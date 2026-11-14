//! The Run menu's infinite-buffer single-method runs: Whitt QNA (`qna`, `bna_qna`), Whitt–You RQNA
//! (`rqna`, `bna_rqna`), SBD (`sbd`, `bna_sbd`), the spectral method (`inf_sm`, `bnet`) and the
//! Monte Carlo simulation (`inf_sim`, `jackson_sim`). Each ports its action in
//! `2_QNET/Sources/Qnet/QnetGUIApp.swift`: `runQNA`, `runRQNA`, `runSBD`, both
//! `runSpectralMethodInfinite` overloads with `spectralResourceIssue`, and `runSimulationInfinite`,
//! together with the pieces of the command they built (`singleMethodFormatCmd`,
//! `writeAnalyticalFile`, `regimeHeader`, `tractabilityHeader`, `threadCountBanner`, `withSpinner`,
//! `withProgress`, `runWithStderrOnFailure`); ledger METH-016…019, METH-051…053, METH-055…059.
//!
//! All five ran the same way in 0.90.34. The action resolved its solver, exported the network
//! (`QNAExporter` for the three QNA-family methods, `BNASRBMExporter.exportForSpectral` for the
//! spectral method, `BNANetworkExporter` for the simulation), wrote it to a pid-stamped file in the
//! temporary folder, and typed one command: the `[Threads]` banner, the solver with its standard
//! output sent to `BNET_<method>_out_<pid>.txt` and its standard error under the stderr policy,
//! inside a spinner (the three analytical solvers) or a progress bar fed by the solver's `-P` file
//! (the spectral method and the simulation), then, if it exited 0, a blank line, the network-load
//! lines, the tractability line and the comparison table with one column (and the exact or
//! asymptotic column when the network is tractable). SBD then printed the output's
//! `QNET_SBD_STATUS_V1` lines, which the result parser reads to mark a fallback result partial.
//! `runScript` printed "Elapsed time" last, whatever the exit status. The Status sentences, their
//! severities and order, the file names, the arguments and the parameters each run records are
//! 0.90.34's.
//!
//! The spectral method and the simulation asked for their parameters in a sheet (P6). As in the
//! golden corpus, which pressed Run at once, a run here takes the sheet's initial values, which are
//! the stored settings (`sm.degree`; `sim.replications`, `sim.warmup`, `sim.time`, `sim.seedFixed`,
//! `sim.seed`), clamped as the sheet's Run closure clamped them. The sheet's Cancel sentences and its
//! Set as Default belong to the sheet.
//!
//! Where 2.0 differs, deliberately:
//!
//! - D1: each solver is started as an argument vector by the supervisor (`BNET_BIN` goes into the
//!   SBD process's environment), its standard output is captured instead of going to
//!   `BNET_<method>_out_<pid>.txt`, the table is Rust text (`qnet_core::output::table`, RUN-066)
//!   instead of an awk program, and the analytical column comes from
//!   `qnet_core::output::table::analytical_file` instead of `BNET_analytical_<pid>.txt`.
//! - The input file is registered with the run's temporary-file guard and removed when the run ends
//!   or the launch is refused, as is the `<input>_results.txt` file `jackson_sim` writes beside its
//!   input; 0.90.34 left both, and every output file, in the temporary folder (RUN-021, Changed).
//! - The spectral memory guard's sentence names "8 EB" for a dense matrix of 2⁶³ bytes or more.
//!   0.90.34 converted `min(bytes, Double(Int64.max))` to `Int64`, and `Double(Int64.max)` is 2⁶³,
//!   which does not fit, so the app trapped (measured: exit 133) for, say, 15 stations at degree 20
//!   (D5: a crash is a defect).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use qnet_core::export::{jackson_sim, qna, srbm_orthant};
use qnet_core::model::NodeKind;
use qnet_core::output::banner::{regime_lines, table_banner, thread_count_banner, tractability_line};
use qnet_core::output::table::{analytical_file, comparison_table, TableSpec, VarName};

use crate::supervisor::{Job, ProcessSpec, Severity, Step, TempFiles};

use crate::methods::exact::{blocked, could_not_start, finish, parameters, write_input};
use crate::methods::shell::{run_with_progress, run_with_spinner};
use crate::methods::{Method, Prepared, PreparedRun, RunBody, RunContext, StatusLine};

/// Prepares one of the five infinite-buffer single-method runs.
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    match method {
        Method::Qna => qna_family(ctx, &QNA),
        Method::Rqna => qna_family(ctx, &RQNA),
        Method::Sbd => qna_family(ctx, &SBD),
        Method::InfiniteSpectral => spectral(ctx, ctx.settings.sm_degree.max(2)),
        Method::InfiniteMonteCarlo => simulation(ctx, &SimulationValues::from_settings(ctx)),
        _ => crate::methods::unimplemented_method(method),
    }
}

// ─── QNA, RQNA and SBD ──────────────────────────────────────────────────────────────────────────

