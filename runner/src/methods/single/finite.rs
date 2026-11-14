//! The finite-buffer single-method runs of the Run menu: Run Spectral Method… (`sm`, the SRBM
//! Galerkin solver `finite/fBNAsm/srbm_solver`), Run Finite Element… (`fm`, `finite/fBNAfm/
//! bna_fm_gauss` or `bna_fm_cbc`) and Run Monte Carlo… (`sim`, the discrete-event simulator
//! `finite/fBNAsim/fBNAsim`). A port of `runSpectralMethod` and `runSpectralMethod(degree:
//! useLegendre:)`, `runFiniteElement` and `runFiniteElement(useGauss:meshSize:)`, and
//! `runSimulation` in `2_QNET/Sources/Qnet/QnetGUIApp.swift`, with the helpers they called
//! (`findBinary`, `findFBNAsimBinary`, `progressFilePath`, `runWithStderrOnFailure`,
//! `withProgress`, `threadCountBanner`, `singleMethodFormatCmd` with `regimeHeader`,
//! `tractabilityHeader` and `writeAnalyticalFile`, and `silentScript`; ledger METH-095…097,
//! METH-107, METH-108, METH-110, METH-111, RUN-014).
//!
//! The three ran the same way in 0.90.34. The pre-checks come first, each refusing with its own
//! Status sentence: the solver is looked up with `findBinary`, which drops the resolver's
//! diagnostic and gives a fixed "Could not locate the <name> binary. Make sure it is compiled (run
//! 'make' in the <dir> directory)." detail instead (RUN-014, kept); the exporter's refusal is
//! "<Method> aborted: <reason>"; a failed write is "<Method> aborted: could not write temp file."
//! with the reason as detail. The order differs by method, as it did: the simulation exports
//! first and looks for its binary second, the other two look for the binary first. The input is
//! written to `BNET_network_<pid>.txt` (fBNAsim's text, `qnet_core::export::fbnasim`),
//! `BNET_fm_<pid>.in` (the grouped box file, `srbm_box::export_for_finite_element`) or
//! `BNET_sm_<pid>.in` (the interleaved box file, `srbm_box::export_for_spectral`).
//!
//! Then the parameter sheet. The sheet itself is P6; as in the golden corpus, which pressed Run at
//! once, a run here takes the sheet's initial values, which are the stored settings: `sm.degree`
//! and `sm.legendre`; `fem.solver` and `fem.meshSize` capped by the station count d (20 below 4
//! stations, 8 at 4, 6 at 5, 4 from 6 on); and the `sim.*` blocking, parallelism, replications,
//! warm-up, time and seed. The answer is read as `onRun` read it: degree and mesh at least 2,
//! replications and time at least 1, warm-up and entered seed at least 0, and an unfixed seed drawn
//! from 1…2,147,483,647 (from the system's randomness, not Swift's generator: it is meant to differ
//! from run to run). The simulation's replication seeds are recorded as base + k/2, k = 0…n−1.
//!
//! The run is `silentScript`'s command: the thread banner ("[Threads] Using N CPU cores
//! (OpenMP)"), the solver with `-G -P <progress file>` under the Shell's progress bar
//! (`shell::run_with_progress`, which reads the solver's own `-P` file) and the stderr policy of
//! `runWithStderrOnFailure`, then, only if the solver exited 0, a blank line, the single-method
//! table (the regime lines, the tractability line, and the comparison table with one column over
//! the rho, Gamma, sojourn and E[X_k] rows, beside the exact or asymptotic column when the network
//! is tractable) and "Elapsed time". On a non-zero exit the `&&` chain stopped after the bar: the
//! failure text ("⚠ <Label> failed (exit N):" and the solver's stderr) is shown before the bar's
//! last frame, and nothing follows it. The record's parameters, seeds, Status sentences and labels
//! are 0.90.34's; none of these runs records a "runtime" parameter.
//!
//! Where 2.0 differs, deliberately:
//!
//! - D1: each solver is started as an argument vector by the supervisor. Its standard output is
//!   captured instead of going to `BNET_<sim|fm|sm>_out_<pid>.txt`, the table is Rust text
//!   (`qnet_core::output::table`, RUN-066 Changed) instead of an awk program, and the analytical
//!   column comes from `qnet_core::output::table::analytical_file` instead of
//!   `BNET_analytical_<pid>.txt`.
//! - The input is registered with the run's temporary-file guard and removed however the run ends,
//!   including a refused launch; 0.90.34 left the inputs and outputs of all three in the temporary
//!   folder, and wrote the simulation's input before its sheet opened (RUN-021, Changed).
//! - The progress file goes in the run's temporary folder (`RunContext::temp_dir`), beside the
//!   input, where 0.90.34 also put it; its name is the supervisor's (`BNET_progress_<label>_<pid>_
//!   <µs>.bin`, the label `fin_sim`, `fin_fe` or `fin_sm` as before).
//! - fBNAsim's `# Generated:` comment line, which the simulator ignores, is the corpus's form (an
//!   en_US short date and a 24-hour medium time); 0.90.34 wrote it in the Mac's own locale.
//! - A solver that resolved but cannot be started is logged as "<Label> could not start: <error>"
//!   with exit status −1 (the supervisor's `could_not_start`); 0.90.34's bash would have reported
//!   exit 126 or 127 through the stderr policy instead.

