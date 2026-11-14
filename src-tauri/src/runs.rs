//! Running a Run-menu method from the interface (PLAN.md §7 P6) through the same code as
//! `qnet-cli run` (`cli/src/run.rs`) and P3's tests: `qnet_runner::methods::prepare` (the solver
//! lookup, the pre-checks and their Status sentences, the exporter, the input file, the seeds and
//! the record's parameters), then `launch` through the one single-flight registry and the
//! supervisor, which starts the solvers itself (decision D1).
//!
//! What a run sends back, on the `Channel` the page passes to `run_start` (`RunMessage`):
//! - `status`: a line for the owning tab's Status log, in the order 0.90.34 wrote it;
//! - `output`: bytes for the Shell pane (base64), through the display-precision filter at
//!   `output.decimals`, as 0.90.34's perl stage showed them;
//! - `progress`: the status bar's state every 500 ms (fraction, elapsed, the readout text);
//! - `finished`: the summary ("QNA finished in 0.4 s"), the status-bar text, the exit status, and
//!   what filing the result did.
//!
//! - `report`: a failure report is being written for the run (`reports.rs`, new in 2.0), sent just
//!   before `finished`, with its id and the Status line that gains "Show Report…". The report's
//!   files are written after `finished`, so a run's end never waits for them.
//!
//! Results are kept in `results-v1.json` in the app's data folder (0.90.34's file name and schema,
//! `qnet_runner::store`): a record is registered when the run is accepted and finished from its
//! full-precision archive, as `registerStructuredResult` and `finishRun` did. Every change is
//! announced as `results://changed` with the record's tab id.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use qnet_core::output::precision::PrecisionFilter;
use qnet_core::results::model::{file_url, Provenance, RunRecord};
use qnet_core::results::{Date, Disposition, MethodMetadata};
use qnet_runner::methods::{launch, prepare, Method, Prepared, RunContext, RunSettings};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use qnet_runner::store::{Finished, ResultsStore, RunOutcome};
use qnet_runner::supervisor::{display_label, OutputSink, RunEvent, RunOwner, RunRegistry, Severity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::errors::QnError;

/// The app's one registry, resolver and results store.
pub struct Runs {
    pub registry: Arc<RunRegistry>,
    pub resolver: Arc<Resolver>,
    pub store: Arc<Mutex<ResultsStore>>,
    /// Where failure reports go (`reports.rs`); `None` writes none (the tests' runs).
    pub reports_dir: Option<PathBuf>,
}

impl Runs {
    /// The runs of this process, with the results store at `store_path`.
    pub fn new(store_path: impl Into<PathBuf>) -> Runs {
        let store_path = store_path.into();
        let reports_dir = store_path.parent().map(|d| d.join("reports"));
        Runs { reports_dir, ..Runs::with_resolver(store_path, Arc::new(Resolver::new(ResolverConfig::from_process()))) }
    }

    pub fn with_resolver(store_path: impl Into<PathBuf>, resolver: Arc<Resolver>) -> Runs {
        Runs { registry: RunRegistry::new(), resolver, store: Arc::new(Mutex::new(ResultsStore::open(store_path))), reports_dir: None }
    }

    fn store(&self) -> std::sync::MutexGuard<'_, ResultsStore> {
        self.store.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// What a run sends the page.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunMessage {
    #[serde(rename_all = "camelCase")]
    Status { text: String, severity: &'static str },
    /// Shell-pane bytes, base64.
    #[serde(rename_all = "camelCase")]
    Output { data: String },
    #[serde(rename_all = "camelCase")]
    Progress { fraction: Option<f64>, elapsed_seconds: f64, text: String },
    #[serde(rename_all = "camelCase")]
    Finished {
        /// "QNA finished in 0.4 s" / "… cancelled after …" / "… failed (exit N) after …".
        summary: String,
        /// What the status bar shows afterwards.
        status_bar: String,
        exit_code: i32,
        user_stopped: bool,
        succeeded: bool,
        /// The filed record's id, when the method files one.
        record_id: Option<String>,
        /// "completed", "partial", "failed", "deleted" (a stopped run), or null.
        filed: Option<String>,
        /// The partial or failed reason, when there is one.
        filed_reason: Option<String>,
    },
    /// A failure report has its id and is being written (`reports.rs`), and the Status line
    /// already sent that it belongs to (none when the run wrote no failure line of its own).
    /// `report_get` says "still writing" until the files are there.
    #[serde(rename_all = "camelCase")]
    Report { id: String, status_text: Option<String> },
}

pub fn severity_word(s: Severity) -> &'static str {
    match s {
        Severity::Info => "info",
        Severity::Success => "success",
        Severity::Warning => "warning",
        Severity::Error => "error",
    }
}

/// A run the page asks for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    /// The owning tab's id (an upper-case UUID).
    pub tab_id: String,
    /// The tab's title ("2dtandem.bnet", "Untitled").
    pub title: String,
    /// The tab's document, the `.bnet` object itself.
    pub document: Value,
    /// 0.90.34's run label ("qna", "inf_cmp").
    pub method: String,
    /// Every setting as `settings_get` returns them (0.90.34's AppSettings keys).
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    /// What a parameter sheet changed for this run, by the same keys.
    #[serde(default)]
    pub overrides: BTreeMap<String, Value>,
    /// The file the tab was opened from or saved to, recorded in the result's provenance.
    #[serde(default)]
    pub source_path: Option<String>,
}

