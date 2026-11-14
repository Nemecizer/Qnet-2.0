//! Fit a distribution from data (new in 2.1, ROADMAP D2): the bridge from a measured system to a
//! model. Given observed service or inter-arrival times, this describes the sample (size, mean,
//! variance, SCV, quartiles, 95 % intervals for the mean and the SCV), fits every family the model
//! can hold (`qnet_core::model::Distribution`; there is no hyperexponential in the model, so none
//! is fitted) twice over — by maximum likelihood, and by matching the mean and the SCV, which is
//! all that QNA, the diffusion methods and the bounds read from a law — and says how well each
//! fits: log-likelihood, AIC, and the Kolmogorov–Smirnov distance with its asymptotic p-value.
//!
//! Everything here is a pure function of the numbers; the command at the end only shapes the
//! answer. The moments of a fitted law and the parameters for a (mean, SCV) pair are core's
//! (`dist::mean`, `dist::scv`, `dist::parameters_from_moments`), not a second copy.
//!
//! Method, family by family (x̄ the sample mean, L the mean of ln x, n the sample size):
//! - Exponential (Poisson for a source): λ̂ = 1/x̄.
//! - Deterministic: only when every value is the same.
//! - Uniform: â = min, b̂ = max.
//! - Gamma: k̂ solves ln k − ψ(k) = ln x̄ − L (Newton, started from Minka's closed form), θ̂ = x̄/k̂.
//! - Erlang: for a whole k the rate is k/x̄ and the profile log-likelihood per observation is
//!   k ln(k/x̄) + (k−1)L − k − ln Γ(k), concave in k, so the best whole k is one of the two
//!   neighbours of the Gamma k̂ (never below 1). Refused when the sample SCV exceeds 1.
//! - Weibull: k̂ solves Σxᵏ ln x / Σxᵏ − 1/k = L (bisection; the left side is increasing),
//!   λ̂ = (Σxᵏ/n)^(1/k).
//! - Lognormal: μ̂ = L, σ̂² = the mean of (ln x − L)² (divisor n).
//! - Pareto: x̂ₘ = min, α̂ = n / Σ ln(x/x̂ₘ); refused when α̂ ≤ 2, which the model does not hold.
//!
//! The KS p-value is Kolmogorov's limiting distribution with Stephens' small-sample correction
//! (M. A. Stephens, "Use of the Kolmogorov–Smirnov, Cramér–von Mises and related statistics
//! without extensive tables", JRSS B 32 (1970) 115–122). It is the p-value for a law fixed in
//! advance; here the parameters were fitted to the same data, so it is optimistic (too large),
//! and the answer says so.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use qnet_core::dist;
use qnet_core::model::Distribution;

use crate::errors::QnError;

// ── Special functions ────────────────────────────────────────────────────────────────────────

