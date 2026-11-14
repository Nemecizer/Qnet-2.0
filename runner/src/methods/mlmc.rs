//! Run SRBM MLMC (`mlmc`): the Blanchet–Chen–Glynn–Si multilevel Monte Carlo estimator of the
//! stationary mean of the network's workload SRBM, `infinite/BNAmc/rbm_mlmc`, run K times with
//! independent seeds and aggregated into a per-station queue-length table. A port of `runExactSim`
//! and the helpers before it in `2_QNET/Sources/Qnet/QnetGUIApp.swift` (`mlmcCostPreview`,
//! `mlmcAutomaticSamples`, `solveRuntimeLinearSystem`; `mlmcReplicationSeeds` and `mlmc95Critical`
//! are `qnet_core::output::mlmc`), ledger METH-060…METH-073.
//!
//! There is no parameter sheet: every knob is a stored `mlmc.*` setting (METH-060), so the golden
//! corpus ran with `RunSettings::golden()` (only `mlmc.seedFixed` differs from the defaults). The
//! run resolves `rbm_mlmc`, builds the workload SRBM (`srbm_orthant::compute`, 0.90.34's
//! `BNASRBMExporter.computeData`), writes `formatBNAmcInput` to `BNET_mlmc_<pid>.in`, sanitises ε
//! and γ, derives the plan (path length T, levels L, samples N per replication) and refuses a plan
//! the native solver can't run or that exceeds Qnet's work budget, each with 0.90.34's sentence. A
//! launched run prints "Running SRBM MLMC (<summary>) ... ", runs the replications one after
//! another, checks each one's station rows, prints a failing replication's standard error and
//! stops, or prints a successful one's standard error under "SRBM MLMC replication k
//! diagnostics:", then "done.", a blank line, the aggregator's table (`output::mlmc::aggregate`)
//! and "Elapsed time". There is no spinner, progress bar or thread banner.
//!
//! Where 2.0 differs, deliberately:
//!
//! - D1: each replication is started as an argument vector by the supervisor, not by the bash
//!   loop 0.90.34 typed into the user's shell; its standard output and error are captured instead
//!   of going to `BNET_mlmc_out_<pid>.<k>` and `.<k>.err`, and the per-replication check and the
//!   aggregator are Rust functions instead of awk programs (SH-085, RUN-066, Changed). The text is
//!   0.90.34's.
//! - The input file is registered with the run's temporary-file guard instead of the subshell's
//!   `trap cleanup_mlmc EXIT`, so it is also removed when the launch itself is refused (RUN-021,
//!   RUN-022, Changed).
//! - A replication whose solver cannot be spawned at all ends the run as the other families do,
//!   "SRBM MLMC could not start: <reason>" with exit status −1, where bash reported its own exec
//!   error (status 126 or 127) under "SRBM MLMC replication k failed with status N.".
//! - A negative stored base seed is recorded as its 64-bit two's-complement value, the state the
//!   replication seeds are derived from; 0.90.34 trapped converting it to `UInt64` (D5). The
//!   Settings window never stores one (its range is 0…2147483647).
//! - The Status sentences format numbers as Foundation's ICU `formatted(...)` did (measured on
//!   macOS 27.2, Swift 6.4.2, en_US); the rarer styles are reproduced here, not called.

use std::path::{Path, PathBuf};

use qnet_core::cfmt;
use qnet_core::export::srbm_orthant::{self, OrthantData};
use qnet_core::output::mlmc as text;

use crate::supervisor::{Job, ProcessSpec, Severity, Step, TempFiles};

use super::exact::{blocked, could_not_start, finish, parameters, runtime, write_input};
use super::{Method, Prepared, PreparedRun, RunBody, RunContext, RunSettings, StatusLine};

/// 0.90.34's `AppSettings.Defaults.exactSimGamma`, used when the stored γ can't be.
const DEFAULT_GAMMA: f64 = 0.05;
/// The ε used when the stored one is outside (0, 1].
const DEFAULT_EPSILON: f64 = 0.01;
/// `Int32.max`, the native solver's largest sample count and grid length.
const INT32_MAX: f64 = 2_147_483_647.0;
/// Qnet's safety budget: expected coupled-path vector steps, and coordinate steps.
const PATH_STEP_BUDGET: f64 = 1_000_000_000.0;
const COORDINATE_STEP_BUDGET: f64 = 20_000_000_000.0;
/// The exit status of a replication whose station rows are incomplete (`exit 65`).
const MALFORMED_EXIT: i32 = 65;

