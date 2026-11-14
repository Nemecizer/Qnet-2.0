//! Quiet runs (new in 2.1, ROADMAP B4): a Run-menu method run for a document and handed back as
//! the record it would have filed — nothing is filed in the results store, nothing is streamed to
//! the Shell pane and no Status line is written. Run ▸ What-If Sweep… (src/sweeps/) asks for one
//! per point and method.
//!
//! A quiet run is prepared and launched by the code every other run uses
//! (`qnet_runner::methods::prepare` and `launch`, as `runs::start_with` does), with a sink that
//! discards the display stream; its record is built from the full-precision archive by the parser
//! the store uses (`qnet_core::results::parse`).
//!
//! The single-flight slot: a sweep is one run to the rest of the app. `quiet_begin` claims the
//! app's one slot under the label `what-if_sweep` ("What-If Sweep" in the status bar and in the
//! refusal a second run gets) and holds it until `quiet_end`; while it is held, each `quiet_run`
//! goes through a registry of the sweep's own, so the solver steps are supervised and stopped
//! exactly as any run's. Run ▸ Stop cancels the slot's token: the run in flight is interrupted at
//! once and answers `stopped`, and every later `quiet_run` of that sweep answers `stopped` too. A
//! sweep whose page went away (a reload) can't hold the slot for ever: a held slot that is
//! stopped, or idle for `IDLE_LIMIT`, is released by a watcher.
//!
//! Requests are tied to their sweep: `quiet_begin` issues a sweep id and each of the sweep's
//! `quiet_run`s carries it. A request whose sweep is no longer the one holding the slot — Stop
//! was pressed while no point was in flight and the watcher has freed the slot, or another sweep
//! has begun since — answers `stopped`; it never runs on its own in a slot that may by then be
//! someone else's. A `quiet_run` with no sweep id claims the app's slot for itself, as a Run-menu
//! method would.
//!
//! What a quiet run answers (`QuietOutcome`): the record; `unstable` (an infinite-buffer network
//! with a station at utilisation ≥ 1 — no method is started for it); `refused` (the method's own
//! pre-check sentences, or the registry's); `failed` (a non-zero exit or output the parser can't
//! use, with the sentence); or `stopped`.
//!
//! `quiet_probe` answers each station's utilisation for a document without running anything: the
//! sweep panel finds a range that stays stable with it, and the chart its asymptote.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use qnet_core::results::model::{station_name_at_export_index, Provenance, RunRecord};
use qnet_core::results::{parse, Date, Disposition, MethodMetadata};
use qnet_runner::methods::{launch, prepare, Method, Prepared, RunContext};
use qnet_runner::resolver::Resolver;
use qnet_runner::supervisor::{display_label, CancelToken, NullSink, OutputSink, RunEvent, RunOwner, RunRegistry, RunTicket, Severity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::errors::QnError;
use crate::runs::{run_settings, Runs};

/// The run label a sweep holds the slot under ("What-If Sweep").
pub const SWEEP_LABEL: &str = "what-if_sweep";
/// The run label Results ▸ Sensitivity's numerical route holds the slot under ("Sensitivity"): it
/// runs on the sweep's machinery, and is named for what the person started.
pub const SENSITIVITY_LABEL: &str = "sensitivity";

/// The run label Results ▸ Capacity's numerical route holds the slot under ("Capacity").
pub const CAPACITY_LABEL: &str = "capacity";

/// The label a quiet session may ask for: the sweep's unless it names the sensitivity estimate.
pub fn session_label(asked: Option<&str>) -> &'static str {
    if asked == Some(SENSITIVITY_LABEL) {
        SENSITIVITY_LABEL
    } else if asked == Some(CAPACITY_LABEL) {
        CAPACITY_LABEL
    } else {
        SWEEP_LABEL
    }
}

/// A held slot nobody has used for this long is released (its page went away).
const IDLE_LIMIT: Duration = Duration::from_secs(120);

