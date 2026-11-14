//! The nine distribution families: their parameters, moments, inversions and validation
//! (0.90.34 `Models.swift`, `QueueDistribution` and `DistributionParameterDef`).
//!
//! Parameters live in a node as text, "key=value,key=value". These functions read that text as
//! 0.90.34 read it: pairs split on "," and "=" with empty pieces dropped, a pair kept only when it
//! has exactly a key and a value, whitespace trimmed, the last of two equal keys winning.
//!
//! There are two readings of the same text in 0.90.34, and both are kept. The inspector's
//! (`mean`, `scv` here) gives None when a parameter is missing or out of range. The SRBM
//! pipeline's (`traffic::rate`, `traffic::scv`) fills a missing parameter with the family's
//! default instead. Which one a caller uses changes what the user sees, so neither is merged away.

use std::collections::BTreeMap;

use crate::cfmt;
use crate::model::Distribution;

/// Swift's `.whitespaces`: tab and the Unicode space separators (not line breaks).
pub(crate) fn is_swift_whitespace(c: char) -> bool {
    matches!(c, '\t' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}

/// "k=v,k=v" into text values (`parseParameterStrings`).
pub fn parse_parameter_strings(s: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for pair in s.split(',').filter(|p| !p.is_empty()) {
        let parts: Vec<&str> = pair.split('=').filter(|p| !p.is_empty()).collect();
        if parts.len() == 2 {
            out.insert(parts[0].trim_matches(is_swift_whitespace).to_string(), parts[1].trim_matches(is_swift_whitespace).to_string());
        }
    }
    out
}

/// Swift's `Double(String)`: decimal text, with "inf", "infinity" and "nan" in any case.
pub(crate) fn swift_double(s: &str) -> Option<f64> {
    s.parse::<f64>().ok()
}

/// "k=v,k=v" into numbers as the inspector reads them (`parseParameterStrings` then
/// `compactMapValues`): the last text written for a key wins, and is dropped if it isn't a number.
pub fn parse_params(s: &str) -> BTreeMap<String, f64> {
    parse_parameter_strings(s).into_iter().filter_map(|(k, v)| swift_double(&v).map(|x| (k, x))).collect()
}

/// "k=v,k=v" into numbers as the SRBM pipeline and the exporters read them (`SRBMExporter.parseParams`):
/// a value that isn't a number is skipped, so the last *number* written for a key wins
/// ("rate=2,rate=x" is rate 2 here, and no rate for the inspector).
pub fn parse_params_numeric_last(s: &str) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for pair in s.split(',').filter(|p| !p.is_empty()) {
        let parts: Vec<&str> = pair.split('=').filter(|p| !p.is_empty()).collect();
        if parts.len() == 2 {
            if let Some(v) = swift_double(parts[1].trim_matches(is_swift_whitespace)) {
                out.insert(parts[0].trim_matches(is_swift_whitespace).to_string(), v);
            }
        }
    }
    out
}

/// The words and formulas the inspector's distribution card and pickers show for a family
/// (0.90.34 `pickerName`, `formulaDescription`, `meanFormula`, `scvFormula`, `menuSubtitle`, `symbol`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    /// "Poisson process (Exp. inter-arrivals)" for Poisson, else the display name.
    pub picker_name: &'static str,
    pub formula: &'static str,
    pub mean_formula: &'static str,
    pub scv_formula: &'static str,
    /// The one-line SCV hint beside the name in picker menus.
    pub menu_subtitle: &'static str,
    /// 0.90.34's SF Symbol name; the interface maps it to a lucide icon (PLAN.md §4).
    pub symbol: &'static str,
}

