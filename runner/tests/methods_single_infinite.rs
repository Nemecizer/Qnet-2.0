//! The infinite-buffer single-method run specifications (`methods/single/infinite.rs`: Whitt QNA,
//! Whitt–You RQNA, SBD, the spectral method and the Monte Carlo simulation) against 0.90.34.
//!
//! The golden acceptance: for every example with a folder for the method in `golden/runs/`, the run
//! is prepared and launched with the staged solvers as `golden/tools/GoldenRuns.swift` ran it, and
//! compared with what 0.90.34 wrote, through `common::golden_method` (its rules 1–6 are listed in
//! `tests/common/mod.rs`): the Status lines with the solver's stderr inbox, whether it launched, the
//! record's parameters, seed and replication seeds, the exit status, the full-precision archive
//! line for line after `common::normalize`, and the record 2.0's store files from that archive.
//!
//! Besides the corpus: one test per refusal and pre-check the corpus doesn't reach (every method's
//! missing-solver diagnostic over an empty solver tree, SBD's warning when `bnet` is missing and the
//! partial record that follows, each exporter's refusal, an input that cannot be written, the
//! sheet's clamps and the drawn seed), the clean-up of inputs and of `jackson_sim`'s side file, and
//! a Stop during a simulation.
mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::json::Json;
use qnet_core::model::{Network, NodeKind};
use qnet_runner::methods::{prepare, Method, Prepared, RunContext, RunSettings, StatusLine};
use qnet_runner::resolver::{Resolver, ResolverConfig};

// ─── Golden acceptance ───────────────────────────────────────────────────────────────────────────
//
// `bna_qna`, `bna_rqna`, `bna_sbd` and `jackson_sim` reproduce the corpus byte for byte on this
// Mac. `bnet` (the spectral method, linked against Apple Accelerate and SuiteSparse) does too on 30
// of the 31 networks it runs on; on Bramson94.d3.c5.reentrant.inf, given the corpus's own input
// (`golden/<ex>/export-all/cmp_sm.in`, byte-identical to what this port writes), it prints E[Q_1] =
// 16.944218 and E[Q_2] = 13.057562 where the harvested output has 16.944215 and 13.057565 (sojourn_1
// and sojourn_2 move by 1e-6 and 2e-6; at most 3e-7 relative; measured 2026-11-11). The run prints
// its table at the corpus's `output.decimals` = 3 (16.944, 13.058) and the record is parsed from
// that table, so neither the compared archive nor the record differs, and every run of these
// methods is compared exactly.

fn golden_method(method: Method) {
    common::golden_method(method);
}

#[test]
fn whitt_qna_matches_0_90_34_on_every_example() {
    golden_method(Method::Qna);
}

#[test]
fn whitt_you_rqna_matches_0_90_34_on_every_example() {
    golden_method(Method::Rqna);
}

#[test]
fn sbd_matches_0_90_34_on_every_example() {
    golden_method(Method::Sbd);
}

#[test]
fn the_infinite_spectral_method_matches_0_90_34_on_every_example() {
    golden_method(Method::InfiniteSpectral);
}

#[test]
fn the_infinite_monte_carlo_simulation_matches_0_90_34_on_every_example() {
    golden_method(Method::InfiniteMonteCarlo);
}

// ─── Networks and contexts for the checks the corpus doesn't reach ──────────────────────────────

/// `examples/<file>` as File › Open reads it.
fn example(file: &str) -> Network {
    let text = std::fs::read_to_string(common::root().join("examples").join(file)).expect("example");
    qnet_core::bnet::read(&text).expect("example reads")
}

/// The M/M/1/K example with infinite buffers and its source's rate set to `lambda`.
fn mm1(lambda: &str) -> Network {
    let mut net = example("MM1K.d1.c1.fin.bnet");
    net.infinite_buffers = true;
    for n in net.nodes.iter_mut().filter(|n| n.kind == NodeKind::Source) {
        n.parameters = format!("lambda={lambda}");
    }
    net
}

/// A context over `net` with the golden settings and `resolver`, in its own temporary folder.
fn context(net: Network, title: &str, resolver: Arc<Resolver>, tag: &str) -> RunContext {
    let mut ctx = RunContext::new(net, title, RunSettings::golden(), resolver);
    ctx.temp_dir = fresh_dir(tag);
    ctx
}

