//! The exact queue-process methods of the Run menu: Exact Open Product Form (`product_form`),
//! Exact Matrix-Analytic QBD (`qbd`), Adaptive Truncated CTMC (`truncated_ctmc`, with its scale
//! pre-check), Exact Sparse CTMC (`generic_ctmc`) and Finite-Buffer Decomposition (`fb_decomp`).
//! Each ports its `run…()` action in `2_QNET/Sources/Qnet/QnetGUIApp.swift` (`runOpenProductForm`,
//! `runQBD`, `runTruncatedCTMC` with `truncatedCTMCScaleIssue`, `runGenericCTMC`,
//! `runFiniteDecomposition`; ledger METH-027…METH-037, METH-102…METH-106).
//!
//! All five ran the same way in 0.90.34: resolve the solver (three of them through `resolveEngine`,
//! which picks the C or Python engine from the stored setting and falls back to the other with a
//! warning), export a JSON document named `qnet_<method>_<uuid>.json` into the temporary folder,
//! and run `<solver> <input> [flags]` under the Shell's spinner (`withSpinner`) inside
//! `commandWithCleanup`'s subshell, whose traps removed the input however the run ended; `runScript`
//! then printed "Elapsed time". The spinner captured the solver's merged standard output and error
//! and printed them after its `[done]` frame. The Status sentences, their severities and their
//! order, the parameters each run records and the input documents are 0.90.34's.
//!
//! Where 2.0 differs, deliberately:
//!
//! - D1: the solver is started as an argument vector by the supervisor, not typed into the user's
//!   shell. The input file is registered with the run's temporary-file guard instead of a bash trap,
//!   so it is removed on every exit path, including a refused launch (RUN-022, SH-084, Changed).
//! - A write failure's reason is Cocoa's sentence as measured for the two common causes (a missing
//!   folder, no permission) and a generic "couldn't be saved" otherwise; 0.90.34 printed whatever
//!   Foundation said, which differs for rarer errors.
//!
//! This file also holds the few helpers the other exact-family files (`regenerative.rs`, `bar.rs`,
//! `multiclass.rs`) share: `reportBlocked`, writing an input file, the spinner-wrapped run, the
//! engine resolution with its fallback note, and the ICU number styles three Status sentences use.

use std::io;
use std::path::{Path, PathBuf};

use qnet_core::export::finite_markov::{self, Blocking, DecompositionOptions, GenericCtmcOptions, TruncatedCtmcOptions};
use qnet_core::export::{product_form, qbd};
use qnet_core::model::NodeKind;

use crate::resolver::{DualEngineMethod, LaunchPrefix, PythonRequest, ResolvedEngine, SolverEngine, SolverLookup};
use crate::supervisor::{Job, ProcessSpec, Severity, StderrTarget, Step, TempFiles};

use super::shell::run_with_spinner;
use super::{Method, Prepared, PreparedRun, RunBody, RunContext, StatusLine};

/// Prepares one of the five exact queue-process methods.
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    match method {
        Method::ProductForm => product_form(ctx),
        Method::Qbd => qbd(ctx),
        Method::TruncatedCtmc => truncated_ctmc(ctx),
        Method::GenericCtmc => generic_ctmc(ctx),
        Method::FiniteDecomposition => finite_decomposition(ctx),
        _ => super::unimplemented_method(method),
    }
}

// ─── The five methods ────────────────────────────────────────────────────────────────────────────

