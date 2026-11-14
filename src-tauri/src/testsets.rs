//! Test ▸ Run Infinite / Finite Test Set… and Run Infinite Spectral Convergence… from the interface
//! (PLAN.md §7 P6; ledger §7.6, §14.9): the sweeps `qnet_runner::methods::testset` prepares and
//! launches, started through the app's one single-flight registry, resolver and results store
//! (`runs::Runs`), as `runs::start` starts a Run-menu method.
//!
//! The page asks with `sweep_start(request, channel)` and gets back what `run_start` sends — Status
//! lines, Shell-pane bytes through the display filter, progress, and the end with the filed record
//! — on a channel of the same `RunMessage` shape, so the same routing follows both. The sweep is
//! owned by the tab that was active when Test ▸ Run was chosen: its Status log gets the refusals,
//! and its record is filed there, with that tab's network in the provenance, as 0.90.34 filed it.
//!
//! `solver_lookup` answers whether a solver resolves (Run ▸ Multi-Class SRBM's title and tooltip,
//! which 0.90.34 took from `SolverRuntimeResolver.resolveExecutable(name: "mc_solver",
//! subdirectory: "BNAmd")`).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use qnet_core::results::model::{file_url, Provenance, RunRecord};
use qnet_core::results::{Date, Disposition, MethodMetadata};
use qnet_runner::methods::testset::{launch_sweep, prepare_spectral_convergence, prepare_test_set, SweepPrepared};
use qnet_runner::methods::{RunContext, SpectralConvergenceParameters, TestSetParameters};
use qnet_runner::store::{Finished, RunOutcome};
use qnet_runner::supervisor::{display_label, OutputSink, RunEvent, RunOwner};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::errors::QnError;
use crate::runs::{run_settings, severity_word, Changed, Emit, RunMessage, Runs, StartOutcome};

/// Which sweep the page asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SweepKind {
    /// Run Infinite Test Set….
    Infinite,
    /// Run Finite Test Set….
    Finite,
    /// Run Infinite Spectral Convergence….
    Spc,
}

/// The sheet's answer (`TestSetParameters` / `SpectralConvergenceParameters`); the ρ fields of the
/// other sweep are absent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepParams {
    pub stations_lower: i64,
    pub stations_upper: i64,
    pub classes_lower: i64,
    pub classes_upper: i64,
    #[serde(default)]
    pub rho_lower: Option<f64>,
    #[serde(default)]
    pub rho_upper: Option<f64>,
    #[serde(default)]
    pub rho_start: Option<f64>,
    #[serde(default)]
    pub rho_end: Option<f64>,
    #[serde(default)]
    pub rho_step: Option<f64>,
    pub num_test_cases: i64,
    pub topology: i64,
    /// A fixed base seed, or null for a fresh one.
    #[serde(default)]
    pub seed: Option<u64>,
}

impl SweepParams {
    fn test_set(&self) -> Result<TestSetParameters, QnError> {
        let need = |v: Option<f64>, name: &str| v.ok_or_else(|| QnError::invalid(format!("A test set needs {name}.")));
        Ok(TestSetParameters {
            stations_lower: self.stations_lower,
            stations_upper: self.stations_upper,
            classes_lower: self.classes_lower,
            classes_upper: self.classes_upper,
            rho_lower: need(self.rho_lower, "rhoLower")?,
            rho_upper: need(self.rho_upper, "rhoUpper")?,
            num_test_cases: self.num_test_cases,
            topology: self.topology,
            seed: self.seed,
        })
    }

    fn spectral_convergence(&self) -> Result<SpectralConvergenceParameters, QnError> {
        let need = |v: Option<f64>, name: &str| v.ok_or_else(|| QnError::invalid(format!("A convergence sweep needs {name}.")));
        Ok(SpectralConvergenceParameters {
            stations_lower: self.stations_lower,
            stations_upper: self.stations_upper,
            classes_lower: self.classes_lower,
            classes_upper: self.classes_upper,
            rho_start: need(self.rho_start, "rhoStart")?,
            rho_end: need(self.rho_end, "rhoEnd")?,
            rho_step: need(self.rho_step, "rhoStep")?,
            num_test_cases: self.num_test_cases,
            topology: self.topology,
            seed: self.seed,
        })
    }
}

/// A sweep the page asks for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepRequest {
    /// The owning tab's id (an upper-case UUID).
    pub tab_id: String,
    pub title: String,
    /// The owning tab's document; only the record keeps it.
    pub document: Value,
    pub kind: SweepKind,
    /// Every setting as `settings_get` returns them: the sweeps read `sim.*`, `sm.degree`, `fem.*`,
    /// `flp.*` and `output.decimals`.
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    pub params: SweepParams,
    #[serde(default)]
    pub source_path: Option<String>,
}

