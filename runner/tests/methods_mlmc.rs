//! Run SRBM MLMC (`methods/mlmc.rs`) against 0.90.34.
//!
//! The golden acceptance is `common::golden_method` (rules 1–6 in `tests/common/mod.rs`): for every
//! example with an `mlmc` folder in `golden/runs/` (35, of which 19 launched and 16 were refused
//! by the work budget), the run is prepared and launched with the staged `rbm_mlmc` as
//! `golden/tools/GoldenRuns.swift` ran it, and compared with what 0.90.34 wrote: the Status lines,
//! whether it launched, the record's parameters, base seed and replication seeds, the exit status,
//! the full-precision archive line for line after `common::normalize`, and the record 2.0's store
//! files from that archive against `record.json`. `rbm_mlmc`'s estimates depend on its thread
//! count, which the harness sets to the corpus's 18 (`common::corpus_threads`); with it the staged
//! solver reproduces all 19 launched runs exactly.
//!
//! Besides the corpus: one test per refusal the corpus doesn't reach (a missing solver, an SRBM
//! that can't be built, an input that can't be written; the plan's refusals are unit tests in
//! `mlmc.rs`), the input file's life, the seeds, and the replication loop itself, driven both by
//! the real solver (several replications, adaptive sampling, Stop) and by a stand-in solver
//! script for the outcomes the real one doesn't produce on demand (a failure, a signal, malformed
//! rows).
mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::model::{Network, NodeKind};
use qnet_core::output::mlmc as text;
use qnet_runner::methods::{prepare, Method, Prepared, RunContext, RunSettings, StatusLine};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use qnet_runner::supervisor::Severity;

// ─── Golden acceptance ───────────────────────────────────────────────────────────────────────────

// With the corpus's thread count (`common::corpus_threads`), `rbm_mlmc` reproduces every golden
// run exactly.

#[test]
fn srbm_mlmc_matches_0_90_34_on_every_example() {
    common::golden_method(Method::Mlmc);
}

// ─── Contexts and solver trees for the checks the corpus doesn't reach ──────────────────────────

/// `examples/<file>` as File › Open reads it.
fn example(file: &str) -> Network {
    let text = std::fs::read_to_string(common::root().join("examples").join(file)).expect("example");
    qnet_core::bnet::read(&text).expect("example reads")
}

