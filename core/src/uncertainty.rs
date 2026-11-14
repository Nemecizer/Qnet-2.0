//! Uncertainty in the inputs (new in 2.1, ROADMAP D7): "my arrival rate is 0.8 give or take 10 %:
//! how sure is the answer?". Three pieces, each tested against a closed form:
//!
//! 1. **Sampling the closed form** (`propagate`, `propagate_jackson`). The uncertain rates are
//!    drawn from their laws with a fixed-seed generator and the Jackson network is solved exactly
//!    (`jackson::solve`) for every draw. The result is the distribution of a measure: mean, median,
//!    2.5 % and 97.5 % quantiles, the fraction of draws with an overloaded station, and the Monte
//!    Carlo standard error of each. The only error is the sampling error, which is reported.
//! 2. **The delta method** (`delta`): Var f ≈ Σ (∂f/∂θ)² σ², from the exact derivatives of
//!    `sensitivity::derivative`. Instant, and wrong near ρ → 1 where f is far from linear.
//! 3. **Variance shares**: which input's uncertainty matters. First-order and total Sobol' indices
//!    by the pick-freeze design of Saltelli et al. (2010) for route 1, with standard errors; the
//!    delta method's shares (∂f/∂θ·σ)²/Σ for route 2.
//!
//! The laws. A rate "θ₀ ± c, read as a standard deviation" is lognormal with mean θ₀ and
//! coefficient of variation c: ln θ ~ N(ln θ₀ − s²/2, s²), s² = ln(1 + c²) (positive, mean exactly
//! θ₀). "Read as a range" it is uniform on [θ₀(1 − c), θ₀(1 + c)]. An interval [a, b] read as a
//! 95 % interval is the lognormal whose 2.5 % and 97.5 % quantiles are a and b; read as a range,
//! uniform on [a, b]. Inputs are independent, except that several may share one driver (the
//! "arrival rates move together" switch): they are then increasing functions of one standard
//! normal, i.e. perfectly rank-correlated.
//!
//! Two facts the interface must say, and does (src/uncertainty):
//! - Quantiles are taken over the draws that have a steady state, and are order statistics
//!   (x₍⌈qn⌉₎, no interpolation). For a measure that is monotone in one input the q-quantile of
//!   the measure is then the measure at the q-quantile of the input, exactly (tested).
//! - L grows like 1/(1 − ρ), so whenever the input law puts density at ρ = 1 the mean over the
//!   stable cases is infinite (∫ dρ/(1 − ρ) diverges, logarithmically) and the variance more so.
//!   A lognormal always does; a uniform range does when it reaches ρ = 1. Whether it does is
//!   decided analytically, not from the sample (`mean_exists`): ρ_i = α_i/(c_i μ_i) rises with
//!   every arrival rate (the traffic equations are linear with non-negative coefficients) and
//!   falls with μ_i, so its supremum over a box of ranges is at one corner — every arrival rate at
//!   its upper end, μ_i at its lower end — and it is unbounded as soon as a lognormal input moves
//!   it. Where the supremum reaches 1 at a station the measure depends on, no mean, standard
//!   deviation, standard error of either or sampled variance share is reported (a sample average
//!   of a quantity with no mean is not an estimate of anything, however calm it looks when
//!   overload is many standard deviations away); the median, the quantiles and the chance of
//!   overload are, and the variance shares are the delta method's.
//!
//! Sources. Saltelli, Annoni, Azzini, Campolongo, Ratto & Tarantola (2010), "Variance based
//! sensitivity analysis of model output. Design and estimator for the total sensitivity index",
//! Comput. Phys. Commun. 181:259–270 (first-order estimator, Table 2 (b); total-effect estimator
//! of Jansen 1999, Table 2 (f)). Sobol' (1993), Math. Model. Comput. Exp. 1:407–414. Ishigami &
//! Homma (1990), Proc. ISUMA '90, 398–403 (the test function; values as in Saltelli et al. 2008,
//! *Global Sensitivity Analysis: The Primer*, §4.3). Blackman & Vigna (2021), "Scrambled linear
//! pseudorandom number generators", ACM TOMS 47(4) (xoshiro256++); Steele, Lea & Flood (2014)
//! (SplitMix64, the seeding). Box & Muller (1958), Ann. Math. Statist. 29:610–611. Marsaglia
//! (2004), "Evaluating the normal distribution", J. Stat. Softw. 11(4) (Φ by its Taylor series).
//! The distribution-free interval for a quantile from order statistics: David & Nagaraja (2003),
//! *Order Statistics*, 3rd ed., §7.1.

use crate::jackson::{self, JacksonModel, JacksonSolution};
use crate::sensitivity::{self, Family, Measure};

/// Φ⁻¹(0.975).
pub const Z975: f64 = 1.959963984540054;
/// The histogram's number of bins.
pub const BINS: usize = 40;
/// The histogram stops at median + `TAIL_REACH`·(median − 2.5 % quantile) when the 99.5 % point is
/// further out (for a normal sample that is 15 standard deviations: never the nearer of the two).
pub const TAIL_REACH: f64 = 8.0;
/// The most exact solutions spent on the variance shares (the pick-freeze design takes
/// (k + 1) per row for k inputs); the rows are cut to fit, never below `SOBOL_MIN_ROWS`.
pub const SOBOL_BUDGET: usize = 400_000;
pub const SOBOL_MIN_ROWS: usize = 500;
/// The linear approximation is flagged when it differs from the sampled answer by more than this
/// (`linear_disagreement`).
pub const DISAGREE: f64 = 0.10;

// ── The generator ───────────────────────────────────────────────────────────────────────────

/// xoshiro256++ seeded by SplitMix64: the same seed gives the same draws on every machine.
#[derive(Clone, Debug)]
pub struct Rng {
    s: [u64; 4],
}

/// One step of SplitMix64.
pub fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut x = seed;
        Rng { s: [splitmix64(&mut x), splitmix64(&mut x), splitmix64(&mut x), splitmix64(&mut x)] }
    }

    pub fn next_u64(&mut self) -> u64 {
        let s = &mut self.s;
        let result = s[0].wrapping_add(s[3]).rotate_left(23).wrapping_add(s[0]);
        let t = s[1] << 17;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(45);
        result
    }

    /// Uniform on the open interval (0, 1): 53 bits, never 0 or 1.
    pub fn uniform(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 0.5) / 9_007_199_254_740_992.0
    }

    /// A standard normal by Box–Muller (one per two uniforms: no state is carried between calls).
    pub fn normal(&mut self) -> f64 {
        let (u1, u2) = (self.uniform(), self.uniform());
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }
}

/// The standard normal distribution function, by Marsaglia's series
/// Φ(x) = ½ + φ(x)·(x + x³/3 + x⁵/(3·5) + …), which converges for every x.
pub fn normal_cdf(x: f64) -> f64 {
    if x > 8.2 {
        return 1.0;
    }
    if x < -8.2 {
        return 0.0;
    }
    let q = x * x;
    let (mut s, mut t, mut b, mut i) = (x, 0.0, x, 1.0);
    while s != t {
        t = s;
        i += 2.0;
        b *= q / i;
        s = t + b;
    }
    (0.5 + s * (-0.5 * q - 0.918_938_533_204_672_7).exp()).clamp(0.0, 1.0)
}

// ── The laws ────────────────────────────────────────────────────────────────────────────────

/// What is believed about one input.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Law {
    /// ln θ ~ N(m, s²).
    LogNormal { m: f64, s: f64 },
    /// θ uniform on [lo, hi].
    Uniform { lo: f64, hi: f64 },
    /// Known exactly.
    Fixed(f64),
}

impl Law {
    /// θ₀ ± cv·θ₀ read as a standard deviation: lognormal with mean θ₀ and that coefficient of variation.
    pub fn relative_sd(nominal: f64, cv: f64) -> Result<Law, String> {
        if !(nominal > 0.0) || !nominal.is_finite() {
            return Err("A rate must be positive.".into());
        }
        if !(cv >= 0.0) || !cv.is_finite() {
            return Err("An uncertainty can't be negative.".into());
        }
        if cv == 0.0 {
            return Ok(Law::Fixed(nominal));
        }
        let s2 = (1.0 + cv * cv).ln();
        Ok(Law::LogNormal { m: nominal.ln() - 0.5 * s2, s: s2.sqrt() })
    }

    /// θ₀ ± cv·θ₀ read as a range: uniform on [θ₀(1 − cv), θ₀(1 + cv)].
    pub fn relative_range(nominal: f64, cv: f64) -> Result<Law, String> {
        if !(nominal > 0.0) || !nominal.is_finite() {
            return Err("A rate must be positive.".into());
        }
        if !(cv >= 0.0) || !cv.is_finite() {
            return Err("An uncertainty can't be negative.".into());
        }
        if cv >= 1.0 {
            return Err("A range of ±100 % or more would let the rate reach zero: choose less, or read the uncertainty as a standard deviation.".into());
        }
        if cv == 0.0 {
            return Ok(Law::Fixed(nominal));
        }
        Ok(Law::Uniform { lo: nominal * (1.0 - cv), hi: nominal * (1.0 + cv) })
    }

    /// [lo, hi] read as a 95 % interval: the lognormal with those 2.5 % and 97.5 % quantiles.
    pub fn interval95(lo: f64, hi: f64) -> Result<Law, String> {
        Law::check_interval(lo, hi)?;
        Ok(Law::LogNormal { m: 0.5 * (lo.ln() + hi.ln()), s: (hi.ln() - lo.ln()) / (2.0 * Z975) })
    }

    /// [lo, hi] read as a range: uniform on it.
    pub fn interval_range(lo: f64, hi: f64) -> Result<Law, String> {
        Law::check_interval(lo, hi)?;
        Ok(Law::Uniform { lo, hi })
    }

    fn check_interval(lo: f64, hi: f64) -> Result<(), String> {
        if !(lo > 0.0) || !lo.is_finite() || !hi.is_finite() {
            return Err("An interval for a rate needs two positive ends.".into());
        }
        if !(hi > lo) {
            return Err("An interval's upper end must be above its lower end.".into());
        }
        Ok(())
    }

