//! Run › Test Set and Run › Spectral Convergence (`methods/testset.rs`) against 0.90.34.
//!
//! The golden acceptance: `golden/runs/_testsets/` holds the three seeded sweeps
//! `golden/tools/GoldenRuns.swift` (`runGoldenTestSets`) ran with 0.90.34's own code path: an
//! infinite and a finite test set (2–3 stations, 1–2 classes, ρ 0.50–0.85, feed-forward, 3 cases,
//! base seeds 20261110 and 20261111) and a convergence sweep (2–3 stations, 1 class, ρ 0.5 → 0.7
//! step 0.1, 2 cases, base seed 20261112), with the corpus's settings. Each is prepared and launched
//! here with the staged solvers and compared with what 0.90.34 wrote: the Status lines (none), the
//! record's parameters, base seed and replication seeds, the exit status, the full-precision
//! archive line for line after `common::normalize`, and the record 2.0's store files from that
//! archive against `record.json`.
//!
//! The sweeps are not Run-menu methods, so `common::golden_method` and `common::file_record` (both
//! keyed by `Method`) don't fit; this file has its own small harness, built the same way and using
//! `common`'s pieces. Two rules besides `common`'s:
//!
//! - Each spinner line ends "done in X.XXs", the case's wall-clock time; that number is masked
//!   ([`mask_case_time`]), as `common::normalize` masks the other frames' times.
//! - The record is filed for the tab that launched the sweep, which in the corpus was the owner's
//!   restored document `Randon.reentrant.s3.bnet` (the record's `networkSnapshot`, title and
//!   `sourceFileURL`), with the buffer mode `runGoldenTestSets` set. 0.90.34 filed every sweep as
//!   failed ("The solver produced no recognized station performance measures."); 2.0 files a sweep
//!   that exits 0 as completed (RES-047, METH-150, TEST-019, TEST-029, Changed), so the golden
//!   record is compared with that status and without the failure message.
//!
//! Besides the corpus: the refusals the corpus doesn't reach (the sheets' sentences; the folder
//! check is a unit test in the module), a sweep over an empty solver tree, the work folder's
//! removal after a run and on a refused launch, Stop, and an unfixed base seed.
mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::json::{self, Json};
use qnet_runner::methods::testset::{
    launch_sweep, prepare_spectral_convergence, prepare_test_set, Sweep, SweepPrepared,
};
use qnet_runner::methods::{RunContext, RunSettings, SpectralConvergenceParameters, StatusLine, TestSetParameters};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use qnet_runner::supervisor::{CollectSink, RunEvent, RunOwner, RunRegistry, Severity};

// ─── The harness ─────────────────────────────────────────────────────────────────────────────────

/// What one sweep produced in 2.0.
#[derive(Debug)]
struct Ran {
    status: Vec<StatusLine>,
    parameters: BTreeMap<String, String>,
    seed: Option<u64>,
    replication_seeds: Vec<u64>,
    archive: String,
    exit_code: i32,
    work_dir: PathBuf,
}

/// The Status lines a reporter receives.
fn collector() -> (Arc<Mutex<Vec<StatusLine>>>, qnet_runner::supervisor::Reporter) {
    let lines: Arc<Mutex<Vec<StatusLine>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = lines.clone();
    let reporter = Arc::new(move |event: &RunEvent| {
        if let RunEvent::Status { text, severity } = event {
            seen.lock().unwrap().push(StatusLine::new(text.clone(), *severity));
        }
    });
    (lines, reporter)
}

/// Launches a prepared sweep on a fresh registry and waits for it.
fn run(prepared: SweepPrepared, title: &str) -> Ran {
    let run = match prepared {
        SweepPrepared::Launch(run) => run,
        SweepPrepared::Refused(lines) => panic!("refused: {lines:?}"),
    };
    let (parameters, seed, replication_seeds, work_dir) =
        (run.parameters.clone(), run.seed, run.replication_seeds.clone(), run.work_dir.clone());
    let (lines, reporter) = collector();
    let owner = RunOwner { id: "golden-tab".into(), title: title.into() };
    let handle = launch_sweep(run, &RunRegistry::new(), owner, reporter, Box::new(CollectSink::default()))
        .expect("a fresh registry accepts the sweep");
    let report = handle.join().expect("the job thread");
    let status = lines.lock().unwrap().clone();
    Ran { status, parameters, seed, replication_seeds, archive: report.archive_text(), exit_code: report.summary.exit_code, work_dir }
}