pub fn card(d: Distribution) -> Card {
    use Distribution::*;
    let c = |picker_name, formula, mean_formula, scv_formula, menu_subtitle, symbol| Card { picker_name, formula, mean_formula, scv_formula, menu_subtitle, symbol };
    match d {
        Exponential => c("Exponential", "f(x) = λ e^(−λx),  x ≥ 0", "E[X] = 1/λ", "c² = 1", "c² = 1", "chart.line.downtrend.xyaxis"),
        Gamma => c("Gamma", "f(x) = x^(k−1) e^(−x/θ) / (Γ(k) θ^k),  x > 0", "E[X] = k·θ", "c² = 1/k", "c² = 1/k", "waveform.path"),
        Uniform => c("Uniform", "f(x) = 1 / (b − a),  a ≤ x ≤ b", "E[X] = (a + b)/2", "c² = (b − a)² / 3(a + b)²", "c² from (a, b)", "rectangle.fill"),
        Constant => c("Deterministic", "P(X = v) = 1  (no variability)", "E[X] = v", "c² = 0", "c² = 0", "minus"),
        Weibull => c("Weibull", "f(x) = (k/λ)(x/λ)^(k−1) e^(−(x/λ)^k),  x ≥ 0", "E[X] = λ·Γ(1 + 1/k)", "c² = Γ(1 + 2/k)/Γ(1 + 1/k)² − 1", "c² from k", "waveform.path.ecg"),
        Erlang => c("Erlang", "f(x) = μ^k x^(k−1) e^(−μx) / (k−1)!,  x ≥ 0", "E[X] = k/μ", "c² = 1/k", "c² = 1/k", "chart.bar.fill"),
        Lognormal => c("Lognormal", "f(x) = e^(−(ln x − μ)² / 2σ²) / (x σ √(2π)),  x > 0", "E[X] = e^(μ + σ²/2)", "c² = e^(σ²) − 1", "c² = e^σ² − 1", "chart.line.uptrend.xyaxis"),
        Pareto => c("Pareto", "f(x) = α xₘ^α / x^(α+1),  x ≥ xₘ", "E[X] = α·xₘ/(α − 1),  α > 1", "c² = 1/(α(α − 2)),  α > 2", "c² = 1/α(α−2)", "chart.line.flattrend.xyaxis"),
        Poisson => c("Poisson process (Exp. inter-arrivals)", "N(t) ~ Poisson(λt);  inter-arrivals ~ Exp(λ)", "E[X] = 1/λ  (inter-arrival)", "c² = 1", "c² = 1", "circle.grid.cross"),
    }
}

/// The families the inspector offers for a node kind: all nine for sources, all but Poisson for
/// stations (`cases(for:)`).
pub fn families_for(kind: crate::model::NodeKind) -> Vec<Distribution> {
    Distribution::ALL.into_iter().filter(|d| kind != crate::model::NodeKind::Station || d.is_available_for_stations()).collect()
}

/// Erlang's SCV can only be 1/k for whole k ≥ 1 (`hasDiscreteSCV`).
pub fn has_discrete_scv(d: Distribution) -> bool {
    d == Distribution::Erlang
}

/// One parameter of a family, as the inspector shows and checks it.
#[derive(Clone, Debug, PartialEq)]
pub struct ParamDef {
    pub key: &'static str,
    pub display_name: &'static str,
    pub default: f64,
    /// "time", "1/time", or none for a pure number.
    pub unit: Option<&'static str>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// The lower bound is strict.
    pub exclusive_min: bool,
    pub help: &'static str,
    pub integer: bool,
}

const fn def(key: &'static str, display_name: &'static str, default: f64, unit: Option<&'static str>, min: Option<f64>, exclusive_min: bool, help: &'static str) -> ParamDef {
    ParamDef { key, display_name, default, unit, min, max: None, exclusive_min, help, integer: false }
}

impl ParamDef {
    /// The message under the field, or None when the value is acceptable (`validate`).
    pub fn validate(&self, value: f64) -> Option<String> {
        if !value.is_finite() {
            return Some(format!("{} must be a finite number.", self.display_name));
        }
        if self.integer && value != value.round() {
            return Some(format!("{} must be a whole number.", self.display_name));
        }
        if let Some(min) = self.min {
            if self.exclusive_min && value <= min {
                return Some(format!("{} must be > {}.", self.display_name, format_readout(min)));
            }
            if !self.exclusive_min && value < min {
                return Some(format!("{} must be ≥ {}.", self.display_name, format_readout(min)));
            }
        }
        if let Some(max) = self.max {
            if value > max {
                return Some(format!("{} must be ≤ {}.", self.display_name, format_readout(max)));
            }
        }
        None
    }
}