/// How a request ended before or at the launch.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartOutcome {
    /// False when the method refused (its Status lines were sent) or another run owns the slot.
    pub started: bool,
}

/// A setting's value as `RunSettings::set` reads it.
fn setting_text(v: &Value) -> Option<String> {
    match v {
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// The run settings for a request: 0.90.34's defaults, then every stored setting the runner knows,
/// then the sheet's overrides. Keys the runner doesn't read (pane visibility, fonts) are skipped.
pub fn run_settings(settings: &BTreeMap<String, Value>, overrides: &BTreeMap<String, Value>) -> RunSettings {
    let mut s = RunSettings::default();
    for (k, v) in settings {
        if let Some(text) = setting_text(v) {
            let _ = s.set(k, &text);
        }
    }
    // A sheet's answers change the stored settings for this run and are kept as answers too, for
    // the sheets whose values are no stored setting (`RunSettings::sheet`).
    for (k, v) in overrides {
        if let Some(text) = setting_text(v) {
            let _ = s.set(k, &text);
            s.sheet.insert(k.clone(), text);
        }
    }
    s
}

pub type Emit = Arc<dyn Fn(RunMessage) + Send + Sync>;
pub type Changed = Arc<dyn Fn(&str) + Send + Sync>;

/// Starts a run: prepares it, sends its Status lines, and — when it launches — files its record,
/// streams its output and progress, and finishes it on a thread of its own. Returns at once.
/// `changed` is told the tab id whenever the results store changes.
pub fn start(runs: &Runs, req: StartRequest, emit: Emit, changed: Changed) -> Result<(StartOutcome, Option<JoinHandle<()>>), QnError> {
    start_with(runs, req, emit, changed, |_| {})
}

/// `start`, with a last word on the run's context (the golden test gives it the corpus Mac's CPU
/// count, as P3's tests do).
pub fn start_with(runs: &Runs, req: StartRequest, emit: Emit, changed: Changed, adjust: impl FnOnce(&mut RunContext)) -> Result<(StartOutcome, Option<JoinHandle<()>>), QnError> {
    let method = Method::from_label(&req.method).ok_or_else(|| QnError::invalid(format!("There's no method called “{}”.", req.method)))?;
    let text = serde_json::to_string(&req.document).map_err(|e| QnError::invalid(e.to_string()))?;
    let network = qnet_core::bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the tab's network.").with_detail(e.to_string()))?;
    let settings = run_settings(&req.settings, &req.overrides);
    let decimals = settings.output_decimals;
    let mut ctx = RunContext::new(network, req.title.clone(), settings, runs.resolver.clone());
    adjust(&mut ctx);

    let run = match prepare(method, &ctx) {
        Prepared::Refused(lines) => {
            for l in lines {
                emit(RunMessage::Status { text: l.text, severity: severity_word(l.severity) });
            }
            return Ok((StartOutcome { started: false }, None));
        }
        Prepared::Launch(run) => run,
    };
    let (parameters, seed, replication_seeds) = (run.parameters.clone(), run.seed, run.replication_seeds.clone());
    // What a failure report would need that is gone once the run ends: the input files, which the
    // supervisor removes. They are hard-linked now and copied only if the run fails (no bytes are
    // read here); everything else a report holds is gathered when the run has failed.
    let report_plan = runs.reports_dir.clone().map(|dir| (dir, crate::reports::InputStage::link(run.temps.paths()), runs.resolver.config().bundle_resources.clone()));
    let report_parameters = report_plan.is_some().then(|| parameters.clone());
    let status_log: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));

    let summary_slot: Arc<Mutex<Option<qnet_runner::supervisor::RunSummary>>> = Arc::new(Mutex::new(None));
    let reporter = {
        let (emit, summary_slot, status_log) = (emit.clone(), summary_slot.clone(), status_log.clone());
        Arc::new(move |event: &RunEvent| match event {
            RunEvent::Status { text, severity } => {
                status_log.lock().unwrap_or_else(|p| p.into_inner()).push((severity_word(*severity).to_string(), text.clone()));
                emit(RunMessage::Status { text: text.clone(), severity: severity_word(*severity) })
            }
            RunEvent::Progress(p) => emit(RunMessage::Progress {
                fraction: p.fraction,
                elapsed_seconds: p.elapsed.as_secs_f64(),
                text: p.status_text(&display_label(method.label()), ""),
            }),
            RunEvent::Finished(summary) => *summary_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(summary.clone()),
        })
    };
    let owner = RunOwner { id: req.tab_id.clone(), title: req.title.clone() };
    let sink: Box<dyn OutputSink> = Box::new(DisplaySink::new(decimals, emit.clone()));
    let handle = match launch(run, &runs.registry, owner, reporter, sink) {
        Ok(h) => h,
        // The refusal sentence has gone to the tab already, as a warning.
        Err(_) => return Ok((StartOutcome { started: false }, None)),
    };

    // Registered as soon as the run is accepted, as `registerStructuredResult` did.
    let record_id = MethodMetadata::for_run_label(method.label()).map(|meta| {
        let source = req.source_path.as_deref().map(|p| file_url(p));
        let provenance = Provenance::capture(&req.tab_id, &req.title, &ctx.network, source, parameters, seed, replication_seeds, env!("CARGO_PKG_VERSION"));
        let id = runs.store().begin_run(RunRecord::new(&ctx.uuid().to_uppercase(), meta, provenance, Date::now()));
        changed(&req.tab_id);
        id
    });

    let store = runs.store.clone();
    let tab_id = req.tab_id.clone();
    let started = Instant::now();
    let finisher = std::thread::spawn(move || {
        // A failure report in two steps, so the run's end never waits for it: `announce` settles
        // the report's id (one `mkdir`) and tells the page, before `finished`; `file` gathers
        // the evidence and writes the files, after `finished`.
        let announce = |status_text: Option<String>| {
            let (dir, _, _) = report_plan.as_ref()?;
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            // A report that can't be made (a full disk) must not hide the run's own end.
            let pending = crate::reports::reserve(dir, method.label(), now).ok()?;
            emit(RunMessage::Report { id: pending.id().to_string(), status_text });
            Some(pending)
        };
        let file = |pending: Option<crate::reports::Pending>, fill: &mut dyn FnMut(&mut crate::reports::Failure)| {
            let (Some(pending), Some((_, stage, bundle_resources))) = (pending, report_plan.as_ref()) else { return };
            let mut failure = crate::reports::Failure {
                method: method.label().to_string(),
                method_name: display_label(method.label()),
                title: req.title.clone(),
                parameters: report_parameters.clone().unwrap_or_default(),
                overrides: req.overrides.iter().filter_map(|(k, v)| setting_text(v).map(|t| (k.clone(), t))).collect(),
                seed,
                infinite_buffers: ctx.network.infinite_buffers,
                utilisation: station_loads(&ctx),
                inputs: stage.inputs(),
                network: serde_json::to_string_pretty(&req.document).unwrap_or(text.clone()) + "\n",
                status_lines: status_log.lock().unwrap_or_else(|p| p.into_inner()).clone(),
                ..Default::default()
            };
            fill(&mut failure);
            // Written or not, the folder is whole or gone: the panel says which.
            let _ = pending.write(&failure, &crate::reports::Environment::detect(bundle_resources.as_deref()));
        };
        let report = match handle.join() {
            Ok(r) => r,
            Err(_) => {
                // The run's thread panicked (its ticket has freed the slot): file the record as
                // failed and say the run ended, so neither the record nor the run segment is left
                // "running".
                let message = "The run's thread ended unexpectedly.".to_string();
                emit(RunMessage::Status { text: message.clone(), severity: "error" });
                if let Some(id) = &record_id {
                    store.lock().unwrap_or_else(|p| p.into_inner()).fail_run(id, &message, None, Date::now());
                    changed(&tab_id);
                }
                let pending = announce(Some(message.clone()));
                let (duration, reason) = (started.elapsed().as_secs_f64(), message.clone());
                let label = display_label(method.label());
                emit(RunMessage::Finished {
                    summary: format!("{label} failed"),
                    status_bar: format!("{label} failed"),
                    exit_code: -1,
                    user_stopped: false,
                    succeeded: false,
                    record_id: record_id.clone(),
                    filed: record_id.as_ref().map(|_| "failed".to_string()),
                    filed_reason: Some(message),
                });
                file(pending, &mut |f| {
                    f.internal = true;
                    f.exit_code = -1;
                    f.duration_seconds = duration;
                    f.reason = Some(reason.clone());
                });
                return;
            }
        };
        let summary = summary_slot.lock().unwrap_or_else(|p| p.into_inner()).take().unwrap_or_else(|| report.summary.clone());
        let (mut filed, mut reason) = (None, None);
        if let Some(id) = &record_id {
            let outcome = RunOutcome {
                id: id.clone(),
                label: display_label(method.label()),
                exit_code: report.summary.exit_code,
                user_stopped: report.summary.user_stopped,
                finished_at: Date::now(),
            };
            let result = store.lock().unwrap_or_else(|p| p.into_inner()).finish_run(&outcome, Some(&report.archive_text()));
            (filed, reason) = match result {
                Finished::NoRecord => (None, None),
                Finished::Deleted => (Some("deleted"), None),
                Finished::ExitedWithError(m) => (Some("failed"), Some(m)),
                Finished::Parsed(Disposition::Completed) => (Some("completed"), None),
                Finished::Parsed(Disposition::Partial(why)) => (Some("partial"), Some(why)),
                Finished::Parsed(Disposition::Failed(why)) => (Some("failed"), Some(why)),
            };
            changed(&tab_id);
        }
        // A failure other than the user's Stop: a non-zero exit, a signal, a solver that could
        // not start, or output the parser could not use.
        let exited_badly = !summary.succeeded() && !summary.cancelled();
        let pending = if exited_badly || (filed == Some("failed") && !summary.cancelled()) {
            // `Job::finish` wrote this line for a non-zero exit.
            announce(exited_badly.then(|| summary.text()))
        } else {
            None
        };
        let report_reason = pending.is_some().then(|| reason.clone()).flatten();
        emit(RunMessage::Finished {
            summary: summary.text(),
            status_bar: summary.status_bar_text(),
            exit_code: summary.exit_code,
            user_stopped: summary.user_stopped,
            succeeded: summary.succeeded(),
            record_id: if filed == Some("deleted") { None } else { record_id },
            filed: filed.map(str::to_string),
            filed_reason: reason,
        });
        // The run's steps and output are moved into the report, not copied.
        let (mut steps, mut archive) = (report.steps, report.archive);
        file(pending, &mut |f| {
            f.exit_code = summary.exit_code;
            f.duration_seconds = summary.elapsed.as_secs_f64();
            f.reason = report_reason.clone();
            f.steps = std::mem::take(&mut steps);
            f.archive = std::mem::take(&mut archive);
        });
    });
    Ok((StartOutcome { started: true }, Some(finisher)))
}