use std::ffi::OsString;
use std::path::PathBuf;

use qnet_core::export::{fbnasim, srbm_box};
use qnet_core::model::NodeKind;
use qnet_core::output::banner::{regime_lines, table_banner, thread_count_banner, tractability_line};
use qnet_core::output::table::{analytical_file, comparison_table, TableSpec, VarName};

use crate::methods::exact::{blocked, parameters, write_input};
use crate::methods::shell::run_with_progress;
use crate::methods::{Method, Prepared, PreparedRun, RunBody, RunContext, RunSettings, StatusLine};
use crate::supervisor::{Job, ProcessSpec, Severity, Step, TempFiles};

/// Prepares one of the three finite-buffer single-method runs with the sheet's initial values.
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    match method {
        Method::FiniteSpectral => spectral(ctx, &SpectralSheet::initial(&ctx.settings)),
        Method::FiniteElement => finite_element(ctx, &FiniteElementSheet::initial(ctx)),
        Method::FiniteMonteCarlo => simulation(ctx, &SimulationSheet::initial(&ctx.settings)),
        _ => crate::methods::unimplemented_method(method),
    }
}

// ─── The parameter sheets' answers ──────────────────────────────────────────────────────────────

/// What the Run Spectral Method sheet (finite buffers) answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SpectralSheet {
    /// Polynomial degree (`RunKey.degree`).
    pub degree: i64,
    /// Use the Legendre basis (`RunKey.legendre`), for this run only.
    pub legendre: bool,
}

impl SpectralSheet {
    /// The sheet's initial values (`RunParameterSpec.spectralFinite(degree:legendre:)`): `sm.degree`
    /// and `sm.legendre`.
    pub(crate) fn initial(settings: &RunSettings) -> Self {
        SpectralSheet { degree: settings.sm_degree, legendre: settings.sm_legendre }
    }
}

/// What the Run Finite Element sheet answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FiniteElementSheet {
    /// 0 = Gauss–Legendre (`bna_fm_gauss`), anything else = CBC quasi-Monte Carlo (`bna_fm_cbc`).
    pub quadrature: i64,
    /// Mesh size per dimension (`RunKey.mesh`).
    pub mesh: i64,
}

impl FiniteElementSheet {
    /// The sheet's initial values (`runFiniteElement()`): `fem.solver`, and `fem.meshSize` capped
    /// by the network's station count ([`mesh_cap`]).
    pub(crate) fn initial(ctx: &RunContext) -> Self {
        let stations = ctx.network.nodes_of(NodeKind::Station).count();
        // A mesh typed into the sheet (`RunSettings::sheet`) is taken as typed: the cap only seeds it.
        let mesh = ctx.settings.sheet_i64("fem.meshSize").unwrap_or_else(|| ctx.settings.fem_mesh_size.min(mesh_cap(stations)));
        FiniteElementSheet { quadrature: ctx.settings.fem_solver, mesh }
    }
}

