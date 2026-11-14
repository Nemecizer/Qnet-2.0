//! Run › Test Set (infinite and finite) and Run › Spectral Convergence: the two sweeps that
//! generate random networks, run several solvers on each and print one accuracy table. They are not
//! Run-menu methods (they don't solve the open network), so they have their own preparing and
//! launching functions here, beside [`super::prepare`] and [`super::launch`].
//!
//! This ports, from `2_QNET/Sources/Qnet/QnetGUIApp.swift`, `executeTestSet`,
//! `testSetCaseSpinner`, `executeSpectralConvergence`, `loadTestSetDefaults` and
//! `loadSpectralConvergenceDefaults`, and from `TestSetRunner.swift` the ρ grid
//! (`SpectralConvergenceParameters.rhoValues`) and the sheets' validation sentences (`problem`),
//! which the sheets themselves (P6) and any other caller share. The two awk aggregators
//! (`testSetAggregatorAwk`, `spectralConvergenceAggregatorAwk`) are `qnet_core::output::aggregate`.
//! `TestSetRunner.swift`'s `Process`-based runner (`TestSetProcess.runCapturing`, `TestSetParser`,
//! `formatAggregateReport`) was never called in 0.90.34 and is not ported (METH-151, TEST-030).
//!
//! In 0.90.34 a sweep ran in two phases. Before typing anything into the Shell, the app drew every
//! case from a SplitMix64 stream seeded with the base seed (d, K and ρ, or d and K for the
//! convergence sweep, then a network seed and a 31-bit simulation seed), generated each network
//! with `RandomNetworkGenerator`, and wrote its solver inputs into a fresh work folder
//! `BNET_testset_<pid>_<ms>` (`BNET_spc_<pid>_<ms>`). Then one generated bash script printed a
//! header, ran each case's solvers one after another (stdout to `out_<case>_<algo>.txt`, stderr
//! discarded, a missing solver skipped) under a per-case spinner that ends "done in X.XXs", ran the
//! awk aggregator over `out_*.txt`, and removed the work folder; `runScript` added "Elapsed time".
//! Preparing here is the first phase and the run's body is the second, with the same text in the
//! same order, the same record parameters, base seed and replication seeds, and the same exit
//! status (the folder removal's, so 0 however the solvers fared).
//!
//! Where 2.0 differs, deliberately:
//!
//! - D1 (TEST-014, RUN-066): each solver is started by the supervisor as an argument vector, with
//!   its standard output going straight to its `out_…` file; the spinner is drawn by the app
//!   (`|/-\` every 0.15 s, as the bash poller did), and the tables are composed in Rust.
//! - The work folder is a temporary of the run, so it is removed on every exit path: after the
//!   table as before, at once when the launch is refused (as before), and now also after Stop,
//!   which in 0.90.34 left it behind (METH-144, TEST-017).
//! - The solvers run with the work folder as their working directory (0.90.34: wherever the user's
//!   shell was), so a file a solver writes beside itself goes away with the folder.
//! - A test set looks up only its own regime's solvers; 0.90.34 probed all nine for either regime.
//!   Which solvers run is unchanged.
//! - A sweep whose parameters the sheet would not accept is refused with the sheet's own sentence,
//!   and one whose work folder can't be created is refused with "<Label> could not start: …"; the
//!   sheet made the first impossible in 0.90.34, and the second ran a sweep with no inputs.
//! - When no solver wrote any output at all (none was found), the table is printed with every row
//!   empty; 0.90.34's awk stopped with "can't open file …/out_*.txt" instead.
//!
//! Kept although it looks wrong: the "Elapsed time" line counts from the start of the last case's
//! spinner, not from the start of the sweep, because 0.90.34's per-case spinner reused the
//! wrapper's `_t0` variable (golden: "done in 0.06s" for the last case, then "Elapsed time:
//! 0.077s" after a 0.4 s sweep).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use qnet_core::cfmt;
use qnet_core::export::{fbnasim, jackson_sim, qna, srbm_box, srbm_orthant};
use qnet_core::generate::rng::SplitMix64;
use qnet_core::generate::{self, CountingIds, Topology};
use qnet_core::model::Network;
use qnet_core::output::aggregate::{spectral_convergence_table, test_set_table, SweepFile};

use crate::supervisor::{
    display_label, elapsed_footer, run_job, Job, JobOutput, JobReport, OutputSink, ProcessSpec, Refused, Reporter,
    RunEvent, RunOwner, RunRegistry, StderrTarget, Step, TempFiles, CANCELLED_EXIT_CODE,
};

use super::exact::cocoa_write_error;
use super::{RunBody, RunContext, SpectralConvergenceParameters, StatusLine, TestSetParameters};

// ─── What is prepared and launched ───────────────────────────────────────────────────────────────

/// Which sweep a prepared run is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Sweep {
    /// Run › Run Infinite Test Set….
    InfiniteTestSet,
    /// Run › Run Finite Test Set….
    FiniteTestSet,
    /// Run › Run Infinite Spectral Convergence….
    SpectralConvergence,
}

impl Sweep {
    /// 0.90.34's run label: `testset` for both test sets, `spc` for the convergence sweep (the
    /// key of `resultMethod(forRunLabel:)` and the registry's label).
    pub fn label(self) -> &'static str {
        match self {
            Sweep::InfiniteTestSet | Sweep::FiniteTestSet => "testset",
            Sweep::SpectralConvergence => "spc",
        }
    }

    /// The name the run is shown under ("Test Set", "Spectral Convergence").
    pub fn display_label(self) -> String {
        display_label(self.label())
    }
}

/// A sweep that passed its checks and is ready to launch: the counterpart of
/// [`super::PreparedRun`] for a run that is not a Run-menu [`super::Method`].
pub struct PreparedSweep {
    pub sweep: Sweep,
    /// The record's parameters (`runScript(…, parameters:)`).
    pub parameters: BTreeMap<String, String>,
    /// The base seed, recorded as the run's seed.
    pub seed: Option<u64>,
    /// Every case's simulation seed, recorded as the replication seeds.
    pub replication_seeds: Vec<u64>,
    /// Status lines written before the launch (0.90.34 wrote none).
    pub before: Vec<StatusLine>,
    /// Status lines written once the launch is accepted (0.90.34 wrote none).
    pub accepted: Vec<StatusLine>,
    /// The work folder holding every input and solver output.
    pub work_dir: PathBuf,
    /// The work folder, removed when the run ends or at once if the launch is refused.
    pub temps: TempFiles,
    pub body: RunBody,
}

impl std::fmt::Debug for PreparedSweep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedSweep")
            .field("sweep", &self.sweep)
            .field("parameters", &self.parameters)
            .field("seed", &self.seed)
            .field("replication_seeds", &self.replication_seeds)
            .field("before", &self.before)
            .field("accepted", &self.accepted)
            .field("work_dir", &self.work_dir)
            .finish_non_exhaustive()
    }
}

