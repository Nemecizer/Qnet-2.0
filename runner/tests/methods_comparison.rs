//! Run Comparison (`methods/comparison.rs`, both buffer modes) against 0.90.34.
//!
//! The golden acceptance: for every example with an `inf_cmp` or `cmp` folder in `golden/runs/`,
//! the comparison is prepared and launched with the staged solvers as
//! `golden/tools/GoldenRuns.swift` ran it (with `runCompare.remember` on, so the finite run takes
//! `sim.blocking` without a sheet), and compared with what 0.90.34 wrote through
//! `common::golden_method`: the Status lines, the record's parameters and seeds, the exit status,
//! the archive line for line after `common::normalize`, and the record 2.0's store files from it.
//!
//! Besides the corpus, one test per refusal and pre-check the corpus doesn't reach: each missing
//! finite solver, the infinite comparison over an empty solver tree (every column skipped), the
//! refusal when no exporter accepts the network, a temporary folder that can't be written, the
//! Loss regime with its exact CTMC column (and without it, when the script is missing), each
//! regime's and parallel mode's simulation flags, the finite-element choice, failing and fallback
//! columns (with stand-in solvers: small shell scripts in a private solver tree), the METH-122
//! change (a failing finite step no longer stops the comparison), the seeds, and Stop.
mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::export::{jackson_sim, qna, srbm_orthant};
use qnet_core::json::Json;
use qnet_core::model::{Link, Network, NodeKind};
use qnet_runner::methods::{prepare, Method, Prepared, RunContext, RunSettings, StatusLine};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use qnet_runner::supervisor::Severity;

// ─── Golden acceptance ───────────────────────────────────────────────────────────────────────────
//
// Every run is compared exactly, the Spectral (`bnet`) and FE (`bna_fm_gauss`) columns included:
// with the input this port writes, both solvers reproduced the corpus on this Mac (bnet's 3e-7
// drift on Bramson94.d3.c5 doesn't show at 3 decimals).

#[test]
fn infinite_run_comparison_matches_0_90_34_on_every_example() {
    common::golden_method(Method::InfiniteComparison);
}

#[test]
fn finite_run_comparison_matches_0_90_34_on_every_example() {
    common::golden_method(Method::FiniteComparison);
}

// ─── Networks, solver trees and stand-in solvers ────────────────────────────────────────────────

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

/// A fresh empty folder for this test.
fn fresh_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-methods-comparison-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
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