/// Prepares `mlmc` (`runExactSim`).
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    if method != Method::Mlmc {
        return super::unimplemented_method(method);
    }
    let mut lines = Vec::new();
    let lookup = ctx.resolver.resolve_executable("rbm_mlmc", "BNAmc");
    let Some(binary) = lookup.url().map(Path::to_path_buf) else {
        blocked(&mut lines, "SRBM MLMC aborted: rbm_mlmc binary not found.", Some(&lookup.actionable_diagnostic()), Severity::Error);
        return Prepared::Refused(lines);
    };
    let data = match srbm_orthant::compute(&ctx.network.nodes, &ctx.network.links) {
        Ok(data) => data,
        Err(e) => {
            blocked(&mut lines, &format!("SRBM MLMC aborted: {}", e.message()), None, Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let input = match write_input(ctx, &format!("BNET_mlmc_{}.in", ctx.pid), &srbm_orthant::format_bnamc_input(&data), &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(&mut lines, "SRBM MLMC aborted: could not write temp file.", Some(&reason), Severity::Error);
            return Prepared::Refused(lines);
        }
    };
    let plan = match plan(&ctx.settings, &data, &mut lines) {
        Ok(plan) => plan,
        Err(message) => {
            // `abortPlan`: the warning, and the input file the run will now never read (dropping
            // `temps` removes it).
            blocked(&mut lines, &format!("SRBM MLMC not started: {message}"), None, Severity::Warning);
            return Prepared::Refused(lines);
        }
    };

    let s = &ctx.settings;
    // `Int.random(in: 1...1_000_000_000)` when the seed is not fixed.
    let base_seed = if s.mlmc_seed_fixed { s.mlmc_seed } else { ctx.random_in(1, 1_000_000_000) as i64 };
    let seeds = text::replication_seeds(base_seed, plan.replications);
    let summary = cli_summary(s, &plan);
    let replications = Replications {
        binary,
        input,
        gamma: cfmt::f("%g", plan.gamma),
        epsilon: cfmt::f("%g", plan.epsilon),
        flags: flags(s),
        seeds: seeds.clone(),
        // `tau > 0 ? 1.0 / tau : 1.0`, the factor that turns workload into queue length.
        mu_eff: data.mean_service_times.iter().map(|&tau| if tau > 0.0 { 1.0 / tau } else { 1.0 }).collect(),
        expected_rows: data.mean_service_times.len(),
        critical: text::critical_95(plan.replications),
        summary: summary.clone(),
    };
    let sample_plan = if plan.adaptive {
        format!("adaptive, maximum {}", s.mlmc_max_samples)
    } else {
        cfmt::swift_description(plan.samples)
    };
    let threads = if s.mlmc_threads == 0 { "automatic".to_string() } else { s.mlmc_threads.to_string() };
    Prepared::Launch(PreparedRun {
        method: Method::Mlmc,
        parameters: parameters(&[
            ("epsilon", &replications.epsilon),
            ("gamma", &replications.gamma),
            ("path length T", &cfmt::swift_description(plan.path_length)),
            ("levels L", &plan.levels.to_string()),
            ("sample plan", &sample_plan),
            ("replications", &plan.replications.to_string()),
            ("antithetic", &s.mlmc_antithetic.to_string()),
            ("adaptive", &s.mlmc_adaptive.to_string()),
            ("backend", &s.mlmc_backend.to_string()),
            ("threads", &threads),
            ("runtime", &runtime(&lookup)),
        ]),
        // `UInt64(baseSeed)`; see the header for a negative stored seed.
        seed: Some(base_seed as u64),
        replication_seeds: seeds,
        before: lines,
        accepted: vec![StatusLine::info(format!("Running SRBM MLMC ({summary})..."))],
        temps,
        body: body(replications),
    })
}

// ─── The plan ────────────────────────────────────────────────────────────────────────────────────

/// What `runExactSim` resolved before it built the command.
#[derive(Debug, Clone, PartialEq)]
struct Plan {
    /// ε after sanitising.
    epsilon: f64,
    /// γ after sanitising.
    gamma: f64,
    /// The path length T: the override, or the automatic one.
    path_length: f64,
    /// The level count L: the override, or the automatic one.
    levels: i64,
    /// Samples per replication: the adaptive cap, the explicit N, or the automatic formula.
    samples: f64,
    adaptive: bool,
    /// K = max(1, `mlmc.replications`).
    replications: usize,
}

/// Sanitises ε and γ and resolves T, L and N as `runExactSim` did, writing the γ warning and the
/// "Estimated MLMC plan" line to `lines`. An `Err` is the sentence `abortPlan` reported after
/// "SRBM MLMC not started: ".
fn plan(s: &RunSettings, data: &OrthantData, lines: &mut Vec<StatusLine>) -> Result<Plan, String> {
    let epsilon = if s.mlmc_epsilon > 0.0 && s.mlmc_epsilon <= 1.0 { s.mlmc_epsilon } else { DEFAULT_EPSILON };
    let gamma_raw = s.mlmc_gamma;
    let reciprocal = 1.0 / gamma_raw;
    let rounded = reciprocal.round();
    let native_compatible = gamma_raw.is_finite()
        && gamma_raw > 0.0
        && gamma_raw < 1.0
        && reciprocal.is_finite()
        && rounded >= 1.0
        && rounded <= INT32_MAX
        && (rounded * gamma_raw - 1.0).abs() <= 1e-9;
    let gamma = if native_compatible { gamma_raw } else { DEFAULT_GAMMA };
    if !native_compatible {
        lines.push(StatusLine::warning(format!(
            "Stored MLMC γ={} is incompatible with the native solver because 1/γ must be an integer; using the documented default γ={}.",
            cfmt::swift_description(gamma_raw),
            cfmt::swift_description(gamma)
        )));
    }
    let k = s.mlmc_replications.max(1);
    let replications = usize::try_from(k).unwrap_or(usize::MAX);

    let automatic = cost_preview(data, gamma, epsilon);
    let path_length = if s.mlmc_override_t {
        (s.mlmc_t.is_finite() && s.mlmc_t > 0.0).then_some(s.mlmc_t)
    } else {
        automatic.map(|c| c.path_length)
    };
    let levels = if s.mlmc_override_l { (s.mlmc_l > 0).then_some(s.mlmc_l) } else { automatic.map(|c| c.levels) };
    let (Some(path_length), Some(levels)) = (path_length, levels) else {
        return Err("Qnet could not derive finite positive T and L values. Supply deliberate T/L overrides after reviewing finite-horizon and discretization bias, or use Adaptive Low-Rank BAR.".into());
    };

    let adaptive = s.mlmc_adaptive;
    let (samples, sample_label) = if adaptive {
        let (batch, minimum, maximum) = (s.mlmc_batch_size, s.mlmc_min_samples, s.mlmc_max_samples);
        if !(batch > 0 && minimum >= 2 && maximum >= 2 && batch <= maximum && minimum <= maximum) {
            return Err("Adaptive MLMC requires a positive batch size and at least two minimum/maximum samples so it can estimate variance, with batch and minimum no larger than the maximum. The maximum is the hard cost cap.".into());
        }
        (maximum as f64, format!("maximum N={maximum}"))
    } else if s.mlmc_override_n {
        if s.mlmc_n <= 0 {
            return Err("The explicit sample count N must be positive.".into());
        }
        (s.mlmc_n as f64, format!("N={}", s.mlmc_n))
    } else {
        let Some(samples) = automatic_samples(gamma, levels) else {
            return Err(format!("The automatic sample formula overflows at L={levels}. Choose a deliberate positive N override after reviewing bias, enable adaptive sampling with a finite maximum-sample cap, or use Adaptive Low-Rank BAR."));
        };
        (samples, format!("N≈{}", icu_compact(samples, 4)))
    };

    if samples > INT32_MAX {
        return Err("The resolved sample count exceeds the native solver's 2147483647 sample limit. Choose a smaller explicit N, use adaptive sampling with a finite cap, or increase ε/reduce L after reviewing bias.".into());
    }
    let finest = path_length / gamma.powf(levels as f64);
    let coarsest = if levels > 1 { (levels - 1) as f64 * path_length / gamma.powf((levels - 1) as f64) } else { 0.0 };
    let grids_fit = finest.is_finite()
        && finest >= 1.0
        && finest <= INT32_MAX
        && coarsest.is_finite()
        && coarsest >= 0.0
        && coarsest <= INT32_MAX;
    if !grids_fit {
        return Err(format!(
            "The finest/coupled path grids would require about {} and {} loop iterations, respectively; at least one exceeds the native solver's safe integer grid. Reduce T or L, increase γ, or use Adaptive Low-Rank BAR.",
            icu_scientific(finest),
            icu_scientific(coarsest)
        ));
    }

    // The closed-form expected fine + coarse path-loop count per sample under the truncated
    // geometric level law, times N, K and the antithetic factor.
    let antithetic_factor = if s.mlmc_antithetic { 2.0 } else { 1.0 };
    let l = levels as f64;
    let gamma_l = gamma.powf(l);
    let level_normalizer = (1.0 - gamma) / (1.0 - gamma_l);
    let steps_per_sample = level_normalizer * path_length * (l * (l + 1.0) / (2.0 * gamma) + l * (l - 1.0) / 2.0);
    let path_work = steps_per_sample * samples * k as f64 * antithetic_factor;
    let coordinate_work = path_work * data.d.max(1) as f64;
    let preview = format!(
        "Estimated MLMC plan: T≈{}, L={levels}, {sample_label} per replication.",
        icu_significant(path_length, 4)
    );
    lines.push(StatusLine::info(preview.clone()));
    if !path_work.is_finite() || !coordinate_work.is_finite() || path_work > PATH_STEP_BUDGET || coordinate_work > COORDINATE_STEP_BUDGET {
        return Err(format!(
            "{preview} Across {k} replication{}, its expected coupled-path work exceeds Qnet's safety budget (1 billion vector steps or 20 billion coordinate steps, including γ and antithetic cost). Reduce the adaptive maximum or choose deliberate T/L/N values after reviewing bias, or use Adaptive Low-Rank BAR.",
            if k == 1 { "" } else { "s" }
        ));
    }
    Ok(Plan { epsilon, gamma, path_length, levels, samples, adaptive, replications })
}

/// The automatic path length and level count (`MLMCCostPreview`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct CostPreview {
    path_length: f64,
    levels: i64,
}

