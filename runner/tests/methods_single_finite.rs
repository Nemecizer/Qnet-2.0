//! The finite-buffer single-method run specifications (`methods/single/finite.rs`: Run Spectral
//! Method `sm`, Run Finite Element `fm`, Run Monte Carlo `sim`) against 0.90.34.
//!
//! The golden acceptance is `common::golden_method` for each method: for every example with a
//! folder for it in `golden/runs/`, the run is prepared and launched with the staged solvers as
//! `golden/tools/GoldenRuns.swift` ran it (the parameter sheet answered with its initial values),
//! and its Status lines, launch, parameters, seeds, exit status, normalised archive and filed record
//! are compared with what 0.90.34 wrote, under the rules listed with `common::golden_method`.
//!
//! Besides the corpus, which launches every run and refuses none: each refusal sentence (a missing
//! solver with `findBinary`'s fixed detail, each exporter's refusal, a write failure), the mesh cap
//! by station count, the argument vector each sheet answer gives (checked with a stand-in solver
//! that records its arguments), a failing solver's text and Status lines, an unfixed seed, the CBC
//! quadrature and the Legendre basis on the real solvers, and a Stop during a long simulation.
mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::model::{Distribution, Network, NodeKind};
use qnet_runner::methods::{prepare, Method, Prepared, RunContext, RunSettings, StatusLine};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use qnet_runner::supervisor::Severity;

// ─── Golden acceptance ───────────────────────────────────────────────────────────────────────────
//
// The harness and its rules are `common::golden_method` (rules 1–6 in `tests/common/mod.rs`).
//
// Every run of these methods is compared exactly. `fBNAsim` and `srbm_solver` reproduce the
// corpus exactly. `bna_fm_gauss`, the one Accelerate-linked solver here, does too on the input these
// runs give it: on the two networks where it was expected to differ (4d3c.fin and random1.fin.test,
// both four stations, so mesh 8, and both slow runs under rule 4), the staged solver run on this
// port's `BNET_fm_<pid>.in` in a temporary folder printed, on 2026-11-11, byte for byte the output
// 0.90.34's runs left behind (`core/tests/fixtures/output/solver-outputs/<example>/fm/1.txt`), and
// both runs match with `QNET_GOLDEN_SLOW=1`.

fn golden_method(method: Method) {
    common::golden_method(method);
}

#[test]
fn the_finite_spectral_method_matches_0_90_34_on_every_example() {
    golden_method(Method::FiniteSpectral);
}

#[test]
fn the_finite_element_method_matches_0_90_34_on_every_example() {
    golden_method(Method::FiniteElement);
}

#[test]
fn the_finite_monte_carlo_simulation_matches_0_90_34_on_every_example() {
    golden_method(Method::FiniteMonteCarlo);
}

// ─── Networks and contexts for the checks the corpus doesn't reach ──────────────────────────────

/// `examples/<file>` as File › Open reads it.
fn example(file: &str) -> Network {
    let text = std::fs::read_to_string(common::root().join("examples").join(file)).expect("example");
    qnet_core::bnet::read(&text).expect("example reads")
}

/// The M/M/1/K example (one station, a 10-place buffer).
fn mm1k() -> Network {
    example("MM1K.d1.c1.fin.bnet")
}

/// An infinite-buffer example switched to finite buffers, as the Buffer Model menu would.
fn finite(file: &str) -> Network {
    let mut net = example(file);
    net.infinite_buffers = false;
    net
}

