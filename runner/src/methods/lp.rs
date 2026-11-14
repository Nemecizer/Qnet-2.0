//! The two linear programs of the Run menu: Run Linear Program for infinite buffers (`lp`, the
//! orthant solver `infinite/BNAlp/srbm_lp`, Saure–Glynn–Zeevi 2008) and Run Finite-Buffer LP
//! (`flp`, the box solver `finite/fBNAlp/fBNAlp_solver`). A port of `runLinearProgram` (both
//! halves) with `readLPSettings`, `presentLPParams`, `linearProgramResourceIssue`, `lpSummaryAwk`
//! and `stationIndex`, and of `runFiniteLP`, in `2_QNET/Sources/Qnet/QnetGUIApp.swift` (ledger
//! METH-074…METH-079, METH-113, METH-114, EXP-039).
//!
//! **Run Linear Program.** 0.90.34 resolved `srbm_lp`, built the workload-scaled orthant model
//! (`BNASRBMExporter.computeData`), read the `lp.*` settings (and, with `lp.askBeforeRun` on,
//! showed the parameter sheet), resolved a grid or basis size of 0 to `recommendedBNAlpGrid(d)`,
//! refused a tensor grid above two million LP columns, and then ran one stage, or two when
//! `lp.multiLevel` is on and the grid is at least 8 (a coarse preview at max(n/2, 6), then the
//! full grid). Each stage wrote `BNET_lp_<pid>_s<k>.in`, ran `srbm_lp --input <in> [--solver
//! <name>] 2>&1 | tee <out>` straight onto the Shell, stopped with "Solver exited with code N." on a
//! non-zero exit, and otherwise printed the LP summary table (`qnet_core::output::lp::summary`).
//! `runScript` then printed "Elapsed time". There is no thread banner, spinner or progress bar, and
//! no "runtime" parameter: the record keeps grid size, basis size, grid type, solver ("automatic"
//! when none is named), smoothness, basis normalization and multi-level.
//!
//! The Servers column keeps one quirk of 0.90.34's: it was ordered by `stationIndex`, which strips
//! trailing letters and underscores from a station's name and reads what is left as an integer, so
//! `stationIndex("S1")` is 0 for every usual name and the stable sort leaves the stations in
//! document order, not in the S1…Sn order of the rows beside them
//! (`qnet_core::output::lp::servers_column`). It is kept as it was; no ledger row changes it.
//!
//! **Run Finite-Buffer LP.** No sheet (`flp.askBeforeRun` is stored but 0.90.34 never read it).
//! It found `fBNAlp_solver` through `findBinary`, so a missing solver gets a fixed detail sentence,
//! not the resolver's diagnostic (RUN-014); exported the box model with an output prefix
//! `BNET_flp_csv_<pid>` to `BNET_flp_<pid>.in`; and ran, after the single-threaded thread banner,
//! `fBNAlp_solver --input <in> --solver <name>` under the Shell's spinner with
//! `runWithStderrOnFailure` (standard output to a file, the stderr policy under "Finite LP"),
//! then a blank line, the single-method table (`singleMethodFormatCmd`: regime lines, tractability
//! line, one "Finite LP" column) and "Elapsed time". A failed solver ends the output after the
//! failure text, with no table and no "Elapsed time".
//!
//! Where 2.0 differs, deliberately:
//!
//! - D1: the solvers are started as argument vectors, not typed into the user's shell; the LP
//!   summary and the single-method table are Rust text, not awk (RUN-066, Changed); the solvers'
//!   standard output is captured instead of going through `tee` or to `BNET_flp_out_<pid>.txt`.
//! - Every input file, the finite LP's CSV outputs and the infinite LP's working folder are removed
//!   when the run ends, however it ends (RUN-021, Changed). 0.90.34 removed them only after a
//!   successful stage or run.
//! - `srbm_lp` writes `srbm_out_marginal_<k>.csv` and `srbm_out_distribution.csv` into its working
//!   directory (its input names no output prefix). In 0.90.34 that was the user's shell's current
//!   folder, where the files stayed; 2.0 runs it in a private folder in the temporary folder,
//!   `BNET_lp_csv_<pid>`, removed with the run. The solver's output, which names the files
//!   relatively, is unchanged.
//! - A solver that cannot be started at all is reported as 0.90.34's `failRunToLaunch` worded it
//!   ("<Label> could not start: <error>"), with exit status −1; 0.90.34's bash would have printed
//!   its own error and "Solver exited with code 127.".
//! - The parameter sheet itself (and its "Linear Program cancelled by user." line) is P6. With
//!   `lp.askBeforeRun` on, a run here takes the sheet's initial values as if Run were pressed at
//!   once, which is what `golden/tools/GoldenRuns.swift` did; that only clamps a negative grid size,
//!   basis size or smoothness to 0, as the sheet's `resolved(_:)` did.