/// Swift's `max` on Doubles: `y >= x ? y : x`.
fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

/// `mlmcCostPreview`: T = max(5, (ln d)²/2, 5·Γᵢᵢ/(2ηᵢ²)) over the stations whose η = R⁻¹θ is not
/// zero, and L = max(1, ⌈(ln ln d + 2 ln(1/ε) − 2) / ln(1/γ)⌉) for d > 1 (1 for one station), or
/// `None` when the inputs or the result are out of range.
fn cost_preview(data: &OrthantData, gamma: f64, epsilon: f64) -> Option<CostPreview> {
    if !(data.d > 0 && gamma > 0.0 && gamma < 1.0 && epsilon > 0.0 && epsilon <= 1.0) {
        return None;
    }
    let eta = solve_linear_system(&data.r, &data.drift)?;
    let log_d = (data.d as f64).ln();
    let mut path_length = swift_max(5.0, log_d * log_d / 2.0);
    for i in 0..data.d {
        if eta[i].abs() > 1e-14 {
            let relaxation = data.gamma[i][i] / (2.0 * eta[i] * eta[i]);
            if relaxation.is_finite() {
                path_length = swift_max(path_length, 5.0 * relaxation);
            }
        }
    }
    let level_numerator = if data.d > 1 {
        // `Double.leastNonzeroMagnitude`, the smallest subnormal.
        swift_max(log_d, f64::from_bits(1)).ln() + 2.0 * (1.0 / epsilon).ln() - 2.0
    } else {
        0.0
    };
    let raw_levels = (level_numerator / (1.0 / gamma).ln()).ceil();
    if !(path_length.is_finite()
        && path_length > 0.0
        && level_numerator.is_finite()
        && raw_levels.is_finite()
        && (-1_000_000.0..=1_000_000.0).contains(&raw_levels))
    {
        return None;
    }
    Some(CostPreview { path_length, levels: (raw_levels as i64).max(1) })
}

/// `mlmcAutomaticSamples`: the native solver's classical automatic sample count
/// ⌈L·γ^−L·(1 − γ^L)/(1 − γ)⌉ for a resolved level count, or `None` when it overflows.
fn automatic_samples(gamma: f64, levels: i64) -> Option<f64> {
    if !(gamma > 0.0 && gamma < 1.0 && levels > 0) {
        return None;
    }
    let gamma_l = gamma.powf(levels as f64);
    let inverse_gamma_l = gamma.powf(-(levels as f64));
    let normalization = (1.0 - gamma) / (1.0 - gamma_l);
    let samples = ((1.0 / normalization) * inverse_gamma_l * levels as f64).ceil();
    let valid = gamma_l.is_finite()
        && gamma_l > 0.0
        && inverse_gamma_l.is_finite()
        && normalization.is_finite()
        && normalization > 0.0
        && samples.is_finite()
        && samples >= 1.0;
    valid.then_some(samples)
}