    /// The value at the driver z (a standard normal): increasing in z.
    pub fn at(&self, z: f64) -> f64 {
        match *self {
            Law::LogNormal { m, s } => (m + s * z).exp(),
            Law::Uniform { lo, hi } => lo + (hi - lo) * normal_cdf(z),
            Law::Fixed(v) => v,
        }
    }

    pub fn mean(&self) -> f64 {
        match *self {
            Law::LogNormal { m, s } => (m + 0.5 * s * s).exp(),
            Law::Uniform { lo, hi } => 0.5 * (lo + hi),
            Law::Fixed(v) => v,
        }
    }

    pub fn sd(&self) -> f64 {
        match *self {
            Law::LogNormal { s, .. } => self.mean() * ((s * s).exp() - 1.0).sqrt(),
            Law::Uniform { lo, hi } => (hi - lo) / 12f64.sqrt(),
            Law::Fixed(_) => 0.0,
        }
    }

    /// P(θ ≤ x).
    pub fn cdf(&self, x: f64) -> f64 {
        match *self {
            Law::LogNormal { m, s } => {
                if x <= 0.0 {
                    0.0
                } else {
                    normal_cdf((x.ln() - m) / s)
                }
            }
            Law::Uniform { lo, hi } => ((x - lo) / (hi - lo)).clamp(0.0, 1.0),
            Law::Fixed(v) => {
                if x >= v {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }

    /// The 2.5 % and 97.5 % quantiles.
    pub fn interval(&self) -> (f64, f64) {
        match *self {
            Law::LogNormal { m, s } => ((m - Z975 * s).exp(), (m + Z975 * s).exp()),
            Law::Uniform { lo, hi } => (lo + 0.025 * (hi - lo), lo + 0.975 * (hi - lo)),
            Law::Fixed(v) => (v, v),
        }
    }

    pub fn is_fixed(&self) -> bool {
        matches!(self, Law::Fixed(_))
    }
}

// ── Route 1: sampling ───────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Options {
    /// The number of draws (20 000 by default in the interface).
    pub samples: usize,
    pub seed: u64,
    /// Whether to estimate the variance shares too.
    pub sobol: bool,
}

/// An estimate and its Monte Carlo standard error.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stat {
    pub value: f64,
    pub se: f64,
}

/// One factor's share of the output variance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Index {
    /// First-order index Sᵢ = Var(E[Y | Xᵢ])/Var Y: the share due to this input alone.
    pub first: Stat,
    /// Total index: the share that would remain if every other input were known.
    pub total: Stat,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Histogram {
    /// `counts[b]` draws fall in [lo + b·w, lo + (b + 1)·w), w = (hi − lo)/counts.len(); the last bin includes hi.
    pub lo: f64,
    pub hi: f64,
    pub counts: Vec<usize>,
    /// Stable draws above `hi` (the top 0.5 %, or more of a long tail: see `TAIL_REACH`), left off
    /// so that the tail does not flatten the rest.
    pub above: usize,
}

/// The measure over the stable draws.
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub mean: Stat,
    pub sd: f64,
    pub median: Stat,
    pub q025: Stat,
    pub q975: Stat,
    pub min: f64,
    pub max: f64,
    pub histogram: Histogram,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sobol {
    /// Rows of the pick-freeze design, and the exact solutions it took.
    pub rows: usize,
    pub evaluations: usize,
    /// One per factor, in the order given.
    pub indices: Vec<Index>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Propagation {
    pub samples: usize,
    /// Draws with no steady state (a station at ρ ≥ 1).
    pub unstable: usize,
    /// Their fraction, with the binomial standard error.
    pub p_unstable: Stat,
    /// None when fewer than two draws have a steady state.
    pub summary: Option<Summary>,
    /// None when not asked for, or when too few rows are stable to estimate anything.
    pub sobol: Option<Sobol>,
}

/// The rows the pick-freeze design gets for k factors out of n draws.
pub fn sobol_rows(n: usize, k: usize) -> usize {
    n.min((SOBOL_BUDGET / (k + 1)).max(SOBOL_MIN_ROWS))
}

fn mean_sd(xs: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    let mean = xs.iter().sum::<f64>() / n;
    let var = if xs.len() > 1 { xs.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (n - 1.0) } else { 0.0 };
    (mean, var.sqrt())
}

/// The q-quantile of a sorted sample as an order statistic, x₍⌈qn⌉₎, with the standard error read
/// off the distribution-free 95 % interval (the order statistics at nq ± 1.96·√(nq(1 − q))).
pub fn quantile(sorted: &[f64], q: f64) -> Stat {
    let n = sorted.len();
    let nf = n as f64;
    let at = |rank: f64| sorted[(rank.max(1.0).min(nf) as usize) - 1];
    let half = Z975 * (nf * q * (1.0 - q)).sqrt();
    let (lo, hi) = (at((nf * q - half).floor()), at((nf * q + half).ceil()));
    Stat { value: at((nf * q).ceil()), se: (hi - lo) / (2.0 * Z975) }
}

fn summarise(values: &[f64]) -> Option<Summary> {
    if values.len() < 2 {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let (mean, sd) = mean_sd(values);
    let n = sorted.len();
    let (median, q025) = (quantile(&sorted, 0.5), quantile(&sorted, 0.025));
    // The histogram runs to the 99.5 % point — or, for a long tail, to `TAIL_REACH` times the
    // median's distance from the 2.5 % point above the median, so that the bulk stays readable.
    let (lo, top) = (sorted[0], quantile(&sorted, 0.995).value.min(median.value + TAIL_REACH * (median.value - q025.value)));
    let hi = if top > lo { top } else { sorted[n - 1] };
    let mut counts = vec![0usize; if hi > lo { BINS } else { 1 }];
    let mut above = 0;
    for &x in &sorted {
        if x > hi {
            above += 1;
        } else if hi > lo {
            let b = (((x - lo) / (hi - lo)) * BINS as f64) as usize;
            counts[b.min(BINS - 1)] += 1;
        } else {
            counts[0] += 1;
        }
    }
    Some(Summary {
        mean: Stat { value: mean, se: sd / (n as f64).sqrt() },
        sd,
        median,
        q025,
        q975: quantile(&sorted, 0.975),
        min: lo,
        max: sorted[n - 1],
        histogram: Histogram { lo, hi, counts, above },
    })
}

/// Draws the inputs and evaluates `f` at each draw.
///
/// `laws[i]` is input i's law; `factors[g]` lists the inputs that share driver g (one standard
/// normal each: inputs of one factor move together). Every input that is not `Fixed` belongs to
/// exactly one factor. `f` answers None where the model has no steady state. `progress(done,
/// total)` is called now and then with the number of evaluations so far.
///
/// The main sample (matrix A, `opts.samples` rows) gives the distribution. With `opts.sobol`, a
/// second independent sample B and the k mixed matrices A_B⁽ⁱ⁾ (A with factor i's column from B)
/// give, over the first `sobol_rows` rows (Saltelli et al. 2010, Table 2):
///   Sᵢ  = (1/N) Σⱼ (f(B)ⱼ − f̄)·(f(A_B⁽ⁱ⁾)ⱼ − f(A)ⱼ) / V,   Sₜᵢ = (1/2N) Σⱼ (f(A)ⱼ − f(A_B⁽ⁱ⁾)ⱼ)² / V,
/// f̄ and V the mean and variance of f over A and B together. (Centring f(B) on f̄ leaves the
/// expectation alone, the second factor having mean zero, and takes f̄² out of the estimator's
/// variance: without it a measure whose mean is large beside its spread has useless shares.) Rows where any of the three has no steady state are
/// left out. The standard error of a ratio u̅/V is that of the mean of its influence values
/// (uⱼ − u̅)/V − (u̅/V)·(wⱼ − V)/V, wⱼ = ((f(A)ⱼ − f̄)² + (f(B)ⱼ − f̄)²)/2 (the delta method for a ratio).
pub fn propagate(laws: &[Law], factors: &[Vec<usize>], f: &mut dyn FnMut(&[f64]) -> Option<f64>, opts: &Options, progress: &mut dyn FnMut(usize, usize)) -> Propagation {
    let k = factors.len();
    let n = opts.samples;
    let rows = if opts.sobol && k >= 2 { sobol_rows(n, k) } else { 0 };
    let total = n + rows * (k + 1);
    let mut done = 0usize;
    let mut theta: Vec<f64> = laws.iter().map(|l| l.at(0.0)).collect();
    let mut eval = |z: &[f64], theta: &mut Vec<f64>, done: &mut usize| {
        for (g, members) in factors.iter().enumerate() {
            for &i in members {
                theta[i] = laws[i].at(z[g]);
            }
        }
        let y = f(theta).filter(|v| v.is_finite());
        *done += 1;
        if *done % 2000 == 0 {
            progress(*done, total);
        }
        y
    };

    // A: the main sample. The drivers of its first `rows` rows are kept for the mixed matrices.
    let mut rng_a = Rng::new(opts.seed);
    let mut za = vec![0.0; rows * k];
    let mut ya: Vec<Option<f64>> = Vec::with_capacity(n);
    let mut z = vec![0.0; k];
    for j in 0..n {
        for zg in z.iter_mut() {
            *zg = rng_a.normal();
        }
        if j < rows {
            za[j * k..(j + 1) * k].copy_from_slice(&z);
        }
        ya.push(eval(&z, &mut theta, &mut done));
    }
    let stable: Vec<f64> = ya.iter().flatten().copied().collect();
    let unstable = n - stable.len();
    let p = if n > 0 { unstable as f64 / n as f64 } else { 0.0 };
    let p_unstable = Stat { value: p, se: if n > 0 { (p * (1.0 - p) / n as f64).sqrt() } else { 0.0 } };
    let summary = summarise(&stable);

    let sobol = if !opts.sobol || k == 0 {
        None
    } else if k == 1 {
        // One factor carries all the variance there is.
        summary.as_ref().filter(|s| s.sd > 0.0).map(|_| Sobol { rows: 0, evaluations: 0, indices: vec![Index { first: Stat { value: 1.0, se: 0.0 }, total: Stat { value: 1.0, se: 0.0 } }] })
    } else {
        // B: a second sample, from a stream of its own.
        let mut seed_b = opts.seed ^ 0x5851_F42D_4C95_7F2D;
        let mut rng_b = Rng::new(splitmix64(&mut seed_b));
        let mut zb = vec![0.0; rows * k];
        let mut yb: Vec<Option<f64>> = Vec::with_capacity(rows);
        for j in 0..rows {
            for g in 0..k {
                zb[j * k + g] = rng_b.normal();
            }
            yb.push(eval(&zb[j * k..(j + 1) * k], &mut theta, &mut done));
        }
        let both: Vec<f64> = (0..rows).filter(|&j| ya[j].is_some() && yb[j].is_some()).flat_map(|j| [ya[j].unwrap(), yb[j].unwrap()]).collect();
        let (f0, sd) = if both.len() >= 4 { mean_sd(&both) } else { (0.0, 0.0) };
        let v = sd * sd;
        let mut indices = Vec::with_capacity(k);
        for i in 0..k {
            let (mut u, mut e, mut w) = (Vec::new(), Vec::new(), Vec::new());
            for j in 0..rows {
                z.copy_from_slice(&za[j * k..(j + 1) * k]);
                z[i] = zb[j * k + i];
                let yab = eval(&z, &mut theta, &mut done);
                if let (Some(a), Some(b), Some(ab)) = (ya[j], yb[j], yab) {
                    u.push((b - f0) * (ab - a));
                    e.push(0.5 * (a - ab) * (a - ab));
                    w.push(0.5 * ((a - f0) * (a - f0) + (b - f0) * (b - f0)));
                }
            }
            let ratio = |num: &[f64]| {
                if num.len() < 2 || !(v > 0.0) {
                    return Stat { value: 0.0, se: 0.0 };
                }
                let m = num.iter().sum::<f64>() / num.len() as f64;
                let s = m / v;
                let psi: Vec<f64> = num.iter().zip(&w).map(|(x, wj)| (x - m) / v - s * (wj - v) / v).collect();
                Stat { value: s, se: mean_sd(&psi).1 / (num.len() as f64).sqrt() }
            };
            indices.push(Index { first: ratio(&u), total: ratio(&e) });
        }
        (v > 0.0).then_some(Sobol { rows, evaluations: rows * (k + 1), indices })
    };
    progress(total, total);
    Propagation { samples: n, unstable, p_unstable, summary, sobol }
}

/// One uncertain parameter of a Jackson network.
#[derive(Clone, Debug, PartialEq)]
pub struct Input {
    /// An arrival or service family (`sensitivity::Family::arrival`, `::service`).
    pub family: Family,
    pub law: Law,
}

/// The measure with every input at its value in `theta`; None where there is no steady state.
/// `scratch` is a copy of `base` that is overwritten.
pub fn evaluate_at(base: &JacksonModel, measure: Measure, inputs: &[Input], theta: &[f64], scratch: &mut JacksonModel) -> Option<f64> {
    scratch.gamma.copy_from_slice(&base.gamma);
    scratch.mu.copy_from_slice(&base.mu);
    for (input, &t) in inputs.iter().zip(theta) {
        let fam = &input.family;
        let dt = t - fam.current;
        for (g, dg) in scratch.gamma.iter_mut().zip(&fam.d_gamma) {
            *g += dt * dg;
        }
        if let Some(j) = fam.service {
            scratch.mu[j] = t;
        }
    }
    if scratch.gamma.iter().any(|g| *g < 0.0) || scratch.mu.iter().any(|m| !(*m > 0.0)) {
        return None;
    }
    let v = measure.value(&jackson::solve(scratch).ok()?);
    v.is_finite().then_some(v)
}

/// Route 1 for a Jackson network: each draw solved exactly by `jackson::solve`.
pub fn propagate_jackson(base: &JacksonModel, measure: Measure, inputs: &[Input], factors: &[Vec<usize>], opts: &Options, progress: &mut dyn FnMut(usize, usize)) -> Propagation {
    let laws: Vec<Law> = inputs.iter().map(|i| i.law).collect();
    let mut scratch = base.clone();
    propagate(&laws, factors, &mut |theta| evaluate_at(base, measure, inputs, theta, &mut scratch), opts, progress)
}

/// Whether the measure has a finite mean (and variance) over the cases with a steady state: true
/// when no station the measure depends on can come arbitrarily close to ρ = 1 under the inputs'
/// laws (module text). The stations: all of them for a network measure, its own for a station's
/// number, queue or sojourn time; a utilisation or a throughput is bounded and always has a mean.
///
/// For station i: a lognormal input that moves ρ_i (its service rate, or an arrival rate that
/// reaches it) has support (0, ∞), so ρ_i reaches 1 — false. Otherwise sup ρ_i is at the corner
/// of the uniform ranges (arrival rates at their upper ends, μ_i at its lower end), and the
/// answer is sup ρ_i < 1. The edge is conservative in one case: ranges that end exactly at
/// ρ_i = 1 through two or more independent inputs leave a finite mean (the corner carries too
/// little probability) but still no finite variance for two; it is reported as "no mean".
pub fn mean_exists(base: &JacksonModel, measure: Measure, inputs: &[Input]) -> bool {
    let d = base.mu.len();
    let stations: Vec<usize> = match measure {
        Measure::NetworkNumber | Measure::NetworkSojourn => (0..d).collect(),
        Measure::StationNumber(i) | Measure::StationQueue(i) | Measure::StationSojourn(i) => vec![i],
        Measure::StationUtilisation(_) | Measure::StationThroughput(_) => return true,
    };
    let alpha_of = |gamma: Vec<f64>| jackson::throughputs(&JacksonModel { gamma, ..base.clone() });
    // The throughputs with every uniform arrival rate at its upper end.
    let mut top = base.gamma.clone();
    for input in inputs {
        let upper = match input.law {
            Law::Uniform { hi, .. } => hi,
            Law::Fixed(v) => v,
            Law::LogNormal { .. } => input.family.current,
        };
        for (g, dg) in top.iter_mut().zip(&input.family.d_gamma) {
            *g += (upper - input.family.current) * dg;
        }
    }
    let Some(alpha) = alpha_of(top) else { return false };
    for &i in &stations {
        let mut mu = base.mu[i];
        for input in inputs {
            let serves = input.family.service == Some(i);
            // An arrival rate reaches station i when a unit of it adds to α_i.
            let reaches = input.family.d_gamma.iter().any(|g| *g != 0.0) && alpha_of(input.family.d_gamma.clone()).is_none_or(|a| a[i] > 1e-15);
            match input.law {
                Law::LogNormal { .. } if serves || reaches => return false,
                Law::Uniform { lo, .. } if serves => mu = lo,
                Law::Fixed(v) if serves => mu = v,
                _ => {}
            }
        }
        if !(alpha[i] < base.servers[i].max(1) as f64 * mu * (1.0 - 1e-12)) {
            return false;
        }
    }
    true
}

/// How far the linear approximation's 95 % interval is from the sampled one, as fractions of the
/// sampled interval's width: `linear_disagreement` without the standard deviations, for a
/// measure that has none (`mean_exists` false).
pub fn interval_disagreement(value: f64, delta_sd: f64, sampled: &Summary) -> f64 {
    let width = sampled.q975.value - sampled.q025.value;
    if !(width > 0.0) {
        return if delta_sd > 0.0 { f64::INFINITY } else { 0.0 };
    }
    let (lo, hi) = (value - Z975 * delta_sd, value + Z975 * delta_sd);
    ((hi - sampled.q975.value).abs() / width).max((lo - sampled.q025.value).abs() / width)
}

// ── Route 2: the delta method ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct Delta {
    /// Var f ≈ Σ_g (Σ_{i ∈ g} ∂f/∂θᵢ·σᵢ)²: inputs of one factor move together (correlation 1).
    pub variance: f64,
    pub sd: f64,
    /// Each factor's part of `variance`, as a fraction (all zero when nothing moves the measure).
    pub shares: Vec<f64>,
}

/// The first-order variance of a measure from its derivatives and the inputs' standard deviations.
pub fn delta(derivatives: &[f64], sds: &[f64], factors: &[Vec<usize>]) -> Delta {
    let parts: Vec<f64> = factors.iter().map(|members| members.iter().map(|&i| derivatives[i] * sds[i]).sum::<f64>().powi(2)).collect();
    let variance: f64 = parts.iter().sum();
    let shares = parts.iter().map(|p| if variance > 0.0 { p / variance } else { 0.0 }).collect();
    Delta { variance, sd: variance.sqrt(), shares }
}

/// ∂(measure)/∂θ for each input at the network as drawn, exactly (`sensitivity::derivative`).
pub fn jackson_derivatives(model: &JacksonModel, sol: &JacksonSolution, measure: Measure, inputs: &[Input]) -> Vec<f64> {
    inputs.iter().map(|i| sensitivity::derivative(model, sol, measure, &i.family)).collect()
}

/// How far the linear approximation (value ± 1.96·sd, normal) is from the sampled answer: the
/// largest of the relative difference of the two standard deviations and the differences of the
/// two interval ends as fractions of the sampled interval's width. Compared with `DISAGREE`.
pub fn linear_disagreement(value: f64, delta_sd: f64, sampled: &Summary) -> f64 {
    let width = sampled.q975.value - sampled.q025.value;
    if !(width > 0.0) || !(sampled.sd > 0.0) {
        return if delta_sd > 0.0 { f64::INFINITY } else { 0.0 };
    }
    let (lo, hi) = (value - Z975 * delta_sd, value + Z975 * delta_sd);
    ((delta_sd / sampled.sd - 1.0).abs()).max((hi - sampled.q975.value).abs() / width).max((lo - sampled.q025.value).abs() / width)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1e-300)
    }