/// What preparing a sweep gives.
#[derive(Debug)]
pub enum SweepPrepared {
    /// The sweep did not start; these are the Status lines to write.
    Refused(Vec<StatusLine>),
    /// The sweep is ready to launch.
    Launch(PreparedSweep),
}

/// Launches a prepared sweep through the single-flight registry, on a new thread, as
/// [`super::launch`] does for a method: the `before` lines, then the registry's refusal (the work
/// folder is removed and `Err` returned) or the `accepted` lines and the body as a job.
pub fn launch_sweep(
    run: PreparedSweep,
    registry: &Arc<RunRegistry>,
    owner: RunOwner,
    reporter: Reporter,
    sink: Box<dyn OutputSink>,
) -> Result<JoinHandle<JobReport>, Refused> {
    let PreparedSweep { sweep, before, accepted, temps, body, .. } = run;
    for line in &before {
        reporter(&RunEvent::Status { text: line.text.clone(), severity: line.severity });
    }
    let ticket = match registry.begin(sweep.label(), owner, reporter.clone()) {
        Ok(ticket) => ticket,
        Err(refused) => {
            drop(temps);
            return Err(refused);
        }
    };
    for line in &accepted {
        reporter(&RunEvent::Status { text: line.text.clone(), severity: line.severity });
    }
    Ok(std::thread::spawn(move || {
        run_job(ticket, sink, move |job| {
            job.adopt_temps(temps);
            body(job)
        })
    }))
}

// ─── The sheets' defaults and checks ─────────────────────────────────────────────────────────────

/// The Settings ▸ Test Sets values the two sheets open with (`testset.inf.*`, `testset.fin.*`,
/// `testset.spc.*` in 0.90.34's `AppSettings`), with 0.90.34's defaults. The Settings window that
/// edits them is P4.
#[derive(Debug, Clone, PartialEq)]
pub struct TestSetSettings {
    /// `testset.inf.stationsLo` (3) and `testset.inf.stationsHi` (6).
    pub inf_stations: (i64, i64),
    /// `testset.inf.classesLo` (1) and `testset.inf.classesHi` (3).
    pub inf_classes: (i64, i64),
    /// `testset.inf.rhoLo` (0.5) and `testset.inf.rhoHi` (0.85).
    pub inf_rho: (f64, f64),
    /// `testset.inf.numCases` (20).
    pub inf_num_cases: i64,
    /// `testset.inf.topology` (0, feed-forward).
    pub inf_topology: i64,
    /// `testset.fin.stationsLo` (2) and `testset.fin.stationsHi` (4).
    pub fin_stations: (i64, i64),
    /// `testset.fin.classesLo` (1) and `testset.fin.classesHi` (2).
    pub fin_classes: (i64, i64),
    /// `testset.fin.rhoLo` (0.5) and `testset.fin.rhoHi` (0.85).
    pub fin_rho: (f64, f64),
    /// `testset.fin.numCases` (10).
    pub fin_num_cases: i64,
    /// `testset.fin.topology` (0).
    pub fin_topology: i64,
    /// `testset.spc.stationsLo` (3) and `testset.spc.stationsHi` (6).
    pub spc_stations: (i64, i64),
    /// `testset.spc.classesLo` (1) and `testset.spc.classesHi` (3).
    pub spc_classes: (i64, i64),
    /// `testset.spc.rhoStart` (0.50).
    pub spc_rho_start: f64,
    /// `testset.spc.rhoEnd` (0.95).
    pub spc_rho_end: f64,
    /// `testset.spc.rhoStep` (0.05).
    pub spc_rho_step: f64,
    /// `testset.spc.numCases` (10).
    pub spc_num_cases: i64,
    /// `testset.spc.topology` (0).
    pub spc_topology: i64,
}

impl Default for TestSetSettings {
    fn default() -> Self {
        Self {
            inf_stations: (3, 6),
            inf_classes: (1, 3),
            inf_rho: (0.5, 0.85),
            inf_num_cases: 20,
            inf_topology: 0,
            fin_stations: (2, 4),
            fin_classes: (1, 2),
            fin_rho: (0.5, 0.85),
            fin_num_cases: 10,
            fin_topology: 0,
            spc_stations: (3, 6),
            spc_classes: (1, 3),
            spc_rho_start: 0.50,
            spc_rho_end: 0.95,
            spc_rho_step: 0.05,
            spc_num_cases: 10,
            spc_topology: 0,
        }
    }
}

/// A stored topology as the sheets read it: `Topology(rawValue:) ?? .feedForward`.
fn topology_of(raw: i64) -> Topology {
    Topology::from_raw(raw).unwrap_or(Topology::FeedForward)
}

/// `loadTestSetDefaults(infinite:)`: the test-set sheet's starting values for one regime. The seed
/// is never filled in (the sheet opens with a fresh seed).
pub fn load_test_set_defaults(settings: &TestSetSettings, infinite: bool) -> TestSetParameters {
    let s = settings;
    let (stations, classes, rho, cases, topology) = if infinite {
        (s.inf_stations, s.inf_classes, s.inf_rho, s.inf_num_cases, s.inf_topology)
    } else {
        (s.fin_stations, s.fin_classes, s.fin_rho, s.fin_num_cases, s.fin_topology)
    };
    TestSetParameters {
        stations_lower: stations.0,
        stations_upper: stations.1,
        classes_lower: classes.0,
        classes_upper: classes.1,
        rho_lower: rho.0,
        rho_upper: rho.1,
        num_test_cases: cases,
        topology: topology_of(topology).raw(),
        seed: None,
    }
}

/// `loadSpectralConvergenceDefaults()`: the convergence sheet's starting values.
pub fn load_spectral_convergence_defaults(settings: &TestSetSettings) -> SpectralConvergenceParameters {
    let s = settings;
    SpectralConvergenceParameters {
        stations_lower: s.spc_stations.0,
        stations_upper: s.spc_stations.1,
        classes_lower: s.spc_classes.0,
        classes_upper: s.spc_classes.1,
        rho_start: s.spc_rho_start,
        rho_end: s.spc_rho_end,
        rho_step: s.spc_rho_step,
        num_test_cases: s.spc_num_cases,
        topology: topology_of(s.spc_topology).raw(),
        seed: None,
    }
}

/// The station and class checks both sheets make first, in row order.
fn range_problem(stations: (i64, i64), classes: (i64, i64)) -> Option<&'static str> {
    let station_range = 1..=32;
    let class_range = 1..=16;
    if !station_range.contains(&stations.0) || !station_range.contains(&stations.1) {
        return Some("Stations must be between 1 and 32.");
    }
    if stations.0 > stations.1 {
        return Some("Minimum stations must not exceed the maximum.");
    }
    if !class_range.contains(&classes.0) || !class_range.contains(&classes.1) {
        return Some("Customer classes must be between 1 and 16.");
    }
    if classes.0 > classes.1 {
        return Some("Minimum classes must not exceed the maximum.");
    }
    None
}