/// A family's parameters, in field order (`parameterDefs`).
pub fn parameter_defs(d: Distribution) -> Vec<ParamDef> {
    use Distribution::*;
    const TIME: Option<&str> = Some("time");
    const RATE: Option<&str> = Some("1/time");
    match d {
        Exponential => vec![def("rate", "Rate (λ)", 1.0, RATE, Some(0.0), true, "Events per unit time; mean = 1/λ.")],
        Gamma => vec![
            def("shape", "Shape (k)", 2.0, None, Some(0.0), true, "k > 0. Larger k means less variability (c² = 1/k)."),
            def("scale", "Scale (θ)", 1.0, TIME, Some(0.0), true, "θ > 0. Mean = k·θ."),
        ],
        Uniform => vec![
            def("min", "Min (a)", 0.5, TIME, Some(0.0), false, "Lower bound, a ≥ 0 and a < b."),
            def("max", "Max (b)", 1.5, TIME, Some(0.0), true, "Upper bound, b > a."),
        ],
        Constant => vec![def("value", "Value (v)", 1.0, TIME, Some(0.0), true, "Deterministic duration, v > 0.")],
        Weibull => vec![
            def("shape", "Shape (k)", 1.5, None, Some(0.0), true, "k > 0. k = 1 is Exponential; k > 1 is less variable."),
            def("scale", "Scale (λ)", 1.0, TIME, Some(0.0), true, "λ > 0. Mean = λ·Γ(1 + 1/k)."),
        ],
        Erlang => vec![
            ParamDef { integer: true, ..def("k", "Stages (k)", 2.0, None, Some(1.0), false, "Whole number k ≥ 1; c² = 1/k.") },
            def("rate", "Rate (μ)", 1.0, RATE, Some(0.0), true, "Per-stage rate μ > 0; mean = k/μ."),
        ],
        Lognormal => vec![
            def("mu", "μ (log-mean)", 0.0, None, None, false, "Mean of ln X (any real number)."),
            def("sigma", "σ (log-sd)", 0.25, None, Some(0.0), true, "σ > 0. c² = e^σ² − 1."),
        ],
        // 0.90.34 said α > 1 here, but its cross-field rule refuses α ≤ 2, so a field showing no
        // error could still not be saved. The owner chose to fix that (PLAN.md §5, D5; ledger
        // DIST-025): the field states the rule that is enforced.
        Pareto => vec![
            def("shape", "Shape (α)", 2.5, None, Some(2.0), true, "α > 2: Qnet needs a finite variance (SCV), which a Pareto law has only for α > 2."),
            def("scale", "Scale (xₘ)", 1.0, TIME, Some(0.0), true, "Minimum value xₘ > 0."),
        ],
        Poisson => vec![def("lambda", "Rate (λ)", 1.0, RATE, Some(0.0), true, "Arrival rate; inter-arrivals are Exp(λ) with mean 1/λ.")],
    }
}

/// Per-field bounds plus the cross-field rules: Uniform needs max > min (checked only when the
/// fields are otherwise valid), Pareto needs α > 2 (`validateParameters`).
pub fn validate_parameters(d: Distribution, params: &BTreeMap<String, f64>) -> BTreeMap<String, String> {
    let mut errors = BTreeMap::new();
    for def in parameter_defs(d) {
        if let Some(msg) = params.get(def.key).and_then(|v| def.validate(*v)) {
            errors.insert(def.key.to_string(), msg);
        }
    }
    match d {
        Distribution::Uniform => {
            if let (true, Some(a), Some(b)) = (errors.is_empty(), params.get("min"), params.get("max")) {
                if b <= a {
                    errors.insert("max".into(), "Max must be greater than Min.".into());
                }
            }
        }
        Distribution::Pareto => {
            // With the field's own bound now α > 2 this can't fire on its own; it stays so the
            // rule is stated where 0.90.34 stated it.
            if let (false, Some(alpha)) = (errors.contains_key("shape"), params.get("shape")) {
                if *alpha <= 2.0 {
                    errors.insert("shape".into(), "Pareto SCV is finite only for α > 2.".into());
                }
            }
        }
        _ => {}
    }
    errors
}