    fn quiet() -> impl FnMut(usize, usize) {
        |_, _| {}
    }

    /// One M/M/1 queue.
    fn mm1(lambda: f64, mu: f64) -> JacksonModel {
        JacksonModel { ids: vec!["S1".into()], names: vec!["S1".into()], gamma: vec![lambda], p: vec![vec![0.0]], mu: vec![mu], servers: vec![1] }
    }

    fn arrival(model: &JacksonModel, law: Law) -> Input {
        Input { family: Family::arrival(vec![1.0], model.gamma[0]), law }
    }

    fn service(model: &JacksonModel, law: Law) -> Input {
        Input { family: Family::service(model, 0), law }
    }

    /// ∫ g(z) φ(z) dz over [a, b] by composite Simpson with n (even) panels.
    fn gauss_integral(a: f64, b: f64, n: usize, g: impl Fn(f64) -> f64) -> f64 {
        let h = (b - a) / n as f64;
        let phi = |z: f64| (-0.5 * z * z).exp() / (2.0 * PI).sqrt();
        let mut s = g(a) * phi(a) + g(b) * phi(b);
        for i in 1..n {
            let z = a + i as f64 * h;
            s += if i % 2 == 1 { 4.0 } else { 2.0 } * g(z) * phi(z);
        }
        s * h / 3.0
    }