use std::path::{Path, PathBuf};

use qnet_core::export::srbm_box::{self, FiniteLpParams};
use qnet_core::export::srbm_orthant::{self, BnaLpParams, OrthantData};
use qnet_core::output::banner::{regime_lines, table_banner, thread_count_banner, tractability_line};
use qnet_core::output::lp as lp_text;
use qnet_core::output::table::{analytical_file, comparison_table, TableSpec, VarName};
use qnet_core::traffic;

use crate::supervisor::{Job, ProcessSpec, Severity, StderrTarget, Step, TempFiles};

use super::exact::{blocked, cocoa_write_error, icu_scientific, parameters, write_input};
use super::settings::{swift_double, RunSettings};
use super::shell::run_with_spinner;
use super::{Method, Prepared, PreparedRun, RunBody, RunContext, StatusLine};

/// Prepares Run Linear Program or Run Finite-Buffer LP.
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    match method {
        Method::LinearProgram => linear_program(ctx),
        Method::FiniteLinearProgram => finite_linear_program(ctx),
        _ => super::unimplemented_method(method),
    }
}

// ─── Run Linear Program (infinite buffers) ──────────────────────────────────────────────────────

/// `LPRunParams`: the parameters of one Linear Program run, from the settings or the sheet.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LpRunParams {
    /// `lp.gridN`; 0 or less means auto-scaled by dimension.
    pub grid_n: i64,
    /// `lp.basisM`; 0 or less means auto-scaled by dimension.
    pub basis_m: i64,
    /// `--solver <name>`, or `None` to let `srbm_lp` choose.
    pub solver_flag: Option<&'static str>,
    /// "exponential", "dyadic" or "exprandom".
    pub grid_type: &'static str,
    pub smoothness: f64,
    pub basis_normalize: bool,
    pub multi_level: bool,
}

impl LpRunParams {
    /// `readLPSettings`: `lp.solver` 1, 2, 3 are cplex, glpk, highs and anything else none;
    /// `lp.gridType` 1, 2 are dyadic, exprandom and anything else exponential.
    pub(crate) fn from_settings(s: &RunSettings) -> Self {
        let solver_flag = match s.lp_solver {
            1 => Some("cplex"),
            2 => Some("glpk"),
            3 => Some("highs"),
            _ => None,
        };
        let grid_type = match s.lp_grid_type {
            1 => "dyadic",
            2 => "exprandom",
            _ => "exponential",
        };
        LpRunParams {
            grid_n: s.lp_grid_n,
            basis_m: s.lp_basis_m,
            solver_flag,
            grid_type,
            smoothness: s.lp_smoothness,
            basis_normalize: s.lp_basis_normalize,
            multi_level: s.lp_multi_level,
        }
    }

    /// What `presentLPParams` handed on when Run was pressed with the sheet's initial values
    /// (`resolved(_:)`): the grid size, basis size and smoothness clamped to at least 0 (Swift's
    /// `max(0, x)`, so a NaN smoothness becomes 0), the choices and flags unchanged.
    pub(crate) fn answered_by_sheet(self) -> Self {
        let smoothness = if self.smoothness >= 0.0 { self.smoothness } else { 0.0 };
        LpRunParams { grid_n: self.grid_n.max(0), basis_m: self.basis_m.max(0), smoothness, ..self }
    }
}