/// The wall-clock time at the end of a spinner line ("…ρ=0.736 done in 0.08s"), masked.
fn mask_case_time(text: &str) -> String {
    text.split('\n')
        .map(|line| match line.rfind(" done in ") {
            Some(at) => {
                let time = &line[at + " done in ".len()..];
                let digits = time.strip_suffix('s').unwrap_or("");
                let numeric = digits.split_once('.').is_some_and(|(w, f)| {
                    !w.is_empty() && !f.is_empty() && w.bytes().all(|b| b.is_ascii_digit()) && f.bytes().all(|b| b.is_ascii_digit())
                });
                if numeric {
                    format!("{} done in <T>s", &line[..at])
                } else {
                    line.to_string()
                }
            }
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// An archive made comparable: `common::normalize`, then the case times masked.
fn comparable_archive(text: &str) -> String {
    mask_case_time(&common::normalize(text, None, None))
}

/// The tab the corpus's sweeps were launched from: the network, title and file of the golden
/// record (`Randon.reentrant.s3.bnet`, restored in 0.90.34's session when the corpus was made).
fn golden_owner(g: &common::Golden) -> (qnet_core::model::Network, String, String) {
    let record = g.record.as_ref().expect("record.json");
    let provenance = record.as_object().and_then(|r| r.get("provenance")).and_then(Json::as_object).expect("provenance");
    let snapshot = provenance.get("networkSnapshot").expect("networkSnapshot");
    let network = qnet_core::bnet::read(&json::to_pretty(snapshot)).expect("the snapshot reads as a network");
    let title = provenance.get("networkTitle").and_then(Json::as_str).expect("networkTitle").to_string();
    let url = provenance.get("sourceFileURL").and_then(Json::as_str).expect("sourceFileURL");
    let path = url.strip_prefix("file://").expect("a file URL").to_string();
    (network, title, path)
}

/// Files the sweep as 0.90.34 did (`registerStructuredResult` at launch, `finalizeStructuredResult`
/// at the end) through 2.0's `ResultsStore`, and returns the record as JSON.
fn file_record(sweep: Sweep, ctx: &RunContext, source: &str, ran: &Ran) -> Json {
    use qnet_core::results::model::{file_url, Provenance, RunRecord};
    use qnet_core::results::{Date, MethodMetadata};
    use qnet_runner::store::{ResultsStore, RunOutcome};
    let meta = MethodMetadata::for_run_label(sweep.label()).expect("a Results method for the sweep");
    let dir = common::fresh_dir(&format!("store-{}-{}", sweep.label(), ctx.uuid()));
    let mut store = ResultsStore::open(dir.join("results-v1.json"));
    let provenance = Provenance::capture(
        "golden-tab",
        &ctx.title,
        &ctx.network,
        Some(file_url(source)),
        ran.parameters.clone(),
        ran.seed,
        ran.replication_seeds.clone(),
        "2.0.0",
    );
    let id = store.begin_run(RunRecord::new(&ctx.uuid().to_uppercase(), meta, provenance, Date::now()));
    let outcome = RunOutcome {
        id: id.clone(),
        label: sweep.display_label(),
        exit_code: ran.exit_code,
        user_stopped: false,
        finished_at: Date::now(),
    };
    store.finish_run(&outcome, Some(&ran.archive));
    let record = store.record(&id).and_then(|r| r.to_json().ok()).expect("the filed record");
    let _ = std::fs::remove_dir_all(&dir);
    record
}

/// The golden record as 2.0 files it: completed, with no failure message (RES-047, D5).
fn as_completed(record: &Json) -> Json {
    let mut r = record.clone();
    if let Json::Object(map) = &mut r {
        assert_eq!(map.get("status").and_then(Json::as_str), Some("failed"), "0.90.34 filed every sweep as failed");
        map.insert("status".into(), Json::String("completed".into()));
        map.remove("failureMessage");
    }
    r
}

/// Compares one golden sweep with 2.0's.
fn check_golden(folder: &str, sweep: Sweep, prepare: impl FnOnce(&RunContext) -> SweepPrepared) {
    let Some(resolver) = common::golden_resolver(folder) else { return };
    let g = common::golden("_testsets", folder).expect("golden/runs/_testsets/<folder>");
    assert!(common::complete(&g), "{folder}: the golden folder is incomplete");
    let (network, title, source) = golden_owner(&g);
    let mut ctx = RunContext::new(network, title.clone(), RunSettings::golden(), resolver);
    ctx.temp_dir = common::fresh_dir(&format!("sweep-{folder}"));
    let ran = common::with_slot(|| run(prepare(&ctx), &title));

    let expected = common::expected_status(&g);
    assert_eq!(common::actual_status(&ran.status), expected, "{folder}: Status lines");
    assert_eq!(ran.parameters, g.parameters(), "{folder}: parameters");
    assert_eq!(ran.seed, g.seed(), "{folder}: base seed");
    assert_eq!(ran.replication_seeds, g.replication_seeds(), "{folder}: replication seeds");
    assert_eq!(Some(ran.exit_code), g.exit_code, "{folder}: exit status");
    if let Some(d) = common::first_difference(&comparable_archive(&g.archive), &comparable_archive(&ran.archive)) {
        panic!("{folder}: archive differs at {d}");
    }
    assert!(!ran.work_dir.exists(), "{folder}: the work folder outlived the sweep");

    let filed = file_record(sweep, &ctx, &source, &ran);
    let golden_record = as_completed(g.record.as_ref().expect("record.json"));
    if let Some(d) = common::first_difference(&common::comparable_text(&golden_record, true), &common::comparable_text(&filed, true)) {
        panic!("{folder}: filed record differs at {d}");
    }
    let left: Vec<_> = std::fs::read_dir(&ctx.temp_dir).unwrap().collect();
    assert!(left.is_empty(), "{folder}: left behind {left:?}");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    println!("{folder}: matches 0.90.34");
}

/// `runGoldenTestSets`'s infinite test set: `TestSetParameters()` with 2…3 stations, 1…2 classes,
/// 3 cases and base seed 20261110.
fn golden_infinite_parameters() -> TestSetParameters {
    TestSetParameters {
        stations_lower: 2,
        stations_upper: 3,
        classes_lower: 1,
        classes_upper: 2,
        num_test_cases: 3,
        seed: Some(20261110),
        ..TestSetParameters::default()
    }
}

// ─── Golden acceptance ───────────────────────────────────────────────────────────────────────────
//
// Every number in the three golden archives came out the same on this Mac, including the Spectral
// (bnet) and FE (bna_fm_gauss) columns, so the sweeps are compared exactly.

#[test]
fn the_infinite_test_set_matches_0_90_34() {
    check_golden("testset-infinite", Sweep::InfiniteTestSet, |ctx| prepare_test_set(&golden_infinite_parameters(), true, ctx));
}

#[test]
fn the_finite_test_set_matches_0_90_34() {
    let params = TestSetParameters { seed: Some(20261111), ..golden_infinite_parameters() };
    check_golden("testset-finite", Sweep::FiniteTestSet, |ctx| prepare_test_set(&params, false, ctx));
}

#[test]
fn the_spectral_convergence_sweep_matches_0_90_34() {
    let params = SpectralConvergenceParameters {
        stations_lower: 2,
        stations_upper: 3,
        classes_lower: 1,
        classes_upper: 1,
        rho_start: 0.5,
        rho_end: 0.7,
        rho_step: 0.1,
        num_test_cases: 2,
        seed: Some(20261112),
        ..SpectralConvergenceParameters::default()
    };
    check_golden("spc", Sweep::SpectralConvergence, |ctx| prepare_spectral_convergence(&params, ctx));
}

// ─── Beyond the corpus ───────────────────────────────────────────────────────────────────────────

/// A context over the M/M/1/K example with the golden settings, in a fresh temporary folder.
fn context(resolver: Arc<Resolver>, tag: &str) -> RunContext {
    let text = std::fs::read_to_string(common::root().join("examples/MM1K.d1.c1.fin.bnet")).expect("example");
    let network = qnet_core::bnet::read(&text).expect("example reads");
    let mut ctx = RunContext::new(network, "MM1K.d1.c1.fin.bnet", RunSettings::golden(), resolver);
    ctx.temp_dir = common::fresh_dir(&format!("sweep-{tag}"));
    ctx
}

/// A resolver that finds solvers only under `root`.
fn resolver_over(root: &Path) -> Arc<Resolver> {
    let mut cfg = ResolverConfig::from_process();
    cfg.bundle_resources = None;
    cfg.development_roots = Vec::new();
    cfg.env.insert("QNET_SOLVER_ROOT".into(), root.as_os_str().to_owned());
    cfg.current_dir = root.to_path_buf();
    cfg.executable_dir = Some(root.to_path_buf());
    Arc::new(Resolver::new(cfg))
}

fn staged() -> Option<Arc<Resolver>> {
    let r = common::staged_resolver();
    if r.is_none() {
        println!("skipped: the staged solvers are absent");
    }
    r
}

#[test]
fn parameters_the_sheet_would_refuse_are_refused_with_its_sentence_and_leave_no_folder() {
    let root = common::fresh_dir("sweep-refusals-tree");
    let ctx = context(resolver_over(&root), "refusals");
    let refused = |p: SweepPrepared| match p {
        SweepPrepared::Refused(lines) => lines,
        SweepPrepared::Launch(run) => panic!("launched: {run:?}"),
    };
    let bad = TestSetParameters { stations_lower: 5, stations_upper: 4, ..TestSetParameters::default() };
    assert_eq!(refused(prepare_test_set(&bad, true, &ctx)), vec![StatusLine::warning("Minimum stations must not exceed the maximum.")]);
    let bad = TestSetParameters { rho_upper: 1.0, ..TestSetParameters::default() };
    assert_eq!(refused(prepare_test_set(&bad, false, &ctx)), vec![StatusLine::warning("ρ must lie strictly between 0 and 1.")]);
    let bad = SpectralConvergenceParameters { rho_step: 0.5, ..SpectralConvergenceParameters::default() };
    assert_eq!(
        refused(prepare_spectral_convergence(&bad, &ctx)),
        vec![StatusLine::warning("ρ sweep needs 0 < start < end < 1 and 0 < step ≤ end − start.")]
    );
    let bad = SpectralConvergenceParameters { num_test_cases: 0, ..SpectralConvergenceParameters::default() };
    assert_eq!(refused(prepare_spectral_convergence(&bad, &ctx)), vec![StatusLine::warning("Test cases must be between 1 and 200.")]);
    let left: Vec<_> = std::fs::read_dir(&ctx.temp_dir).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_sweep_over_an_empty_solver_tree_skips_every_solver_and_prints_empty_rows() {
    let root = common::fresh_dir("sweep-empty-tree");
    let ctx = context(resolver_over(&root), "empty-tree");
    let params = TestSetParameters { num_test_cases: 2, seed: Some(7), ..TestSetParameters::default() };
    let ran = run(prepare_test_set(&params, true, &ctx), "MM1K.d1.c1.fin.bnet");
    assert_eq!(ran.exit_code, 0);
    assert!(ran.status.is_empty(), "{:?}", ran.status);
    let archive = comparable_archive(&ran.archive);
    assert!(archive.contains("\n  [1/2] d="), "{archive}");
    assert!(archive.contains(" done in <T>s\n  [2/2] d="), "{archive}");
    for algo in ["Spectral", "QNA", "RQNA", "SBD", "Average of Algorithms", "Sim (ref)"] {
        let row = archive.lines().find(|l| l.starts_with(algo)).unwrap_or_else(|| panic!("no {algo} row: {archive}"));
        assert!(row.ends_with("      0"), "{row}");
        assert!(row.contains("—"), "{row}");
    }
    assert!(archive.ends_with("Elapsed time: <T>s\n\n"), "{archive}");
    assert!(!ran.work_dir.exists());
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_spinner_draws_its_first_and_last_frames_as_the_bash_fragment_did() {
    let Some(resolver) = staged() else { return };
    let ctx = context(resolver, "frames");
    let params = SpectralConvergenceParameters {
        stations_lower: 2,
        stations_upper: 2,
        classes_lower: 1,
        classes_upper: 1,
        rho_start: 0.5,
        rho_end: 0.6,
        rho_step: 0.1,
        num_test_cases: 1,
        seed: Some(3),
        ..SpectralConvergenceParameters::default()
    };
    let ran = common::with_slot(|| run(prepare_spectral_convergence(&params, &ctx), "MM1K.d1.c1.fin.bnet"));
    assert_eq!(ran.exit_code, 0);
    let line = ran.archive.lines().find(|l| l.starts_with("      ρ=0.500 [ ]")).unwrap_or_else(|| panic!("{}", ran.archive));
    let last = line.rsplit('\r').next().unwrap();
    assert!(last.starts_with("      ρ=0.500 done in ") && last.ends_with('s'), "{line:?}");
    assert!(ran.archive.contains("  [1/1] d=2 K=1  (2 ρ values)\n      ρ=0.500 [ ]"), "{}", ran.archive);
    for frame in line.split('\r').skip(1) {
        assert!(frame.starts_with("      ρ=0.500 "), "{frame:?}");
        assert!(!frame.contains("\x1b["), "the fragment redrew with a bare carriage return: {frame:?}");
    }
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn an_unfixed_base_seed_is_drawn_from_the_contexts_randomness_and_recorded() {
    let root = common::fresh_dir("sweep-seed-tree");
    let mut ctx = context(resolver_over(&root), "seed");
    ctx.entropy = Arc::new(|| 0xfeed_beef_dead_cafe);
    let params = TestSetParameters { num_test_cases: 1, seed: None, ..TestSetParameters::default() };
    let SweepPrepared::Launch(run) = prepare_test_set(&params, false, &ctx) else { panic!("refused") };
    assert_eq!(run.seed, Some(0xfeed_beef_dead_cafe));
    assert_eq!(run.replication_seeds.len(), 1);
    assert!(run.replication_seeds[0] <= i32::MAX as u64);
    assert_eq!(run.parameters["capacity"], "finite");
    assert_eq!(run.parameters["rho range"], "0.5...0.85");
    assert_eq!(run.sweep.label(), "testset");
    drop(run);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_refused_launch_removes_the_work_folder_at_once() {
    let root = common::fresh_dir("sweep-refused-tree");
    let ctx = context(resolver_over(&root), "refused-launch");
    let params = TestSetParameters { num_test_cases: 2, seed: Some(1), ..TestSetParameters::default() };
    let SweepPrepared::Launch(run) = prepare_test_set(&params, true, &ctx) else { panic!("refused") };
    let work_dir = run.work_dir.clone();
    assert!(work_dir.join("case_0.qna").is_file() && work_dir.join("case_1.smin").is_file() && work_dir.join("case_1.sim").is_file());
    assert!(work_dir.file_name().unwrap().to_string_lossy().starts_with(&format!("BNET_testset_{}_", ctx.pid)));
    // Another run holds the registry.
    let registry = RunRegistry::new();
    let (_, busy_reporter) = collector();
    let _held = registry.begin("qna", RunOwner { id: "other".into(), title: "Other.bnet".into() }, busy_reporter).expect("free");
    let (lines, reporter) = collector();
    let refused = launch_sweep(run, &registry, RunOwner { id: "tab".into(), title: "MM1K.d1.c1.fin.bnet".into() }, reporter, Box::new(CollectSink::default()));
    let message = refused.expect_err("single flight refuses the sweep").message;
    assert_eq!(message, "Test Set was not started because QNA is already running for “Other.bnet”. Stop or wait for that run first.");
    assert_eq!(*lines.lock().unwrap(), vec![StatusLine::warning(message)]);
    assert!(!work_dir.exists(), "the work folder outlived the refused launch");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_stop_during_a_sweep_removes_the_work_folder_and_leaves_no_solver_running() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(resolver, "stop");
    // Long simulations, so the first case is still running when Stop arrives.
    ctx.settings.sim_time = 200_000_000;
    let params = TestSetParameters { num_test_cases: 3, seed: Some(11), ..TestSetParameters::default() };
    let SweepPrepared::Launch(run) = prepare_test_set(&params, true, &ctx) else { panic!("refused") };
    let work_dir = run.work_dir.clone();
    let registry = RunRegistry::new();
    let (lines, reporter) = collector();
    let sink = CollectSink::default();
    let shown = sink.buffer.clone();
    let owner = RunOwner { id: "tab".into(), title: "MM1K.d1.c1.fin.bnet".into() };
    let handle = launch_sweep(run, &registry, owner, reporter, Box::new(sink)).expect("accepted");
    // Wait until the first case's simulation is running.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !work_dir.join("out_0_Sim.txt").exists() {
        assert!(std::time::Instant::now() < deadline, "the simulation never started");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(registry.stop().is_some(), "a sweep to stop");
    let report = handle.join().expect("the job");
    assert!(report.summary.cancelled(), "{:?}", report.summary);
    assert!(!work_dir.exists(), "the work folder outlived the Stop");
    let archive = report.archive_text();
    assert!(archive.contains("  [1/3] d="), "{archive}");
    assert!(!archive.contains("[2/3]") && !archive.contains("Elapsed time"), "the wrapper died with the solver: {archive}");
    assert_eq!(String::from_utf8_lossy(&shown.lock().unwrap()), archive, "the Shell saw what was archived");
    let alive = std::process::Command::new("pgrep").arg("-f").arg(work_dir.to_string_lossy().as_ref()).output().unwrap();
    assert!(alive.stdout.is_empty(), "a solver survived: {}", String::from_utf8_lossy(&alive.stdout));
    assert_eq!(*lines.lock().unwrap(), vec![StatusLine::new("Test Set cancelled.", Severity::Warning)]);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}