/// `solveRuntimeLinearSystem`: Gaussian elimination with partial pivoting (the first row with
/// the largest magnitude), `None` for a pivot of magnitude at most 1e-14 or a shape mismatch.
fn solve_linear_system(matrix: &[Vec<f64>], rhs: &[f64]) -> Option<Vec<f64>> {
    let n = rhs.len();
    if matrix.len() != n || matrix.iter().any(|row| row.len() != n) {
        return None;
    }
    let mut a = matrix.to_vec();
    let mut b = rhs.to_vec();
    for column in 0..n {
        let mut pivot = column;
        for row in column..n {
            if a[row][column].abs() > a[pivot][column].abs() {
                pivot = row;
            }
        }
        if a[pivot][column].abs() <= 1e-14 {
            return None;
        }
        if pivot != column {
            a.swap(pivot, column);
            b.swap(pivot, column);
        }
        for row in column + 1..n {
            let factor = a[row][column] / a[column][column];
            for j in column..n {
                a[row][j] -= factor * a[column][j];
            }
            b[row] -= factor * b[column];
        }
    }
    let mut solution = vec![0.0; n];
    for row in (0..n).rev() {
        let mut value = b[row];
        for j in row + 1..n {
            value -= a[row][j] * solution[j];
        }
        solution[row] = value / a[row][row];
    }
    Some(solution)
}

/// The flags after `--seed $SEED`, from what the user overrode (METH-067).
fn flags(s: &RunSettings) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if s.mlmc_override_t && s.mlmc_t > 0.0 {
        out.extend(["--T".into(), cfmt::f("%g", s.mlmc_t)]);
    }
    if s.mlmc_override_l && s.mlmc_l > 0 {
        out.extend(["--L".into(), s.mlmc_l.to_string()]);
    }
    if !s.mlmc_adaptive && s.mlmc_override_n && s.mlmc_n > 0 {
        out.extend(["--N".into(), s.mlmc_n.to_string()]);
    }
    match s.mlmc_backend {
        1 => out.extend(["--backend".into(), "openmp".into()]),
        2 => out.extend(["--backend".into(), "accelerate".into()]),
        3 => out.extend(["--backend".into(), "serial".into()]),
        _ => {} // auto-select
    }
    if s.mlmc_threads > 0 {
        out.extend(["--threads".into(), s.mlmc_threads.to_string()]);
    }
    if s.mlmc_antithetic {
        out.push("--antithetic".into());
    }
    if s.mlmc_adaptive {
        out.push("--adaptive".into());
        out.extend(["--batch-size".into(), s.mlmc_batch_size.to_string()]);
        out.extend(["--min-samples".into(), s.mlmc_min_samples.to_string()]);
        out.extend(["--max-samples".into(), s.mlmc_max_samples.to_string()]);
    }
    out
}

/// What the run is about to do, for the Shell's first line and the Status line ("γ=0.05, ε=0.01,
/// T=10, L=3, N=25000, antithetic, adaptive (max 200000), K=4 replications").
fn cli_summary(s: &RunSettings, plan: &Plan) -> String {
    let mut out = format!("γ={}, ε={}", cfmt::f("%g", plan.gamma), cfmt::f("%g", plan.epsilon));
    if s.mlmc_override_t {
        out.push_str(&format!(", T={}", cfmt::f("%g", s.mlmc_t)));
    }
    if s.mlmc_override_l {
        out.push_str(&format!(", L={}", s.mlmc_l));
    }
    if !plan.adaptive && s.mlmc_override_n {
        out.push_str(&format!(", N={}", s.mlmc_n));
    }
    if s.mlmc_antithetic {
        out.push_str(", antithetic");
    }
    if plan.adaptive {
        out.push_str(&format!(", adaptive (max {})", s.mlmc_max_samples));
    }
    if plan.replications > 1 {
        out.push_str(&format!(", K={} replications", plan.replications));
    }
    out
}

// ─── The replication loop ────────────────────────────────────────────────────────────────────────

/// Everything the replication loop needs.
struct Replications {
    binary: PathBuf,
    input: PathBuf,
    /// γ and ε as `%g`, the solver's second and third arguments.
    gamma: String,
    epsilon: String,
    flags: Vec<String>,
    seeds: Vec<u64>,
    mu_eff: Vec<f64>,
    expected_rows: usize,
    critical: f64,
    summary: String,
}

impl Replications {
    /// `'<rbm_mlmc>' '<in>' <γ> <ε> --seed <seed> <flags…>`.
    fn command(&self, seed: u64) -> ProcessSpec {
        ProcessSpec::new(&self.binary)
            .arg(&self.input)
            .arg(&self.gamma)
            .arg(&self.epsilon)
            .arg("--seed")
            .arg(seed.to_string())
            .args(self.flags.iter())
    }
}

/// The body of the wrapper's subshell, then `runScript`'s "Elapsed time": K replications in
/// order, each checked as the loop checked it, then the aggregator over all of them. The exit
/// status is the failing replication's, 65 for incomplete station rows, else 0.
fn body(run: Replications) -> RunBody {
    Box::new(move |job: &mut Job| {
        job.emit_str(&format!("Running SRBM MLMC ({}) ... ", run.summary));
        let mut outputs: Vec<String> = Vec::with_capacity(run.seeds.len());
        for (index, &seed) in run.seeds.iter().enumerate() {
            let k = index + 1;
            // Standard output is the replication's file; it is not shown.
            let outcome = match job.run_step(&Step::new(run.command(seed)).quiet()) {
                Ok(outcome) => outcome,
                Err(e) => {
                    job.emit_str("\n");
                    return could_not_start(job, &e);
                }
            };
            if outcome.interrupted() {
                // Stop: the subshell died with the solver and printed nothing more.
                return finish(job, true, outcome.shell_code());
            }
            let rc = outcome.shell_code();
            if rc != 0 {
                job.emit_str(&format!("\n{}\n", text::replication_failed_line(k, rc)));
                job.emit(&outcome.stderr);
                return finish(job, false, rc);
            }
            let stdout = String::from_utf8_lossy(&outcome.stdout).into_owned();
            if !text::replication_output_is_complete(&stdout, run.expected_rows) {
                job.emit_str(&format!("\n{}\n", text::replication_malformed_line(k, run.expected_rows)));
                job.emit(&outcome.stderr);
                return finish(job, false, MALFORMED_EXIT);
            }
            if !outcome.stderr.is_empty() {
                job.emit_str(&format!("\n{}\n", text::replication_diagnostics_line(k)));
                job.emit(&outcome.stderr);
            }
            outputs.push(stdout);
        }
        job.emit_str("done.\n\n");
        let files: Vec<Option<&str>> = outputs.iter().map(|o| Some(o.as_str())).collect();
        job.emit_str(&text::aggregate(&files, &run.mu_eff, &run.seeds, run.critical));
        finish(job, false, 0)
    })
}