/// `runOpenProductForm`.
fn product_form(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    let lookup = ctx.resolver.resolve_python_support_file_in("solver.py", "BNApf", &["infinite"], &PythonRequest::default());
    let Some(launch) = python_launch(&lookup) else {
        blocked(
            &mut lines,
            "Exact product form aborted: solver support is unavailable.",
            Some(&lookup.actionable_diagnostic()),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let input = match product_form::export(&ctx.network, &ctx.title, product_form::DEFAULT_MAXIMUM_SERVERS) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("Exact product form not started: {}", e.message()), None, Severity::Warning);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let file = format!("qnet_open_product_form_{}.json", ctx.uuid());
    let path = match write_input(ctx, &file, &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                &format!("Exact product form aborted: could not write the solver input file: {reason}"),
                None,
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    let spec = launch_spec(&launch).arg(&path);
    Prepared::Launch(PreparedRun {
        method: Method::ProductForm,
        parameters: parameters(&[
            ("model", "exact open FCFS BCMP/Jackson"),
            ("local queues", "M/M/c"),
            ("state-space truncation", "none"),
            ("traffic equations", "class-preserving open routing"),
            ("runtime", &runtime(&lookup)),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info("Running exact open product form (analytic M/M/c local normalizers).")],
        temps,
        body: spinner_body("Solving exact open product form ...  ".into(), spec),
    })
}

/// `runQBD`.
fn qbd(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    let Some(engine) = resolve_engine(
        ctx,
        DualEngineMethod::MatrixAnalyticQbd,
        ctx.settings.engine_qbd,
        "Exact QBD aborted: solver support is unavailable.",
        &mut lines,
    ) else {
        return Prepared::Refused(lines);
    };
    let input = match qbd::export(&ctx.network, &ctx.title, &qbd::QbdOptions::default()) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("Exact QBD not started: {}", e.message()), None, Severity::Warning);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("qnet_qbd_{}.json", ctx.uuid()), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                &format!("Exact QBD aborted: could not write the solver input file: {reason}"),
                None,
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    let spec = launch_spec(&engine.launch).arg(&path).arg("--human");
    Prepared::Launch(PreparedRun {
        method: Method::Qbd,
        parameters: parameters(&[
            ("model", "exact scalar continuous-time QBD"),
            ("queue", "one-station M/M/1 with optional feedback"),
            ("algorithm", "minimal nonnegative matrix-geometric rate"),
            ("maximum iterations", "100000"),
            ("engine", engine.engine.title()),
            ("runtime", &engine.provenance),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!(
            "Running exact matrix-analytic QBD solution on the {}.",
            engine.engine.descriptive_name()
        ))],
        temps,
        body: spinner_body(format!("Solving exact matrix-analytic QBD ({}) ...  ", engine.engine.title()), spec),
    })
}

/// `runTruncatedCTMC`.
fn truncated_ctmc(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    if let Some(issue) = truncated_ctmc_scale_issue(ctx) {
        blocked(&mut lines, &format!("Adaptive truncated CTMC not started: {issue}"), None, Severity::Warning);
        return Prepared::Refused(lines);
    }
    let Some(engine) = resolve_engine(
        ctx,
        DualEngineMethod::TruncatedCtmc,
        ctx.settings.engine_ctmc,
        "Adaptive truncated CTMC aborted: solver not found.",
        &mut lines,
    ) else {
        return Prepared::Refused(lines);
    };
    let input = match finite_markov::truncated_infinite_ctmc(&ctx.network, &ctx.title, &TruncatedCtmcOptions::default()) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("Adaptive truncated CTMC not started: {}", e.message()), None, Severity::Warning);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("qnet_truncated_ctmc_{}.json", ctx.uuid()), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                &format!("Adaptive truncated CTMC aborted: could not write the solver input file: {reason}"),
                None,
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    let spec = launch_spec(&engine.launch).arg(&path).arg("--human");
    Prepared::Launch(PreparedRun {
        method: Method::TruncatedCtmc,
        parameters: parameters(&[
            ("process", "open single-class M/M/c network"),
            ("initial total-population cap", "8"),
            ("maximum total-population cap", "64"),
            ("maximum states", "200000"),
            ("boundary mass tolerance", "1e-8"),
            ("successive refinement tolerance", "1e-7"),
            ("truncation evidence", "heuristic"),
            ("engine", engine.engine.title()),
            ("runtime", &engine.provenance),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!(
            "Running adaptive truncated CTMC on the {} (queue process; heuristic truncation diagnostics).",
            engine.engine.descriptive_name()
        ))],
        temps,
        body: spinner_body(format!("Solving adaptive truncated CTMC ({}) ...  ", engine.engine.title()), spec),
    })
}

/// The total-population caps the truncated CTMC may try, and its state budget.
const SCALE_MAX_CAP: i64 = 64;
const SCALE_STATE_BUDGET: f64 = 200_000.0;

/// `truncatedCTMCScaleIssue`: for an infinite-buffer network whose tractability is exact and
/// labelled Jackson, with more than one station, the sentence refusing the run when the exact mean
/// population exceeds three quarters of the largest total-population cap whose state count
/// C(cap + d, d) fits the 200,000-state budget (METH-035); otherwise `None`.
pub(crate) fn truncated_ctmc_scale_issue(ctx: &RunContext) -> Option<String> {
    if !ctx.network.infinite_buffers {
        return None;
    }
    // The cleared flags (a failed analysis) are not exact, so no check is made.
    let flags = ctx.flags()?;
    // `localizedCaseInsensitiveContains("Jackson")`; the labels are ASCII.
    if !flags.tractability_is_exact || !flags.tractability_means_label.to_lowercase().contains("jackson") {
        return None;
    }
    let dimension = ctx.network.nodes_of(NodeKind::Station).count();
    if dimension <= 1 {
        return None;
    }
    let state_count = |cap: i64| -> f64 {
        let mut value = 1.0f64;
        for k in 1..=dimension {
            value *= (cap + k as i64) as f64 / k as f64;
        }
        value
    };
    let mut feasible_cap = 1;
    for cap in 1..=SCALE_MAX_CAP {
        if state_count(cap) <= SCALE_STATE_BUDGET {
            feasible_cap = cap;
        }
    }
    let exact_mean = flags.tractability_means.iter().fold(0.0, |sum, m| sum + m);
    // `guard exactMean > 0.75 * cap`: a NaN mean fails the guard.
    if exact_mean.partial_cmp(&(0.75 * feasible_cap as f64)) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    // `Int(x.rounded())`: to nearest, ties away from zero.
    let states = state_count(feasible_cap).round() as i64;
    Some(format!(
        "The exact Jackson mean population is {} customers, while the 200,000-state budget only reaches total population {feasible_cap} (about {} states). That boundary lies inside the distribution's main mass, so truncation cannot be reliable. Run Exact Open Product Form instead; it is exact and does not enumerate the infinite state space.",
        icu_fixed(exact_mean, 1),
        icu_integer(states)
    ))
}

/// `runGenericCTMC`.
fn generic_ctmc(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    // 0.90.34 says "Python solver runtime unavailable" even when the C engine is the one missing
    // (METH-103); the wording is kept.
    let Some(engine) = resolve_engine(
        ctx,
        DualEngineMethod::FiniteGenericCtmc,
        ctx.settings.engine_ctmc,
        "Exact sparse CTMC aborted: Python solver runtime unavailable.",
        &mut lines,
    ) else {
        return Prepared::Refused(lines);
    };
    let input = match finite_markov::generic_ctmc(&ctx.network, &ctx.title, &GenericCtmcOptions::default()) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("Exact sparse CTMC not started: {}", e.message()), None, Severity::Warning);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("qnet_ctmc_{}.json", ctx.uuid()), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                &format!("Exact sparse CTMC aborted: could not write the solver input file: {reason}"),
                None,
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    let spec = launch_spec(&engine.launch).arg(&path).args(["--top-states", "0"]);
    Prepared::Launch(PreparedRun {
        method: Method::GenericCtmc,
        parameters: parameters(&[
            ("blocking", "loss"),
            ("service discipline", "FCFS"),
            ("max reachable states", "200000"),
            ("stationary tolerance", "1e-12"),
            ("engine", engine.engine.title()),
            ("runtime", &engine.provenance),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!(
            "Running exact sparse CTMC on the {} (queue process, loss on full).",
            engine.engine.descriptive_name()
        ))],
        temps,
        body: spinner_body(format!("Solving exact CTMC ({}) ...  ", engine.engine.title()), spec),
    })
}