/// ρ per station in export order, where it is finite, for a failure report.
fn station_loads(ctx: &RunContext) -> Vec<(String, f64)> {
    let Some(data) = ctx.analysis_data() else { return Vec::new() };
    (0..data.d)
        .filter_map(|i| {
            let rho = data.rho(i);
            rho.is_finite().then(|| (qnet_core::results::model::station_name_at_export_index(&ctx.network, i), rho))
        })
        .collect()
}

/// Sends the Shell pane what 0.90.34's display filter showed: the run's bytes through the
/// precision filter, with a held tail released after its 50 ms of quiet by a poller. The Test
/// menu's runs (`testsets.rs`) use it too.
pub struct DisplaySink {
    filter: Arc<Mutex<PrecisionFilter>>,
    /// Held from taking bytes out of the filter until they are sent, by the run thread and the
    /// poller alike, so a released tail can never be sent after newer bytes.
    out: Arc<Mutex<()>>,
    emit: Emit,
    done: Arc<AtomicBool>,
    poller: Option<JoinHandle<()>>,
}

impl DisplaySink {
    pub fn new(decimals: i64, emit: Emit) -> Self {
        let filter = Arc::new(Mutex::new(PrecisionFilter::new(decimals, true)));
        let out = Arc::new(Mutex::new(()));
        let done = Arc::new(AtomicBool::new(false));
        let poller = {
            let (filter, out, done, emit) = (filter.clone(), out.clone(), done.clone(), emit.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(10));
                    let _order = out.lock().unwrap_or_else(|p| p.into_inner());
                    let shown = filter.lock().unwrap_or_else(|p| p.into_inner()).poll(Instant::now());
                    send_bytes(&emit, &shown);
                }
            })
        };
        DisplaySink { filter, out, emit, done, poller: Some(poller) }
    }

    fn stop_poller(&mut self) {
        self.done.store(true, Ordering::SeqCst);
        if let Some(p) = self.poller.take() {
            let _ = p.join();
        }
    }
}