/// The squared coefficient of variation, or None when the parameters don't give one (`computeSCV`).
pub fn scv(d: Distribution, p: &BTreeMap<String, f64>) -> Option<f64> {
    use Distribution::*;
    match d {
        Exponential => Some(1.0),
        Gamma => p.get("shape").filter(|s| **s > 0.0).map(|s| 1.0 / s),
        Uniform => {
            let (a, b) = (*p.get("min")?, *p.get("max")?);
            if a + b == 0.0 {
                return None;
            }
            let (diff, sum) = (b - a, a + b);
            Some((diff * diff) / (3.0 * sum * sum))
        }
        Constant => Some(0.0),
        Weibull => {
            let k = *p.get("shape").filter(|k| **k > 0.0)?;
            let g1 = cfmt::tgamma(1.0 + 1.0 / k);
            let g2 = cfmt::tgamma(1.0 + 2.0 / k);
            (g1 > 0.0).then(|| (g2 - g1 * g1) / (g1 * g1))
        }
        Erlang => p.get("k").filter(|k| **k > 0.0).map(|k| 1.0 / k),
        Lognormal => p.get("sigma").map(|s| (s * s).exp() - 1.0),
        Pareto => p.get("shape").filter(|a| **a > 2.0).map(|a| 1.0 / (a * (a - 2.0))),
        Poisson => p.get("lambda").filter(|l| **l > 0.0).map(|_| 1.0),
    }
}

/// The mean service or inter-arrival time, or None (`computeMean`). A Poisson source's mean is
/// 1/λ, its inter-arrival time.
pub fn mean(d: Distribution, p: &BTreeMap<String, f64>) -> Option<f64> {
    use Distribution::*;
    let get = |k: &str| p.get(k).copied();
    match d {
        Exponential => get("rate").filter(|r| *r > 0.0).map(|r| 1.0 / r),
        Gamma => match (get("shape"), get("scale")) {
            (Some(k), Some(t)) if k > 0.0 && t > 0.0 => Some(k * t),
            _ => None,
        },
        Uniform => Some((get("min")? + get("max")?) / 2.0),
        Constant => get("value"),
        Weibull => match (get("shape"), get("scale")) {
            (Some(k), Some(l)) if k > 0.0 && l > 0.0 => Some(l * cfmt::tgamma(1.0 + 1.0 / k)),
            _ => None,
        },
        Erlang => match (get("k"), get("rate")) {
            (Some(k), Some(r)) if k > 0.0 && r > 0.0 => Some(k / r),
            _ => None,
        },
        Lognormal => {
            let (mu, sigma) = (get("mu")?, get("sigma")?);
            Some((mu + sigma * sigma / 2.0).exp())
        }
        Pareto => match (get("shape"), get("scale")) {
            (Some(a), Some(xm)) if a > 1.0 && xm > 0.0 => Some(a * xm / (a - 1.0)),
            _ => None,
        },
        Poisson => get("lambda").filter(|l| *l > 0.0).map(|l| 1.0 / l),
    }
}

pub fn mean_from_text(d: Distribution, text: &str) -> Option<f64> {
    mean(d, &parse_params(text))
}

pub fn scv_from_text(d: Distribution, text: &str) -> Option<f64> {
    scv(d, &parse_params(text))
}