/// One quiet run the page asks for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuietRequest {
    /// The owning tab's id and title (the record's provenance; exporters name their document after the title).
    pub tab_id: String,
    pub title: String,
    /// The document to run: the `.bnet` object itself.
    pub document: Value,
    /// 0.90.34's run label ("qna", "inf_sim").
    pub method: String,
    /// Every setting as `settings_get` returns them; a method with a parameter sheet runs with these defaults.
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    #[serde(default)]
    pub overrides: BTreeMap<String, Value>,
    /** The sweep this run is a point of (`quiet_begin`'s answer); none for a quiet run on its own. */
    #[serde(default)]
    pub sweep_id: Option<String>,
}

/// How a quiet run ended.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QuietOutcome {
    /// The record the run would have filed (completed or partial), without its raw output.
    #[serde(rename_all = "camelCase")]
    Record { record: Value, elapsed_seconds: f64 },
    /// A station at utilisation ≥ 1 in an infinite-buffer network: nothing was run.
    #[serde(rename_all = "camelCase")]
    Unstable { sentence: String, station: String, utilisation: f64 },
    /// The method (or the single-flight slot) refused before anything ran.
    #[serde(rename_all = "camelCase")]
    Refused { sentence: String },
    /// It ran and gave no usable result.
    #[serde(rename_all = "camelCase")]
    Failed { sentence: String },
    /// Stop was pressed.
    Stopped,
}

/// Each station's utilisation for a document.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuietProbe {
    pub infinite_buffers: bool,
    /// ρ per station in export order, where it is finite.
    pub loads: Vec<StationLoad>,
    /// False when an infinite-buffer network has a station at ρ ≥ 1 (a finite one is always stable).
    pub stable: bool,
    /// Why the traffic equations couldn't be solved, when they couldn't.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StationLoad {
    pub station: String,
    pub utilisation: f64,
}

/// Whether `quiet_begin` got the slot, and the registry's sentence when it didn't.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuietBegun {
    pub started: bool,
    pub sentence: Option<String>,
    /// The sweep's id, which each of its `quiet_run`s carries.
    pub sweep_id: Option<String>,
}

// ── The held slot ───────────────────────────────────────────────────────────────────────────

struct Session {
    /// The claim on the app's slot; dropping it frees the slot.
    ticket: RunTicket,
    /// The sweep's own registry, which each of its runs goes through.
    inner: Arc<RunRegistry>,
    /// A run is in flight.
    busy: bool,
    last_used: Instant,
    serial: u64,
    /// What `quiet_begin` answered: the requests that carry it are this sweep's.
    id: String,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn session() -> std::sync::MutexGuard<'static, Option<Session>> {
    SESSION.lock().unwrap_or_else(|p| p.into_inner())
}

/// Claims the app's slot for a sweep owned by `tab_id`. Refused, with the registry's sentence,
/// while any run (or another sweep) is in progress.
#[cfg(test)]
pub fn begin(registry: &Arc<RunRegistry>, tab_id: &str, title: &str) -> QuietBegun {
    begin_as(registry, SWEEP_LABEL, tab_id, title)
}

/// [`begin`] under `label` ([`session_label`]): what the status bar, Run ▸ Stop and a refusal call the session.
pub fn begin_as(registry: &Arc<RunRegistry>, label: &'static str, tab_id: &str, title: &str) -> QuietBegun {
    let quiet: qnet_runner::supervisor::Reporter = Arc::new(|_: &RunEvent| {});
    let ticket = match registry.begin(label, RunOwner { id: tab_id.to_string(), title: title.to_string() }, quiet) {
        Ok(t) => t,
        Err(refused) => return QuietBegun { started: false, sentence: Some(refused.message), sweep_id: None },
    };
    let serial = SERIAL.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let id = format!("sweep-{}-{serial}", std::process::id());
    *session() = Some(Session { ticket, inner: RunRegistry::new(), busy: false, last_used: Instant::now(), serial, id: id.clone() });
    // Releases a slot that was stopped or abandoned, once no run of it is in flight.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        let mut held = session();
        match held.as_ref() {
            Some(s) if s.serial == serial => {
                if !s.busy && (s.ticket.cancel_token().is_cancelled() || s.last_used.elapsed() > IDLE_LIMIT) {
                    *held = None;
                    return;
                }
            }
            _ => return,
        }
    });
    QuietBegun { started: true, sentence: None, sweep_id: Some(id) }
}

