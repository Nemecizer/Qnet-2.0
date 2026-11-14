//! The exact-family run specifications (`methods/exact.rs`, `regenerative.rs`, `bar.rs`,
//! `multiclass.rs`) against 0.90.34.
//!
//! The golden acceptance: for every example with a folder for the method in `golden/runs/`, the run
//! is prepared and launched with the staged solvers as `golden/tools/GoldenRuns.swift` ran it, and
//! compared with what 0.90.34 wrote: the Status lines (`status.txt`, with the solver's stderr inbox
//! from `status-inbox.txt` drained as 0.90.34's poller drained it), whether it launched, the
//! record's parameters, seed and replication seeds, the exit status, the full-precision archive
//! line for line after `common::normalize`, and the record 2.0's store files from that archive
//! (`common::file_record`) against `record.json`, both through `common::comparable_record`.
//!
//! The comparison rules (failure-line order, the stderr inbox, the corpus's settings and CPU count,
//! slow and partial runs, bash's job report for a signal) are `common`'s, listed with
//! `common::golden_method`.
//!
//! Besides the corpus: unit tests for the refusals and pre-checks the corpus doesn't reach (each
//! QBD condition, the truncated CTMC's scale guard at the 64 cap and for one station, every
//! method's missing-solver diagnostic over an empty solver tree, the engine fallback note both
//! ways, the multi-class SRBM's unwritable input; its "could not serialize" refusal is covered by
//! `multiclass.rs`'s `encodable` unit test, as no saved document can hold a non-finite number), the
//! D5 exit status of a failing Adaptive BAR solver, and, per dual-engine method, a check that the
//! Python engine prints the same archive as the C engine apart from the engine's name, and so files
//! the same measurements.
mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::model::{Distribution, Link, Network, NodeKind};
use qnet_core::json::Json;
use qnet_runner::methods::{prepare, Method, Prepared, RunContext, RunSettings, StatusLine};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use qnet_runner::supervisor::Severity;

// ─── Golden acceptance ───────────────────────────────────────────────────────────────────────────
//
// The harness and its rules are `common::golden_method` (rules 1–6 in `tests/common/mod.rs`). Every
// solver these methods start reproduced the corpus exactly when rebuilt on a second Mac
// (2026-11-11).

fn golden_method(method: Method) {
    common::golden_method(method);
}

#[test]
fn exact_open_product_form_matches_0_90_34_on_every_example() {
    golden_method(Method::ProductForm);
}

#[test]
fn exact_matrix_analytic_qbd_matches_0_90_34_on_every_example() {
    golden_method(Method::Qbd);
}

#[test]
fn adaptive_truncated_ctmc_matches_0_90_34_on_every_example() {
    golden_method(Method::TruncatedCtmc);
}

#[test]
fn exact_sparse_ctmc_matches_0_90_34_on_every_example() {
    golden_method(Method::GenericCtmc);
}

#[test]
fn finite_buffer_decomposition_matches_0_90_34_on_every_example() {
    golden_method(Method::FiniteDecomposition);
}

#[test]
fn regenerative_monte_carlo_matches_0_90_34_on_every_example() {
    golden_method(Method::RegenerativeMonteCarlo);
}

#[test]
fn adaptive_low_rank_bar_matches_0_90_34_on_every_example() {
    golden_method(Method::AdaptiveBar);
}

#[test]
fn bar_moment_bounds_match_0_90_34_on_every_example() {
    golden_method(Method::BarBounds);
}

#[test]
fn multi_class_srbm_matches_0_90_34_on_every_example() {
    golden_method(Method::MultiClassSrbm);
}

// ─── Networks for the checks the corpus doesn't reach ───────────────────────────────────────────

/// `examples/<file>` as File › Open reads it.
fn example(file: &str) -> Network {
    let text = std::fs::read_to_string(common::root().join("examples").join(file)).expect("example");
    qnet_core::bnet::read(&text).expect("example reads")
}

/// The M/M/1/K example with its source's rate set to `lambda`, in either buffer mode.
fn mm1(lambda: &str, infinite: bool) -> Network {
    let mut net = example("MM1K.d1.c1.fin.bnet");
    net.infinite_buffers = infinite;
    for n in net.nodes.iter_mut().filter(|n| n.kind == NodeKind::Source) {
        n.parameters = format!("lambda={lambda}");
    }
    net
}