/// ln Γ(x) for x > 0: Lanczos' approximation (g = 7, nine terms), good to about 1e-14 relative.
pub fn ln_gamma(x: f64) -> f64 {
    const C: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if !(x > 0.0) {
        return f64::NAN;
    }
    if x < 0.5 {
        // Reflection: Γ(x)Γ(1−x) = π / sin(πx).
        return (std::f64::consts::PI / (std::f64::consts::PI * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let z = x - 1.0;
    let mut a = C[0];
    for (i, c) in C.iter().enumerate().skip(1) {
        a += c / (z + i as f64);
    }
    let t = z + 7.5;
    0.5 * (2.0 * std::f64::consts::PI).ln() + (z + 0.5) * t.ln() - t + a.ln()
}

/// ψ(x) = d/dx ln Γ(x) for x > 0: the recurrence ψ(x) = ψ(x+1) − 1/x up to x ≥ 12, then the
/// asymptotic series.
pub fn digamma(mut x: f64) -> f64 {
    if !(x > 0.0) {
        return f64::NAN;
    }
    let mut r = 0.0;
    while x < 12.0 {
        r -= 1.0 / x;
        x += 1.0;
    }
    let f = 1.0 / (x * x);
    r + x.ln() - 0.5 / x - f * (1.0 / 12.0 - f * (1.0 / 120.0 - f * (1.0 / 252.0 - f * (1.0 / 240.0 - f * (1.0 / 132.0)))))
}

/// ψ′(x) for x > 0, by the same recurrence and series.
pub fn trigamma(mut x: f64) -> f64 {
    if !(x > 0.0) {
        return f64::NAN;
    }
    let mut r = 0.0;
    while x < 12.0 {
        r += 1.0 / (x * x);
        x += 1.0;
    }
    let f = 1.0 / (x * x);
    r + 1.0 / x + 0.5 * f + (1.0 / x) * f * (1.0 / 6.0 - f * (1.0 / 30.0 - f * (1.0 / 42.0 - f * (1.0 / 30.0 - f * (5.0 / 66.0)))))
}

/// The regularised lower incomplete gamma function P(a, x) = γ(a, x)/Γ(a): the series for
/// x < a + 1, Lentz's continued fraction for the complement otherwise.
pub fn gamma_p(a: f64, x: f64) -> f64 {
    if !(a > 0.0) || x.is_nan() {
        return f64::NAN;
    }
    if x <= 0.0 {
        return 0.0;
    }
    if x.is_infinite() {
        return 1.0;
    }
    let front = (a * x.ln() - x - ln_gamma(a)).exp();
    if x < a + 1.0 {
        let mut term = 1.0 / a;
        let mut sum = term;
        let mut ap = a;
        for _ in 0..10_000 {
            ap += 1.0;
            term *= x / ap;
            sum += term;
            if term.abs() < sum.abs() * 1e-16 {
                break;
            }
        }
        (sum * front).clamp(0.0, 1.0)
    } else {
        const TINY: f64 = 1e-300;
        let mut b = x + 1.0 - a;
        let mut c = 1.0 / TINY;
        let mut d = 1.0 / b;
        let mut h = d;
        for i in 1..10_000 {
            let an = -(i as f64) * (i as f64 - a);
            b += 2.0;
            d = an * d + b;
            if d.abs() < TINY {
                d = TINY;
            }
            c = b + an / c;
            if c.abs() < TINY {
                c = TINY;
            }
            d = 1.0 / d;
            let delta = d * c;
            h *= delta;
            if (delta - 1.0).abs() < 1e-16 {
                break;
            }
        }
        (1.0 - front * h).clamp(0.0, 1.0)
    }
}

/// The standard normal distribution function, through P(½, z²/2) = erf(|z|/√2).
pub fn normal_cdf(z: f64) -> f64 {
    let half = 0.5 * gamma_p(0.5, 0.5 * z * z);
    if z >= 0.0 {
        0.5 + half
    } else {
        0.5 - half
    }
}

// ── The laws ─────────────────────────────────────────────────────────────────────────────────

/// A fitted law, in the model's own parameters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Law {
    Exponential { rate: f64 },
    Gamma { shape: f64, scale: f64 },
    Uniform { min: f64, max: f64 },
    Constant { value: f64 },
    Weibull { shape: f64, scale: f64 },
    Lognormal { mu: f64, sigma: f64 },
    Pareto { shape: f64, scale: f64 },
}

impl Law {
    /// The law a family's parameter map describes (Erlang is a Gamma with a whole shape; Poisson
    /// arrivals have exponential gaps), or None when the parameters are missing or out of range.
    pub fn of(d: Distribution, p: &BTreeMap<String, f64>) -> Option<Law> {
        let g = |k: &str| p.get(k).copied().filter(|v| v.is_finite());
        let pos = |k: &str| g(k).filter(|v| *v > 0.0);
        Some(match d {
            Distribution::Exponential => Law::Exponential { rate: pos("rate")? },
            Distribution::Poisson => Law::Exponential { rate: pos("lambda")? },
            Distribution::Gamma => Law::Gamma { shape: pos("shape")?, scale: pos("scale")? },
            Distribution::Erlang => {
                let k = pos("k")?;
                Law::Gamma { shape: k, scale: 1.0 / pos("rate")? }
            }
            Distribution::Uniform => {
                let (a, b) = (g("min")?, g("max")?);
                if !(b > a) {
                    return None;
                }
                Law::Uniform { min: a, max: b }
            }
            Distribution::Constant => Law::Constant { value: pos("value")? },
            Distribution::Weibull => Law::Weibull { shape: pos("shape")?, scale: pos("scale")? },
            Distribution::Lognormal => Law::Lognormal { mu: g("mu")?, sigma: pos("sigma")? },
            Distribution::Pareto => Law::Pareto { shape: pos("shape")?, scale: pos("scale")? },
        })
    }

    /// ln f(x); −∞ outside the support. A deterministic law has no density (None).
    pub fn ln_pdf(&self, x: f64) -> Option<f64> {
        const NO: f64 = f64::NEG_INFINITY;
        Some(match *self {
            Law::Exponential { rate } => {
                if x < 0.0 {
                    NO
                } else {
                    rate.ln() - rate * x
                }
            }
            Law::Gamma { shape, scale } => {
                if x < 0.0 {
                    NO
                } else if x == 0.0 {
                    if shape == 1.0 {
                        -scale.ln()
                    } else if shape < 1.0 {
                        f64::INFINITY
                    } else {
                        NO
                    }
                } else {
                    (shape - 1.0) * x.ln() - x / scale - ln_gamma(shape) - shape * scale.ln()
                }
            }
            Law::Uniform { min, max } => {
                if x < min || x > max {
                    NO
                } else {
                    -(max - min).ln()
                }
            }
            Law::Constant { .. } => return None,
            Law::Weibull { shape, scale } => {
                if x < 0.0 {
                    NO
                } else if x == 0.0 {
                    if shape == 1.0 {
                        -scale.ln()
                    } else if shape < 1.0 {
                        f64::INFINITY
                    } else {
                        NO
                    }
                } else {
                    let z = x / scale;
                    shape.ln() - scale.ln() + (shape - 1.0) * z.ln() - z.powf(shape)
                }
            }
            Law::Lognormal { mu, sigma } => {
                if x <= 0.0 {
                    NO
                } else {
                    let z = (x.ln() - mu) / sigma;
                    -x.ln() - sigma.ln() - 0.5 * (2.0 * std::f64::consts::PI).ln() - 0.5 * z * z
                }
            }
            Law::Pareto { shape, scale } => {
                if x < scale {
                    NO
                } else {
                    shape.ln() + shape * scale.ln() - (shape + 1.0) * x.ln()
                }
            }
        })
    }

    /// F(x) = P(X ≤ x).
    pub fn cdf(&self, x: f64) -> f64 {
        match *self {
            Law::Exponential { rate } => {
                if x <= 0.0 {
                    0.0
                } else {
                    -(-rate * x).exp_m1()
                }
            }
            Law::Gamma { shape, scale } => gamma_p(shape, x / scale),
            Law::Uniform { min, max } => ((x - min) / (max - min)).clamp(0.0, 1.0),
            Law::Constant { value } => {
                if x >= value {
                    1.0
                } else {
                    0.0
                }
            }
            Law::Weibull { shape, scale } => {
                if x <= 0.0 {
                    0.0
                } else {
                    -(-(x / scale).powf(shape)).exp_m1()
                }
            }
            Law::Lognormal { mu, sigma } => {
                if x <= 0.0 {
                    0.0
                } else {
                    normal_cdf((x.ln() - mu) / sigma)
                }
            }
            Law::Pareto { shape, scale } => {
                if x <= scale {
                    0.0
                } else {
                    1.0 - (scale / x).powf(shape)
                }
            }
        }
    }

    /// Σ ln f(xᵢ), or None when it is not a finite number (a value outside the support, or a law
    /// with no density).
    pub fn log_likelihood(&self, data: &[f64]) -> Option<f64> {
        let mut sum = 0.0;
        for x in data {
            sum += self.ln_pdf(*x)?;
        }
        sum.is_finite().then_some(sum)
    }
}

// ── Kolmogorov–Smirnov ───────────────────────────────────────────────────────────────────────

/// D = supₓ |Fₙ(x) − F(x)| for a continuous F, from the sorted sample.
pub fn ks_statistic(sorted: &[f64], cdf: impl Fn(f64) -> f64) -> f64 {
    let n = sorted.len() as f64;
    let mut d: f64 = 0.0;
    for (i, x) in sorted.iter().enumerate() {
        let f = cdf(*x);
        d = d.max((i as f64 + 1.0) / n - f).max(f - i as f64 / n);
    }
    d
}

/// Kolmogorov's limiting survival function Q(λ) = 2 Σⱼ₌₁^∞ (−1)^(j−1) e^(−2j²λ²).
pub fn kolmogorov_q(lambda: f64) -> f64 {
    if !(lambda > 0.0) {
        return 1.0;
    }
    // Below 0.2 the alternating series converges slowly and Q is 1 to twelve digits.
    if lambda < 0.2 {
        return 1.0;
    }
    let mut sum = 0.0;
    let mut sign = 1.0;
    for j in 1..=200 {
        let term = (-2.0 * (j * j) as f64 * lambda * lambda).exp();
        sum += sign * term;
        if term < 1e-17 {
            break;
        }
        sign = -sign;
    }
    (2.0 * sum).clamp(0.0, 1.0)
}

/// The asymptotic p-value of D at sample size n, with Stephens' (1970) correction
/// λ = (√n + 0.12 + 0.11/√n)·D.
pub fn ks_p_value(d: f64, n: usize) -> f64 {
    let rn = (n as f64).sqrt();
    kolmogorov_q((rn + 0.12 + 0.11 / rn) * d)
}

// ── Describing the sample ────────────────────────────────────────────────────────────────────

/// The first two moments of a sample: the mean and the unbiased variance (divisor n − 1).
pub fn mean_variance(data: &[f64]) -> (f64, f64) {
    let n = data.len() as f64;
    let mean = data.iter().sum::<f64>() / n;
    let ss = data.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>();
    (mean, if data.len() > 1 { ss / (n - 1.0) } else { 0.0 })
}

/// The p-quantile of a sorted sample by linear interpolation between order statistics
/// (Hyndman & Fan's type 7, the default of R and NumPy).
pub fn quantile(sorted: &[f64], p: f64) -> f64 {
    let h = (sorted.len() - 1) as f64 * p;
    let lo = h.floor() as usize;
    let hi = (lo + 1).min(sorted.len() - 1);
    sorted[lo] + (h - lo as f64) * (sorted[hi] - sorted[lo])
}

/// SplitMix64 (Steele, Lea & Flood 2014): the fixed-seed generator behind the bootstrap, so the
/// same data always give the same interval.
pub struct SplitMix64(pub u64);

impl SplitMix64 {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform on (0, 1).
    pub fn uniform(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
}

pub const BOOTSTRAP_RESAMPLES: usize = 2000;
/// Above this many observations the intervals are the large-sample ones (the bootstrap would
/// agree with them to the digits shown, and cost seconds).
pub const BOOTSTRAP_MAX_N: usize = 5000;
const BOOTSTRAP_SEED: u64 = 0x51_4E_45_54; // "QNET"

/// 95 % percentile-bootstrap intervals for the mean and the SCV: `BOOTSTRAP_RESAMPLES` resamples
/// with replacement, the 2.5 % and 97.5 % quantiles of each statistic.
pub fn bootstrap_intervals(data: &[f64]) -> ([f64; 2], [f64; 2]) {
    let n = data.len();
    let mut rng = SplitMix64(BOOTSTRAP_SEED);
    let mut means = Vec::with_capacity(BOOTSTRAP_RESAMPLES);
    let mut scvs = Vec::with_capacity(BOOTSTRAP_RESAMPLES);
    for _ in 0..BOOTSTRAP_RESAMPLES {
        let (mut s, mut ss) = (0.0, 0.0);
        for _ in 0..n {
            let x = data[((rng.uniform() * n as f64) as usize).min(n - 1)];
            s += x;
            ss += x * x;
        }
        let m = s / n as f64;
        let var = ((ss - n as f64 * m * m) / (n as f64 - 1.0)).max(0.0);
        means.push(m);
        scvs.push(if m > 0.0 { var / (m * m) } else { 0.0 });
    }
    means.sort_by(f64::total_cmp);
    scvs.sort_by(f64::total_cmp);
    ([quantile(&means, 0.025), quantile(&means, 0.975)], [quantile(&scvs, 0.025), quantile(&scvs, 0.975)])
}

/// 95 % large-sample intervals: x̄ ± 1.96 s/√n, and for c² = s²/x̄² the delta method,
/// Var(c²) ≈ [4σ⁶/m⁶ − 4σ²μ₃/m⁵ + (μ₄ − σ⁴)/m⁴]/n with the sample's central moments
/// (4/n for an exponential law).
pub fn asymptotic_intervals(data: &[f64]) -> ([f64; 2], [f64; 2]) {
    let n = data.len() as f64;
    let (m, var) = mean_variance(data);
    let mu3 = data.iter().map(|x| (x - m).powi(3)).sum::<f64>() / n;
    let mu4 = data.iter().map(|x| (x - m).powi(4)).sum::<f64>() / n;
    let scv = var / (m * m);
    let v_scv = (4.0 * var.powi(3) / m.powi(6) - 4.0 * var * mu3 / m.powi(5) + (mu4 - var * var) / m.powi(4)) / n;
    const Z: f64 = 1.959_963_984_540_054;
    let hm = Z * (var / n).sqrt();
    let hs = Z * v_scv.max(0.0).sqrt();
    ([m - hm, m + hm], [(scv - hs).max(0.0), scv + hs])
}

// ── The maximum-likelihood fits ──────────────────────────────────────────────────────────────

type Params = BTreeMap<String, f64>;

fn params(pairs: &[(&str, f64)]) -> Params {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

/// λ̂ = 1/x̄.
pub fn mle_exponential(data: &[f64]) -> Option<f64> {
    let m = data.iter().sum::<f64>() / data.len() as f64;
    (m > 0.0 && m.is_finite()).then(|| 1.0 / m)
}

/// (â, b̂) = (min, max).
pub fn mle_uniform(data: &[f64]) -> Option<(f64, f64)> {
    let lo = data.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = data.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (hi > lo).then_some((lo, hi))
}

/// (μ̂, σ̂) of ln x, σ̂² with divisor n.
pub fn mle_lognormal(data: &[f64]) -> Option<(f64, f64)> {
    if data.iter().any(|x| !(*x > 0.0)) {
        return None;
    }
    let n = data.len() as f64;
    let mu = data.iter().map(|x| x.ln()).sum::<f64>() / n;
    let s2 = data.iter().map(|x| (x.ln() - mu).powi(2)).sum::<f64>() / n;
    (s2 > 0.0).then(|| (mu, s2.sqrt()))
}

/// (α̂, x̂ₘ) = (n / Σ ln(x/min), min).
pub fn mle_pareto(data: &[f64]) -> Option<(f64, f64)> {
    let xm = data.iter().copied().fold(f64::INFINITY, f64::min);
    if !(xm > 0.0) {
        return None;
    }
    let s = data.iter().map(|x| (x / xm).ln()).sum::<f64>();
    (s > 0.0).then(|| (data.len() as f64 / s, xm))
}

/// ln x̄ − (mean of ln x): positive by Jensen's inequality unless every value is the same.
fn log_gap(data: &[f64]) -> Option<(f64, f64, f64)> {
    if data.iter().any(|x| !(*x > 0.0)) {
        return None;
    }
    let n = data.len() as f64;
    let mean = data.iter().sum::<f64>() / n;
    let mean_ln = data.iter().map(|x| x.ln()).sum::<f64>() / n;
    let s = mean.ln() - mean_ln;
    (s > 1e-13).then_some((mean, mean_ln, s))
}

/// (k̂, θ̂): k̂ solves ln k − ψ(k) = s by Newton's method from Minka's starting value
/// (T. P. Minka, "Estimating a Gamma distribution", 2002), θ̂ = x̄/k̂.
pub fn mle_gamma(data: &[f64]) -> Option<(f64, f64)> {
    let (mean, _, s) = log_gap(data)?;
    let mut k = (3.0 - s + ((s - 3.0) * (s - 3.0) + 24.0 * s).sqrt()) / (12.0 * s);
    for _ in 0..100 {
        let f = k.ln() - digamma(k) - s;
        let df = 1.0 / k - trigamma(k);
        let mut next = k - f / df;
        if !(next > 0.0) {
            next = k / 2.0;
        }
        let done = (next - k).abs() <= 1e-13 * k;
        k = next;
        if done {
            break;
        }
    }
    (k.is_finite() && k > 0.0).then(|| (k, mean / k))
}

pub const ERLANG_MAX_K: f64 = 100_000.0;

/// The Erlang profile log-likelihood per observation at a whole k (rate k/x̄).
fn erlang_profile(k: f64, mean: f64, mean_ln: f64) -> f64 {
    k * (k / mean).ln() + (k - 1.0) * mean_ln - k - ln_gamma(k)
}

/// (k̂, μ̂): the whole k ≥ 1 with the largest profile likelihood, and the stage rate k̂/x̄.
pub fn mle_erlang(data: &[f64]) -> Option<(f64, f64)> {
    let (mean, mean_ln, _) = log_gap(data)?;
    let (shape, _) = mle_gamma(data)?;
    let lo = shape.floor().clamp(1.0, ERLANG_MAX_K);
    let hi = shape.ceil().clamp(1.0, ERLANG_MAX_K);
    let k = if erlang_profile(hi, mean, mean_ln) > erlang_profile(lo, mean, mean_ln) { hi } else { lo };
    Some((k, k / mean))
}

/// (k̂, λ̂): k̂ by bisection on the score equation, computed on x/max so that xᵏ cannot overflow.
pub fn mle_weibull(data: &[f64]) -> Option<(f64, f64)> {
    log_gap(data)?;
    let n = data.len() as f64;
    let top = data.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let ln_y: Vec<f64> = data.iter().map(|x| (x / top).ln()).collect();
    let mean_ln = ln_y.iter().sum::<f64>() / n;
    let score = |k: f64| {
        let (mut a, mut b) = (0.0, 0.0);
        for l in &ln_y {
            let w = (k * l).exp();
            a += w * l;
            b += w;
        }
        a / b - 1.0 / k - mean_ln
    };
    let mut lo = 1e-3;
    let mut hi = 1.0;
    while score(hi) < 0.0 {
        hi *= 2.0;
        if hi > 1e6 {
            return None;
        }
    }
    if score(lo) > 0.0 {
        return None;
    }
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if score(mid) < 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let k = 0.5 * (lo + hi);
    let mean_pow = ln_y.iter().map(|l| (k * l).exp()).sum::<f64>() / n;
    Some((k, top * mean_pow.powf(1.0 / k)))
}

// ── The answer ───────────────────────────────────────────────────────────────────────────────

pub const MIN_POINTS: usize = 10;
pub const WARN_POINTS: usize = 30;
pub const MAX_POINTS: usize = 1_000_000;
const GRID_POINTS: usize = 121;
const ECDF_MAX_POINTS: usize = 400;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitRequest {
    /// The observed times, in any order.
    pub data: Vec<f64>,
    /// "source" (inter-arrival times: the exponential fit is offered as a Poisson process) or "station".
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub n: usize,
    pub mean: f64,
    /// Unbiased (divisor n − 1).
    pub variance: f64,
    pub sd: f64,
    pub scv: f64,
    pub min: f64,
    pub q1: f64,
    pub median: f64,
    pub q3: f64,
    pub max: f64,
    pub zeros: usize,
    /// 95 % intervals, and how they were made: "bootstrap" or "asymptotic".
    pub mean_interval: [f64; 2],
    pub scv_interval: [f64; 2],
    pub interval_method: &'static str,
    pub resamples: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FittedParam {
    pub key: String,
    pub name: String,
    pub value: f64,
    /// "time", "1/time" or null for a pure number.
    pub unit: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// The model's family name ("gamma", "erlang", "poisson", …).
    pub family: String,
    pub name: String,
    /// False when the family cannot describe these data; `note` says why.
    pub applicable: bool,
    pub note: Option<String>,
    pub params: Vec<FittedParam>,
    /// The model's parameter text, "key=value,key=value".
    pub parameters: String,
    /// The fitted law's own mean and SCV (core's `dist::mean`, `dist::scv`).
    pub mean: Option<f64>,
    pub scv: Option<f64>,
    /// Whether the family could take the sample's SCV (false for a family whose SCV is fixed or snapped).
    pub matches_scv: bool,
    pub free_parameters: usize,
    pub log_likelihood: Option<f64>,
    pub aic: Option<f64>,
    pub ks: Option<f64>,
    pub ks_p: Option<f64>,
    /// The density and distribution function on `FitReport::grid`; a density that is not finite is null.
    pub pdf: Vec<Option<f64>>,
    pub cdf: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Histogram {
    /// Bin edges, one more than the bins.
    pub edges: Vec<f64>,
    pub counts: Vec<usize>,
    /// counts / (n · bin width): comparable with a density.
    pub density: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitReport {
    pub summary: Summary,
    /// Maximum-likelihood fits, best (lowest AIC) first; the families that don't apply last.
    pub mle: Vec<Candidate>,
    /// The same families with the parameters that match the sample's mean and SCV.
    pub moments: Vec<Candidate>,
    /// The recommended family among `mle`, and why, in one sentence.
    pub recommended: Option<String>,
    pub reason: String,
    pub warnings: Vec<String>,
    pub histogram: Histogram,
    /// The empirical distribution function as (x, Fₙ(x)) steps, thinned to a few hundred points.
    pub ecdf: Vec<[f64; 2]>,
    pub grid: Vec<f64>,
}

fn sig(v: f64) -> String {
    dist::format_significant(v, 4)
}

fn parameter_text(d: Distribution, p: &Params) -> String {
    dist::parameter_defs(d)
        .iter()
        .filter_map(|def| p.get(def.key).map(|v| if def.integer { format!("{}={}", def.key, *v as i64) } else { format!("{}={}", def.key, v) }))
        .collect::<Vec<_>>()
        .join(",")
}

fn display_name(d: Distribution) -> &'static str {
    match d {
        Distribution::Poisson => "Poisson process (exponential gaps)",
        other => other.display_name(),
    }
}

fn free_parameters(d: Distribution) -> usize {
    dist::parameter_defs(d).len()
}

fn not_applicable(d: Distribution, note: String) -> Candidate {
    Candidate {
        family: d.raw().to_string(),
        name: display_name(d).to_string(),
        applicable: false,
        note: Some(note),
        params: vec![],
        parameters: String::new(),
        mean: None,
        scv: None,
        matches_scv: false,
        free_parameters: free_parameters(d),
        log_likelihood: None,
        aic: None,
        ks: None,
        ks_p: None,
        pdf: vec![],
        cdf: vec![],
    }
}

/// A family with its parameters, measured against the data.
fn candidate(d: Distribution, p: &Params, sorted: &[f64], grid: &[f64], sample_scv: f64, note: Option<String>) -> Candidate {
    let Some(law) = Law::of(d, p) else {
        return not_applicable(d, "Qnet could not find parameters for this family.".into());
    };
    let n = sorted.len();
    let k = free_parameters(d);
    let log_likelihood = law.log_likelihood(sorted);
    let continuous = !matches!(law, Law::Constant { .. });
    let ks = continuous.then(|| ks_statistic(sorted, |x| law.cdf(x)));
    let scv = dist::scv(d, p);
    Candidate {
        family: d.raw().to_string(),
        name: display_name(d).to_string(),
        applicable: true,
        note,
        params: dist::parameter_defs(d)
            .iter()
            .filter_map(|def| p.get(def.key).map(|v| FittedParam { key: def.key.to_string(), name: def.display_name.to_string(), value: *v, unit: def.unit.map(str::to_string) }))
            .collect(),
        parameters: parameter_text(d, p),
        mean: dist::mean(d, p),
        scv,
        matches_scv: scv.is_some_and(|c| (c - sample_scv).abs() <= 1e-9 * sample_scv.max(1.0)),
        free_parameters: k,
        log_likelihood,
        aic: log_likelihood.map(|l| 2.0 * k as f64 - 2.0 * l),
        ks,
        ks_p: ks.map(|d| ks_p_value(d, n)),
        pdf: grid.iter().map(|x| law.ln_pdf(*x).map(f64::exp).filter(|v| v.is_finite())).collect(),
        cdf: grid.iter().map(|x| law.cdf(*x)).collect(),
    }
}

/// Best first: by AIC where there is one, then by KS distance; what doesn't apply goes last.
fn rank(list: &mut [Candidate]) {
    let key = |c: &Candidate| (!c.applicable, c.aic.is_none(), c.aic.unwrap_or(0.0), c.ks.unwrap_or(f64::INFINITY));
    list.sort_by(|a, b| {
        let (x, y) = (key(a), key(b));
        x.0.cmp(&y.0).then(x.1.cmp(&y.1)).then(x.2.total_cmp(&y.2)).then(x.3.total_cmp(&y.3))
    });
}

const NEEDS_POSITIVE: &str = "This family needs every value to be greater than zero, and the data contain zeros.";

fn mle_candidates(sorted: &[f64], grid: &[f64], scv: f64, source: bool, degenerate: bool) -> Vec<Candidate> {
    use Distribution::*;
    let exp_family = if source { Poisson } else { Exponential };
    let has_zero = sorted[0] <= 0.0;
    let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
    let mut out = Vec::new();
    if degenerate {
        let mut c = candidate(Constant, &params(&[("value", mean)]), sorted, grid, scv, Some("Every value is the same, so only a deterministic time describes them.".into()));
        c.matches_scv = true;
        out.push(c);
        for d in [exp_family, Erlang, Gamma, Weibull, Lognormal, Uniform, Pareto] {
            out.push(not_applicable(d, "Every value is the same: there is no variability for this family to fit.".into()));
        }
        return out;
    }
    let or_refuse = |d: Distribution, p: Option<Params>, why: &str, note: Option<String>| match p {
        Some(p) => candidate(d, &p, sorted, grid, scv, note),
        None => not_applicable(d, if has_zero && d != Uniform && d != exp_family { NEEDS_POSITIVE.into() } else { why.into() }),
    };
    out.push(or_refuse(exp_family, mle_exponential(sorted).map(|r| params(&[(if source { "lambda" } else { "rate" }, r)])), "The mean is not positive.", None));
    // Erlang: never when the data are more variable than an exponential law.
    out.push(if scv > 1.0 {
        not_applicable(Erlang, format!("An Erlang time is never more variable than an exponential one (SCV ≤ 1); these data have SCV {}.", sig(scv)))
    } else {
        let fit = mle_erlang(sorted);
        let note = fit.and_then(|(k, _)| {
            if k == 1.0 {
                Some("With one stage an Erlang law is the exponential law.".to_string())
            } else if k >= ERLANG_MAX_K {
                Some("The data are almost constant: the number of stages stopped at Qnet's limit.".to_string())
            } else {
                None
            }
        });
        or_refuse(Erlang, fit.map(|(k, r)| params(&[("k", k), ("rate", r)])), "Qnet could not solve the likelihood equation for these data.", note)
    });
    out.push(or_refuse(Gamma, mle_gamma(sorted).map(|(k, t)| params(&[("shape", k), ("scale", t)])), "Qnet could not solve the likelihood equation for these data.", None));
    out.push(or_refuse(Weibull, mle_weibull(sorted).map(|(k, l)| params(&[("shape", k), ("scale", l)])), "Qnet could not solve the likelihood equation for these data.", None));
    out.push(or_refuse(Lognormal, mle_lognormal(sorted).map(|(m, s)| params(&[("mu", m), ("sigma", s)])), "Qnet could not fit this family to these data.", None));
    out.push(or_refuse(
        Uniform,
        mle_uniform(sorted).map(|(a, b)| params(&[("min", a), ("max", b)])),
        "Qnet could not fit this family to these data.",
        Some("The fitted range is exactly the data's own (min to max), so a new observation can fall outside it; AIC flatters such a fit.".into()),
    ));
    out.push(match mle_pareto(sorted) {
        Some((alpha, _)) if alpha <= 2.0 => not_applicable(Pareto, format!("The fitted shape is α = {}; Qnet holds a Pareto law only for α > 2, where its SCV is finite.", sig(alpha))),
        Some((alpha, xm)) => candidate(Pareto, &params(&[("shape", alpha), ("scale", xm)]), sorted, grid, scv, Some("The fitted minimum is the smallest observation; AIC flatters such a fit.".into())),
        None => not_applicable(Pareto, if has_zero { NEEDS_POSITIVE.into() } else { "Qnet could not fit this family to these data.".into() }),
    });
    out.push(not_applicable(Constant, "The values differ, so a deterministic time cannot have produced them.".into()));
    out
}

fn moment_candidates(sorted: &[f64], grid: &[f64], mean: f64, scv: f64, source: bool) -> Vec<Candidate> {
    use Distribution::*;
    let exp_family = if source { Poisson } else { Exponential };
    [exp_family, Erlang, Gamma, Weibull, Lognormal, Uniform, Pareto, Constant]
        .into_iter()
        .map(|d| match dist::parameters_from_moments(d, mean, scv) {
            Some(p) => {
                let fitted = dist::scv(d, &p);
                let matches = fitted.is_some_and(|c| (c - scv).abs() <= 1e-9 * scv.max(1.0));
                let note = match (matches, fitted) {
                    (true, _) => None,
                    (false, Some(c)) if d == Erlang => Some(format!("Matches the mean; the SCV is the nearest an Erlang law has, 1/k = {} (the data's is {}).", sig(c), sig(scv))),
                    (false, Some(c)) => Some(format!("Matches the mean only: this family's SCV is always {} (the data's is {}).", sig(c), sig(scv))),
                    (false, None) => None,
                };
                candidate(d, &p, sorted, grid, scv, note)
            }
            None => not_applicable(
                d,
                match d {
                    Uniform => format!("No uniform law on positive times has SCV {}: the largest it can have is 1/3.", sig(scv)),
                    Pareto => format!("No Pareto law has SCV {} with the finite variance Qnet needs.", sig(scv)),
                    _ => format!("This family cannot have SCV {}.", sig(scv)),
                },
            ),
        })
        .collect()
}

/// The family to use among the ranked maximum-likelihood fits, and one sentence saying why.
///
/// The lowest AIC wins, except that a simpler family is preferred when it is statistically
/// indistinguishable from the winner: exponential first when its AIC is within 2 (Burnham &
/// Anderson's rule of thumb; against Gamma or Weibull, which contain it with one more parameter,
/// that is a likelihood-ratio statistic under 4) — it keeps the exact product-form methods
/// available — then Erlang over a winning Gamma, which contains it with the same number of parameters, when twice
/// the log-likelihood difference is under 3.841, the 5 % point of χ² with one degree of freedom.
const CHI2_1_95: f64 = 3.841_458_820_694_124;

fn recommend(mle: &[Candidate], degenerate: bool) -> (Option<String>, String) {
    if degenerate {
        return (Some("constant".into()), "Every value is the same, so a deterministic time is the only law that describes them.".into());
    }
    let ranked: Vec<&Candidate> = mle.iter().filter(|c| c.applicable && c.aic.is_some()).collect();
    let Some(best) = ranked.first() else {
        return (None, "No family could be fitted to these data.".into());
    };
    let best_aic = best.aic.unwrap();
    let close = |family: &[&str]| ranked.iter().find(|c| family.contains(&c.family.as_str()) && c.aic.unwrap() - best_aic <= 2.0).copied();
    let (pick, mut reason) = if let Some(c) = close(&["exponential", "poisson"]) {
        let why = if c.family == best.family {
            "It has the lowest AIC of the families fitted, and it keeps Qnet's exact product-form methods available.".to_string()
        } else {
            format!("Its AIC is within 2 of the best ({}), so the data cannot tell them apart, and it is the simplest family: it keeps Qnet's exact product-form methods available.", best.name)
        };
        (c, why)
    } else if let Some(c) = ranked.iter().find(|c| c.family == "erlang" && matches!(best.family.as_str(), "erlang" | "gamma") && c.aic.unwrap() - best_aic <= CHI2_1_95).copied() {
        let why = if c.family == best.family {
            "It has the lowest AIC of the families fitted.".to_string()
        } else {
            format!("{} fits a little better, but not significantly so (a likelihood-ratio difference under the 5 % point of χ² with one degree of freedom), and a whole number of stages has a direct meaning.", best.name)
        };
        (c, why)
    } else {
        (*best, "It has the lowest AIC of the families fitted.".to_string())
    };
    if pick.ks_p.is_some_and(|p| p < 0.05) {
        reason.push_str(" Even so it fits poorly (the KS test rejects it): consider matching the mean and SCV instead.");
    }
    (Some(pick.family.clone()), reason)
}

fn histogram(sorted: &[f64], q1: f64, q3: f64) -> Histogram {
    let n = sorted.len();
    let (lo, hi) = (sorted[0], sorted[n - 1]);
    let range = hi - lo;
    if !(range > 0.0) {
        let half = if lo != 0.0 { lo.abs() * 0.05 } else { 0.5 };
        return Histogram { edges: vec![lo - half, lo + half], counts: vec![n], density: vec![1.0 / (2.0 * half)] };
    }
    // Freedman–Diaconis: width 2·IQR·n^(−1/3); Sturges' count when the quartiles coincide.
    let fd = 2.0 * (q3 - q1) / (n as f64).cbrt();
    let bins = if fd > 0.0 { (range / fd).ceil() } else { (n as f64).log2().ceil() + 1.0 };
    let bins = bins.clamp(5.0, 40.0) as usize;
    let width = range / bins as f64;
    let mut counts = vec![0usize; bins];
    for x in sorted {
        counts[(((x - lo) / width) as usize).min(bins - 1)] += 1;
    }
    Histogram {
        edges: (0..=bins).map(|i| if i == bins { hi } else { lo + i as f64 * width }).collect(),
        density: counts.iter().map(|c| *c as f64 / (n as f64 * width)).collect(),
        counts,
    }
}

fn ecdf(sorted: &[f64]) -> Vec<[f64; 2]> {
    let n = sorted.len();
    let step = n.div_ceil(ECDF_MAX_POINTS).max(1);
    let mut out: Vec<[f64; 2]> = Vec::new();
    for i in (step - 1..n).step_by(step) {
        // The step is taken at the last of equal values.
        if i + 1 < n && sorted[i + 1] == sorted[i] && i + step < n {
            continue;
        }
        out.push([sorted[i], (i + 1) as f64 / n as f64]);
    }
    if out.last().is_none_or(|p| p[1] < 1.0) {
        out.push([sorted[n - 1], 1.0]);
    }
    out
}

/// The whole answer for a sample. Refuses, with the reason, data it cannot fit.
pub fn fit(request: &FitRequest) -> Result<FitReport, QnError> {
    let n = request.data.len();
    if let Some(bad) = request.data.iter().find(|x| !x.is_finite()) {
        return Err(QnError::invalid(format!("The data contain a value that is not a finite number ({bad}).")));
    }
    let negatives = request.data.iter().filter(|x| **x < 0.0).count();
    if negatives > 0 {
        return Err(QnError::invalid(format!(
            "{negatives} of the values {} negative. A service or inter-arrival time cannot be negative: remove {}, or if these are event times, switch on “These are event times”.",
            if negatives == 1 { "is" } else { "are" },
            if negatives == 1 { "it" } else { "them" }
        )));
    }
    if n < MIN_POINTS {
        return Err(QnError::invalid(format!(
            "Qnet needs at least {MIN_POINTS} observations to fit a distribution, and there {} {n}. With so few, even the mean is uncertain by a large factor.",
            if n == 1 { "is" } else { "are" }
        )));
    }
    if n > MAX_POINTS {
        return Err(QnError::invalid(format!("Qnet fits at most {MAX_POINTS} observations at a time, and there are {n}.")));
    }
    let mut sorted = request.data.clone();
    sorted.sort_by(f64::total_cmp);
    let (mean, variance) = mean_variance(&sorted);
    if !(mean > 0.0) {
        return Err(QnError::invalid("Every value is zero, so there is no time to fit."));
    }
    let source = request.kind == "source";
    let (lo, hi) = (sorted[0], sorted[n - 1]);
    let degenerate = hi - lo <= 1e-12 * hi.abs();
    let scv = if degenerate { 0.0 } else { variance / (mean * mean) };
    let zeros = sorted.iter().filter(|x| **x == 0.0).count();
    let (q1, median, q3) = (quantile(&sorted, 0.25), quantile(&sorted, 0.5), quantile(&sorted, 0.75));
    let bootstrap = n <= BOOTSTRAP_MAX_N;
    let (mean_interval, scv_interval) = if degenerate {
        ([mean, mean], [0.0, 0.0])
    } else if bootstrap {
        bootstrap_intervals(&sorted)
    } else {
        asymptotic_intervals(&sorted)
    };
    let summary = Summary {
        n,
        mean,
        variance: if degenerate { 0.0 } else { variance },
        sd: if degenerate { 0.0 } else { variance.sqrt() },
        scv,
        min: lo,
        q1,
        median,
        q3,
        max: hi,
        zeros,
        mean_interval,
        scv_interval,
        interval_method: if bootstrap { "bootstrap" } else { "asymptotic" },
        resamples: if bootstrap && !degenerate { BOOTSTRAP_RESAMPLES } else { 0 },
    };

    let pad = if degenerate { hi.abs() * 0.5 } else { (hi - lo) * 0.05 };
    let (g0, g1) = ((lo - pad).max(0.0), hi + pad);
    let grid: Vec<f64> = (0..GRID_POINTS).map(|i| g0 + (g1 - g0) * i as f64 / (GRID_POINTS - 1) as f64).collect();

    let mut mle = mle_candidates(&sorted, &grid, scv, source, degenerate);
    rank(&mut mle);
    let mut moments = moment_candidates(&sorted, &grid, mean, scv, source);
    rank(&mut moments);
    let (recommended, reason) = recommend(&mle, degenerate);

    let mut warnings = Vec::new();
    if n < WARN_POINTS {
        warnings.push(format!("Only {n} observations: with fewer than {WARN_POINTS} the SCV in particular is uncertain, and several families will fit about equally well. Read the intervals before trusting a family."));
    }
    if zeros > 0 && !degenerate {
        warnings.push(format!(
            "{zeros} of the values {} exactly zero. Gamma, Erlang, Weibull, lognormal and Pareto laws need positive values, so only the exponential and uniform laws are fitted by maximum likelihood; the mean-and-SCV match is not affected.",
            if zeros == 1 { "is" } else { "are" }
        ));
    }

    Ok(FitReport { histogram: histogram(&sorted, q1, q3), ecdf: ecdf(&sorted), summary, mle, moments, recommended, reason, warnings, grid })
}

/// Fit ▸ the whole answer for a pasted or loaded sample. Async, so a large sample's bootstrap
/// runs off the main thread.
#[tauri::command]
pub async fn fit_distribution(request: FitRequest) -> Result<FitReport, QnError> {
    fit(&request)
}

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataFile {
    pub name: String,
    pub text: String,
}

/// The text of a data file the user chose (CSV or plain text), for the interface to read numbers from.
pub fn read_data_file(path: &std::path::Path) -> Result<DataFile, QnError> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let meta = std::fs::metadata(path).map_err(|e| QnError::new(crate::errors::ErrorKind::NotFound, format!("Qnet couldn't open “{name}”.")).with_detail(e.to_string()))?;
    if !meta.is_file() {
        return Err(QnError::invalid(format!("“{name}” is not a file.")));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(QnError::invalid(format!("“{name}” is larger than 16 MB, which is more than Qnet reads as a data file.")));
    }
    let bytes = std::fs::read(path).map_err(|e| QnError::failed(format!("Qnet couldn't read “{name}”.")).with_detail(e.to_string()))?;
    if bytes.iter().take(4096).any(|b| *b == 0) {
        return Err(QnError::invalid(format!("“{name}” is not a text file. Export the numbers as CSV or plain text first.")));
    }
    Ok(DataFile { name, text: String::from_utf8_lossy(&bytes).into_owned() })
}

#[tauri::command]
pub async fn fit_read_file(path: String) -> Result<DataFile, QnError> {
    read_data_file(std::path::Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(got: f64, want: f64, tol: f64, what: &str) {
        assert!((got - want).abs() <= tol, "{what}: got {got}, want {want} (± {tol})");
    }

    fn rel(got: f64, want: f64, tol: f64, what: &str) {
        assert!((got - want).abs() <= tol * want.abs(), "{what}: got {got}, want {want} (± {} %)", tol * 100.0);
    }

    // ── Special functions against known values ──────────────────────────────────────────────

    /// Closed forms: Γ(½) = √π, Γ(n) = (n−1)!, and Γ(100) = 99! (ln 99! = 359.134205369575…,
    /// Abramowitz & Stegun table 6.4). Also against libm's Γ, the one core uses.
    #[test]
    fn ln_gamma_matches_closed_forms_and_libm() {
        close(ln_gamma(0.5), std::f64::consts::PI.sqrt().ln(), 1e-14, "ln Γ(1/2)");
        close(ln_gamma(1.0), 0.0, 1e-14, "ln Γ(1)");
        close(ln_gamma(2.0), 0.0, 1e-14, "ln Γ(2)");
        close(ln_gamma(10.0), 362_880f64.ln(), 1e-13, "ln Γ(10)");
        rel(ln_gamma(100.0), 359.134_205_369_575_4, 1e-14, "ln Γ(100)");
        for x in [0.1, 0.3, 0.75, 1.5, 3.7, 12.25, 60.0, 150.0] {
            rel(ln_gamma(x), qnet_core::cfmt::tgamma(x).ln(), 2e-13, &format!("ln Γ({x})"));
        }
    }

    /// ψ(1) = −γ, ψ(½) = −γ − 2 ln 2, ψ(n+1) = ψ(n) + 1/n; ψ′(1) = π²/6, ψ′(½) = π²/2
    /// (Abramowitz & Stegun 6.3.2, 6.3.3, 6.4.2, 6.4.4).
    #[test]
    fn digamma_and_trigamma_match_closed_forms() {
        const EULER: f64 = 0.577_215_664_901_532_9;
        close(digamma(1.0), -EULER, 1e-13, "ψ(1)");
        close(digamma(0.5), -EULER - 2.0 * 2f64.ln(), 1e-13, "ψ(1/2)");
        let h9: f64 = (1..=9).map(|k| 1.0 / k as f64).sum();
        close(digamma(10.0), -EULER + h9, 1e-13, "ψ(10)");
        close(digamma(123.5 + 1.0), digamma(123.5) + 1.0 / 123.5, 1e-13, "recurrence");
        let pi2 = std::f64::consts::PI * std::f64::consts::PI;
        close(trigamma(1.0), pi2 / 6.0, 1e-12, "ψ′(1)");
        close(trigamma(0.5), pi2 / 2.0, 1e-12, "ψ′(1/2)");
        // ψ′ is the derivative of ψ (central difference).
        for x in [0.7, 2.3, 9.0, 40.0] {
            let h = 1e-5 * x;
            rel(trigamma(x), (digamma(x + h) - digamma(x - h)) / (2.0 * h), 1e-7, &format!("ψ′({x})"));
        }
    }

    /// P(1, x) = 1 − e^(−x); P(2, 2) = 1 − 3e^(−2); P(½, ½) = erf(1/√2) = 0.682689492137086
    /// (the one-sigma probability); P(10, 10) = 1 − Σ_{k<10} e^(−10) 10^k/k! (a Poisson tail,
    /// summed here), and Φ(1.96) = 0.975002104851780 (A&S table 26.1).
    #[test]
    fn incomplete_gamma_and_normal_cdf_match_closed_forms() {
        for x in [0.01, 0.5, 1.0, 3.0, 20.0] {
            close(gamma_p(1.0, x), 1.0 - (-x as f64).exp(), 1e-14, &format!("P(1,{x})"));
        }
        close(gamma_p(2.0, 2.0), 1.0 - 3.0 * (-2f64).exp(), 1e-14, "P(2,2)");
        close(gamma_p(0.5, 0.5), 0.682_689_492_137_086, 1e-13, "P(1/2,1/2)");
        let mut term = (-10f64).exp();
        let mut below = term;
        for k in 1..10 {
            term *= 10.0 / k as f64;
            below += term;
        }
        close(gamma_p(10.0, 10.0), 1.0 - below, 1e-13, "P(10,10)");
        // Both branches meet: the series just below a + 1 and the continued fraction just above.
        close(gamma_p(4.0, 4.999_999_999), gamma_p(4.0, 5.000_000_001), 1e-8, "branch join");
        close(normal_cdf(0.0), 0.5, 1e-15, "Φ(0)");
        close(normal_cdf(1.96), 0.975_002_104_851_780, 1e-13, "Φ(1.96)");
        close(normal_cdf(-1.96), 1.0 - 0.975_002_104_851_780, 1e-13, "Φ(−1.96)");
    }

    // ── Closed-form MLEs against hand-computed samples ──────────────────────────────────────

    #[test]
    fn closed_form_mles_match_hand_computation() {
        // Exponential, {1, 2, 3}: x̄ = 2, λ̂ = 1/2, ℓ = 3 ln ½ − ½·6 = −5.079441541679836.
        let r = mle_exponential(&[1.0, 2.0, 3.0]).unwrap();
        assert_eq!(r, 0.5);
        close(Law::Exponential { rate: r }.log_likelihood(&[1.0, 2.0, 3.0]).unwrap(), 3.0 * 0.5f64.ln() - 3.0, 1e-14, "exponential ℓ");
        // Uniform, {2, 5, 3}: (2, 5), ℓ = −3 ln 3.
        assert_eq!(mle_uniform(&[2.0, 5.0, 3.0]), Some((2.0, 5.0)));
        close(Law::Uniform { min: 2.0, max: 5.0 }.log_likelihood(&[2.0, 5.0, 3.0]).unwrap(), -3.0 * 3f64.ln(), 1e-14, "uniform ℓ");
        // Lognormal, {1, e, e²}: logs 0, 1, 2 → μ̂ = 1, σ̂² = 2/3.
        let e = std::f64::consts::E;
        let (mu, sigma) = mle_lognormal(&[1.0, e, e * e]).unwrap();
        close(mu, 1.0, 1e-14, "lognormal μ");
        close(sigma, (2.0f64 / 3.0).sqrt(), 1e-14, "lognormal σ");
        // ℓ = −Σ ln x − n ln σ − (n/2) ln 2π − n/2 = −3 − 3 ln σ − 1.5 ln 2π − 1.5.
        close(
            Law::Lognormal { mu, sigma }.log_likelihood(&[1.0, e, e * e]).unwrap(),
            -3.0 - 3.0 * sigma.ln() - 1.5 * (2.0 * std::f64::consts::PI).ln() - 1.5,
            1e-13,
            "lognormal ℓ",
        );
        // Pareto, {1, e, e²}: x̂ₘ = 1, α̂ = 3/(0 + 1 + 2) = 1.
        let (alpha, xm) = mle_pareto(&[1.0, e, e * e]).unwrap();
        close(alpha, 1.0, 1e-14, "Pareto α");
        assert_eq!(xm, 1.0);
        // Erlang profile, {1, 3}: x̄ = 2, L = ½ ln 3. ℓ₁/n = −ln 2 − 1 = −1.6931; ℓ₂/n = L − 2 =
        // −1.4507; ℓ₃/n = 3 ln 1.5 + 2L − 3 − ln 2 = −1.3781; ℓ₄/n = 4 ln 2 + 3L − 4 − ln 6 = −1.3713;
        // ℓ₅/n = 5 ln 2.5 + 4L − 5 − ln 24 = −1.3995. So k̂ = 4, μ̂ = 2.
        let l = 0.5 * 3f64.ln();
        close(erlang_profile(3.0, 2.0, l), 3.0 * 1.5f64.ln() + 2.0 * l - 3.0 - 2f64.ln(), 1e-14, "profile at 3");
        assert_eq!(mle_erlang(&[1.0, 3.0]), Some((4.0, 2.0)));
    }

    /// The numeric MLEs satisfy their score equations, and no nearby parameter has a higher
    /// likelihood (a 1 % step in each direction).
    #[test]
    fn numeric_mles_solve_their_likelihood_equations() {
        let data = [0.31, 0.92, 1.4, 0.55, 2.7, 1.1, 0.8, 1.9, 0.47, 1.25, 3.3, 0.66];
        let n = data.len() as f64;
        let mean = data.iter().sum::<f64>() / n;
        let mean_ln = data.iter().map(|x| x.ln()).sum::<f64>() / n;

        let (k, theta) = mle_gamma(&data).unwrap();
        close(k.ln() - digamma(k), mean.ln() - mean_ln, 1e-11, "gamma score in k");
        close(k * theta, mean, 1e-12, "gamma mean");
        let at = |k: f64, t: f64| Law::Gamma { shape: k, scale: t }.log_likelihood(&data).unwrap();
        for (dk, dt) in [(1.01, 1.0), (0.99, 1.0), (1.0, 1.01), (1.0, 0.99)] {
            assert!(at(k, theta) > at(k * dk, theta * dt), "gamma is a maximum");
        }

        let (k, lambda) = mle_weibull(&data).unwrap();
        let a: f64 = data.iter().map(|x| x.powf(k) * x.ln()).sum();
        let b: f64 = data.iter().map(|x| x.powf(k)).sum();
        close(a / b - 1.0 / k, mean_ln, 1e-10, "Weibull score in k");
        close(lambda.powf(k), b / n, 1e-10, "Weibull scale");
        let at = |k: f64, l: f64| Law::Weibull { shape: k, scale: l }.log_likelihood(&data).unwrap();
        for (dk, dl) in [(1.01, 1.0), (0.99, 1.0), (1.0, 1.01), (1.0, 0.99)] {
            assert!(at(k, lambda) > at(k * dk, lambda * dl), "Weibull is a maximum");
        }
    }

    /// Two routes to one number: a Gamma or a Weibull law with shape 1, and an Erlang law with
    /// one stage, are the exponential law, so their densities and distribution functions agree.
    #[test]
    fn nested_families_agree_with_the_exponential() {
        let e = Law::Exponential { rate: 0.8 };
        let g = Law::Gamma { shape: 1.0, scale: 1.25 };
        let w = Law::Weibull { shape: 1.0, scale: 1.25 };
        for x in [0.0, 0.2, 1.0, 4.0, 15.0] {
            close(g.ln_pdf(x).unwrap(), e.ln_pdf(x).unwrap(), 1e-13, "gamma pdf");
            close(w.ln_pdf(x).unwrap(), e.ln_pdf(x).unwrap(), 1e-13, "Weibull pdf");
            close(g.cdf(x), e.cdf(x), 1e-13, "gamma cdf");
            close(w.cdf(x), e.cdf(x), 1e-13, "Weibull cdf");
        }
        // Erlang-3 with rate 2: F(x) = 1 − e^(−2x)(1 + 2x + 2x²).
        let p: Params = params(&[("k", 3.0), ("rate", 2.0)]);
        let law = Law::of(Distribution::Erlang, &p).unwrap();
        for x in [0.3f64, 1.0, 2.5] {
            close(law.cdf(x), 1.0 - (-2.0 * x).exp() * (1.0 + 2.0 * x + 2.0 * x * x), 1e-13, "Erlang-3 cdf");
        }
    }

    // ── Kolmogorov–Smirnov against published values ─────────────────────────────────────────

    #[test]
    fn ks_statistic_matches_a_hand_computed_sample() {
        // {0.1, 0.4, 0.7} against Uniform(0, 1): D⁺ = max(1/3 − 0.1, 2/3 − 0.4, 1 − 0.7) = 0.3,
        // D⁻ = max(0.1, 0.4 − 1/3, 0.7 − 2/3) = 0.1, so D = 0.3.
        close(ks_statistic(&[0.1, 0.4, 0.7], |x| x), 0.3, 1e-15, "D");
        // A sample at the law's own quantile midpoints has D = 1/(2n).
        let mid: Vec<f64> = (0..20).map(|i| (i as f64 + 0.5) / 20.0).collect();
        close(ks_statistic(&mid, |x| x), 0.025, 1e-15, "midpoints");
    }

    /// Kolmogorov's limiting distribution: the critical values 1.2238, 1.3581 and 1.6276 for
    /// α = 0.10, 0.05 and 0.01 (N. Smirnov, "Table for estimating the goodness of fit of
    /// empirical distributions", Ann. Math. Statist. 19 (1948) 279–281; they are the 1.22/√n,
    /// 1.36/√n and 1.63/√n of every textbook table).
    #[test]
    fn kolmogorov_distribution_matches_smirnovs_table() {
        close(kolmogorov_q(1.2238), 0.10, 5e-5, "α = 0.10");
        close(kolmogorov_q(1.3581), 0.05, 5e-5, "α = 0.05");
        close(kolmogorov_q(1.6276), 0.01, 5e-5, "α = 0.01");
        assert_eq!(kolmogorov_q(0.0), 1.0);
        assert!(kolmogorov_q(0.3) > 0.9999 && kolmogorov_q(3.0) < 1e-7);
    }

    /// Finite-sample critical values of D (F. J. Massey, "The Kolmogorov–Smirnov test for goodness
    /// of fit", JASA 46 (1951) 68–78, Table 1): at α = 0.05, D = 0.410 for n = 10, 0.294 for
    /// n = 20, 0.240 for n = 30; at α = 0.01, 0.490 for n = 10 and 0.356 for n = 20. With
    /// Stephens' correction the asymptotic p-value reproduces them to within 0.004 (the table is
    /// rounded to three places, which alone moves p by about 0.002).
    #[test]
    fn ks_p_value_reproduces_masseys_finite_sample_table() {
        for (n, d, alpha) in [(10, 0.410, 0.05), (20, 0.294, 0.05), (30, 0.240, 0.05), (10, 0.490, 0.01), (20, 0.356, 0.01)] {
            close(ks_p_value(d, n), alpha, 0.004, &format!("n = {n}, D = {d}"));
        }
    }

    // ── Recovery of known parameters from fixed-seed synthetic samples ──────────────────────

    struct Sampler(SplitMix64);

    impl Sampler {
        fn exp(&mut self, rate: f64) -> f64 {
            -self.0.uniform().ln() / rate
        }
        fn normal(&mut self) -> f64 {
            // Box–Muller.
            (-2.0 * self.0.uniform().ln()).sqrt() * (2.0 * std::f64::consts::PI * self.0.uniform()).cos()
        }
        /// Marsaglia & Tsang (2000), with the boost for shape < 1.
        fn gamma(&mut self, shape: f64, scale: f64) -> f64 {
            if shape < 1.0 {
                let u = self.0.uniform();
                return self.gamma(shape + 1.0, scale) * u.powf(1.0 / shape);
            }
            let d = shape - 1.0 / 3.0;
            let c = 1.0 / (9.0 * d).sqrt();
            loop {
                let x = self.normal();
                let v = (1.0 + c * x).powi(3);
                if v <= 0.0 {
                    continue;
                }
                let u = self.0.uniform();
                if u.ln() < 0.5 * x * x + d - d * v + d * v.ln() {
                    return d * v * scale;
                }
            }
        }
        fn erlang(&mut self, k: usize, rate: f64) -> f64 {
            (0..k).map(|_| self.exp(rate)).sum()
        }
        fn weibull(&mut self, shape: f64, scale: f64) -> f64 {
            scale * (-self.0.uniform().ln()).powf(1.0 / shape)
        }
        fn lognormal(&mut self, mu: f64, sigma: f64) -> f64 {
            (mu + sigma * self.normal()).exp()
        }
        fn pareto(&mut self, alpha: f64, xm: f64) -> f64 {
            xm * self.0.uniform().powf(-1.0 / alpha)
        }
        fn uniform(&mut self, a: f64, b: f64) -> f64 {
            a + (b - a) * self.0.uniform()
        }
    }

    fn sample(seed: u64, n: usize, mut draw: impl FnMut(&mut Sampler) -> f64) -> Vec<f64> {
        let mut s = Sampler(SplitMix64(seed));
        (0..n).map(|_| draw(&mut s)).collect()
    }

    fn report(data: Vec<f64>, kind: &str) -> FitReport {
        fit(&FitRequest { data, kind: kind.into() }).expect("a fit")
    }

    fn param(c: &Candidate, key: &str) -> f64 {
        c.params.iter().find(|p| p.key == key).unwrap_or_else(|| panic!("{} has no {key}", c.family)).value
    }

    fn family<'a>(list: &'a [Candidate], name: &str) -> &'a Candidate {
        list.iter().find(|c| c.family == name).unwrap_or_else(|| panic!("no {name}"))
    }

    /// Every family recovers the parameters its sample was drawn with. n = 20 000, so a rate or a
    /// scale has a standard error of about 1/√n = 0.7 % and a shape about 1 %; the tolerances are
    /// 3 % and 5 %, four to five standard errors (σ̂ of a lognormal: 0.5 %, tolerance 3 %; the
    /// uniform's ends and the Pareto minimum converge at rate 1/n, tolerance 0.1 %).
    #[test]
    fn every_family_recovers_known_parameters_from_a_large_sample() {
        const N: usize = 20_000;
        let r = report(sample(1, N, |s| s.exp(2.5)), "station");
        rel(param(family(&r.mle, "exponential"), "rate"), 2.5, 0.03, "exponential rate");
        assert_eq!(r.recommended.as_deref(), Some("exponential"));

        let r = report(sample(2, N, |s| s.gamma(2.6, 0.7)), "station");
        let g = family(&r.mle, "gamma");
        rel(param(g, "shape"), 2.6, 0.05, "gamma shape");
        rel(param(g, "scale"), 0.7, 0.05, "gamma scale");
        assert_eq!(r.recommended.as_deref(), Some("gamma"));

        let r = report(sample(3, N, |s| s.gamma(0.5, 3.0)), "station");
        let g = family(&r.mle, "gamma");
        rel(param(g, "shape"), 0.5, 0.05, "gamma shape below 1");
        rel(param(g, "scale"), 3.0, 0.05, "gamma scale");

        let r = report(sample(4, N, |s| s.weibull(1.8, 3.0)), "station");
        let w = family(&r.mle, "weibull");
        rel(param(w, "shape"), 1.8, 0.05, "Weibull shape");
        rel(param(w, "scale"), 3.0, 0.03, "Weibull scale");
        assert_eq!(r.recommended.as_deref(), Some("weibull"));

        let r = report(sample(5, N, |s| s.lognormal(0.4, 0.9)), "station");
        let l = family(&r.mle, "lognormal");
        close(param(l, "mu"), 0.4, 0.03, "lognormal μ");
        rel(param(l, "sigma"), 0.9, 0.03, "lognormal σ");
        assert_eq!(r.recommended.as_deref(), Some("lognormal"));

        let r = report(sample(6, N, |s| s.pareto(3.5, 2.0)), "station");
        let p = family(&r.mle, "pareto");
        rel(param(p, "shape"), 3.5, 0.05, "Pareto α");
        rel(param(p, "scale"), 2.0, 0.001, "Pareto minimum");
        assert_eq!(r.recommended.as_deref(), Some("pareto"));

        let r = report(sample(7, N, |s| s.uniform(1.0, 4.0)), "station");
        let u = family(&r.mle, "uniform");
        rel(param(u, "min"), 1.0, 0.001, "uniform min");
        rel(param(u, "max"), 4.0, 0.001, "uniform max");
        assert_eq!(r.recommended.as_deref(), Some("uniform"));

        // The summary and the moment match: the fitted law has the sample's mean and SCV exactly.
        let r = report(sample(8, N, |s| s.gamma(4.0, 0.5)), "station");
        rel(r.summary.mean, 2.0, 0.02, "mean");
        rel(r.summary.scv, 0.25, 0.05, "SCV");
        for c in r.moments.iter().filter(|c| c.applicable && c.matches_scv) {
            rel(c.mean.unwrap(), r.summary.mean, 1e-9, &format!("{} mean", c.family));
            rel(c.scv.unwrap(), r.summary.scv, 1e-7, &format!("{} SCV", c.family));
        }
        assert!(family(&r.moments, "gamma").matches_scv && !family(&r.moments, "exponential").matches_scv);
    }

    /// Erlang's whole k: the profile likelihood picks the k the sample was drawn with, and the
    /// stage rate follows (n = 5000: k̂ as a real number has a standard error near 2 %·k, far
    /// from the next whole number for k ≤ 7).
    #[test]
    fn erlang_selection_picks_the_right_number_of_stages() {
        for (seed, k, rate) in [(11u64, 2usize, 3.0), (12, 4, 1.0), (13, 7, 0.5), (14, 1, 2.0), (15, 1, 2.0)] {
            let r = report(sample(seed, 5000, |s| s.erlang(k, rate)), "station");
            let e = family(&r.mle, "erlang");
            if k == 1 && r.summary.scv > 1.0 {
                // An exponential sample's SCV falls above 1 half the time, and then Erlang is refused.
                assert!(!e.applicable);
                assert_eq!(r.recommended.as_deref(), Some("exponential"));
                continue;
            }
            assert!(e.applicable, "k = {k}");
            assert_eq!(param(e, "k"), k as f64, "k = {k}");
            rel(param(e, "rate"), rate, 0.05, "stage rate");
            assert_eq!(e.parameters.split(',').next().unwrap(), format!("k={k}"), "k is written as a whole number");
            // Erlang-k is nested in Gamma, whose likelihood can only be a little higher.
            let g = family(&r.mle, "gamma");
            assert!(g.log_likelihood.unwrap() >= e.log_likelihood.unwrap() - 1e-9);
            let want = if k == 1 { "exponential" } else { "erlang" };
            assert_eq!(r.recommended.as_deref(), Some(want), "k = {k}: {}", r.reason);
        }
    }

    // ── Degenerate and refused inputs ───────────────────────────────────────────────────────

    #[test]
    fn equal_values_give_a_deterministic_time_and_nothing_else() {
        let r = report(vec![2.5; 12], "station");
        assert_eq!(r.recommended.as_deref(), Some("constant"));
        assert_eq!(r.summary.scv, 0.0);
        assert_eq!(r.summary.mean_interval, [2.5, 2.5]);
        let c = &r.mle[0];
        assert_eq!((c.family.as_str(), c.applicable, c.parameters.as_str()), ("constant", true, "value=2.5"));
        assert!(r.mle[1..].iter().all(|c| !c.applicable && c.note.is_some()));
        assert_eq!(r.histogram.counts, vec![12]);
    }

    #[test]
    fn data_more_variable_than_exponential_are_never_fitted_as_erlang() {
        // A two-phase mixture with SCV well above 1.
        let data = sample(21, 400, |s| if s.0.uniform() < 0.9 { s.exp(5.0) } else { s.exp(0.2) });
        let r = report(data, "station");
        assert!(r.summary.scv > 1.5, "SCV {}", r.summary.scv);
        let e = family(&r.mle, "erlang");
        assert!(!e.applicable);
        assert!(e.note.as_deref().unwrap().contains("never more variable"), "{:?}", e.note);
        assert_ne!(r.recommended.as_deref(), Some("erlang"));
        // The moment match snaps to one stage and says the SCV is not matched.
        let m = family(&r.moments, "erlang");
        assert_eq!(param(m, "k"), 1.0);
        assert!(!m.matches_scv && m.note.is_some());
        // No uniform law has this SCV.
        assert!(!family(&r.moments, "uniform").applicable);
    }

    #[test]
    fn a_heavy_tail_the_model_cannot_hold_is_refused_for_pareto() {
        let r = report(sample(22, 2000, |s| s.pareto(1.4, 1.0)), "station");
        let p = family(&r.mle, "pareto");
        assert!(!p.applicable && p.note.as_deref().unwrap().contains("α > 2"), "{:?}", p.note);
    }

    #[test]
    fn too_few_points_negative_values_and_zeros_are_said_plainly() {
        let few = fit(&FitRequest { data: vec![1.0; 9], kind: "station".into() }).unwrap_err();
        assert!(few.message.contains("at least 10 observations") && few.message.contains("there are 9"), "{}", few.message);
        let neg = fit(&FitRequest { data: vec![1.0, 2.0, -0.5, 1.0, 2.0, 3.0, 1.0, 2.0, 3.0, 4.0], kind: "station".into() }).unwrap_err();
        assert!(neg.message.starts_with("1 of the values is negative"), "{}", neg.message);
        let nan = fit(&FitRequest { data: vec![f64::NAN; 12], kind: "station".into() }).unwrap_err();
        assert!(nan.message.contains("not a finite number"));
        assert!(fit(&FitRequest { data: vec![0.0; 12], kind: "station".into() }).is_err());

        let mut data = sample(23, 20, |s| s.exp(1.0));
        data[3] = 0.0;
        let r = report(data, "station");
        assert_eq!(r.summary.zeros, 1);
        assert_eq!(r.warnings.len(), 2, "fewer than 30, and a zero: {:?}", r.warnings);
        assert!(family(&r.mle, "exponential").applicable && family(&r.mle, "uniform").applicable);
        assert!(!family(&r.mle, "erlang").applicable);
        for f in ["gamma", "weibull", "lognormal", "pareto"] {
            let c = family(&r.mle, f);
            assert!(!c.applicable && c.note.as_deref() == Some(NEEDS_POSITIVE), "{f}: {:?}", c.note);
        }
        assert!(report(sample(24, 30, |s| s.exp(1.0)), "station").warnings.is_empty());
    }

    #[test]
    fn a_sources_exponential_fit_is_a_poisson_process() {
        let r = report(sample(31, 500, |s| s.exp(4.0)), "source");
        let p = family(&r.mle, "poisson");
        rel(param(p, "lambda"), 4.0, 0.15, "λ");
        assert!(p.parameters.starts_with("lambda="));
        assert!(r.mle.iter().all(|c| c.family != "exponential"));
        assert_eq!(r.recommended.as_deref(), Some("poisson"));
    }

    // ── The summary, its intervals, and the shape of the answer ─────────────────────────────

    #[test]
    fn summary_statistics_match_hand_computation() {
        // 1…10: mean 5.5, variance 55/6, quartiles (type 7) 3.25, 5.5, 7.75.
        let r = report((1..=10).map(f64::from).collect(), "station");
        let s = &r.summary;
        assert_eq!((s.n, s.mean, s.min, s.max, s.median), (10, 5.5, 1.0, 10.0, 5.5));
        close(s.variance, 55.0 / 6.0, 1e-13, "variance");
        close(s.scv, 55.0 / 6.0 / 30.25, 1e-13, "SCV");
        assert_eq!((s.q1, s.q3), (3.25, 7.75));
        assert!(s.mean_interval[0] < 5.5 && 5.5 < s.mean_interval[1]);
        assert_eq!(s.interval_method, "bootstrap");
        // The histogram counts every point; the ECDF ends at 1.
        assert_eq!(r.histogram.counts.iter().sum::<usize>(), 10);
        assert_eq!(r.histogram.edges.len(), r.histogram.counts.len() + 1);
        let area: f64 = r.histogram.density.iter().zip(r.histogram.edges.windows(2)).map(|(d, e)| d * (e[1] - e[0])).sum();
        close(area, 1.0, 1e-12, "the histogram's area");
        assert_eq!(r.ecdf.last().unwrap(), &[10.0, 1.0]);
        assert_eq!(r.ecdf.len(), 10);
        for c in r.mle.iter().chain(&r.moments).filter(|c| c.applicable) {
            assert_eq!((c.pdf.len(), c.cdf.len()), (r.grid.len(), r.grid.len()), "{}", c.family);
        }
    }

    /// Two routes to the intervals: on a large exponential sample the bootstrap and the delta
    /// method agree (each end within 15 % of the interval's half-width, the bootstrap's own
    /// Monte-Carlo error with 2000 resamples being about 5 %), and the SCV's asymptotic
    /// half-width is 1.96·√(4/n) as the exponential's moments (σ² = 1, μ₃ = 2, μ₄ = 9) give.
    #[test]
    fn bootstrap_and_asymptotic_intervals_agree_on_a_large_sample() {
        let n = 4000;
        let data = sample(41, n, |s| s.exp(1.0));
        let (bm, bs) = bootstrap_intervals(&data);
        let (am, asv) = asymptotic_intervals(&data);
        let (hm, hs) = ((am[1] - am[0]) / 2.0, (asv[1] - asv[0]) / 2.0);
        for i in 0..2 {
            close(bm[i], am[i], 0.15 * hm, "mean interval");
            close(bs[i], asv[i], 0.15 * hs, "SCV interval");
        }
        // (The fourth moment of 4000 exponential values is itself noisy, so this closed form is
        // checked on a sample large enough to pin it: 200 000 values, within 5 %.)
        let big = sample(43, 200_000, |s| s.exp(1.0));
        let (_, bs_big) = asymptotic_intervals(&big);
        rel((bs_big[1] - bs_big[0]) / 2.0, 1.959_964 * (4.0 / 200_000f64).sqrt(), 0.05, "SCV half-width");
        // The same data give the same interval again (fixed seed).
        assert_eq!(bootstrap_intervals(&data), (bm, bs));
        // The intervals cover the truth here.
        assert!(bm[0] < 1.0 && 1.0 < bm[1] && bs[0] < 1.0 && 1.0 < bs[1]);
        assert_eq!(report(sample(42, BOOTSTRAP_MAX_N + 1, |s| s.exp(1.0)), "station").summary.interval_method, "asymptotic");
    }

    /// The KS p-value behaves as a p-value should for a law fixed in advance: of 400 exponential
    /// samples of size 50 tested against the true Exp(1), about 5 % are rejected at 0.05 (the
    /// binomial standard error is 1.1 %; the band is 2 % to 9 %). Against the law FITTED to each
    /// sample far fewer are — which is the optimism the interface warns about.
    #[test]
    fn ks_p_value_is_calibrated_for_a_fixed_law_and_optimistic_for_a_fitted_one() {
        let truth = Law::Exponential { rate: 1.0 };
        let (mut fixed, mut fitted) = (0, 0);
        for seed in 0..400u64 {
            let mut data = sample(1000 + seed, 50, |s| s.exp(1.0));
            data.sort_by(f64::total_cmp);
            if ks_p_value(ks_statistic(&data, |x| truth.cdf(x)), 50) < 0.05 {
                fixed += 1;
            }
            let own = Law::Exponential { rate: mle_exponential(&data).unwrap() };
            if ks_p_value(ks_statistic(&data, |x| own.cdf(x)), 50) < 0.05 {
                fitted += 1;
            }
        }
        assert!((8..=36).contains(&fixed), "fixed law: {fixed} of 400 rejected");
        assert!(fitted < fixed && fitted <= 8, "fitted law: {fitted} of 400 rejected");
    }

    #[test]
    fn candidates_are_ranked_by_aic_and_the_reason_is_one_sentence_or_two() {
        let r = report(sample(51, 300, |s| s.gamma(3.0, 1.0)), "station");
        let aics: Vec<f64> = r.mle.iter().filter(|c| c.applicable).filter_map(|c| c.aic).collect();
        assert!(aics.windows(2).all(|w| w[0] <= w[1]), "{aics:?}");
        assert!(r.mle.iter().skip_while(|c| c.applicable).all(|c| !c.applicable), "what doesn't apply is last");
        for c in r.mle.iter().filter(|c| c.applicable) {
            close(c.aic.unwrap(), 2.0 * c.free_parameters as f64 - 2.0 * c.log_likelihood.unwrap(), 1e-9, "AIC");
            let p = c.ks_p.unwrap();
            assert!((0.0..=1.0).contains(&p) && c.ks.unwrap() > 0.0);
        }
        assert!(!r.reason.is_empty() && r.recommended.is_some());
    }

    #[test]
    fn a_data_file_is_read_as_text_and_a_binary_one_refused() {
        let dir = std::env::temp_dir().join(format!("qnet-fit-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("times.csv");
        std::fs::write(&ok, "t,service\n1,0.5\n2,0.7\n").unwrap();
        let f = read_data_file(&ok).unwrap();
        assert_eq!((f.name.as_str(), f.text.lines().count()), ("times.csv", 3));
        let bin = dir.join("times.xlsx");
        std::fs::write(&bin, [80u8, 75, 3, 4, 0, 0, 0, 1]).unwrap();
        assert!(read_data_file(&bin).unwrap_err().message.contains("not a text file"));
        assert_eq!(read_data_file(&dir.join("missing.txt")).unwrap_err().kind, crate::errors::ErrorKind::NotFound);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The browser preview answers `fit_distribution` from recorded answers
    /// (src/dev/mock/fit-fixtures.json), so it shows real numbers without a second copy of this
    /// arithmetic in TypeScript. This checks each recording is still what `fit` returns (numbers
    /// to 1e-9 relative: the two Macs' libm differ in the last digits). Re-record with
    /// `QNET_WRITE_FIT_FIXTURES=1 cargo test -p qnet fit::`.
    #[test]
    fn the_browser_previews_recorded_answers_are_what_fit_returns() {
        use serde_json::Value;
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/dev/mock/fit-fixtures.json");
        let text = std::fs::read_to_string(&path).expect("src/dev/mock/fit-fixtures.json");
        let mut file: Value = serde_json::from_str(&text).unwrap();
        let write = std::env::var_os("QNET_WRITE_FIT_FIXTURES").is_some();
        fn same(a: &Value, b: &Value, at: &str) {
            match (a, b) {
                (Value::Number(x), Value::Number(y)) => {
                    let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
                    assert!((x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1e-6), "{at}: {x} vs {y}");
                }
                (Value::Array(x), Value::Array(y)) => {
                    assert_eq!(x.len(), y.len(), "{at}");
                    x.iter().zip(y).enumerate().for_each(|(i, (p, q))| same(p, q, &format!("{at}[{i}]")));
                }
                (Value::Object(x), Value::Object(y)) => {
                    assert_eq!(x.keys().collect::<Vec<_>>(), y.keys().collect::<Vec<_>>(), "{at}");
                    x.iter().for_each(|(k, p)| same(p, &y[k], &format!("{at}.{k}")));
                }
                _ => assert_eq!(a, b, "{at}"),
            }
        }
        let cases = file["cases"].as_array_mut().expect("cases");
        assert!(cases.len() >= 2);
        for case in cases.iter_mut() {
            let data: Vec<f64> = case["data"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            let kind = case["kind"].as_str().unwrap().to_string();
            let got = serde_json::to_value(fit(&FitRequest { data, kind }).unwrap()).unwrap();
            if write {
                case["report"] = got;
            } else {
                same(&case["report"], &got, case["name"].as_str().unwrap());
            }
        }
        if write {
            std::fs::write(&path, serde_json::to_string(&file).unwrap() + "\n").unwrap();
        }
    }
}