fn send_bytes(emit: &Emit, bytes: &[u8]) {
    if !bytes.is_empty() {
        emit(RunMessage::Output { data: base64(bytes) });
    }
}

impl OutputSink for DisplaySink {
    fn write(&mut self, bytes: &[u8]) {
        let _order = self.out.lock().unwrap_or_else(|p| p.into_inner());
        let shown = self.filter.lock().unwrap_or_else(|p| p.into_inner()).feed(bytes, Instant::now());
        send_bytes(&self.emit, &shown);
    }

    fn finish(&mut self) {
        self.stop_poller();
        let _order = self.out.lock().unwrap_or_else(|p| p.into_inner());
        let shown = self.filter.lock().unwrap_or_else(|p| p.into_inner()).finish();
        send_bytes(&self.emit, &shown);
    }
}

impl Drop for DisplaySink {
    fn drop(&mut self) {
        self.stop_poller();
    }
}

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A record as the page reads it: the JSON object `results-v1.json` holds.
fn record_value(r: &RunRecord) -> Value {
    r.to_json()
        .ok()
        .and_then(|j| serde_json::from_str(&qnet_core::json::to_pretty(&j)).ok())
        .unwrap_or(Value::Null)
}

/// The active run, for the status bar and the Run menu.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRunInfo {
    pub id: String,
    pub label: String,
    pub display_label: String,
    pub tab_id: String,
    pub tab_title: String,
    pub elapsed_seconds: f64,
    pub fraction: Option<f64>,
    pub stop_requested: bool,
    pub text: String,
}

