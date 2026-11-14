//! The linear-program run specifications (`methods/lp.rs`: Run Linear Program, `lp`, and Run
//! Finite-Buffer LP, `flp`) against 0.90.34.
//!
//! The golden acceptance: for every example with a folder for the method in `golden/runs/`, the run
//! is prepared and launched with the staged solvers as `golden/tools/GoldenRuns.swift` ran it, and
//! compared with what 0.90.34 wrote (Status lines, launch, parameters, seeds, exit status, the
//! normalised archive and the filed record), by `common::golden_method` under its rules 1–6. The
//! two LP solvers print their stage timings outside compact mode, and the LP summary repeats the
//! total ("[Total] 2.843s"); `common::normalize` masks those lines and nothing else, and every run
//! is compared exactly.
//!
//! Besides the corpus: the refusals and pre-checks the corpus doesn't reach (each missing solver,
//! the orthant model's and the box model's refusals, the resource guard with smoothness slacks, an
//! input that cannot be written), and the settings it never varied (user-set grid and basis, a
//! named LP backend, multi-level refinement, the sheet's answer), plus what a run leaves behind
//! (nothing, whether it ends, is never launched, or is stopped).
mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::model::{Network, NodeKind};
use qnet_runner::methods::{prepare, Method, Prepared, RunContext, RunSettings, StatusLine};
use qnet_runner::resolver::{Resolver, ResolverConfig};

// ─── Golden acceptance ───────────────────────────────────────────────────────────────────────────
//
// Every run is compared exactly: `srbm_lp` and `fBNAlp_solver` reproduced the harvested
// raw outputs byte for byte, apart from their printed wall-clock times, when rebuilt on a second
// Mac (2026-11-11).
//
// One golden run is known to differ: Bramson94.d3.c5.reentrant
// `lp`. On the corpus's Mac HiGHS gave up on its LP ("HiGHS: run_status=-1, model_status=0", "LP
// solve failed!", exit 1 after 12 s); on the second Mac (M3 Ultra) `srbm_lp` solves the same input
// file to "Optimal u* = 5.4714923232e-04" in 1.7 s. The input is the corpus's own export
// (`each_stage_input_is_the_corpus_export_of_the_same_network`) and the solver's output agrees line
// for line up to "[Solve] Using solver: highs". `srbm_lp` links Apple Accelerate (`dgesv` for its
// automatic grid spacing, `cblas_dgemm`/`dgemv`) and OpenMP, so its LP coefficients may differ in
// the last bits between chips; that is unproven. Since 2026-11-12 (the owner's instruction) that
// exact difference is expected (`KNOWN_DIFFERENCES` in common/mod.rs): the corpus records the
// failure and this Mac's run has none. Any other difference on that run still fails, and
// `6_QNET20/handoff/check-bramson94-lp.sh` remains for re-running it on the corpus's Mac.

#[test]
fn the_linear_program_matches_0_90_34_on_every_example() {
    common::golden_method(Method::LinearProgram);
}

#[test]
fn the_finite_buffer_linear_program_matches_0_90_34_on_every_example() {
    common::golden_method(Method::FiniteLinearProgram);
}

// ─── Networks and contexts for the checks the corpus doesn't reach ─────────────────────────────

/// `examples/<file>` as File › Open reads it.
fn example(file: &str) -> Network {
    let text = std::fs::read_to_string(common::root().join("examples").join(file)).expect("example");
    qnet_core::bnet::read(&text).expect("example reads")
}

/// The M/M/1/K example (λ = 0.9, μ = 1) with its source's rate set to `lambda`, in either mode.
fn mm1(lambda: &str, infinite: bool) -> Network {
    let mut net = example("MM1K.d1.c1.fin.bnet");
    net.infinite_buffers = infinite;
    for n in net.nodes.iter_mut().filter(|n| n.kind == NodeKind::Source) {
        n.parameters = format!("lambda={lambda}");
    }
    net
}

