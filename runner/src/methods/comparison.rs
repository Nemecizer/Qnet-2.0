//! Run Comparison, the Run menu's first item in both buffer modes: every method that applies,
//! run one after another on the same network, then one table with a column per method. The
//! infinite-buffer comparison (`inf_cmp`: spectral `bnet`, Whitt QNA `bna_qna`, Whitt–You RQNA
//! `bna_rqna`, SBD `bna_sbd`, the `jackson_sim` simulation) ports `runComparisonInfinite`, and the
//! finite-buffer one (`cmp`: spectral `srbm_solver`, finite elements `bna_fm_gauss` or
//! `bna_fm_cbc`, the optional finite LP `fBNAlp_solver`, the optional exact loss-tandem CTMC
//! `ctmc_dtandem.py`, the `fBNAsim` simulation) ports both halves of `runComparison` with
//! `buildCTMCRunCommand`, all in `2_QNET/Sources/Qnet/QnetGUIApp.swift` (ledger METH-116…METH-131).
//! The helpers they called are here too (`spectralResourceIssue`, the 2 GB guard that skips the
//! spectral column, is shared with Run › Spectral Method and lives in `single/infinite.rs` with
//! Foundation's measured number styles): `stationOrder`, the `independentStep` and `skippedStep`
//! shell fragments and the `QNET_COMPARISON_STATUS_V1` trailer, and `StatusEntry.inferSeverity` for the one Status line
//! whose severity 0.90.34 inferred from its wording. The table, the banners above it and the
//! analytical hand-over are `qnet_core::output` (`buildComparisonAwk`, `regimeHeader`,
//! `tractabilityHeader`, `writeAnalyticalFile`, `threadCountBannerMixed`).
//!
//! 0.90.34 built the comparison's own commands rather than calling the single-method runs, so this
//! file does too: the solvers, their flags, the input and output file names, the padded progress
//! prefixes, the Status sentences with their severities and order, and the parameters, seed and
//! replication seeds the record keeps are 0.90.34's.
//!
//! Where 2.0 differs, deliberately:
//!
//! - D1: each solver is started as an argument vector by the supervisor, not typed into the user's
//!   shell, so the shell fragments that kept the infinite comparison's columns independent
//!   (`CMP_FAILED`, `CMP_SUCCEEDED`, the failure markers written into a column's output file) are
//!   plain Rust here. Inputs, outputs, progress files and `jackson_sim`'s `<input>_results.txt` are
//!   registered with the run's temporary-file guard and removed on every exit path; 0.90.34 left
//!   most of them in the temporary folder (RUN-021, RUN-022, Changed). The analytical column is
//!   handed to the table as text, not through `BNET_analytical_<pid>.txt` (FILE-027, Changed).
//! - METH-122 (D5, the owner's decision of 2026-11-10): 0.90.34 chained the finite comparison's
//!   solvers with `&&`, so the first failure stopped the run before the table. Here each finite
//!   step runs on its own, as the infinite ones always did: a failing column is marked
//!   `QNET_METHOD_FAILURE_V1 method=<token> exit=N`, "<Label> failed; continuing with independent
//!   methods." is printed and the next solver runs; the table prints whatever finished. When
//!   something failed the table is followed by `QNET_COMPARISON_STATUS_V1 partial=yes …` (so the
//!   record is Partial), and when nothing succeeded by `… successful=0 failed=all` and exit status
//!   70, as the infinite comparison ends. A finite comparison in which every step succeeds prints
//!   exactly what 0.90.34 printed, with no trailer. The finite tokens are `spectral`,
//!   `finite-element`, `finite-lp` and `simulation`; the CTMC column keeps 0.90.34's own tolerant
//!   handling (`failed=ctmc`).
//! - The LP's CSV files (`BNET_cmp_lp_csv_<pid>_marginal_*.csv`, `…_distribution.csv`) are removed
//!   however the run ends; 0.90.34 removed them only when every step had succeeded (FILE-031).
//! - The blocking-regime sheet (METH-117, METH-118) is P6. A run here uses `sim.blocking`, which
//!   is what 0.90.34 used with `runCompare.remember` on and what the sheet offered as its initial
//!   value; the sheet answers by setting `sim_blocking` in the context's settings before
//!   preparing (and stores it, with `runCompare.remember`, only when "Skip this dialog" is ticked).
//! - `spectralResourceIssue` trapped (`Int64(Double)` overflow) when the basis matrix needed 2^63
//!   bytes or more, which a network of about seventy stations reaches at degree 8; the shared guard
//!   clamps the size to the largest Int64, which Foundation prints as "8 EB" (METH-052, D5).
//! - A solver that resolved but then cannot be spawned (removed in between) is a failed column
//!   with exit status 127 (126 when it is not executable), as bash reported it, and its stderr text
//!   is "<path>: could not start: <reason>" instead of bash's own sentence.

// The loops index as 0.90.34 did, and `!(x > y)` keeps Swift's NaN behaviour in its guards.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use qnet_core::cfmt;
use qnet_core::export::{fbnasim, jackson_sim, qna, srbm_box, srbm_orthant};
use qnet_core::model::{Distribution, NodeKind};
use qnet_core::output::{banner, table};
use qnet_core::traffic::{self, SrbmData};

use crate::resolver::{LaunchPrefix, PythonRequest};
use crate::supervisor::{stderr_report, Job, ProcessSpec, Severity, StderrTarget, Step, TempFiles};

use super::exact::{blocked, parameters, python_launch, runtime, write_input};
use super::shell::{progress_last_frame, run_with_progress, run_with_spinner};
use super::single::spectral_resource_issue;
use super::{Method, Prepared, PreparedRun, RunContext, StatusLine};

/// Prepares Run Comparison for either buffer mode.
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    match method {
        Method::InfiniteComparison => infinite(ctx),
        Method::FiniteComparison => finite(ctx),
        _ => super::unimplemented_method(method),
    }
}

// ─── The comparison's steps ─────────────────────────────────────────────────────────────────────

/// One argument of a solver's command line: text, or the step's progress file (`-P <file>`),
/// which only exists once the run has started.
#[derive(Debug, Clone)]
enum Arg {
    Text(OsString),
    Progress,
}