    /// Whether a mean exists is decided from the laws, not the sample. M/M/1, λ = 0.5, μ = 1:
    /// L = ρ/(1 − ρ) has ∫ dρ/(1 − ρ) = ∞ up to ρ = 1. A uniform arrival range that stops short
    /// of μ leaves a finite mean (the closed form of `mm1_with_a_uniform_arrival_rate…`); one
    /// that reaches or passes μ does not; a lognormal always reaches it; a uniform service range
    /// is read at its lower end. A utilisation is bounded. In a two-station tandem a lognormal
    /// service rate at S2 takes the mean from S2's measures and the network's, not from S1's.
    #[test]
    fn a_mean_exists_exactly_when_no_station_can_reach_overload() {
        let m = mm1(0.5, 1.0);
        let uniform = |lo, hi| Law::interval_range(lo, hi).unwrap();
        let number = Measure::NetworkNumber;
        assert!(mean_exists(&m, number, &[arrival(&m, uniform(0.3, 0.99))]));
        assert!(!mean_exists(&m, number, &[arrival(&m, uniform(0.3, 1.0))]), "the range ends at ρ = 1");
        assert!(!mean_exists(&m, number, &[arrival(&m, uniform(0.3, 1.4))]));
        assert!(!mean_exists(&m, number, &[arrival(&m, Law::relative_sd(0.5, 0.01).unwrap())]), "a lognormal has density at every ρ");
        assert!(mean_exists(&m, number, &[arrival(&m, Law::Fixed(0.5))]));
        assert!(mean_exists(&m, number, &[service(&m, uniform(0.6, 2.0))]));
        assert!(!mean_exists(&m, number, &[service(&m, uniform(0.5, 2.0))]));
        assert!(!mean_exists(&m, number, &[service(&m, Law::relative_sd(1.0, 0.1).unwrap())]));
        // Both at once: sup ρ = (upper arrival)/(lower service).
        assert!(mean_exists(&m, number, &[arrival(&m, uniform(0.4, 0.7)), service(&m, uniform(0.8, 1.2))]));
        assert!(!mean_exists(&m, number, &[arrival(&m, uniform(0.4, 0.85)), service(&m, uniform(0.8, 1.2))]));
        assert!(mean_exists(&m, Measure::StationUtilisation(0), &[arrival(&m, Law::relative_sd(0.5, 0.3).unwrap())]));
        for measure in [Measure::StationNumber(0), Measure::StationQueue(0), Measure::StationSojourn(0), Measure::NetworkSojourn] {
            assert!(!mean_exists(&m, measure, &[arrival(&m, uniform(0.3, 1.4))]) && mean_exists(&m, measure, &[arrival(&m, uniform(0.3, 0.9))]));
        }
        // Tandem S1 → S2 with feedback from S2 to S1 (p = 0.3): α = γ/0.7 at both.
        let t = JacksonModel { ids: vec!["a".into(), "b".into()], names: vec!["S1".into(), "S2".into()], gamma: vec![0.35, 0.0], p: vec![vec![0.0, 1.0], vec![0.3, 0.0]], mu: vec![1.0, 1.0], servers: vec![1, 1] };
        let mu2 = Input { family: Family::service(&t, 1), law: Law::relative_sd(1.0, 0.1).unwrap() };
        assert!(mean_exists(&t, Measure::StationNumber(0), &[mu2.clone()]) && !mean_exists(&t, Measure::StationNumber(1), &[mu2.clone()]) && !mean_exists(&t, number, &[mu2]));
        let gamma = |law| Input { family: Family::arrival(vec![1.0, 0.0], 0.35), law };
        // α = γ/0.7 < 1 needs γ < 0.7 at both stations: the feedback carries the arrival rate to S2.
        assert!(mean_exists(&t, Measure::StationNumber(1), &[gamma(uniform(0.2, 0.69))]) && !mean_exists(&t, Measure::StationNumber(1), &[gamma(uniform(0.2, 0.71))]));
        // The sample agrees with the decision where it can: a range past μ has overloaded draws.
        let p = propagate_jackson(&m, number, &[arrival(&m, uniform(0.3, 1.4))], &[vec![0]], &Options { samples: 2000, seed: 1, sobol: false }, &mut quiet());
        assert!(p.unstable > 0);
        let p = propagate_jackson(&m, number, &[arrival(&m, uniform(0.3, 0.99))], &[vec![0]], &Options { samples: 2000, seed: 1, sobol: false }, &mut quiet());
        assert_eq!(p.unstable, 0);
    }

    // ── The generator and Φ ─────────────────────────────────────────────────────────────────

    /// SplitMix64 against the reference implementation's output for seed 1234567 (Vigna,
    /// prng.di.unimi.it/splitmix64.c; the same values Java's SplittableRandom gives).
    #[test]
    fn splitmix64_gives_the_reference_stream() {
        let mut x = 1234567u64;
        let got: Vec<u64> = (0..5).map(|_| splitmix64(&mut x)).collect();
        assert_eq!(got, [6457827717110365317, 3203168211198807973, 9817491932198370423, 4593380528125082431, 16408922859458223821]);
    }

    /// The uniform and the normal have their moments, to within four standard errors of 200 000
    /// draws (mean of U: 1/2 ± 4·0.2887/√n; of Z: 0 ± 4/√n; E Z² = 1 ± 4·√2/√n; E Z⁴ = 3 ± 4·√96/√n),
    /// and P(Z ≤ 1) = Φ(1) ± 4·√(pq/n).
    #[test]
    fn the_generator_has_the_moments_of_its_laws() {
        let n = 200_000usize;
        let nf = n as f64;
        let mut rng = Rng::new(7);
        let u: Vec<f64> = (0..n).map(|_| rng.uniform()).collect();
        assert!(u.iter().all(|x| *x > 0.0 && *x < 1.0));
        assert!((u.iter().sum::<f64>() / nf - 0.5).abs() < 4.0 * 0.2887 / nf.sqrt());
        let z: Vec<f64> = (0..n).map(|_| rng.normal()).collect();
        let m = |p: i32| z.iter().map(|x| x.powi(p)).sum::<f64>() / nf;
        assert!(m(1).abs() < 4.0 / nf.sqrt());
        assert!((m(2) - 1.0).abs() < 4.0 * 2f64.sqrt() / nf.sqrt());
        assert!((m(4) - 3.0).abs() < 4.0 * 96f64.sqrt() / nf.sqrt());
        let below = z.iter().filter(|x| **x <= 1.0).count() as f64 / nf;
        let p = normal_cdf(1.0);
        assert!((below - p).abs() < 4.0 * (p * (1.0 - p) / nf).sqrt());
    }

    /// Φ at tabulated points (Abramowitz & Stegun, Table 26.1, to 15 digits) and its symmetry.
    #[test]
    fn the_normal_distribution_function_matches_its_table() {
        for (x, p) in [(0.0, 0.5), (1.0, 0.841344746068543), (2.0, 0.977249868051821), (3.0, 0.998650101968370), (Z975, 0.975), (-1.0, 0.158655253931457)] {
            assert!((normal_cdf(x) - p).abs() < 1e-14, "Φ({x}) = {}", normal_cdf(x));
        }
        // Φ(−6) = 9.865876450377e−10: the lower tail keeps an absolute error near 1e−16.
        assert!((normal_cdf(-6.0) - 9.865876450377e-10).abs() < 1e-15);
        for x in [0.3, 1.7, 4.2] {
            assert!((normal_cdf(x) + normal_cdf(-x) - 1.0).abs() < 1e-15);
        }
    }

    // ── The laws ────────────────────────────────────────────────────────────────────────────