/// What differs between `runQNA`, `runRQNA` and `runSBD`.
struct QnaFamily {
    method: Method,
    /// The solver and its folder under `bin/infinite`.
    solver: &'static str,
    folder: &'static str,
    /// The word every sentence starts with, the stderr label and the table's column ("QNA").
    name: &'static str,
    /// The input's stem: `BNET_<stem>_<pid>.qna`.
    stem: &'static str,
    /// Whether this is SBD: it looks for `bnet`, passes it in `BNET_BIN`, and prints its status line.
    sbd: bool,
}

const QNA: QnaFamily =
    QnaFamily { method: Method::Qna, solver: "bna_qna", folder: "BNAqna", name: "QNA", stem: "qna", sbd: false };
const RQNA: QnaFamily =
    QnaFamily { method: Method::Rqna, solver: "bna_rqna", folder: "BNArqna", name: "RQNA", stem: "rqna", sbd: false };
const SBD: QnaFamily =
    QnaFamily { method: Method::Sbd, solver: "bna_sbd", folder: "BNAsbd", name: "SBD", stem: "sbd", sbd: true };

/// `runQNA`, `runRQNA` and `runSBD`.
fn qna_family(ctx: &RunContext, m: &QnaFamily) -> Prepared {
    let mut lines = Vec::new();
    let lookup = ctx.resolver.resolve_executable(m.solver, m.folder);
    let Some(binary) = lookup.url().map(Path::to_path_buf) else {
        blocked(
            &mut lines,
            &format!("{} aborted: {} binary not found.", m.name, m.solver),
            Some(&lookup.actionable_diagnostic()),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    // `findBinary(name: "bnet", subdirectory: "BNAsm")`: only SBD needs it, and only warns.
    let bnet = if m.sbd {
        let bnet = ctx.resolver.resolve_executable("bnet", "BNAsm").url().map(Path::to_path_buf);
        if bnet.is_none() {
            lines.push(StatusLine::warning(
                "SBD dependency warning: bnet is unavailable. Multi-station subnetworks will be reported as partial fallback results.",
            ));
        }
        bnet
    } else {
        None
    };
    let input = match qna::export(&ctx.network.nodes, &ctx.network.links) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("{} aborted: {}", m.name, e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("BNET_{}_{}.qna", m.stem, ctx.pid), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(&mut lines, &format!("{} aborted: could not write temp file.", m.name), Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let mut spec = ProcessSpec::new(binary);
    if let Some(bnet) = bnet {
        spec = spec.env("BNET_BIN", bnet);
    }
    let spec = spec.arg(&path).arg("-c");
    Prepared::Launch(PreparedRun {
        method: m.method,
        parameters: std::collections::BTreeMap::new(),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running {}...", m.name))],
        temps,
        body: spinner_run(
            format!("Running {} ...  ", m.name),
            m.name,
            spec,
            Table::for_context(ctx, m.name),
            ctx.cpu_count,
            m.sbd,
        ),
    })
}

/// The body of a QNA-family run: `threadCountBanner(parallel: false) && withSpinner(…) && echo &&
/// singleMethodFormatCmd(…)`, and for SBD `&& grep '^QNET_SBD_STATUS_V1' <out> || true`, then the
/// "Elapsed time" line `runScript` appended.
fn spinner_run(prefix: String, label: &'static str, spec: ProcessSpec, table: Table, cpus: usize, sbd: bool) -> RunBody {
    let step = Step::new(spec).stderr_policy(label).quiet();
    Box::new(move |job: &mut Job| {
        job.emit_str(&format!("{}\n", thread_count_banner(false, cpus)));
        let outcome = match run_with_spinner(job, &prefix, &step) {
            Ok(outcome) => outcome,
            Err(e) => return could_not_start(job, &e),
        };
        let code = outcome.shell_code();
        if outcome.interrupted() || code != 0 {
            return finish(job, outcome.interrupted(), code);
        }
        job.emit_str("\n");
        job.emit_str(&table.render(&String::from_utf8_lossy(&outcome.stdout)));
        if sbd {
            let status = sbd_status_lines(&outcome.stdout);
            job.emit(&status);
        }
        finish(job, false, 0)
    })
}

/// What `grep '^QNET_SBD_STATUS_V1' <out>` printed: every line that starts with the tag, each
/// followed by a newline (grep adds one to a last line that has none).
fn sbd_status_lines(output: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for line in output.split(|&b| b == b'\n') {
        if line.starts_with(b"QNET_SBD_STATUS_V1") {
            out.extend_from_slice(line);
            out.push(b'\n');
        }
    }
    out
}

// ─── The spectral method ────────────────────────────────────────────────────────────────────────

/// The second `runSpectralMethodInfinite(degree:)`, once the sheet has answered `degree` (at
/// least 2).
fn spectral(ctx: &RunContext, degree: i64) -> Prepared {
    let mut lines = Vec::new();
    let dimension = ctx.network.nodes_of(NodeKind::Station).count() as i64;
    if let Some(issue) = spectral_resource_issue(dimension, degree) {
        blocked(&mut lines, &format!("Spectral method not started: {issue}"), None, Severity::Warning);
        return Prepared::Refused(lines);
    }
    let lookup = ctx.resolver.resolve_executable("bnet", "BNAsm");
    let Some(binary) = lookup.url().map(Path::to_path_buf) else {
        blocked(
            &mut lines,
            "Spectral method (infinite) aborted: bnet binary not found.",
            Some(&lookup.actionable_diagnostic()),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let input = match srbm_orthant::export_for_spectral(&ctx.network.nodes, &ctx.network.links, degree) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("Spectral method (infinite) aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("BNET_inf_sm_{}.in", ctx.pid), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                "Spectral method (infinite) aborted: could not write temp file.",
                Some(&reason),
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    // `"<bnet>" -c -P "<progress>" "<input>"`.
    let command = move |progress: &Path| ProcessSpec::new(&binary).arg("-c").arg("-P").arg(progress).arg(&path);
    Prepared::Launch(PreparedRun {
        method: Method::InfiniteSpectral,
        parameters: parameters(&[("polynomial degree", &degree.to_string())]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running spectral method (infinite, degree={degree})..."))],
        temps,
        body: progress_run(ProgressRun {
            prefix: "Running spectral method ...  ",
            label: "Spectral Method (infinite)",
            run_label: "inf_sm",
            command: Box::new(command),
            table: Table::for_context(ctx, "Spectral"),
            cpus: ctx.cpu_count,
            temp_dir: ctx.temp_dir.clone(),
        }),
    })
}

/// The 2 GB budget of the spectral method's dense matrix.
const SPECTRAL_BYTE_LIMIT: f64 = 2.0 * 1024.0 * 1024.0 * 1024.0;

/// `spectralResourceIssue(dimension:degree:)`: the sentence refusing a spectral run whose dense
/// basis matrix, C(d + p, p)² doubles, would exceed 2 GB, naming the largest degree from 2 up to
/// `p` that fits (METH-052); `None` when it fits or when either number is not positive. Run
/// Comparison's spectral column uses it too.
pub(in crate::methods) fn spectral_resource_issue(d: i64, p: i64) -> Option<String> {
    if d <= 0 || p <= 0 {
        return None;
    }
    let basis_count = |degree: i64| -> f64 {
        let mut value = 1.0f64;
        for k in 1..=degree {
            value *= (d + k) as f64 / k as f64;
        }
        value
    };
    let basis = basis_count(p);
    let bytes = basis * basis * 8.0;
    // `guard !bytes.isFinite || bytes > limit else { return nil }` (a finite count is never NaN).
    if bytes.is_finite() && bytes <= SPECTRAL_BYTE_LIMIT {
        return None;
    }
    let mut safe_degree = None;
    if p >= 2 {
        for candidate in 2..=p {
            let b = basis_count(candidate);
            if b * b * 8.0 <= SPECTRAL_BYTE_LIMIT {
                safe_degree = Some(candidate);
            }
        }
    }
    let basis_text = icu_significant(basis, 3);
    let memory_text = if bytes.is_finite() {
        // `Int64(min(bytes, Double(Int64.max)))` trapped at 2⁶³; `as` saturates at Int64.max.
        byte_count_memory(bytes as i64)
    } else {
        "more than addressable memory".to_string()
    };
    let alternative = match safe_degree {
        Some(k) => format!("Try degree {k} or lower, or use Adaptive Low-Rank BAR / product form when applicable."),
        None => "No degree of at least 2 fits the safety budget; use Adaptive Low-Rank BAR, MLMC, or product form instead."
            .to_string(),
    };
    Some(format!(
        "For d={d} and degree {p}, the spectral basis has about {basis_text} terms and its dense matrix alone needs about {memory_text}. The 2 GB safety limit prevents this run. {alternative}"
    ))
}

// ─── The Monte Carlo simulation ─────────────────────────────────────────────────────────────────

/// What the Run Monte Carlo sheet (infinite buffers) answered, clamped as its Run closure clamped
/// it: at least one replication, a warm-up of at least 0, a run length of at least 1, a seed of at
/// least 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SimulationValues {
    replications: i64,
    warmup: i64,
    sim_time: i64,
    seed_fixed: bool,
    seed: i64,
}

impl SimulationValues {
    /// The sheet's initial values, which are the stored settings.
    fn from_settings(ctx: &RunContext) -> Self {
        let s = &ctx.settings;
        SimulationValues {
            replications: s.sim_replications.max(1),
            warmup: s.sim_warmup.max(0),
            sim_time: s.sim_time.max(1),
            seed_fixed: s.sim_seed_fixed,
            seed: s.sim_seed.max(0),
        }
    }
}

/// `runSimulationInfinite`: the export, the solver, the input file, then the sheet's answer.
fn simulation(ctx: &RunContext, values: &SimulationValues) -> Prepared {
    let mut lines = Vec::new();
    let input = match jackson_sim::export(&ctx.network.nodes, &ctx.network.links) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("Simulation (infinite) aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let lookup = ctx.resolver.resolve_executable("jackson_sim", "BNAsim");
    let Some(binary) = lookup.url().map(Path::to_path_buf) else {
        blocked(
            &mut lines,
            "Simulation (infinite) aborted: jackson_sim binary not found.",
            Some(&lookup.actionable_diagnostic()),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let mut temps = TempFiles::new();
    let stem = format!("BNET_inf_sim_{}", ctx.pid);
    let path = match write_input(ctx, &format!("{stem}.sim"), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(&mut lines, "Simulation (infinite) aborted: could not write temp file.", Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    // jackson_sim writes `<input minus its extension>_results.txt` beside its input.
    temps.add(ctx.temp_path(&format!("{stem}_results.txt")));

    let SimulationValues { replications, warmup, sim_time, seed_fixed, seed } = *values;
    // `Int.random(in: 1...Int(Int32.max))` when the seed is not fixed.
    let base_seed = if seed_fixed { seed as u64 } else { ctx.random_in(1, i32::MAX as u64) };
    let args: Vec<OsString> = vec![
        path.clone().into(),
        "-c".into(),
        "-n".into(),
        replications.to_string().into(),
        "-w".into(),
        warmup.to_string().into(),
        "-r".into(),
        sim_time.to_string().into(),
        "-s".into(),
        base_seed.to_string().into(),
    ];
    // `"<jackson_sim>" "<input>" -c -n <n> -w <w> -r <t> -s <seed> -P "<progress>"`.
    let command = move |progress: &Path| ProcessSpec::new(&binary).args(args.iter().cloned()).arg("-P").arg(progress);
    Prepared::Launch(PreparedRun {
        method: Method::InfiniteMonteCarlo,
        parameters: parameters(&[
            ("replications", &replications.to_string()),
            ("warm-up", &warmup.to_string()),
            ("simulation time", &sim_time.to_string()),
            ("fixed seed", if seed_fixed { "true" } else { "false" }),
        ]),
        seed: Some(base_seed),
        replication_seeds: (0..replications as u64).map(|k| base_seed + k).collect(),
        before: lines,
        accepted: vec![StatusLine::info("Running simulation (infinite) via jackson_sim...")],
        temps,
        body: progress_run(ProgressRun {
            prefix: "Running simulation ...  ",
            label: "Simulation (infinite)",
            run_label: "inf_sim",
            command: Box::new(command),
            table: Table::for_context(ctx, "Simulation"),
            cpus: ctx.cpu_count,
            temp_dir: ctx.temp_dir.clone(),
        }),
    })
}

// ─── Shared by the spectral method and the simulation ───────────────────────────────────────────

/// A run under the progress bar.
struct ProgressRun {
    /// The bar's prefix ("Running simulation ...  ").
    prefix: &'static str,
    /// The stderr policy's label.
    label: &'static str,
    /// The run label the progress file is named after (`BNET_progress_<label>_<pid>_<µs>.bin`).
    run_label: &'static str,
    /// The solver's command, given the progress file it is to write.
    command: Box<dyn FnOnce(&Path) -> ProcessSpec + Send>,
    table: Table,
    cpus: usize,
    /// Where the progress file goes (the run's temporary folder).
    temp_dir: PathBuf,
}

/// The body of a progress-bar run: `threadCountBanner(parallel: true) && withProgress(…) && echo &&
/// singleMethodFormatCmd(…)`, then "Elapsed time".
fn progress_run(run: ProgressRun) -> RunBody {
    Box::new(move |job: &mut Job| {
        let ProgressRun { prefix, label, run_label, command, table, cpus, temp_dir } = run;
        job.set_temp_dir(temp_dir);
        job.emit_str(&format!("{}\n", thread_count_banner(true, cpus)));
        let progress = job.progress_file(run_label);
        let step = Step::new(command(&progress)).stderr_policy(label).progress(&progress).quiet();
        let outcome = match run_with_progress(job, prefix, &step) {
            Ok(outcome) => outcome,
            Err(e) => return could_not_start(job, &e),
        };
        let code = outcome.shell_code();
        if outcome.interrupted() || code != 0 {
            return finish(job, outcome.interrupted(), code);
        }
        job.emit_str("\n");
        job.emit_str(&table.render(&String::from_utf8_lossy(&outcome.stdout)));
        finish(job, false, 0)
    })
}

/// What `singleMethodFormatCmd(outFile:, methodLabel:, varName: "Q", showGamma: true, showSojourn:
/// true, showXClass: false)` took from the tab when the command was built: the regime and
/// tractability lines, and the analytical column of a tractable network.
struct Table {
    label: &'static str,
    /// The regime lines and the tractability line, each with its newline.
    banner: String,
    analytical: Option<String>,
    analytical_label: String,
    analytical_is_exact: bool,
    decimals: i64,
}

impl Table {
    fn for_context(ctx: &RunContext, label: &'static str) -> Table {
        let net = &ctx.network;
        let flags = ctx.flags();
        let tractable = flags.as_ref().is_some_and(|f| f.is_analytically_tractable);
        let detail = flags.as_ref().map(|f| f.tractability_detail.clone()).unwrap_or_default();
        let means = flags.as_ref().map(|f| f.tractability_means.clone()).unwrap_or_default();
        let regime = regime_lines(&net.nodes, &net.links, net.infinite_buffers);
        Table {
            label,
            banner: table_banner(&regime, tractability_line(tractable, &detail).as_deref()),
            analytical: analytical_file(tractable, &means, ctx.analysis_data().as_ref(), VarName::Q),
            analytical_label: flags.as_ref().map(|f| f.tractability_means_label.clone()).unwrap_or_default(),
            analytical_is_exact: flags.as_ref().is_some_and(|f| f.tractability_is_exact),
            decimals: ctx.settings.output_decimals,
        }
    }

    /// The banner and the table over the solver's output.
    fn render(&self, solver_output: &str) -> String {
        let spec = TableSpec::single(
            self.label,
            solver_output,
            VarName::Q,
            self.analytical.clone(),
            Some(self.analytical_label.clone()),
            self.analytical_is_exact,
            self.decimals,
        );
        format!("{}{}", self.banner, comparison_table(&spec))
    }
}

// ─── Foundation's number words in the spectral guard (en_US) ────────────────────────────────────
//
// Measured on macOS 27.2 with Swift 6.4.2: `x.formatted(.number.precision(.significantDigits(3)))`
// rounds the shortest round-trip decimal of `x` half to even to exactly three significant digits
// (padding with zeros: 45 → "45.0") and groups the integer part with commas (43,758 → "43,800");
// `ByteCountFormatter.string(fromByteCount:countStyle: .memory)` divides by powers of 1024, rounds
// GB and larger to two decimals half away from zero, drops trailing zeros (2 GiB → "2 GB"), groups
// with commas ("1,023.99 GB"), and moves to the next unit when the rounded value reaches 1024
// (1023.996 GiB → "1 TB").

/// The shortest round-trip decimal of `|x|` (finite, nonzero) as its digits and the exponent of
/// the first (the value is d0.d1d2… × 10^e).
fn shortest_digits(x: f64) -> (Vec<u8>, i32) {
    let text = format!("{:e}", x.abs());
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let digits = mantissa.bytes().filter(u8::is_ascii_digit).map(|b| b - b'0').collect();
    (digits, exponent.parse().unwrap_or(0))
}

/// Rounds `digits` (exponent `e`) to its first `keep` digits, half to even when `even`, else half
/// away from zero. Returns the kept digits (empty for zero) and the exponent after any carry.
fn round_digits(digits: &[u8], e: i32, keep: i64, even: bool) -> (Vec<u8>, i32) {
    if keep < 0 {
        return (Vec::new(), e);
    }
    let keep = keep as usize;
    if keep >= digits.len() {
        return (digits.to_vec(), e);
    }
    let mut kept = digits[..keep].to_vec();
    let first = digits[keep];
    let rest = digits[keep + 1..].iter().any(|&d| d != 0);
    let odd = kept.last().is_some_and(|d| d % 2 == 1);
    let up = first > 5 || (first == 5 && (!even || rest || odd));
    let mut e = e;
    if up {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, 1);
                e += 1;
                break;
            }
            i -= 1;
            if kept[i] == 9 {
                kept[i] = 0;
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    (kept, e)
}

/// The digit with place value 10^p in `digits` (exponent `e`), or 0 outside them.
fn place(digits: &[u8], e: i32, p: i32) -> u8 {
    let index = e as i64 - p as i64;
    if index >= 0 && (index as usize) < digits.len() {
        digits[index as usize]
    } else {
        0
    }
}

/// Groups a run of integer digits in threes with commas.
fn group(int_digits: &str) -> String {
    let mut out = String::with_capacity(int_digits.len() + int_digits.len() / 3);
    for (i, c) in int_digits.chars().enumerate() {
        if i > 0 && (int_digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `x.formatted(.number.precision(.significantDigits(n)))`.
fn icu_significant(x: f64, n: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-∞".into() } else { "∞".into() };
    }
    let n = n.max(1);
    let sign = if x.is_sign_negative() && x != 0.0 { "-" } else { "" };
    let (digits, e) = if x == 0.0 { (Vec::new(), 0) } else { shortest_digits(x) };
    let (digits, e) = if digits.is_empty() { (vec![0], 0) } else { round_digits(&digits, e, n as i64, true) };
    // Exactly n significant digits: the lowest place shown is e − n + 1.
    let lowest = e - n as i32 + 1;
    let int_part: String = if e >= 0 { (0..=e).rev().map(|p| (b'0' + place(&digits, e, p)) as char).collect() } else { "0".into() };
    let frac_part: String = (lowest..0).rev().map(|p| (b'0' + place(&digits, e, p)) as char).collect();
    if frac_part.is_empty() {
        format!("{sign}{}", group(&int_part))
    } else {
        format!("{sign}{}.{frac_part}", group(&int_part))
    }
}

/// `ByteCountFormatter.string(fromByteCount: bytes, countStyle: .memory)` for a count of at least
/// 1 GiB (the guard only calls it above 2 GiB).
fn byte_count_memory(bytes: i64) -> String {
    const UNITS: [&str; 4] = ["GB", "TB", "PB", "EB"];
    let mut unit = 0;
    let mut value = bytes as f64 / 1024f64.powi(3);
    while unit + 1 < UNITS.len() && value >= 1024.0 {
        value /= 1024.0;
        unit += 1;
    }
    let rounded = |v: f64| -> (Vec<u8>, i32) {
        let (digits, e) = shortest_digits(v);
        round_digits(&digits, e, e as i64 + 1 + 2, false)
    };
    let (mut digits, mut e) = rounded(value);
    let whole = |digits: &[u8], e: i32| -> u64 { (0..=e).rev().fold(0, |acc, p| acc * 10 + place(digits, e, p) as u64) };
    if unit + 1 < UNITS.len() && whole(&digits, e) >= 1024 {
        unit += 1;
        (digits, e) = rounded(value / 1024.0);
    }
    let int_part: String = (0..=e.max(0)).rev().map(|p| (b'0' + place(&digits, e, p)) as char).collect();
    let frac_part: String =
        (1..=2).map(|p| (b'0' + place(&digits, e, -p)) as char).collect::<String>().trim_end_matches('0').to_string();
    let number = if frac_part.is_empty() { group(&int_part) } else { format!("{}.{frac_part}", group(&int_part)) };
    format!("{number} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_significant_digits_read_as_foundation_wrote_them() {
        // Measured with Swift 6.4.2 on macOS 27.2 (en_US).
        let cases: &[(f64, &str)] = &[
            (43758.00000000001, "43,800"),
            (490314.0, "490,000"),
            (3108105.0, "3,110,000"),
            (45.0, "45.0"),
            (16385.0, "16,400"),
            (1e20, "100,000,000,000,000,000,000"),
            (123456789012.0, "123,000,000,000"),
            (1.5, "1.50"),
            (99950.0, "100,000"),
            (99949.0, "99,900"),
            (1234567.0, "1,230,000"),
            (12345.0, "12,300"),
            (12250.0, "12,200"),
            (12350.0, "12,400"),
            (16450.0, "16,400"),
            (16550.0, "16,600"),
            (0.0125, "0.0125"),
            (0.5, "0.500"),
            (100.0, "100"),
            (999.5, "1,000"),
            (1005.0, "1,000"),
            (1015.0, "1,020"),
            (9995.0, "10,000"),
            (2.0e-5, "0.0000200"),
            (-45.0, "-45.0"),
            (f64::INFINITY, "∞"),
        ];
        for (x, want) in cases {
            assert_eq!(icu_significant(*x, 3), *want, "{x:e}");
        }
    }

    #[test]
    fn memory_sizes_read_as_byte_count_formatter_wrote_them() {
        // Measured with Swift 6.4.2 on macOS 27.2 (en_US), countStyle .memory.
        let cases: &[(i64, &str)] = &[
            (2147483649, "2 GB"),
            (2684354560, "2.5 GB"),
            (3221225472, "3 GB"),
            (15318100512, "14.27 GB"),
            (1099511627776, "1 TB"),
            (1649267441664, "1.5 TB"),
            (1923453034752, "1.75 TB"),
            (77281012332032, "70.29 TB"),
            (1125899906842624, "1 PB"),
            (1152921504606846976, "1 EB"),
            (i64::MAX, "8 EB"),
            (21474836480, "20 GB"),
            (2147483648000, "1.95 TB"),
            (5373956915, "5 GB"),
            (5379200000, "5.01 GB"),
            (2152726528, "2 GB"),
            (1407374883553280, "1.25 PB"),
            (1124800395214848, "1,023 TB"),
            (1125899906842623, "1 PB"),
            (2281701376, "2.13 GB"),
            (2550136832, "2.38 GB"),
            (2818572288, "2.63 GB"),
            (2152852357, "2 GB"),
            (2163589775, "2.01 GB"),
            (2174327193, "2.02 GB"),
            (1099500890357, "1,023.99 GB"),
            (1099506259066, "1,023.99 GB"),
            (1099507332808, "1 TB"),
            (1098867382681, "1,023.4 GB"),
            (1073736455290, "999.99 GB"),
            (1073741824000, "1,000 GB"),
            (1074278694912, "1,000.5 GB"),
            (107368813690, "99.99 GB"),
            (10732049530, "9.99 GB"),
            (1125898833100800, "1 PB"),
            (1152917001007219584, "1 EB"),
            (1152914749207405952, "1,023.99 PB"),
        ];
        for (bytes, want) in cases {
            assert_eq!(byte_count_memory(*bytes), *want, "{bytes}");
        }
    }

    #[test]
    fn the_spectral_guard_reads_as_in_the_corpus_and_names_the_largest_degree_that_fits() {
        assert_eq!(
            spectral_resource_issue(10, 8).as_deref(),
            Some("For d=10 and degree 8, the spectral basis has about 43,800 terms and its dense matrix alone needs about 14.27 GB. The 2 GB safety limit prevents this run. Try degree 6 or lower, or use Adaptive Low-Rank BAR / product form when applicable.")
        );
        assert_eq!(
            spectral_resource_issue(20, 8).as_deref(),
            Some("For d=20 and degree 8, the spectral basis has about 3,110,000 terms and its dense matrix alone needs about 70.29 TB. The 2 GB safety limit prevents this run. Try degree 4 or lower, or use Adaptive Low-Rank BAR / product form when applicable.")
        );
        // C(3 + 8, 8) = 165 terms: about 218 kB.
        assert_eq!(spectral_resource_issue(3, 8), None);
        assert_eq!(spectral_resource_issue(0, 8), None);
        assert_eq!(spectral_resource_issue(5, 0), None);
    }

    #[test]
    fn the_spectral_guard_says_when_no_degree_of_two_or_more_fits() {
        // C(180 + 2, 2) = 16,471 terms at degree 2: 16,471² × 8 bytes is just over 2 GiB.
        assert_eq!(
            spectral_resource_issue(180, 2).as_deref(),
            Some("For d=180 and degree 2, the spectral basis has about 16,500 terms and its dense matrix alone needs about 2.02 GB. The 2 GB safety limit prevents this run. No degree of at least 2 fits the safety budget; use Adaptive Low-Rank BAR, MLMC, or product form instead.")
        );
        // C(179 + 2, 2) = 16,290 terms fits.
        assert_eq!(spectral_resource_issue(179, 2), None);
        // At degree 1 no degree of at least 2 is tried.
        assert!(spectral_resource_issue(50_000, 1).expect("refused").ends_with("No degree of at least 2 fits the safety budget; use Adaptive Low-Rank BAR, MLMC, or product form instead."));
    }

    #[test]
    fn a_matrix_of_two_to_the_sixty_three_bytes_or_more_is_named_as_8_eb_instead_of_trapping() {
        // 15 stations at degree 20: C(35, 20) ≈ 3.2e9 terms, ≈ 8.3e19 bytes. 0.90.34 trapped here.
        let issue = spectral_resource_issue(15, 20).expect("refused");
        assert!(issue.starts_with("For d=15 and degree 20, the spectral basis has about 3,250,000,000 terms and its dense matrix alone needs about 8 EB."), "{issue}");
        assert!(issue.ends_with("Try degree 5 or lower, or use Adaptive Low-Rank BAR / product form when applicable."), "{issue}");
        // A basis whose square overflows to infinity.
        let issue = spectral_resource_issue(1_000_000, 40).expect("refused");
        assert!(issue.contains("its dense matrix alone needs about more than addressable memory."), "{issue}");
        assert!(issue.ends_with("No degree of at least 2 fits the safety budget; use Adaptive Low-Rank BAR, MLMC, or product form instead."), "{issue}");
    }

    #[test]
    fn the_sbd_status_lines_are_the_lines_grep_prints() {
        let out = b"rho_1 = 0.9\nQNET_SBD_STATUS_V1 fallback_used=no\nx QNET_SBD_STATUS_V1\nQNET_SBD_STATUS_V1 tail";
        assert_eq!(sbd_status_lines(out), b"QNET_SBD_STATUS_V1 fallback_used=no\nQNET_SBD_STATUS_V1 tail\n".to_vec());
        assert!(sbd_status_lines(b"rho_1 = 0.9\n").is_empty());
    }

    // The Run Comparison port's measured cases (it had its own copy of this guard and these
    // formats; they now share these).
    #[test]
    fn the_comparisons_spectral_guard_reads_as_0_90_34_wrote_it_for_the_corpus_tandems() {
        // golden/runs/{10,15,20}stationtandem.inf/inf_cmp/archive.txt
        assert_eq!(
            spectral_resource_issue(10, 8).unwrap(),
            "For d=10 and degree 8, the spectral basis has about 43,800 terms and its dense matrix alone needs about 14.27 GB. The 2 GB safety limit prevents this run. Try degree 6 or lower, or use Adaptive Low-Rank BAR / product form when applicable."
        );
        assert!(spectral_resource_issue(15, 8).unwrap().contains("about 490,000 terms and its dense matrix alone needs about 1.75 TB. The 2 GB safety limit prevents this run. Try degree 5 or lower"));
        assert!(spectral_resource_issue(20, 8).unwrap().contains("about 3,110,000 terms and its dense matrix alone needs about 70.29 TB. The 2 GB safety limit prevents this run. Try degree 4 or lower"));
    }

    #[test]
    fn the_spectral_guard_passes_small_bases_and_names_no_degree_when_none_fits_at_large_dimensions() {
        assert_eq!(spectral_resource_issue(3, 8), None);
        assert_eq!(spectral_resource_issue(0, 8), None);
        assert_eq!(spectral_resource_issue(5, 0), None);
        // C(9, 8) = 9 terms is nothing; C(18, 8) = 43,758 at d = 10 is too much.
        assert_eq!(spectral_resource_issue(9, 1), None);
        // At d = 200 even degree 2 has C(202, 2) = 20,301 terms, over the 16,384 that fit.
        let s = spectral_resource_issue(200, 2).unwrap();
        assert!(s.ends_with("The 2 GB safety limit prevents this run. No degree of at least 2 fits the safety budget; use Adaptive Low-Rank BAR, MLMC, or product form instead."), "{s}");
        assert!(s.starts_with("For d=200 and degree 2, the spectral basis has about 20,300 terms and its dense matrix alone needs about 3.07 GB."), "{s}");
        // Degree 1 never offers an alternative degree.
        assert!(spectral_resource_issue(20_000, 1).unwrap().ends_with("No degree of at least 2 fits the safety budget; use Adaptive Low-Rank BAR, MLMC, or product form instead."));
    }

    #[test]
    fn the_spectral_guard_survives_a_matrix_past_int64_and_past_a_double_in_the_comparison() {
        // 0.90.34 trapped here; C(78, 8)² × 8 ≈ 4.4e21 bytes is clamped to Int64.max ("8 EB").
        let s = spectral_resource_issue(70, 8).unwrap();
        assert!(s.contains("needs about 8 EB."), "{s}");
        let s = spectral_resource_issue(2000, 1000).unwrap();
        assert!(s.contains("has about ∞ terms and its dense matrix alone needs about more than addressable memory."), "{s}");
    }

    #[test]
    fn memory_sizes_read_as_foundations_byte_count_formatter_printed_them_for_the_comparison() {
        // Measured with Swift 6.4.2 on macOS 27.2: ByteCountFormatter, countStyle .memory.
        let g: i64 = 1 << 30;
        let t: i64 = g << 10;
        let cases: &[(i64, &str)] = &[
            (2_147_483_649, "2 GB"),
            (2_756_976_768, "2.57 GB"),
            (4_727_808_800, "4.4 GB"),
            (15_318_100_512, "14.27 GB"),
            (1_923_262_548_768, "1.75 TB"),
            (77_282_533_528_199, "70.29 TB"),
            (2_281_701_376, "2.13 GB"),
            (2_818_572_288, "2.63 GB"),
            (3_087_007_744, "2.88 GB"),
            (5_374_077_829, "5 GB"),
            (5_374_077_830, "5.01 GB"),
            (1_098_867_382_681, "1,023.4 GB"),
            (1_099_506_259_066, "1,023.99 GB"),
            (1_099_507_332_808, "1 TB"),
            (1_073_741_824_000, "1,000 GB"),
            (t * 3 / 2, "1.5 TB"),
            (t + t / 8, "1.13 TB"),
            (1_125_350_151_028_736, "1,023.5 TB"),
            (1_125_895_611_875_328, "1 PB"),
            (1_139_138_106_182_496_256, "1,011.76 PB"),
            (2_405_537_225_474_574_848, "2.09 EB"),
            (8_214_565_720_323_784_704, "7.13 EB"),
            (i64::MAX, "8 EB"),
        ];
        for (bytes, want) in cases {
            assert_eq!(byte_count_memory(*bytes), *want, "{bytes}");
        }
    }

    #[test]
    fn significant_digits_round_the_shortest_decimal_half_to_even_for_the_comparison() {
        // Measured with Swift 6.4.2 on macOS 27.2 (en_US), `.significantDigits(3)`.
        let cases: &[(f64, &str)] = &[
            (43758.0, "43,800"),
            (43758.00000000001, "43,800"),
            (490314.0, "490,000"),
            (3108105.0, "3,110,000"),
            (16385.0, "16,400"),
            (99950.0, "100,000"),
            (99949.0, "99,900"),
            (1234567890123.0, "1,230,000,000,000"),
            (125.0, "125"),
            (1250.0, "1,250"),
            (1235.0, "1,240"),
            (1245.0, "1,240"),
            (1255.0, "1,260"),
            (12355.0, "12,400"),
            (12.5, "12.5"),
            (1.0, "1.00"),
            (123456.7, "123,000"),
            (1e20, "100,000,000,000,000,000,000"),
        ];
        for (x, want) in cases {
            assert_eq!(icu_significant(*x, 3), *want, "{x}");
        }
    }
}