/// Starts a sweep: prepares it (the sheet's checks, the work folder, every case's inputs), sends
/// its Status lines, and — when the registry accepts it — files its record, streams its output and
/// progress and finishes it on a thread of its own. Returns at once.
pub fn start_sweep(runs: &Runs, req: SweepRequest, emit: Emit, changed: Changed) -> Result<(StartOutcome, Option<JoinHandle<()>>), QnError> {
    let text = serde_json::to_string(&req.document).map_err(|e| QnError::invalid(e.to_string()))?;
    let network = qnet_core::bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the tab's network.").with_detail(e.to_string()))?;
    let settings = run_settings(&req.settings, &BTreeMap::new());
    let decimals = settings.output_decimals;
    let ctx = RunContext::new(network, req.title.clone(), settings, runs.resolver.clone());

    let prepared = match req.kind {
        SweepKind::Infinite => prepare_test_set(&req.params.test_set()?, true, &ctx),
        SweepKind::Finite => prepare_test_set(&req.params.test_set()?, false, &ctx),
        SweepKind::Spc => prepare_spectral_convergence(&req.params.spectral_convergence()?, &ctx),
    };
    let run = match prepared {
        SweepPrepared::Refused(lines) => {
            for l in lines {
                emit(RunMessage::Status { text: l.text, severity: severity_word(l.severity) });
            }
            return Ok((StartOutcome { started: false }, None));
        }
        SweepPrepared::Launch(run) => run,
    };
    let label = run.sweep.label();
    let (parameters, seed, replication_seeds) = (run.parameters.clone(), run.seed, run.replication_seeds.clone());

    let summary_slot: Arc<Mutex<Option<qnet_runner::supervisor::RunSummary>>> = Arc::new(Mutex::new(None));
    let reporter = {
        let (emit, summary_slot) = (emit.clone(), summary_slot.clone());
        Arc::new(move |event: &RunEvent| match event {
            RunEvent::Status { text, severity } => emit(RunMessage::Status { text: text.clone(), severity: severity_word(*severity) }),
            RunEvent::Progress(p) => emit(RunMessage::Progress { fraction: p.fraction, elapsed_seconds: p.elapsed.as_secs_f64(), text: p.status_text(&display_label(label), "") }),
            RunEvent::Finished(summary) => *summary_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(summary.clone()),
        })
    };
    let owner = RunOwner { id: req.tab_id.clone(), title: req.title.clone() };
    let sink: Box<dyn OutputSink> = Box::new(crate::runs::DisplaySink::new(decimals, emit.clone()));
    let handle = match launch_sweep(run, &runs.registry, owner, reporter, sink) {
        Ok(h) => h,
        // The registry's refusal sentence has gone to the tab already.
        Err(_) => return Ok((StartOutcome { started: false }, None)),
    };

    // Registered as soon as the sweep is accepted, as `registerStructuredResult` did.
    let record_id = MethodMetadata::for_run_label(label).map(|meta| {
        let source = req.source_path.as_deref().map(file_url);
        let provenance = Provenance::capture(&req.tab_id, &req.title, &ctx.network, source, parameters, seed, replication_seeds, env!("CARGO_PKG_VERSION"));
        let id = runs.store.lock().unwrap_or_else(|p| p.into_inner()).begin_run(RunRecord::new(&ctx.uuid().to_uppercase(), meta, provenance, Date::now()));
        changed(&req.tab_id);
        id
    });

    let store = runs.store.clone();
    let tab_id = req.tab_id.clone();
    let finisher = std::thread::spawn(move || {
        let report = match handle.join() {
            Ok(r) => r,
            Err(_) => {
                // The sweep's thread panicked: file its record as failed and say it ended, so
                // neither is left "running" (as runs.rs does).
                let message = "The run's thread ended unexpectedly.".to_string();
                emit(RunMessage::Status { text: message.clone(), severity: "error" });
                if let Some(id) = &record_id {
                    store.lock().unwrap_or_else(|p| p.into_inner()).fail_run(id, &message, None, Date::now());
                    changed(&tab_id);
                }
                let shown = format!("{} failed", display_label(label));
                emit(RunMessage::Finished {
                    summary: shown.clone(),
                    status_bar: shown,
                    exit_code: -1,
                    user_stopped: false,
                    succeeded: false,
                    record_id: record_id.clone(),
                    filed: record_id.as_ref().map(|_| "failed".to_string()),
                    filed_reason: Some(message),
                });
                return;
            }
        };
        let summary = summary_slot.lock().unwrap_or_else(|p| p.into_inner()).take().unwrap_or_else(|| report.summary.clone());
        let (mut filed, mut reason) = (None, None);
        if let Some(id) = &record_id {
            let outcome = RunOutcome { id: id.clone(), label: display_label(label), exit_code: report.summary.exit_code, user_stopped: report.summary.user_stopped, finished_at: Date::now() };
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
    });
    Ok((StartOutcome { started: true }, Some(finisher)))
}

/// Whether a solver resolves, and the resolver's diagnostic.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SolverLookup {
    pub available: bool,
    pub diagnostic: String,
}