    /// "θ₀ ± c as a standard deviation" has mean θ₀ and standard deviation c·θ₀ exactly (lognormal
    /// moments); "as a range" is uniform with sd c·θ₀/√3; a 95 % interval returns its own ends.
    #[test]
    fn the_laws_have_the_moments_they_are_named_for() {
        let l = Law::relative_sd(0.8, 0.1).unwrap();
        assert!(close(l.mean(), 0.8, 1e-14) && close(l.sd(), 0.08, 1e-12));
        let u = Law::relative_range(0.8, 0.1).unwrap();
        assert_eq!(u, Law::Uniform { lo: 0.8 * 0.9, hi: 0.8 * 1.1 });
        assert!(close(u.mean(), 0.8, 1e-14) && close(u.sd(), 0.08 / 3f64.sqrt(), 1e-12));
        let i = Law::interval95(0.7, 0.95).unwrap();
        let (lo, hi) = i.interval();
        assert!(close(lo, 0.7, 1e-12) && close(hi, 0.95, 1e-12));
        assert!(close(i.cdf(0.7), 0.025, 1e-10) && close(i.cdf(0.95), 0.975, 1e-12));
        assert_eq!(Law::relative_sd(0.8, 0.0).unwrap(), Law::Fixed(0.8));
        assert!(Law::relative_range(0.8, 1.0).is_err() && Law::interval95(0.9, 0.7).is_err() && Law::interval_range(0.0, 1.0).is_err() && Law::relative_sd(-1.0, 0.1).is_err());
        // The sampled moments, within four standard errors of 100 000 draws.
        let mut rng = Rng::new(3);
        for law in [l, u] {
            let xs: Vec<f64> = (0..100_000).map(|_| law.at(rng.normal())).collect();
            let (m, s) = mean_sd(&xs);
            assert!((m - law.mean()).abs() < 4.0 * law.sd() / 100_000f64.sqrt());
            // sd of a sample sd is at most about sd·√((κ − 1)/4n); κ ≤ 3.3 here.
            assert!((s / law.sd() - 1.0).abs() < 4.0 * (2.3f64 / 400_000.0).sqrt());
        }
    }

    // ── M/M/1 with an uncertain arrival rate ────────────────────────────────────────────────

    const N: usize = 20_000;

    fn opts(seed: u64) -> Options {
        Options { samples: N, seed, sobol: false }
    }

    /// λ uniform on [a, b] ⊂ (0, μ), μ = 1: L = λ/(1 − λ) has
    ///   E[L] = (1/(b − a))·∫ λ/(1 − λ) dλ = (ln((1 − a)/(1 − b)) − (b − a))/(b − a),
    /// and, L being increasing in λ, its q-quantile is L at λ's q-quantile a + q(b − a).
    /// Tolerance: four of the reported standard errors (a 4σ event has probability 6·10⁻⁵).
    #[test]
    fn mm1_with_a_uniform_arrival_rate_matches_the_closed_form() {
        let base = mm1(0.6, 1.0);
        let (a, b): (f64, f64) = (0.6 * 0.75, 0.6 * 1.25);
        let inputs = [arrival(&base, Law::relative_range(0.6, 0.25).unwrap())];
        let r = propagate_jackson(&base, Measure::NetworkNumber, &inputs, &[vec![0]], &opts(1), &mut quiet());
        assert_eq!((r.samples, r.unstable), (N, 0));
        let s = r.summary.unwrap();
        let mean = (((1.0 - a) / (1.0 - b)).ln() - (b - a)) / (b - a);
        assert!((s.mean.value - mean).abs() < 4.0 * s.mean.se, "mean {} vs {mean} ± {}", s.mean.value, s.mean.se);
        // The standard error itself: sd/√n, with Var L = E[L²] − E[L]², E[L²] = ∫ (λ/(1−λ))² dλ/(b−a)
        // = [λ + 1/(1 − λ) + 2 ln(1 − λ)]ₐᵇ/(b − a).
        let second = ((b - a) + 1.0 / (1.0 - b) - 1.0 / (1.0 - a) + 2.0 * ((1.0 - b) / (1.0 - a)).ln()) / (b - a);
        let sd = (second - mean * mean).sqrt();
        assert!(close(s.sd, sd, 0.03), "sd {} vs {sd}", s.sd);
        assert!(close(s.mean.se, sd / (N as f64).sqrt(), 0.03));
        let l = |x: f64| x / (1.0 - x);
        for (got, q) in [(s.q025, 0.025), (s.median, 0.5), (s.q975, 0.975)] {
            let exact = l(a + q * (b - a));
            assert!((got.value - exact).abs() < 4.0 * got.se, "q{q}: {} vs {exact} ± {}", got.value, got.se);
        }
        // The mean delay W = 1/(μ − λ): E[W] = ln((1 − a)/(1 − b))/(b − a).
        let w = propagate_jackson(&base, Measure::NetworkSojourn, &inputs, &[vec![0]], &opts(1), &mut quiet()).summary.unwrap();
        assert!((w.mean.value - ((1.0 - a) / (1.0 - b)).ln() / (b - a)).abs() < 4.0 * w.mean.se);
    }

    /// λ lognormal with mean 0.5 and 10 % standard deviation, μ = 1. E[L] against Simpson's rule
    /// on ∫ L(λ(z)) φ(z) dz over z ∈ [−8, 6] (4000 panels). Overload starts at z ≈ 7.0 (ln 2/s +
    /// s/2), where L has its pole: the part left out carries probability Φ(−6) ≈ 10⁻⁹ with L < 10
    /// up to z = 6, and beyond the mean over stable cases diverges only logarithmically with
    /// weight φ(7) ≈ 10⁻¹¹ — invisible to quadrature and to 20 000 draws alike (see the module
    /// comment). Quantiles are exact by monotonicity: L at exp(m + z_q·s).
    #[test]
    fn mm1_with_a_lognormal_arrival_rate_matches_quadrature_and_exact_quantiles() {
        let base = mm1(0.5, 1.0);
        let law = Law::relative_sd(0.5, 0.1).unwrap();
        let Law::LogNormal { m, s } = law else { panic!() };
        let l = |x: f64| x / (1.0 - x);
        let r = propagate_jackson(&base, Measure::NetworkNumber, &[arrival(&base, law)], &[vec![0]], &opts(11), &mut quiet());
        assert_eq!(r.unstable, 0);
        let got = r.summary.unwrap();
        let mean = gauss_integral(-8.0, 6.0, 4000, |z| l((m + s * z).exp()));
        // Halving the panels moves the quadrature by less than 1e−10: it is converged.
        assert!((mean - gauss_integral(-8.0, 6.0, 2000, |z| l((m + s * z).exp()))).abs() < 1e-10);
        assert!((got.mean.value - mean).abs() < 4.0 * got.mean.se, "mean {} vs {mean} ± {}", got.mean.value, got.mean.se);
        // Jensen: the mean is above the nominal L(0.5) = 1, by about ½·L″·σ² = 0.02.
        assert!(mean > 1.0 && (mean - 1.0 - 0.5 * 2.0 / 0.125 * 0.0025).abs() < 0.005);
        for (stat, z) in [(got.q025, -Z975), (got.median, 0.0), (got.q975, Z975)] {
            let exact = l((m + s * z).exp());
            assert!((stat.value - exact).abs() < 4.0 * stat.se, "{} vs {exact} ± {}", stat.value, stat.se);
            assert!(stat.se > 0.0 && stat.se < 0.02);
        }
    }

    /// The identity behind the quantiles, to the last bit: with one uncertain input and a measure
    /// increasing in it, the q-quantile of the sampled measure is the measure at the q-quantile
    /// of the sampled input (the same order statistic), for L (increasing in λ) directly and for
    /// L against μ (decreasing: the q-quantile of L is L at the (1 − q) order statistic of μ).
    #[test]
    fn a_quantile_of_the_measure_is_the_measure_at_the_quantile_of_the_input() {
        let base = mm1(0.7, 1.0);
        let law = Law::relative_sd(0.7, 0.08).unwrap();
        let o = opts(5);
        let l = propagate_jackson(&base, Measure::NetworkNumber, &[arrival(&base, law)], &[vec![0]], &o, &mut quiet());
        assert_eq!(l.unstable, 0);
        let lambda = propagate(&[law], &[vec![0]], &mut |t| Some(t[0]), &o, &mut quiet()).summary.unwrap();
        let mut scratch = base.clone();
        let at = |x: f64, scratch: &mut JacksonModel| evaluate_at(&base, Measure::NetworkNumber, &[arrival(&base, law)], &[x], scratch).unwrap();
        let s = l.summary.unwrap();
        for (lq, xq) in [(s.q025, lambda.q025), (s.median, lambda.median), (s.q975, lambda.q975)] {
            assert_eq!(lq.value, at(xq.value, &mut scratch));
        }
        assert_eq!((s.min, s.max), (at(lambda.min, &mut scratch), at(lambda.max, &mut scratch)));

        // Decreasing in μ: sort the sampled μ and read the mirrored order statistic.
        let mu_law = Law::relative_sd(1.0, 0.05).unwrap();
        let input = [service(&base, mu_law)];
        let r = propagate_jackson(&base, Measure::NetworkNumber, &input, &[vec![0]], &o, &mut quiet()).summary.unwrap();
        let mut mus = Vec::new();
        propagate(&[mu_law], &[vec![0]], &mut |t| { mus.push(t[0]); Some(t[0]) }, &o, &mut quiet());
        mus.sort_by(|a, b| b.total_cmp(a));
        let mut scratch = base.clone();
        for (stat, q) in [(r.q025, 0.025), (r.median, 0.5), (r.q975, 0.975)] {
            let k = (N as f64 * q).ceil() as usize;
            assert_eq!(stat.value, evaluate_at(&base, Measure::NetworkNumber, &input, &[mus[k - 1]], &mut scratch).unwrap());
        }
    }