/// The finite-element mesh the sheet suggests at most, by station count d: no effective cap below
/// 4 (20), 8 at d = 4, 6 at d = 5 and 4 from d = 6 on, because the method's cost grows as n^2d.
/// It only seeds the sheet; the sheet accepts up to 40 (METH-110).
pub(crate) fn mesh_cap(stations: usize) -> i64 {
    match stations {
        0..=3 => 20,
        4 => 8,
        5 => 6,
        _ => 4,
    }
}

/// What the Run Monte Carlo sheet (finite buffers) answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SimulationSheet {
    /// 0 = loss, 2 = BAS + external loss, anything else = BAS.
    pub blocking: i64,
    /// 0 = Apple GCD, 1 = OpenMP, anything else = sequential.
    pub parallel: i64,
    pub replications: i64,
    pub warmup: i64,
    pub sim_time: i64,
    pub seed_fixed: bool,
    pub seed: i64,
}

impl SimulationSheet {
    /// The sheet's initial values (`RunParameterSpec.monteCarloFinite`): the `sim.*` settings.
    pub(crate) fn initial(settings: &RunSettings) -> Self {
        SimulationSheet {
            blocking: settings.sim_blocking,
            parallel: settings.sim_parallel,
            replications: settings.sim_replications,
            warmup: settings.sim_warmup,
            sim_time: settings.sim_time,
            seed_fixed: settings.sim_seed_fixed,
            seed: settings.sim_seed,
        }
    }
}

// ─── The three methods ──────────────────────────────────────────────────────────────────────────

/// The `findBinary` refusal detail, which replaces the resolver's diagnostic (RUN-014).
fn not_compiled(name: &str, dir: &str) -> String {
    format!("Could not locate the {name} binary. Make sure it is compiled (run 'make' in the {dir} directory).")
}

/// `findBinary(name:subdirectory:)`: the resolved solver's path, or `None`.
fn find_binary(ctx: &RunContext, name: &str, subdirectory: &str) -> Option<PathBuf> {
    ctx.resolver.resolve_executable(name, subdirectory).url().map(|p| p.to_path_buf())
}