pub fn lookup(runs: &Runs, name: &str, subdirectory: &str) -> SolverLookup {
    let l = runs.resolver.resolve_executable(name, subdirectory);
    SolverLookup { available: l.url().is_some(), diagnostic: l.actionable_diagnostic() }
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────

/// Test ▸ Run … Test Set / Spectral Convergence: starts the sweep for the tab, streaming to `channel`.
/// Async, so preparing every case's input runs off the main thread.
#[tauri::command]
pub async fn sweep_start(app: AppHandle, runs: State<'_, Runs>, request: SweepRequest, channel: Channel<RunMessage>) -> Result<StartOutcome, QnError> {
    let emit: Emit = Arc::new(move |m| {
        let _ = channel.send(m);
    });
    let announce: Changed = {
        let app = app.clone();
        Arc::new(move |tab: &str| {
            let _ = app.emit("results://changed", tab.to_string());
        })
    };
    let (outcome, _finisher) = start_sweep(&runs, request, emit, announce)?;
    let _ = app.emit("runs://changed", ());
    Ok(outcome)
}

/// Whether `name` (in `subdirectory`) resolves: Run ▸ Multi-Class SRBM's availability.
/// Async: resolving a solver can probe it (a short-lived process).
#[tauri::command]
pub async fn solver_lookup(runs: State<'_, Runs>, name: String, subdirectory: String) -> Result<SolverLookup, QnError> {
    Ok(lookup(&runs, &name, &subdirectory))
}

#[cfg(test)]
mod tests {
    use super::*;
    use qnet_runner::resolver::{Resolver, ResolverConfig};
    use std::ffi::OsString;
    use std::path::PathBuf;

    /// Runs whose resolver finds nothing (an empty solver root) and whose store is a temp file.
    fn empty_runs(tag: &str) -> (Runs, PathBuf) {
        let dir = std::env::temp_dir().join(format!("qnet-testsets-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("solvers/bin")).unwrap();
        let mut cfg = ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.env.clear();
        cfg.env.insert(OsString::from("QNET_SOLVER_ROOT"), dir.join("solvers").into_os_string());
        cfg.env.insert(OsString::from("PATH"), OsString::from("/nonexistent"));
        cfg.development_roots = Vec::new();
        cfg.executable_dir = None;
        cfg.current_dir = dir.clone();
        let runs = Runs::with_resolver(dir.join("results-v1.json"), Arc::new(Resolver::new(cfg)));
        (runs, dir)
    }

    fn request(kind: &str, params: serde_json::Value) -> SweepRequest {
        serde_json::from_value(serde_json::json!({
            "tabId": "AAAAAAAA-0000-4000-8000-000000000001",
            "title": "Untitled",
            "document": { "nodes": [], "links": [], "infiniteBuffers": true },
            "kind": kind,
            "settings": { "sim.replications": 2, "sim.warmup": 10, "sim.time": 100, "output.decimals": 3 },
            "params": params,
        }))
        .expect("a request the page sends")
    }

    fn collect() -> (Arc<Mutex<Vec<RunMessage>>>, Emit) {
        let got: Arc<Mutex<Vec<RunMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        (got, Arc::new(move |m| g.lock().unwrap().push(m)))
    }

    fn quiet() -> Changed {
        Arc::new(|_: &str| {})
    }

    #[test]
    fn requests_read_as_the_page_writes_them() {
        let r = request("infinite", serde_json::json!({ "stationsLower": 2, "stationsUpper": 3, "classesLower": 1, "classesUpper": 2, "rhoLower": 0.5, "rhoUpper": 0.85, "numTestCases": 3, "topology": 0, "seed": 20261110u64 }));
        assert_eq!(r.kind, SweepKind::Infinite);
        let p = r.params.test_set().unwrap();
        assert_eq!((p.stations_lower, p.stations_upper, p.num_test_cases, p.seed), (2, 3, 3, Some(20261110)));
        let r = request("spc", serde_json::json!({ "stationsLower": 2, "stationsUpper": 3, "classesLower": 1, "classesUpper": 1, "rhoStart": 0.5, "rhoEnd": 0.7, "rhoStep": 0.1, "numTestCases": 2, "topology": 0, "seed": null }));
        assert_eq!(r.kind, SweepKind::Spc);
        let p = r.params.spectral_convergence().unwrap();
        assert_eq!((p.rho_start, p.rho_end, p.rho_step, p.seed), (0.5, 0.7, 0.1, None));
        // A test set without its ρ range is a malformed request, not a refusal.
        assert!(r.params.test_set().is_err());
        assert!(serde_json::from_value::<SweepRequest>(serde_json::json!({ "tabId": "x", "title": "t", "document": {}, "kind": "weekly", "params": {} })).is_err());
    }

    #[test]
    fn a_sweep_the_sheet_would_not_accept_is_refused_in_its_words() {
        let (runs, dir) = empty_runs("refused");
        let (got, emit) = collect();
        let r = request("finite", serde_json::json!({ "stationsLower": 4, "stationsUpper": 2, "classesLower": 1, "classesUpper": 2, "rhoLower": 0.5, "rhoUpper": 0.85, "numTestCases": 3, "topology": 0 }));
        let (outcome, finisher) = start_sweep(&runs, r, emit, quiet()).unwrap();
        assert!(!outcome.started && finisher.is_none());
        assert_eq!(*got.lock().unwrap(), vec![RunMessage::Status { text: "Minimum stations must not exceed the maximum.".into(), severity: "warning" }]);
        let (got, emit) = collect();
        let r = request("spc", serde_json::json!({ "stationsLower": 2, "stationsUpper": 3, "classesLower": 1, "classesUpper": 1, "rhoStart": 0.7, "rhoEnd": 0.5, "rhoStep": 0.1, "numTestCases": 2, "topology": 0 }));
        let (outcome, _) = start_sweep(&runs, r, emit, quiet()).unwrap();
        assert!(!outcome.started);
        assert_eq!(*got.lock().unwrap(), vec![RunMessage::Status { text: "ρ sweep needs 0 < start < end < 1 and 0 < step ≤ end − start.".into(), severity: "warning" }]);
        assert!(runs.registry.active().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_sweep_runs_through_the_registry_files_its_record_for_the_tab_and_finishes() {
        let (runs, dir) = empty_runs("ran");
        let (got, emit) = collect();
        let tabs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let t = tabs.clone();
        let changed: Changed = Arc::new(move |tab: &str| t.lock().unwrap().push(tab.to_string()));
        let r = request("infinite", serde_json::json!({ "stationsLower": 2, "stationsUpper": 2, "classesLower": 1, "classesUpper": 1, "rhoLower": 0.5, "rhoUpper": 0.6, "numTestCases": 1, "topology": 0, "seed": 7 }));
        // Single flight: while another run holds the registry, the sweep is refused in its words,
        // no record is filed and its work folder goes.
        {
            let (got2, emit2) = collect();
            let held = runs.registry.begin("qna", RunOwner { id: "other".into(), title: "2dtandem.bnet".into() }, Arc::new(|_: &RunEvent| {})).unwrap();
            let (refused, none) = start_sweep(&runs, r.clone(), emit2, quiet()).unwrap();
            assert!(!refused.started && none.is_none());
            assert!(got2.lock().unwrap().iter().any(|m| matches!(m, RunMessage::Status { text, .. } if text == "Test Set was not started because QNA is already running for “2dtandem.bnet”. Stop or wait for that run first.")));
            assert!(runs.store.lock().unwrap().records().is_empty());
            drop(held);
        }
        let (outcome, finisher) = start_sweep(&runs, r, emit, changed).unwrap();
        assert!(outcome.started);
        finisher.unwrap().join().unwrap();
        let messages = got.lock().unwrap().clone();
        let finished = messages.iter().find_map(|m| match m {
            RunMessage::Finished { summary, record_id, .. } => Some((summary.clone(), record_id.clone())),
            _ => None,
        });
        let (summary, record_id) = finished.expect("a finished message");
        assert!(summary.starts_with("Test Set "), "{summary}");
        let output: String = messages.iter().filter(|m| matches!(m, RunMessage::Output { .. })).count().to_string();
        assert_ne!(output, "0", "the banner reaches the Shell pane");
        let id = record_id.expect("a filed record");
        let store = runs.store.lock().unwrap();
        let rec = store.record(&id).expect("the record");
        assert_eq!(rec.provenance.tab_id, "AAAAAAAA-0000-4000-8000-000000000001");
        assert_eq!(rec.provenance.seed, Some(7));
        assert!(tabs.lock().unwrap().iter().all(|t| t == "AAAAAAAA-0000-4000-8000-000000000001"));
        drop(store);
        assert!(runs.registry.active().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_solver_is_unavailable_with_the_resolvers_diagnostic() {
        let (runs, dir) = empty_runs("lookup");
        let l = lookup(&runs, "mc_solver", "BNAmd");
        assert!(!l.available);
        assert!(!l.diagnostic.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