/// `runLinearProgram()`: the solver, the orthant model, the parameters.
fn linear_program(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    let lookup = ctx.resolver.resolve_executable("srbm_lp", "BNAlp");
    let Some(binary) = lookup.url().map(Path::to_path_buf) else {
        blocked(
            &mut lines,
            "Linear Program aborted: srbm_lp binary not found.",
            Some(&lookup.actionable_diagnostic()),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let data = match srbm_orthant::compute(&ctx.network.nodes, &ctx.network.links) {
        Ok(data) => data,
        Err(e) => {
            blocked(&mut lines, &format!("Linear Program aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let params = LpRunParams::from_settings(&ctx.settings);
    // 0.90.34 has an empty "promote basis normalisation for d ≥ 3" block here (METH-079).
    let params = if ctx.settings.lp_ask_before_run { params.answered_by_sheet() } else { params };
    prepare_linear_program(ctx, binary, &data, &params)
}

/// `runLinearProgram(binary:data:params:)`: the grid, the resource guard, the stages.
fn prepare_linear_program(ctx: &RunContext, binary: PathBuf, data: &OrthantData, params: &LpRunParams) -> Prepared {
    let mut lines = Vec::new();
    let d = data.d;
    let rec = srbm_orthant::recommended_bnalp_grid(d);
    let grid_n = if params.grid_n > 0 { params.grid_n } else { rec.0 };
    let basis_m = if params.basis_m > 0 { params.basis_m } else { rec.1 };

    if let Some(issue) = linear_program_resource_issue(d, grid_n, params.smoothness) {
        blocked(&mut lines, &format!("Linear Program not started: {issue}"), None, Severity::Warning);
        return Prepared::Refused(lines);
    }

    // μ_eff,i = 1/τ_i, for the workload → queue-length scaling of the summary.
    let mu_eff: Vec<f64> = data.mean_service_times.iter().map(|&tau| if tau > 0.0 { 1.0 / tau } else { 1.0 }).collect();
    let servers = lp_text::servers_column(&ctx.network.nodes);

    let stages = lp_stages(grid_n, params.multi_level);
    let auto = params.grid_n == 0 && params.basis_m == 0;
    let grid_note = if auto {
        lp_text::grid_note(true, d, rec.0, rec.1)
    } else {
        lp_text::grid_note(false, d, grid_n, basis_m)
    };

    let mut temps = TempFiles::new();
    let mut runs = Vec::new();
    for (index, (stage_n, label)) in stages.iter().enumerate() {
        let content = srbm_orthant::format_bnalp_input(
            data,
            &BnaLpParams {
                grid_n: Some(*stage_n),
                basis_m: Some(basis_m),
                grid_type: params.grid_type.to_string(),
                smoothness_weight: params.smoothness,
                basis_normalize: params.basis_normalize,
            },
        );
        let file = format!("BNET_lp_{}_s{index}.in", ctx.pid);
        let input = match write_input(ctx, &file, &content, &mut temps) {
            Ok(path) => path,
            Err(reason) => {
                blocked(&mut lines, "Linear Program aborted: could not write temp file.", Some(&reason), Severity::Error);
                return Prepared::Refused(lines);
            }
        };
        runs.push(LpStage { label: label.clone(), input });
    }
    // `srbm_lp` writes its CSV files into its working directory.
    let work = ctx.temp_path(&format!("BNET_lp_csv_{}", ctx.pid));
    if let Err(e) = std::fs::create_dir_all(&work) {
        blocked(&mut lines, "Linear Program aborted: could not write temp file.", Some(&cocoa_write_error(&work, &e)), Severity::Error);
        return Prepared::Refused(lines);
    }
    temps.add(&work);

    let solver_flag = params.solver_flag;
    let stage_specs: Vec<(String, ProcessSpec)> = runs
        .into_iter()
        .map(|stage| {
            let mut spec = ProcessSpec::new(&binary).arg("--input").arg(&stage.input);
            if let Some(flag) = solver_flag {
                spec = spec.arg("--solver").arg(flag);
            }
            (stage.label, spec.cwd(&work).stderr(StderrTarget::MergeWithStdout))
        })
        .collect();

    Prepared::Launch(PreparedRun {
        method: Method::LinearProgram,
        parameters: parameters(&[
            ("grid size", &grid_n.to_string()),
            ("basis size", &basis_m.to_string()),
            ("grid type", params.grid_type),
            ("solver", params.solver_flag.unwrap_or("automatic")),
            ("smoothness", &swift_double(params.smoothness)),
            ("basis normalization", &params.basis_normalize.to_string()),
            ("multi-level", &params.multi_level.to_string()),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info("Running Linear Program (BNAlp)...")],
        temps,
        body: linear_program_body(grid_note, stage_specs, mu_eff, servers),
    })
}

/// One stage's label ("" for a single-stage run) and input file.
struct LpStage {
    label: String,
    input: PathBuf,
}

/// The (grid n, stage label) pairs to run: with multi-level refinement and a grid of at least 8, a
/// coarse preview at max(n/2, 6) then the full grid, each labelled; otherwise the one grid,
/// unlabelled.
pub(crate) fn lp_stages(grid_n: i64, multi_level: bool) -> Vec<(i64, String)> {
    if multi_level && grid_n >= 8 {
        let coarse = (grid_n / 2).max(6);
        vec![(coarse, lp_text::stage_label(false, coarse)), (grid_n, lp_text::stage_label(true, grid_n))]
    } else {
        vec![(grid_n, String::new())]
    }
}

/// The run: the heading and grid note, then per stage its label, the solver's merged output as it
/// arrives, and its summary, then "Elapsed time". A stage that exits non-zero prints "Solver exited
/// with code N." and ends the run (the wrapper's `exit $RC` skipped the elapsed line); a Stop ends
/// it with nothing more.
fn linear_program_body(grid_note: String, stages: Vec<(String, ProcessSpec)>, mu_eff: Vec<f64>, servers: Vec<i64>) -> RunBody {
    Box::new(move |job: &mut Job| {
        job.emit_str(&format!("{}\n", lp_text::HEADING));
        job.emit_str(&format!("{grid_note}\n\n"));
        for (label, spec) in &stages {
            if !label.is_empty() {
                job.emit_str(&format!("===== {label} =====\n"));
            }
            let outcome = match job.run_step(&Step::new(spec.clone())) {
                Ok(outcome) => outcome,
                Err(e) => return could_not_start(job, &e),
            };
            if outcome.interrupted() {
                return outcome.shell_code();
            }
            let code = outcome.shell_code();
            if code != 0 {
                job.emit_str(&format!("\nSolver exited with code {code}.\n"));
                return code;
            }
            let summary = lp_text::summary(&String::from_utf8_lossy(&outcome.stdout), &mu_eff, &servers);
            job.emit_str(&summary);
        }
        job.emit_elapsed_footer();
        0
    })
}

/// A solver that could not be spawned: 0.90.34's `failRunToLaunch` sentence and exit status −1.
fn could_not_start(job: &mut Job, e: &std::io::Error) -> i32 {
    let message = format!("{} could not start: {e}", job.display_label());
    job.could_not_start(message);
    -1
}

/// The largest LP 0.90.34 would build (`safeColumnLimit`).
const SAFE_COLUMN_LIMIT: f64 = 2_000_000.0;

/// `linearProgramResourceIssue`: BNAlp's tensor grid has nᵈ interior points, d·nᵈ⁻¹ boundary
/// points and, with a smoothness weight, d(n − 1)·nᵈ⁻¹ slack columns, plus one; above two million
/// columns (or when the count overflows) the run is refused with this sentence. No check is made
/// for d = 0 or n < 2.
pub(crate) fn linear_program_resource_issue(d: usize, n: i64, smoothness: f64) -> Option<String> {
    if d == 0 || n < 2 {
        return None;
    }
    let power = |base: f64, exponent: i64| -> f64 {
        if exponent <= 0 {
            return 1.0;
        }
        let mut result = 1.0f64;
        for _ in 0..exponent {
            result *= base;
            if !result.is_finite() {
                return f64::INFINITY;
            }
        }
        result
    };
    let interior = power(n as f64, d as i64);
    let per_face = power(n as f64, d as i64 - 1);
    let boundary = d as f64 * per_face;
    // `Double(d * (n - 1))`: an Int product, which Swift would trap on overflow.
    let slack = if smoothness > 0.0 {
        (d as i64).checked_mul(n - 1).map_or(f64::INFINITY, |c| c as f64) * per_face
    } else {
        0.0
    };
    // A sum of non-negative terms, each finite or +∞, is never NaN.
    let columns = interior + boundary + slack + 1.0;
    if columns.is_finite() && columns <= SAFE_COLUMN_LIMIT {
        return None;
    }
    let count = icu_compact_name(columns);
    let smooth = if smoothness > 0.0 { " including smoothness slacks" } else { "" };
    Some(format!(
        "For d={d} and grid_n={n}, BNAlp would create about {count} variables{smooth}, above the 2 million-variable safety limit. Reduce grid_n or smoothness, or use Adaptive Low-Rank BAR / MLMC. Tensor-grid LP is not practical at this scale."
    ))
}

/// `x.formatted(.number.notation(.compactName).precision(.significantDigits(3)))` for a count of
/// at least one, as Foundation wrote it (en_US, measured with Swift 6.4.2 on macOS 27.2): the
/// shortest round-trip decimal rounded half to even to three significant digits; the scale chosen
/// from the rounded value (999,500,000 is "1.00B"), K, M, B or T, with T kept for every larger
/// count ("1000T", "29,300T"); trailing zeros kept ("3.00M"); the integer part grouped in threes
/// only from five digits on; infinity "∞".
pub(crate) fn icu_compact_name(x: f64) -> String {
    if x.is_infinite() {
        return if x < 0.0 { "-∞".into() } else { "∞".into() };
    }
    // "d.ddE<e>" from the shared ICU rounding.
    let scientific = icu_scientific(x, 3);
    let (mantissa, exponent) = scientific.split_once('E').unwrap_or((&scientific, "0"));
    let negative = mantissa.starts_with('-');
    let digits: Vec<char> = mantissa.chars().filter(char::is_ascii_digit).collect();
    let e: i64 = exponent.parse().unwrap_or(0);
    let (scale, suffix) = match e {
        12.. => (12, "T"),
        9..=11 => (9, "B"),
        6..=8 => (6, "M"),
        3..=5 => (3, "K"),
        _ => (0, ""),
    };
    let integer_digits = e - scale + 1;
    let text = if integer_digits >= digits.len() as i64 {
        let mut whole: String = digits.iter().collect();
        whole.push_str(&"0".repeat((integer_digits - digits.len() as i64) as usize));
        if whole.len() >= 5 {
            group_thousands(&whole)
        } else {
            whole
        }
    } else if integer_digits >= 1 {
        let (whole, fraction) = digits.split_at(integer_digits as usize);
        format!("{}.{}", whole.iter().collect::<String>(), fraction.iter().collect::<String>())
    } else {
        // Below one (not reached by a count): 0.00ddd.
        format!("0.{}{}", "0".repeat((-integer_digits) as usize), digits.iter().collect::<String>())
    };
    format!("{}{text}{suffix}", if negative { "-" } else { "" })
}

/// Groups a run of digits in threes with commas.
fn group_thousands(digits: &str) -> String {
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

// ─── Run Finite-Buffer LP ───────────────────────────────────────────────────────────────────────

/// The label of the finite LP's stderr policy and table column.
const FINITE_LABEL: &str = "Finite LP";

/// `flp.solver` as `runFiniteLP` read it: 0 highs, 1 glpk, 2 cplex, clamped into that range.
pub(crate) fn finite_lp_solver(setting: i64) -> &'static str {
    const NAMES: [&str; 3] = ["highs", "glpk", "cplex"];
    NAMES[setting.clamp(0, NAMES.len() as i64 - 1) as usize]
}

/// `flp.gridType` as `runFiniteLP` read it: 1 chebyshev, anything else uniform.
pub(crate) fn finite_lp_grid_type(setting: i64) -> &'static str {
    if setting == 1 {
        "chebyshev"
    } else {
        "uniform"
    }
}

/// `runFiniteLP`.
fn finite_linear_program(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    // `findBinary` keeps only the lookup's path, so the detail is a fixed sentence (RUN-014).
    let Some(binary) = ctx.resolver.resolve_executable("fBNAlp_solver", "fBNAlp").url().map(Path::to_path_buf) else {
        blocked(
            &mut lines,
            "Finite LP aborted: fBNAlp_solver binary not found.",
            Some("Could not locate the fBNAlp_solver binary. Make sure it is compiled (run 'make' in the fBNAlp directory)."),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let s = &ctx.settings;
    let solver = finite_lp_solver(s.flp_solver);
    let grid_type = finite_lp_grid_type(s.flp_grid_type);
    let out_prefix = ctx.temp_path(&format!("BNET_flp_csv_{}", ctx.pid));
    let out_prefix_text = out_prefix.to_string_lossy().into_owned();

    // `SRBMExporter.exportForFiniteLP` (always with finite buffers, no blocking correction).
    let net = &ctx.network;
    let data = match traffic::compute(&net.nodes, &net.links, false, false, false) {
        Ok(data) => data,
        Err(e) => {
            blocked(&mut lines, &format!("Finite LP aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let params = FiniteLpParams {
        grid_n: s.flp_grid_n,
        basis_m: s.flp_basis_m,
        grid_type: grid_type.to_string(),
        solver: solver.to_string(),
        output_prefix: Some(out_prefix_text.clone()),
        smoothness_weight: 0.0,
        basis_normalize: s.flp_basis_normalize,
    };
    // New in 2.1: the solver's own size limits, checked here so that a problem it would refuse
    // is refused before anything is written or launched (`srbm_box::finite_lp_size_refusal`).
    if let Some(sentence) = srbm_box::finite_lp_size_refusal(data.d, &params) {
        blocked(&mut lines, &format!("Finite LP aborted: {sentence}"), None, Severity::Error);
        return Prepared::Refused(lines);
    }
    let content = srbm_box::format_finite_lp_input(&data, &params);
    let mut temps = TempFiles::new();
    let input = match write_input(ctx, &format!("BNET_flp_{}.in", ctx.pid), &content, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(&mut lines, "Finite LP aborted: could not write temp file.", Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    // The CSV files the solver writes beside its output prefix.
    for k in 1..=data.d {
        temps.add(PathBuf::from(format!("{out_prefix_text}_marginal_{k}.csv")));
    }
    temps.add(PathBuf::from(format!("{out_prefix_text}_distribution.csv")));

    let spec = ProcessSpec::new(&binary).arg("--input").arg(&input).args(["--solver", solver]);
    let auto_or = |n: i64| if n == 0 { "auto".to_string() } else { n.to_string() };
    Prepared::Launch(PreparedRun {
        method: Method::FiniteLinearProgram,
        parameters: parameters(&[
            ("solver", solver),
            ("grid type", grid_type),
            ("grid size", &auto_or(s.flp_grid_n)),
            ("basis size", &auto_or(s.flp_basis_m)),
            ("basis normalization", &s.flp_basis_normalize.to_string()),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running finite LP ({solver})..."))],
        temps,
        body: finite_linear_program_body(
            thread_count_banner(false, ctx.cpu_count),
            format!("Running finite LP method ({solver}) ...  "),
            spec,
            SingleMethodTable::for_context(ctx, FINITE_LABEL),
        ),
    })
}

/// The run: the thread banner, the solver under the spinner and the stderr policy, then a blank
/// line, the single-method table and "Elapsed time" once it exits 0.
fn finite_linear_program_body(banner: String, prefix: String, spec: ProcessSpec, table: SingleMethodTable) -> RunBody {
    let step = Step::new(spec).stderr_policy(FINITE_LABEL).quiet();
    Box::new(move |job: &mut Job| {
        job.emit_str(&format!("{banner}\n"));
        let outcome = match run_with_spinner(job, &prefix, &step) {
            Ok(outcome) => outcome,
            Err(e) => return could_not_start(job, &e),
        };
        let code = outcome.shell_code();
        if outcome.interrupted() || code != 0 {
            // `( exit $_rc ) && …` ran nothing more.
            return code;
        }
        job.emit_str("\n");
        job.emit_str(&table.render(&String::from_utf8_lossy(&outcome.stdout)));
        job.emit_elapsed_footer();
        0
    })
}

/// What `singleMethodFormatCmd(methodLabel:varName: "X", showGamma: true, showSojourn: true,
/// showXClass: false)` read from the tab when the command was built: the regime and tractability
/// lines, and the analytical column (`writeAnalyticalFile`) when the network is tractable.
struct SingleMethodTable {
    label: &'static str,
    banner: String,
    analytical: Option<String>,
    analytical_label: String,
    analytical_is_exact: bool,
    decimals: i64,
}

impl SingleMethodTable {
    fn for_context(ctx: &RunContext, label: &'static str) -> Self {
        let net = &ctx.network;
        let flags = ctx.flags();
        let tractable = flags.as_ref().is_some_and(|f| f.is_analytically_tractable);
        let detail = flags.as_ref().map(|f| f.tractability_detail.clone()).unwrap_or_default();
        let means = flags.as_ref().map(|f| f.tractability_means.clone()).unwrap_or_default();
        let regime = regime_lines(&net.nodes, &net.links, net.infinite_buffers);
        let data = ctx.analysis_data();
        SingleMethodTable {
            label,
            banner: table_banner(&regime, tractability_line(tractable, &detail).as_deref()),
            analytical: analytical_file(tractable, &means, data.as_ref(), VarName::X),
            analytical_label: flags.as_ref().map(|f| f.tractability_means_label.clone()).unwrap_or_default(),
            analytical_is_exact: flags.as_ref().is_some_and(|f| f.tractability_is_exact),
            decimals: ctx.settings.output_decimals,
        }
    }

    fn render(&self, solver_output: &str) -> String {
        let spec = TableSpec::single(
            self.label,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_counts_read_as_foundation_wrote_them() {
        // Measured with Swift 6.4.2 on macOS 27.2 (en_US).
        let cases: &[(f64, &str)] = &[
            (2_000_001.0, "2.00M"),
            (2_621_441.0, "2.62M"),
            (3_000_001.0, "3.00M"),
            (8_120_001.0, "8.12M"),
            (11_534_337.0, "11.5M"),
            (999_499_999.0, "999M"),
            (999_500_000.0, "1.00B"),
            (999_999_999.0, "1.00B"),
            (17_179_869_185.0, "17.2B"),
            (23_100_000_000_000.0, "23.1T"),
            (99_950_000_000_000.0, "100T"),
            (999_400_000_000_000.0, "999T"),
            (999_500_000_000_000.0, "1000T"),
            (1.5e15, "1500T"),
            (2.93e16, "29,300T"),
            (1e18, "1,000,000T"),
            (1.2345e20, "123,000,000T"),
            (1e25, "10,000,000,000,000T"),
            (2_125_000.0, "2.12M"),
            (2_135_000.0, "2.14M"),
            (2_145_000.0, "2.14M"),
            (12_345_000.0, "12.3M"),
            (12_355_000.0, "12.4M"),
            (123_455_000.0, "123M"),
            (9_995_000.0, "10.0M"),
            (9_994_999.0, "9.99M"),
            (99_950_000.0, "100M"),
            (99_949_999.0, "99.9M"),
            (f64::INFINITY, "∞"),
        ];
        for (x, want) in cases {
            assert_eq!(icu_compact_name(*x), *want, "{x:e}");
        }
    }

    #[test]
    fn the_resource_guard_counts_interior_boundary_and_slack_columns() {
        // 20 stations at the automatic grid 2: 2^20 + 20·2^19 + 1 = 11,534,337 (the corpus).
        assert_eq!(
            linear_program_resource_issue(20, 2, 0.0).as_deref(),
            Some("For d=20 and grid_n=2, BNAlp would create about 11.5M variables, above the 2 million-variable safety limit. Reduce grid_n or smoothness, or use Adaptive Low-Rank BAR / MLMC. Tensor-grid LP is not practical at this scale.")
        );
        // 17 stations fit (1,245,185 columns), 18 do not (2,621,441).
        assert_eq!(linear_program_resource_issue(17, 2, 0.0), None);
        assert!(linear_program_resource_issue(18, 2, 0.0).unwrap().contains("about 2.62M variables,"));
        // d = 2, n = 1000: 1,002,001 columns, but 3,000,001 with the 1,998,000 smoothness slacks.
        assert_eq!(linear_program_resource_issue(2, 1000, 0.0), None);
        assert_eq!(
            linear_program_resource_issue(2, 1000, 1e-4).as_deref(),
            Some("For d=2 and grid_n=1000, BNAlp would create about 3.00M variables including smoothness slacks, above the 2 million-variable safety limit. Reduce grid_n or smoothness, or use Adaptive Low-Rank BAR / MLMC. Tensor-grid LP is not practical at this scale.")
        );
        // Exactly at the limit is allowed: d = 1 never reaches it; 1,999,999 + 1 = 2,000,000.
        assert_eq!(linear_program_resource_issue(1, 1_999_998, 0.0), None);
        assert!(linear_program_resource_issue(1, 1_999_999, 0.0).unwrap().contains("about 2.00M variables"));
        // No check for d = 0 or a grid below 2; an overflowing count is refused as ∞.
        assert_eq!(linear_program_resource_issue(0, 100, 0.0), None);
        assert_eq!(linear_program_resource_issue(40, 1, 0.0), None);
        assert!(linear_program_resource_issue(400, 1000, 0.0).unwrap().contains("about ∞ variables,"));
        assert!(linear_program_resource_issue(3, i64::MAX, 1.0).unwrap().contains("about ∞ variables including smoothness slacks,"));
    }

    #[test]
    fn the_settings_map_to_solver_flags_and_grid_types_as_read_lp_settings_did() {
        let mut s = RunSettings::default();
        let p = LpRunParams::from_settings(&s);
        assert_eq!(
            p,
            LpRunParams { grid_n: 0, basis_m: 0, solver_flag: None, grid_type: "exponential", smoothness: 0.0, basis_normalize: false, multi_level: false }
        );
        for (setting, flag) in [(0, None), (1, Some("cplex")), (2, Some("glpk")), (3, Some("highs")), (4, None), (-1, None)] {
            s.lp_solver = setting;
            assert_eq!(LpRunParams::from_settings(&s).solver_flag, flag, "{setting}");
        }
        for (setting, grid) in [(0, "exponential"), (1, "dyadic"), (2, "exprandom"), (3, "exponential"), (-2, "exponential")] {
            s.lp_grid_type = setting;
            assert_eq!(LpRunParams::from_settings(&s).grid_type, grid, "{setting}");
        }
    }

    #[test]
    fn the_sheet_answered_with_its_initial_values_only_clamps_negatives() {
        let p = LpRunParams { grid_n: 12, basis_m: 4, solver_flag: Some("glpk"), grid_type: "dyadic", smoothness: 0.5, basis_normalize: true, multi_level: true };
        assert_eq!(p.clone().answered_by_sheet(), p);
        let negative = LpRunParams { grid_n: -3, basis_m: -1, smoothness: -0.25, ..p.clone() };
        assert_eq!(negative.answered_by_sheet(), LpRunParams { grid_n: 0, basis_m: 0, smoothness: 0.0, ..p.clone() });
        let nan = LpRunParams { smoothness: f64::NAN, ..p };
        assert_eq!(nan.answered_by_sheet().smoothness, 0.0);
    }

    #[test]
    fn multi_level_runs_a_coarse_preview_only_from_grid_eight() {
        assert_eq!(lp_stages(25, false), vec![(25, String::new())]);
        assert_eq!(lp_stages(7, true), vec![(7, String::new())]);
        assert_eq!(
            lp_stages(8, true),
            vec![(6, "COARSE PREVIEW (grid_n = 6)".to_string()), (8, "REFINED RUN (grid_n = 8)".to_string())]
        );
        assert_eq!(
            lp_stages(25, true),
            vec![(12, "COARSE PREVIEW (grid_n = 12)".to_string()), (25, "REFINED RUN (grid_n = 25)".to_string())]
        );
        assert_eq!(lp_stages(100, true)[0].0, 50);
    }

    #[test]
    fn the_finite_lp_settings_clamp_the_solver_and_default_the_grid() {
        assert_eq!(finite_lp_solver(0), "highs");
        assert_eq!(finite_lp_solver(1), "glpk");
        assert_eq!(finite_lp_solver(2), "cplex");
        assert_eq!(finite_lp_solver(7), "cplex");
        assert_eq!(finite_lp_solver(-4), "highs");
        assert_eq!(finite_lp_grid_type(0), "uniform");
        assert_eq!(finite_lp_grid_type(1), "chebyshev");
        assert_eq!(finite_lp_grid_type(2), "uniform");
    }
}