// ─── ICU number styles (Foundation's FormatStyle, en_US) ───────────────────────────────────────
//
// Three of this run's Status sentences format numbers with Swift's `formatted(...)` in styles the
// exact family's helpers don't cover. Measured on macOS 27.2, Swift 6.4.2, locale en_US: ICU starts
// from the shortest decimal that round-trips the Double, rounds half to even, and groups the
// integer part in threes (compact notation only from five integer digits on: "1000T", "2,500,000T").

/// The shortest round-trip decimal of `|x|`: its digits d0 d1 … and the exponent of d0 (the value
/// is d0.d1d2… × 10^e), with the sign. Zero has no digits.
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

/// `digits` × 10^e rounded half to even to at most `keep` significant digits, trailing zeros
/// dropped; a carry raises the exponent.
fn round_significant(digits: &[u8], e: i32, keep: usize) -> (Vec<u8>, i32) {
    let mut kept = digits[..keep.min(digits.len())].to_vec();
    let mut e = e;
    if keep < digits.len() {
        let first = digits[keep];
        let rest_nonzero = digits[keep + 1..].iter().any(|&d| d != 0);
        let last_odd = kept.last().is_some_and(|d| d % 2 == 1);
        if first > 5 || (first == 5 && (rest_nonzero || last_odd)) {
            let mut i = kept.len();
            loop {
                if i == 0 {
                    kept.insert(0, 1);
                    kept.pop();
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
    }
    while kept.last() == Some(&0) {
        kept.pop();
    }
    if kept.is_empty() {
        e = 0;
    }
    (kept, e)
}

/// Writes `digits` × 10^e in fixed notation with exactly `significant` significant digits (zero as
/// a zero followed by `significant − 1` decimals), grouping the integer part when it has at least
/// `min_grouping` digits.
fn fixed(negative: bool, digits: &[u8], e: i32, significant: usize, min_grouping: usize) -> String {
    let digit_at = |place: i32| -> u8 {
        // The digit with place value 10^place.
        let index = i64::from(e) - i64::from(place);
        if index >= 0 && (index as usize) < digits.len() {
            b'0' + digits[index as usize]
        } else {
            b'0'
        }
    };
    let last_place = e - (significant as i32 - 1);
    let top = e.max(0);
    let int_part: String = (0..=top).rev().map(|p| digit_at(p) as char).collect();
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.push_str(&group(&int_part, min_grouping));
    if last_place < 0 {
        out.push('.');
        out.extend((last_place..0).rev().map(|p| digit_at(p) as char));
    }
    out
}

/// Groups a run of integer digits in threes with commas, when there are at least `min` of them.
fn group(int_digits: &str, min: usize) -> String {
    if int_digits.len() < min {
        return int_digits.to_string();
    }
    let mut out = String::with_capacity(int_digits.len() + int_digits.len() / 3);
    for (i, c) in int_digits.chars().enumerate() {
        if i > 0 && (int_digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// ICU's spelling of a NaN or an infinity, or `None` for a finite number.
fn non_finite(x: f64) -> Option<String> {
    if x.is_nan() {
        Some("NaN".into())
    } else if x.is_infinite() {
        Some(if x < 0.0 { "-∞" } else { "∞" }.into())
    } else {
        None
    }
}

/// `x.formatted(.number.precision(.significantDigits(n)))`: "405.0", "2,147", "5.000".
fn icu_significant(x: f64, n: usize) -> String {
    if let Some(s) = non_finite(x) {
        return s;
    }
    let (negative, digits, e) = shortest_decimal(x);
    let (digits, e) = round_significant(&digits, e, n);
    fixed(negative, &digits, e, n, 4)
}

/// `x.formatted(.number.notation(.compactName).precision(.significantDigits(n)))`: the value
/// rounded to `n` significant digits, then shown in thousands ("K"), millions ("M"), billions ("B")
/// or trillions ("T", also beyond) by the rounded value's magnitude: "25.26K", "1.000M", "999.0".
fn icu_compact(x: f64, n: usize) -> String {
    if let Some(s) = non_finite(x) {
        return s;
    }
    let (negative, digits, e) = shortest_decimal(x);
    let (digits, e) = round_significant(&digits, e, n);
    let (suffix, scale) = match e {
        i32::MIN..=2 => ("", 0),
        3..=5 => ("K", 3),
        6..=8 => ("M", 6),
        9..=11 => ("B", 9),
        _ => ("T", 12),
    };
    let e = if digits.is_empty() { 0 } else { e - scale };
    format!("{}{suffix}", fixed(negative, &digits, e, n, 5))
}

/// `x.formatted(.number.notation(.scientific))`: up to seven significant digits, trailing zeros
/// dropped, then `E` and the exponent: "1.28E10", "2E-1", "0E0".
fn icu_scientific(x: f64) -> String {
    if let Some(s) = non_finite(x) {
        return s;
    }
    let (negative, digits, e) = shortest_decimal(x);
    let (digits, e) = round_significant(&digits, e, 7);
    let sign = if negative { "-" } else { "" };
    let Some((first, rest)) = digits.split_first() else { return format!("{sign}0E0") };
    let rest: String = rest.iter().map(|d| (b'0' + d) as char).collect();
    if rest.is_empty() {
        format!("{sign}{first}E{e}")
    } else {
        format!("{sign}{first}.{rest}E{e}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The workload SRBM of an example, as `computeData` builds it.
    fn example_data(file: &str) -> OrthantData {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(file);
        let net = qnet_core::bnet::read(&std::fs::read_to_string(path).expect("example")).expect("example reads");
        srbm_orthant::compute(&net.nodes, &net.links).expect("an SRBM")
    }

    /// A one-station SRBM: drift −0.5, variance 1, R = 1, τ = 1.
    fn one_station() -> OrthantData {
        OrthantData {
            d: 1,
            drift: vec![-0.5],
            gamma: vec![vec![1.0]],
            r: vec![vec![1.0]],
            mean_service_times: vec![1.0],
            k: 1,
            total_throughput: vec![0.5],
            effective_service_rates: vec![1.0],
            class_external_arrivals: vec![0.5],
            class_throughput: vec![vec![0.5]],
            class_service_rates: vec![vec![1.0]],
        }
    }

    fn planned(s: &RunSettings, data: &OrthantData) -> (Vec<StatusLine>, Result<Plan, String>) {
        let mut lines = Vec::new();
        let result = plan(s, data, &mut lines);
        (lines, result)
    }

    #[test]
    fn the_icu_styles_read_as_foundation_wrote_them() {
        // Measured with Swift 6.4.2 on macOS 27.2 (en_US).
        let significant: &[(f64, &str)] = &[
            (405.0, "405.0"),
            (2147.4, "2,147"),
            (2146.5, "2,146"),
            (2147.5, "2,148"),
            (5.0, "5.000"),
            (9.085789155072227, "9.086"),
            (15.0, "15.00"),
            (0.001234567, "0.001235"),
            (0.00012345, "0.0001234"),
            (1e-10, "0.0000000001000"),
            (12345.6, "12,350"),
            (99999.5, "100,000"),
            (9999.5, "10,000"),
            (9999.4, "9,999"),
            (1234567.0, "1,235,000"),
            (1e21, "1,000,000,000,000,000,000,000"),
            (0.5, "0.5000"),
            (0.0, "0.000"),
            (1.00025, "1.000"),
            (123.45, "123.4"),
            (123.55, "123.6"),
            (1.5e-7, "0.0000001500"),
            (-2.5, "-2.500"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "∞"),
        ];
        for (x, want) in significant {
            assert_eq!(icu_significant(*x, 4), *want, "{x}");
        }
        let compact: &[(f64, &str)] = &[
            (25260.0, "25.26K"),
            (1000.0, "1.000K"),
            (999.0, "999.0"),
            (999.95, "1.000K"),
            (999.94, "999.9"),
            (20.0, "20.00"),
            (1.0, "1.000"),
            (999950.0, "1.000M"),
            (999949.0, "999.9K"),
            (1.5e9, "1.500B"),
            (1e12, "1.000T"),
            (1e15, "1000T"),
            (2.5e18, "2,500,000T"),
            (123456789.0, "123.5M"),
            (12345678901234.0, "12.35T"),
            (1234.5, "1.234K"),
            (1235.5, "1.236K"),
            (99995.0, "100.0K"),
            (160001.0, "160.0K"),
            (2147483647.0, "2.147B"),
            (1e20, "100,000,000T"),
            (673680.0, "673.7K"),
            (16842100.0, "16.84M"),
            (9431578940.0, "9.432B"),
        ];
        for (x, want) in compact {
            assert_eq!(icu_compact(*x, 4), *want, "{x}");
        }
        let scientific: &[(f64, &str)] = &[
            (1.0, "1E0"),
            (0.5, "5E-1"),
            (2147483648.0, "2.147484E9"),
            (4.5e10, "4.5E10"),
            (1.2345678e12, "1.234568E12"),
            (0.0, "0E0"),
            (1e300, "1E300"),
            (f64::INFINITY, "∞"),
            (f64::NAN, "NaN"),
            (3.14159265, "3.141593E0"),
            (1e-5, "1E-5"),
            (9999999990.0, "1E10"),
            (12799999999.999996, "1.28E10"),
            (3839999999.9999986, "3.84E9"),
            (0.19999999999999998, "2E-1"),
        ];
        for (x, want) in scientific {
            assert_eq!(icu_scientific(*x), *want, "{x}");
        }
    }

    #[test]
    fn the_automatic_plan_gives_0_90_34s_path_length_to_the_last_bit() {
        // golden/runs/DaiHarrison92.d2.c2.1.inf/mlmc/record.json: "path length T" 9.085789155072227.
        let data = example_data("DaiHarrison92.d2.c2.1.inf.bnet");
        let preview = cost_preview(&data, 0.05, 0.01).expect("a plan");
        assert_eq!(cfmt::swift_description(preview.path_length), "9.085789155072227");
        assert_eq!(preview.levels, 3);
        // One station: no level numerator, so L = 1.
        let one = cost_preview(&one_station(), 0.05, 0.01).expect("a plan");
        assert_eq!(one.levels, 1);
        // η = −0.5, relaxation 1 / (2 · 0.25) = 2, so T = max(5, 0, 10) = 10.
        assert_eq!(one.path_length, 10.0);
        // Out-of-range inputs give no plan.
        assert_eq!(cost_preview(&one_station(), 1.0, 0.01), None);
        assert_eq!(cost_preview(&one_station(), 0.05, 0.0), None);
    }

    #[test]
    fn the_automatic_sample_count_is_the_solvers_formula_and_refuses_an_overflow() {
        // Measured in Swift with mlmcAutomaticSamples.
        for (gamma, levels, want) in [(0.05, 3, 25260.0), (0.05, 1, 20.0), (0.05, 2, 840.0), (0.05, 5, 16842100.0), (0.5, 3, 42.0), (0.1, 4, 44440.0), (0.25, 6, 32760.0), (0.01, 2, 20200.0), (0.05, 8, 215578947360.0)] {
            assert_eq!(automatic_samples(gamma, levels), Some(want), "γ={gamma} L={levels}");
        }
        assert_eq!(automatic_samples(0.05, 236), None);
        assert_eq!(automatic_samples(0.05, 0), None);
        assert_eq!(automatic_samples(1.0, 3), None);
    }

    #[test]
    fn the_linear_system_pivots_and_refuses_a_singular_matrix() {
        let a = vec![vec![0.0, 2.0], vec![1.0, 1.0]];
        assert_eq!(solve_linear_system(&a, &[4.0, 3.0]), Some(vec![1.0, 2.0]));
        assert_eq!(solve_linear_system(&[vec![1.0, 2.0], vec![2.0, 4.0]], &[1.0, 2.0]), None);
        assert_eq!(solve_linear_system(&[vec![1.0]], &[1.0, 2.0]), None);
        assert_eq!(solve_linear_system(&[vec![1e-15]], &[1.0]), None);
    }

    #[test]
    fn a_singular_reflection_or_an_invalid_override_leaves_no_t_or_l() {
        let refusal = "Qnet could not derive finite positive T and L values. Supply deliberate T/L overrides after reviewing finite-horizon and discretization bias, or use Adaptive Low-Rank BAR.";
        let mut singular = one_station();
        singular.r = vec![vec![0.0]];
        let (lines, result) = planned(&RunSettings::golden(), &singular);
        assert_eq!(result, Err(refusal.to_string()));
        assert!(lines.is_empty(), "{lines:?}");
        // Overriding both T and L lets a singular SRBM run.
        let mut s = RunSettings::golden();
        s.mlmc_override_t = true;
        s.mlmc_t = 2.0;
        s.mlmc_override_l = true;
        s.mlmc_l = 2;
        assert!(planned(&s, &singular).1.is_ok());
        // A non-positive override is no value at all.
        for (t, l) in [(0.0, 3), (f64::NAN, 3), (f64::INFINITY, 3), (2.0, 0), (2.0, -1)] {
            s.mlmc_t = t;
            s.mlmc_l = l;
            assert_eq!(planned(&s, &one_station()).1, Err(refusal.to_string()), "T={t} L={l}");
        }
    }

    #[test]
    fn an_incompatible_gamma_falls_back_to_the_default_with_a_warning_and_a_bad_epsilon_silently() {
        let data = example_data("DaiHarrison92.d2.c2.1.inf.bnet");
        let mut s = RunSettings::golden();
        s.mlmc_gamma = 0.03;
        s.mlmc_epsilon = 2.0;
        let (lines, result) = planned(&s, &data);
        assert_eq!(
            lines,
            vec![
                StatusLine::warning("Stored MLMC γ=0.03 is incompatible with the native solver because 1/γ must be an integer; using the documented default γ=0.05."),
                StatusLine::info("Estimated MLMC plan: T≈9.086, L=3, N≈25.26K per replication."),
            ]
        );
        let plan = result.expect("a plan");
        assert_eq!((plan.gamma, plan.epsilon), (0.05, 0.01));
        for bad in [f64::NAN, 0.0, 1.0, -0.5, 0.3] {
            s.mlmc_gamma = bad;
            let (lines, _) = planned(&s, &data);
            assert_eq!(lines[0].severity, Severity::Warning, "γ={bad}");
            assert!(lines[0].text.starts_with(&format!("Stored MLMC γ={} is incompatible", cfmt::swift_description(bad))));
        }
        // 1/γ within 1e-9 of an integer is accepted as it is.
        for good in [0.5, 0.25, 0.1, 0.01, 0.2] {
            s.mlmc_gamma = good;
            let (lines, result) = planned(&s, &data);
            assert_eq!(lines.len(), 1, "γ={good}: {lines:?}");
            assert_eq!(result.expect("a plan").gamma, good);
        }
    }

    #[test]
    fn each_sample_plan_refusal_has_0_90_34s_sentence() {
        let data = example_data("DaiHarrison92.d2.c2.1.inf.bnet");
        let adaptive_refusal = "Adaptive MLMC requires a positive batch size and at least two minimum/maximum samples so it can estimate variance, with batch and minimum no larger than the maximum. The maximum is the hard cost cap.";
        for (batch, minimum, maximum) in [(0, 5000, 200_000), (1000, 1, 200_000), (1000, 5000, 1), (300_000, 5000, 200_000), (1000, 300_000, 200_000)] {
            let mut s = RunSettings::golden();
            s.mlmc_adaptive = true;
            (s.mlmc_batch_size, s.mlmc_min_samples, s.mlmc_max_samples) = (batch, minimum, maximum);
            let (lines, result) = planned(&s, &data);
            assert_eq!(result, Err(adaptive_refusal.to_string()), "{batch} {minimum} {maximum}");
            assert!(lines.is_empty());
        }
        let mut s = RunSettings::golden();
        s.mlmc_override_n = true;
        s.mlmc_n = 0;
        assert_eq!(planned(&s, &data).1, Err("The explicit sample count N must be positive.".to_string()));
        // While adaptive, the N override is ignored.
        s.mlmc_adaptive = true;
        assert!(planned(&s, &data).1.is_ok());

        let mut s = RunSettings::golden();
        s.mlmc_override_l = true;
        s.mlmc_l = 250;
        assert_eq!(
            planned(&s, &data).1,
            Err("The automatic sample formula overflows at L=250. Choose a deliberate positive N override after reviewing bias, enable adaptive sampling with a finite maximum-sample cap, or use Adaptive Low-Rank BAR.".to_string())
        );
        let limit = "The resolved sample count exceeds the native solver's 2147483647 sample limit. Choose a smaller explicit N, use adaptive sampling with a finite cap, or increase ε/reduce L after reviewing bias.";
        s.mlmc_l = 8; // N ≈ 2.2e11
        assert_eq!(planned(&s, &data).1, Err(limit.to_string()));
        let mut s = RunSettings::golden();
        s.mlmc_override_n = true;
        s.mlmc_n = 2_147_483_648;
        assert_eq!(planned(&s, &data).1, Err(limit.to_string()));
        s.mlmc_n = 2_147_483_647;
        assert_ne!(planned(&s, &data).1, Err(limit.to_string()));
    }

    #[test]
    fn a_path_grid_outside_the_native_integer_range_is_refused_with_both_counts() {
        let data = example_data("DaiHarrison92.d2.c2.1.inf.bnet");
        let mut s = RunSettings::golden();
        (s.mlmc_override_t, s.mlmc_t, s.mlmc_override_l, s.mlmc_l, s.mlmc_override_n, s.mlmc_n) = (true, 10.0, true, 7, true, 100);
        let (lines, result) = planned(&s, &data);
        assert_eq!(
            result,
            Err("The finest/coupled path grids would require about 1.28E10 and 3.84E9 loop iterations, respectively; at least one exceeds the native solver's safe integer grid. Reduce T or L, increase γ, or use Adaptive Low-Rank BAR.".to_string())
        );
        assert!(lines.is_empty(), "the plan line comes after this check: {lines:?}");
        // A finest grid below one step: T = 0.01, L = 1 gives 0.2 and no coupled grid.
        (s.mlmc_t, s.mlmc_l) = (0.01, 1);
        assert_eq!(
            planned(&s, &data).1,
            Err("The finest/coupled path grids would require about 2E-1 and 0E0 loop iterations, respectively; at least one exceeds the native solver's safe integer grid. Reduce T or L, increase γ, or use Adaptive Low-Rank BAR.".to_string())
        );
    }

    #[test]
    fn the_work_budget_counts_replications_and_the_antithetic_pass() {
        // 25,260 samples at T ≈ 9.086 is about 2.7e7 vector steps per replication: 37 replications
        // fit the 1e9 budget, 38 do not, and the antithetic pass halves that.
        let data = example_data("DaiHarrison92.d2.c2.1.inf.bnet");
        let mut s = RunSettings::golden();
        s.mlmc_replications = 37;
        assert!(planned(&s, &data).1.is_ok());
        s.mlmc_replications = 38;
        let (lines, result) = planned(&s, &data);
        let preview = "Estimated MLMC plan: T≈9.086, L=3, N≈25.26K per replication.";
        assert_eq!(lines, vec![StatusLine::info(preview)]);
        assert_eq!(
            result,
            Err(format!("{preview} Across 38 replications, its expected coupled-path work exceeds Qnet's safety budget (1 billion vector steps or 20 billion coordinate steps, including γ and antithetic cost). Reduce the adaptive maximum or choose deliberate T/L/N values after reviewing bias, or use Adaptive Low-Rank BAR."))
        );
        s.mlmc_replications = 19;
        s.mlmc_antithetic = true;
        assert!(planned(&s, &data).1.is_err());
        s.mlmc_replications = 18;
        assert!(planned(&s, &data).1.is_ok());
        // K = max(1, replications).
        s.mlmc_replications = -4;
        assert_eq!(planned(&s, &data).1.expect("a plan").replications, 1);
    }

    #[test]
    fn the_plan_line_names_the_explicit_or_adaptive_sample_count() {
        let data = example_data("DaiHarrison92.d2.c2.1.inf.bnet");
        let mut s = RunSettings::golden();
        s.mlmc_override_n = true;
        let (lines, _) = planned(&s, &data);
        assert_eq!(lines, vec![StatusLine::info("Estimated MLMC plan: T≈9.086, L=3, N=25000 per replication.")]);
        s.mlmc_adaptive = true;
        let (lines, result) = planned(&s, &data);
        assert_eq!(lines, vec![StatusLine::info("Estimated MLMC plan: T≈9.086, L=3, maximum N=200000 per replication.")]);
        assert_eq!(result.expect("a plan").samples, 200_000.0);
    }

    #[test]
    fn every_override_becomes_a_flag_and_a_summary_entry() {
        let data = example_data("DaiHarrison92.d2.c2.1.inf.bnet");
        let s = RunSettings::golden();
        let plan = planned(&s, &data).1.expect("a plan");
        assert!(flags(&s).is_empty());
        assert_eq!(cli_summary(&s, &plan), "γ=0.05, ε=0.01");

        let mut s = RunSettings::golden();
        (s.mlmc_override_t, s.mlmc_t, s.mlmc_override_l, s.mlmc_l, s.mlmc_override_n, s.mlmc_n) = (true, 2.5, true, 2, true, 4000);
        (s.mlmc_backend, s.mlmc_threads, s.mlmc_antithetic, s.mlmc_replications, s.mlmc_gamma, s.mlmc_epsilon) = (3, 4, true, 3, 0.1, 0.02);
        let plan = planned(&s, &data).1.expect("a plan");
        assert_eq!(flags(&s), ["--T", "2.5", "--L", "2", "--N", "4000", "--backend", "serial", "--threads", "4", "--antithetic"]);
        assert_eq!(cli_summary(&s, &plan), "γ=0.1, ε=0.02, T=2.5, L=2, N=4000, antithetic, K=3 replications");

        s.mlmc_adaptive = true;
        s.mlmc_backend = 1;
        let plan = planned(&s, &data).1.expect("a plan");
        assert_eq!(
            flags(&s),
            ["--T", "2.5", "--L", "2", "--backend", "openmp", "--threads", "4", "--antithetic", "--adaptive", "--batch-size", "1000", "--min-samples", "5000", "--max-samples", "200000"]
        );
        assert_eq!(cli_summary(&s, &plan), "γ=0.1, ε=0.02, T=2.5, L=2, antithetic, adaptive (max 200000), K=3 replications");
        s.mlmc_backend = 2;
        assert_eq!(flags(&s)[4..6], ["--backend", "accelerate"]);
        s.mlmc_backend = 7;
        assert!(!flags(&s).contains(&"--backend".to_string()));
    }
}