/// A fresh empty folder for this test.
fn fresh_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-methods-mlmc-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A context over `net` with the golden settings and `resolver`, in its own temporary folder (the
/// input is named by the pid, which every test in this binary shares).
fn context(net: Network, title: &str, resolver: Arc<Resolver>, tag: &str) -> RunContext {
    let mut ctx = RunContext::new(net, title, RunSettings::golden(), resolver);
    ctx.temp_dir = fresh_dir(tag);
    ctx
}

/// A resolver that finds solvers only under `root`, with this process's `PATH`.
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

fn refused(ctx: &RunContext) -> Vec<StatusLine> {
    match prepare(Method::Mlmc, ctx) {
        Prepared::Refused(lines) => lines,
        Prepared::Launch(run) => panic!("launched: {:?}", run.parameters),
    }
}

fn launched(ctx: &RunContext) -> qnet_runner::methods::PreparedRun {
    match prepare(Method::Mlmc, ctx) {
        Prepared::Launch(run) => run,
        Prepared::Refused(lines) => panic!("refused: {lines:?}"),
    }
}

/// A solver tree whose `bin/infinite/BNAmc/rbm_mlmc` is a shell script: `body` runs for each
/// replication (after the loadability probe, which it passes), with `$DIR` its own folder. Each
/// call appends its arguments, one per line, to `$DIR/argv` after a `--` line.
fn stand_in_solver(tag: &str, body: &str) -> (PathBuf, Arc<Resolver>) {
    let root = fresh_dir(&format!("solver-{tag}"));
    let dir = root.join("bin/infinite/BNAmc");
    std::fs::create_dir_all(&dir).unwrap();
    let script = format!(
        "#!/bin/sh\n[ \"$1\" = \"--qnet-loadability-probe\" ] && exit 0\nDIR=\"$(dirname \"$0\")\"\n{{ echo --; printf '%s\\n' \"$@\"; }} >> \"$DIR/argv\"\n{body}\n"
    );
    let path = dir.join("rbm_mlmc");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let resolver = resolver_over(&root);
    (root, resolver)
}

/// Two well-formed station rows, as `rbm_mlmc` prints them, with workload means `w1` and `w2`.
fn rows(w1: &str, w2: &str) -> String {
    format!(
        "# Dimension: 2\n# gamma=0.0500  epsilon=0.0100  T=9.0859  L=3  N=100  seed=7\n# backend=serial  threads=1  elapsed=0.000s\n# Total Gaussian RVs generated: 1000\n# antithetic=off adaptive=off\n#\n# Component   E[Y_i(inf)]     SE          95% CI half-width\n     1        {w1}     0.010000     0.019600\n     2        {w2}     0.020000     0.039200\n"
    )
}

/// `text` as a literal `printf` format inside single quotes: `%` doubled, newlines as `\n`.
fn printf_text(text: &str) -> String {
    text.replace('%', "%%").replace('\n', "\\n")
}

/// The arguments of each stand-in call, in order.
fn calls(root: &Path) -> Vec<Vec<String>> {
    let text = std::fs::read_to_string(root.join("bin/infinite/BNAmc/argv")).unwrap_or_default();
    text.split("--\n").filter(|c| !c.is_empty()).map(|c| c.lines().map(str::to_string).collect()).collect()
}

// ─── Refusals the corpus doesn't reach ───────────────────────────────────────────────────────────

#[test]
fn a_missing_solver_is_named_with_the_resolvers_diagnostic() {
    let root = fresh_dir("empty-tree");
    let ctx = context(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", resolver_over(&root), "empty-tree-tmp");
    assert_eq!(
        refused(&ctx),
        vec![
            StatusLine::error("SRBM MLMC aborted: rbm_mlmc binary not found."),
            StatusLine::info("    No loadable copy of rbm_mlmc was found for BNAmc."),
            StatusLine::info("    Searched the app bundle, QNET_SOLVER_ROOT, a nearby Qnet.app, and the development source tree."),
            StatusLine::info("    Rebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree."),
        ]
    );
    assert_eq!(std::fs::read_dir(&ctx.temp_dir).unwrap().count(), 0, "no input was written");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn an_srbm_that_cannot_be_built_is_refused_with_the_exporters_reason_before_any_input() {
    let Some(resolver) = staged() else { return };
    // The M/M/1 example loaded past capacity: ρ = 1.5.
    let mut net = example("MM1K.d1.c1.fin.bnet");
    net.infinite_buffers = true;
    for n in net.nodes.iter_mut().filter(|n| n.kind == NodeKind::Source) {
        n.parameters = "lambda=1.5".into();
    }
    let ctx = context(net, "mm1.bnet", resolver, "overloaded");
    assert_eq!(
        refused(&ctx),
        vec![StatusLine::error("SRBM MLMC aborted: S1 has traffic intensity rho = 1.5000 >= 1. The service rate must exceed the arrival rate at every station for the SRBM to have a stationary distribution.")]
    );
    assert_eq!(std::fs::read_dir(&ctx.temp_dir).unwrap().count(), 0, "no input was written");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn an_input_that_cannot_be_written_is_refused_with_the_cocoa_reason() {
    let Some(resolver) = staged() else { return };
    let mut ctx = RunContext::new(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", RunSettings::golden(), resolver);
    ctx.temp_dir = PathBuf::from("/nonexistent-dir-qnet-mlmc");
    assert_eq!(
        refused(&ctx),
        vec![
            StatusLine::error("SRBM MLMC aborted: could not write temp file."),
            StatusLine::info(format!("    The folder “BNET_mlmc_{}.in” doesn’t exist.", ctx.pid)),
        ]
    );
}

#[test]
fn a_refused_plan_removes_the_input_it_had_written() {
    let Some(resolver) = staged() else { return };
    // 3dtandem.inf is refused by the work budget in the corpus, after its input was written.
    let ctx = context(example("3dtandem.inf.bnet"), "3dtandem.inf.bnet", resolver, "budget");
    let lines = refused(&ctx);
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[1].severity, Severity::Warning);
    assert!(lines[1].text.starts_with("SRBM MLMC not started: Estimated MLMC plan: T≈405.0, L=3, N≈25.26K per replication. Across 1 replication,"));
    assert_eq!(std::fs::read_dir(&ctx.temp_dir).unwrap().count(), 0, "the input outlived the refusal");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

// ─── The input, the seeds and the record's parameters ───────────────────────────────────────────

#[test]
fn the_input_is_the_bnamc_document_and_an_unlaunched_run_removes_it() {
    let Some(resolver) = staged() else { return };
    let net = example("DaiHarrison92.d2.c2.1.inf.bnet");
    let ctx = context(net, "DaiHarrison92.d2.c2.1.inf.bnet", resolver, "input");
    let run = launched(&ctx);
    let input = run.temps.paths().to_vec();
    assert_eq!(input, vec![ctx.temp_dir.join(format!("BNET_mlmc_{}.in", ctx.pid))]);
    // The exporter's own golden file (`golden/<example>/bnamc.in`) is the same document.
    let golden = std::fs::read_to_string(common::root().join("golden/DaiHarrison92.d2.c2.1.inf/bnamc.in")).unwrap();
    assert_eq!(std::fs::read_to_string(&input[0]).unwrap(), golden);
    drop(run);
    assert!(!input[0].exists());
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn an_unfixed_base_seed_is_drawn_from_one_to_a_billion_and_spread_by_splitmix() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", resolver, "seeds");
    ctx.settings.mlmc_seed_fixed = false;
    ctx.settings.mlmc_replications = 3;
    ctx.entropy = Arc::new(|| 0);
    let run = launched(&ctx);
    assert_eq!(run.seed, Some(1), "entropy 0 is the lowest seed, 1");
    assert_eq!(run.replication_seeds, text::replication_seeds(1, 3));
    drop(run);
    ctx.entropy = Arc::new(|| u64::MAX);
    let run = launched(&ctx);
    let seed = run.seed.unwrap();
    assert!((1..=1_000_000_000).contains(&seed), "{seed}");
    assert_eq!(run.replication_seeds, text::replication_seeds(seed as i64, 3));
    drop(run);
    // A negative stored seed (Settings never stores one) is recorded as its 64-bit pattern.
    ctx.settings.mlmc_seed_fixed = true;
    ctx.settings.mlmc_seed = -5;
    let run = launched(&ctx);
    assert_eq!(run.seed, Some((-5i64) as u64));
    assert_eq!(run.replication_seeds, text::replication_seeds(-5, 3));
    drop(run);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn the_record_keeps_every_resolved_value_of_an_overridden_adaptive_run() {
    let Some(resolver) = staged() else { return };
    let mut ctx = context(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", resolver, "parameters");
    let s = &mut ctx.settings;
    (s.mlmc_override_t, s.mlmc_t, s.mlmc_override_l, s.mlmc_l, s.mlmc_override_n, s.mlmc_n) = (true, 2.5, true, 2, true, 4000);
    (s.mlmc_backend, s.mlmc_threads, s.mlmc_antithetic, s.mlmc_replications, s.mlmc_adaptive) = (3, 4, true, 2, true);
    (s.mlmc_gamma, s.mlmc_epsilon) = (0.1, 0.02);
    let run = launched(&ctx);
    let mut parameters = run.parameters.clone();
    let runtime = parameters.remove("runtime").unwrap();
    assert!(runtime.starts_with("QNET_SOLVER_ROOT: ") && runtime.ends_with("/bin/infinite/BNAmc/rbm_mlmc"), "{runtime}");
    let want: Vec<(&str, &str)> = vec![
        ("adaptive", "true"),
        ("antithetic", "true"),
        ("backend", "3"),
        ("epsilon", "0.02"),
        ("gamma", "0.1"),
        ("levels L", "2"),
        ("path length T", "2.5"),
        ("replications", "2"),
        ("sample plan", "adaptive, maximum 200000"),
        ("threads", "4"),
    ];
    assert_eq!(parameters.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), want);
    assert_eq!(run.before, vec![StatusLine::info("Estimated MLMC plan: T≈2.500, L=2, maximum N=200000 per replication.")]);
    assert_eq!(
        run.accepted,
        vec![StatusLine::info("Running SRBM MLMC (γ=0.1, ε=0.02, T=2.5, L=2, antithetic, adaptive (max 200000), K=2 replications)...")]
    );
    drop(run);
    // A fixed-sample plan records N as Swift printed the Double.
    ctx.settings.mlmc_adaptive = false;
    assert_eq!(launched(&ctx).parameters["sample plan"], "4000.0");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

// ─── The replication loop, with a stand-in solver ───────────────────────────────────────────────

#[test]
fn every_replication_gets_its_own_seed_and_the_flags_and_the_aggregate_reads_them_all() {
    let w = [("0.500000", "0.250000"), ("0.700000", "0.350000"), ("0.600000", "0.300000")];
    let body = format!(
        "C=$(grep -c -- '^--$' \"$DIR/argv\")\ncase $C in\n1) printf '{}' ;;\n2) printf '{}' ;;\n*) printf '{}' ;;\nesac\necho \"note $C\" >&2\n",
        printf_text(&rows(w[0].0, w[0].1)),
        printf_text(&rows(w[1].0, w[1].1)),
        printf_text(&rows(w[2].0, w[2].1)),
    );
    let (root, resolver) = stand_in_solver("three", &body);
    let mut ctx = context(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", resolver, "three-tmp");
    ctx.settings.mlmc_replications = 3;
    ctx.settings.mlmc_backend = 3;
    let out = common::run(Method::Mlmc, &ctx);
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    let input = ctx.temp_dir.join(format!("BNET_mlmc_{}.in", ctx.pid));
    let seeds = text::replication_seeds(12_345, 3);
    let calls = calls(&root);
    assert_eq!(calls.len(), 3);
    for (call, seed) in calls.iter().zip(&seeds) {
        let want = [input.to_string_lossy().into_owned(), "0.05".into(), "0.01".into(), "--seed".into(), seed.to_string(), "--backend".into(), "serial".into()];
        assert_eq!(call, &want);
    }
    let outputs: Vec<String> = w.iter().map(|(a, b)| rows(a, b)).collect();
    let files: Vec<Option<&str>> = outputs.iter().map(|o| Some(o.as_str())).collect();
    let summary = "γ=0.05, ε=0.01, K=3 replications";
    let expected = format!(
        "Running SRBM MLMC ({summary}) ... \nSRBM MLMC replication 1 diagnostics:\nnote 1\n\nSRBM MLMC replication 2 diagnostics:\nnote 2\n\nSRBM MLMC replication 3 diagnostics:\nnote 3\ndone.\n\n{}",
        text::aggregate(&files, &[1.5614035087719298, 1.7619047619047621], &seeds, text::critical_95(3))
    );
    let archive = out.archive.split("Elapsed time: ").next().unwrap();
    assert_eq!(archive, expected);
    assert!(out.archive.ends_with("s\n\n"));
    assert!(!input.exists(), "the input outlived the run");
    assert_eq!(
        out.status,
        vec![
            StatusLine::info("Estimated MLMC plan: T≈9.086, L=3, N≈25.26K per replication."),
            StatusLine::info(format!("Running SRBM MLMC ({summary})...")),
        ]
    );
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn a_failing_replication_shows_its_stderr_and_ends_the_run_with_its_status() {
    // The second replication fails; the first one's output is never aggregated.
    let body = format!(
        "if [ $(grep -c -- '^--$' \"$DIR/argv\") -eq 1 ]; then printf '{}'; else echo 'out of memory' >&2; echo 'giving up' >&2; exit 3; fi\n",
        printf_text(&rows("0.500000", "0.250000"))
    );
    let (root, resolver) = stand_in_solver("fails", &body);
    let mut ctx = context(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", resolver, "fails-tmp");
    ctx.settings.mlmc_replications = 3;
    let out = common::run(Method::Mlmc, &ctx);
    assert_eq!(out.exit_code, Some(3));
    assert_eq!(calls(&root).len(), 2, "the loop stopped at the failure");
    let archive = out.archive.split("Elapsed time: ").next().unwrap();
    assert_eq!(archive, "Running SRBM MLMC (γ=0.05, ε=0.01, K=3 replications) ... \nSRBM MLMC replication 2 failed with status 3.\nout of memory\ngiving up\n");
    let last = out.status.last().unwrap();
    assert_eq!((last.severity, common::mask_duration(&last.text)), (Severity::Error, "SRBM MLMC failed (exit 3) after <T>".to_string()));
    assert!(!ctx.temp_dir.join(format!("BNET_mlmc_{}.in", ctx.pid)).exists());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn a_replication_killed_by_a_signal_reports_the_shells_status() {
    // SIGKILL rather than a crash signal, so no crash report is written.
    let (root, resolver) = stand_in_solver("signal", "kill -KILL $$\n");
    let ctx = context(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", resolver, "signal-tmp");
    let out = common::run(Method::Mlmc, &ctx);
    assert_eq!(out.exit_code, Some(137));
    assert!(out.archive.starts_with("Running SRBM MLMC (γ=0.05, ε=0.01) ... \nSRBM MLMC replication 1 failed with status 137.\nElapsed time: "), "{}", out.archive);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn incomplete_station_rows_end_the_run_with_status_65() {
    // One row for a two-station network, and a diagnostic on stderr.
    let one_row = "     1        0.500000     0.010000     0.019600\\n";
    let (root, resolver) = stand_in_solver("malformed", &format!("printf '{one_row}'\necho 'warning: short run' >&2\n"));
    let ctx = context(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", resolver, "malformed-tmp");
    let out = common::run(Method::Mlmc, &ctx);
    assert_eq!(out.exit_code, Some(65));
    let archive = out.archive.split("Elapsed time: ").next().unwrap();
    assert_eq!(
        archive,
        "Running SRBM MLMC (γ=0.05, ε=0.01) ... \nSRBM MLMC replication 1 returned incomplete or malformed station output (expected 2 rows).\nwarning: short run\n"
    );
    // A non-numeric estimate is malformed too.
    let (root2, resolver) = stand_in_solver("nan", &format!("printf '{}'\n", printf_text(&rows("nan", "0.250000"))));
    let ctx2 = context(example("DaiHarrison92.d2.c2.1.inf.bnet"), "DaiHarrison92.d2.c2.1.inf.bnet", resolver, "nan-tmp");
    assert_eq!(common::run(Method::Mlmc, &ctx2).exit_code, Some(65));
    for dir in [root, ctx.temp_dir.clone(), root2, ctx2.temp_dir.clone()] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

// ─── The replication loop, with the real solver ─────────────────────────────────────────────────

#[test]
fn a_second_replication_continues_the_first_ones_seed_stream() {
    common::corpus_threads();
    let Some(resolver) = staged() else { return };
    let Some(g) = common::golden("Reiman84.d2.c1.reentrant.inf", "mlmc") else { return };
    let path = common::root().join("examples/Reiman84.d2.c1.reentrant.inf.bnet");
    let mut ctx = common::golden_run_context(&path, resolver, &g);
    ctx.temp_dir = fresh_dir("two");
    ctx.settings.mlmc_replications = 2;
    let out = common::with_slot(|| common::run(Method::Mlmc, &ctx));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    // The first of two seeds is the one seed of K = 1, so replication 1 is the golden run.
    assert_eq!(out.replication_seeds[0], g.replication_seeds()[0]);
    let diagnostics = |archive: &str, k: usize| -> String {
        let start = archive.find(&format!("SRBM MLMC replication {k} diagnostics:\n")).expect("diagnostics");
        let rest = &archive[start..];
        let end = rest.find("\nSRBM MLMC replication ").or_else(|| rest.find("done.\n")).unwrap();
        rest[..end].to_string()
    };
    assert_eq!(diagnostics(&out.archive, 1), diagnostics(&g.archive, 1));
    assert!(out.archive.contains(&format!("seed          = {}\n", out.replication_seeds[1])));
    assert!(out.archive.contains(&format!("# Replications: 2 (independent top-level streams)\n# Replication seeds: {} {}\n", out.replication_seeds[0], out.replication_seeds[1])));
    assert!(out.archive.contains("(95% across independent replications)\n"));
    let record = common::file_record(Method::Mlmc, &ctx, &path, &out).expect("a record");
    let record = record.as_object().unwrap();
    assert_eq!(record["status"].as_str(), Some("completed"));
    assert_eq!(record["measurements"].as_array().map(<[_]>::len), Some(2));
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn adaptive_sampling_reaches_the_solver_and_a_missed_target_files_a_partial_result() {
    common::corpus_threads();
    let Some(resolver) = staged() else { return };
    let mut ctx = context(example("Reiman84.d2.c1.reentrant.inf.bnet"), "Reiman84.d2.c1.reentrant.inf.bnet", resolver, "adaptive");
    let s = &mut ctx.settings;
    (s.mlmc_adaptive, s.mlmc_batch_size, s.mlmc_min_samples, s.mlmc_max_samples, s.mlmc_epsilon) = (true, 500, 1000, 2000, 0.0001);
    let out = common::with_slot(|| common::run(Method::Mlmc, &ctx));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert!(out.archive.contains("adaptive      = on (batch=500, SE target=0.0001)\n"), "{}", out.archive);
    assert!(out.archive.contains("sample cap    = 2000 (--max-samples)\n"), "{}", out.archive);
    assert!(out.archive.contains(" stop=cap-reached\n"), "{}", out.archive);
    assert!(out.archive.contains("QNET_MLMC_STATUS_V1 adaptive=yes precision_met=no cap_hits=1\n"), "{}", out.archive);
    let record = common::file_record(Method::Mlmc, &ctx, &common::root().join("examples/Reiman84.d2.c1.reentrant.inf.bnet"), &out).expect("a record");
    let record = record.as_object().unwrap();
    assert_eq!(record["status"].as_str(), Some("partial"), "{record:?}");
    assert!(record["measurements"].as_array().is_some_and(|m| !m.is_empty()));
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}

#[test]
fn a_stop_during_a_replication_removes_the_input_and_leaves_no_solver_running() {
    use qnet_runner::methods::launch;
    use qnet_runner::supervisor::{CollectSink, RunEvent, RunOwner, RunRegistry};
    common::corpus_threads();
    let Some(resolver) = staged() else { return };
    // GuangChenDaiGlynn25.sec3.3.3d's one replication takes about 18 s (more would exceed the
    // work budget).
    let ctx = context(example("GuangChenDaiGlynn25.sec3.3.3d.inf.bnet"), "GuangChenDaiGlynn25.sec3.3.3d.inf.bnet", resolver, "stop");
    let run = launched(&ctx);
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
    let archive = report.archive_text();
    assert_eq!(archive, "Running SRBM MLMC (γ=0.05, ε=0.01) ... ", "the loop died with the solver");
    let alive = std::process::Command::new("pgrep").arg("-f").arg(input.to_string_lossy().as_ref()).output().unwrap();
    assert!(alive.stdout.is_empty(), "a solver survived: {}", String::from_utf8_lossy(&alive.stdout));
    let status = status.lock().unwrap();
    assert_eq!(status[..2], ["Estimated MLMC plan: T≈291.0, L=3, N≈25.26K per replication.".to_string(), "Running SRBM MLMC (γ=0.05, ε=0.01)...".to_string()]);
    assert!(status.len() <= 3 && status.get(2).is_none_or(|l| l.starts_with("SRBM MLMC cancelled")), "{status:?}");
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
}
