//! The two BAR methods on the stationary orthant SRBM: Run Adaptive Low-Rank BAR (`adaptive_bar`,
//! `infinite/BNAalr/low_rank_bar.py`) and Run BAR Moment Bounds (`bar_bounds`,
//! `infinite/BNAbb/solver.py --backend auto --require-bounds`). Ports `runAdaptiveLowRankBAR` and
//! `runBARMomentBounds` in `2_QNET/Sources/Qnet/QnetGUIApp.swift` (ledger METH-087…METH-091).
//!
//! Both are Python-only, need no named module (NumPy is optional for `low_rank_bar.py`, RUN-010),
//! export with `BNASRBMExporter` (`export_for_adaptive_bar` with rank 12, `export_for_bar_bounds`
//! with order 2) to `qnet_<method>_<uuid>.json`, and run under the spinner.
//!
//! The adaptive BAR solver reports workloads E[Z_i]; 0.90.34 converted them to queue lengths
//! L_i = μ_i·E[Z_i] for single-server networks with a one-line awk stage after the solver, or, when
//! a station has more than one server, printed a sentence saying why it did not (METH-088). That
//! text is `qnet_core::output::adaptive_bar` (already ported and checked against the awk program);
//! this file only decides which applies and places it where the wrapper did.
//!
//! How the wrapper placed it, and how 2.0 does: with the awk stage, `python … | awk …` sent the
//! solver's standard output through awk while its standard error went straight to the spinner's
//! capture file; awk, writing to a file, flushed when it ended, after the solver had exited. So the
//! solver's standard error comes first, then its standard output with the L_i rows. With the
//! multi-server sentence the wrapper ran `python … && printf '%s\n' <sentence>`, so the sentence
//! follows the solver's merged output only when the solver succeeded. With neither (no station's
//! capacity known), the solver ran alone.
//!
//! Where 2.0 differs: D1, as for every exact-family method (see `exact.rs`); the conversion is Rust
//! text over the captured output instead of an awk process (RUN-066, Changed); and, under D5, the
//! run's exit status is always the solver's. 0.90.34's pipeline returned awk's status (0) under the
//! L_i stage, so a solver that failed there still "finished" (METH-087, Changed). No golden run is
//! affected: every corpus run of the solver exited 0.

use qnet_core::export::srbm_orthant;
use qnet_core::output::adaptive_bar::{capacities, multi_server_note, multi_server_stations, queue_length_rows};

use crate::resolver::PythonRequest;
use crate::supervisor::{Job, ProcessSpec, Severity, StderrTarget, Step, TempFiles};

use super::exact::{blocked, could_not_start, finish, launch_spec, parameters, python_launch, runtime, spinner_body, write_input};
use super::shell::run_with_spinner;
use super::{Method, Prepared, PreparedRun, RunBody, RunContext, StatusLine};

/// The adaptive BAR's maximum mixture rank and the bounds' relaxation order (0.90.34's defaults).
const MAX_RANK: i64 = 12;
const RELAXATION_ORDER: i64 = 2;

/// Prepares one of the two BAR methods.
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    match method {
        Method::AdaptiveBar => adaptive_bar(ctx),
        Method::BarBounds => bar_bounds(ctx),
        _ => super::unimplemented_method(method),
    }
}

/// What follows the adaptive BAR solver's output.
#[derive(Debug, Clone, PartialEq)]
enum Conversion {
    /// The awk stage: L_i rows from these capacities (single-server network).
    QueueLengths(Vec<f64>),
    /// The sentence naming the multi-server stations.
    Withheld(String),
    /// Nothing: the station model could not be computed (unreachable once the exporter succeeded).
    None,
}