fn text(s: impl Into<OsString>) -> Arg {
    Arg::Text(s.into())
}

/// How the Shell showed a running step: `withProgress` (a bar fed by the solver's `-P` file,
/// named `BNET_progress_<label>_<pid>_<µs>.bin`) or `withSpinner`.
#[derive(Debug, Clone, Copy)]
enum Frame {
    Progress(&'static str),
    Spinner,
}

/// One solver of a comparison, as the wrapper ran it under `runWithStderrOnFailure`.
#[derive(Debug, Clone)]
struct Solver {
    /// The program and its leading arguments (`<python> -B <script>` for the CTMC).
    launch: LaunchPrefix,
    args: Vec<Arg>,
    env: Vec<(OsString, OsString)>,
    /// `runWithStderrOnFailure`'s label ("Spectral Method", "QNA").
    stderr_label: &'static str,
    /// The file its standard output went to (`BNET_inf_cmp_sm_out_<pid>.txt`).
    output: PathBuf,
    /// The padded progress prefix ("Running QNA ...              ").
    prefix: String,
    frame: Frame,
}

/// A table column that runs a solver, or was skipped before the run (infinite comparison only).
#[derive(Debug, Clone)]
enum Plan {
    Run(Solver),
    Skip(String),
}

/// One column of the comparison: its header, its failure token, and what it runs.
#[derive(Debug, Clone)]
struct Column {
    /// The table header and the "<Label> failed; …" / "<Label> skipped: …" label.
    label: String,
    /// The token of `QNET_METHOD_FAILURE_V1 method=<token>` and of `failed=<tokens>`.
    token: &'static str,
    plan: Plan,
    /// SBD only: whether the `QNET_SBD_STATUS_V1 fallback_used=yes` check follows the step.
    sbd_fallback_check: bool,
}

/// What a step ended as.
enum Ended {
    /// It exited 0; this is its output file's text.
    Output(String),
    /// It exited with this non-zero status (its stderr policy has run).
    Failed(i32),
    /// Stop ended it (or prevented it); the run ends with this status.
    Interrupted(i32),
}

/// Runs one solver under its frame, applying the stderr policy, and reads its output file.
fn run_solver(job: &mut Job, s: &Solver) -> Ended {
    let progress = match s.frame {
        Frame::Progress(label) => Some(job.progress_file(label)),
        Frame::Spinner => None,
    };
    let mut spec = ProcessSpec::new(&s.launch.program).args(s.launch.args.iter().cloned());
    for a in &s.args {
        spec = match a {
            Arg::Text(t) => spec.arg(t.clone()),
            Arg::Progress => spec.arg(progress.clone().unwrap_or_default().into_os_string()),
        };
    }
    for (k, v) in &s.env {
        spec = spec.env(k.clone(), v.clone());
    }
    let spec = spec.stdout_to(&s.output).stderr(StderrTarget::Capture);
    let mut step = Step::new(spec).stderr_policy(s.stderr_label);
    if let Some(p) = &progress {
        step = step.progress(p);
    }
    let result = match s.frame {
        Frame::Progress(_) => run_with_progress(job, &s.prefix, &step),
        Frame::Spinner => run_with_spinner(job, &s.prefix, &step),
    };
    match result {
        Ok(outcome) if outcome.interrupted() => Ended::Interrupted(outcome.shell_code()),
        Ok(outcome) => match outcome.shell_code() {
            0 => Ended::Output(read_text(&s.output)),
            code => Ended::Failed(code),
        },
        Err(e) => Ended::Failed(could_not_spawn(job, s, &e)),
    }
}

/// A solver that resolved but could not be spawned: the status bash gave such a command (127 for
/// a missing file, 126 otherwise), reported through the stderr policy as any failure is. The
/// spinner has already drawn its last frame; the progress bar draws it after the failure text,
/// as the wrapper did.
fn could_not_spawn(job: &mut Job, s: &Solver, e: &io::Error) -> i32 {
    let code = if e.kind() == io::ErrorKind::NotFound { 127 } else { 126 };
    let stderr = format!("{}: could not start: {e}\n", s.launch.program.display());
    let report = stderr_report(s.stderr_label, code, stderr.as_bytes());
    job.emit(&report.display);
    for (line, severity) in report.status {
        job.status(line, severity);
    }
    if let Frame::Progress(_) = s.frame {
        job.emit_str(&progress_last_frame(&s.prefix, None, Duration::ZERO));
    }
    code
}

/// A file's text, or nothing when it cannot be read.
fn read_text(path: &Path) -> String {
    std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

/// What the columns came to: each column's output text (or its failure marker) in order, how many
/// succeeded (`CMP_SUCCEEDED`) and the failure tokens (`CMP_FAILED`).
#[derive(Default)]
struct Tally {
    outputs: Vec<String>,
    succeeded: usize,
    failed: Vec<String>,
}

impl Tally {
    /// `independentStep` / `skippedStep`: runs (or skips) one column and records what it came to.
    /// Returns the status to end the run with when Stop interrupted it.
    fn column(&mut self, job: &mut Job, c: &Column) -> Option<i32> {
        match &c.plan {
            Plan::Skip(reason) => {
                job.emit_str(&format!("{} skipped: {reason}\n", c.label));
                self.outputs.push(format!("QNET_METHOD_FAILURE_V1 method={} skipped=yes reason={reason}\n", c.token));
                self.failed.push(c.token.to_string());
            }
            Plan::Run(s) => match run_solver(job, s) {
                Ended::Interrupted(code) => return Some(code),
                Ended::Failed(code) => {
                    self.outputs.push(format!("QNET_METHOD_FAILURE_V1 method={} exit={code}\n", c.token));
                    self.failed.push(c.token.to_string());
                    job.emit_str(&format!("{} failed; continuing with independent methods.\n", c.label));
                }
                Ended::Output(text) => {
                    self.succeeded += 1;
                    self.outputs.push(text);
                }
            },
        }
        if c.sbd_fallback_check {
            let used = self.outputs.last().is_some_and(|o| o.lines().any(|l| l.starts_with("QNET_SBD_STATUS_V1 fallback_used=yes")));
            if used {
                self.failed.push("sbd-fallback".into());
                job.emit_str("SBD used a fallback after an internal spectral subproblem failed; retaining it as a partial column.\n");
            }
        }
        None
    }

    /// The `QNET_COMPARISON_STATUS_V1` line, and whether nothing succeeded (exit 70).
    fn trailer(&self) -> (String, bool) {
        if self.succeeded == 0 {
            ("QNET_COMPARISON_STATUS_V1 partial=yes successful=0 failed=all\n".into(), true)
        } else if !self.failed.is_empty() {
            (format!("QNET_COMPARISON_STATUS_V1 partial=yes successful={} failed={}\n", self.succeeded, self.failed.join(",")), false)
        } else {
            (format!("QNET_COMPARISON_STATUS_V1 partial=no successful={}\n", self.succeeded), false)
        }
    }
}

/// Everything after the solvers: the blank line, the banners and the table (`echo`, then
/// `regimeHeader && tractabilityHeader && <awk>`).
struct TableText {
    labels: Vec<String>,
    spec: table::TableSpec,
    banner: String,
}

impl TableText {
    fn new(ctx: &RunContext, labels: Vec<String>, var_name: table::VarName) -> Self {
        let n = &ctx.network;
        let flags = ctx.flags();
        let (tractable, detail, means, label, exact) = match &flags {
            Some(f) => (
                f.is_analytically_tractable,
                f.tractability_detail.as_str(),
                f.tractability_means.as_slice(),
                f.tractability_means_label.clone(),
                f.tractability_is_exact,
            ),
            None => (false, "", &[][..], String::new(), false),
        };
        let data = ctx.analysis_data();
        let analytical = table::analytical_file(tractable, means, data.as_ref(), var_name);
        let regime = banner::regime_lines(&n.nodes, &n.links, var_name == table::VarName::Q);
        let tractability = banner::tractability_line(tractable, detail);
        TableText {
            labels,
            spec: table::TableSpec {
                columns: Vec::new(),
                var_name,
                show_gamma: true,
                show_sojourn: true,
                show_xclass: false,
                analytical,
                analytical_label: Some(label),
                analytical_is_exact: exact,
                show_average: true,
                decimals: ctx.settings.output_decimals,
            },
            banner: banner::table_banner(&regime, tractability.as_deref()),
        }
    }

    fn emit(mut self, job: &mut Job, outputs: Vec<String>) {
        self.spec.columns = self.labels.into_iter().zip(outputs).map(|(label, output)| table::MethodColumn { label, output }).collect();
        job.emit_str("\n");
        job.emit_str(&self.banner);
        job.emit_str(&table::comparison_table(&self.spec));
    }
}

/// Pads every progress prefix to one width, so the bars line up: the longest label plus two.
fn padder(labels: &[&str]) -> impl Fn(&str) -> String {
    let width = labels.iter().map(|l| l.chars().count()).max().unwrap_or(0) + 2;
    move |s: &str| format!("{s}{}", " ".repeat(width.saturating_sub(s.chars().count())))
}

/// The comparison's seed: `sim.seed` (at least 0) when fixed, else a fresh one in 1…Int32.max.
fn comparison_seed(ctx: &RunContext) -> u64 {
    if ctx.settings.sim_seed_fixed {
        ctx.settings.sim_seed.max(0) as u64
    } else {
        ctx.random_in(1, i32::MAX as u64)
    }
}

/// A resolved native solver's path (`findBinary`).
fn find_binary(ctx: &RunContext, name: &str, subdirectory: &str) -> Option<PathBuf> {
    ctx.resolver.resolve_executable(name, subdirectory).url().map(Path::to_path_buf)
}

fn native(path: &Path) -> LaunchPrefix {
    LaunchPrefix { program: path.to_path_buf(), args: Vec::new() }
}

// ─── Run Comparison, infinite buffers ───────────────────────────────────────────────────────────

/// `runComparisonInfinite`.
fn infinite(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    let (nodes, links) = (&ctx.network.nodes, &ctx.network.links);
    let sm_binary = find_binary(ctx, "bnet", "BNAsm");
    let qna_binary = find_binary(ctx, "bna_qna", "BNAqna");
    let sim_binary = find_binary(ctx, "jackson_sim", "BNAsim");
    let sbd_binary = find_binary(ctx, "bna_sbd", "BNAsbd");
    let rqna_binary = find_binary(ctx, "bna_rqna", "BNArqna");
    let degree = ctx.settings.sm_degree;

    let sm = srbm_orthant::export_for_spectral(nodes, links, degree).map_err(|e| e.message());
    let qna = qna::export(nodes, links).map_err(|e| e.message());
    let sim = jackson_sim::export(nodes, links).map_err(|e| e.message());
    if sm.is_err() && qna.is_err() && sim.is_err() {
        let details = [&sm, &qna, &sim].iter().filter_map(|r| r.as_ref().err().cloned()).collect::<Vec<_>>().join("\n\n");
        blocked(&mut lines, "Comparison not started: no method accepted this network.", Some(&details), Severity::Error);
        return Prepared::Refused(lines);
    }

    let pid = ctx.pid;
    let mut temps = TempFiles::new();
    let sm_file = format!("BNET_inf_cmp_sm_{pid}.in");
    let qna_file = format!("BNET_inf_cmp_qna_{pid}.qna");
    let sbd_file = format!("BNET_inf_cmp_sbd_{pid}.qna");
    let rqna_file = format!("BNET_inf_cmp_rqna_{pid}.qna");
    let sim_file = format!("BNET_inf_cmp_sim_{pid}.sim");
    let mut writes: Vec<(&str, &str)> = Vec::new();
    if let Ok(text) = &sm {
        writes.push((sm_file.as_str(), text.as_str()));
    }
    if let Ok(text) = &qna {
        writes.extend([(qna_file.as_str(), text.as_str()), (sbd_file.as_str(), text.as_str()), (rqna_file.as_str(), text.as_str())]);
    }
    if let Ok(text) = &sim {
        writes.push((sim_file.as_str(), text.as_str()));
    }
    for (file, text) in writes {
        if let Err(reason) = write_input(ctx, file, text, &mut temps) {
            blocked(&mut lines, "Comparison (infinite) aborted: could not write temp files.", Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    }
    // jackson_sim writes `<input minus extension>_results.txt` beside its input.
    temps.add(ctx.temp_path(&format!("BNET_inf_cmp_sim_{pid}_results.txt")));
    let mut out = |name: &str| temps.add(ctx.temp_path(&format!("BNET_inf_cmp_{name}_out_{pid}.txt")));
    let (sm_out, qna_out, sbd_out, rqna_out, sim_out) = (out("sm"), out("qna"), out("sbd"), out("rqna"), out("sim"));

    let pad = padder(&["Running spectral method ...", "Running QNA ...", "Running RQNA ...", "Running SBD ...", "Running simulation ..."]);
    let path_arg = |file: &str| text(ctx.temp_path(file).into_os_string());

    let dimension = ctx.network.nodes_of(NodeKind::Station).count();
    let resource = spectral_resource_issue(dimension as i64, degree);
    let spectral = match (&sm_binary, &sm, &resource) {
        (Some(bin), Ok(_), None) => Plan::Run(Solver {
            launch: native(bin),
            args: vec![text("-c"), text("-P"), Arg::Progress, path_arg(&sm_file)],
            env: Vec::new(),
            stderr_label: "Spectral Method",
            output: sm_out,
            prefix: pad("Running spectral method ..."),
            frame: Frame::Progress("inf_cmp_sm"),
        }),
        _ => Plan::Skip(sm.clone().err().or(resource.clone()).unwrap_or_else(|| "solver unavailable".into())),
    };
    let unavailable = |export: &Result<String, String>| export.clone().err().unwrap_or_else(|| "solver unavailable".into());
    let spinner = |bin: &Path, file: &str, label: &'static str, output: PathBuf, prefix: &str| Solver {
        launch: native(bin),
        args: vec![path_arg(file), text("-c")],
        env: Vec::new(),
        stderr_label: label,
        output,
        prefix: pad(prefix),
        frame: Frame::Spinner,
    };
    let qna_plan = match (&qna_binary, &qna) {
        (Some(bin), Ok(_)) => Plan::Run(spinner(bin, &qna_file, "QNA", qna_out, "Running QNA ...")),
        _ => Plan::Skip(unavailable(&qna)),
    };
    let rqna_plan = match (&rqna_binary, &qna) {
        (Some(bin), Ok(_)) => Plan::Run(spinner(bin, &rqna_file, "RQNA", rqna_out, "Running RQNA ...")),
        _ => Plan::Skip(unavailable(&qna)),
    };
    let sbd_plan = match (&sbd_binary, &qna) {
        (Some(bin), Ok(_)) => {
            let mut s = spinner(bin, &sbd_file, "SBD", sbd_out, "Running SBD ...");
            if let Some(bnet) = &sm_binary {
                s.env.push(("BNET_BIN".into(), bnet.clone().into_os_string()));
            }
            Plan::Run(s)
        }
        _ => Plan::Skip(unavailable(&qna)),
    };
    let sbd_ran = matches!(sbd_plan, Plan::Run(_));
    let seed = comparison_seed(ctx);
    let s = &ctx.settings;
    let sim_plan = match (&sim_binary, &sim) {
        (Some(bin), Ok(_)) => Plan::Run(Solver {
            launch: native(bin),
            args: vec![
                path_arg(&sim_file),
                text("-c"),
                text("-n"),
                text(s.sim_replications.to_string()),
                text("-w"),
                text(s.sim_warmup.to_string()),
                text("-r"),
                text(s.sim_time.to_string()),
                text("-s"),
                text(seed.to_string()),
                text("-P"),
                Arg::Progress,
            ],
            env: Vec::new(),
            stderr_label: "Simulation",
            output: sim_out,
            prefix: pad("Running simulation ..."),
            frame: Frame::Progress("inf_cmp_sim"),
        }),
        _ => Plan::Skip(unavailable(&sim)),
    };

    let column = |label: &str, token: &'static str, plan: Plan, sbd_fallback_check: bool| Column { label: label.into(), token, plan, sbd_fallback_check };
    let columns = vec![
        column("Spectral", "spectral", spectral, false),
        column("QNA", "qna", qna_plan, false),
        column("RQNA", "rqna", rqna_plan, false),
        column("SBD", "sbd", sbd_plan, sbd_ran),
        column("Simulation", "simulation", sim_plan, false),
    ];
    let table_text = TableText::new(ctx, columns.iter().map(|c| c.label.clone()).collect(), table::VarName::Q);
    let banner_line = banner::thread_count_banner_mixed(ctx.cpu_count);
    let temp_dir = ctx.temp_dir.clone();

    Prepared::Launch(PreparedRun {
        method: Method::InfiniteComparison,
        parameters: parameters(&[
            ("spectral degree", &degree.to_string()),
            ("simulation replications", &s.sim_replications.to_string()),
            ("simulation warm-up", &s.sim_warmup.to_string()),
            ("simulation time", &s.sim_time.to_string()),
            ("RQNA solver found", if rqna_binary.is_some() { "true" } else { "false" }),
            ("SBD solver found", if sbd_binary.is_some() { "true" } else { "false" }),
        ]),
        seed: Some(seed),
        replication_seeds: (0..s.sim_replications.max(0) as u64).map(|k| seed + k).collect(),
        before: lines,
        accepted: vec![StatusLine::info("Running independent infinite-buffer comparison methods...")],
        temps,
        body: Box::new(move |job: &mut Job| {
            job.set_temp_dir(temp_dir);
            job.emit_str(&format!("{banner_line}\n"));
            let mut tally = Tally::default();
            for c in &columns {
                if let Some(code) = tally.column(job, c) {
                    return code;
                }
            }
            table_text.emit(job, std::mem::take(&mut tally.outputs));
            let (trailer, nothing_succeeded) = tally.trailer();
            job.emit_str(&trailer);
            if nothing_succeeded {
                // `exit 70` ends the wrapper's command before runScript's "Elapsed time".
                return 70;
            }
            job.emit_elapsed_footer();
            0
        }),
    })
}

// ─── Run Comparison, finite buffers ─────────────────────────────────────────────────────────────

/// `runComparison()` and `runComparison(chosenBlocking:…)`.
fn finite(ctx: &RunContext) -> Prepared {
    let mut lines = Vec::new();
    let s = &ctx.settings;
    let not_found = |lines: &mut Vec<StatusLine>, name: &str, dir: &str| {
        blocked(
            lines,
            &format!("Comparison aborted: {name} binary not found."),
            Some(&format!("Could not locate the {name} binary. Make sure it is compiled (run 'make' in the {dir} directory).")),
            Severity::Error,
        );
    };
    let Some(sm_binary) = find_binary(ctx, "srbm_solver", "fBNAsm") else {
        not_found(&mut lines, "srbm_solver", "fBNAsm");
        return Prepared::Refused(lines);
    };
    let (fm_name, fm_label) = if s.fem_solver == 0 { ("bna_fm_gauss", "FE (Gauss)") } else { ("bna_fm_cbc", "FE (CBC)") };
    let Some(fm_binary) = find_binary(ctx, fm_name, "fBNAfm") else {
        not_found(&mut lines, fm_name, "fBNAfm");
        return Prepared::Refused(lines);
    };
    let Some(mc_binary) = find_binary(ctx, "fBNAsim", "fBNAsim") else {
        not_found(&mut lines, "fBNAsim", "fBNAsim");
        return Prepared::Refused(lines);
    };
    // Optional: a missing fBNAlp drops the LP column rather than aborting.
    let lp_binary = find_binary(ctx, "fBNAlp_solver", "fBNAlp");

    // With `runCompare.remember` on, the stored regime is used silently; otherwise the sheet (P6)
    // asks, starting from the same stored value, and its answer arrives in `sim_blocking`.
    let chosen = s.sim_blocking;
    let (blocking_flag, blocking_desc) = match chosen {
        0 => (Some("-l"), "loss"),
        2 => (Some("-e"), "BAS+ext-loss"),
        _ => (None, "BAS"),
    };
    let infinite = ctx.network.infinite_buffers;
    let loss = chosen == 0 && !infinite;
    let bas = chosen != 0 && !infinite;
    let (nodes, links) = (&ctx.network.nodes, &ctx.network.links);

    if !infinite && chosen != 0 {
        if let Ok(d) = traffic::compute(nodes, links, false, false, false) {
            let hot: Vec<String> = (0..d.d).filter(|&i| d.capacity[i] > 1e-12 && d.alpha[i] / d.capacity[i] > 0.97).map(|i| format!("S{}", i + 1)).collect();
            if !hot.is_empty() {
                let text = format!(
                    "Warning: {} at ρ > 0.97 with sim blocking = {blocking_desc}. Continuous-reflection SRBM doesn't model BAS back-pressure — expect the algorithm columns to under-predict queue means by roughly 10%. Pick Loss in the popup for tighter agreement, or see Help ▸ Test Sets ▸ BAS vs Loss.",
                    hot.join(", ")
                );
                let severity = infer_severity(&text);
                lines.push(StatusLine::new(text, severity));
            }
        }
    }

    let sm_content = match srbm_box::export_for_spectral(nodes, links, infinite, s.sm_degree, loss, bas) {
        Ok(text) => text,
        Err(e) => {
            blocked(&mut lines, &format!("Comparison aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let fm_cap = match ctx.network.nodes_of(NodeKind::Station).count() {
        0..=3 => 20,
        4 => 8,
        5 => 6,
        _ => 4,
    };
    let fm_mesh = s.fem_mesh_size.min(fm_cap);
    let fm_content = match srbm_box::export_for_finite_element(nodes, links, infinite, fm_mesh, loss, bas) {
        Ok(text) => text,
        Err(e) => {
            blocked(&mut lines, &format!("Comparison aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let mc_content = match fbnasim::export(nodes, links, &generated_now()) {
        Ok(text) => text,
        Err(e) => {
            blocked(&mut lines, &format!("Comparison aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };

    let pid = ctx.pid;
    let lp_csv_name = format!("BNET_cmp_lp_csv_{pid}");
    let lp_solver = ["highs", "glpk", "cplex"][s.flp_solver.clamp(0, 2) as usize];
    let mut lp_content = None;
    if lp_binary.is_some() {
        let params = srbm_box::FiniteLpParams {
            grid_n: s.flp_grid_n,
            basis_m: s.flp_basis_m,
            grid_type: if s.flp_grid_type == 1 { "chebyshev" } else { "uniform" }.into(),
            solver: lp_solver.into(),
            output_prefix: Some(ctx.temp_path(&lp_csv_name).to_string_lossy().into_owned()),
            smoothness_weight: 0.0,
            basis_normalize: s.flp_basis_normalize,
        };
        match srbm_box::export_for_finite_lp(nodes, links, &params, loss, bas) {
            Ok(text) => lp_content = Some(text),
            Err(e) => {
                let text = format!("Comparison: skipping LP — {}", e.message());
                let severity = infer_severity(&text);
                lines.push(StatusLine::new(text, severity));
            }
        }
    }

    let mut temps = TempFiles::new();
    let sm_file = format!("BNET_cmp_sm_{pid}.in");
    let fm_file = format!("BNET_cmp_fm_{pid}.in");
    let mc_file = format!("BNET_cmp_mc_{pid}.txt");
    let lp_file = format!("BNET_cmp_lp_{pid}.in");
    let mut writes = vec![(sm_file.as_str(), sm_content.as_str()), (fm_file.as_str(), fm_content.as_str()), (mc_file.as_str(), mc_content.as_str())];
    if let Some(text) = &lp_content {
        writes.push((lp_file.as_str(), text.as_str()));
    }
    for (file, text) in writes {
        if let Err(reason) = write_input(ctx, file, text, &mut temps) {
            blocked(&mut lines, "Comparison aborted: could not write temp files.", Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    }

    let seed = comparison_seed(ctx);
    let mut out = |name: &str| temps.add(ctx.temp_path(&format!("BNET_cmp_{name}_out_{pid}.txt")));
    let (sm_out, fm_out, mc_out, lp_out, ctmc_out) = (out("sm"), out("fm"), out("mc"), out("lp"), out("ctmc"));
    let have_lp = lp_binary.is_some() && lp_content.is_some();
    let lp_prefix_label = format!("Running finite LP method ({lp_solver}) ...");
    let mut labels = vec!["Running spectral method ...", "Running finite element method ...", "Running simulation ..."];
    if have_lp {
        labels.push(&lp_prefix_label);
    }
    let pad = padder(&labels);
    let path_arg = |file: &str| text(ctx.temp_path(file).into_os_string());

    let mut columns = vec![
        Column {
            label: "Spectral".into(),
            token: "spectral",
            plan: Plan::Run(Solver {
                launch: native(&sm_binary),
                args: vec![path_arg(&sm_file), text("-G"), text("-P"), Arg::Progress],
                env: Vec::new(),
                stderr_label: "Spectral Method",
                output: sm_out,
                prefix: pad("Running spectral method ..."),
                frame: Frame::Progress("fin_cmp_sm"),
            }),
            sbd_fallback_check: false,
        },
        Column {
            label: fm_label.into(),
            token: "finite-element",
            plan: Plan::Run(Solver {
                launch: native(&fm_binary),
                args: vec![path_arg(&fm_file), text("-G"), text("-P"), Arg::Progress],
                env: Vec::new(),
                stderr_label: "Finite Element",
                output: fm_out,
                prefix: pad("Running finite element method ..."),
                frame: Frame::Progress("fin_cmp_fm"),
            }),
            sbd_fallback_check: false,
        },
    ];
    if let (true, Some(bin)) = (have_lp, &lp_binary) {
        columns.push(Column {
            label: "Finite LP".into(),
            token: "finite-lp",
            plan: Plan::Run(Solver {
                launch: native(bin),
                args: vec![text("--input"), path_arg(&lp_file), text("--solver"), text(lp_solver), text("-c")],
                env: Vec::new(),
                stderr_label: "Finite LP",
                output: lp_out,
                prefix: pad(&lp_prefix_label),
                frame: Frame::Spinner,
            }),
            sbd_fallback_check: false,
        });
    }
    let ctmc = ctmc_plan(ctx, chosen, ctmc_out, &pad, &mut lines);
    let ctmc_runtime = ctmc.as_ref().map_or_else(|| "omitted".to_string(), |(_, provenance)| provenance.clone());
    let mut mc_args = vec![
        text("-f"),
        path_arg(&mc_file),
        text("-G"),
        text("-n"),
        text(s.sim_replications.to_string()),
        text("-w"),
        text(s.sim_warmup.to_string()),
        text("-T"),
        text(s.sim_time.to_string()),
        text("-s"),
        text(seed.to_string()),
        text("-P"),
        Arg::Progress,
    ];
    match s.sim_parallel {
        0 => mc_args.push(text("-a")), // Apple GCD
        1 => mc_args.push(text("-o")), // OpenMP
        _ => {}                        // sequential
    }
    if let Some(flag) = blocking_flag {
        mc_args.push(text(flag));
    }
    let simulation = Column {
        label: "Simulation".into(),
        token: "simulation",
        plan: Plan::Run(Solver {
            launch: native(&mc_binary),
            args: mc_args,
            env: Vec::new(),
            stderr_label: "Simulation",
            output: mc_out,
            prefix: pad("Running simulation ..."),
            frame: Frame::Progress("fin_cmp_mc"),
        }),
        sbd_fallback_check: false,
    };

    let mut table_labels: Vec<String> = columns.iter().map(|c| c.label.clone()).collect();
    let ctmc_solver = ctmc.map(|(solver, _)| solver);
    if ctmc_solver.is_some() {
        table_labels.push("CTMC (exact loss)".into());
    }
    table_labels.push("Simulation".into());
    let table_text = TableText::new(ctx, table_labels, table::VarName::X);
    let banner_line = banner::thread_count_banner_mixed(ctx.cpu_count);
    let temp_dir = ctx.temp_dir.clone();
    let chain = if have_lp { "SM → FM → LP → MC" } else { "SM → FM → MC" };

    Prepared::Launch(PreparedRun {
        method: Method::FiniteComparison,
        parameters: parameters(&[
            ("blocking", blocking_desc),
            ("spectral degree", &s.sm_degree.to_string()),
            ("finite-element mesh", &fm_mesh.to_string()),
            ("simulation replications", &s.sim_replications.to_string()),
            ("simulation warm-up", &s.sim_warmup.to_string()),
            ("simulation time", &s.sim_time.to_string()),
            ("exact CTMC runtime", &ctmc_runtime),
        ]),
        seed: Some(seed),
        replication_seeds: (0..s.sim_replications.max(0) as u64).map(|k| seed + k / 2).collect(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running comparison ({chain}, sim blocking = {blocking_desc})..."))],
        temps,
        body: Box::new(move |job: &mut Job| {
            let _csv = LpCsvCleanup { dir: temp_dir.clone(), prefix: lp_csv_name };
            job.set_temp_dir(temp_dir);
            job.emit_str(&format!("{banner_line}\n"));
            let mut tally = Tally::default();
            for c in &columns {
                if let Some(code) = tally.column(job, c) {
                    return code;
                }
            }
            if let Some(code) = ctmc_solver.as_ref().and_then(|ctmc| run_ctmc(job, ctmc, &mut tally)) {
                return code;
            }
            if let Some(code) = tally.column(job, &simulation) {
                return code;
            }
            table_text.emit(job, std::mem::take(&mut tally.outputs));
            // 0.90.34 printed no trailer; one appears only when a column failed (METH-122).
            if !tally.failed.is_empty() || tally.succeeded == 0 {
                let (trailer, nothing_succeeded) = tally.trailer();
                job.emit_str(&trailer);
                if nothing_succeeded {
                    return 70;
                }
            }
            job.emit_elapsed_footer();
            0
        }),
    })
}

/// The exact loss-tandem CTMC column, run as `buildCTMCRunCommand`'s tolerant wrapper did: a
/// failure marks the column `QNET_METHOD_FAILURE_V1 method=ctmc exit=N`, says so and announces
/// the partial comparison itself, and never stops the other columns. A success counts as one.
fn run_ctmc(job: &mut Job, ctmc: &Solver, tally: &mut Tally) -> Option<i32> {
    match run_solver(job, ctmc) {
        Ended::Interrupted(code) => return Some(code),
        Ended::Failed(code) => {
            tally.outputs.push(format!("QNET_METHOD_FAILURE_V1 method=ctmc exit={code}\n"));
            job.emit_str("Continuing comparison without the exact loss-tandem CTMC column.\n");
            job.emit_str("QNET_COMPARISON_STATUS_V1 partial=yes successful=other failed=ctmc\n");
        }
        Ended::Output(text) => {
            tally.succeeded += 1;
            tally.outputs.push(text);
        }
    }
    None
}

/// `cleanupCsv`: removes the LP's `<prefix>_marginal_*.csv` and `<prefix>_distribution.csv` when
/// the run ends, however it ends.
struct LpCsvCleanup {
    dir: PathBuf,
    prefix: String,
}

impl Drop for LpCsvCleanup {
    fn drop(&mut self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        let marginal = format!("{}_marginal_", self.prefix);
        let distribution = format!("{}_distribution.csv", self.prefix);
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if (name.starts_with(&marginal) && name.ends_with(".csv")) || name == distribution {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// `buildCTMCRunCommand`: the exact loss-tandem CTMC column and its runtime provenance, when the
/// network qualifies (Loss regime; one class; 1 ≤ d ≤ 4; a pure tandem S1 → S2 → …; one
/// exponential server per station; one Poisson or exponential source whose arrivals all enter
/// S1; a buffer before every station; at most 1,000 states). When it qualifies but Python with
/// NumPy or the script is missing, "Exact tandem CTMC omitted: <diagnostic>" is logged and the
/// column dropped.
fn ctmc_plan(ctx: &RunContext, blocking: i64, output: PathBuf, pad: &dyn Fn(&str) -> String, lines: &mut Vec<StatusLine>) -> Option<(Solver, String)> {
    if blocking != 0 {
        return None;
    }
    let (nodes, links) = (&ctx.network.nodes, &ctx.network.links);
    let data = traffic::compute(nodes, links, false, false, false).ok()?;
    let d = data.d;
    if data.k != 1 || !(1..=4).contains(&d) {
        return None;
    }
    if !is_tandem(&data) {
        return None;
    }
    let mut stations: Vec<_> = nodes.iter().filter(|n| n.kind == NodeKind::Station).collect();
    stations.sort_by_key(|n| station_order(&n.name));
    if stations.len() != d || !data.servers.iter().all(|&c| c == 1) {
        return None;
    }
    let exponential = |dist: Distribution| dist == Distribution::Exponential;
    if !stations.iter().all(|st| exponential(st.distribution) && st.service_by_class.values().all(|c| exponential(c.distribution))) {
        return None;
    }
    let sources: Vec<_> = nodes.iter().filter(|n| n.kind == NodeKind::Source).collect();
    if sources.len() != 1 || !matches!(sources[0].distribution, Distribution::Exponential | Distribution::Poisson) {
        return None;
    }
    // The script takes one arrival rate, so every external arrival must enter S1.
    let external = data.class_external_arrival_rates.first()?;
    if external.len() != d || !external[0].is_finite() || !(external[0] > 0.0) {
        return None;
    }
    // Swift's max(1.0, x): `x >= 1.0 ? x : 1.0`.
    let tolerance = if external[0] >= 1.0 { external[0] } else { 1.0 } * 1e-10;
    if !external[1..].iter().all(|x| x.is_finite() && x.abs() <= tolerance) {
        return None;
    }
    let mut buffers = Vec::with_capacity(d);
    for st in &stations {
        let feed = nodes.iter().find(|cand| cand.kind == NodeKind::Buffer && links.iter().any(|l| l.from == cand.id && l.to == st.id))?;
        buffers.push(feed.buffer_size);
    }
    // The dense solver materialises Q and solves it in O(n³): at most 1,000 states.
    let mut states: i64 = 1;
    for i in 0..d {
        let factor = buffers[i] + data.servers[i] + 1;
        if factor <= 0 || states > 1_000 / factor {
            return None;
        }
        states *= factor;
    }
    let lookup = ctx.resolver.resolve_python_support_file_in("ctmc_dtandem.py", "fBNActmc", &["finite"], &PythonRequest::with_modules(&["numpy"]));
    let Some(launch) = python_launch(&lookup) else {
        lines.push(StatusLine::warning(format!("Exact tandem CTMC omitted: {}", lookup.actionable_diagnostic())));
        return None;
    };
    let g10 = |x: f64| text(cfmt::f("%.10g", x));
    let mut args = vec![text("--buffers")];
    args.extend(buffers.iter().map(|b| text(b.to_string())));
    args.push(text("--servers"));
    args.extend(data.servers.iter().map(|c| text(c.to_string())));
    args.extend([text("--lam"), g10(external[0]), text("--mu")]);
    args.extend(data.service_rates.iter().map(|&m| g10(m)));
    args.extend([text("--mode"), text("loss"), text("--grid")]);
    let solver = Solver {
        launch,
        args,
        env: Vec::new(),
        stderr_label: "Exact loss-tandem CTMC",
        output,
        prefix: pad("Running CTMC (exact loss) ..."),
        frame: Frame::Spinner,
    };
    Some((solver, runtime(&lookup)))
}

/// A pure tandem: `aggregatedP[i][i+1] = 1` and every other entry 0, each within 1e-6 (a NaN
/// entry passes, as `abs(p − expected) > 1e-6` is false for it).
fn is_tandem(data: &SrbmData) -> bool {
    (0..data.d).all(|i| {
        (0..data.d).all(|j| {
            let expected = if j == i + 1 { 1.0 } else { 0.0 };
            !((data.aggregated_p[i][j] - expected).abs() > 1e-6)
        })
    })
}

/// `stationOrder`: the number after a name's leading non-numeric characters, `Int.max` when the
/// rest is not a whole number ("S1" → 1, "S1a" and "Mill" → `Int.max`).
fn station_order(name: &str) -> i64 {
    let digits = name.trim_start_matches(|c: char| !c.is_numeric());
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return i64::MAX;
    }
    digits.parse().unwrap_or(i64::MAX)
}

/// The fBNAsim document's `# Generated:` time: 0.90.34's short date and medium time for en_US
/// with a 24-hour clock (`11/10/26, 14:11:04`), as the corpus shows. The simulator ignores it.
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

// ─── A Status line's severity from its wording ──────────────────────────────────────────────────

/// `StatusEntry.inferSeverity`, for the lines 0.90.34 wrote with `addStatus(_:)` and no severity:
/// a leading ⚠ is an error when it says failed or aborted, else a warning; a negation ("no
/// warnings") is a success; failure wording is an error; warning wording a warning; a few verbs
/// of completion a success; anything else info.
fn infer_severity(text: &str) -> Severity {
    let lower = text.to_lowercase();
    let trimmed = lower.trim_matches(|c: char| c == ' ' || c == '\t' || (c.is_whitespace() && !matches!(c, '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}')));
    if trimmed.starts_with('⚠') {
        return if lower.contains("failed") || lower.contains("aborted") { Severity::Error } else { Severity::Warning };
    }
    const NEGATIONS: [&str; 9] = ["no warnings", "0 warnings", "without warning", "no errors", "0 errors", "no error", "without error", "no failures", "0 failures"];
    if NEGATIONS.iter().any(|n| lower.contains(n)) {
        return Severity::Success;
    }
    if lower.contains(" aborted:")
        || lower.starts_with("error")
        || lower.contains(" failed")
        || lower.starts_with("failed")
        || lower.contains("not found")
        || lower.starts_with("cannot ")
        || lower.contains("could not ")
        || lower.contains("invalid ")
    {
        return Severity::Error;
    }
    if lower.contains("warning")
        || lower.contains("warn:")
        || lower.contains("cancelled")
        || lower.contains("canceled")
        || lower.starts_with("banner will fire")
        || lower.starts_with("banner triggered")
        || lower.contains("unstable")
        || lower.contains("caution")
        || lower.starts_with("nothing ")
        || lower.starts_with("no node matches")
        || lower.contains("skipping")
    {
        return Severity::Warning;
    }
    const SUCCESS: [&str; 16] = ["wrote", "updated", "aligned", "saved", "exported", "loaded", "straightened", "distributed", "displayed", "fit network", "pasted", "copied", "added ", "renamed", "found ", "undid"];
    if SUCCESS.iter().any(|p| trimmed.starts_with(p)) {
        return Severity::Success;
    }
    Severity::Info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn station_order_reads_the_number_after_the_leading_letters() {
        assert_eq!(station_order("S1"), 1);
        assert_eq!(station_order("S12"), 12);
        assert_eq!(station_order("Station 3"), 3);
        assert_eq!(station_order("S1a"), i64::MAX);
        assert_eq!(station_order("Mill"), i64::MAX);
        assert_eq!(station_order(""), i64::MAX);
        assert_eq!(station_order("S99999999999999999999"), i64::MAX);
    }

    #[test]
    fn severities_are_inferred_from_the_wording_as_0_90_34_did() {
        assert_eq!(infer_severity("Comparison: skipping LP — The network has no sink node."), Severity::Warning);
        assert_eq!(infer_severity("Comparison: skipping LP — Station S1 has no buffer feeding into it."), Severity::Warning);
        assert_eq!(infer_severity("Comparison: skipping LP — S1 is invalid here."), Severity::Error);
        assert_eq!(infer_severity("Warning: S1, S2 at ρ > 0.97 with sim blocking = BAS."), Severity::Warning);
        assert_eq!(infer_severity("⚠ QNA failed (exit 2):"), Severity::Error);
        assert_eq!(infer_severity("⚠ QNA warnings:"), Severity::Warning);
        assert_eq!(infer_severity("Finished with no warnings."), Severity::Success);
        assert_eq!(infer_severity("  Wrote 3 files"), Severity::Success);
        assert_eq!(infer_severity("Error opening"), Severity::Error);
        assert_eq!(infer_severity("Running comparison"), Severity::Info);
    }

    #[test]
    fn the_progress_prefixes_are_padded_to_the_longest_label_plus_two() {
        let pad = padder(&["Running spectral method ...", "Running QNA ...", "Running RQNA ...", "Running SBD ...", "Running simulation ..."]);
        assert_eq!(pad("Running QNA ..."), "Running QNA ...              ");
        assert_eq!(pad("Running spectral method ..."), "Running spectral method ...  ");
        let pad = padder(&["Running spectral method ...", "Running finite element method ...", "Running simulation ...", "Running finite LP method (highs) ..."]);
        assert_eq!(pad("Running simulation ...").len(), 38);
        assert_eq!(pad("Running CTMC (exact loss) ...").len(), 38);
    }

    #[test]
    fn the_trailer_names_what_failed_and_ends_the_run_when_nothing_succeeded() {
        let t = Tally { outputs: Vec::new(), succeeded: 5, failed: Vec::new() };
        assert_eq!(t.trailer(), ("QNET_COMPARISON_STATUS_V1 partial=no successful=5\n".to_string(), false));
        let t = Tally { outputs: Vec::new(), succeeded: 4, failed: vec!["spectral".into(), "sbd-fallback".into()] };
        assert_eq!(t.trailer(), ("QNET_COMPARISON_STATUS_V1 partial=yes successful=4 failed=spectral,sbd-fallback\n".to_string(), false));
        let t = Tally { outputs: Vec::new(), succeeded: 0, failed: vec!["qna".into()] };
        assert_eq!(t.trailer(), ("QNET_COMPARISON_STATUS_V1 partial=yes successful=0 failed=all\n".to_string(), true));
    }
}