/// A context over `net` with the golden settings and `resolver`, writing into `temp`.
fn context(net: Network, title: &str, resolver: Arc<Resolver>, temp: &Path) -> RunContext {
    let mut ctx = RunContext::new(net, title, RunSettings::golden(), resolver);
    ctx.temp_dir = temp.to_path_buf();
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

/// A fresh empty folder for this test, outside the repository.
fn fresh_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-methods-single-finite-{tag}-{}", std::process::id()));
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

/// The files left in a folder.
fn left_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

// ─── Refusals ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn each_missing_solver_is_refused_with_the_fixed_make_sentence() {
    let root = fresh_dir("empty-tree");
    let temp = fresh_dir("empty-tree-temp");
    let resolver = resolver_over(&root);
    let make = |name: &str, dir: &str| {
        StatusLine::info(format!("    Could not locate the {name} binary. Make sure it is compiled (run 'make' in the {dir} directory)."))
    };
    let mut ctx = context(mm1k(), "MM1K.d1.c1.fin.bnet", resolver, &temp);
    assert_eq!(
        refused(Method::FiniteSpectral, &ctx),
        vec![StatusLine::error("Spectral method aborted: srbm_solver binary not found."), make("srbm_solver", "fBNAsm")]
    );
    assert_eq!(
        refused(Method::FiniteElement, &ctx),
        vec![StatusLine::error("Finite element aborted: bna_fm_gauss binary not found."), make("bna_fm_gauss", "fBNAfm")]
    );
    ctx.settings.fem_solver = 1;
    assert_eq!(
        refused(Method::FiniteElement, &ctx),
        vec![StatusLine::error("Finite element aborted: bna_fm_cbc binary not found."), make("bna_fm_cbc", "fBNAfm")]
    );
    assert_eq!(
        refused(Method::FiniteMonteCarlo, &ctx),
        vec![StatusLine::error("Simulation aborted: fBNAsim binary not found."), make("fBNAsim", "fBNAsim")]
    );
    assert!(left_in(&temp).is_empty(), "{:?}", left_in(&temp));
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn each_exporter_refusal_is_reported_as_the_method_aborted() {
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("exporter");
    // A station with an infinite-mean service law: both box files refuse (fBNAsim's text computes
    // no moments, so the simulation is written and launched).
    let mut pareto = mm1k();
    let station = pareto.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap();
    station.distribution = Distribution::Pareto;
    station.parameters = "shape=0.9,scale=1.0".into();
    let ctx = context(pareto, "pareto.bnet", resolver.clone(), &temp);
    let reason = "S1 has a distribution with infinite mean (e.g. Pareto with shape <= 1).";
    assert_eq!(refused(Method::FiniteSpectral, &ctx), vec![StatusLine::error(format!("Spectral method aborted: {reason}"))]);
    assert_eq!(refused(Method::FiniteElement, &ctx), vec![StatusLine::error(format!("Finite element aborted: {reason}"))]);
    drop(launched(Method::FiniteMonteCarlo, &ctx));

    // A station fed straight from its source: all three inputs need a buffer before each station.
    let mut unbuffered = mm1k();
    let buffer = unbuffered.nodes.iter().find(|n| n.kind == NodeKind::Buffer).unwrap().id.clone();
    let station = unbuffered.nodes.iter().find(|n| n.kind == NodeKind::Station).unwrap().id.clone();
    unbuffered.nodes.retain(|n| n.id != buffer);
    unbuffered.links.retain(|l| l.from != buffer);
    for l in unbuffered.links.iter_mut().filter(|l| l.to == buffer) {
        l.to = station.clone();
    }
    let ctx = context(unbuffered, "unbuffered.bnet", resolver, &temp);
    let reason = "Station S1 has no buffer feeding into it.";
    assert_eq!(refused(Method::FiniteSpectral, &ctx), vec![StatusLine::error(format!("Spectral method aborted: {reason}"))]);
    assert_eq!(refused(Method::FiniteElement, &ctx), vec![StatusLine::error(format!("Finite element aborted: {reason}"))]);
    assert_eq!(refused(Method::FiniteMonteCarlo, &ctx), vec![StatusLine::error(format!("Simulation aborted: {reason}"))]);
    assert!(left_in(&temp).is_empty(), "{:?}", left_in(&temp));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn an_input_that_cannot_be_written_is_refused_with_the_reason_as_detail() {
    let Some(resolver) = staged() else { return };
    let missing = PathBuf::from("/nonexistent-dir-qnet-single-finite");
    let ctx = context(mm1k(), "MM1K.d1.c1.fin.bnet", resolver, &missing);
    let pid = ctx.pid;
    for (method, summary, file) in [
        (Method::FiniteSpectral, "Spectral method aborted: could not write temp file.", format!("BNET_sm_{pid}.in")),
        (Method::FiniteElement, "Finite element aborted: could not write temp file.", format!("BNET_fm_{pid}.in")),
        (Method::FiniteMonteCarlo, "Simulation aborted: could not write temp file.", format!("BNET_network_{pid}.txt")),
    ] {
        assert_eq!(
            refused(method, &ctx),
            vec![StatusLine::error(summary), StatusLine::info(format!("    The folder “{file}” doesn’t exist."))],
            "{}",
            method.label()
        );
    }
}

// ─── What the sheets' answers become ────────────────────────────────────────────────────────────

/// The prepared run of `method`, which must launch.
fn launched(method: Method, ctx: &RunContext) -> qnet_runner::methods::PreparedRun {
    match prepare(method, ctx) {
        Prepared::Launch(run) => run,
        Prepared::Refused(lines) => panic!("{} refused: {lines:?}", method.label()),
    }
}

#[test]
fn the_finite_element_mesh_is_capped_by_the_station_count() {
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("mesh-cap");
    for (net, title, mesh) in [
        (mm1k(), "MM1K.d1.c1.fin.bnet", 10),
        (example("4d3c.fin.bnet"), "4d3c.fin.bnet", 8),
        (finite("5stationtandem.inf.bnet"), "5stationtandem.inf.bnet", 6),
        (finite("10stationtandem.inf.bnet"), "10stationtandem.inf.bnet", 4),
    ] {
        let stations = net.nodes_of(NodeKind::Station).count();
        let ctx = context(net, title, resolver.clone(), &temp);
        let run = launched(Method::FiniteElement, &ctx);
        assert_eq!(run.parameters["mesh per dimension"], mesh.to_string(), "{title}");
        assert_eq!(run.parameters["quadrature"], "Gauss-Legendre");
        assert_eq!(run.accepted, vec![StatusLine::info(format!("Running finite element (Gauss-Legendre, mesh={mesh})..."))]);
        let input = run.temps.paths()[0].clone();
        assert_eq!(input.file_name().unwrap().to_string_lossy(), format!("BNET_fm_{}.in", ctx.pid));
        let text = std::fs::read_to_string(&input).unwrap();
        let meshes = vec![mesh.to_string(); stations].join(" ");
        assert!(text.lines().any(|l| l == meshes), "{title}: no line {meshes:?} in\n{text}");
        drop(run);
        assert!(!input.exists(), "{title}: the input outlived the prepared run");
    }
    // A stored mesh below the cap is kept; one below 2 is raised to 2.
    let mut ctx = context(mm1k(), "MM1K.d1.c1.fin.bnet", resolver, &temp);
    ctx.settings.fem_mesh_size = 5;
    assert_eq!(launched(Method::FiniteElement, &ctx).parameters["mesh per dimension"], "5");
    ctx.settings.fem_mesh_size = 1;
    assert_eq!(launched(Method::FiniteElement, &ctx).parameters["mesh per dimension"], "2");
    ctx.settings.fem_solver = 1;
    let run = launched(Method::FiniteElement, &ctx);
    assert_eq!(run.parameters["quadrature"], "CBC QMC");
    assert_eq!(run.accepted, vec![StatusLine::info("Running finite element (CBC QMC, mesh=2)...")]);
    drop(run);
    assert!(left_in(&temp).is_empty(), "{:?}", left_in(&temp));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn the_spectral_degree_and_basis_are_recorded_and_announced() {
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("spectral-sheet");
    let mut ctx = context(mm1k(), "MM1K.d1.c1.fin.bnet", resolver, &temp);
    ctx.settings.sm_degree = 1;
    ctx.settings.sm_legendre = true;
    let run = launched(Method::FiniteSpectral, &ctx);
    assert_eq!(run.parameters["polynomial degree"], "2", "a degree below 2 is raised to 2");
    assert_eq!(run.parameters["basis"], "Legendre");
    assert_eq!(run.accepted, vec![StatusLine::info("Running spectral method (degree=2, Legendre)...")]);
    let text = std::fs::read_to_string(&run.temps.paths()[0]).unwrap();
    assert!(text.contains("\n2\n\n"), "the degree is the file's own line:\n{text}");
    drop(run);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn an_unfixed_seed_is_drawn_from_one_to_int32_max_and_replications_pair_their_seeds() {
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("seed");
    let mut ctx = context(mm1k(), "MM1K.d1.c1.fin.bnet", resolver, &temp);
    ctx.settings.sim_seed_fixed = false;
    ctx.settings.sim_replications = 5;
    ctx.entropy = Arc::new(|| 0);
    let run = launched(Method::FiniteMonteCarlo, &ctx);
    assert_eq!(run.seed, Some(1), "entropy 0 is the lowest seed, 1");
    assert_eq!(run.replication_seeds, vec![1, 1, 2, 2, 3]);
    assert_eq!(run.parameters["fixed seed"], "false");
    drop(run);
    ctx.entropy = Arc::new(|| u64::from(u32::MAX) * 7 + 3);
    let seed = launched(Method::FiniteMonteCarlo, &ctx).seed.unwrap();
    assert!((1..=i32::MAX as u64).contains(&seed), "{seed}");
    // A fixed, negative entered seed is read as 0, and at least one replication runs.
    ctx.settings.sim_seed_fixed = true;
    ctx.settings.sim_seed = -4;
    ctx.settings.sim_replications = 0;
    let run = launched(Method::FiniteMonteCarlo, &ctx);
    assert_eq!((run.seed, run.replication_seeds.clone()), (Some(0), vec![0]));
    assert_eq!(run.parameters["replications"], "1");
    drop(run);
    let _ = std::fs::remove_dir_all(&temp);
}

// ─── A stand-in solver that records how it was started ──────────────────────────────────────────

/// A solver tree under a fresh folder holding one stand-in executable at `bin/finite/<dir>/<name>`.
/// The stand-in passes the loadability probe, writes its arguments one per line to `argv.txt`
/// beside itself, fills the `-P` file with a total of 4 and four units, and prints a one-station
/// `-G` table and a warning line on stderr; with a `fail` file beside it, it prints an error on
/// stderr and exits 3 instead.
fn stand_in(tag: &str, dir: &str, name: &str) -> (PathBuf, PathBuf) {
    let root = fresh_dir(tag);
    let folder = root.join("bin/finite").join(dir);
    std::fs::create_dir_all(&folder).unwrap();
    let script = r#"#!/bin/sh
[ "$1" = "--qnet-loadability-probe" ] && exit 0
here=$(dirname "$0")
: > "$here/argv.txt"
prev=""
for a in "$@"; do
  printf '%s\n' "$a" >> "$here/argv.txt"
  [ "$prev" = "-P" ] && printf '4\n....' > "$a"
  prev="$a"
done
if [ -f "$here/fail" ]; then
  echo "stand-in: the matrix is singular" >&2
  exit 3
fi
printf 'rho_1 = 0.900000\nGamma_1 = 0.900000\nsojourn_1 = 7.500000\nE[X_1] = 6.750000\n'
echo "WARNING: stand-in condition number 1e+14" >&2
"#;
    let exe = folder.join(name);
    std::fs::write(&exe, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    (root, folder)
}

fn recorded_argv(folder: &Path) -> Vec<String> {
    std::fs::read_to_string(folder.join("argv.txt")).unwrap().lines().map(str::to_string).collect()
}

/// Checks the recorded arguments: `expected` with `<IN>` for the input, `<P>` for the progress
/// file (which must be in the run's temporary folder and gone afterwards).
fn assert_argv(folder: &Path, temp: &Path, input: &str, expected: &[&str]) {
    let argv = recorded_argv(folder);
    assert_eq!(argv.len(), expected.len(), "{argv:?}");
    for (got, want) in argv.iter().zip(expected) {
        match *want {
            "<IN>" => assert_eq!(*got, temp.join(input).to_string_lossy(), "{argv:?}"),
            "<P>" => {
                let p = Path::new(got);
                assert_eq!(p.parent().unwrap(), temp, "{argv:?}");
                assert!(p.file_name().unwrap().to_string_lossy().starts_with("BNET_progress_fin_"), "{argv:?}");
                assert!(!p.exists(), "the progress file outlived the run");
            }
            w => assert_eq!(got, w, "{argv:?}"),
        }
    }
}

/// Runs `method` over a stand-in `<dir>/<name>` with the golden settings changed by `set`, and
/// checks its exit, its recorded arguments, its bar and that it left nothing behind.
fn run_stand_in(method: Method, dir: &str, name: &str, set: &dyn Fn(&mut RunSettings), input: &str, expected: &[&str], prefix: &str) -> common::Outcome {
    let temp = fresh_dir(&format!("argv-temp-{name}"));
    let (root, folder) = stand_in(&format!("argv-{name}"), dir, name);
    let mut ctx = context(mm1k(), "MM1K.d1.c1.fin.bnet", resolver_over(&root), &temp);
    set(&mut ctx.settings);
    let out = common::run(method, &ctx);
    assert_eq!(out.exit_code, Some(0), "{}: {}", method.label(), out.archive);
    assert_argv(&folder, &temp, input, expected);
    assert!(out.archive.contains(&format!("{prefix}[")), "{}", out.archive);
    assert!(out.archive.contains("]  4/4          (100%)  "), "{}", out.archive);
    assert!(left_in(&temp).is_empty(), "{:?}", left_in(&temp));
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
    out
}

#[test]
fn each_method_starts_its_solver_with_0_90_34s_arguments() {
    let pid = std::process::id();
    let sm_in = format!("BNET_sm_{pid}.in");
    let fm_in = format!("BNET_fm_{pid}.in");
    let sim_in = format!("BNET_network_{pid}.txt");
    let running_sm = "Running spectral method ...  ";
    run_stand_in(Method::FiniteSpectral, "fBNAsm", "srbm_solver", &|_| {}, &sm_in, &["<IN>", "-G", "-P", "<P>"], running_sm);
    run_stand_in(Method::FiniteSpectral, "fBNAsm", "srbm_solver", &|s| s.sm_legendre = true, &sm_in, &["<IN>", "-G", "-P", "<P>", "-L"], running_sm);
    let running_fm = "Running finite element method ...  ";
    run_stand_in(Method::FiniteElement, "fBNAfm", "bna_fm_gauss", &|_| {}, &fm_in, &["<IN>", "-G", "-P", "<P>"], running_fm);
    run_stand_in(Method::FiniteElement, "fBNAfm", "bna_fm_cbc", &|s| s.fem_solver = 1, &fm_in, &["<IN>", "-G", "-P", "<P>"], running_fm);
    let running_sim = "Running simulation ...  ";
    for (parallel, blocking, tail, mode) in [
        (2, 2, &["-e"][..], "BAS+ext-loss"),
        (0, 0, &["-a", "-l"][..], "loss"),
        (1, 1, &["-o"][..], "BAS"),
        (7, 9, &[][..], "BAS"),
    ] {
        let mut expected = vec!["-f", "<IN>", "-G", "-n", "8", "-w", "10000", "-T", "200000", "-s", "12345", "-P", "<P>"];
        expected.extend_from_slice(tail);
        let set = move |s: &mut RunSettings| {
            s.sim_parallel = parallel;
            s.sim_blocking = blocking;
        };
        let out = run_stand_in(Method::FiniteMonteCarlo, "fBNAsim", "fBNAsim", &set, &sim_in, &expected, running_sim);
        assert_eq!(out.parameters["blocking"], mode);
        assert_eq!(out.parameters["parallelism"], parallel.to_string());
        assert_eq!(out.status[0], StatusLine::info(format!("Running simulation via fBNAsim ({mode} mode)...")));
    }
}

#[test]
fn a_clean_run_prints_the_banner_the_bar_a_blank_line_the_table_and_the_elapsed_time() {
    let temp = fresh_dir("clean-temp");
    let (root, _folder) = stand_in("clean", "fBNAsm", "srbm_solver");
    let mut ctx = context(mm1k(), "MM1K.d1.c1.fin.bnet", resolver_over(&root), &temp);
    ctx.cpu_count = 18;
    let out = common::run(Method::FiniteSpectral, &ctx);
    assert_eq!(out.exit_code, Some(0));
    let archive = common::normalize(&out.archive, None, None);
    let expected = [
        "[Threads] Using 18 CPU cores (OpenMP)",
        &format!("Running spectral method ...  [{}]  4/4          (100%)<T>s", "\x1b[7m \x1b[27m ".repeat(15)),
        "",
        "Network load: rho_max = 0.9000 at S1  (near heavy-traffic — small O(1) deviation expected)",
    ];
    let lines: Vec<&str> = archive.split('\n').collect();
    assert_eq!(&lines[..4], &expected[..], "{archive}");
    // M/M/1/K is tractable: the skew-symmetric exact column sits beside the solver's.
    assert!(lines[4].starts_with("──  ") && lines[5].starts_with("           Spectral  "), "{archive}");
    assert!(archive.contains("\nrho_1      0.900 "), "{archive}");
    assert!(archive.ends_with("\nElapsed time: <T>s\n\n"), "{archive}");
    // The clean exit's warning line reaches the Status log after the "Running" line.
    assert_eq!(
        out.status,
        vec![
            StatusLine::info("Running spectral method (degree=8)..."),
            StatusLine::info("⚠ Spectral Method warnings:"),
            StatusLine::warning("WARNING: stand-in condition number 1e+14"),
        ]
    );
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn a_failing_solver_shows_its_stderr_before_the_bars_last_frame_and_nothing_after() {
    let temp = fresh_dir("fail-temp");
    for (method, dir, name, label, display) in [
        (Method::FiniteSpectral, "fBNAsm", "srbm_solver", "Spectral Method", "Spectral"),
        (Method::FiniteElement, "fBNAfm", "bna_fm_gauss", "Finite Element", "Finite Element"),
        (Method::FiniteMonteCarlo, "fBNAsim", "fBNAsim", "Simulation", "Monte Carlo"),
    ] {
        let (root, folder) = stand_in(&format!("fail-{name}"), dir, name);
        std::fs::write(folder.join("fail"), "").unwrap();
        let ctx = context(mm1k(), "MM1K.d1.c1.fin.bnet", resolver_over(&root), &temp);
        let out = common::run(method, &ctx);
        assert_eq!(out.exit_code, Some(3), "{}", out.archive);
        let archive = common::normalize(&out.archive, None, None);
        let tail = format!("\n⚠ {label} failed (exit 3):\nstand-in: the matrix is singular\n");
        let at = out.archive.find(&tail).unwrap_or_else(|| panic!("{}: no failure text in {:?}", method.label(), out.archive));
        let after = &out.archive[at + tail.len()..];
        assert!(after.starts_with("\r\x1b[K") && after.ends_with("s\n") && after.matches('\n').count() == 1, "{after:?}");
        assert!(!archive.contains("Elapsed time") && !archive.contains("Network load"), "{archive}");
        let texts: Vec<(Severity, String)> = out.status.iter().map(|l| (l.severity, common::mask_duration(&l.text))).collect();
        assert_eq!(texts.len(), 4, "{texts:?}");
        assert_eq!(texts[1], (Severity::Info, format!("⚠ {label} failed (exit 3):")));
        assert_eq!(texts[2], (Severity::Info, "stand-in: the matrix is singular".to_string()));
        assert_eq!(texts[3], (Severity::Error, format!("{display} failed (exit 3) after <T>")));
        assert!(left_in(&temp).is_empty(), "{:?}", left_in(&temp));
        let _ = std::fs::remove_dir_all(&root);
    }
    let _ = std::fs::remove_dir_all(&temp);
}

// ─── The real solvers on what the corpus doesn't run ────────────────────────────────────────────

/// The run's table rows (after the regime lines), from the normalised archive.
fn table_of(archive: &str) -> Vec<String> {
    archive.lines().skip_while(|l| !l.starts_with("rho_1")).take_while(|l| !l.starts_with("Elapsed time")).map(str::to_string).collect()
}

#[test]
fn the_cbc_quadrature_and_the_legendre_basis_run_on_the_staged_solvers() {
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("variants");
    let mut ctx = context(example("Tandem2.MM1.K5.fin.bnet"), "Tandem2.MM1.K5.fin.bnet", resolver, &temp);
    ctx.settings.fem_solver = 1;
    let out = common::with_slot(|| common::run(Method::FiniteElement, &ctx));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert_eq!(out.status[0], StatusLine::info("Running finite element (CBC QMC, mesh=10)..."));
    assert!(out.archive.contains("\n           Finite Element"), "{}", out.archive);
    let record = common::file_record(Method::FiniteElement, &ctx, &common::root().join("examples/Tandem2.MM1.K5.fin.bnet"), &out).expect("a record");
    let status = record.as_object().unwrap()["status"].as_str().unwrap().to_string();
    assert_eq!(status, "completed");
    let rows = table_of(&common::normalize(&out.archive, None, None));
    assert!(rows.iter().any(|r| r.starts_with("E[X_2] ")), "{rows:?}");

    ctx.settings.fem_solver = 0;
    ctx.settings.sm_legendre = true;
    let out = common::with_slot(|| common::run(Method::FiniteSpectral, &ctx));
    assert_eq!(out.exit_code, Some(0), "{}", out.archive);
    assert_eq!(out.parameters["basis"], "Legendre");
    assert!(table_of(&common::normalize(&out.archive, None, None)).iter().any(|r| r.starts_with("E[X_2] ")));
    assert!(left_in(&temp).is_empty(), "{:?}", left_in(&temp));
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn a_stop_during_a_long_simulation_removes_its_files_and_leaves_no_simulator_running() {
    use qnet_runner::methods::launch;
    use qnet_runner::supervisor::{CollectSink, RunEvent, RunOwner, RunRegistry};
    let Some(resolver) = staged() else { return };
    let temp = fresh_dir("stop");
    let mut ctx = context(example("4d3c.fin.bnet"), "4d3c.fin.bnet", resolver, &temp);
    ctx.settings.sim_time = 1_000_000_000;
    let Prepared::Launch(run) = prepare(Method::FiniteMonteCarlo, &ctx) else { panic!("refused") };
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
    assert!(left_in(&temp).is_empty(), "files outlived the run: {:?}", left_in(&temp));
    let archive = report.archive_text();
    assert!(archive.starts_with(&format!("[Threads] Using {} CPU cores (OpenMP)\nRunning simulation ...  [", ctx.cpu_count)), "{archive}");
    assert!(!archive.contains("Elapsed time") && !archive.contains("Network load"), "{archive}");
    let alive = std::process::Command::new("pgrep").arg("-f").arg(input.to_string_lossy().as_ref()).output().unwrap();
    assert!(alive.stdout.is_empty(), "a simulator survived: {}", String::from_utf8_lossy(&alive.stdout));
    assert_eq!(
        *status.lock().unwrap(),
        vec!["Running simulation via fBNAsim (BAS+ext-loss mode)...".to_string(), "Monte Carlo cancelled.".to_string()]
    );
    let _ = std::fs::remove_dir_all(&temp);
}