    /// The chance of overload in closed form: P(λ ≥ μ) = 1 − Φ((ln μ − m)/s) for a lognormal λ and
    /// (b − μ)/(b − a) for a uniform one; within four binomial standard errors, and the reported
    /// standard error is √(p(1 − p)/n). Quantiles are then over the stable draws: the q-quantile
    /// of L given stability is L at λ's q·P(stable) quantile.
    #[test]
    fn the_chance_of_overload_matches_the_input_law() {
        let base = mm1(0.9, 1.0);
        let law = Law::relative_sd(0.9, 0.1).unwrap();
        let r = propagate_jackson(&base, Measure::NetworkNumber, &[arrival(&base, law)], &[vec![0]], &opts(2), &mut quiet());
        let p = 1.0 - law.cdf(1.0);
        assert!(p > 0.13 && p < 0.16, "{p}");
        let se = (p * (1.0 - p) / N as f64).sqrt();
        assert!((r.p_unstable.value - p).abs() < 4.0 * se, "{} vs {p}", r.p_unstable.value);
        assert!(close(r.p_unstable.se, se, 0.05));
        assert_eq!(r.p_unstable.value, r.unstable as f64 / N as f64);
        let Law::LogNormal { m, s } = law else { panic!() };
        // Median given stability: λ at probability ½(1 − p). Φ⁻¹ by bisection on Φ.
        let inv = |q: f64| {
            let (mut a, mut b) = (-9.0, 9.0);
            for _ in 0..200 {
                let mid = 0.5 * (a + b);
                if normal_cdf(mid) < q { a = mid } else { b = mid }
            }
            0.5 * (a + b)
        };
        let lam = (m + s * inv(0.5 * (1.0 - p))).exp();
        let median = r.summary.as_ref().unwrap().median;
        assert!((median.value - lam / (1.0 - lam)).abs() < 4.0 * median.se, "{} vs {}", median.value, lam / (1.0 - lam));

        let range = Law::relative_range(0.9, 0.2).unwrap();
        let r = propagate_jackson(&base, Measure::NetworkNumber, &[arrival(&base, range)], &[vec![0]], &opts(2), &mut quiet());
        let p = (1.08 - 1.0) / (1.08 - 0.72);
        assert!(close(1.0 - range.cdf(1.0), p, 1e-12));
        assert!((r.p_unstable.value - p).abs() < 4.0 * (p * (1.0 - p) / N as f64).sqrt());
        // An uncertain service rate overloads when μ ≤ λ: P = F_μ(λ).
        let mu = Law::relative_sd(1.0, 0.1).unwrap();
        let r = propagate_jackson(&base, Measure::NetworkNumber, &[service(&base, mu)], &[vec![0]], &opts(2), &mut quiet());
        let p = mu.cdf(0.9);
        assert!((r.p_unstable.value - p).abs() < 4.0 * (p * (1.0 - p) / N as f64).sqrt());
    }

    #[test]
    fn the_same_seed_gives_the_same_answer_and_another_seed_another() {
        let base = mm1(0.8, 1.0);
        let inputs = [arrival(&base, Law::relative_sd(0.8, 0.1).unwrap()), service(&base, Law::relative_sd(1.0, 0.05).unwrap())];
        let o = Options { samples: 4000, seed: 2026, sobol: true };
        let run = |o: &Options| propagate_jackson(&base, Measure::NetworkSojourn, &inputs, &[vec![0], vec![1]], o, &mut quiet());
        let (a, b) = (run(&o), run(&o));
        assert_eq!(a, b);
        assert!(a.sobol.is_some());
        let c = run(&Options { seed: 2027, ..o });
        assert_ne!(a.summary.unwrap().mean.value, c.summary.unwrap().mean.value);
        // The distribution does not depend on whether the shares were asked for.
        assert_eq!(run(&Options { sobol: false, ..o }).summary, b.summary);
    }

    /// The standard errors are calibrated: over 300 seeds the truth lies within 1.96 standard
    /// errors about 95 % of the time. With 300 repeats the coverage's own standard deviation is
    /// 1.26 %, so [90.5 %, 99 %] is ±3.5 of them. Checked for the mean, the median, the 97.5 %
    /// quantile and the chance of overload.
    #[test]
    fn the_standard_errors_cover_the_truth_as_often_as_they_claim() {
        let base = mm1(0.6, 1.0);
        let (a, b): (f64, f64) = (0.45, 0.75);
        let inputs = [arrival(&base, Law::relative_range(0.6, 0.25).unwrap())];
        let l = |x: f64| x / (1.0 - x);
        let mean = (((1.0 - a) / (1.0 - b)).ln() - (b - a)) / (b - a);
        let over = mm1(0.9, 1.0);
        let over_law = Law::relative_sd(0.9, 0.1).unwrap();
        let p = 1.0 - over_law.cdf(1.0);
        let mut hits = [0usize; 4];
        let reps = 300;
        for seed in 0..reps {
            let o = Options { samples: 2000, seed: 1000 + seed as u64, sobol: false };
            let s = propagate_jackson(&base, Measure::NetworkNumber, &inputs, &[vec![0]], &o, &mut quiet()).summary.unwrap();
            let inside = |stat: Stat, truth: f64| ((stat.value - truth).abs() <= Z975 * stat.se) as usize;
            hits[0] += inside(s.mean, mean);
            hits[1] += inside(s.median, l(a + 0.5 * (b - a)));
            hits[2] += inside(s.q975, l(a + 0.975 * (b - a)));
            let r = propagate_jackson(&over, Measure::NetworkNumber, &[arrival(&over, over_law)], &[vec![0]], &o, &mut quiet());
            hits[3] += inside(r.p_unstable, p);
        }
        for (what, h) in ["mean", "median", "97.5 % quantile", "chance of overload"].iter().zip(hits) {
            let cover = h as f64 / reps as f64;
            assert!((0.905..=0.99).contains(&cover), "{what}: coverage {cover}");
        }
    }

    // ── The delta method ────────────────────────────────────────────────────────────────────

    /// M/M/1: dL/dλ = 1/(μ(1 − ρ)²), dL/dμ = −ρ/(μ(1 − ρ)²), so
    /// Var L ≈ (σ_λ² + ρ²σ_μ²)/(μ²(1 − ρ)⁴), with shares σ_λ² : ρ²σ_μ².
    #[test]
    fn the_delta_method_variance_is_its_formula() {
        let (lambda, mu) = (0.8, 1.25);
        let base = mm1(lambda, mu);
        let sol = jackson::solve(&base).unwrap();
        let inputs = [arrival(&base, Law::relative_sd(lambda, 0.1).unwrap()), service(&base, Law::relative_range(mu, 0.06).unwrap())];
        let d = jackson_derivatives(&base, &sol, Measure::NetworkNumber, &inputs);
        let rho: f64 = lambda / mu;
        assert!(close(d[0], 1.0 / (mu * (1.0 - rho).powi(2)), 1e-12) && close(d[1], -rho / (mu * (1.0 - rho).powi(2)), 1e-12));
        let sds: Vec<f64> = inputs.iter().map(|i| i.law.sd()).collect();
        let (sl, sm) = (0.1 * lambda, 0.06 * mu / 3f64.sqrt());
        assert!(close(sds[0], sl, 1e-12) && close(sds[1], sm, 1e-12));
        let got = delta(&d, &sds, &[vec![0], vec![1]]);
        let var = (sl * sl + rho * rho * sm * sm) / (mu * mu * (1.0 - rho).powi(4));
        assert!(close(got.variance, var, 1e-12) && close(got.sd, var.sqrt(), 1e-12));
        assert!(close(got.shares[0], sl * sl / (sl * sl + rho * rho * sm * sm), 1e-12));
        assert!(close(got.shares.iter().sum::<f64>(), 1.0, 1e-14));
        // Moving together: (d₁σ₁ + d₂σ₂)², one factor.
        let together = delta(&d, &sds, &[vec![0, 1]]);
        assert!(close(together.variance, (d[0] * sl + d[1] * sm).powi(2), 1e-12));
        assert_eq!(together.shares, vec![1.0]);
        // Nothing uncertain moves the measure: no variance, no shares.
        assert_eq!(delta(&[0.0], &[0.3], &[vec![0]]), Delta { variance: 0.0, sd: 0.0, shares: vec![0.0] });
    }

    /// The two routes agree where the measure is nearly linear over the inputs' spread (ρ = 0.3,
    /// 2 % uncertainty: second-order terms are about (cρ/(1 − ρ))² ≈ 10⁻⁴ of the variance, so the
    /// standard deviations agree to the sampling error of an sd, 1/√(2n) = 0.5 %, taken as 2 %)
    /// and part company near saturation (ρ = 0.9, 5 %): the contrast the view teaches.
    #[test]
    fn the_linear_approximation_holds_at_light_load_and_fails_near_saturation() {
        let run = |lambda: f64, cv: f64| {
            let base = mm1(lambda, 1.0);
            let sol = jackson::solve(&base).unwrap();
            let inputs = [arrival(&base, Law::relative_sd(lambda, cv).unwrap()), service(&base, Law::relative_sd(1.0, cv).unwrap())];
            let d = delta(&jackson_derivatives(&base, &sol, Measure::NetworkNumber, &inputs), &[cv * lambda, cv], &[vec![0], vec![1]]);
            let r = propagate_jackson(&base, Measure::NetworkNumber, &inputs, &[vec![0], vec![1]], &opts(4), &mut quiet());
            (sol.network_number(), d, r)
        };
        let (value, d, r) = run(0.3, 0.02);
        let s = r.summary.unwrap();
        assert_eq!(r.unstable, 0);
        assert!(close(d.sd, s.sd, 0.02), "delta sd {} vs sampled {}", d.sd, s.sd);
        assert!(linear_disagreement(value, d.sd, &s) < DISAGREE);
        assert!((s.mean.value - value).abs() < 4.0 * s.mean.se + 1e-4);

        let (value, d, r) = run(0.9, 0.05);
        let s = r.summary.unwrap();
        assert!(r.unstable > 0);
        assert!(linear_disagreement(value, d.sd, &s) > 2.0 * DISAGREE, "{}", linear_disagreement(value, d.sd, &s));
        // The linear interval even goes below zero customers; the sampled one cannot.
        assert!(value - Z975 * d.sd < 0.0 && s.q025.value > 0.0 && s.q975.value > value + Z975 * d.sd);
    }

    // ── Variance shares ─────────────────────────────────────────────────────────────────────

    fn sobol_of(laws: &[Law], f: &mut dyn FnMut(&[f64]) -> Option<f64>, n: usize, seed: u64) -> Sobol {
        let factors: Vec<Vec<usize>> = (0..laws.len()).map(|i| vec![i]).collect();
        propagate(laws, &factors, f, &Options { samples: n, seed, sobol: true }, &mut quiet()).sobol.unwrap()
    }