/// `runFiniteDecomposition`.
fn finite_decomposition(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    let lookup =
        ctx.resolver.resolve_python_support_file_in("fbna_decomp.py", "fBNAdecomp", &["finite"], &PythonRequest::default());
    let Some(launch) = python_launch(&lookup) else {
        blocked(
            &mut lines,
            "Finite-buffer decomposition aborted: Python solver runtime unavailable.",
            Some(&lookup.actionable_diagnostic()),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let (blocking, display) = match ctx.settings.sim_blocking {
        0 => (Blocking::Loss, "Loss"),
        1 => (Blocking::Bas, "BAS approximation"),
        _ => (Blocking::BasExternalLoss, "BAS + external loss approximation"),
    };
    let input =
        match finite_markov::decomposition(&ctx.network, &ctx.title, blocking, &DecompositionOptions::default()) {
            Ok(input) => input,
            Err(e) => {
                blocked(
                    &mut lines,
                    &format!("Finite-buffer decomposition not started: {}", e.message()),
                    None,
                    Severity::Warning,
                );
                return Prepared::Refused(lines);
            }
        };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("qnet_decomp_{}.json", ctx.uuid()), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                &format!("Finite-buffer decomposition aborted: could not write the solver input file: {reason}"),
                None,
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    let spec = launch_spec(&launch).arg(&path).args(["--format", "text"]);
    let approximation = if ctx.settings.sim_blocking != 0 { "true" } else { "false" };
    Prepared::Launch(PreparedRun {
        method: Method::FiniteDecomposition,
        parameters: parameters(&[
            ("blocking", display),
            ("fixed-point tolerance", "1e-10"),
            ("maximum iterations", "1000"),
            ("damping", "0.5"),
            ("BAS is approximation", approximation),
            ("runtime", &runtime(&lookup)),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running finite-buffer decomposition ({display})."))],
        temps,
        body: spinner_body("Solving finite decomposition ...  ".into(), spec),
    })
}

// ─── Helpers shared by the exact-family files ───────────────────────────────────────────────────

/// `reportBlocked(summary, detail:, severity:)`: the summary at its severity, then each non-empty
/// line of the trimmed detail, itself trimmed and indented by four spaces, at info, unless the
/// summary already contains the whole trimmed detail.
pub(super) fn blocked(lines: &mut Vec<StatusLine>, summary: &str, detail: Option<&str>, severity: Severity) {
    lines.push(StatusLine::new(summary, severity));
    let Some(detail) = detail else { return };
    let trimmed = detail.trim();
    if trimmed.is_empty() || summary.contains(trimmed) {
        return;
    }
    for line in trimmed.split('\n') {
        // `.whitespaces`: spaces and tabs, not line breaks.
        let text = line.trim_matches(|c: char| c.is_whitespace() && !matches!(c, '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}'));
        if !text.is_empty() {
            lines.push(StatusLine::info(format!("    {text}")));
        }
    }
}

/// The record's parameters from string pairs.
pub(super) fn parameters(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// `lookup.resolution?.provenanceDescription ?? "unknown"`.
pub(super) fn runtime(lookup: &SolverLookup) -> String {
    lookup.resolution.as_ref().map_or_else(|| "unknown".to_string(), |r| r.provenance_description())
}

/// The `<python> -B <script>` prefix of a Python solver, when both the script and an interpreter
/// resolved (`guard let solver = lookup.url, let python = lookup.resolution?.runtimeExecutableURL`).
pub(super) fn python_launch(lookup: &SolverLookup) -> Option<LaunchPrefix> {
    lookup.resolution.as_ref()?.runtime_executable.as_ref()?;
    lookup.launch_prefix()
}

/// A process spec starting with a launch prefix.
pub(super) fn launch_spec(prefix: &LaunchPrefix) -> ProcessSpec {
    ProcessSpec::new(&prefix.program).args(prefix.args.iter().cloned())
}

/// `resolveEngine` for a dual-engine method, as its four callers used it: the engine the stored
/// setting names, or the other one with its fallback note written as a warning; when neither
/// resolves, `refusal` is reported with the both-engine sentence as its detail and `None` returned.
pub(super) fn resolve_engine(
    ctx: &RunContext,
    method: DualEngineMethod,
    stored: i64,
    refusal: &str,
    lines: &mut Vec<StatusLine>,
) -> Option<ResolvedEngine> {
    match ctx.resolver.resolve_engine(method, SolverEngine::from_stored(stored)) {
        Ok(engine) => {
            if let Some(note) = &engine.note {
                lines.push(StatusLine::warning(note.clone()));
            }
            Some(engine)
        }
        Err(unavailable) => {
            blocked(lines, refusal, Some(&unavailable.diagnostic), Severity::Error);
            None
        }
    }
}

/// Writes a solver input `text` to `<temp folder>/<file>` and registers it for removal. The error
/// is the reason 0.90.34's `String.write(to:atomically:encoding:)` gave (see [`cocoa_write_error`]).
pub(super) fn write_input(ctx: &RunContext, file: &str, text: &str, temps: &mut TempFiles) -> Result<PathBuf, String> {
    let path = ctx.temp_path(file);
    match std::fs::write(&path, text) {
        Ok(()) => Ok(temps.add(path)),
        Err(e) => {
            // A partial file must not stay behind.
            let _ = std::fs::remove_file(&path);
            Err(cocoa_write_error(&path, &e))
        }
    }
}

/// Foundation's `localizedDescription` for a failed atomic write of `path`, as measured on macOS
/// 27.2: a missing folder, a folder without write permission, and anything else.
pub(super) fn cocoa_write_error(path: &Path, e: &io::Error) -> String {
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let file = name(path);
    let folder = path.parent().map(name).unwrap_or_default();
    match e.kind() {
        io::ErrorKind::NotFound => format!("The folder “{file}” doesn’t exist."),
        io::ErrorKind::PermissionDenied => {
            format!("You don’t have permission to save the file “{file}” in the folder “{folder}”.")
        }
        _ => format!("The file “{file}” couldn’t be saved in the folder “{folder}”."),
    }
}

/// The body of a spinner-wrapped run, as `runScript(withSpinner(prefix, commandWithCleanup(solve)))`
/// ran it: the spinner while the solver runs, its `[done]` frame, the solver's merged standard
/// output and error, then the "Elapsed time" line; the exit status is the solver's.
pub(super) fn spinner_body(prefix: String, process: ProcessSpec) -> RunBody {
    let step = Step::new(process.stderr(StderrTarget::MergeWithStdout));
    Box::new(move |job: &mut Job| {
        let outcome = match run_with_spinner(job, &prefix, &step) {
            Ok(outcome) => outcome,
            Err(e) => return could_not_start(job, &e),
        };
        finish(job, outcome.interrupted(), outcome.shell_code())
    })
}

/// A spawn failure: logged as 0.90.34's `failRunToLaunch` worded it, exit status −1, and the
/// "Elapsed time" line the wrapper always printed.
pub(super) fn could_not_start(job: &mut Job, e: &io::Error) -> i32 {
    let message = format!("{} could not start: {e}", job.display_label());
    job.could_not_start(message);
    job.emit_elapsed_footer();
    -1
}

/// The end of `runScript`'s wrapper: "Elapsed time" after the command, unless Stop interrupted the
/// solver (then the wrapper died with it and printed nothing more). Returns `code`.
pub(super) fn finish(job: &mut Job, interrupted: bool, code: i32) -> i32 {
    if !interrupted {
        job.emit_elapsed_footer();
    }
    code
}

// ─── ICU number styles (Foundation's FormatStyle, en_US) ───────────────────────────────────────
//
// Three Status sentences format numbers with Swift's `formatted(...)`. Measured on macOS 27.2,
// Swift 6.4.2, locale en_US: ICU starts from the shortest decimal that round-trips the Double (not
// its exact binary value), rounds half to even, groups the integer part in threes with commas, and
// writes scientific notation as `1.00E-5` (no plus sign, no exponent padding).

/// The shortest round-trip decimal of `|x|` as digits d0 d1 … and the exponent e of d0 (the value
/// is d0.d1d2… × 10^e), with the sign. Zero is no digits.
fn shortest_decimal(x: f64) -> (bool, Vec<u8>, i32) {
    let negative = x.is_sign_negative();
    if x == 0.0 {
        return (negative, Vec::new(), 0);
    }
    let text = format!("{:e}", x.abs());
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).map(|b| b - b'0').collect();
    (negative, digits, exponent.parse().unwrap_or(0))
}

/// Rounds `digits` (exponent `e` as in [`shortest_decimal`]) to its first `keep` digits, half to
/// even, and drops trailing zeros. Returns the digits (empty for zero) and the new exponent.
fn round_half_even(digits: &[u8], e: i32, keep: i64) -> (Vec<u8>, i32) {
    if keep >= digits.len() as i64 {
        return trim_zeros(digits.to_vec(), e);
    }
    if keep < 0 {
        return (Vec::new(), 0);
    }
    let keep = keep as usize;
    let mut kept = digits[..keep].to_vec();
    let first = digits[keep];
    let rest_nonzero = digits[keep + 1..].iter().any(|&d| d != 0);
    let last_odd = kept.last().is_some_and(|d| d % 2 == 1);
    let up = first > 5 || (first == 5 && (rest_nonzero || last_odd));
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
    trim_zeros(kept, e)
}

fn trim_zeros(mut digits: Vec<u8>, e: i32) -> (Vec<u8>, i32) {
    while digits.last() == Some(&0) {
        digits.pop();
    }
    if digits.is_empty() {
        return (digits, 0);
    }
    (digits, e)
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

/// `x.formatted(.number.precision(.fractionLength(f)))`.
pub(super) fn icu_fixed(x: f64, fraction: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-∞".into() } else { "∞".into() };
    }
    let (negative, digits, e) = shortest_decimal(x);
    // Keep the digits whose place is at least 10^-fraction.
    let keep = if digits.is_empty() { 0 } else { e as i64 + 1 + fraction as i64 };
    let (digits, e) = round_half_even(&digits, e, keep);
    let place = |p: i32| -> char {
        // The digit with place value 10^p.
        let index = e as i64 - p as i64;
        if index >= 0 && (index as usize) < digits.len() {
            (b'0' + digits[index as usize]) as char
        } else {
            '0'
        }
    };
    let top = if digits.is_empty() { 0 } else { e.max(0) };
    let int_part: String = (0..=top).rev().map(place).collect();
    let frac_part: String = (1..=fraction as i32).map(|p| place(-p)).collect();
    let sign = if negative { "-" } else { "" };
    if fraction == 0 {
        format!("{sign}{}", group(&int_part))
    } else {
        format!("{sign}{}.{frac_part}", group(&int_part))
    }
}

/// `x.formatted(.number.notation(.scientific).precision(.significantDigits(n)))`.
pub(super) fn icu_scientific(x: f64, significant: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-∞".into() } else { "∞".into() };
    }
    let significant = significant.max(1);
    let (negative, digits, e) = shortest_decimal(x);
    let (mut digits, e) = round_half_even(&digits, e, significant as i64);
    let e = if digits.is_empty() { 0 } else { e };
    digits.resize(significant, 0);
    let text: Vec<char> = digits.iter().map(|d| (b'0' + d) as char).collect();
    let sign = if negative { "-" } else { "" };
    let mantissa = if significant == 1 {
        text[0].to_string()
    } else {
        format!("{}.{}", text[0], text[1..].iter().collect::<String>())
    };
    format!("{sign}{mantissa}E{e}")
}

/// `n.formatted()` for an `Int`.
pub(super) fn icu_integer(n: i64) -> String {
    let sign = if n < 0 { "-" } else { "" };
    format!("{sign}{}", group(&n.unsigned_abs().to_string()))
}

/// One source (λ = 0.5), an infinite buffer, one exponential station (μ = 1), a sink.
#[cfg(test)]
pub(super) const MM1_INFINITE: &str = r#"{"canvasScale":1,"infiniteBuffers":true,"links":[
        {"customerClass":0,"fromNodeID":"EE000001-0001-0001-0001-000000000001","id":"EE000001-0001-0001-2222-000000000001","routingProbability":1,"toNodeID":"EE000001-0001-0001-0001-000000000002"},
        {"customerClass":0,"fromNodeID":"EE000001-0001-0001-0001-000000000002","id":"EE000001-0001-0001-2222-000000000002","routingProbability":1,"toNodeID":"EE000001-0001-0001-0001-000000000003"},
        {"customerClass":0,"fromNodeID":"EE000001-0001-0001-0001-000000000003","id":"EE000001-0001-0001-2222-000000000003","routingProbability":1,"toNodeID":"EE000001-0001-0001-0001-000000000004"}],
      "nodes":[
        {"bufferSize":1,"distribution":"poisson","distributionParameters":"lambda=0.5","id":"EE000001-0001-0001-0001-000000000001","kind":"source","name":"Src1","numberOfServers":1,"position":[100,200],"serviceDistributions":{}},
        {"bufferSize":10,"distribution":"exponential","distributionParameters":"rate=1.0","id":"EE000001-0001-0001-0001-000000000002","kind":"buffer","name":"B1","numberOfServers":1,"position":[220,200],"serviceDistributions":{}},
        {"bufferSize":1,"distribution":"exponential","distributionParameters":"rate=1.0","id":"EE000001-0001-0001-0001-000000000003","kind":"station","name":"S1","numberOfServers":1,"position":[340,200],"serviceDistributions":{}},
        {"bufferSize":1,"distribution":"exponential","distributionParameters":"rate=1.0","id":"EE000001-0001-0001-0001-000000000004","kind":"sink","name":"Sink1","numberOfServers":1,"position":[460,200],"serviceDistributions":{}}]}"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::methods::RunSettings;
    use crate::resolver::{Resolver, ResolverConfig};

    #[test]
    fn scientific_numbers_read_as_foundation_wrote_them() {
        // Measured with Swift 6.4.2 on macOS 27.2 (en_US).
        let cases: &[(f64, &str)] = &[
            (1e-10, "1.00E-10"),
            (1e-5, "1.00E-5"),
            (9.999999e-5, "1.00E-4"),
            (3.45e-5, "3.45E-5"),
            (0.000123456, "1.23E-4"),
            (1.235e-6, "1.24E-6"),
            (1.225e-6, "1.22E-6"),
            (1.2250000001e-6, "1.23E-6"),
            (9.995e-5, "1.00E-4"),
            (1.0, "1.00E0"),
            (0.5, "5.00E-1"),
            (0.0, "0.00E0"),
            (2.5e-300, "2.50E-300"),
            (5e-324, "5.00E-324"),
            (1.0000000000000003e-15, "1.00E-15"),
            (1.00499999e-7, "1.00E-7"),
            (1.005e-7, "1.00E-7"),
            (1.015e-7, "1.02E-7"),
            (1.025e-7, "1.02E-7"),
            (7.775e-8, "7.78E-8"),
            (6.665e-9, "6.66E-9"),
            (-1e-5, "-1.00E-5"),
            (1e20, "1.00E20"),
            (12345.0, "1.23E4"),
        ];
        for (x, want) in cases {
            assert_eq!(icu_scientific(*x, 3), *want, "{x:e}");
        }
    }

    #[test]
    fn fixed_numbers_round_the_shortest_decimal_half_to_even_and_group_thousands() {
        let cases: &[(f64, &str)] = &[
            (90.0, "90.0"),
            (135.0, "135.0"),
            (45.0, "45.0"),
            (0.05, "0.0"),
            (0.15, "0.2"),
            (0.25, "0.2"),
            (0.35, "0.4"),
            (0.45, "0.4"),
            (1.25, "1.2"),
            (2.35, "2.4"),
            (1234.56, "1,234.6"),
            (12345678.95, "12,345,679.0"),
            (999.95, "1,000.0"),
            (1e21, "1,000,000,000,000,000,000,000.0"),
            (-0.04, "-0.0"),
            (0.0, "0.0"),
            (9.96, "10.0"),
        ];
        for (x, want) in cases {
            assert_eq!(icu_fixed(*x, 1), *want, "{x}");
        }
        for (n, want) in [(184756, "184,756"), (53130, "53,130"), (1, "1"), (1000, "1,000"), (999, "999"), (1234567, "1,234,567"), (0, "0"), (-5, "-5")] {
            assert_eq!(icu_integer(n), want);
        }
    }

    #[test]
    fn a_blocked_report_indents_its_detail_unless_the_summary_already_says_it() {
        let mut lines = Vec::new();
        blocked(&mut lines, "X aborted: y.", Some("  first\n\n  second line  \n"), Severity::Error);
        assert_eq!(
            lines,
            vec![StatusLine::error("X aborted: y."), StatusLine::info("    first"), StatusLine::info("    second line")]
        );
        let mut lines = Vec::new();
        blocked(&mut lines, "X aborted: y.", Some(" y. "), Severity::Warning);
        assert_eq!(lines, vec![StatusLine::warning("X aborted: y.")]);
    }

    #[test]
    fn a_write_failure_gives_foundations_sentence() {
        let missing = Path::new("/nonexistent-dir-qnet/qnet_qbd_x.json");
        let e = std::fs::write(missing, "x").unwrap_err();
        assert_eq!(cocoa_write_error(missing, &e), "The folder “qnet_qbd_x.json” doesn’t exist.");
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(
            cocoa_write_error(Path::new("/x/ro/BNET_mc_1.bnet"), &denied),
            "You don’t have permission to save the file “BNET_mc_1.bnet” in the folder “ro”."
        );
    }

    fn context(json: &str, temp: &Path) -> RunContext {
        let network = qnet_core::bnet::read(json).expect("network");
        let mut cfg = ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.development_roots = Vec::new();
        cfg.env.insert("QNET_SOLVER_ROOT".into(), temp.as_os_str().to_owned());
        let mut ctx = RunContext::new(network, "unit.bnet", RunSettings::golden(), Arc::new(Resolver::new(cfg)));
        ctx.temp_dir = temp.to_path_buf();
        ctx
    }

    #[test]
    fn an_input_that_cannot_be_written_refuses_the_run_with_the_cocoa_reason() {
        // A one-station M/M/1 product-form network, solver tree pointing at the staged solvers so
        // the lookup succeeds, and a temporary folder that does not exist.
        let Some(home) = std::env::var_os("HOME") else { return };
        let stage = PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources");
        if !stage.join("bin").is_dir() {
            println!("skipped: the staged solvers are absent");
            return;
        }
        let json = super::MM1_INFINITE;
        let mut ctx = context(json, &stage);
        ctx.temp_dir = PathBuf::from("/nonexistent-dir-qnet");
        let Prepared::Refused(lines) = prepare(Method::ProductForm, &ctx) else { panic!("launched") };
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].severity, Severity::Error);
        assert!(lines[0].text.starts_with("Exact product form aborted: could not write the solver input file: The folder “qnet_open_product_form_"));
        assert!(lines[0].text.ends_with(".json” doesn’t exist."));
    }

    #[test]
    fn the_qbd_and_product_form_refuse_a_finite_network_with_their_own_sentences() {
        // The Run menu of a finite network offers neither, so only a direct call reaches this.
        let Some(home) = std::env::var_os("HOME") else { return };
        let stage = PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources");
        if !stage.join("bin").is_dir() {
            println!("skipped: the staged solvers are absent");
            return;
        }
        let json = super::MM1_INFINITE.replace(r#""infiniteBuffers":true"#, r#""infiniteBuffers":false"#);
        let ctx = context(&json, &stage);
        let Prepared::Refused(lines) = prepare(Method::Qbd, &ctx) else { panic!("launched") };
        assert_eq!(
            lines,
            vec![StatusLine::warning("Exact QBD not started: The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.")]
        );
        let Prepared::Refused(lines) = prepare(Method::ProductForm, &ctx) else { panic!("launched") };
        assert_eq!(
            lines,
            vec![StatusLine::warning("Exact product form not started: Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method.")]
        );
        let Prepared::Refused(lines) = prepare(Method::TruncatedCtmc, &ctx) else { panic!("launched") };
        assert_eq!(
            lines,
            vec![StatusLine::warning("Adaptive truncated CTMC not started: This adaptive CTMC method is defined for infinite-buffer networks.")]
        );
    }
}