fn node_id(net: &Network, name: &str) -> String {
    net.nodes.iter().find(|n| n.name == name).expect(name).id.clone()
}

fn link(id: &str, from: &str, to: &str, probability: f64) -> Link {
    Link { id: id.into(), from: from.into(), to: to.into(), probability, class: 0, to_class: None }
}

/// A context over `net` with the golden settings and `resolver`, in a private temporary folder.
fn context(net: Network, title: &str, resolver: Arc<Resolver>) -> RunContext {
    RunContext::new(net, title, RunSettings::golden(), resolver)
}

/// A resolver that finds solvers only under `root` (no app bundle, no development tree, no nearby
/// Qnet.app), with this process's `PATH` for Python.
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
    let dir = std::env::temp_dir().join(format!("qnet-methods-exact-{tag}-{}", std::process::id()));
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

// ─── Refusals the corpus doesn't reach ───────────────────────────────────────────────────────────

#[test]
fn every_method_names_its_missing_solver_over_an_empty_tree() {
    let root = fresh_dir("empty-tree");
    let resolver = resolver_over(&root);
    let searched = "    Searched the app bundle, QNET_SOLVER_ROOT, a nearby Qnet.app, and the development source tree.";
    let rebuild = "    Rebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree.";
    let single = |summary: &str, name: &str, dir: &str| {
        vec![
            StatusLine::error(summary),
            StatusLine::info(format!("    No loadable copy of {name} was found for {dir}.")),
            StatusLine::info(searched),
            StatusLine::info(rebuild),
        ]
    };
    let dual = |summary: &str, method: &str, native: &str, script: &str| {
        vec![
            StatusLine::error(summary),
            StatusLine::info(format!("    Neither engine for {method} could be resolved: no loadable {native} and no runnable {script}. Rebuild the solvers with ./build_all_algorithms.sh, or reinstall the application.")),
        ]
    };
    let inf = || context(mm1("0.5", true), "mm1.bnet", resolver.clone());
    let fin = || context(mm1("0.5", false), "mm1.bnet", resolver.clone());
    assert_eq!(refused(Method::ProductForm, &inf()), single("Exact product form aborted: solver support is unavailable.", "solver.py", "BNApf"));
    assert_eq!(
        refused(Method::FiniteDecomposition, &fin()),
        single("Finite-buffer decomposition aborted: Python solver runtime unavailable.", "fbna_decomp.py", "fBNAdecomp")
    );
    assert_eq!(refused(Method::AdaptiveBar, &inf()), single("Adaptive low-rank BAR aborted: solver not found.", "low_rank_bar.py", "BNAalr"));
    assert_eq!(refused(Method::BarBounds, &inf()), single("BAR moment bounds aborted: solver not found.", "solver.py", "BNAbb"));
    assert_eq!(refused(Method::MultiClassSrbm, &inf()), single("Multi-class SRBM aborted: mc_solver binary not found.", "mc_solver", "BNAmd"));
    assert_eq!(
        refused(Method::Qbd, &inf()),
        dual("Exact QBD aborted: solver support is unavailable.", "Exact Matrix-Analytic QBD", "bna_qbd", "qbd_solver.py")
    );
    assert_eq!(
        refused(Method::TruncatedCtmc, &inf()),
        dual("Adaptive truncated CTMC aborted: solver not found.", "Adaptive Truncated CTMC", "bna_tc", "truncated_ctmc.py")
    );
    assert_eq!(
        refused(Method::GenericCtmc, &fin()),
        dual("Exact sparse CTMC aborted: Python solver runtime unavailable.", "Exact Sparse CTMC", "fbna_gc", "solver.py")
    );
    for net in [inf(), fin()] {
        assert_eq!(
            refused(Method::RegenerativeMonteCarlo, &net),
            dual("Regenerative Monte Carlo aborted: simulator not found.", "Regenerative Monte Carlo", "bna_rmc", "regenerative_mc.py")
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_qbd_refuses_each_network_outside_its_one_queue_mapping() {
    let Some(resolver) = staged() else { return };
    let qbd = |net: Network| refused(Method::Qbd, &context(net, "q.bnet", resolver.clone()));
    let warn = |reason: &str| vec![StatusLine::warning(format!("Exact QBD not started: {reason}"))];

    // A finite network never reaches the exporter: the Run menu of a finite network has no QBD
    // item (`exact.rs` tests the exporter's finite-buffer sentence directly).
    assert_eq!(qbd(mm1("0.5", false)), Vec::<StatusLine>::new());

    assert_eq!(
        qbd(example("OpenJackson.d2.feedback.p30.inf.bnet")),
        warn("The current QBD adapter supports exactly one service station; this network has 2. Use product form or another network method for multiple stations.")
    );

    let mut no_station = mm1("0.5", true);
    no_station.nodes.retain(|n| n.kind != NodeKind::Station);
    let (b1, sink) = (node_id(&no_station, "B1"), node_id(&no_station, "Sink1"));
    no_station.links.retain(|l| l.from != b1);
    no_station.links.push(link("EE000001-0001-0001-2222-0000000000AA", &b1, &sink, 1.0));
    assert_eq!(
        qbd(no_station),
        warn("The current QBD adapter supports exactly one service station; this network has 0. Use product form or another network method for multiple stations.")
    );

    let mut two_sources = mm1("0.5", true);
    let mut src2 = two_sources.nodes[0].clone();
    src2.id = "EE000001-0001-0001-0001-0000000000A1".into();
    src2.name = "Src2".into();
    let b1 = node_id(&two_sources, "B1");
    two_sources.links.push(link("EE000001-0001-0001-2222-0000000000A1", &src2.id, &b1, 1.0));
    two_sources.nodes.push(src2);
    assert_eq!(
        qbd(two_sources),
        warn("The current QBD adapter supports exactly one external customer class/source; this network has 2.")
    );

    let mut two_servers = mm1("0.5", true);
    two_servers.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap().servers = 2;
    assert_eq!(
        qbd(two_servers),
        warn("S1 has 2 servers. The current scalar QBD level mapping is exact only for one exponential server (M/M/1).")
    );

    let mut sink_feedback = mm1("0.5", true);
    let (sink, b1) = (node_id(&sink_feedback, "Sink1"), node_id(&sink_feedback, "B1"));
    sink_feedback.links.push(link("EE000001-0001-0001-2222-0000000000A2", &sink, &b1, 1.0));
    assert_eq!(
        qbd(sink_feedback),
        warn("Exit sink Sink1 routes back to B1. A sink must be final departure for the one-queue QBD mapping.")
    );

    let mut into_source = mm1("0.5", true);
    let (s1, src) = (node_id(&into_source, "S1"), node_id(&into_source, "Src1"));
    for l in into_source.links.iter_mut().filter(|l| l.from == s1) {
        l.probability = 0.5;
    }
    into_source.links.push(link("EE000001-0001-0001-2222-0000000000A3", &s1, &src, 0.5));
    assert_eq!(
        qbd(into_source),
        warn("The route from S1 enters external source Src1. Route feedback to the station, not to its source.")
    );

    let mut deterministic = mm1("0.5", true);
    let station = deterministic.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap();
    station.distribution = Distribution::Constant;
    station.parameters = "value=1.0".into();
    assert_eq!(
        qbd(deterministic),
        warn("S1, Class 1 uses Deterministic service. The exact one-phase QBD mapping requires exponential FCFS service.")
    );
}

#[test]
fn the_truncated_ctmc_refuses_a_jackson_network_whose_mass_lies_past_the_64_cap() {
    let Some(resolver) = staged() else { return };
    // Three stations at μ = 1.1111111 fed at λ = 1.08: ρ ≈ 0.972 each. C(64 + 3, 3) = 47,905 states
    // fit the budget, so the cap is 64 and the threshold 48; the exact mean is about 104.1.
    let mut net = example("3dtandem.inf.bnet");
    for n in net.nodes.iter_mut().filter(|n| n.kind == NodeKind::Source) {
        n.parameters = "lambda=1.08".into();
    }
    let lines = refused(Method::TruncatedCtmc, &context(net, "3dtandem.inf.bnet", resolver));
    assert_eq!(
        lines,
        vec![StatusLine::warning(
            "Adaptive truncated CTMC not started: The exact Jackson mean population is 104.1 customers, while the 200,000-state budget only reaches total population 64 (about 47,905 states). That boundary lies inside the distribution's main mass, so truncation cannot be reliable. Run Exact Open Product Form instead; it is exact and does not enumerate the infinite state space."
        )]
    );
}

#[test]
fn the_truncated_ctmc_scale_guard_never_refuses_one_station() {
    let Some(resolver) = staged() else { return };
    // An M/M/1 at ρ = 0.99 has mean 99, above 0.75 × 64, but one station is never refused.
    let ctx = context(mm1("0.99", true), "mm1.bnet", resolver);
    match prepare(Method::TruncatedCtmc, &ctx) {
        Prepared::Launch(run) => assert!(run.before.is_empty(), "{:?}", run.before),
        Prepared::Refused(lines) => panic!("refused: {lines:?}"),
    }
}

#[test]
fn the_truncated_ctmc_refuses_non_exponential_service_through_its_exporter() {
    let Some(resolver) = staged() else { return };
    let mut net = mm1("0.5", true);
    let station = net.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap();
    station.distribution = Distribution::Constant;
    station.parameters = "value=1.0".into();
    let lines = refused(Method::TruncatedCtmc, &context(net, "md1.bnet", resolver));
    assert_eq!(
        lines,
        vec![StatusLine::warning("Adaptive truncated CTMC not started: S1, Class 1 uses Deterministic service. This method requires exponential service times.")]
    );
}

#[test]
fn the_engine_falls_back_with_a_warning_when_the_preferred_one_is_missing() {
    let Some(stage) = common::staged_solver_root() else {
        println!("skipped: the staged solvers are absent");
        return;
    };
    for (preferred, present, absent) in [(0, "qbd_solver.py", "C"), (1, "bna_qbd", "Python")] {
        let root = fresh_dir(&format!("fallback-{preferred}"));
        let dir = root.join("bin/infinite/BNAqbd");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(stage.join("bin/infinite/BNAqbd").join(present), dir.join(present)).unwrap();
        let mut ctx = context(mm1("0.5", true), "mm1.bnet", resolver_over(&root));
        ctx.settings.engine_qbd = preferred;
        let out = common::run(Method::Qbd, &ctx);
        let (used, other) = if absent == "C" { ("Python", "C") } else { ("C", "Python") };
        assert_eq!(
            out.status,
            vec![
                StatusLine::warning(format!("Exact Matrix-Analytic QBD: the {other} engine is not available in this installation, so the {used} engine ran instead. The two produce the same result; only the run time differs. Settings ▸ Solvers ▸ Solver Engine chooses.")),
                StatusLine::info(format!("Running exact matrix-analytic QBD solution on the {used} engine.")),
            ]
        );
        assert_eq!(out.parameters["engine"], used);
        assert!(
            out.parameters["runtime"].starts_with(&format!("{used} engine (fallback); QNET_SOLVER_ROOT: ")),
            "{}",
            out.parameters["runtime"]
        );
        assert_eq!(out.exit_code, Some(0));
        assert!(out.archive.contains(&format!("Solving exact matrix-analytic QBD ({used}) ...  ")));
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[test]
fn the_cycle_scarcity_warning_comes_before_the_run_and_its_estimate_is_recorded() {
    let Some(resolver) = staged() else { return };
    // The two-station Jackson network loaded to ρ = 0.999 at its busiest station: P(empty) is
    // below 1e-3 × (1 − ρ₂) < 1e-4.
    let mut net = example("OpenJackson.d2.feedback.p30.inf.bnet");
    // Load it to ρ ≈ 0.99 at its busiest station by scaling the arrival rate.
    let data = qnet_core::traffic::compute(&net.nodes, &net.links, true, false, false).expect("traffic");
    let rho_max = (0..data.d).map(|i| data.rho(i)).fold(0.0, f64::max);
    let lambda: f64 = net.nodes.iter().find(|n| n.kind == NodeKind::Source).unwrap().parameters.trim_start_matches("lambda=").parse().unwrap();
    let scaled = lambda * 0.999 / rho_max;
    for n in net.nodes.iter_mut().filter(|n| n.kind == NodeKind::Source) {
        n.parameters = format!("lambda={scaled}");
    }
    let mut ctx = context(net, "jackson.bnet", resolver);
    ctx.settings.sim_seed_fixed = true;
    match prepare(Method::RegenerativeMonteCarlo, &ctx) {
        Prepared::Launch(run) => {
            assert_eq!(run.before.len(), 1, "{:?}", run.before);
            assert_eq!(run.before[0].severity, Severity::Warning);
            assert!(run.before[0].text.starts_with("Regenerative-cycle warning: estimated empty-system probability is "));
            assert!(run.before[0].text.contains("E-"), "{}", run.before[0].text);
            let p: f64 = run.parameters["estimated empty-system probability"].parse().unwrap();
            assert!(p < 1e-4, "{p}");
            assert_eq!(run.seed, Some(12_345));
            assert_eq!(run.accepted, vec![StatusLine::info("Running regenerative Monte Carlo on the C engine (seed 12345, stream 0).")]);
        }
        Prepared::Refused(lines) => panic!("refused: {lines:?}"),
    }
}

#[test]
fn an_unfixed_seed_is_drawn_from_one_to_int32_max() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(mm1("0.5", true), "mm1.bnet", resolver);
    ctx.settings.sim_seed_fixed = false;
    ctx.entropy = Arc::new(|| 0);
    let Prepared::Launch(run) = prepare(Method::RegenerativeMonteCarlo, &ctx) else { panic!("refused") };
    assert_eq!(run.seed, Some(1), "entropy 0 is the lowest seed, 1");
    ctx.entropy = Arc::new(|| u64::from(u32::MAX) * 7 + 3);
    let Prepared::Launch(run) = prepare(Method::RegenerativeMonteCarlo, &ctx) else { panic!("refused") };
    let seed = run.seed.unwrap();
    assert!((1..=i32::MAX as u64).contains(&seed), "{seed}");
    assert!(run.accepted[0].text.contains(&format!("(seed {seed}, stream 0)")));
}

#[test]
fn the_decomposition_takes_its_blocking_from_the_simulation_setting() {
    let Some(resolver) = staged() else { return };
    for (setting, display, approximation) in [(0, "Loss", "false"), (1, "BAS approximation", "true"), (2, "BAS + external loss approximation", "true")] {
        let mut ctx = context(mm1("0.5", false), "mm1.bnet", resolver.clone());
        ctx.settings.sim_blocking = setting;
        let Prepared::Launch(run) = prepare(Method::FiniteDecomposition, &ctx) else { panic!("refused") };
        assert_eq!(run.parameters["blocking"], display);
        assert_eq!(run.parameters["BAS is approximation"], approximation);
        assert_eq!(run.accepted, vec![StatusLine::info(format!("Running finite-buffer decomposition ({display})."))]);
    }
}

#[test]
fn the_adaptive_bar_withholds_queue_lengths_for_a_multi_server_station() {
    let Some(resolver) = staged() else { return };
    let mut net = mm1("0.5", true);
    net.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap().servers = 2;
    let out = common::run(Method::AdaptiveBar, &context(net, "mm2.bnet", resolver));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert!(
        out.archive.contains("\n  Queue lengths not derived: S1 has more than one server, and the workload-to-queue identity used for single-server stations is only asymptotic in heavy traffic when c > 1. The workload means above are the solver's own output.\nElapsed time: "),
        "{}",
        out.archive
    );
    assert!(!out.archive.contains("  L_1 = "));
}

#[test]
fn a_prepared_run_that_is_never_launched_leaves_no_input_behind() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(mm1("0.5", true), "mm1.bnet", resolver);
    ctx.temp_dir = fresh_dir("unlaunched");
    for method in [Method::ProductForm, Method::Qbd, Method::TruncatedCtmc, Method::RegenerativeMonteCarlo, Method::AdaptiveBar, Method::BarBounds, Method::MultiClassSrbm] {
        let Prepared::Launch(run) = prepare(method, &ctx) else { panic!("{} refused", method.label()) };
        let inputs: Vec<PathBuf> = run.temps.paths().to_vec();
        assert_eq!(inputs.len(), 1, "{}", method.label());
        assert!(inputs[0].is_file());
        drop(run);
        assert!(!inputs[0].exists(), "{} left {}", method.label(), inputs[0].display());
    }
    let left: Vec<_> = std::fs::read_dir(&ctx.temp_dir).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn the_multi_class_input_is_the_saved_document_and_is_removed_after_the_run() {
    let Some(resolver) = staged() else { return };
    let net = example("3dtandem.inf.bnet");
    let mut ctx = context(net.clone(), "3dtandem.inf.bnet", resolver);
    ctx.temp_dir = fresh_dir("mc-input");
    let Prepared::Launch(run) = prepare(Method::MultiClassSrbm, &ctx) else { panic!("refused") };
    let input = run.temps.paths()[0].clone();
    assert_eq!(input.file_name().unwrap().to_string_lossy(), format!("BNET_mc_{}.bnet", ctx.pid));
    assert_eq!(std::fs::read_to_string(&input).unwrap(), qnet_core::bnet::write(&net));
    drop(run);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn the_multi_class_srbm_refuses_when_its_input_cannot_be_written_with_the_cocoa_reason() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(example("3dtandem.inf.bnet"), "3dtandem.inf.bnet", resolver);
    ctx.temp_dir = fresh_dir("mc-unwritable").join("missing-folder");
    let lines = refused(Method::MultiClassSrbm, &ctx);
    assert_eq!(lines[0], StatusLine::error("Multi-class SRBM aborted: could not write temp file."));
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[1].severity, Severity::Info);
    assert!(lines[1].text.starts_with("    ") && lines[1].text.contains("BNET_mc_"), "{:?}", lines[1]);
    let _ = std::fs::remove_dir_all(ctx.temp_dir.parent().unwrap());
}

/// D5 (METH-087, Changed): under the L_i stage 0.90.34's pipeline returned awk's status, so a BAR
/// solver that failed still finished with 0; 2.0 returns the solver's status.
#[test]
fn an_adaptive_bar_solver_that_fails_under_the_queue_length_stage_fails_the_run() {
    let root = fresh_dir("bar-fails");
    let dir = root.join("infinite/BNAalr");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("low_rank_bar.py"), "import sys\nprint('E[Z_1] = 1.5    Var[Z_1] = 2')\nsys.exit(3)\n").unwrap();
    let mut ctx = context(mm1("0.5", true), "mm1.bnet", resolver_over(&root));
    ctx.temp_dir = fresh_dir("bar-fails-tmp");
    let out = common::run(Method::AdaptiveBar, &ctx);
    assert!(out.launched, "{:?}", out.status);
    assert_eq!(out.exit_code, Some(3), "{:?}", out.status);
    assert!(out.status.iter().any(|l| l.severity == Severity::Error && l.text.contains(" failed (exit 3) after ")), "{:?}", out.status);
    assert!(out.archive.contains("E[Z_1] = 1.5"), "{}", out.archive);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn a_stop_during_a_run_removes_its_input_and_leaves_no_solver_running() {
    use qnet_runner::methods::launch;
    use qnet_runner::supervisor::{CollectSink, RunEvent, RunOwner, RunRegistry};
    let Some(resolver) = staged() else { return };
    // The adaptive truncated CTMC on 3dtandem.inf takes tens of seconds.
    let mut ctx = context(example("3dtandem.inf.bnet"), "3dtandem.inf.bnet", resolver);
    ctx.temp_dir = fresh_dir("stop");
    let Prepared::Launch(run) = prepare(Method::TruncatedCtmc, &ctx) else { panic!("refused") };
    let input = run.temps.paths()[0].clone();
    assert!(input.is_file());
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
    assert!(!input.exists(), "the input outlived the run");
    let archive = report.archive_text();
    assert!(archive.starts_with("Solving adaptive truncated CTMC (C) ...  [ ]"), "{archive}");
    assert!(!archive.contains("Elapsed time"), "the wrapper died with the solver: {archive}");
    let alive = std::process::Command::new("pgrep").arg("-f").arg(input.to_string_lossy().as_ref()).output().unwrap();
    assert!(alive.stdout.is_empty(), "a solver survived: {}", String::from_utf8_lossy(&alive.stdout));
    assert_eq!(
        *status.lock().unwrap(),
        vec![
            "Running adaptive truncated CTMC on the C engine (queue process; heuristic truncation diagnostics).".to_string(),
            "Truncated Ctmc cancelled.".to_string(),
        ]
    );
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

// ─── The two engines of each dual-engine method print the same archive ──────────────────────────

/// Runs `method` on `net` with each engine and checks that the archives agree apart from the
/// engine's name in the spinner, and that the store files the same measurements from them.
fn engines_agree(method: Method, net: Network, title: &str, set_engine: fn(&mut RunSettings, i64)) {
    let Some(resolver) = staged() else { return };
    let mut runs = Vec::new();
    for engine in [0, 1] {
        let mut ctx = context(net.clone(), title, resolver.clone());
        set_engine(&mut ctx.settings, engine);
        let out = common::with_slot(|| common::run(method, &ctx));
        assert!(out.launched, "{} refused: {:?}", method.label(), out.status);
        let record = common::file_record(method, &ctx, &common::root().join("examples").join(title), &out).expect("a record");
        let temp = ctx.temp_dir.to_string_lossy().trim_end_matches('/').to_string();
        let archive = common::normalize(&out.archive, Some(&temp), Some(&ctx.pid.to_string()));
        runs.push((out, archive, record));
    }
    let (c, python) = (&runs[0], &runs[1]);
    assert_eq!(c.0.parameters["engine"], "C");
    assert_eq!(python.0.parameters["engine"], "Python");
    assert!(python.0.parameters["runtime"].starts_with("Python engine; "), "{}", python.0.parameters["runtime"]);
    assert_eq!(c.0.exit_code, python.0.exit_code);
    let c_archive = c.1.replace(" (C) ...  ", " (Python) ...  ");
    if let Some(d) = common::first_difference(&c_archive, &python.1) {
        panic!("{}: the engines' archives differ at {d}", method.label());
    }
    let (c_record, python_record) = (common::comparable_text(&c.2, false), common::comparable_text(&python.2, false));
    if let Some(d) = common::first_difference(&c_record, &python_record) {
        panic!("{}: the engines' records differ at {d}", method.label());
    }
    let count = c.2.as_object().and_then(|r| r.get("measurements")).and_then(Json::as_array).map_or(0, |m| m.len());
    println!("{}: both engines filed the same {count} measurements", method.label());
}

fn set_qbd(s: &mut RunSettings, v: i64) {
    s.engine_qbd = v;
}
fn set_ctmc(s: &mut RunSettings, v: i64) {
    s.engine_ctmc = v;
}
fn set_regenerative(s: &mut RunSettings, v: i64) {
    s.engine_regenerative = v;
}

#[test]
fn the_python_qbd_engine_prints_what_the_c_engine_prints() {
    engines_agree(Method::Qbd, mm1("0.9", true), "mm1.bnet", set_qbd);
}

#[test]
fn the_python_truncated_ctmc_engine_prints_what_the_c_engine_prints() {
    engines_agree(Method::TruncatedCtmc, example("OpenJackson.d2.feedback.p30.inf.bnet"), "OpenJackson.d2.feedback.p30.inf.bnet", set_ctmc);
}

#[test]
fn the_python_sparse_ctmc_engine_prints_what_the_c_engine_prints() {
    engines_agree(Method::GenericCtmc, example("Tandem2.MM1.K5.fin.bnet"), "Tandem2.MM1.K5.fin.bnet", set_ctmc);
}

#[test]
fn the_python_regenerative_engine_prints_what_the_c_engine_prints_in_both_buffer_modes() {
    engines_agree(Method::RegenerativeMonteCarlo, mm1("0.5", true), "mm1.bnet", set_regenerative);
    engines_agree(Method::RegenerativeMonteCarlo, mm1("0.9", false), "MM1K.d1.c1.fin.bnet", set_regenerative);
}