pub fn active(runs: &Runs) -> Option<ActiveRunInfo> {
    runs.registry.active().map(|a| ActiveRunInfo {
        text: a.status_text(),
        id: a.id.as_str().to_string(),
        label: a.label,
        display_label: a.display_label,
        tab_id: a.owner.id,
        tab_title: a.owner.title,
        elapsed_seconds: a.elapsed.as_secs_f64(),
        fraction: a.fraction,
        stop_requested: a.stop_requested,
    })
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────

fn announce(app: &AppHandle) -> Changed {
    let app = app.clone();
    Arc::new(move |tab: &str| {
        let _ = app.emit("results://changed", tab.to_string());
    })
}

/// Run ▸ <method>: starts it for the tab, streaming to `channel`.
/// Async, so preparing (solver and Python probes, writing the input) runs off the main thread.
#[tauri::command]
pub async fn run_start(app: AppHandle, runs: State<'_, Runs>, request: StartRequest, channel: Channel<RunMessage>) -> Result<StartOutcome, QnError> {
    let emit: Emit = Arc::new(move |m| {
        let _ = channel.send(m);
    });
    let (outcome, _finisher) = start(&runs, request, emit, announce(&app))?;
    let _ = app.emit("runs://changed", ());
    Ok(outcome)
}

/// Run ▸ Stop (⌘.) and the status bar's Stop: the display label of the run stopped, or null.
#[tauri::command]
pub fn run_stop(runs: State<'_, Runs>) -> Option<String> {
    runs.registry.stop()
}

/// The run in progress, if any.
#[tauri::command]
pub fn run_active(runs: State<'_, Runs>) -> Option<ActiveRunInfo> {
    active(&runs)
}

/// Every record of a tab (or all of them), oldest first, as the store holds them.
#[tauri::command]
pub fn results_list(runs: State<'_, Runs>, tab_id: Option<String>) -> Vec<Value> {
    let store = runs.store();
    match tab_id {
        Some(t) => store.records_for_tab(&t).into_iter().map(record_value).collect(),
        None => store.records().iter().map(record_value).collect(),
    }
}

#[tauri::command]
pub fn results_get(runs: State<'_, Runs>, id: String) -> Option<Value> {
    runs.store().record(&id).map(record_value)
}

/// Removes a record (the Results workspace's Delete).
#[tauri::command]
pub fn results_delete(app: AppHandle, runs: State<'_, Runs>, id: String) {
    let tab = runs.store().record(&id).map(|r| r.provenance.tab_id.clone());
    runs.store().delete(&id);
    if let Some(t) = tab {
        let _ = app.emit("results://changed", t);
    }
}

/// Why the results file couldn't be used or written, when it couldn't.
#[tauri::command]
pub fn results_problem(runs: State<'_, Runs>) -> Option<String> {
    let store = runs.store();
    if let Some(a) = store.set_aside() {
        return Some(match &a.backup {
            Some(b) => format!("Qnet couldn't read its results file ({}); it was moved to {}.", a.error.trim_end_matches('.'), b.display()),
            None => format!("Qnet couldn't read its results file ({}); it was left where it is, and nothing will be written over it.", a.error.trim_end_matches('.')),
        });
    }
    store.persistence_error().map(str::to_string)
}

/// The results file's path in the app's data folder.
pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join("results-v1.json")
}