/// The test-set sheet's first blocking problem (`TestSetParameterSheet.problem`), or `None` when
/// the sweep can run.
pub fn test_set_problem(p: &TestSetParameters) -> Option<&'static str> {
    if let Some(problem) = range_problem((p.stations_lower, p.stations_upper), (p.classes_lower, p.classes_upper)) {
        return Some(problem);
    }
    if !(p.rho_lower > 0.0 && p.rho_upper < 1.0) {
        return Some("ρ must lie strictly between 0 and 1.");
    }
    if p.rho_lower > p.rho_upper {
        return Some("Minimum ρ must not exceed the maximum.");
    }
    if !(1..=1000).contains(&p.num_test_cases) {
        return Some("Test cases must be between 1 and 1000.");
    }
    None
}

/// The convergence sheet's first blocking problem (`SpectralConvergenceParameterSheet.problem`),
/// or `None` when the sweep can run.
pub fn spectral_convergence_problem(p: &SpectralConvergenceParameters) -> Option<&'static str> {
    if let Some(problem) = range_problem((p.stations_lower, p.stations_upper), (p.classes_lower, p.classes_upper)) {
        return Some(problem);
    }
    let sweep_valid = p.rho_start > 0.0
        && p.rho_end > p.rho_start
        && p.rho_end < 1.0
        && p.rho_step > 0.0
        && p.rho_step <= (p.rho_end - p.rho_start) + 1e-9;
    if !sweep_valid {
        return Some("ρ sweep needs 0 < start < end < 1 and 0 < step ≤ end − start.");
    }
    if !(1..=200).contains(&p.num_test_cases) {
        return Some("Test cases must be between 1 and 200.");
    }
    None
}

/// The convergence sweep's ρ grid (`SpectralConvergenceParameters.rhoValues`): start, start + step,
/// … while within end + 1e-9 (each capped at end), with end appended when the last step falls
/// short of it; just `[start]` when the step is not above 1e-9.
// `guard rhoStep > 1e-9` is kept as a negated comparison, so a NaN step gives `[start]` as it did.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn rho_values(p: &SpectralConvergenceParameters) -> Vec<f64> {
    if !(p.rho_step > 1e-9) {
        return vec![p.rho_start];
    }
    let mut out = Vec::new();
    let mut v = p.rho_start;
    while v <= p.rho_end + 1e-9 {
        // Swift's `min(v, rhoEnd)`: `rhoEnd < v ? rhoEnd : v`.
        out.push(if p.rho_end < v { p.rho_end } else { v });
        v += p.rho_step;
    }
    if let Some(&last) = out.last() {
        if (last - p.rho_end).abs() > 1e-9 && last < p.rho_end {
            out.push(p.rho_end);
        }
    }
    out
}

/// The topology's name in the header and the record ("feed-forward", "Jackson + feedback",
/// "general P-matrix", "re-entrant").
pub fn topology_label(raw: i64) -> &'static str {
    match topology_of(raw) {
        Topology::FeedForward => "feed-forward",
        Topology::JacksonFeedback => "Jackson + feedback",
        Topology::GeneralPMatrix => "general P-matrix",
        Topology::ReentrantFeedback => "re-entrant",
    }
}

// ─── Run › Test Set ──────────────────────────────────────────────────────────────────────────────

/// One drawn test case (`CaseMeta` in `executeTestSet`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct TestCase {
    d: i64,
    k: i64,
    rho: f64,
    network_seed: u64,
    simulation_seed: u64,
}

/// The cases of a test set, drawn from the base seed's stream as 0.90.34 drew them.
fn draw_test_cases(p: &TestSetParameters, base_seed: u64) -> Vec<TestCase> {
    let mut rng = SplitMix64::new(base_seed);
    (0..p.num_test_cases.max(0))
        .map(|_| {
            let d = rng.int_in_closed(p.stations_lower, p.stations_upper);
            let k = rng.int_in_closed(p.classes_lower, p.classes_upper);
            let rho = rng.double_in_closed(p.rho_lower, p.rho_upper);
            let network_seed = rng.next_u64();
            let simulation_seed = rng.next_u64() & i32::MAX as u64;
            TestCase { d, k, rho, network_seed, simulation_seed }
        })
        .collect()
}

/// The simulation settings every case passes on.
#[derive(Debug, Clone, Copy)]
struct SimRun {
    replications: i64,
    warmup: i64,
    time: i64,
}

/// The solvers of an infinite-buffer sweep (`TestSetBinaries`); a missing one is skipped.
#[derive(Debug, Clone, Default)]
struct InfiniteSolvers {
    bnet: Option<PathBuf>,
    qna: Option<PathBuf>,
    rqna: Option<PathBuf>,
    sbd: Option<PathBuf>,
    jackson_sim: Option<PathBuf>,
}

/// The solvers of a finite-buffer test set.
#[derive(Debug, Clone, Default)]
struct FiniteSolvers {
    srbm: Option<PathBuf>,
    fm: Option<PathBuf>,
    lp: Option<PathBuf>,
    sim: Option<PathBuf>,
}

/// `findBinary(name:subdirectory:)`: the resolver's chosen file, or nothing.
fn find(ctx: &RunContext, name: &str, subdirectory: &str) -> Option<PathBuf> {
    ctx.resolver.resolve_executable(name, subdirectory).url().map(Path::to_path_buf)
}

/// One solver of a case: its argument vector, standard output to `out`, standard error
/// discarded (`> "<out>" 2>/dev/null`), run in the work folder.
fn solver(program: &Path, args: Vec<String>, out: PathBuf, work_dir: &Path) -> ProcessSpec {
    ProcessSpec::new(program).args(args).stdout_to(out).stderr(StderrTarget::Null).cwd(work_dir)
}