    /// An additive function Y = Σ aᵢXᵢ of independent inputs has Sᵢ = Sₜᵢ = aᵢ²Var Xᵢ/Σ aⱼ²Var Xⱼ
    /// (no interactions). Lognormal and uniform inputs mixed. Within four reported standard errors.
    #[test]
    fn sobol_indices_of_an_additive_function_are_its_variance_parts() {
        let laws = [Law::relative_sd(2.0, 0.2).unwrap(), Law::relative_range(1.0, 0.5).unwrap(), Law::relative_sd(5.0, 0.05).unwrap()];
        let a = [1.0, -3.0, 0.5];
        let parts: Vec<f64> = laws.iter().zip(a).map(|(l, a)| (a * l.sd()).powi(2)).collect();
        let total: f64 = parts.iter().sum();
        let s = sobol_of(&laws, &mut |x| Some(a[0] * x[0] + a[1] * x[1] + a[2] * x[2]), N, 9);
        assert_eq!((s.rows, s.evaluations), (N, 4 * N));
        for (i, index) in s.indices.iter().enumerate() {
            let exact = parts[i] / total;
            assert!((index.first.value - exact).abs() < 4.0 * index.first.se, "S{i}: {} vs {exact} ± {}", index.first.value, index.first.se);
            assert!((index.total.value - exact).abs() < 4.0 * index.total.se, "ST{i}: {} vs {exact} ± {}", index.total.value, index.total.se);
            assert!(index.first.se > 0.0 && index.first.se < 0.02 && index.total.se < 0.02);
        }
        // For a linear function the delta method's shares are the same numbers, exactly.
        let d = delta(&a, &laws.iter().map(|l| l.sd()).collect::<Vec<_>>(), &[vec![0], vec![1], vec![2]]);
        for i in 0..3 {
            assert!(close(d.shares[i], parts[i] / total, 1e-12));
        }
    }

    /// A product Y = X₁X₂ of independent inputs with means mᵢ and variances vᵢ:
    /// Var Y = m₂²v₁ + m₁²v₂ + v₁v₂, S₁ = m₂²v₁/Var Y, and the interaction v₁v₂ belongs to both
    /// totals: Sₜ₁ = (m₂²v₁ + v₁v₂)/Var Y (Sobol' 1993). The first-order shares sum to less than 1.
    #[test]
    fn sobol_indices_of_a_product_separate_the_interaction() {
        let laws = [Law::relative_sd(1.0, 0.6).unwrap(), Law::relative_range(2.0, 0.9).unwrap()];
        let (m1, m2) = (laws[0].mean(), laws[1].mean());
        let (v1, v2) = (laws[0].sd().powi(2), laws[1].sd().powi(2));
        let var = m2 * m2 * v1 + m1 * m1 * v2 + v1 * v2;
        let exact = [(m2 * m2 * v1 / var, (m2 * m2 * v1 + v1 * v2) / var), (m1 * m1 * v2 / var, (m1 * m1 * v2 + v1 * v2) / var)];
        assert!(exact[0].0 + exact[1].0 < 0.95);
        let s = sobol_of(&laws, &mut |x| Some(x[0] * x[1]), 40_000, 21);
        for (i, index) in s.indices.iter().enumerate() {
            assert!((index.first.value - exact[i].0).abs() < 4.0 * index.first.se, "S{i}: {} vs {} ± {}", index.first.value, exact[i].0, index.first.se);
            assert!((index.total.value - exact[i].1).abs() < 4.0 * index.total.se, "ST{i}: {} vs {} ± {}", index.total.value, exact[i].1, index.total.se);
        }
    }

    /// The Ishigami function Y = sin X₁ + a·sin²X₂ + b·X₃⁴·sin X₁, Xᵢ uniform on (−π, π), a = 7,
    /// b = 0.1 (Ishigami & Homma 1990). Analytic values (Saltelli et al. 2008, §4.3; Sobol' &
    /// Levitan 1999): V = a²/8 + bπ⁴/5 + b²π⁸/18 + ½; V₁ = ½(1 + bπ⁴/5)², V₂ = a²/8, V₃ = 0,
    /// V₁₃ = 8b²π⁸/225: S = (0.3139, 0.4424, 0), Sₜ = (0.5576, 0.4424, 0.2437).
    #[test]
    fn sobol_indices_of_the_ishigami_function_match_the_published_values() {
        let (a, b) = (7.0, 0.1);
        let laws = [Law::Uniform { lo: -PI, hi: PI }; 3];
        let v = a * a / 8.0 + b * PI.powi(4) / 5.0 + b * b * PI.powi(8) / 18.0 + 0.5;
        let v1 = 0.5 * (1.0 + b * PI.powi(4) / 5.0).powi(2);
        let v13 = 8.0 * b * b * PI.powi(8) / 225.0;
        let first = [v1 / v, a * a / 8.0 / v, 0.0];
        let total = [(v1 + v13) / v, a * a / 8.0 / v, v13 / v];
        for (got, published) in first.iter().chain(&total).zip([0.3139, 0.4424, 0.0, 0.5576, 0.4424, 0.2437]) {
            assert!((got - published).abs() < 5e-5);
        }
        let mut f = |x: &[f64]| Some(x[0].sin() + a * x[1].sin().powi(2) + b * x[2].powi(4) * x[0].sin());
        let s = sobol_of(&laws, &mut f, 40_000, 33);
        for i in 0..3 {
            let (f1, t) = (s.indices[i].first, s.indices[i].total);
            assert!((f1.value - first[i]).abs() < 4.0 * f1.se, "S{i}: {} vs {} ± {}", f1.value, first[i], f1.se);
            assert!((t.value - total[i]).abs() < 4.0 * t.se, "ST{i}: {} vs {} ± {}", t.value, total[i], t.se);
            assert!(f1.se < 0.02 && t.se < 0.02);
        }
        // The sampled variance is V too (the uniform is drawn through Φ of a normal).
        let all = propagate(&laws, &[vec![0], vec![1], vec![2]], &mut f, &Options { samples: 40_000, seed: 33, sobol: false }, &mut quiet()).summary.unwrap();
        assert!(close(all.sd * all.sd, v, 0.03) && (all.mean.value - a / 2.0).abs() < 4.0 * all.mean.se);
    }

    /// The standard error of a share is calibrated: over 200 seeds the exact first-order and total
    /// indices of the product function lie within 1.96 standard errors about 95 % of the time
    /// (coverage sd 1.5 %; [89 %, 99.5 %] is ±4 of them).
    #[test]
    fn the_standard_error_of_a_share_covers_the_truth() {
        let laws = [Law::relative_sd(1.0, 0.3).unwrap(), Law::relative_range(2.0, 0.5).unwrap()];
        let (m1, m2) = (laws[0].mean(), laws[1].mean());
        let (v1, v2) = (laws[0].sd().powi(2), laws[1].sd().powi(2));
        let var = m2 * m2 * v1 + m1 * m1 * v2 + v1 * v2;
        let (first, total) = (m2 * m2 * v1 / var, (m2 * m2 * v1 + v1 * v2) / var);
        let (mut hit_first, mut hit_total) = (0, 0);
        let reps = 200;
        for seed in 0..reps {
            let s = sobol_of(&laws, &mut |x| Some(x[0] * x[1]), 2000, 500 + seed as u64);
            let i = s.indices[0];
            hit_first += ((i.first.value - first).abs() <= Z975 * i.first.se) as usize;
            hit_total += ((i.total.value - total).abs() <= Z975 * i.total.se) as usize;
        }
        for (what, h) in [("first", hit_first), ("total", hit_total)] {
            let cover = h as f64 / reps as f64;
            assert!((0.89..=0.995).contains(&cover), "{what}: coverage {cover}");
        }
    }

    /// The rows of the design shrink as the inputs grow, to keep within the budget.
    #[test]
    fn the_pick_freeze_design_keeps_within_its_budget() {
        assert_eq!(sobol_rows(20_000, 2), 20_000);
        assert_eq!(sobol_rows(20_000, 19), 20_000);
        assert_eq!(sobol_rows(20_000, 39), 10_000);
        assert_eq!(sobol_rows(20_000, 5000), SOBOL_MIN_ROWS);
        assert_eq!(sobol_rows(300, 2), 300);
        let mut calls = Vec::new();
        let laws = [Law::relative_sd(1.0, 0.1).unwrap(); 3];
        let mut count = 0usize;
        let r = propagate(&laws, &[vec![0], vec![1], vec![2]], &mut |x| { count += 1; Some(x.iter().sum()) }, &Options { samples: 3000, seed: 1, sobol: true }, &mut |d, t| calls.push((d, t)));
        // n + rows·(k + 1) evaluations, reported as they go and at the end.
        assert_eq!(count, 3000 + 3000 * 4);
        assert_eq!(r.sobol.unwrap().evaluations, 12_000);
        assert_eq!(calls.last(), Some(&(15_000, 15_000)));
        assert!(calls.len() >= 7 && calls.windows(2).all(|w| w[0].0 <= w[1].0));
    }

    // ── Networks, and inputs that move together ─────────────────────────────────────────────