/// One at a time for tests that run a solver through the real run path (here, quiet_runs.rs,
/// reports.rs): the solver inputs are named by process id, which the tests of one binary share.
#[cfg(test)]
pub(crate) static TEST_TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_is_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"\x1b[2K\xff"), "G1syS/8=");
    }

    #[test]
    fn run_settings_take_the_stored_keys_then_the_sheet() {
        let mut settings = BTreeMap::new();
        settings.insert("output.decimals".to_string(), Value::from(5));
        settings.insert("sim.replications".to_string(), Value::from(12));
        settings.insert("status.paneVisible".to_string(), Value::from(true));
        let mut overrides = BTreeMap::new();
        overrides.insert("sim.replications".to_string(), Value::from(3));
        let s = run_settings(&settings, &overrides);
        assert_eq!(s.output_decimals, 5);
        assert_eq!(s.get("sim.replications").as_deref(), Some("3"));
        // Sheet answers are kept as answers too, including ones that are no stored setting.
        overrides.insert("regenerative.confidence".to_string(), Value::from(0.99));
        let s = run_settings(&settings, &overrides);
        assert_eq!(s.sheet.get("sim.replications").map(String::as_str), Some("3"));
        assert_eq!(s.sheet.get("regenerative.confidence").map(String::as_str), Some("0.99"));
        assert!(!s.sheet.contains_key("output.decimals"));
    }
}

#[cfg(test)]
#[path = "runs_golden.rs"]
mod golden;