/// Releases the slot of sweep `sweep_id` (a no-op when Stop or the watcher already has, or when
/// another sweep holds it by now); with `None`, of whichever sweep holds it — a page that has
/// just loaded ends the sweep its predecessor left.
pub fn end(sweep_id: Option<&str>) {
    // A run still in flight keeps the slot until it has answered; the watcher releases it then.
    let mut held = session();
    if let (Some(id), Some(s)) = (sweep_id, held.as_ref()) {
        if s.id != id {
            return;
        }
    }
    if held.as_ref().is_some_and(|s| !s.busy) {
        *held = None;
    } else if let Some(s) = held.as_ref() {
        s.ticket.cancel_token().cancel();
    }
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────

/// The first station at utilisation ≥ 1, for an infinite-buffer network.
fn overloaded(ctx: &RunContext) -> Option<(String, f64)> {
    if !ctx.network.infinite_buffers {
        return None;
    }
    let data = ctx.analysis_data()?;
    (0..data.d).find_map(|i| {
        let rho = data.rho(i);
        (rho.is_finite() && rho >= 1.0).then(|| (station_name_at_export_index(&ctx.network, i), rho))
    })
}

fn read_network(document: &Value) -> Result<qnet_core::model::Network, QnError> {
    let text = serde_json::to_string(document).map_err(|e| QnError::invalid(e.to_string()))?;
    qnet_core::bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the network.").with_detail(e.to_string()))
}

/// Runs `req` to its end on this thread through `registry` and answers its outcome. `stop`, when
/// given, is a token whose cancellation stops the run (the sweep's slot); `adjust` has the last
/// word on the run's context, as `runs::start_with`'s does.
pub fn run_quiet(resolver: &Arc<Resolver>, registry: &Arc<RunRegistry>, stop: Option<&CancelToken>, req: &QuietRequest, adjust: impl FnOnce(&mut RunContext)) -> Result<QuietOutcome, QnError> {
    let method = Method::from_label(&req.method).ok_or_else(|| QnError::invalid(format!("There's no method called “{}”.", req.method)))?;
    let network = read_network(&req.document)?;
    let settings = run_settings(&req.settings, &req.overrides);
    let mut ctx = RunContext::new(network, req.title.clone(), settings, resolver.clone());
    adjust(&mut ctx);
    let label = display_label(method.label());

    if let Some((station, utilisation)) = overloaded(&ctx) {
        let sentence = format!("{station} would be overloaded (utilisation {utilisation:.3}), so the network has no steady state.");
        return Ok(QuietOutcome::Unstable { sentence, station, utilisation });
    }
    let run = match prepare(method, &ctx) {
        Prepared::Refused(lines) => {
            let said: Vec<String> = lines.into_iter().map(|l| l.text).collect();
            let sentence = if said.is_empty() { format!("{label} isn't offered for a network with {} buffers.", if ctx.network.infinite_buffers { "infinite" } else { "finite" }) } else { said.join(" ") };
            return Ok(QuietOutcome::Refused { sentence });
        }
        Prepared::Launch(run) => run,
    };
    let (parameters, seed, replication_seeds) = (run.parameters.clone(), run.seed, run.replication_seeds.clone());
    let said: Arc<Mutex<Vec<(Severity, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let reporter = {
        let said = said.clone();
        Arc::new(move |event: &RunEvent| {
            if let RunEvent::Status { text, severity } = event {
                said.lock().unwrap_or_else(|p| p.into_inner()).push((*severity, text.clone()));
            }
        })
    };
    let owner = RunOwner { id: req.tab_id.clone(), title: req.title.clone() };
    let sink: Box<dyn OutputSink> = Box::new(NullSink);
    let started = Instant::now();
    let handle = match launch(run, registry, owner, reporter, sink) {
        Ok(h) => h,
        Err(refused) => return Ok(QuietOutcome::Refused { sentence: refused.message }),
    };
    // The sweep's Stop reaches the run in flight within a few milliseconds.
    let mut forwarded = false;
    while !handle.is_finished() {
        match stop {
            Some(token) if !forwarded => {
                if token.wait_timeout(Duration::from_millis(20)) {
                    registry.stop();
                    forwarded = true;
                }
            }
            _ => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    let Ok(report) = handle.join() else {
        return Ok(QuietOutcome::Failed { sentence: format!("{label} ended unexpectedly.") });
    };
    if report.summary.cancelled() || stop.is_some_and(CancelToken::is_cancelled) {
        return Ok(QuietOutcome::Stopped);
    }
    if !report.summary.succeeded() {
        // The run's own last error line says more than the exit status alone.
        let lines = said.lock().unwrap_or_else(|p| p.into_inner());
        let own = lines.iter().rev().find(|(s, t)| *s == Severity::Error && *t != report.summary.text()).map(|(_, t)| t.clone());
        let sentence = match own {
            Some(t) => format!("{label} exited with status {}: {t}", report.summary.exit_code),
            None => format!("{label} exited with status {}.", report.summary.exit_code),
        };
        return Ok(QuietOutcome::Failed { sentence });
    }
    let Some(meta) = MethodMetadata::for_run_label(method.label()) else {
        return Ok(QuietOutcome::Failed { sentence: format!("{label} files no record.") });
    };
    let provenance = Provenance::capture(&req.tab_id, &req.title, &ctx.network, None, parameters, seed, replication_seeds, env!("CARGO_PKG_VERSION"));
    let mut record = RunRecord::new(&ctx.uuid().to_uppercase(), meta, provenance, Date::now());
    let raw = report.archive_text();
    let parsed = parse(Some(&raw), &record);
    match &parsed.disposition {
        Disposition::Completed => record.complete(Some(parsed.measurements), parsed.evidence, parsed.warnings, None, Date::now()),
        Disposition::Partial(why) => record.partial(why, Some(parsed.measurements), parsed.evidence, parsed.warnings, None, Date::now()),
        Disposition::Failed(why) => return Ok(QuietOutcome::Failed { sentence: why.clone() }),
    }
    // A NaN or an infinity can't be written as JSON; the store fails such a run, and so does this.
    let Ok(json) = record.to_json() else {
        return Ok(QuietOutcome::Failed { sentence: format!("{label} produced a value that isn't a finite number.") });
    };
    let value: Value = serde_json::from_str(&qnet_core::json::to_pretty(&json)).map_err(|e| QnError::failed(e.to_string()))?;
    Ok(QuietOutcome::Record { record: value, elapsed_seconds: started.elapsed().as_secs_f64() })
}

/// `run_quiet` as a point of the sweep the request names (the sweep's own registry, stopped by
/// the slot's token) — `stopped` when that sweep is no longer the one holding the slot — or, for
/// a request that names no sweep, as a run of its own through the app's registry.
pub fn run(resolver: &Arc<Resolver>, registry: &Arc<RunRegistry>, req: &QuietRequest, adjust: impl FnOnce(&mut RunContext)) -> Result<QuietOutcome, QnError> {
    let Some(id) = req.sweep_id.as_deref() else {
        return run_quiet(resolver, registry, None, req, adjust);
    };
    let (inner, token, serial) = {
        let mut s = session();
        match s.as_mut() {
            Some(sess) if sess.id == id && !sess.ticket.cancel_token().is_cancelled() => {
                if sess.busy {
                    return Ok(QuietOutcome::Refused { sentence: "The sweep is still running its previous point.".into() });
                }
                sess.busy = true;
                (sess.inner.clone(), sess.ticket.cancel_token().clone(), sess.serial)
            }
            // Stopped (and perhaps freed already), ended, or replaced by another sweep.
            _ => return Ok(QuietOutcome::Stopped),
        }
    };
    let outcome = run_quiet(resolver, &inner, Some(&token), req, adjust);
    if let Some(sess) = session().as_mut().filter(|s| s.serial == serial) {
        sess.busy = false;
        sess.last_used = Instant::now();
    }
    outcome
}

/// What the load check covers, as the start of `closed::open_only`'s sentence.
pub const PROBE_SUBJECT: &str = "The load check (utilisation from the traffic equations)";

/// Each station's utilisation for `document`. A network drawn as a closed one has no arrivals for
/// the traffic equations to start from: its `error` is the shared closed sentence
/// (`closed::open_only`), never "The network has no source node." (ledger FIX-109).
pub fn probe(document: &Value) -> Result<QuietProbe, QnError> {
    let net = read_network(document)?;
    let infinite_buffers = net.infinite_buffers;
    if let Some((_, sentence)) = qnet_core::closed::open_only(&net, PROBE_SUBJECT) {
        return Ok(QuietProbe { infinite_buffers, loads: Vec::new(), stable: true, error: Some(sentence) });
    }
    // At the sources' long-run customer rates (`extended::traffic`: `traffic::compute` itself
    // for a network without batch arrivals or a rate profile).
    match qnet_core::extended::traffic(&net, net.infinite_buffers, false, false) {
        Ok(data) => {
            let loads: Vec<StationLoad> = (0..data.d)
                .filter_map(|i| {
                    let rho = data.rho(i);
                    rho.is_finite().then(|| StationLoad { station: station_name_at_export_index(&net, i), utilisation: rho })
                })
                .collect();
            let stable = !infinite_buffers || loads.iter().all(|l| l.utilisation < 1.0);
            Ok(QuietProbe { infinite_buffers, loads, stable, error: None })
        }
        Err(e) => Ok(QuietProbe { infinite_buffers, loads: Vec::new(), stable: true, error: Some(e.message().to_string()) }),
    }
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────

/// Run ▸ What-If Sweep… (and, with `label` "sensitivity", Results ▸ Sensitivity's numerical
/// route): claims the run slot for the sweep.
#[tauri::command]
pub fn quiet_begin(app: AppHandle, runs: State<'_, Runs>, tab_id: String, title: String, label: Option<String>) -> QuietBegun {
    let begun = begin_as(&runs.registry, session_label(label.as_deref()), &tab_id, &title);
    let _ = app.emit("runs://changed", ());
    begun
}

/// One point of a sweep (or a quiet run on its own): the record, or why there is none.
#[tauri::command]
pub async fn quiet_run(runs: State<'_, Runs>, request: QuietRequest) -> Result<QuietOutcome, QnError> {
    let (resolver, registry) = (runs.resolver.clone(), runs.registry.clone());
    tauri::async_runtime::spawn_blocking(move || run(&resolver, &registry, &request, |_| {}))
        .await
        .map_err(|e| QnError::failed(format!("The quiet run ended unexpectedly: {e}")))?
}

/// The sweep is over: frees the run slot.
#[tauri::command]
pub fn quiet_end(app: AppHandle, sweep_id: Option<String>) {
    end(sweep_id.as_deref());
    let _ = app.emit("runs://changed", ());
}

/// Each station's utilisation for a document, without running anything.
#[tauri::command]
pub fn quiet_probe(document: Value) -> Result<QuietProbe, QnError> {
    probe(&document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::{start_with, RunMessage, StartRequest};
    use qnet_runner::methods::RunSettings;
    use qnet_runner::resolver::ResolverConfig;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    /// The session is one per process: tests that hold it take turns.
    // Shared with every other test that runs a solver through the real run path: they write
    // inputs named by process id, so two at once would read each other's files.
    use crate::runs::TEST_TURN as TURN;

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
    }

    fn staged_resolver() -> Option<Arc<Resolver>> {
        let home = std::env::var_os("HOME")?;
        let solvers = PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources");
        if !solvers.join("bin").is_dir() {
            return None;
        }
        let mut cfg = ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.env.insert(OsString::from("QNET_SOLVER_ROOT"), solvers.into_os_string());
        Some(Arc::new(Resolver::new(cfg)))
    }

    fn temp_runs(tag: &str, resolver: Arc<Resolver>) -> (Runs, PathBuf) {
        let dir = std::env::temp_dir().join(format!("qnet-quiet-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (Runs::with_resolver(dir.join("results-v1.json"), resolver), dir)
    }

    fn example(name: &str) -> Value {
        serde_json::from_str(&std::fs::read_to_string(root().join("examples").join(format!("{name}.bnet"))).unwrap()).unwrap()
    }

    fn golden_settings() -> BTreeMap<String, Value> {
        let golden = RunSettings::golden();
        RunSettings::KEYS.iter().map(|k| (k.to_string(), Value::String(golden.get(k).unwrap()))).collect()
    }

    fn request(name: &str, method: &str, document: Value) -> QuietRequest {
        QuietRequest { tab_id: "C0000000-0000-4000-8000-000000000007".into(), title: format!("{name}.bnet"), document, method: method.into(), settings: golden_settings(), overrides: BTreeMap::new(), sweep_id: None }
    }

    /// (station, class, metric, unit, estimate) of every measurement, in order.
    fn measurements(record: &Value) -> Vec<(String, String, String, String, String)> {
        record["measurements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| (m["stationName"].to_string(), m["customerClass"].to_string(), m["metric"].to_string(), m["unit"].to_string(), m["estimate"].to_string()))
            .collect()
    }

    #[test]
    fn a_quiet_run_gives_a_normal_runs_measurements_and_files_nothing() {
        let Some(resolver) = staged_resolver() else {
            println!("skipped: the staged solvers are absent (scripts/stage-solvers.sh)");
            return;
        };
        let _turn = TURN.lock().unwrap_or_else(|p| p.into_inner());
        let (runs, dir) = temp_runs("same", resolver);
        let name = "5stationtandem.inf";
        let messages = Arc::new(Mutex::new(Vec::<RunMessage>::new()));

        // Quietly, first: the record comes back and the store stays empty.
        let outcome = run(&runs.resolver, &runs.registry, &request(name, "qna", example(name)), |_| {}).unwrap();
        let QuietOutcome::Record { record: quiet, .. } = outcome else { panic!("no record: {outcome:?}") };
        assert_eq!(quiet["status"], "completed");
        assert!(quiet.get("rawOutput").is_none(), "a quiet record carries no transcript");
        assert!(runs.store.lock().unwrap().records().is_empty(), "a quiet run files nothing");
        assert!(!dir.join("results-v1.json").exists(), "…and writes no results file");
        assert!(runs.registry.active().is_none(), "…and leaves the slot free");

        // The same method through the Run menu's path files a record with the same numbers.
        let emit = {
            let messages = messages.clone();
            Arc::new(move |m: RunMessage| messages.lock().unwrap().push(m))
        };
        let req = StartRequest {
            tab_id: "C0000000-0000-4000-8000-000000000007".into(),
            title: format!("{name}.bnet"),
            document: example(name),
            method: "qna".into(),
            settings: golden_settings(),
            overrides: BTreeMap::new(),
            source_path: None,
        };
        let (started, finisher) = start_with(&runs, req, emit, Arc::new(|_: &str| {}), |_| {}).unwrap();
        assert!(started.started);
        finisher.unwrap().join().unwrap();
        let filed = runs.store.lock().unwrap().records().first().and_then(|r| r.to_json().ok()).map(|j| serde_json::from_str::<Value>(&qnet_core::json::to_pretty(&j)).unwrap()).unwrap();
        assert!(!measurements(&quiet).is_empty());
        assert_eq!(measurements(&quiet), measurements(&filed));
        assert_eq!(quiet["method"], filed["method"]);
        assert_eq!(quiet["provenance"]["networkFingerprint"], filed["provenance"]["networkFingerprint"]);
        // Nothing reached the page from the quiet run: every message is the normal run's.
        assert_eq!(runs.store.lock().unwrap().records().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Results ▸ Sensitivity's numerical route holds the same slot under its own name: the
    /// status bar, Run ▸ Stop and a refusal say "Sensitivity", never "What-If Sweep".
    #[test]
    fn a_sensitivity_session_holds_the_slot_under_its_own_name() {
        let _turn = TURN.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!((session_label(Some("sensitivity")), session_label(None), session_label(Some("qna"))), (SENSITIVITY_LABEL, SWEEP_LABEL, SWEEP_LABEL));
        assert_eq!(session_label(Some("capacity")), CAPACITY_LABEL);
        assert_eq!(display_label(CAPACITY_LABEL), "Capacity");
        let resolver = Arc::new(Resolver::new(ResolverConfig::from_process()));
        let (runs, dir) = temp_runs("sensitivity-slot", resolver);
        let begun = begin_as(&runs.registry, session_label(Some("sensitivity")), "TAB", "tandem.bnet");
        assert!(begun.started);
        let active = runs.registry.active().unwrap();
        assert_eq!((active.label.as_str(), active.display_label.as_str()), ("sensitivity", "Sensitivity"));
        let second = begin(&runs.registry, "OTHER", "other.bnet");
        assert_eq!(second.sentence.as_deref(), Some("What-If Sweep was not started because Sensitivity is already running for \u{201C}tandem.bnet\u{201D}. Stop or wait for that run first."));
        assert_eq!(runs.registry.stop().as_deref(), Some("Sensitivity"));
        end(begun.sweep_id.as_deref());
        assert!(runs.registry.active().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_sweep_holds_the_slot_and_stop_ends_it() {
        let _turn = TURN.lock().unwrap_or_else(|p| p.into_inner());
        let resolver = Arc::new(Resolver::new(ResolverConfig::from_process()));
        let (runs, dir) = temp_runs("slot", resolver);
        let begun = begin(&runs.registry, "TAB", "tandem.bnet");
        assert!(begun.started && begun.sentence.is_none());
        let sweep = begun.sweep_id.clone().expect("a sweep id");
        let of = |sweep: &str| QuietRequest { sweep_id: Some(sweep.to_string()), ..request("5stationtandem.inf", "qna", example("5stationtandem.inf")) };
        let active = runs.registry.active().unwrap();
        assert_eq!((active.label.as_str(), active.display_label.as_str()), (SWEEP_LABEL, "What-If Sweep"));
        // A second sweep, like any run, is refused with the registry's sentence.
        let second = begin(&runs.registry, "OTHER", "other.bnet");
        assert!(!second.started);
        assert_eq!(second.sentence.as_deref(), Some("What-If Sweep was not started because What-If Sweep is already running for \u{201C}tandem.bnet\u{201D}. Stop or wait for that run first."));
        // Stop: later points answer `stopped`, and the watcher frees the slot.
        assert_eq!(runs.registry.stop().as_deref(), Some("What-If Sweep"));
        assert_eq!(run(&runs.resolver, &runs.registry, &of(&sweep), |_| {}).unwrap(), QuietOutcome::Stopped);
        let freed = Instant::now();
        while runs.registry.active().is_some() && freed.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(runs.registry.active().is_none(), "a stopped sweep frees the slot");
        // Stop came with nothing in flight and the watcher has freed the session: the stopped
        // sweep's next point still answers `stopped`. It must not run on its own.
        assert!(session().is_none(), "the watcher freed the stopped session");
        assert_eq!(run(&runs.resolver, &runs.registry, &of(&sweep), |_| {}).unwrap(), QuietOutcome::Stopped);
        // …also when an ordinary run has taken the slot in the gap (it is not "refused" either).
        let other = runs.registry.begin("qna", RunOwner { id: "TAB".into(), title: "tandem.bnet".into() }, Arc::new(|_: &RunEvent| {})).ok().expect("the slot was free");
        assert_eq!(run(&runs.resolver, &runs.registry, &of(&sweep), |_| {}).unwrap(), QuietOutcome::Stopped);
        drop(other);
        // …and when another sweep has begun since: the old sweep's point is not run inside it.
        let next = begin(&runs.registry, "TAB", "tandem.bnet");
        assert!(next.started && next.sweep_id.as_deref() != Some(sweep.as_str()));
        assert_eq!(run(&runs.resolver, &runs.registry, &of(&sweep), |_| {}).unwrap(), QuietOutcome::Stopped);
        // Ending the old sweep leaves the new one holding the slot; ending the new one frees it at once.
        end(Some(&sweep));
        assert!(runs.registry.active().is_some());
        end(next.sweep_id.as_deref());
        assert!(runs.registry.active().is_none());
        // A page that has just loaded ends whatever sweep its predecessor left.
        assert!(begin(&runs.registry, "TAB", "tandem.bnet").started);
        end(None);
        assert!(runs.registry.active().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Gap FIX-109: the load check told a closed network "The network has no source node."
    #[test]
    fn the_load_check_tells_a_closed_network_that_it_is_one() {
        let text = std::fs::read_to_string(root().join("examples/closed/ClosedCentralServer.d3.N8.bnet")).unwrap();
        let mut doc: Value = serde_json::from_str(&text).unwrap();
        let p = probe(&doc).unwrap();
        assert_eq!(
            p.error.as_deref(),
            Some("This is a closed network: a fixed number of customers circulates and nothing arrives from outside. The load check (utilisation from the traffic equations) covers open networks.")
        );
        assert!(p.loads.is_empty() && p.stable);
        // Drawn closed, with no population yet: told what is missing, by the same rule.
        doc.as_object_mut().unwrap().remove("closedPopulation");
        let p = probe(&doc).unwrap();
        let said = p.error.unwrap();
        assert!(said.starts_with("The network has no source and no sink, but no number of customers is set.") && said.ends_with("covers open networks, which have a source and a sink."), "{said}");
        assert!(!said.contains("no source node"));
        // An open network is unchanged.
        assert_eq!(probe(&example("5stationtandem.inf")).unwrap().error, None);
    }

    #[test]
    fn an_overloaded_point_is_unstable_and_a_method_of_the_other_buffer_mode_is_refused() {
        let _turn = TURN.lock().unwrap_or_else(|p| p.into_inner());
        let resolver = Arc::new(Resolver::new(ResolverConfig::from_process()));
        let (runs, dir) = temp_runs("gap", resolver);
        let name = "5stationtandem.inf";
        let mut doc = example(name);
        assert!(probe(&doc).unwrap().stable);
        // Ten times the arrivals: every station is overloaded.
        for node in doc["nodes"].as_array_mut().unwrap() {
            if node["kind"] == "source" {
                let rate: f64 = node["distributionParameters"].as_str().unwrap().split('=').nth(1).unwrap().parse().unwrap();
                node["distributionParameters"] = Value::String(format!("{}={}", node["distributionParameters"].as_str().unwrap().split('=').next().unwrap(), rate * 10.0));
            }
        }
        let p = probe(&doc).unwrap();
        assert!(!p.stable && p.loads.iter().any(|l| l.utilisation >= 1.0), "{p:?}");
        match run(&runs.resolver, &runs.registry, &request(name, "qna", doc), |_| {}).unwrap() {
            QuietOutcome::Unstable { sentence, utilisation, .. } => {
                assert!(utilisation >= 1.0);
                assert!(sentence.contains("would be overloaded"), "{sentence}");
            }
            other => panic!("{other:?}"),
        }
        // A finite-buffer method on an infinite-buffer network: refused in a sentence, not an error.
        match run(&runs.resolver, &runs.registry, &request(name, "fm", example(name)), |_| {}).unwrap() {
            QuietOutcome::Refused { sentence } => assert_eq!(sentence, "Finite Element isn't offered for a network with infinite buffers."),
            other => panic!("{other:?}"),
        }
        assert!(run(&runs.resolver, &runs.registry, &request(name, "nope", example(name)), |_| {}).is_err());
        assert!(runs.store.lock().unwrap().records().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