    /// Two sources into one exponential server, their rates uncertain by the same 15 % and moving
    /// together: the total is (λ₁ + λ₂)·e^{sZ − s²/2}, one lognormal with 15 % standard deviation,
    /// so everything is a one-dimensional integral. Against it: the chance of overload (closed
    /// form), the median (exact by monotonicity), the mean (Simpson on z ∈ [−8, z*], z* just
    /// short of the pole; here overload is likely, so the draws within 10⁻³ of it are compared
    /// through the median and quantiles, and the mean through a truncated measure, ρ itself).
    /// Independent, the same inputs give a narrower total: sd √(σ₁² + σ₂²) instead of σ₁ + σ₂.
    #[test]
    fn rates_that_move_together_are_one_lognormal_total() {
        let (l1, l2, mu) = (0.5, 0.3, 1.0);
        let base = mm1(l1 + l2, mu);
        let cv = 0.15;
        let inputs = [
            Input { family: Family::arrival(vec![1.0], l1), law: Law::relative_sd(l1, cv).unwrap() },
            Input { family: Family::arrival(vec![1.0], l2), law: Law::relative_sd(l2, cv).unwrap() },
        ];
        let total = Law::relative_sd(l1 + l2, cv).unwrap();
        let Law::LogNormal { m, s } = total else { panic!() };
        let together = [vec![0, 1]];
        let r = propagate_jackson(&base, Measure::NetworkNumber, &inputs, &together, &opts(8), &mut quiet());
        let p = 1.0 - total.cdf(mu);
        assert!((r.p_unstable.value - p).abs() < 4.0 * (p * (1.0 - p) / N as f64).sqrt(), "{} vs {p}", r.p_unstable.value);
        // Utilisation ρ = λ/μ is linear, so its mean over the stable cases is a finite integral:
        // E[ρ; ρ < 1]/P(ρ < 1), by Simpson up to the boundary z* = (ln μ − m)/s.
        let z_star = (mu.ln() - m) / s;
        let rho = propagate_jackson(&base, Measure::StationUtilisation(0), &inputs, &together, &opts(8), &mut quiet()).summary.unwrap();
        let mean = gauss_integral(-8.0, z_star, 4000, |z| (m + s * z).exp() / mu) / (1.0 - p);
        assert!((rho.mean.value - mean).abs() < 4.0 * rho.mean.se, "{} vs {mean} ± {}", rho.mean.value, rho.mean.se);
        // One factor: its share is all of it.
        let one = propagate_jackson(&base, Measure::StationUtilisation(0), &inputs, &together, &Options { sobol: true, ..opts(8) }, &mut quiet()).sobol.unwrap();
        assert_eq!(one.indices, vec![Index { first: Stat { value: 1.0, se: 0.0 }, total: Stat { value: 1.0, se: 0.0 } }]);

        // Independent: Var(λ₁ + λ₂) = σ₁² + σ₂² < (σ₁ + σ₂)², and the delta method says so too.
        // With a server fast enough that no draw overloads (μ = 5), so the whole law is seen.
        let fast = mm1(l1 + l2, 5.0);
        let apart = [vec![0], vec![1]];
        let throughput = |factors: &[Vec<usize>]| {
            let r = propagate_jackson(&fast, Measure::StationThroughput(0), &inputs, factors, &opts(8), &mut quiet());
            assert_eq!(r.unstable, 0);
            r.summary.unwrap()
        };
        let (dep, ind) = (throughput(&together), throughput(&apart));
        // The sd of a sample sd of 20 000 draws is under 1 %: 3 %.
        assert!(close(dep.sd, cv * (l1 + l2), 0.03) && close(ind.sd, cv * (l1 * l1 + l2 * l2).sqrt(), 0.03), "{} {}", dep.sd, ind.sd);
        let sol = jackson::solve(&fast).unwrap();
        let d = jackson_derivatives(&fast, &sol, Measure::StationThroughput(0), &inputs);
        let sds = [cv * l1, cv * l2];
        assert!(close(delta(&d, &sds, &together).sd, cv * (l1 + l2), 1e-12) && close(delta(&d, &sds, &apart).sd, cv * (l1 * l1 + l2 * l2).sqrt(), 1e-12));
    }

    /// A network, not one queue: a tandem with feedback (S1 → S2; from S2 back to S1 with
    /// probability ½), γ = 0.3 into S1, so α₁ = α₂ = 2γ; μ₁ = 1, μ₂ = 0.8 with two servers at S1.
    /// Each draw is the model `sensitivity::Family::at` builds, solved by `jackson::solve` (the
    /// arithmetic the Sensitivity view uses), and overload is exactly "2γ ≥ μ₂ or 2γ ≥ 2μ₁".
    #[test]
    fn a_draw_of_a_network_is_the_exact_solution_of_the_moved_network() {
        let base = JacksonModel {
            ids: vec!["S1".into(), "S2".into()],
            names: vec!["S1".into(), "S2".into()],
            gamma: vec![0.3, 0.0],
            p: vec![vec![0.0, 1.0], vec![0.5, 0.0]],
            mu: vec![1.0, 0.8],
            servers: vec![2, 1],
        };
        let gamma = Input { family: Family::arrival(vec![1.0, 0.0], 0.3), law: Law::relative_sd(0.3, 0.2).unwrap() };
        let mu2 = Input { family: Family::service(&base, 1), law: Law::relative_range(0.8, 0.3).unwrap() };
        let inputs = [gamma.clone(), mu2.clone()];
        let mut scratch = base.clone();
        for theta in [[0.3, 0.8], [0.35, 0.74], [0.21, 1.0], [0.39, 0.79]] {
            let moved = mu2.family.at(&gamma.family.at(&base, theta[0]), theta[1]);
            for measure in [Measure::NetworkNumber, Measure::NetworkSojourn, Measure::StationQueue(0), Measure::StationSojourn(1), Measure::StationUtilisation(1)] {
                let expected = jackson::solve(&moved).ok().map(|s| measure.value(&s));
                assert_eq!(evaluate_at(&base, measure, &inputs, &theta, &mut scratch), expected);
            }
        }
        assert_eq!(evaluate_at(&base, Measure::NetworkNumber, &inputs, &[0.41, 0.8], &mut scratch), None);
        assert_eq!(scratch.p, base.p);

        // Overload ⇔ 2γ ≥ μ₂ (S1 has room: 2γ < 2 always here). Counted on the same draws.
        let o = Options { samples: N, seed: 14, sobol: true };
        let r = propagate_jackson(&base, Measure::NetworkSojourn, &inputs, &[vec![0], vec![1]], &o, &mut quiet());
        let mut over = 0;
        let mut n = 0;
        propagate(&[gamma.law, mu2.law], &[vec![0], vec![1]], &mut |t| { n += 1; over += (2.0 * t[0] >= t[1]) as usize; Some(0.0) }, &Options { sobol: false, ..o }, &mut quiet());
        assert_eq!((n, r.unstable), (N, over));
        assert!(over > 0);
        // The shares, where no draw overloads (5 % uncertainties: overload is 4.7 standard
        // deviations away). S2's utilisation 2γ/μ₂ is nearly linear over so small a spread, so the
        // sampled shares are the delta method's, σ_γ²/γ² : σ_μ²/μ² = 0.0025 : 0.0025/3 = ¾ : ¼, to
        // second order (about 1 %) and four standard errors.
        let small = [Input { law: Law::relative_sd(0.3, 0.05).unwrap(), ..gamma.clone() }, Input { law: Law::relative_range(0.8, 0.05).unwrap(), ..mu2.clone() }];
        let r = propagate_jackson(&base, Measure::StationUtilisation(1), &small, &[vec![0], vec![1]], &o, &mut quiet());
        assert_eq!(r.unstable, 0);
        let sol = jackson::solve(&base).unwrap();
        let d = delta(&jackson_derivatives(&base, &sol, Measure::StationUtilisation(1), &small), &[small[0].law.sd(), small[1].law.sd()], &[vec![0], vec![1]]);
        assert!(close(d.shares[0], 0.75, 1e-9) && close(d.shares[1], 0.25, 1e-9));
        assert!(close(d.sd, r.summary.as_ref().unwrap().sd, 0.03));
        for (i, index) in r.sobol.unwrap().indices.iter().enumerate() {
            assert!((index.first.value - d.shares[i]).abs() < 0.01 + 4.0 * index.first.se, "{index:?}");
            assert!((index.total.value - d.shares[i]).abs() < 0.01 + 4.0 * index.total.se, "{index:?}");
            assert!(index.first.se < 0.01);
        }
    }

    /// The histogram counts every stable draw once: its bins up to the 99.5 % point, the rest above.
    #[test]
    fn the_histogram_accounts_for_every_stable_draw() {
        let base = mm1(0.85, 1.0);
        let r = propagate_jackson(&base, Measure::NetworkNumber, &[arrival(&base, Law::relative_sd(0.85, 0.1).unwrap())], &[vec![0]], &opts(6), &mut quiet());
        let s = r.summary.unwrap();
        let h = &s.histogram;
        assert_eq!(h.counts.len(), BINS);
        assert_eq!(h.counts.iter().sum::<usize>() + h.above, N - r.unstable);
        // Here overload is near and the tail long: the bins stop at median + 8·(median − q₀.₀₂₅).
        assert!(close(h.hi, s.median.value + TAIL_REACH * (s.median.value - s.q025.value), 1e-12));
        assert!(h.lo == s.min && h.hi < s.max && h.above > (N - r.unstable) / 200);
        // A tame case: the bins run to the 99.5 % point and hold the whole 95 % interval.
        let tame = mm1(0.5, 1.0);
        let t = propagate_jackson(&tame, Measure::NetworkNumber, &[arrival(&tame, Law::relative_sd(0.5, 0.05).unwrap())], &[vec![0]], &opts(6), &mut quiet()).summary.unwrap();
        let h = &t.histogram;
        assert_eq!(h.counts.iter().sum::<usize>() + h.above, N);
        assert!(h.above > 0 && h.above <= N / 200 + 1 && h.lo < t.q025.value && t.q975.value < h.hi && h.hi < t.max);
        // A measure nothing moves: one bin, no spread, no shares.
        let fixed = propagate(&[Law::relative_sd(1.0, 0.1).unwrap()], &[vec![0]], &mut |_| Some(2.5), &Options { samples: 100, seed: 1, sobol: true }, &mut quiet());
        let s = fixed.summary.unwrap();
        assert_eq!((s.histogram.counts.clone(), s.sd, s.median.value), (vec![100], 0.0, 2.5));
        assert!(fixed.sobol.is_none());
        // Nothing stable at all: no summary.
        let none = propagate(&[Law::relative_sd(1.0, 0.1).unwrap()], &[vec![0]], &mut |_| None, &Options { samples: 50, seed: 1, sobol: true }, &mut quiet());
        assert_eq!((none.unstable, none.p_unstable.value, none.summary, none.sobol), (50, 1.0, None, None));
    }
}