/// A resolver that finds solvers only under `root` (no app bundle, no development tree, no nearby
/// Qnet.app).
fn resolver_over(root: &Path) -> Arc<Resolver> {
    let mut cfg = ResolverConfig::from_process();
    cfg.bundle_resources = None;
    cfg.development_roots = Vec::new();
    cfg.env.insert("QNET_SOLVER_ROOT".into(), root.as_os_str().to_owned());
    cfg.current_dir = root.to_path_buf();
    cfg.executable_dir = Some(root.to_path_buf());
    Arc::new(Resolver::new(cfg))
}

/// A fresh empty folder for this test.
fn fresh_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-methods-single-inf-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn refused(method: Method, ctx: &RunContext) -> Vec<StatusLine> {
    match prepare(method, ctx) {
        Prepared::Refused(lines) => lines,
        Prepared::Launch(run) => panic!("{} launched: {:?}", method.label(), run.parameters),
    }
}

fn staged() -> Option<Arc<Resolver>> {
    let r = common::staged_resolver();
    if r.is_none() {
        println!("skipped: the staged solvers are absent");
    }
    r
}

const ALL: [Method; 5] = [Method::Qna, Method::Rqna, Method::Sbd, Method::InfiniteSpectral, Method::InfiniteMonteCarlo];

// ─── Refusals the corpus doesn't reach ───────────────────────────────────────────────────────────