fn path_arg(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// The infinite-buffer chain for one input stem (`case_3` or `case_3_r2`), in 0.90.34's order:
/// Spectral, QNA, RQNA, SBD (the latter two only for a test set), Sim.
fn infinite_chain(bins: &InfiniteSolvers, dir: &Path, stem: &str, out: &str, sim: SimRun, seed: u64) -> Vec<ProcessSpec> {
    let input = |ext: &str| path_arg(dir.join(format!("{stem}.{ext}")));
    let output = |algo: &str| dir.join(format!("{out}_{algo}.txt"));
    let mut chain = Vec::new();
    if let Some(bin) = &bins.bnet {
        chain.push(solver(bin, vec!["-c".into(), input("smin")], output("Spectral"), dir));
    }
    for (bin, algo) in [(&bins.qna, "QNA"), (&bins.rqna, "RQNA"), (&bins.sbd, "SBD")] {
        if let Some(bin) = bin {
            chain.push(solver(bin, vec![input("qna"), "-c".into()], output(algo), dir));
        }
    }
    if let Some(bin) = &bins.jackson_sim {
        let args = vec![
            input("sim"),
            "-c".into(),
            "-n".into(),
            sim.replications.to_string(),
            "-w".into(),
            sim.warmup.to_string(),
            "-r".into(),
            sim.time.to_string(),
            "-s".into(),
            seed.to_string(),
        ];
        chain.push(solver(bin, args, output("Sim"), dir));
    }
    chain
}

/// The finite-buffer chain for one case: Spectral (`srbm_solver`, no flags), FE (`-c`), LP
/// (`--input … --solver … -c`), Sim (`-G -f … -T …` and the blocking flag).
fn finite_chain(bins: &FiniteSolvers, dir: &Path, case: usize, lp_solver: &str, blocking_flag: Option<&str>, sim: SimRun, seed: u64) -> Vec<ProcessSpec> {
    let input = |ext: &str| path_arg(dir.join(format!("case_{case}.{ext}")));
    let output = |algo: &str| dir.join(format!("out_{case}_{algo}.txt"));
    let mut chain = Vec::new();
    if let Some(bin) = &bins.srbm {
        chain.push(solver(bin, vec![input("smin")], output("Spectral"), dir));
    }
    if let Some(bin) = &bins.fm {
        chain.push(solver(bin, vec![input("fmin"), "-c".into()], output("FE"), dir));
    }
    if let Some(bin) = &bins.lp {
        let args = vec!["--input".into(), input("lpin"), "--solver".into(), lp_solver.into(), "-c".into()];
        chain.push(solver(bin, args, output("LP"), dir));
    }
    if let Some(bin) = &bins.sim {
        let mut args = vec![
            "-G".into(),
            "-f".into(),
            input("sim"),
            "-n".into(),
            sim.replications.to_string(),
            "-w".into(),
            sim.warmup.to_string(),
            "-T".into(),
            sim.time.to_string(),
            "-s".into(),
            seed.to_string(),
        ];
        args.extend(blocking_flag.map(str::to_string));
        chain.push(solver(bin, args, output("Sim"), dir));
    }
    chain
}

/// fBNAsim's blocking flag for `sim.blocking`: `-l` for Loss, `-e` for BAS + external loss,
/// nothing for BAS.
fn blocking_flag(sim_blocking: i64) -> Option<&'static str> {
    match sim_blocking {
        0 => Some("-l"),
        2 => Some("-e"),
        _ => None,
    }
}

/// The finite element mesh of a d-station case: the FE mesh setting, capped at 20, 8, 6 or 4 for
/// d < 4, 4, 5 and more (as Run Comparison caps it).
fn fe_mesh(setting: i64, d: i64) -> i64 {
    let cap = if d < 4 {
        20
    } else if d == 4 {
        8
    } else if d == 5 {
        6
    } else {
        4
    };
    setting.min(cap)
}

/// fBNAlp's solver name for `flp.solver`, clamped into range.
fn lp_solver_name(flp_solver: i64) -> &'static str {
    let names = ["highs", "glpk", "cplex"];
    names[flp_solver.clamp(0, names.len() as i64 - 1) as usize]
}

/// Writes one input, ignoring a failure as 0.90.34's `try? write(toFile:)` did (the solver then
/// finds no input and writes nothing usable).
fn write_quietly(path: PathBuf, text: Result<String, impl Sized>) {
    if let Ok(text) = text {
        let _ = fs::write(path, text);
    }
}

/// Generates one case's network (`RandomNetworkGenerator.generate`), with predictable node ids.
fn generate_network(d: i64, k: i64, infinite: bool, rho: f64, topology: Topology, seed: u64) -> Network {
    let params = generate::Parameters { stations: d, classes: k, infinite_buffers: infinite, target_rho: rho, topology, seed: Some(seed) };
    generate::generate(&params, &mut CountingIds::new())
}

/// Creates the sweep's work folder, or the refusal when it can't be.
fn create_work_dir(ctx: &RunContext, prefix: &str, sweep: Sweep) -> Result<(PathBuf, TempFiles), Vec<StatusLine>> {
    let dir = ctx.temp_path(&format!("{prefix}_{}_{}", ctx.pid, now_ms()));
    match fs::create_dir_all(&dir) {
        Ok(()) => {
            let mut temps = TempFiles::new();
            temps.add(&dir);
            Ok((dir, temps))
        }
        Err(e) => Err(vec![StatusLine::error(format!(
            "{} could not start: {}",
            sweep.display_label(),
            cocoa_write_error(&dir, &e)
        ))]),
    }
}