/// `runAdaptiveLowRankBAR`.
fn adaptive_bar(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    let lookup = ctx.resolver.resolve_python_support_file_in(
        "low_rank_bar.py",
        "BNAalr",
        crate::resolver::DEFAULT_GROUPS,
        &PythonRequest::default(),
    );
    let Some(launch) = python_launch(&lookup) else {
        blocked(&mut lines, "Adaptive low-rank BAR aborted: solver not found.", Some(&lookup.actionable_diagnostic()), Severity::Error);
        return Prepared::Refused(lines);
    };
    let net = &ctx.network;
    let input = match srbm_orthant::export_for_adaptive_bar(&net.nodes, &net.links, &ctx.title, MAX_RANK) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("Adaptive low-rank BAR not started: {}", e.message()), None, Severity::Warning);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("qnet_adaptive_bar_{}.json", ctx.uuid()), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                &format!("Adaptive low-rank BAR aborted: could not write the solver input file: {reason}"),
                None,
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    let multi_server = multi_server_stations(&net.nodes);
    let conversion = if !multi_server.is_empty() {
        Conversion::Withheld(multi_server_note(&multi_server))
    } else {
        match srbm_orthant::compute(&net.nodes, &net.links) {
            // `else if !muList.isEmpty`: the L_i stage only when some capacity is known.
            Ok(data) if !capacities(&data).is_empty() => Conversion::QueueLengths(capacities(&data)),
            _ => Conversion::None,
        }
    };
    let spec = launch_spec(&launch).arg(&path);
    Prepared::Launch(PreparedRun {
        method: Method::AdaptiveBar,
        parameters: parameters(&[
            ("model layer", "stationary orthant SRBM"),
            ("maximum mixture rank", "12"),
            ("training BAR points", "max(64, 6 × dimension)"),
            ("held-out BAR points", "max(32, 6 × dimension)"),
            ("BAR tolerance", "2e-5"),
            ("moment-change tolerance", "2e-3"),
            ("certified error bound", "false except exact product form"),
            ("runtime", &runtime(&lookup)),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info("Running adaptive low-rank BAR (SRBM; held-out numerical diagnostics).")],
        temps,
        body: adaptive_bar_body(spec, conversion),
    })
}

const ADAPTIVE_BAR_PREFIX: &str = "Fitting adaptive low-rank BAR ...  ";

/// The adaptive BAR's run: the spinner, then the solver's output with the conversion after it.
fn adaptive_bar_body(spec: ProcessSpec, conversion: Conversion) -> RunBody {
    match conversion {
        Conversion::None => spinner_body(ADAPTIVE_BAR_PREFIX.into(), spec),
        Conversion::Withheld(note) => {
            // `solve && printf '%s\n' <note>`, merged into the spinner's capture.
            let step = Step::new(spec.stderr(StderrTarget::MergeWithStdout));
            Box::new(move |job: &mut Job| {
                let outcome = match run_with_spinner(job, ADAPTIVE_BAR_PREFIX, &step) {
                    Ok(outcome) => outcome,
                    Err(e) => return could_not_start(job, &e),
                };
                let code = outcome.shell_code();
                if code == 0 {
                    job.emit_str(&note);
                    job.emit_str("\n");
                }
                finish(job, outcome.interrupted(), code)
            })
        }
        Conversion::QueueLengths(capacities) => {
            // `solve | awk …`: standard error straight to the capture, standard output through awk.
            let step = Step::new(spec.stderr(StderrTarget::Capture)).quiet();
            Box::new(move |job: &mut Job| {
                let outcome = match run_with_spinner(job, ADAPTIVE_BAR_PREFIX, &step) {
                    Ok(outcome) => outcome,
                    Err(e) => return could_not_start(job, &e),
                };
                if outcome.interrupted() {
                    return finish(job, true, outcome.shell_code());
                }
                job.emit(&outcome.stderr);
                let rows = queue_length_rows(&String::from_utf8_lossy(&outcome.stdout), &capacities);
                job.emit_str(&rows);
                // D5: the solver's status, not the pipeline's (awk's 0).
                finish(job, false, outcome.shell_code())
            })
        }
    }
}

/// `runBARMomentBounds`.
fn bar_bounds(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    let lookup =
        ctx.resolver.resolve_python_support_file_in("solver.py", "BNAbb", crate::resolver::DEFAULT_GROUPS, &PythonRequest::default());
    let Some(launch) = python_launch(&lookup) else {
        blocked(&mut lines, "BAR moment bounds aborted: solver not found.", Some(&lookup.actionable_diagnostic()), Severity::Error);
        return Prepared::Refused(lines);
    };
    let net = &ctx.network;
    let input = match srbm_orthant::export_for_bar_bounds(&net.nodes, &net.links, &ctx.title, RELAXATION_ORDER) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("BAR moment bounds not started: {}", e.message()), None, Severity::Warning);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("qnet_bar_bounds_{}.json", ctx.uuid()), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                &format!("BAR moment bounds aborted: could not write the solver input file: {reason}"),
                None,
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    let spec = launch_spec(&launch).arg(&path).args(["--backend", "auto", "--require-bounds"]);
    Prepared::Launch(PreparedRun {
        method: Method::BarBounds,
        parameters: parameters(&[
            ("model layer", "stationary orthant SRBM"),
            ("moment-relaxation order", "2"),
            ("backend", "auto (CVXPY when available)"),
            ("certification", "exact 1D/product form only; floating SDP results uncertified"),
            ("runtime", &runtime(&lookup)),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info("Running BAR moment relaxation; certification will be stated in the result.")],
        temps,
        body: spinner_body("Constructing BAR moment bounds ...  ".into(), spec),
    })
}