#[test]
fn every_method_names_its_missing_solver_over_an_empty_tree() {
    let root = fresh_dir("empty-tree");
    let resolver = resolver_over(&root);
    let missing = |summary: &str, name: &str, dir: &str| {
        vec![
            StatusLine::error(summary),
            StatusLine::info(format!("    No loadable copy of {name} was found for {dir}.")),
            StatusLine::info("    Searched the app bundle, QNET_SOLVER_ROOT, a nearby Qnet.app, and the development source tree."),
            StatusLine::info("    Rebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree."),
        ]
    };
    let ctx = context(mm1("0.5"), "mm1.bnet", resolver, "empty-tree-ctx");
    assert_eq!(refused(Method::Qna, &ctx), missing("QNA aborted: bna_qna binary not found.", "bna_qna", "BNAqna"));
    assert_eq!(refused(Method::Rqna, &ctx), missing("RQNA aborted: bna_rqna binary not found.", "bna_rqna", "BNArqna"));
    // SBD is refused before it looks for bnet, so there is no dependency warning.
    assert_eq!(refused(Method::Sbd, &ctx), missing("SBD aborted: bna_sbd binary not found.", "bna_sbd", "BNAsbd"));
    assert_eq!(
        refused(Method::InfiniteSpectral, &ctx),
        missing("Spectral method (infinite) aborted: bnet binary not found.", "bnet", "BNAsm")
    );
    assert_eq!(
        refused(Method::InfiniteMonteCarlo, &ctx),
        missing("Simulation (infinite) aborted: jackson_sim binary not found.", "jackson_sim", "BNAsim")
    );
    let left: Vec<_> = std::fs::read_dir(&ctx.temp_dir).unwrap().collect();
    assert!(left.is_empty(), "a refused run wrote {left:?}");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_simulation_is_refused_by_its_exporter_before_its_solver_is_looked_for() {
    // 0.90.34 exported first, so an empty solver tree still gives the exporter's sentence.
    let root = fresh_dir("sim-export-first");
    let mut net = mm1("0.5");
    let sink = net.nodes.iter().find(|n| n.kind == NodeKind::Sink).unwrap().id.clone();
    net.nodes.retain(|n| n.id != sink);
    net.links.retain(|l| l.to != sink);
    let ctx = context(net, "nosink.bnet", resolver_over(&root), "sim-export-first-ctx");
    assert_eq!(
        refused(Method::InfiniteMonteCarlo, &ctx),
        vec![StatusLine::error("Simulation (infinite) aborted: The network has no sink node.")]
    );
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn each_exporter_refusal_is_reported_with_its_reason() {
    let Some(resolver) = staged() else { return };
    // ρ = 1.5 at the one station.
    let ctx = context(mm1("1.5"), "mm1.bnet", resolver.clone(), "export-refusals");
    let qna = "S1 has traffic intensity rho = 1.5000 >= 1. The arrival rate must not exceed the service capacity.";
    assert_eq!(refused(Method::Qna, &ctx), vec![StatusLine::error(format!("QNA aborted: {qna}"))]);
    assert_eq!(refused(Method::Rqna, &ctx), vec![StatusLine::error(format!("RQNA aborted: {qna}"))]);
    assert_eq!(refused(Method::Sbd, &ctx), vec![StatusLine::error(format!("SBD aborted: {qna}"))]);
    assert_eq!(
        refused(Method::InfiniteSpectral, &ctx),
        vec![StatusLine::error("Spectral method (infinite) aborted: S1 has traffic intensity rho = 1.5000 >= 1. The service rate must exceed the arrival rate at every station for the SRBM to have a stationary distribution.")]
    );
    // jackson_sim's exporter does not check the load; a network without a sink is refused.
    let mut net = mm1("0.5");
    let sink = net.nodes.iter().find(|n| n.kind == NodeKind::Sink).unwrap().id.clone();
    net.nodes.retain(|n| n.id != sink);
    net.links.retain(|l| l.to != sink);
    let ctx2 = context(net, "nosink.bnet", resolver, "export-refusals-2");
    assert_eq!(refused(Method::Qna, &ctx2), vec![StatusLine::error("QNA aborted: The network has no sink node.")]);
    assert_eq!(
        refused(Method::InfiniteMonteCarlo, &ctx2),
        vec![StatusLine::error("Simulation (infinite) aborted: The network has no sink node.")]
    );
    for c in [&ctx, &ctx2] {
        let left: Vec<_> = std::fs::read_dir(&c.temp_dir).unwrap().collect();
        assert!(left.is_empty(), "a refused run wrote {left:?}");
        let _ = std::fs::remove_dir_all(&c.temp_dir);
    }
}

#[test]
fn an_input_that_cannot_be_written_refuses_the_run_with_the_cocoa_reason() {
    let Some(resolver) = staged() else { return };
    let mut ctx = RunContext::new(mm1("0.5"), "mm1.bnet", RunSettings::golden(), resolver);
    ctx.temp_dir = PathBuf::from("/nonexistent-dir-qnet-single-inf");
    let pid = ctx.pid;
    let cases = [
        (Method::Qna, "QNA", format!("BNET_qna_{pid}.qna")),
        (Method::Rqna, "RQNA", format!("BNET_rqna_{pid}.qna")),
        (Method::Sbd, "SBD", format!("BNET_sbd_{pid}.qna")),
        (Method::InfiniteSpectral, "Spectral method (infinite)", format!("BNET_inf_sm_{pid}.in")),
        (Method::InfiniteMonteCarlo, "Simulation (infinite)", format!("BNET_inf_sim_{pid}.sim")),
    ];
    for (method, name, file) in cases {
        assert_eq!(
            refused(method, &ctx),
            vec![
                StatusLine::error(format!("{name} aborted: could not write temp file.")),
                StatusLine::info(format!("    The folder “{file}” doesn’t exist.")),
            ],
            "{}",
            method.label()
        );
    }
}

#[test]
fn sbd_without_bnet_warns_first_and_files_a_partial_record_when_it_falls_back() {
    let Some(stage) = common::staged_solver_root() else {
        println!("skipped: the staged solvers are absent");
        return;
    };
    // A tree with bna_sbd and no bnet. The two-station feedback network is one multi-station
    // subnetwork, which bna_sbd hands to bnet.
    let root = fresh_dir("sbd-no-bnet");
    let dir = root.join("bin/infinite/BNAsbd");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(stage.join("bin/infinite/BNAsbd/bna_sbd"), dir.join("bna_sbd")).unwrap();
    let title = "OpenJackson.d2.feedback.p30.inf.bnet";
    let ctx = context(example(title), title, resolver_over(&root), "sbd-no-bnet-ctx");
    let warning = StatusLine::warning(
        "SBD dependency warning: bnet is unavailable. Multi-station subnetworks will be reported as partial fallback results.",
    );
    let out = common::with_slot(|| common::run(Method::Sbd, &ctx));
    assert!(out.launched, "{:?}", out.status);
    assert_eq!(out.status[..2], [warning.clone(), StatusLine::info("Running SBD...")]);
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert!(out.archive.contains("\nQNET_SBD_STATUS_V1 fallback_used=yes"), "{}", out.archive);
    let record = common::file_record(Method::Sbd, &ctx, &common::root().join("examples").join(title), &out).expect("a record");
    let status = record.as_object().and_then(|r| r.get("status")).and_then(Json::as_str).map(str::to_string);
    assert_eq!(status.as_deref(), Some("partial"), "{}", qnet_core::json::to_pretty(&record));

    // The warning stays when the exporter then refuses the network.
    let ctx2 = context(mm1("1.5"), "mm1.bnet", resolver_over(&root), "sbd-no-bnet-ctx2");
    assert_eq!(
        refused(Method::Sbd, &ctx2),
        vec![
            warning,
            StatusLine::error("SBD aborted: S1 has traffic intensity rho = 1.5000 >= 1. The arrival rate must not exceed the service capacity."),
        ]
    );
    for d in [&ctx.temp_dir, &ctx2.temp_dir, &root] {
        let _ = std::fs::remove_dir_all(d);
    }
}

// ─── The sheets' answers ─────────────────────────────────────────────────────────────────────────

#[test]
fn the_spectral_degree_is_at_least_two_and_is_recorded() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(mm1("0.5"), "mm1.bnet", resolver, "sm-degree");
    for (stored, used) in [(1, "2"), (-3, "2"), (2, "2"), (12, "12")] {
        ctx.settings.sm_degree = stored;
        let Prepared::Launch(run) = prepare(Method::InfiniteSpectral, &ctx) else { panic!("refused") };
        assert_eq!(run.parameters.len(), 1);
        assert_eq!(run.parameters["polynomial degree"], used);
        assert_eq!(run.accepted, vec![StatusLine::info(format!("Running spectral method (infinite, degree={used})..."))]);
        assert!(run.before.is_empty());
    }
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn the_simulation_clamps_its_run_length_as_the_sheet_did() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(mm1("0.5"), "mm1.bnet", resolver, "sim-clamps");
    ctx.settings.sim_replications = 0;
    ctx.settings.sim_warmup = -5;
    ctx.settings.sim_time = 0;
    ctx.settings.sim_seed = -1;
    ctx.settings.sim_seed_fixed = true;
    let Prepared::Launch(run) = prepare(Method::InfiniteMonteCarlo, &ctx) else { panic!("refused") };
    assert_eq!(run.parameters["replications"], "1");
    assert_eq!(run.parameters["warm-up"], "0");
    assert_eq!(run.parameters["simulation time"], "1");
    assert_eq!(run.parameters["fixed seed"], "true");
    assert_eq!(run.seed, Some(0));
    assert_eq!(run.replication_seeds, vec![0]);
    assert_eq!(run.accepted, vec![StatusLine::info("Running simulation (infinite) via jackson_sim...")]);
    drop(run);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn an_unfixed_seed_is_drawn_from_one_to_int32_max_and_seeds_each_replication() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(mm1("0.5"), "mm1.bnet", resolver, "sim-seed");
    ctx.settings.sim_seed_fixed = false;
    ctx.settings.sim_replications = 4;
    ctx.entropy = Arc::new(|| 0);
    let Prepared::Launch(run) = prepare(Method::InfiniteMonteCarlo, &ctx) else { panic!("refused") };
    assert_eq!(run.seed, Some(1), "entropy 0 is the lowest seed, 1");
    assert_eq!(run.replication_seeds, vec![1, 2, 3, 4]);
    assert_eq!(run.parameters["fixed seed"], "false");
    drop(run);
    ctx.entropy = Arc::new(|| u64::from(u32::MAX) * 7 + 3);
    let Prepared::Launch(run) = prepare(Method::InfiniteMonteCarlo, &ctx) else { panic!("refused") };
    let seed = run.seed.unwrap();
    assert!((1..=i32::MAX as u64).contains(&seed), "{seed}");
    assert_eq!(run.replication_seeds, (seed..seed + 4).collect::<Vec<_>>());
    drop(run);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

// ─── Temporary files ─────────────────────────────────────────────────────────────────────────────

#[test]
fn a_prepared_run_that_is_never_launched_leaves_no_input_behind() {
    let Some(resolver) = staged() else { return };
    let ctx = context(mm1("0.5"), "mm1.bnet", resolver, "unlaunched");
    let pid = ctx.pid;
    let names = [
        format!("BNET_qna_{pid}.qna"),
        format!("BNET_rqna_{pid}.qna"),
        format!("BNET_sbd_{pid}.qna"),
        format!("BNET_inf_sm_{pid}.in"),
        format!("BNET_inf_sim_{pid}.sim"),
    ];
    for (method, name) in ALL.iter().zip(&names) {
        let Prepared::Launch(run) = prepare(*method, &ctx) else { panic!("{} refused", method.label()) };
        let input = run.temps.paths()[0].clone();
        assert_eq!(input, ctx.temp_dir.join(name), "{}", method.label());
        assert!(input.is_file());
        drop(run);
        assert!(!input.exists(), "{} left {}", method.label(), input.display());
    }
    let left: Vec<_> = std::fs::read_dir(&ctx.temp_dir).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn a_finished_run_leaves_nothing_in_its_temporary_folder() {
    let Some(resolver) = staged() else { return };
    // jackson_sim also writes `<input stem>_results.txt` beside its input.
    let title = "3dtandem.inf.bnet";
    let ctx = context(example(title), title, resolver, "finished");
    for method in ALL {
        let out = common::with_slot(|| common::run(method, &ctx));
        assert_eq!(out.exit_code, Some(0), "{}: {}", method.label(), out.archive);
        let left: Vec<_> = std::fs::read_dir(&ctx.temp_dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert!(left.is_empty(), "{} left {left:?}", method.label());
    }
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn a_stop_during_a_simulation_removes_its_files_and_leaves_no_solver_running() {
    use qnet_runner::methods::launch;
    use qnet_runner::supervisor::{CollectSink, RunEvent, RunOwner, RunRegistry};
    let Some(resolver) = staged() else { return };
    let title = "3dtandem.inf.bnet";
    let mut ctx = context(example(title), title, resolver, "stop");
    ctx.settings.sim_time = 2_000_000_000;
    ctx.settings.sim_replications = 2;
    let Prepared::Launch(run) = prepare(Method::InfiniteMonteCarlo, &ctx) else { panic!("refused") };
    let input = run.temps.paths()[0].clone();
    let registry = RunRegistry::new();
    let status: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = status.clone();
    let reporter = Arc::new(move |e: &RunEvent| {
        if let RunEvent::Status { text, .. } = e {
            seen.lock().unwrap().push(text.clone());
        }
    });
    let owner = RunOwner { id: "tab".into(), title: ctx.title.clone() };
    let handle = launch(run, &registry, owner, reporter, Box::new(CollectSink::default())).expect("accepted");
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert!(registry.stop().is_some(), "a run to stop");
    let report = handle.join().expect("the job");
    assert!(report.summary.cancelled(), "{:?}", report.summary);
    let archive = report.archive_text();
    assert!(archive.starts_with("[Threads] Using "), "{archive}");
    assert!(archive.contains("Running simulation ...  ["), "{archive}");
    assert!(!archive.contains("Elapsed time"), "the wrapper died with the solver: {archive}");
    let alive = std::process::Command::new("pgrep").arg("-f").arg(input.to_string_lossy().as_ref()).output().unwrap();
    assert!(alive.stdout.is_empty(), "a solver survived: {}", String::from_utf8_lossy(&alive.stdout));
    let left: Vec<_> = std::fs::read_dir(&ctx.temp_dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
    assert!(left.is_empty(), "left {left:?}");
    assert_eq!(
        *status.lock().unwrap(),
        vec!["Running simulation (infinite) via jackson_sim...".to_string(), "Monte Carlo cancelled.".to_string()]
    );
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}