/// Prepares Run › Test Set for one regime (`executeTestSet(params:infinite:)` up to `runScript`):
/// checks the parameters as the sheet did, creates the work folder, draws and generates every
/// case, writes its inputs, and returns the run with its record parameters, base seed and the
/// cases' simulation seeds. `ctx` supplies the settings, solvers, temporary folder, pid and (for an
/// unfixed seed) randomness; its network is the launching tab's, which only the record keeps.
pub fn prepare_test_set(params: &TestSetParameters, infinite: bool, ctx: &RunContext) -> SweepPrepared {
    let sweep = if infinite { Sweep::InfiniteTestSet } else { Sweep::FiniteTestSet };
    if let Some(problem) = test_set_problem(params) {
        return SweepPrepared::Refused(vec![StatusLine::warning(problem)]);
    }
    let (work_dir, temps) = match create_work_dir(ctx, "BNET_testset", sweep) {
        Ok(made) => made,
        Err(lines) => return SweepPrepared::Refused(lines),
    };
    let s = &ctx.settings;
    let sim = SimRun { replications: s.sim_replications, warmup: s.sim_warmup, time: s.sim_time };
    // Run Comparison's rule: the loss correction for Loss, the BAS correction otherwise.
    let (loss, bas) = (!infinite && s.sim_blocking == 0, !infinite && s.sim_blocking != 0);
    let lp_solver = lp_solver_name(s.flp_solver);
    let topology = topology_of(params.topology);

    let base_seed = params.seed.unwrap_or_else(|| (ctx.entropy)());
    let cases = draw_test_cases(params, base_seed);
    let generated = generated_now();
    for (i, case) in cases.iter().enumerate() {
        let net = generate_network(case.d, case.k, infinite, case.rho, topology, case.network_seed);
        let (nodes, links) = (&net.nodes[..], &net.links[..]);
        let stem = |ext: &str| work_dir.join(format!("case_{i}.{ext}"));
        if infinite {
            write_quietly(stem("qna"), qna::export(nodes, links));
            write_quietly(stem("smin"), srbm_orthant::export_for_spectral(nodes, links, s.sm_degree));
            write_quietly(stem("sim"), jackson_sim::export(nodes, links));
        } else {
            let mesh = fe_mesh(s.fem_mesh_size, case.d);
            write_quietly(stem("smin"), srbm_box::export_for_spectral(nodes, links, false, s.sm_degree, loss, bas));
            write_quietly(stem("fmin"), srbm_box::export_for_finite_element(nodes, links, false, mesh, loss, bas));
            let lp = srbm_box::FiniteLpParams {
                grid_n: s.flp_grid_n,
                basis_m: s.flp_basis_m,
                grid_type: if s.flp_grid_type == 1 { "chebyshev" } else { "uniform" }.into(),
                solver: lp_solver.into(),
                output_prefix: Some(path_arg(work_dir.join(format!("case_{i}_lp")))),
                smoothness_weight: 0.0,
                basis_normalize: s.flp_basis_normalize,
            };
            write_quietly(stem("lpin"), srbm_box::export_for_finite_lp(nodes, links, &lp, loss, bas));
            write_quietly(stem("sim"), fbnasim::export(nodes, links, &generated));
        }
    }

    let infinite_bins = || InfiniteSolvers {
        bnet: find(ctx, "bnet", "BNAsm"),
        qna: find(ctx, "bna_qna", "BNAqna"),
        rqna: find(ctx, "bna_rqna", "BNArqna"),
        sbd: find(ctx, "bna_sbd", "BNAsbd"),
        jackson_sim: find(ctx, "jackson_sim", "BNAsim"),
    };
    let finite_bins = || FiniteSolvers {
        srbm: find(ctx, "srbm_solver", "fBNAsm"),
        fm: find(ctx, if s.fem_solver == 0 { "bna_fm_gauss" } else { "bna_fm_cbc" }, "fBNAfm"),
        lp: find(ctx, "fBNAlp_solver", "fBNAlp"),
        sim: find(ctx, "fBNAsim", "fBNAsim"),
    };
    let n = params.num_test_cases;
    let mut items = vec![Item::Text(test_set_header(params, infinite, base_seed))];
    let (inf, fin) = if infinite { (Some(infinite_bins()), None) } else { (None, Some(finite_bins())) };
    for (i, case) in cases.iter().enumerate() {
        let chain = match (&inf, &fin) {
            (Some(bins), _) => infinite_chain(bins, &work_dir, &format!("case_{i}"), &format!("out_{i}"), sim, case.simulation_seed),
            (_, Some(bins)) => finite_chain(bins, &work_dir, i, lp_solver, blocking_flag(s.sim_blocking), sim, case.simulation_seed),
            _ => Vec::new(),
        };
        let prefix = format!("  [{}/{n}] d={} K={} ρ={}", i + 1, case.d, case.k, cfmt::f("%.3f", case.rho));
        items.push(Item::Spinner { prefix, chain });
    }
    let table = if infinite {
        Table::TestSet { var: "Q", algorithms: &["Spectral", "QNA", "RQNA", "SBD", "Sim"] }
    } else {
        Table::TestSet { var: "X", algorithms: &["Spectral", "FE", "LP", "Sim"] }
    };

    let sd = cfmt::swift_description;
    let parameters: BTreeMap<String, String> = [
        ("capacity", if infinite { "infinite" } else { "finite" }.to_string()),
        ("cases", n.to_string()),
        ("station range", format!("{}...{}", params.stations_lower, params.stations_upper)),
        ("class range", format!("{}...{}", params.classes_lower, params.classes_upper)),
        ("rho range", format!("{}...{}", sd(params.rho_lower), sd(params.rho_upper))),
        ("topology", topology_label(params.topology).to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    SweepPrepared::Launch(PreparedSweep {
        sweep,
        parameters,
        seed: Some(base_seed),
        replication_seeds: cases.iter().map(|c| c.simulation_seed).collect(),
        before: Vec::new(),
        accepted: Vec::new(),
        body: sweep_body(Plan { items, table, work_dir: work_dir.clone() }),
        work_dir,
        temps,
    })
}

/// The test set's header block.
fn test_set_header(p: &TestSetParameters, infinite: bool, base_seed: u64) -> String {
    let mut out = String::new();
    out.push_str(&format!("{}\n", "═".repeat(66)));
    out.push_str(&format!("{} Test Set — {} cases\n", if infinite { "Infinite" } else { "Finite" }, p.num_test_cases));
    out.push_str(&format!("  Stations:  {}…{}\n", p.stations_lower, p.stations_upper));
    out.push_str(&format!("  Classes:   {}…{}\n", p.classes_lower, p.classes_upper));
    out.push_str(&format!("  ρ range:   {}…{}\n", cfmt::f("%.2f", p.rho_lower), cfmt::f("%.2f", p.rho_upper)));
    out.push_str(&format!("  Topology:  {}\n", topology_label(p.topology)));
    out.push_str(&format!("  Base seed: {base_seed}\n"));
    out.push_str("  Reference: Sim\n");
    out.push_str(&format!("{}\n", "─".repeat(66)));
    out
}

// ─── Run › Spectral Convergence ─────────────────────────────────────────────────────────────────

/// One drawn convergence case: its shape, the network seed reused at every ρ, and its simulation
/// seed.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ConvergenceCase {
    d: i64,
    k: i64,
    seed: u64,
    simulation_seed: u64,
}

fn draw_convergence_cases(p: &SpectralConvergenceParameters, base_seed: u64) -> Vec<ConvergenceCase> {
    let mut rng = SplitMix64::new(base_seed);
    (0..p.num_test_cases.max(0))
        .map(|_| {
            let d = rng.int_in_closed(p.stations_lower, p.stations_upper);
            let k = rng.int_in_closed(p.classes_lower, p.classes_upper);
            // `UInt64.random(in: UInt64.min...UInt64.max, using:)` is one whole word.
            let seed = rng.next_u64();
            let simulation_seed = rng.next_u64() & i32::MAX as u64;
            ConvergenceCase { d, k, seed, simulation_seed }
        })
        .collect()
}

/// Prepares Run › Spectral Convergence (`executeSpectralConvergence(params:)` up to
/// `runScript`): checks the parameters as the sheet did, creates the work folder, draws every
/// case, generates its network at every ρ of the grid from the same seed (so only the arrival
/// rates change), writes the inputs, and returns the run.
pub fn prepare_spectral_convergence(params: &SpectralConvergenceParameters, ctx: &RunContext) -> SweepPrepared {
    let sweep = Sweep::SpectralConvergence;
    if let Some(problem) = spectral_convergence_problem(params) {
        return SweepPrepared::Refused(vec![StatusLine::warning(problem)]);
    }
    let (work_dir, temps) = match create_work_dir(ctx, "BNET_spc", sweep) {
        Ok(made) => made,
        Err(lines) => return SweepPrepared::Refused(lines),
    };
    let s = &ctx.settings;
    let sim = SimRun { replications: s.sim_replications, warmup: s.sim_warmup, time: s.sim_time };
    let topology = topology_of(params.topology);
    let base_seed = params.seed.unwrap_or_else(|| (ctx.entropy)());
    let cases = draw_convergence_cases(params, base_seed);
    let grid = rho_values(params);
    for (i, case) in cases.iter().enumerate() {
        for (r, &rho) in grid.iter().enumerate() {
            let net = generate_network(case.d, case.k, true, rho, topology, case.seed);
            let (nodes, links) = (&net.nodes[..], &net.links[..]);
            let stem = |ext: &str| work_dir.join(format!("case_{i}_r{r}.{ext}"));
            write_quietly(stem("qna"), qna::export(nodes, links));
            write_quietly(stem("smin"), srbm_orthant::export_for_spectral(nodes, links, s.sm_degree));
            write_quietly(stem("sim"), jackson_sim::export(nodes, links));
        }
    }

    let bins = InfiniteSolvers {
        bnet: find(ctx, "bnet", "BNAsm"),
        qna: find(ctx, "bna_qna", "BNAqna"),
        rqna: None,
        sbd: None,
        jackson_sim: find(ctx, "jackson_sim", "BNAsim"),
    };
    let (n, m) = (params.num_test_cases, grid.len());
    let mut items = vec![Item::Text(convergence_header(params, m, base_seed))];
    for (i, case) in cases.iter().enumerate() {
        items.push(Item::Text(format!("  [{}/{n}] d={} K={}  ({m} ρ values)\n", i + 1, case.d, case.k)));
        for (r, &rho) in grid.iter().enumerate() {
            let chain = infinite_chain(&bins, &work_dir, &format!("case_{i}_r{r}"), &format!("out_{i}_r{r}"), sim, case.simulation_seed);
            items.push(Item::Spinner { prefix: format!("      ρ={}", cfmt::f("%.3f", rho)), chain });
        }
    }

    let sd = cfmt::swift_description;
    let parameters: BTreeMap<String, String> = [
        ("cases", n.to_string()),
        ("station range", format!("{}...{}", params.stations_lower, params.stations_upper)),
        ("class range", format!("{}...{}", params.classes_lower, params.classes_upper)),
        ("rho sweep", format!("{}...{} by {}", sd(params.rho_start), sd(params.rho_end), sd(params.rho_step))),
        ("topology", topology_label(params.topology).to_string()),
        ("spectral degree", s.sm_degree.to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    SweepPrepared::Launch(PreparedSweep {
        sweep,
        parameters,
        seed: Some(base_seed),
        replication_seeds: cases.iter().map(|c| c.simulation_seed).collect(),
        before: Vec::new(),
        accepted: Vec::new(),
        body: sweep_body(Plan { items, table: Table::Convergence { rho_values: grid }, work_dir: work_dir.clone() }),
        work_dir,
        temps,
    })
}

/// The convergence sweep's header block.
fn convergence_header(p: &SpectralConvergenceParameters, m: usize, base_seed: u64) -> String {
    let mut out = String::new();
    out.push_str(&format!("{}\n", "═".repeat(66)));
    out.push_str(&format!("Infinite Spectral Convergence — {} cases × {m} ρ values\n", p.num_test_cases));
    out.push_str(&format!("  Stations:  {}…{}\n", p.stations_lower, p.stations_upper));
    out.push_str(&format!("  Classes:   {}…{}\n", p.classes_lower, p.classes_upper));
    out.push_str(&format!(
        "  ρ sweep:   {} → {} step {}  ({m} values)\n",
        cfmt::f("%.3f", p.rho_start),
        cfmt::f("%.3f", p.rho_end),
        cfmt::f("%.3f", p.rho_step)
    ));
    out.push_str(&format!("  Topology:  {}\n", topology_label(p.topology)));
    out.push_str(&format!("  Base seed: {base_seed}\n"));
    out.push_str("  Reference: Sim   |   Baseline: QNA\n");
    out.push_str(&format!("{}\n", "─".repeat(66)));
    out
}

// ─── The run's body ──────────────────────────────────────────────────────────────────────────────

/// One piece of a sweep's script, in order.
enum Item {
    /// Text the script printed.
    Text(String),
    /// A spinner line around a chain of solvers (`testSetCaseSpinner`).
    Spinner { prefix: String, chain: Vec<ProcessSpec> },
}

/// Which aggregator ends the sweep.
enum Table {
    TestSet { var: &'static str, algorithms: &'static [&'static str] },
    Convergence { rho_values: Vec<f64> },
}

struct Plan {
    items: Vec<Item>,
    table: Table,
    work_dir: PathBuf,
}

/// How often the spinner was redrawn (`sleep 0.15`).
const SPIN_EVERY: Duration = Duration::from_millis(150);
/// How often a running solver is looked at for a redraw.
const SPIN_POLL: Duration = Duration::from_millis(50);
/// The redraw characters: `_ch='|/-\\'` read at `(_i + 1) % 4 + 1`, so the first redraw is `/`.
const SPIN: [char; 4] = ['|', '/', '-', '\\'];

/// The sweep's script as a job: the header and spinner lines, the table over every
/// `out_*.txt`, the work folder's removal (whose status is the run's), and "Elapsed time".
fn sweep_body(plan: Plan) -> RunBody {
    Box::new(move |job: &mut Job| {
        let mut last_start: Option<Instant> = None;
        for item in &plan.items {
            match item {
                Item::Text(text) => job.emit_str(text),
                Item::Spinner { prefix, chain } => match spinner(job, prefix, chain) {
                    Ok(started) => last_start = Some(started),
                    Err(code) => return code,
                },
            }
        }
        if job.is_cancelled() {
            return CANCELLED_EXIT_CODE;
        }
        let files = sweep_files(&plan.work_dir);
        let table = match &plan.table {
            Table::TestSet { var, algorithms } => test_set_table(&files, var, algorithms, "Sim"),
            Table::Convergence { rho_values } => spectral_convergence_table(&files, rho_values),
        };
        job.emit_str(&table);
        // `rm -rf "<work folder>"`, the script's last command and so its exit status.
        let _ = fs::remove_dir_all(&plan.work_dir);
        let code = if plan.work_dir.exists() { 1 } else { 0 };
        // 0.90.34's footer timed from the wrapper's `_t0`, which every spinner had reset.
        let since = last_start.map_or_else(|| job.elapsed(), |t| t.elapsed());
        job.emit_str(&elapsed_footer(since.as_secs_f64()));
        code
    })
}

/// Runs one spinner line: the prefix and `[ ]`, the chain's solvers one after another (each
/// failure ignored, as `;` did), a redraw `\r<prefix> [c]` every 0.15 s, and the last frame
/// `\r<prefix> done in X.XXs`. Returns when the chain started, or the exit status when Stop
/// interrupted it (the wrapper then died: nothing more is printed).
fn spinner(job: &mut Job, prefix: &str, chain: &[ProcessSpec]) -> Result<Instant, i32> {
    job.emit_str(&format!("{prefix} [ ]"));
    let started = Instant::now();
    let mut frames = 0u64;
    let mut next = SPIN_EVERY;
    for process in chain {
        if job.is_cancelled() {
            return Err(CANCELLED_EXIT_CODE);
        }
        let step = Step::new(process.clone());
        let mut redraw = |out: &mut JobOutput, _: &crate::supervisor::StepTick| {
            if started.elapsed() >= next {
                frames += 1;
                next += SPIN_EVERY;
                out.emit_str(&format!("\r{prefix} [{}]", SPIN[(frames % 4) as usize]));
            }
        };
        // A solver that can't be spawned is skipped, as bash's failed command was.
        if let Ok(outcome) = job.run_step_with(&step, SPIN_POLL, &mut redraw) {
            if outcome.interrupted() {
                return Err(outcome.shell_code());
            }
        }
    }
    if job.is_cancelled() {
        return Err(CANCELLED_EXIT_CODE);
    }
    job.emit_str(&format!("\r{prefix} done in {}s\n", cfmt::f("%.2f", started.elapsed().as_secs_f64())));
    Ok(started)
}

/// The work folder's `out_*.txt` files in the byte order of their names (the glob's order), as
/// the aggregators take them.
fn sweep_files(dir: &Path) -> Vec<SweepFile> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("out_") && n.ends_with(".txt") && n.len() >= "out_.txt".len())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let text = fs::read(dir.join(&name)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            SweepFile { name: format!("{}/{name}", dir.display()), text }
        })
        .collect()
}

// ─── Small things ────────────────────────────────────────────────────────────────────────────────

/// `Int(Date().timeIntervalSince1970 * 1000)`.
fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// The local time in fBNAsim's `# Generated:` form (`11/10/26, 14:11:04`): 0.90.34's short date
/// and medium time for en_US with a 24-hour clock, as `qnet-cli` writes it.
fn generated_now() -> String {
    // SAFETY: time and localtime_r write only into the values passed; tm is zeroed first.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return "unknown time".into();
        }
        format!("{}/{}/{:02}, {:02}:{:02}:{:02}", tm.tm_mon + 1, tm.tm_mday, (tm.tm_year + 1900) % 100, tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::methods::RunSettings;
    use crate::resolver::{Resolver, ResolverConfig};

    fn spc(start: f64, end: f64, step: f64) -> SpectralConvergenceParameters {
        SpectralConvergenceParameters { rho_start: start, rho_end: end, rho_step: step, ..Default::default() }
    }

    #[test]
    fn the_rho_grid_includes_the_end_and_appends_it_when_a_step_falls_short() {
        let g = rho_values(&spc(0.50, 0.95, 0.05));
        assert_eq!(g.len(), 10);
        assert_eq!(g[0], 0.5);
        assert_eq!(*g.last().unwrap(), 0.95);
        assert_eq!(rho_values(&spc(0.5, 0.7, 0.1)).len(), 3);
        // 0.5, 0.65, then 0.8 > 0.7: the end is appended.
        assert_eq!(rho_values(&spc(0.5, 0.7, 0.15)), vec![0.5, 0.65, 0.7]);
        assert_eq!(rho_values(&spc(0.5, 0.7, 0.0)), vec![0.5]);
        assert_eq!(rho_values(&spc(0.5, 0.7, 1e-10)), vec![0.5]);
        assert!(rho_values(&spc(0.8, 0.7, 0.05)).is_empty(), "the sheet refuses this; the grid is empty");
    }

    #[test]
    fn the_test_set_checks_give_the_sheets_sentences_in_row_order() {
        let ok = TestSetParameters::default();
        assert_eq!(test_set_problem(&ok), None);
        let with = |f: fn(&mut TestSetParameters)| {
            let mut p = ok.clone();
            f(&mut p);
            test_set_problem(&p)
        };
        assert_eq!(with(|p| p.stations_upper = 33), Some("Stations must be between 1 and 32."));
        assert_eq!(with(|p| p.stations_lower = 0), Some("Stations must be between 1 and 32."));
        assert_eq!(with(|p| p.stations_lower = 7), Some("Minimum stations must not exceed the maximum."));
        assert_eq!(with(|p| p.classes_upper = 17), Some("Customer classes must be between 1 and 16."));
        assert_eq!(with(|p| p.classes_lower = 4), Some("Minimum classes must not exceed the maximum."));
        assert_eq!(with(|p| p.rho_lower = 0.0), Some("ρ must lie strictly between 0 and 1."));
        assert_eq!(with(|p| p.rho_upper = 1.0), Some("ρ must lie strictly between 0 and 1."));
        assert_eq!(with(|p| p.rho_upper = f64::NAN), Some("ρ must lie strictly between 0 and 1."));
        assert_eq!(with(|p| p.rho_lower = 0.9), Some("Minimum ρ must not exceed the maximum."));
        assert_eq!(with(|p| p.num_test_cases = 0), Some("Test cases must be between 1 and 1000."));
        assert_eq!(with(|p| p.num_test_cases = 1001), Some("Test cases must be between 1 and 1000."));
        // The first problem in row order wins.
        assert_eq!(with(|p| { p.stations_lower = 7; p.num_test_cases = 0 }), Some("Minimum stations must not exceed the maximum."));
    }

    #[test]
    fn the_convergence_checks_give_the_sheets_sentences_in_row_order() {
        let ok = SpectralConvergenceParameters::default();
        assert_eq!(spectral_convergence_problem(&ok), None);
        let sweep = Some("ρ sweep needs 0 < start < end < 1 and 0 < step ≤ end − start.");
        assert_eq!(spectral_convergence_problem(&spc(0.0, 0.9, 0.1)), sweep);
        assert_eq!(spectral_convergence_problem(&spc(0.9, 0.9, 0.1)), sweep);
        assert_eq!(spectral_convergence_problem(&spc(0.5, 1.0, 0.1)), sweep);
        assert_eq!(spectral_convergence_problem(&spc(0.5, 0.9, 0.0)), sweep);
        assert_eq!(spectral_convergence_problem(&spc(0.5, 0.6, 0.2)), sweep);
        assert_eq!(spectral_convergence_problem(&spc(0.5, 0.6, 0.1)), None, "a step of exactly end − start");
        let mut p = ok.clone();
        p.num_test_cases = 201;
        assert_eq!(spectral_convergence_problem(&p), Some("Test cases must be between 1 and 200."));
        p.classes_lower = 0;
        assert_eq!(spectral_convergence_problem(&p), Some("Customer classes must be between 1 and 16."));
    }

    #[test]
    fn the_sheets_open_with_the_stored_test_set_settings() {
        let s = TestSetSettings::default();
        let inf = load_test_set_defaults(&s, true);
        assert_eq!(inf, TestSetParameters::default());
        let fin = load_test_set_defaults(&s, false);
        assert_eq!((fin.stations_lower, fin.stations_upper, fin.classes_upper, fin.num_test_cases), (2, 4, 2, 10));
        assert_eq!(load_spectral_convergence_defaults(&s), SpectralConvergenceParameters::default());
        // An unknown stored topology opens as feed-forward.
        let odd = TestSetSettings { fin_topology: 9, spc_topology: 3, ..TestSetSettings::default() };
        assert_eq!(load_test_set_defaults(&odd, false).topology, 0);
        assert_eq!(load_spectral_convergence_defaults(&odd).topology, 3);
        assert_eq!(topology_label(3), "re-entrant");
        assert_eq!(topology_label(1), "Jackson + feedback");
        assert_eq!(topology_label(2), "general P-matrix");
        assert_eq!(topology_label(-1), "feed-forward");
    }

    #[test]
    fn the_finite_chain_passes_the_blocking_flag_mesh_and_lp_solver_as_0_90_34_did() {
        let dir = Path::new("/w");
        let bins = FiniteSolvers {
            srbm: Some("/b/srbm_solver".into()),
            fm: Some("/b/bna_fm_gauss".into()),
            lp: Some("/b/fBNAlp_solver".into()),
            sim: Some("/b/fBNAsim".into()),
        };
        let sim = SimRun { replications: 8, warmup: 10_000, time: 200_000 };
        let argv = |c: &[ProcessSpec]| -> Vec<Vec<String>> {
            c.iter().map(|p| p.args.iter().map(|a| a.to_string_lossy().into_owned()).collect()).collect()
        };
        let chain = finite_chain(&bins, dir, 2, "glpk", blocking_flag(0), sim, 77);
        assert_eq!(
            argv(&chain),
            vec![
                vec!["/w/case_2.smin".to_string()],
                vec!["/w/case_2.fmin".into(), "-c".into()],
                vec!["--input".into(), "/w/case_2.lpin".into(), "--solver".into(), "glpk".into(), "-c".into()],
                vec!["-G", "-f", "/w/case_2.sim", "-n", "8", "-w", "10000", "-T", "200000", "-s", "77", "-l"].into_iter().map(String::from).collect(),
            ]
        );
        assert_eq!(chain[3].stdout, crate::supervisor::StdoutTarget::File("/w/out_2_Sim.txt".into()));
        assert_eq!(chain[0].stderr, StderrTarget::Null);
        assert_eq!(chain[0].cwd.as_deref(), Some(dir));
        assert_eq!(argv(&finite_chain(&bins, dir, 0, "highs", blocking_flag(2), sim, 1))[3].last().unwrap(), "-e");
        assert_eq!(argv(&finite_chain(&bins, dir, 0, "highs", blocking_flag(1), sim, 1))[3].last().unwrap(), "1");
        // A missing solver is skipped.
        let some = FiniteSolvers { fm: None, lp: None, ..bins.clone() };
        assert_eq!(finite_chain(&some, dir, 0, "highs", None, sim, 1).len(), 2);
        assert_eq!([fe_mesh(10, 3), fe_mesh(10, 4), fe_mesh(10, 5), fe_mesh(10, 6), fe_mesh(30, 2), fe_mesh(5, 9)], [10, 8, 6, 4, 20, 4]);
        assert_eq!([lp_solver_name(0), lp_solver_name(1), lp_solver_name(2), lp_solver_name(7), lp_solver_name(-1)], ["highs", "glpk", "cplex", "cplex", "highs"]);
    }

    #[test]
    fn the_infinite_chain_runs_spectral_qna_rqna_sbd_and_sim_in_order() {
        let dir = Path::new("/w");
        let bins = InfiniteSolvers {
            bnet: Some("/b/bnet".into()),
            qna: Some("/b/bna_qna".into()),
            rqna: Some("/b/bna_rqna".into()),
            sbd: Some("/b/bna_sbd".into()),
            jackson_sim: Some("/b/jackson_sim".into()),
        };
        let sim = SimRun { replications: 8, warmup: 10_000, time: 200_000 };
        let chain = infinite_chain(&bins, dir, "case_1_r2", "out_1_r2", sim, 5);
        let programs: Vec<String> = chain.iter().map(|p| p.program.to_string_lossy().into_owned()).collect();
        assert_eq!(programs, ["/b/bnet", "/b/bna_qna", "/b/bna_rqna", "/b/bna_sbd", "/b/jackson_sim"]);
        let args: Vec<String> = chain[0].args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["-c", "/w/case_1_r2.smin"]);
        let args: Vec<String> = chain[4].args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["/w/case_1_r2.sim", "-c", "-n", "8", "-w", "10000", "-r", "200000", "-s", "5"]);
        assert_eq!(chain[2].stdout, crate::supervisor::StdoutTarget::File("/w/out_1_r2_RQNA.txt".into()));
    }

    #[test]
    fn the_cases_are_drawn_from_the_base_seed_as_the_golden_run_shows() {
        // golden/runs/_testsets/testset-infinite: base seed 20261110, three cases.
        let p = TestSetParameters { stations_lower: 2, stations_upper: 3, classes_lower: 1, classes_upper: 2, num_test_cases: 3, seed: Some(20261110), ..Default::default() };
        let cases = draw_test_cases(&p, 20261110);
        let seeds: Vec<u64> = cases.iter().map(|c| c.simulation_seed).collect();
        assert_eq!(seeds, [1075694873, 2048619053, 1213253945]);
        assert_eq!((cases[0].d, cases[0].k), (3, 1));
        assert_eq!(cases[0].rho.to_bits(), 0.7360691729145132f64.to_bits());
        let c = SpectralConvergenceParameters { stations_lower: 2, stations_upper: 3, classes_lower: 1, classes_upper: 1, num_test_cases: 2, ..Default::default() };
        let seeds: Vec<u64> = draw_convergence_cases(&c, 20261112).iter().map(|c| c.simulation_seed).collect();
        assert_eq!(seeds, [1419347312, 993486962]);
    }

    fn context(temp: &Path) -> RunContext {
        let network = qnet_core::bnet::read(r#"{"nodes":[],"links":[]}"#).expect("empty network");
        let mut cfg = ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.development_roots = Vec::new();
        cfg.env.insert("QNET_SOLVER_ROOT".into(), temp.as_os_str().to_owned());
        let mut ctx = RunContext::new(network, "Untitled", RunSettings::golden(), Arc::new(Resolver::new(cfg)));
        ctx.temp_dir = temp.to_path_buf();
        ctx
    }

    #[test]
    fn a_sweep_whose_work_folder_cannot_be_made_is_refused() {
        let base = std::env::temp_dir().join(format!("qnet-testset-unit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // The temporary "folder" is a file, so nothing can be made inside it.
        let file = base.join("not-a-folder");
        fs::write(&file, "x").unwrap();
        let mut ctx = context(&base);
        ctx.temp_dir = file;
        let p = TestSetParameters { num_test_cases: 1, seed: Some(1), ..Default::default() };
        let SweepPrepared::Refused(lines) = prepare_test_set(&p, true, &ctx) else { panic!("launched") };
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].severity, crate::supervisor::Severity::Error);
        assert!(lines[0].text.starts_with("Test Set could not start: The file “BNET_testset_"), "{}", lines[0].text);
        let c = SpectralConvergenceParameters { num_test_cases: 1, seed: Some(1), ..Default::default() };
        let SweepPrepared::Refused(lines) = prepare_spectral_convergence(&c, &ctx) else { panic!("launched") };
        assert!(lines[0].text.starts_with("Spectral Convergence could not start: "), "{}", lines[0].text);
        let _ = fs::remove_dir_all(&base);
    }
}