/// The SCV a family fixes, whatever its parameters: 1 for Exponential and Poisson, 0 for Constant.
pub fn fixed_scv(d: Distribution) -> Option<f64> {
    match d {
        Distribution::Exponential | Distribution::Poisson => Some(1.0),
        Distribution::Constant => Some(0.0),
        _ => None,
    }
}

/// Native parameters for a target mean and SCV, or None when the family can't have them
/// (`parametersFromMoments`). Families with a fixed SCV ignore the one asked for; Erlang rounds
/// 1/SCV to the nearest whole number of stages; Weibull's shape is found by 80 bisection steps.
pub fn parameters_from_moments(d: Distribution, mean: f64, scv: f64) -> Option<BTreeMap<String, f64>> {
    use Distribution::*;
    if !(mean > 0.0 && scv >= 0.0) {
        return None;
    }
    let m = |pairs: &[(&str, f64)]| Some(pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect());
    match d {
        Exponential => m(&[("rate", 1.0 / mean)]),
        Gamma => (scv > 0.0).then(|| m(&[("shape", 1.0 / scv), ("scale", mean * scv)])).flatten(),
        Uniform => {
            let h = mean * (3.0 * scv).sqrt();
            let (lo, hi) = (mean - h, mean + h);
            (lo >= 0.0).then(|| m(&[("min", lo), ("max", hi)])).flatten()
        }
        Constant => m(&[("value", mean)]),
        Weibull => {
            if scv <= 0.0 {
                return None;
            }
            let target = 1.0 + scv;
            let f = |k: f64| {
                let g1 = cfmt::tgamma(1.0 + 1.0 / k);
                let g2 = cfmt::tgamma(1.0 + 2.0 / k);
                g2 / (g1 * g1) - target
            };
            let mut lo = 0.05;
            let mut hi = 50.0;
            while f(hi) > 0.0 && hi < 1e4 {
                hi *= 2.0;
            }
            if !(f(lo) > 0.0 && f(hi) <= 0.0) {
                return None;
            }
            for _ in 0..80 {
                let mid = 0.5 * (lo + hi);
                if f(mid) > 0.0 {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            let k = 0.5 * (lo + hi);
            m(&[("shape", k), ("scale", mean / cfmt::tgamma(1.0 + 1.0 / k))])
        }
        Erlang => {
            if scv <= 0.0 {
                return None;
            }
            // Swift's .rounded() rounds half away from zero, as Rust's round does.
            let k = f64::max(1.0, (1.0 / scv).round());
            m(&[("k", k), ("rate", k / mean)])
        }
        Lognormal => {
            let s2 = (1.0 + scv).ln();
            m(&[("mu", mean.ln() - s2 / 2.0), ("sigma", s2.sqrt())])
        }
        Pareto => {
            if scv <= 0.0 {
                return None;
            }
            let alpha = 1.0 + (1.0 + 1.0 / scv).sqrt();
            (alpha > 2.0).then(|| m(&[("shape", alpha), ("scale", mean * (alpha - 1.0) / alpha)])).flatten()
        }
        Poisson => m(&[("lambda", 1.0 / mean)]),
    }
}

/// A derived number as the inspector shows it (0.90.34 `DS.Number.format`): up to six significant
/// digits, no trailing zeros, thousands grouped with commas (the en_US style 0.90.34 showed;
/// "—" for NaN and "∞" for an infinity). Rounding is of the exact binary value, as ICU rounds.
pub fn format_readout(v: f64) -> String {
    format_significant(v, 6)
}

pub fn format_significant(v: f64, digits: usize) -> String {
    if v.is_nan() {
        return "—".into();
    }
    if v.is_infinite() {
        return "∞".into();
    }
    if v == 0.0 {
        return "0".into();
    }
    let digits = digits.max(1);
    // printf's %e rounds the exact value to `digits` significant digits.
    let e = cfmt::f(&format!("%.{}e", digits - 1), v);
    let (mantissa, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let negative = mantissa.starts_with('-');
    let digits_only: String = mantissa.chars().filter(|c| c.is_ascii_digit()).collect();
    // Place the decimal point: value = 0.d1d2… × 10^(exp+1).
    let point = exp + 1;
    let (mut int_part, mut frac_part) = if point <= 0 {
        ("0".to_string(), format!("{}{}", "0".repeat((-point) as usize), digits_only))
    } else if point as usize >= digits_only.len() {
        (format!("{}{}", digits_only, "0".repeat(point as usize - digits_only.len())), String::new())
    } else {
        (digits_only[..point as usize].to_string(), digits_only[point as usize..].to_string())
    };
    while frac_part.ends_with('0') {
        frac_part.pop();
    }
    let mut grouped = String::new();
    for (i, c) in int_part.chars().enumerate() {
        if i > 0 && (int_part.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    int_part = grouped;
    let sign = if negative { "-" } else { "" };
    if frac_part.is_empty() {
        format!("{sign}{int_part}")
    } else {
        format!("{sign}{int_part}.{frac_part}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Distribution::*;

    fn p(pairs: &[(&str, f64)]) -> BTreeMap<String, f64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn parameter_text_is_read_as_0_90_34_read_it() {
        let m = parse_parameter_strings(" rate = 2.5 ,,k==3,x=1=2,=4,shape\t=1e-3,rate=7");
        assert_eq!(m.get("rate").map(String::as_str), Some("7"), "the last of two equal keys wins");
        assert_eq!(m.get("k").map(String::as_str), Some("3"), "empty pieces between = are dropped");
        assert!(!m.contains_key("x"), "three pieces is not a pair");
        assert_eq!(m.get("shape").map(String::as_str), Some("1e-3"));
        assert_eq!(parse_params("rate=abc,k=2"), p(&[("k", 2.0)]), "a value that isn't a number is left out");
        assert!(parse_params("rate=inf")["rate"].is_infinite(), "Swift's Double(\"inf\") is infinity");
    }

    #[test]
    fn moments_and_scvs_follow_each_familys_formula() {
        assert_eq!(mean(Exponential, &p(&[("rate", 4.0)])), Some(0.25));
        assert_eq!(mean(Poisson, &p(&[("lambda", 4.0)])), Some(0.25), "inter-arrival mean 1/λ");
        assert_eq!(scv(Poisson, &p(&[("lambda", 4.0)])), Some(1.0), "a Poisson process has SCV 1, not 1/λ");
        assert_eq!(mean(Gamma, &p(&[("shape", 2.0), ("scale", 3.0)])), Some(6.0));
        assert_eq!(scv(Uniform, &p(&[("min", 0.5), ("max", 1.5)])), Some(1.0 / 12.0));
        assert_eq!(scv(Uniform, &p(&[("min", -1.0), ("max", 1.0)])), None, "a + b = 0");
        assert_eq!(mean(Erlang, &p(&[("k", 2.0), ("rate", 1.0)])), Some(2.0));
        assert_eq!(scv(Pareto, &p(&[("shape", 2.0)])), None, "infinite variance at α ≤ 2");
        assert_eq!(mean(Pareto, &p(&[("shape", 1.5), ("scale", 1.0)])), Some(3.0));
        assert_eq!(mean(Exponential, &p(&[])), None, "the inspector's reading has no defaults");
        let w = scv(Weibull, &p(&[("shape", 1.0)])).unwrap();
        assert!((w - 1.0).abs() < 1e-12, "Weibull with k = 1 is Exponential");
    }

    #[test]
    fn moments_invert_back_to_themselves() {
        for d in [Exponential, Gamma, Uniform, Constant, Weibull, Lognormal, Pareto, Poisson] {
            let (m, c) = (2.0, 0.3);
            let params = parameters_from_moments(d, m, c).unwrap();
            assert!((mean(d, &params).unwrap() - m).abs() < 1e-9, "{d:?} mean");
            let want = fixed_scv(d).unwrap_or(c);
            assert!((scv(d, &params).unwrap() - want).abs() < 1e-9, "{d:?} scv");
        }
        assert_eq!(parameters_from_moments(Erlang, 2.0, 0.3), Some(p(&[("k", 3.0), ("rate", 1.5)])), "1/0.3 rounds to 3 stages");
        assert_eq!(parameters_from_moments(Uniform, 1.0, 1.0), None, "the lower bound would be negative");
        assert_eq!(parameters_from_moments(Gamma, 1.0, 0.0), None);
        assert_eq!(parameters_from_moments(Exponential, 0.0, 1.0), None);
    }

    #[test]
    fn validation_messages_name_the_field_and_its_bound() {
        let errs = validate_parameters(Gamma, &p(&[("shape", 0.0), ("scale", 1.0)]));
        assert_eq!(errs["shape"], "Shape (k) must be > 0.");
        let errs = validate_parameters(Erlang, &p(&[("k", 2.5), ("rate", 1.0)]));
        assert_eq!(errs["k"], "Stages (k) must be a whole number.");
        let errs = validate_parameters(Uniform, &p(&[("min", 2.0), ("max", 1.0)]));
        assert_eq!(errs["max"], "Max must be greater than Min.");
        let errs = validate_parameters(Uniform, &p(&[("min", -2.0), ("max", -3.0)]));
        assert_eq!(errs.keys().collect::<Vec<_>>(), ["max", "min"], "the cross-field rule waits for the fields to be valid");
        assert_eq!(validate_parameters(Exponential, &p(&[("rate", f64::NAN)]))["rate"], "Rate (λ) must be a finite number.");
    }

    /// 0.90.34 let α between 1 and 2 pass the field and then refused it on Save (ledger DIST-025);
    /// the owner chose to fix that (D5), so the field now says what Save enforces.
    #[test]
    fn the_pareto_shape_field_states_the_rule_save_enforces() {
        let errs = validate_parameters(Pareto, &p(&[("shape", 1.5), ("scale", 1.0)]));
        assert_eq!(errs["shape"], "Shape (α) must be > 2.");
        assert!(validate_parameters(Pareto, &p(&[("shape", 2.5), ("scale", 1.0)])).is_empty());
    }

    #[test]
    fn every_family_has_its_card_and_stations_are_never_offered_poisson() {
        for d in Distribution::ALL {
            let c = card(d);
            assert!(!c.formula.is_empty() && !c.mean_formula.is_empty() && !c.scv_formula.is_empty() && !c.symbol.is_empty(), "{d:?}");
            assert_eq!(parameter_defs(d).len(), parse_params(d.default_parameters()).len(), "{d:?}: the default text sets every field");
        }
        assert_eq!(card(Poisson).picker_name, "Poisson process (Exp. inter-arrivals)");
        assert_eq!(card(Constant).picker_name, "Deterministic");
        assert_eq!(families_for(crate::model::NodeKind::Station).len(), 8);
        assert_eq!(families_for(crate::model::NodeKind::Source).len(), 9);
    }

    /// Each pair is what 0.90.34's DS.Number.format showed (probe run on macOS 27.2, en_US).
    #[test]
    fn readouts_match_0_90_34s_six_significant_digits() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"), (1.0, "1"), (2.0, "2"), (0.5, "0.5"), (10000.0, "10,000"), (1000000.0, "1,000,000"), (1234567.0, "1,234,570"),
            (0.123456789, "0.123457"), (2.5000005, "2.5"), (1.0000005, "1"), (0.0000123, "0.0000123"), (12.34565, "12.3456"),
            (12.34575, "12.3458"), (999999.5, "1,000,000"), (1e-7, "0.0000001"), (1e12, "1,000,000,000,000"), (-3.5, "-3.5"),
            (1e21, "1,000,000,000,000,000,000,000"),
        ];
        for (v, want) in cases {
            assert_eq!(format_readout(*v), *want, "{v}");
        }
        assert_eq!(format_readout(f64::NAN), "—");
        assert_eq!(format_readout(f64::INFINITY), "∞");
    }
}