/// A stand-in solver `bin/<dir>/<name>` under `root`: a shell script that answers the resolver's
/// loadability probe and otherwise runs `body`.
fn fake(root: &Path, dir: &str, name: &str, body: &str) {
    let folder = root.join("bin").join(dir);
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n[ \"$1\" = --qnet-loadability-probe ] && exit 0\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A context over `net` with the golden settings and `resolver`, writing into its own folder.
fn context(net: Network, title: &str, resolver: Arc<Resolver>, temp: &Path) -> RunContext {
    let mut ctx = RunContext::new(net, title, RunSettings::golden(), resolver);
    ctx.temp_dir = temp.to_path_buf();
    ctx.cpu_count = 8;
    ctx
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

/// The archive with frames reduced to what stays on screen and times masked.
fn screen(out: &common::Outcome, ctx: &RunContext) -> String {
    let temp = ctx.temp_dir.to_string_lossy().trim_end_matches('/').to_string();
    common::normalize(&out.archive, Some(&temp), Some(&ctx.pid.to_string()))
}

/// The status the store filed the run with ("completed", "partial", "failed").
fn record_status(method: Method, ctx: &RunContext, out: &common::Outcome) -> String {
    let record = common::file_record(method, ctx, &common::root().join("examples/MM1K.d1.c1.fin.bnet"), out).expect("a record");
    record.as_object().and_then(|r| r.get("status")).and_then(Json::as_str).unwrap_or_default().to_string()
}

/// The archive's lines from the first one starting with `start` to the first after it that is
/// empty, exclusive.
fn block<'a>(text: &'a str, start: &str) -> Vec<&'a str> {
    text.lines().skip_while(|l| !l.starts_with(start)).take_while(|l| !l.is_empty()).collect()
}

// ─── Refusals and pre-checks the corpus doesn't reach ───────────────────────────────────────────

#[test]
fn the_finite_comparison_names_each_missing_solver_with_its_fixed_sentence() {
    let root = fresh_dir("missing");
    let temp = fresh_dir("missing-temp");
    let missing = |name: &str, dir: &str| {
        vec![
            StatusLine::error(format!("Comparison aborted: {name} binary not found.")),
            StatusLine::info(format!("    Could not locate the {name} binary. Make sure it is compiled (run 'make' in the {dir} directory).")),
        ]
    };
    let run = |settings: fn(&mut RunSettings)| {
        let mut ctx = context(mm1("0.5", false), "mm1.bnet", resolver_over(&root), &temp);
        settings(&mut ctx.settings);
        refused(Method::FiniteComparison, &ctx)
    };
    assert_eq!(run(|_| {}), missing("srbm_solver", "fBNAsm"));
    fake(&root, "finite/fBNAsm", "srbm_solver", "exit 0");
    assert_eq!(run(|_| {}), missing("bna_fm_gauss", "fBNAfm"));
    assert_eq!(run(|s| s.fem_solver = 1), missing("bna_fm_cbc", "fBNAfm"));
    fake(&root, "finite/fBNAfm", "bna_fm_gauss", "exit 0");
    assert_eq!(run(|_| {}), missing("fBNAsim", "fBNAsim"));
    fake(&root, "finite/fBNAsim", "fBNAsim", "exit 0");
    // fBNAlp is optional: without it the comparison runs with no LP column.
    let ctx = context(mm1("0.5", false), "mm1.bnet", resolver_over(&root), &temp);
    let Prepared::Launch(run) = prepare(Method::FiniteComparison, &ctx) else { panic!("refused") };
    assert_eq!(run.accepted, vec![StatusLine::info("Running comparison (SM → FM → MC, sim blocking = BAS+ext-loss)...")]);
    assert!(run.before.is_empty(), "{:?}", run.before);
    drop(run);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn the_infinite_comparison_is_refused_only_when_no_exporter_accepts_the_network() {
    let root = fresh_dir("refused");
    let temp = fresh_dir("refused-temp");
    // A source feeding a buffer that drains straight into the sink: no station.
    let mut net = mm1("0.5", true);
    let station = net.nodes.iter().find(|n| n.kind == NodeKind::Station).unwrap().id.clone();
    let b1 = net.nodes.iter().find(|n| n.kind == NodeKind::Buffer).unwrap().id.clone();
    let sink = net.nodes.iter().find(|n| n.kind == NodeKind::Sink).unwrap().id.clone();
    net.nodes.retain(|n| n.id != station);
    net.links.retain(|l| l.from != station && l.to != station);
    net.links.push(Link { id: "EE000001-0001-0001-2222-0000000000AA".into(), from: b1, to: sink, probability: 1.0, class: 0, to_class: None });
    let reasons = [
        srbm_orthant::export_for_spectral(&net.nodes, &net.links, 8).unwrap_err().message(),
        qna::export(&net.nodes, &net.links).unwrap_err().message(),
        jackson_sim::export(&net.nodes, &net.links).unwrap_err().message(),
    ];
    let mut want = vec![StatusLine::error("Comparison not started: no method accepted this network.")];
    want.extend(reasons.iter().map(|r| StatusLine::info(format!("    {r}"))));
    let ctx = context(net, "none.bnet", resolver_over(&root), &temp);
    assert_eq!(refused(Method::InfiniteComparison, &ctx), want);
    let left: Vec<_> = std::fs::read_dir(&temp).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn a_temporary_folder_that_cannot_be_written_refuses_both_comparisons() {
    let Some(resolver) = staged() else { return };
    let missing = PathBuf::from("/nonexistent-dir-qnet-comparison");
    let ctx = context(mm1("0.5", true), "mm1.bnet", resolver.clone(), &missing);
    assert_eq!(
        refused(Method::InfiniteComparison, &ctx),
        vec![
            StatusLine::error("Comparison (infinite) aborted: could not write temp files."),
            StatusLine::info(format!("    The folder “BNET_inf_cmp_sm_{}.in” doesn’t exist.", ctx.pid)),
        ]
    );
    let ctx = context(mm1("0.5", false), "mm1.bnet", resolver, &missing);
    assert_eq!(
        refused(Method::FiniteComparison, &ctx),
        vec![
            StatusLine::error("Comparison aborted: could not write temp files."),
            StatusLine::info(format!("    The folder “BNET_cmp_sm_{}.in” doesn’t exist.", ctx.pid)),
        ]
    );
}

#[test]
fn the_infinite_comparison_over_an_empty_tree_skips_every_column_and_fails() {
    let root = fresh_dir("empty-tree");
    let temp = fresh_dir("empty-tree-temp");
    let ctx = context(example("3dtandem.inf.bnet"), "3dtandem.inf.bnet", resolver_over(&root), &temp);
    let out = common::run(Method::InfiniteComparison, &ctx);
    assert!(out.launched);
    assert_eq!(out.parameters["RQNA solver found"], "false");
    assert_eq!(out.parameters["SBD solver found"], "false");
    assert_eq!(out.exit_code, Some(70));
    assert_eq!(
        common::actual_status(&out.status),
        vec![
            ("info".to_string(), "Running independent infinite-buffer comparison methods...".to_string()),
            ("error".to_string(), "Run Comparison failed (exit 70) after <T>".to_string()),
        ]
    );
    let text = screen(&out, &ctx);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(
        &lines[..7],
        &[
            "[Threads] 8 CPU cores for parallel solvers (Sim/Spectral/FE); analytical solvers (QNA/SBD/LP) are single-threaded",
            "Spectral skipped: solver unavailable",
            "QNA skipped: solver unavailable",
            "RQNA skipped: solver unavailable",
            "SBD skipped: solver unavailable",
            "Simulation skipped: solver unavailable",
            "",
        ]
    );
    // Every method cell is empty; the exact Jackson column still prints.
    assert!(text.contains("\nE[Q_1]     —         —    —     —    —           —                      9.000\n"), "{text}");
    assert!(text.ends_with("\nQNET_COMPARISON_STATUS_V1 partial=yes successful=0 failed=all\n"), "{text}");
    assert!(!text.contains("Elapsed time"), "exit 70 ends the command before the elapsed line");
    assert_eq!(record_status(Method::InfiniteComparison, &ctx, &out), "failed");
    let left: Vec<_> = std::fs::read_dir(&temp).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn a_failing_infinite_column_is_marked_and_the_others_still_run() {
    let root = fresh_dir("inf-fail");
    let temp = fresh_dir("inf-fail-temp");
    fake(&root, "infinite/BNAqna", "bna_qna", "echo 'rho_1 = 0.4' ; echo 'ERROR: bad input' >&2 ; exit 2");
    fake(&root, "infinite/BNArqna", "bna_rqna", "printf 'rho_1 = 0.5\\nE[Q_1] = 1.25\\n'");
    let ctx = context(mm1("0.5", true), "mm1.bnet", resolver_over(&root), &temp);
    let out = common::run(Method::InfiniteComparison, &ctx);
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert_eq!(out.parameters["RQNA solver found"], "true");
    assert_eq!(
        common::actual_status(&out.status),
        vec![
            ("info".to_string(), "Running independent infinite-buffer comparison methods...".to_string()),
            ("info".to_string(), "⚠ QNA failed (exit 2):".to_string()),
            ("error".to_string(), "ERROR: bad input".to_string()),
        ]
    );
    let text = screen(&out, &ctx);
    assert!(
        text.contains("\nRunning QNA ...              [done]<T>s\n\n⚠ QNA failed (exit 2):\nERROR: bad input\nQNA failed; continuing with independent methods.\nRunning RQNA ...             [done]<T>s\n"),
        "{text}"
    );
    // The failed column's partial output is discarded: its row reads "—", RQNA's value is kept.
    assert!(text.contains("\nrho_1      —         —    0.500 (+0.0%)   —    —           0.500 (+0.0%)          0.500\n"), "{text}");
    assert!(text.contains("\nQNET_COMPARISON_STATUS_V1 partial=yes successful=1 failed=spectral,qna,sbd,simulation\nElapsed time: <T>s\n"), "{text}");
    assert_eq!(record_status(Method::InfiniteComparison, &ctx, &out), "partial");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn an_sbd_fallback_is_kept_as_a_partial_column_and_sbd_is_told_where_bnet_is() {
    let root = fresh_dir("sbd");
    let temp = fresh_dir("sbd-temp");
    fake(&root, "infinite/BNAsm", "bnet", "printf 'E[Q_1] = 1.5\\n'");
    fake(&root, "infinite/BNAsbd", "bna_sbd", "printf 'E[Q_1] = 1.0\\nQNET_SBD_STATUS_V1 fallback_used=yes\\n' ; echo \"warning: BNET_BIN=$BNET_BIN\" >&2");
    let ctx = context(mm1("0.5", true), "mm1.bnet", resolver_over(&root), &temp);
    let out = common::run(Method::InfiniteComparison, &ctx);
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    let bnet = root.join("bin/infinite/BNAsm/bnet");
    assert_eq!(
        common::actual_status(&out.status),
        vec![
            ("info".to_string(), "Running independent infinite-buffer comparison methods...".to_string()),
            ("info".to_string(), "⚠ SBD warnings:".to_string()),
            ("warning".to_string(), format!("warning: BNET_BIN={}", bnet.display())),
        ]
    );
    let text = screen(&out, &ctx);
    assert!(text.contains("\nRunning SBD ...              [done]<T>s\nSBD used a fallback after an internal spectral subproblem failed; retaining it as a partial column.\n"), "{text}");
    assert!(text.contains("\nQNET_COMPARISON_STATUS_V1 partial=yes successful=2 failed=qna,rqna,sbd-fallback,simulation\n"), "{text}");
    assert_eq!(record_status(Method::InfiniteComparison, &ctx, &out), "partial");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

/// A private tree with stand-ins for the finite comparison's solvers: the spectral and
/// finite-element ones print a small `-G` result; the simulation prints its own arguments to
/// stderr and exits `sim_exit`.
fn finite_tree(tag: &str, sim_exit: i32) -> PathBuf {
    let root = fresh_dir(tag);
    fake(&root, "finite/fBNAsm", "srbm_solver", "printf 'rho_1 = 0.5\\nE[X_1] = 0.9\\n'");
    fake(&root, "finite/fBNAfm", "bna_fm_gauss", "printf 'rho_1 = 0.5\\nE[X_1] = 1.1\\n'");
    fake(&root, "finite/fBNAsim", "fBNAsim", &format!("echo \"$@\" >&2 ; exit {sim_exit}"));
    root
}

#[test]
fn a_failing_finite_step_no_longer_stops_the_comparison() {
    // METH-122 (Changed, D5): 0.90.34 chained the steps with `&&`, so this run printed no table
    // and exited 3. Now the failed column is marked and the table follows.
    let root = finite_tree("fin-fail", 3);
    let temp = fresh_dir("fin-fail-temp");
    let ctx = context(mm1("0.5", false), "mm1.bnet", resolver_over(&root), &temp);
    let out = common::run(Method::FiniteComparison, &ctx);
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    let text = screen(&out, &ctx);
    assert!(
        text.contains("\nRunning simulation ...             [                              ]  starting ...\n⚠ Simulation failed (exit 3):\n-f <TMP>/BNET_cmp_mc_<PID>.txt -G -n 8 -w 10000 -T 200000 -s 12345 -P <TMP>/BNET_progress_fin_cmp_mc_<PID>_"),
        "{text}"
    );
    assert!(text.contains(".bin -e\nRunning simulation ...             ["), "sequential, BAS + external loss: {text}");
    assert!(text.contains("\nSimulation failed; continuing with independent methods.\n\n"), "{text}");
    assert_eq!(
        block(&text, "E[X_1]"),
        vec!["E[X_1]     0.900 (-40.0%)  1.100 (-26.7%)  —           1.000 (-33.3%)         1.500"],
        "{text}"
    );
    assert!(text.ends_with("\nQNET_COMPARISON_STATUS_V1 partial=yes successful=2 failed=simulation\nElapsed time: <T>s\n\n"), "{text}");
    assert_eq!(record_status(Method::FiniteComparison, &ctx, &out), "partial");
    // When every column fails the comparison fails, as the infinite one does.
    let root2 = fresh_dir("fin-all-fail");
    fake(&root2, "finite/fBNAsm", "srbm_solver", "exit 1");
    fake(&root2, "finite/fBNAfm", "bna_fm_gauss", "exit 1");
    fake(&root2, "finite/fBNAsim", "fBNAsim", "exit 1");
    let ctx2 = context(mm1("0.5", false), "mm1.bnet", resolver_over(&root2), &temp);
    let out2 = common::run(Method::FiniteComparison, &ctx2);
    assert_eq!(out2.exit_code, Some(70));
    let text2 = screen(&out2, &ctx2);
    assert!(text2.contains("Spectral failed; continuing with independent methods.\n"), "{text2}");
    assert!(text2.contains("FE (Gauss) failed; continuing with independent methods.\n"), "{text2}");
    assert!(text2.ends_with("\nQNET_COMPARISON_STATUS_V1 partial=yes successful=0 failed=all\n"), "{text2}");
    for r in [root, root2, temp] {
        let _ = std::fs::remove_dir_all(r);
    }
}

#[test]
fn each_regime_and_parallel_mode_passes_its_flags_to_the_simulation() {
    let root = finite_tree("flags", 1);
    let temp = fresh_dir("flags-temp");
    for (blocking, parallel, desc, flags) in [(0, 2, "loss", " -l\n"), (1, 2, "BAS", ".bin\n"), (2, 0, "BAS+ext-loss", " -a -e\n"), (1, 1, "BAS", " -o\n")] {
        let mut ctx = context(mm1("0.5", false), "mm1.bnet", resolver_over(&root), &temp);
        ctx.settings.sim_blocking = blocking;
        ctx.settings.sim_parallel = parallel;
        let out = common::run(Method::FiniteComparison, &ctx);
        assert_eq!(out.parameters["blocking"], desc);
        // (Under Loss the one-station tandem qualifies for the CTMC column, whose script this tree
        // lacks, so a warning comes first.)
        assert!(out.status.contains(&StatusLine::info(format!("Running comparison (SM → FM → MC, sim blocking = {desc})..."))), "{:?}", out.status);
        let text = screen(&out, &ctx);
        let args = text.lines().skip_while(|l| !l.starts_with("⚠ Simulation failed")).nth(1).unwrap_or_default().to_string() + "\n";
        assert!(args.ends_with(flags), "{blocking}/{parallel}: {args}");
    }
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn the_loss_regime_adds_the_exact_ctmc_column_for_a_markovian_tandem() {
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("ctmc");
    let mut ctx = context(example("Tandem2.MM1.K5.fin.bnet"), "Tandem2.MM1.K5.fin.bnet", resolver, &temp);
    ctx.settings.sim_blocking = 0;
    let out = common::with_slot(|| common::run(Method::FiniteComparison, &ctx));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert_eq!(out.parameters["blocking"], "loss");
    let runtime = &out.parameters["exact CTMC runtime"];
    assert!(runtime.starts_with("QNET_SOLVER_ROOT: ") && runtime.contains("/bin/finite/fBNActmc/ctmc_dtandem.py; Python runtime: "), "{runtime}");
    assert_eq!(out.status, vec![StatusLine::info("Running comparison (SM → FM → LP → MC, sim blocking = loss)...")]);
    let text = screen(&out, &ctx);
    assert!(text.contains("\nRunning finite LP method (highs) ...  [done]<T>s\nRunning CTMC (exact loss) ...         [done]<T>s\nRunning simulation ...                ["), "{text}");
    let header = text.lines().find(|l| l.trim_start().starts_with("Spectral")).unwrap();
    assert!(header.contains("Finite LP       CTMC (exact loss)  Simulation"), "{header}");
    assert!(!text.contains("QNET_COMPARISON_STATUS_V1"), "{text}");
    assert_eq!(record_status(Method::FiniteComparison, &ctx, &out), "completed");
    let left: Vec<_> = std::fs::read_dir(&temp).unwrap().collect();
    assert!(left.is_empty(), "the LP's CSVs and every input and output are removed: {left:?}");
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn the_ctmc_column_is_omitted_with_a_warning_when_its_script_is_missing_or_the_network_does_not_qualify() {
    let root = finite_tree("no-ctmc", 0);
    let temp = fresh_dir("no-ctmc-temp");
    let mut ctx = context(example("Tandem2.MM1.K5.fin.bnet"), "Tandem2.MM1.K5.fin.bnet", resolver_over(&root), &temp);
    ctx.settings.sim_blocking = 0;
    let Prepared::Launch(run) = prepare(Method::FiniteComparison, &ctx) else { panic!("refused") };
    assert_eq!(run.parameters["exact CTMC runtime"], "omitted");
    assert_eq!(
        run.before,
        vec![StatusLine::warning(
            "Exact tandem CTMC omitted: No loadable copy of ctmc_dtandem.py was found for fBNActmc.\nSearched the app bundle, QNET_SOLVER_ROOT, a nearby Qnet.app, and the development source tree.\nRebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree."
        )]
    );
    drop(run);
    // A second server, a deterministic station, a second class or a BAS regime each drop the
    // column without a word.
    let mut two_servers = example("Tandem2.MM1.K5.fin.bnet");
    two_servers.nodes.iter_mut().find(|n| n.name == "S2").unwrap().servers = 2;
    let mut deterministic = example("Tandem2.MM1.K5.fin.bnet");
    let s1 = deterministic.nodes.iter_mut().find(|n| n.name == "S1").unwrap();
    s1.distribution = qnet_core::model::Distribution::Constant;
    s1.parameters = "value=1.0".into();
    for (net, blocking) in [(two_servers, 0), (deterministic, 0), (example("Tandem2.MM1.K5.fin.bnet"), 1), (example("2d2cfin.bnet"), 0)] {
        let mut ctx = context(net, "t.bnet", resolver_over(&root), &temp);
        ctx.settings.sim_blocking = blocking;
        let Prepared::Launch(run) = prepare(Method::FiniteComparison, &ctx) else { panic!("refused") };
        assert_eq!(run.parameters["exact CTMC runtime"], "omitted");
        assert!(run.before.iter().all(|l| !l.text.starts_with("Exact tandem CTMC")), "{:?}", run.before);
    }
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn the_finite_element_setting_chooses_the_solver_and_names_its_column() {
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("cbc");
    let mut ctx = context(example("MM1K.d1.c1.fin.bnet"), "MM1K.d1.c1.fin.bnet", resolver, &temp);
    ctx.settings.fem_solver = 1;
    let out = common::with_slot(|| common::run(Method::FiniteComparison, &ctx));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert_eq!(out.parameters["finite-element mesh"], "10");
    let text = screen(&out, &ctx);
    let header = text.lines().find(|l| l.trim_start().starts_with("Spectral")).unwrap();
    assert!(header.contains("FE (CBC)"), "{header}");
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn the_finite_element_mesh_is_capped_by_dimension() {
    let root = finite_tree("mesh", 0);
    let temp = fresh_dir("mesh-temp");
    for (file, mesh) in [("MM1K.d1.c1.fin.bnet", "20"), ("4d3c.fin.bnet", "8")] {
        let mut ctx = context(example(file), file, resolver_over(&root), &temp);
        ctx.settings.fem_mesh_size = 30;
        let Prepared::Launch(run) = prepare(Method::FiniteComparison, &ctx) else { panic!("refused") };
        assert_eq!(run.parameters["finite-element mesh"], mesh, "{file}");
    }
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn an_unfixed_seed_is_drawn_and_the_replication_seeds_follow_each_comparisons_rule() {
    let root = finite_tree("seeds", 0);
    fake(&root, "infinite/BNAqna", "bna_qna", "exit 0");
    let temp = fresh_dir("seeds-temp");
    let mut ctx = context(mm1("0.5", false), "mm1.bnet", resolver_over(&root), &temp);
    ctx.settings.sim_seed_fixed = false;
    ctx.settings.sim_replications = 5;
    ctx.entropy = Arc::new(|| 99);
    let Prepared::Launch(run) = prepare(Method::FiniteComparison, &ctx) else { panic!("refused") };
    assert_eq!(run.seed, Some(100), "1 + 99 mod Int32.max");
    assert_eq!(run.replication_seeds, vec![100, 100, 101, 101, 102]);
    drop(run);
    let mut ctx = context(mm1("0.5", true), "mm1.bnet", resolver_over(&root), &temp);
    ctx.settings.sim_seed = -7;
    ctx.settings.sim_replications = 3;
    let Prepared::Launch(run) = prepare(Method::InfiniteComparison, &ctx) else { panic!("refused") };
    assert_eq!(run.seed, Some(0), "a fixed negative seed is raised to 0");
    assert_eq!(run.replication_seeds, vec![0, 1, 2]);
    drop(run);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn a_prepared_comparison_that_is_never_launched_leaves_no_file_behind() {
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("unlaunched");
    for (method, net) in [(Method::InfiniteComparison, mm1("0.5", true)), (Method::FiniteComparison, mm1("0.5", false))] {
        let ctx = context(net, "mm1.bnet", resolver.clone(), &temp);
        let Prepared::Launch(run) = prepare(method, &ctx) else { panic!("{} refused", method.label()) };
        let written: Vec<PathBuf> = run.temps.paths().iter().filter(|p| p.is_file()).cloned().collect();
        assert!(written.len() >= 3, "{}: {written:?}", method.label());
        drop(run);
        let left: Vec<_> = std::fs::read_dir(&temp).unwrap().collect();
        assert!(left.is_empty(), "{}: {left:?}", method.label());
    }
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn a_stop_during_a_comparison_removes_its_files_and_leaves_no_solver_running() {
    use qnet_runner::methods::launch;
    use qnet_runner::supervisor::{CollectSink, RunEvent, RunOwner, RunRegistry};
    let root = fresh_dir("stop");
    let temp = fresh_dir("stop-temp");
    fake(&root, "infinite/BNAsm", "bnet", "while true; do sleep 0.1; done");
    fake(&root, "infinite/BNAqna", "bna_qna", "exit 0");
    let ctx = context(mm1("0.5", true), "mm1.bnet", resolver_over(&root), &temp);
    let Prepared::Launch(run) = prepare(Method::InfiniteComparison, &ctx) else { panic!("refused") };
    let input = temp.join(format!("BNET_inf_cmp_sm_{}.in", ctx.pid));
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
    std::thread::sleep(std::time::Duration::from_millis(800));
    assert!(registry.stop().is_some(), "a run to stop");
    let report = handle.join().expect("the job");
    assert!(report.summary.cancelled(), "{:?}", report.summary);
    let archive = report.archive_text();
    assert!(archive.contains("Running spectral method ...  [                              ]  starting ..."), "{archive}");
    assert!(!archive.contains("Running QNA"), "no later column starts after Stop: {archive}");
    assert!(!archive.contains("Elapsed time"), "{archive}");
    let left: Vec<_> = std::fs::read_dir(&temp).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
    let alive = std::process::Command::new("pgrep").arg("-f").arg(input.to_string_lossy().as_ref()).output().unwrap();
    assert!(alive.stdout.is_empty(), "a solver survived: {}", String::from_utf8_lossy(&alive.stdout));
    assert_eq!(
        *status.lock().unwrap(),
        vec!["Running independent infinite-buffer comparison methods...".to_string(), "Run Comparison cancelled.".to_string()]
    );
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn the_heavy_traffic_warning_names_each_hot_station_only_under_bas_regimes() {
    let root = finite_tree("hot", 0);
    let temp = fresh_dir("hot-temp");
    let warning = |stations: &str, desc: &str| {
        StatusLine::new(
            format!("Warning: {stations} at ρ > 0.97 with sim blocking = {desc}. Continuous-reflection SRBM doesn't model BAS back-pressure — expect the algorithm columns to under-predict queue means by roughly 10%. Pick Loss in the popup for tighter agreement, or see Help ▸ Test Sets ▸ BAS vs Loss."),
            Severity::Warning,
        )
    };
    for (blocking, want) in [(1, vec![warning("S1", "BAS")]), (2, vec![warning("S1", "BAS+ext-loss")]), (0, vec![])] {
        let mut ctx = context(mm1("0.98", false), "mm1.bnet", resolver_over(&root), &temp);
        ctx.settings.sim_blocking = blocking;
        let Prepared::Launch(run) = prepare(Method::FiniteComparison, &ctx) else { panic!("refused") };
        let hot: Vec<StatusLine> = run.before.iter().filter(|l| l.text.starts_with("Warning:")).cloned().collect();
        assert_eq!(hot, want, "{blocking}");
    }
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn a_failing_ctmc_column_is_tolerated_and_announces_the_partial_comparison_itself() {
    // A stand-in ctmc_dtandem.py that prints the arguments it was given and fails.
    let root = finite_tree("ctmc-fail", 0);
    let folder = root.join("bin/finite/fBNActmc");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("ctmc_dtandem.py"), "import sys\nsys.stderr.write(' '.join(sys.argv[1:]) + '\\n')\nsys.exit(4)\n").unwrap();
    let temp = fresh_dir("ctmc-fail-temp");
    let mut ctx = context(example("Tandem2.MM1.K5.fin.bnet"), "Tandem2.MM1.K5.fin.bnet", resolver_over(&root), &temp);
    ctx.settings.sim_blocking = 0;
    let out = common::run(Method::FiniteComparison, &ctx);
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert!(out.parameters["exact CTMC runtime"].contains("/bin/finite/fBNActmc/ctmc_dtandem.py; Python runtime: "));
    let text = screen(&out, &ctx);
    assert!(
        text.contains("\nRunning CTMC (exact loss) ...      [done]<T>s\n\n⚠ Exact loss-tandem CTMC failed (exit 4):\n--buffers 4 4 --servers 1 1 --lam 0.7 --mu 1 1 --mode loss --grid\nContinuing comparison without the exact loss-tandem CTMC column.\nQNET_COMPARISON_STATUS_V1 partial=yes successful=other failed=ctmc\nRunning simulation ...             ["),
        "{text}"
    );
    let header = text.lines().find(|l| l.trim_start().starts_with("Spectral")).unwrap();
    assert!(header.contains("CTMC (exact loss)"), "{header}");
    assert_eq!(block(&text, "E[X_1]"), vec!["E[X_1]  0.900     1.100       —                  —           1.000"], "{text}");
    assert_eq!(text.matches("QNET_COMPARISON_STATUS_V1").count(), 1, "the other columns succeeded: {text}");
    assert_eq!(record_status(Method::FiniteComparison, &ctx, &out), "partial");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}