/// A fresh empty folder for this test.
fn fresh_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-methods-lp-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A context over `net` with the golden settings and `resolver`, writing into its own new folder.
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

fn staged() -> Option<Arc<Resolver>> {
    let r = common::staged_resolver();
    if r.is_none() {
        println!("skipped: the staged solvers are absent");
    }
    r
}

fn refused(method: Method, ctx: &RunContext) -> Vec<StatusLine> {
    match prepare(method, ctx) {
        Prepared::Refused(lines) => lines,
        Prepared::Launch(run) => panic!("{} launched: {:?}", method.label(), run.parameters),
    }
}

/// What is left in a folder.
fn left_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

// ─── Refusals the corpus doesn't reach ───────────────────────────────────────────────────────────

#[test]
fn each_linear_program_names_its_missing_solver_over_an_empty_tree() {
    let root = fresh_dir("empty-tree");
    let resolver = resolver_over(&root);
    // Run Linear Program shows the resolver's diagnostic.
    let ctx = context(mm1("0.5", true), "mm1.bnet", resolver.clone(), "missing-lp");
    assert_eq!(
        refused(Method::LinearProgram, &ctx),
        vec![
            StatusLine::error("Linear Program aborted: srbm_lp binary not found."),
            StatusLine::info("    No loadable copy of srbm_lp was found for BNAlp."),
            StatusLine::info("    Searched the app bundle, QNET_SOLVER_ROOT, a nearby Qnet.app, and the development source tree."),
            StatusLine::info("    Rebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree."),
        ]
    );
    // Run Finite-Buffer LP found its solver through `findBinary`, which shows a fixed sentence.
    let fin = context(mm1("0.5", false), "mm1.bnet", resolver, "missing-flp");
    assert_eq!(
        refused(Method::FiniteLinearProgram, &fin),
        vec![
            StatusLine::error("Finite LP aborted: fBNAlp_solver binary not found."),
            StatusLine::info("    Could not locate the fBNAlp_solver binary. Make sure it is compiled (run 'make' in the fBNAlp directory)."),
        ]
    );
    for dir in [&root, &ctx.temp_dir, &fin.temp_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn the_linear_program_refuses_a_network_its_orthant_model_cannot_build() {
    let Some(resolver) = staged() else { return };
    let ctx = context(mm1("2.0", true), "mm1.bnet", resolver, "orthant");
    assert_eq!(
        refused(Method::LinearProgram, &ctx),
        vec![StatusLine::error("Linear Program aborted: S1 has traffic intensity rho = 2.0000 >= 1. The service rate must exceed the arrival rate at every station for the SRBM to have a stationary distribution.")]
    );
    assert!(left_in(&ctx.temp_dir).is_empty());
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn the_finite_lp_refuses_a_network_its_box_model_cannot_build() {
    let Some(resolver) = staged() else { return };
    let mut net = mm1("0.5", false);
    let sink = net.nodes.iter().find(|n| n.kind == NodeKind::Sink).unwrap().id.clone();
    net.nodes.retain(|n| n.id != sink);
    net.links.retain(|l| l.to != sink);
    let ctx = context(net, "mm1.bnet", resolver, "box");
    assert_eq!(refused(Method::FiniteLinearProgram, &ctx), vec![StatusLine::error("Finite LP aborted: The network has no sink node.")]);
    assert!(left_in(&ctx.temp_dir).is_empty());
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn the_resource_guard_counts_smoothness_slacks_before_any_file_is_written() {
    let Some(resolver) = staged() else { return };
    // Three stations at grid 100: 1,030,001 columns fit, but the 2,970,000 smoothness slacks don't.
    let mut ctx = context(example("3dtandem.inf.bnet"), "3dtandem.inf.bnet", resolver, "guard");
    ctx.settings.lp_grid_n = 100;
    ctx.settings.lp_smoothness = 0.001;
    assert_eq!(
        refused(Method::LinearProgram, &ctx),
        vec![StatusLine::warning("Linear Program not started: For d=3 and grid_n=100, BNAlp would create about 4.00M variables including smoothness slacks, above the 2 million-variable safety limit. Reduce grid_n or smoothness, or use Adaptive Low-Rank BAR / MLMC. Tensor-grid LP is not practical at this scale.")]
    );
    assert!(left_in(&ctx.temp_dir).is_empty());
    ctx.settings.lp_smoothness = 0.0;
    let Prepared::Launch(run) = prepare(Method::LinearProgram, &ctx) else { panic!("refused without smoothness") };
    assert_eq!(run.parameters["grid size"], "100");
    drop(run);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn an_input_that_cannot_be_written_refuses_the_run_with_the_cocoa_reason() {
    let Some(resolver) = staged() else { return };
    let missing = PathBuf::from("/nonexistent-dir-qnet-lp");
    let mut ctx = RunContext::new(mm1("0.5", true), "mm1.bnet", RunSettings::golden(), resolver.clone());
    ctx.temp_dir = missing.clone();
    assert_eq!(
        refused(Method::LinearProgram, &ctx),
        vec![
            StatusLine::error("Linear Program aborted: could not write temp file."),
            StatusLine::info(format!("    The folder “BNET_lp_{}_s0.in” doesn’t exist.", ctx.pid)),
        ]
    );
    let mut fin = RunContext::new(mm1("0.5", false), "mm1.bnet", RunSettings::golden(), resolver);
    fin.temp_dir = missing;
    assert_eq!(
        refused(Method::FiniteLinearProgram, &fin),
        vec![
            StatusLine::error("Finite LP aborted: could not write temp file."),
            StatusLine::info(format!("    The folder “BNET_flp_{}.in” doesn’t exist.", fin.pid)),
        ]
    );
}

// ─── Inputs: the corpus's exports, and the settings the corpus never varied ──────────────────────

#[test]
fn each_stage_input_is_the_corpus_export_of_the_same_network() {
    let Some(resolver) = staged() else { return };
    let (mut lp, mut flp) = (0, 0);
    for (name, path) in common::examples() {
        let golden = common::root().join("golden").join(&name);
        for (method, file) in [(Method::LinearProgram, "bnalp.in"), (Method::FiniteLinearProgram, "fbnalp.in")] {
            let Ok(want) = std::fs::read_to_string(golden.join(file)) else { continue };
            let mut ctx = common::golden_context(&path, resolver.clone());
            if !method.in_menu(ctx.network.infinite_buffers) {
                continue;
            }
            ctx.temp_dir = fresh_dir(&format!("inputs-{}", name.replace('.', "_")));
            if let Prepared::Launch(run) = prepare(method, &ctx) {
                let got = std::fs::read_to_string(&run.temps.paths()[0]).unwrap();
                if method == Method::LinearProgram {
                    assert_eq!(got, want, "{name}: {file}");
                    lp += 1;
                } else {
                    // The run names its temporary output prefix where the corpus's export has a
                    // placeholder.
                    let prefix = format!("output_prefix {}\n", ctx.temp_path(&format!("BNET_flp_csv_{}", ctx.pid)).display());
                    assert!(got.contains(&prefix), "{name}: {got}");
                    assert_eq!(got.replacen(&prefix, "output_prefix OUTPUT_PREFIX\n", 1), want, "{name}: {file}");
                    flp += 1;
                }
            }
            let _ = std::fs::remove_dir_all(&ctx.temp_dir);
        }
    }
    println!("{lp} BNAlp and {flp} fBNAlp inputs equal the corpus exports");
    assert!(lp >= 30 && flp >= 15, "{lp} {flp}");
}

#[test]
fn a_multi_level_run_with_user_set_sizes_and_a_named_backend_runs_both_stages() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(example("OpenJackson.d2.feedback.p30.inf.bnet"), "OpenJackson.d2.feedback.p30.inf.bnet", resolver, "multi");
    ctx.settings.lp_grid_n = 10;
    ctx.settings.lp_basis_m = 4;
    ctx.settings.lp_solver = 3;
    ctx.settings.lp_multi_level = true;
    let out = common::run(Method::LinearProgram, &ctx);
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert_eq!(out.status, vec![StatusLine::info("Running Linear Program (BNAlp)...")]);
    let want: Vec<(&str, &str)> = vec![
        ("basis normalization", "false"),
        ("basis size", "4"),
        ("grid size", "10"),
        ("grid type", "exponential"),
        ("multi-level", "true"),
        ("smoothness", "0.0"),
        ("solver", "highs"),
    ];
    assert_eq!(out.parameters.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), want);
    let a = &out.archive;
    assert!(a.starts_with("Running Linear Program (BNAlp, Saure-Glynn-Zeevi 2008)\nuser-set: grid_n=10, basis_m=4\n\n===== COARSE PREVIEW (grid_n = 6) =====\n"), "{a}");
    let refined = a.find("===== REFINED RUN (grid_n = 10) =====\n").expect("a refined stage");
    let (coarse, fine) = a.split_at(refined);
    for (stage, n) in [(coarse, 6), (fine, 10)] {
        assert!(stage.contains(&format!("  grid_n        = {n}\n  basis_m       = 4\n")), "{stage}");
        assert!(stage.contains("[Solve] Using solver: highs\n"), "{stage}");
        assert!(stage.contains(&format!("\nLinear Program (Saure-Glynn-Zeevi 2008 LP)\n==========================================\n\nSolver: highs  |  grid_n = {n}  |  basis_m = 4\n")), "{stage}");
        assert!(stage.contains("\nNetwork Totals:\n  Total E[N]:             "), "{stage}");
    }
    assert!(fine.contains("\nElapsed time: ") && !coarse.contains("Elapsed time"), "{a}");
    assert!(left_in(&ctx.temp_dir).is_empty(), "{:?}", left_in(&ctx.temp_dir));
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn the_sheets_answer_only_differs_from_the_settings_for_a_negative_size() {
    let Some(resolver) = staged() else { return };
    let net = example("OpenJackson.d2.feedback.p30.inf.bnet");
    let title = "OpenJackson.d2.feedback.p30.inf.bnet";
    let note = |ask: bool, grid: i64| {
        let mut ctx = context(net.clone(), title, resolver.clone(), &format!("sheet-{ask}-{grid}"));
        ctx.settings.lp_ask_before_run = ask;
        ctx.settings.lp_grid_n = grid;
        let out = common::with_slot(|| common::run(Method::LinearProgram, &ctx));
        assert_eq!(out.exit_code, Some(0), "{}", out.archive);
        let _ = std::fs::remove_dir_all(&ctx.temp_dir);
        (out.archive.lines().nth(1).unwrap_or_default().to_string(), out.parameters)
    };
    let (direct, direct_parameters) = note(false, 0);
    let (sheet, sheet_parameters) = note(true, 0);
    assert_eq!(direct, "auto-scaled for d=2: grid_n=100, basis_m=6");
    assert_eq!((sheet, sheet_parameters), (direct, direct_parameters.clone()));
    // A negative stored grid is "user-set" to readLPSettings, and 0 (automatic) to the sheet.
    let (negative, negative_parameters) = note(false, -5);
    assert_eq!(negative, "user-set: grid_n=100, basis_m=6");
    assert_eq!(negative_parameters, direct_parameters);
    assert_eq!(note(true, -5).0, "auto-scaled for d=2: grid_n=100, basis_m=6");
}

#[test]
fn the_finite_lp_passes_its_settings_to_the_input_and_the_record() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(example("Tandem2.MM1.K5.fin.bnet"), "Tandem2.MM1.K5.fin.bnet", resolver, "flp-settings");
    ctx.settings.flp_solver = 1;
    ctx.settings.flp_grid_type = 1;
    ctx.settings.flp_grid_n = 8;
    ctx.settings.flp_basis_m = 3;
    ctx.settings.flp_basis_normalize = true;
    let Prepared::Launch(run) = prepare(Method::FiniteLinearProgram, &ctx) else { panic!("refused") };
    let want: Vec<(&str, &str)> = vec![
        ("basis normalization", "true"),
        ("basis size", "3"),
        ("grid size", "8"),
        ("grid type", "chebyshev"),
        ("solver", "glpk"),
    ];
    assert_eq!(run.parameters.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), want);
    assert_eq!(run.accepted, vec![StatusLine::info("Running finite LP (glpk)...")]);
    let input = run.temps.paths()[0].clone();
    assert_eq!(input.file_name().unwrap().to_string_lossy(), format!("BNET_flp_{}.in", ctx.pid));
    let text = std::fs::read_to_string(&input).unwrap();
    let prefix = ctx.temp_path(&format!("BNET_flp_csv_{}", ctx.pid));
    for line in ["grid_n     8\n", "basis_m    3\n", "grid_type  chebyshev\n", "solver     glpk\n", "basis_normalize 1\n"] {
        assert!(text.contains(line), "{line:?} in {text}");
    }
    assert!(text.contains(&format!("output_prefix {}\n", prefix.display())), "{text}");
    // The solver's CSV outputs are registered for removal with the input.
    let csv: Vec<String> = run.temps.paths()[1..].iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    let stem = format!("BNET_flp_csv_{}", ctx.pid);
    assert_eq!(csv, vec![format!("{stem}_marginal_1.csv"), format!("{stem}_marginal_2.csv"), format!("{stem}_distribution.csv")]);
    drop(run);
    assert!(left_in(&ctx.temp_dir).is_empty());
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

// ─── What a run leaves behind ───────────────────────────────────────────────────────────────────

#[test]
fn a_finished_run_leaves_no_input_output_or_csv_file_behind() {
    let Some(resolver) = staged() else { return };
    let lp = context(example("OpenJackson.d2.feedback.p30.inf.bnet"), "OpenJackson.d2.feedback.p30.inf.bnet", resolver.clone(), "left-lp");
    let out = common::with_slot(|| common::run(Method::LinearProgram, &lp));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    // The solver wrote its CSV files into the run's private working folder, named relatively.
    assert!(out.archive.contains("  Wrote srbm_out_marginal_1.csv (100 points)\n  Wrote srbm_out_marginal_2.csv (100 points)\n  Wrote srbm_out_distribution.csv (10000 points)\n"), "{}", out.archive);
    assert!(left_in(&lp.temp_dir).is_empty(), "{:?}", left_in(&lp.temp_dir));
    let flp = context(example("Tandem2.MM1.K5.fin.bnet"), "Tandem2.MM1.K5.fin.bnet", resolver, "left-flp");
    let out = common::with_slot(|| common::run(Method::FiniteLinearProgram, &flp));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert!(left_in(&flp.temp_dir).is_empty(), "{:?}", left_in(&flp.temp_dir));
    for dir in [&lp.temp_dir, &flp.temp_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn a_prepared_run_that_is_never_launched_leaves_nothing_behind() {
    let Some(resolver) = staged() else { return };
    let mut lp = context(example("OpenJackson.d2.feedback.p30.inf.bnet"), "OpenJackson.d2.feedback.p30.inf.bnet", resolver.clone(), "unlaunched-lp");
    lp.settings.lp_multi_level = true;
    let Prepared::Launch(run) = prepare(Method::LinearProgram, &lp) else { panic!("refused") };
    let names: Vec<String> = run.temps.paths().iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec![format!("BNET_lp_{}_s0.in", lp.pid), format!("BNET_lp_{}_s1.in", lp.pid), format!("BNET_lp_csv_{}", lp.pid)]);
    assert!(run.temps.paths()[2].is_dir());
    drop(run);
    assert!(left_in(&lp.temp_dir).is_empty(), "{:?}", left_in(&lp.temp_dir));
    let flp = context(example("Tandem2.MM1.K5.fin.bnet"), "Tandem2.MM1.K5.fin.bnet", resolver, "unlaunched-flp");
    let Prepared::Launch(run) = prepare(Method::FiniteLinearProgram, &flp) else { panic!("refused") };
    assert!(run.temps.paths()[0].is_file());
    drop(run);
    assert!(left_in(&flp.temp_dir).is_empty(), "{:?}", left_in(&flp.temp_dir));
    for dir in [&lp.temp_dir, &flp.temp_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn a_stop_during_a_run_removes_its_files_and_leaves_no_solver_running() {
    use qnet_runner::methods::launch;
    use qnet_runner::supervisor::{CollectSink, RunEvent, RunOwner, RunRegistry};
    let Some(resolver) = staged() else { return };
    // Five stations at grid 10: several seconds of LP solving.
    let title = "BuzacottShanthikumarStyle.d5.c1.reentrant.inf.bnet";
    let ctx = context(example(title), title, resolver, "stop");
    let Prepared::Launch(run) = prepare(Method::LinearProgram, &ctx) else { panic!("refused") };
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
    assert!(!input.exists(), "the input outlived the run");
    assert!(left_in(&ctx.temp_dir).is_empty(), "{:?}", left_in(&ctx.temp_dir));
    let archive = report.archive_text();
    assert!(archive.starts_with("Running Linear Program (BNAlp, Saure-Glynn-Zeevi 2008)\nauto-scaled for d=5: grid_n=10, basis_m=3\n\n"), "{archive}");
    assert!(!archive.contains("Elapsed time") && !archive.contains("Solver exited"), "the wrapper died with the solver: {archive}");
    let alive = std::process::Command::new("pgrep").arg("-f").arg(input.to_string_lossy().as_ref()).output().unwrap();
    assert!(alive.stdout.is_empty(), "a solver survived: {}", String::from_utf8_lossy(&alive.stdout));
    assert_eq!(*status.lock().unwrap(), vec!["Running Linear Program (BNAlp)...".to_string(), "Linear Program cancelled.".to_string()]);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

/// Review finding FIX-208b: a problem the solver would refuse for its size is refused by the
/// app, in the plain sentence, before any file is written or process started. Ten stations
/// with a grid of 12 a side are 12^10 grid points; the same network at the recommended
/// settings of a small one is launched.
#[test]
fn a_finite_lp_too_large_for_the_solver_is_refused_before_launch() {
    let Some(resolver) = staged() else { return };
    let mut net = example("10stationtandem.inf.bnet");
    net.infinite_buffers = false;
    let dir = fresh_dir("too-large");
    let mut settings = RunSettings::golden();
    settings.flp_grid_n = 12;
    settings.flp_basis_m = 6;
    let mut ctx = RunContext::new(net, "ten.bnet", settings, resolver.clone());
    ctx.temp_dir = dir.clone();
    assert_eq!(
        refused(Method::FiniteLinearProgram, &ctx),
        vec![StatusLine::error("Finite LP aborted: this problem is too large for the LP solver: 10 stations with grid size 12 and basis size 6 give more grid points, basis functions or matrix entries than it can index (the limit is 2,147,483,647). Use a smaller grid size or basis size, or a network with fewer stations.")]
    );
    assert_eq!(left_in(&dir), Vec::<String>::new(), "nothing was written");
    let mut small = RunContext::new(mm1("0.5", false), "mm1.bnet", RunSettings::golden(), resolver);
    small.temp_dir = dir.clone();
    assert!(matches!(prepare(Method::FiniteLinearProgram, &small), Prepared::Launch(_)));
    let _ = std::fs::remove_dir_all(dir);
}