/// `runSpectralMethod(degree:useLegendre:)`, with the sheet's answer.
pub(crate) fn spectral(ctx: &RunContext, sheet: &SpectralSheet) -> Prepared {
    let mut lines = Vec::new();
    // `runSpectralMethod()`'s `onRun`.
    let degree = sheet.degree.max(2);
    let legendre = sheet.legendre;
    let Some(binary) = find_binary(ctx, "srbm_solver", "fBNAsm") else {
        blocked(
            &mut lines,
            "Spectral method aborted: srbm_solver binary not found.",
            Some(&not_compiled("srbm_solver", "fBNAsm")),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let net = &ctx.network;
    let content = match srbm_box::export_for_spectral(&net.nodes, &net.links, net.infinite_buffers, degree, false, false) {
        Ok(content) => content,
        Err(e) => {
            blocked(&mut lines, &format!("Spectral method aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let input = match write_input(ctx, &format!("BNET_sm_{}.in", ctx.pid), &content, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(&mut lines, "Spectral method aborted: could not write temp file.", Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let command = Command {
        program: binary,
        before_progress: vec![input.into_os_string(), "-G".into()],
        after_progress: if legendre { vec!["-L".into()] } else { Vec::new() },
    };
    let basis_label = if legendre { ", Legendre" } else { "" };
    Prepared::Launch(PreparedRun {
        method: Method::FiniteSpectral,
        parameters: parameters(&[
            ("polynomial degree", &degree.to_string()),
            ("basis", if legendre { "Legendre" } else { "monomial" }),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running spectral method (degree={degree}{basis_label})..."))],
        temps,
        body: body(ctx, Wrapper::SPECTRAL, command),
    })
}

/// `runFiniteElement(useGauss:meshSize:)`, with the sheet's answer.
pub(crate) fn finite_element(ctx: &RunContext, sheet: &FiniteElementSheet) -> Prepared {
    let mut lines = Vec::new();
    // `runFiniteElement()`'s `onRun`.
    let use_gauss = sheet.quadrature == 0;
    let mesh = sheet.mesh.max(2);
    let name = if use_gauss { "bna_fm_gauss" } else { "bna_fm_cbc" };
    let Some(binary) = find_binary(ctx, name, "fBNAfm") else {
        blocked(
            &mut lines,
            &format!("Finite element aborted: {name} binary not found."),
            Some(&not_compiled(name, "fBNAfm")),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let net = &ctx.network;
    let content = match srbm_box::export_for_finite_element(&net.nodes, &net.links, net.infinite_buffers, mesh, false, false) {
        Ok(content) => content,
        Err(e) => {
            blocked(&mut lines, &format!("Finite element aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let input = match write_input(ctx, &format!("BNET_fm_{}.in", ctx.pid), &content, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(&mut lines, "Finite element aborted: could not write temp file.", Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let command =
        Command { program: binary, before_progress: vec![input.into_os_string(), "-G".into()], after_progress: Vec::new() };
    let quadrature = if use_gauss { "Gauss-Legendre" } else { "CBC QMC" };
    Prepared::Launch(PreparedRun {
        method: Method::FiniteElement,
        parameters: parameters(&[("quadrature", quadrature), ("mesh per dimension", &mesh.to_string())]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running finite element ({quadrature}, mesh={mesh})..."))],
        temps,
        body: body(ctx, Wrapper::FINITE_ELEMENT, command),
    })
}

/// `runSimulation`, with the sheet's answer.
pub(crate) fn simulation(ctx: &RunContext, sheet: &SimulationSheet) -> Prepared {
    let mut lines = Vec::new();
    let net = &ctx.network;
    let content = match fbnasim::export(&net.nodes, &net.links, &generated_now()) {
        Ok(content) => content,
        Err(e) => {
            blocked(&mut lines, &format!("Simulation aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let Some(binary) = find_binary(ctx, "fBNAsim", "fBNAsim") else {
        blocked(
            &mut lines,
            "Simulation aborted: fBNAsim binary not found.",
            Some(&not_compiled("fBNAsim", "fBNAsim")),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let mut temps = TempFiles::new();
    let input = match write_input(ctx, &format!("BNET_network_{}.txt", ctx.pid), &content, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(&mut lines, "Simulation aborted: could not write temp file.", Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    };

    // The sheet's `onRun`.
    let replications = sheet.replications.max(1);
    let warmup = sheet.warmup.max(0);
    let sim_time = sheet.sim_time.max(1);
    let fixed_seed = sheet.seed_fixed;
    let entered_seed = sheet.seed.max(0);
    let base_seed: i64 = if fixed_seed { entered_seed } else { ctx.random_in(1, i32::MAX as u64) as i64 };
    let parallel_flag: Option<&str> = match sheet.parallel {
        0 => Some("-a"), // Apple GCD
        1 => Some("-o"), // OpenMP
        _ => None,       // sequential
    };
    let (blocking_flag, blocking): (Option<&str>, &str) = match sheet.blocking {
        0 => (Some("-l"), "loss"),
        2 => (Some("-e"), "BAS+ext-loss"),
        _ => (None, "BAS"),
    };
    let mut before_progress: Vec<OsString> = vec!["-f".into(), input.into_os_string(), "-G".into()];
    for (flag, value) in [("-n", replications), ("-w", warmup), ("-T", sim_time), ("-s", base_seed)] {
        before_progress.push(flag.into());
        before_progress.push(value.to_string().into());
    }
    let after_progress: Vec<OsString> = parallel_flag.into_iter().chain(blocking_flag).map(OsString::from).collect();
    let command = Command { program: binary, before_progress, after_progress };
    Prepared::Launch(PreparedRun {
        method: Method::FiniteMonteCarlo,
        parameters: parameters(&[
            ("blocking", blocking),
            ("parallelism", &sheet.parallel.to_string()),
            ("replications", &replications.to_string()),
            ("warm-up", &warmup.to_string()),
            ("simulation time", &sim_time.to_string()),
            ("fixed seed", if fixed_seed { "true" } else { "false" }),
        ]),
        seed: Some(base_seed as u64),
        replication_seeds: (0..replications).map(|k| base_seed.saturating_add(k / 2) as u64).collect(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running simulation via fBNAsim ({blocking} mode)..."))],
        temps,
        body: body(ctx, Wrapper::SIMULATION, command),
    })
}

/// The local time in the `# Generated:` form the corpus shows (`11/10/26, 14:11:04`): 0.90.34's
/// short date and medium time for en_US with a 24-hour clock.
fn generated_now() -> String {
    // SAFETY: time and localtime_r write only into the values passed; tm is zeroed first.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return "unknown time".into();
        }
        format!(
            "{}/{}/{:02}, {:02}:{:02}:{:02}",
            tm.tm_mon + 1,
            tm.tm_mday,
            (tm.tm_year + 1900) % 100,
            tm.tm_hour,
            tm.tm_min,
            tm.tm_sec
        )
    }
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────────

/// The words of one method's wrapper.
#[derive(Debug, Clone, Copy)]
struct Wrapper {
    /// The progress bar's prefix (`withProgress(prefix:)`).
    prefix: &'static str,
    /// The stderr policy's label (`runWithStderrOnFailure(label:)`).
    stderr_label: &'static str,
    /// The table column's header (`singleMethodFormatCmd(methodLabel:)`).
    column: &'static str,
    /// The progress file's label (`progressFilePath(label:)`).
    progress_label: &'static str,
}

impl Wrapper {
    const SPECTRAL: Wrapper = Wrapper {
        prefix: "Running spectral method ...  ",
        stderr_label: "Spectral Method",
        column: "Spectral",
        progress_label: "fin_sm",
    };
    const FINITE_ELEMENT: Wrapper = Wrapper {
        prefix: "Running finite element method ...  ",
        stderr_label: "Finite Element",
        column: "Finite Element",
        progress_label: "fin_fe",
    };
    const SIMULATION: Wrapper = Wrapper {
        prefix: "Running simulation ...  ",
        stderr_label: "Simulation",
        column: "Simulation",
        progress_label: "fin_sim",
    };
}

/// The solver's argument vector around its `-P <progress file>` pair, which only exists once the
/// run has been accepted.
struct Command {
    program: PathBuf,
    before_progress: Vec<OsString>,
    after_progress: Vec<OsString>,
}

impl Command {
    fn spec(&self, progress: &std::path::Path) -> ProcessSpec {
        ProcessSpec::new(&self.program)
            .args(self.before_progress.iter().cloned())
            .arg("-P")
            .arg(progress)
            .args(self.after_progress.iter().cloned())
    }
}

/// What `singleMethodFormatCmd(methodLabel:, varName: "X", showGamma: true, showSojourn: true,
/// showXClass: false)` read from the tab when the command was built.
struct TableText {
    column: &'static str,
    /// The regime lines and the tractability line, each with its newline.
    banner: String,
    analytical: Option<String>,
    analytical_label: String,
    analytical_is_exact: bool,
    decimals: i64,
}

impl TableText {
    fn for_context(ctx: &RunContext, column: &'static str) -> TableText {
        let net = &ctx.network;
        let flags = ctx.flags();
        let tractable = flags.as_ref().is_some_and(|f| f.is_analytically_tractable);
        let detail = flags.as_ref().map(|f| f.tractability_detail.clone()).unwrap_or_default();
        let means = flags.as_ref().map(|f| f.tractability_means.clone()).unwrap_or_default();
        let regime = regime_lines(&net.nodes, &net.links, net.infinite_buffers);
        let banner = table_banner(&regime, tractability_line(tractable, &detail).as_deref());
        let data = ctx.analysis_data();
        TableText {
            column,
            banner,
            analytical: analytical_file(tractable, &means, data.as_ref(), VarName::X),
            analytical_label: flags.as_ref().map(|f| f.tractability_means_label.clone()).unwrap_or_default(),
            analytical_is_exact: flags.as_ref().is_some_and(|f| f.tractability_is_exact),
            decimals: ctx.settings.output_decimals,
        }
    }

    fn render(&self, solver_output: &str) -> String {
        let spec = TableSpec::single(
            self.column,
            solver_output,
            VarName::X,
            self.analytical.clone(),
            Some(self.analytical_label.clone()),
            self.analytical_is_exact,
            self.decimals,
        );
        format!("{}{}", self.banner, comparison_table(&spec))
    }
}

/// The run: `threadCountBanner(parallel: true) && <solver under the progress bar> && echo &&
/// <table> && <Elapsed time>`. The exit status is the solver's.
fn body(ctx: &RunContext, wrapper: Wrapper, command: Command) -> RunBody {
    let banner = format!("{}\n", thread_count_banner(true, ctx.cpu_count));
    let table = TableText::for_context(ctx, wrapper.column);
    let temp_dir = ctx.temp_dir.clone();
    Box::new(move |job: &mut Job| {
        job.set_temp_dir(temp_dir);
        job.emit_str(&banner);
        let progress = job.progress_file(wrapper.progress_label);
        let step = Step::new(command.spec(&progress)).stderr_policy(wrapper.stderr_label).progress(&progress).quiet();
        let outcome = match run_with_progress(job, wrapper.prefix, &step) {
            Ok(outcome) => outcome,
            Err(e) => {
                let message = format!("{} could not start: {e}", job.display_label());
                job.could_not_start(message);
                return -1;
            }
        };
        let code = outcome.shell_code();
        if outcome.interrupted() || code != 0 {
            // `( exit $_rc ) && …`: the chain ends after the bar.
            return code;
        }
        job.emit_str("\n");
        job.emit_str(&table.render(&String::from_utf8_lossy(&outcome.stdout)));
        job.emit_elapsed_footer();
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::methods::exact::MM1_INFINITE;
    use crate::resolver::{Resolver, ResolverConfig};

    /// The M/M/1/K network in finite-buffer mode.
    fn mm1k() -> String {
        MM1_INFINITE.replace(r#""infiniteBuffers":true"#, r#""infiniteBuffers":false"#)
    }

    /// A context over `json` whose resolver finds nothing (an empty solver tree).
    fn context(json: &str, tag: &str) -> RunContext {
        let network = qnet_core::bnet::read(json).expect("network");
        let empty = std::env::temp_dir().join(format!("qnet-single-finite-unit-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let mut cfg = ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.development_roots = Vec::new();
        cfg.env.insert("QNET_SOLVER_ROOT".into(), empty.clone().into_os_string());
        cfg.current_dir = empty.clone();
        cfg.executable_dir = Some(empty.clone());
        let mut ctx = RunContext::new(network, "unit.bnet", RunSettings::golden(), Arc::new(Resolver::new(cfg)));
        ctx.temp_dir = empty;
        ctx
    }

    fn refused(p: Prepared) -> Vec<StatusLine> {
        match p {
            Prepared::Refused(lines) => lines,
            Prepared::Launch(run) => panic!("launched: {run:?}"),
        }
    }

    #[test]
    fn the_mesh_cap_follows_the_station_count() {
        assert_eq!([0, 1, 2, 3, 4, 5, 6, 7, 20].map(mesh_cap), [20, 20, 20, 20, 8, 6, 4, 4, 4]);
    }

    #[test]
    fn a_mesh_typed_into_the_finite_element_sheet_is_taken_above_the_cap() {
        let mut ctx = context(&mm1k(), "sheet-answer");
        ctx.settings.fem_mesh_size = 30;
        assert_eq!(FiniteElementSheet::initial(&ctx).mesh, 20);
        ctx.settings.sheet.insert("fem.meshSize".into(), "30".into());
        assert_eq!(FiniteElementSheet::initial(&ctx).mesh, 30);
    }

    #[test]
    fn the_sheets_start_from_the_stored_settings_and_the_mesh_from_its_cap() {
        let mut ctx = context(&mm1k(), "sheets");
        ctx.settings.fem_mesh_size = 30;
        ctx.settings.fem_solver = 1;
        assert_eq!(FiniteElementSheet::initial(&ctx), FiniteElementSheet { quadrature: 1, mesh: 20 });
        ctx.settings.fem_mesh_size = 7;
        assert_eq!(FiniteElementSheet::initial(&ctx).mesh, 7);
        ctx.settings.sm_degree = 12;
        ctx.settings.sm_legendre = true;
        assert_eq!(SpectralSheet::initial(&ctx.settings), SpectralSheet { degree: 12, legendre: true });
        let sim = SimulationSheet::initial(&RunSettings::golden());
        assert_eq!(
            sim,
            SimulationSheet { blocking: 2, parallel: 2, replications: 8, warmup: 10_000, sim_time: 200_000, seed_fixed: true, seed: 12_345 }
        );
    }

    #[test]
    fn a_missing_solver_gives_the_fixed_make_sentence_not_the_resolvers_diagnostic() {
        let ctx = context(&mm1k(), "missing");
        assert_eq!(
            refused(prepare(Method::FiniteSpectral, &ctx)),
            vec![
                StatusLine::error("Spectral method aborted: srbm_solver binary not found."),
                StatusLine::info("    Could not locate the srbm_solver binary. Make sure it is compiled (run 'make' in the fBNAsm directory)."),
            ]
        );
        assert_eq!(
            refused(prepare(Method::FiniteElement, &ctx)),
            vec![
                StatusLine::error("Finite element aborted: bna_fm_gauss binary not found."),
                StatusLine::info("    Could not locate the bna_fm_gauss binary. Make sure it is compiled (run 'make' in the fBNAfm directory)."),
            ]
        );
        assert_eq!(
            refused(finite_element(&ctx, &FiniteElementSheet { quadrature: 1, mesh: 10 })),
            vec![
                StatusLine::error("Finite element aborted: bna_fm_cbc binary not found."),
                StatusLine::info("    Could not locate the bna_fm_cbc binary. Make sure it is compiled (run 'make' in the fBNAfm directory)."),
            ]
        );
        assert_eq!(
            refused(prepare(Method::FiniteMonteCarlo, &ctx)),
            vec![
                StatusLine::error("Simulation aborted: fBNAsim binary not found."),
                StatusLine::info("    Could not locate the fBNAsim binary. Make sure it is compiled (run 'make' in the fBNAsim directory)."),
            ]
        );
        let left: Vec<_> = std::fs::read_dir(&ctx.temp_dir).unwrap().collect();
        assert!(left.is_empty(), "{left:?}");
        let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    }

    #[test]
    fn the_simulation_refuses_its_exporters_reason_before_looking_for_its_binary() {
        // No sink: fBNAsim's exporter refuses before the (absent) binary is looked for.
        let mut net = qnet_core::bnet::read(&mm1k()).unwrap();
        net.nodes.retain(|n| n.kind != NodeKind::Sink);
        let json = qnet_core::bnet::write(&net);
        let ctx = context(&json, "no-sink");
        assert_eq!(refused(prepare(Method::FiniteMonteCarlo, &ctx)), vec![StatusLine::error("Simulation aborted: The network has no sink node.")]);
        let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    }

    #[test]
    fn the_box_methods_look_for_their_binary_before_exporting() {
        // A network the box exporters refuse, over an empty tree: the binary sentence wins.
        let mut net = qnet_core::bnet::read(&mm1k()).unwrap();
        net.nodes.retain(|n| n.kind != NodeKind::Station);
        let json = qnet_core::bnet::write(&net);
        let ctx = context(&json, "binary-first");
        assert_eq!(refused(prepare(Method::FiniteSpectral, &ctx))[0].text, "Spectral method aborted: srbm_solver binary not found.");
        assert_eq!(refused(prepare(Method::FiniteElement, &ctx))[0].text, "Finite element aborted: bna_fm_gauss binary not found.");
        let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    }

    #[test]
    fn the_progress_pair_sits_between_the_leading_and_trailing_arguments() {
        let command = Command {
            program: PathBuf::from("/bin/solver"),
            before_progress: vec!["in.txt".into(), "-G".into()],
            after_progress: vec!["-a".into(), "-e".into()],
        };
        let spec = command.spec(std::path::Path::new("/tmp/p.bin"));
        let args: Vec<String> = spec.args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["in.txt", "-G", "-P", "/tmp/p.bin", "-a", "-e"]);
    }

    #[test]
    fn the_generated_line_reads_as_a_short_date_and_a_24_hour_time() {
        let text = generated_now();
        let (date, time) = text.split_once(", ").expect("date, time");
        assert_eq!(date.split('/').count(), 3, "{text}");
        assert_eq!(time.len(), 8, "{text}");
        assert_eq!(time.split(':').count(), 3, "{text}");
    }
}
