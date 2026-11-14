//! Uncertainty in the inputs (new in 2.1, ROADMAP D7): Results ▸ Uncertainty. "My arrival rate is
//! 0.8 give or take 10 %: how sure is the answer?" Two commands, all arithmetic in
//! `qnet_core::uncertainty`:
//!
//! - `uncertainty_analyze`: for an open Jackson network, the distribution of one measure when its
//!   arrival and service rates are uncertain. The inputs are sampled with a fixed seed and every
//!   draw is solved exactly in process (route 1: mean, median, 2.5 % and 97.5 % quantiles, the
//!   chance of overload, Sobol' variance shares, each with its Monte Carlo standard error), and
//!   beside it the delta method from the exact derivatives (route 2: a linear approximation and
//!   its variance shares), with how far the two are apart. Runs off the main thread and reports
//!   progress through the channel. Nothing is run and nothing is filed.
//! - `uncertainty_linear`: the delta method alone from derivatives the interface supplies — for a
//!   network with no closed form, whose derivatives are differences over quiet runs
//!   (src/sensitivity/runner.ts). The same function as route 2 above.
//!
//! A network with no closed form is answered `available: false` with the reason in a sentence.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;

use qnet_core::jackson::JacksonError;
use qnet_core::sensitivity::{Context, ParamSpec};
use qnet_core::uncertainty::{self as core, Input, Law, Options, Stat, DISAGREE, Z975};

use crate::errors::QnError;
use crate::sensitivity::{measure_of, spec_of, MeasureRequest, ParameterRequest};

/// The draws when the request names none.
pub const DEFAULT_SAMPLES: usize = 20_000;
pub const MIN_SAMPLES: usize = 1_000;
pub const MAX_SAMPLES: usize = 200_000;
/// The seed when the request names none: the same question gives the same answer.
pub const DEFAULT_SEED: u64 = 2_021;

/// How uncertain one input is. `kind`: "relativeSd" (± `value`, a fraction, read as a standard
/// deviation: lognormal), "relativeRange" (± `value` as a range: uniform), "interval95" ([`low`,
/// `high`] read as a 95 % interval: lognormal) or "intervalRange" (uniform on [`low`, `high`]).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadRequest {
    pub kind: String,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub low: Option<f64>,
    #[serde(default)]
    pub high: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    #[serde(flatten)]
    pub parameter: ParameterRequest,
    pub spread: SpreadRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UncertaintyRequest {
    pub document: Value,
    pub measure: MeasureRequest,
    /// The arrival and service rates that are uncertain.
    pub inputs: Vec<InputRequest>,
    /// Every uncertain arrival rate is driven by one draw (they rise and fall together).
    #[serde(default)]
    pub arrivals_together: bool,
    #[serde(default)]
    pub samples: Option<usize>,
    #[serde(default)]
    pub seed: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearInput {
    pub id: String,
    /// "arrival" or "service".
    pub kind: String,
    /// The parameter's value now, and the measure's derivative in it.
    pub current: f64,
    pub derivative: f64,
    pub spread: SpreadRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearRequest {
    /// The measure now.
    pub value: f64,
    pub inputs: Vec<LinearInput>,
    #[serde(default)]
    pub arrivals_together: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Estimate {
    pub value: f64,
    /// Its Monte Carlo standard error.
    pub se: f64,
}

impl From<Stat> for Estimate {
    fn from(s: Stat) -> Estimate {
        Estimate { value: s.value, se: s.se }
    }
}

/// One uncertain input as it was understood.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputRow {
    pub id: String,
    /// "lognormal", "uniform" or "fixed".
    pub law: &'static str,
    /// The law's mean, standard deviation and 2.5 % / 97.5 % quantiles.
    pub mean: f64,
    pub sd: f64,
    pub low: f64,
    pub high: f64,
    /// ∂(measure)/∂(this input) at the network as drawn.
    pub derivative: f64,
}

/// One independent source of uncertainty: an input, or the arrival rates moving together.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShareRow {
    pub ids: Vec<String>,
    /// Its share of the variance by the delta method.
    pub linear: f64,
    /// Sobol' first-order and total indices from the sample; none when not estimated.
    pub first: Option<Estimate>,
    pub total: Option<Estimate>,
}

/// Route 2: value ± 1.96·sd, by the delta method.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Linear {
    pub sd: f64,
    pub low: f64,
    pub high: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistogramOut {
    pub low: f64,
    pub high: f64,
    pub counts: Vec<usize>,
    pub above: usize,
}

/// Route 1: the sampled distribution, over the draws with a steady state.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sampling {
    pub samples: usize,
    pub seed: u64,
    pub unstable: usize,
    pub p_unstable: Estimate,
    /// False when the inputs' laws let a station the measure depends on reach overload
    /// (`core::mean_exists`): the mean over the stable cases is then infinite, and `mean`, `sd`
    /// and the sampled shares are null, whatever the sample looks like.
    pub mean_exists: bool,
    pub mean: Option<Estimate>,
    pub sd: Option<f64>,
    pub median: Option<Estimate>,
    pub q025: Option<Estimate>,
    pub q975: Option<Estimate>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub histogram: Option<HistogramOut>,
    /// The rows of the pick-freeze design behind the shares, and every exact solution taken.
    pub share_rows: usize,
    pub evaluations: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UncertaintyAnalysis {
    /// False when no closed form applies; `reason` ("network", "unstable", "notJackson") and `sentence` say why.
    pub available: bool,
    pub reason: Option<&'static str>,
    pub sentence: Option<String>,
    /// The measure at the network as drawn, and its unit.
    pub value: Option<f64>,
    pub unit: Option<&'static str>,
    pub inputs: Vec<InputRow>,
    pub shares: Vec<ShareRow>,
    pub linear: Option<Linear>,
    pub sampling: Option<Sampling>,
    /// How far the linear approximation is from the sample (`core::linear_disagreement`), and the
    /// amount beyond which the interface warns.
    pub disagreement: Option<f64>,
    pub threshold: f64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

fn law_of(spread: &SpreadRequest, current: f64) -> Result<Law, String> {
    let fraction = || spread.value.filter(|v| v.is_finite()).ok_or_else(|| "The uncertainty has no size.".to_string());
    let ends = || match (spread.low, spread.high) {
        (Some(a), Some(b)) => Ok((a, b)),
        _ => Err("The interval needs both of its ends.".to_string()),
    };
    match spread.kind.as_str() {
        "relativeSd" => Law::relative_sd(current, fraction()?),
        "relativeRange" => Law::relative_range(current, fraction()?),
        "interval95" => ends().and_then(|(a, b)| Law::interval95(a, b)),
        "intervalRange" => ends().and_then(|(a, b)| Law::interval_range(a, b)),
        other => Err(format!("There's no kind of uncertainty called “{other}”.")),
    }
}

fn law_name(law: &Law) -> &'static str {
    match law {
        Law::LogNormal { .. } => "lognormal",
        Law::Uniform { .. } => "uniform",
        Law::Fixed(_) => "fixed",
    }
}

/// The independent factors: each uncertain input by itself, or — moving together — every
/// uncertain arrival rate as one. Inputs known exactly are in none.
fn factors(laws: &[Law], is_arrival: &[bool], together: bool) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut arrivals: Option<usize> = None;
    for i in 0..laws.len() {
        if laws[i].is_fixed() {
            continue;
        }
        if together && is_arrival[i] {
            match arrivals {
                Some(g) => out[g].push(i),
                None => {
                    arrivals = Some(out.len());
                    out.push(vec![i]);
                }
            }
        } else {
            out.push(vec![i]);
        }
    }
    out
}

struct LinearPart {
    rows: Vec<InputRow>,
    shares: Vec<ShareRow>,
    linear: Linear,
}

/// Route 2 for both commands: the delta method from derivatives and laws.
fn linear_part(value: f64, ids: &[String], laws: &[Law], derivatives: &[f64], factors: &[Vec<usize>]) -> LinearPart {
    let sds: Vec<f64> = laws.iter().map(Law::sd).collect();
    let d = core::delta(derivatives, &sds, factors);
    let rows = (0..ids.len())
        .map(|i| {
            let (low, high) = laws[i].interval();
            InputRow { id: ids[i].clone(), law: law_name(&laws[i]), mean: laws[i].mean(), sd: sds[i], low, high, derivative: derivatives[i] }
        })
        .collect();
    let shares = factors.iter().zip(&d.shares).map(|(members, share)| ShareRow { ids: members.iter().map(|&i| ids[i].clone()).collect(), linear: *share, first: None, total: None }).collect();
    LinearPart { rows, shares, linear: Linear { sd: d.sd, low: value - Z975 * d.sd, high: value + Z975 * d.sd } }
}

const NOTHING_UNCERTAIN: &str = "Nothing is uncertain yet: give at least one rate an uncertainty above zero.";

/// The analysis of `req` (the command, as a plain function); `progress(done, total)` in exact solutions.
pub fn analyze(req: &UncertaintyRequest, progress: &mut dyn FnMut(usize, usize)) -> Result<UncertaintyAnalysis, QnError> {
    let text = serde_json::to_string(&req.document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = qnet_core::bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the network.").with_detail(e.to_string()))?;
    // A network drawn as a closed one is told so, by core's one rule, not "no source node".
    // (and one with priorities, batch arrivals or a rate profile by the other: `extended::classical_only`).
    if let Some((reason, sentence)) = qnet_core::extended::classical_only(&net, "Uncertainty analysis") {
        return Ok(UncertaintyAnalysis { available: false, reason: Some(reason), sentence: Some(sentence), threshold: DISAGREE, ..Default::default() });
    }
    let ctx = match Context::new(&net) {
        Ok(c) => c,
        Err(e) => {
            let reason = match e {
                JacksonError::Network(_) => "network",
                JacksonError::Unstable(..) => "unstable",
                JacksonError::NotJackson => "notJackson",
            };
            return Ok(UncertaintyAnalysis { available: false, reason: Some(reason), sentence: Some(e.message()), threshold: DISAGREE, ..Default::default() });
        }
    };
    let measure = measure_of(&ctx, &req.measure)?;
    let value = measure.value(&ctx.solution);
    let mut inputs = Vec::with_capacity(req.inputs.len());
    let mut ids = Vec::with_capacity(req.inputs.len());
    let mut is_arrival = Vec::with_capacity(req.inputs.len());
    for r in &req.inputs {
        let spec = spec_of(&r.parameter).map_err(QnError::invalid)?;
        if !matches!(spec, ParamSpec::Arrival { .. } | ParamSpec::Service { .. }) {
            return Err(QnError::invalid("Only arrival rates and service rates can be given an uncertainty."));
        }
        let family = ctx.family(&net, &spec).map_err(QnError::invalid)?;
        let law = law_of(&r.spread, family.current).map_err(QnError::invalid)?;
        is_arrival.push(matches!(spec, ParamSpec::Arrival { .. }));
        ids.push(r.parameter.id.clone());
        inputs.push(Input { family, law });
    }
    let laws: Vec<Law> = inputs.iter().map(|i| i.law).collect();
    let factors = factors(&laws, &is_arrival, req.arrivals_together);
    if factors.is_empty() {
        return Err(QnError::invalid(NOTHING_UNCERTAIN));
    }
    let derivatives = core::jackson_derivatives(&ctx.model, &ctx.solution, measure, &inputs);
    let LinearPart { rows, mut shares, linear } = linear_part(value, &ids, &laws, &derivatives, &factors);

    let samples = req.samples.unwrap_or(DEFAULT_SAMPLES).clamp(MIN_SAMPLES, MAX_SAMPLES);
    let seed = req.seed.unwrap_or(DEFAULT_SEED);
    // No mean, no variance to share out: the pick-freeze design is not run (the shares are the linear route's).
    let mean_exists = core::mean_exists(&ctx.model, measure, &inputs);
    let p = core::propagate_jackson(&ctx.model, measure, &inputs, &factors, &Options { samples, seed, sobol: mean_exists }, progress);
    if let Some(sobol) = &p.sobol {
        for (row, index) in shares.iter_mut().zip(&sobol.indices) {
            row.first = Some(index.first.into());
            row.total = Some(index.total.into());
        }
    }
    let s = p.summary.as_ref();
    // With no mean there is no sampled standard deviation to compare: the two intervals alone.
    let disagreement = s.map(|s| if mean_exists { core::linear_disagreement(value, linear.sd, s) } else { core::interval_disagreement(value, linear.sd, s) }).filter(|d| d.is_finite());
    let sampling = Sampling {
        samples,
        seed,
        unstable: p.unstable,
        p_unstable: p.p_unstable.into(),
        mean_exists,
        mean: s.filter(|_| mean_exists).map(|s| s.mean.into()),
        sd: s.filter(|_| mean_exists).map(|s| s.sd),
        median: s.map(|s| s.median.into()),
        q025: s.map(|s| s.q025.into()),
        q975: s.map(|s| s.q975.into()),
        min: s.map(|s| s.min),
        max: s.map(|s| s.max),
        histogram: s.map(|s| HistogramOut { low: s.histogram.lo, high: s.histogram.hi, counts: s.histogram.counts.clone(), above: s.histogram.above }),
        share_rows: p.sobol.as_ref().map_or(0, |s| s.rows),
        evaluations: samples + p.sobol.as_ref().map_or(0, |s| s.evaluations),
    };
    Ok(UncertaintyAnalysis { available: true, reason: None, sentence: None, value: Some(value), unit: Some(measure.unit()), inputs: rows, shares, linear: Some(linear), sampling: Some(sampling), disagreement, threshold: DISAGREE })
}

/// The delta method from supplied derivatives (the command, as a plain function).
pub fn linear(req: &LinearRequest) -> Result<UncertaintyAnalysis, QnError> {
    if !req.value.is_finite() {
        return Err(QnError::invalid("The measure has no value to put an uncertainty on."));
    }
    let mut laws = Vec::with_capacity(req.inputs.len());
    for r in &req.inputs {
        if !r.derivative.is_finite() {
            return Err(QnError::invalid("A derivative is missing."));
        }
        laws.push(law_of(&r.spread, r.current).map_err(QnError::invalid)?);
    }
    let ids: Vec<String> = req.inputs.iter().map(|r| r.id.clone()).collect();
    let is_arrival: Vec<bool> = req.inputs.iter().map(|r| r.kind == "arrival").collect();
    let derivatives: Vec<f64> = req.inputs.iter().map(|r| r.derivative).collect();
    let factors = factors(&laws, &is_arrival, req.arrivals_together);
    if factors.is_empty() {
        return Err(QnError::invalid(NOTHING_UNCERTAIN));
    }
    let LinearPart { rows, shares, linear } = linear_part(req.value, &ids, &laws, &derivatives, &factors);
    Ok(UncertaintyAnalysis { available: true, reason: None, sentence: None, value: Some(req.value), unit: None, inputs: rows, shares, linear: Some(linear), sampling: None, disagreement: None, threshold: DISAGREE })
}

/// Results ▸ Uncertainty for a Jackson network: sampling of the closed form, and the delta method beside it.
#[tauri::command(async)]
pub fn uncertainty_analyze(request: UncertaintyRequest, channel: Channel<Progress>) -> Result<UncertaintyAnalysis, QnError> {
    analyze(&request, &mut |done, total| {
        let _ = channel.send(Progress { done, total });
    })
}

/// Results ▸ Uncertainty for any other network: the delta method from numerical derivatives.
#[tauri::command(async)]
pub fn uncertainty_linear(request: LinearRequest) -> Result<UncertaintyAnalysis, QnError> {
    linear(&request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const SRC: &str = "1FB829CC-F9CC-4662-BA52-1408AE0849C2";
    const S1: &str = "1EA5D945-A8FE-4026-9B40-F78369F6FDDA";
    const S2: &str = "3A8845FE-6084-4B63-B474-2FE42F64FFED";

    fn example(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(format!("{name}.bnet"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn input(id: &str, kind: &str, node: &str, spread: Value) -> Value {
        serde_json::json!({ "id": id, "kind": kind, "nodeId": node, "spread": spread })
    }

    fn request(measure: &str, inputs: Vec<Value>, together: bool) -> UncertaintyRequest {
        serde_json::from_value(serde_json::json!({
            "document": example("OpenJackson.d2.feedback.p30.inf"),
            "measure": { "kind": measure },
            "inputs": inputs,
            "arrivalsTogether": together,
        }))
        .unwrap()
    }

    fn sd(value: f64) -> Value {
        serde_json::json!({ "kind": "relativeSd", "value": value })
    }

    /// A closed network is refused as one, in the closed-network sentence, never "The network has
    /// no source node." (core's one rule, `closed::drawn_as`); one that carries a population but
    /// has a source and a sink is the open network it is.
    #[test]
    fn a_closed_network_is_refused_in_its_own_sentence() {
        let mut req = request("networkNumber", vec![input("arrival", "arrival", SRC, sd(0.1))], false);
        req.document = example("closed/ClosedCentralServer.d3.N8");
        let a = analyze(&req, &mut |_, _| {}).unwrap();
        assert_eq!((a.available, a.reason), (false, Some("closed")));
        assert_eq!(a.sentence.as_deref(), Some("This is a closed network: a fixed number of customers circulates and nothing arrives from outside. Uncertainty analysis covers open networks."));
        req.document.as_object_mut().unwrap().remove("closedPopulation");
        let a = analyze(&req, &mut |_, _| {}).unwrap();
        assert_eq!(a.reason, Some("closedNoPopulation"));
        assert!(a.sentence.unwrap().starts_with("The network has no source and no sink, but no number of customers is set."));
        let mut req = request("networkNumber", vec![input("arrival", "arrival", SRC, sd(0.1))], false);
        req.document["closedPopulation"] = serde_json::json!(5);
        assert!(analyze(&req, &mut |_, _| {}).unwrap().available);
    }

    /// OpenJackson.d2.feedback.p30: ρ₁ = ρ₂ = 0.7, L = 2·(7/3) (see src-tauri/src/sensitivity.rs).
    /// L's elasticity in γ is 10/3 and in each μ −5/3, so with γ ± 3 % and each μ ± 3 % (standard
    /// deviations) the delta method gives sd L = L·0.03·√((10/3)² + 2·(5/3)²) and the shares
    /// (100/9) : (25/9) : (25/9) = ⅔ : ⅙ : ⅙. The sample (20 000 draws, seed fixed) must agree
    /// with the request's shape and with those shares within four of its own standard errors plus
    /// 3 % for the curvature the linear approximation leaves out (ρ = 0.7, 3 %: second order).
    /// The rates are uniform ranges of ±3 %·√3 (standard deviation 3 %), under which no station
    /// can reach overload (sup ρ = 0.7·1.052/0.948 < 1): the measure has a mean, and it is given.
    #[test]
    fn the_command_answers_the_jackson_example_in_the_shape_the_interface_reads() {
        let range = || serde_json::json!({ "kind": "relativeRange", "value": 0.03 * 3f64.sqrt() });
        let req = request("networkNumber", vec![input("arrival", "arrival", SRC, range()), input("service1", "service", S1, range()), input("service2", "service", S2, range())], false);
        let mut calls = Vec::new();
        let a = analyze(&req, &mut |d, t| calls.push((d, t))).unwrap();
        assert!(a.available);
        let l = 14.0 / 3.0;
        assert!((a.value.unwrap() - l).abs() < 1e-9);
        assert_eq!(a.unit, Some("customers"));
        let lin = a.linear.clone().unwrap();
        let sd_exact = l * 0.03 * ((10.0f64 / 3.0).powi(2) + 2.0 * (5.0f64 / 3.0).powi(2)).sqrt();
        assert!((lin.sd - sd_exact).abs() < 1e-9, "{} vs {sd_exact}", lin.sd);
        assert!((lin.low - (l - Z975 * sd_exact)).abs() < 1e-9 && (lin.high - (l + Z975 * sd_exact)).abs() < 1e-9);
        for (row, share) in a.shares.iter().zip([2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0]) {
            assert!((row.linear - share).abs() < 1e-9);
            let (first, total) = (row.first.unwrap(), row.total.unwrap());
            assert!((first.value - share).abs() < 0.03 + 4.0 * first.se, "{first:?} vs {share}");
            assert!(total.value + 4.0 * (total.se + first.se) > first.value);
        }
        assert_eq!(a.shares.iter().map(|s| s.ids.clone()).collect::<Vec<_>>(), [["arrival"], ["service1"], ["service2"]]);
        let s = a.sampling.clone().unwrap();
        assert_eq!((s.samples, s.seed, s.unstable, s.share_rows, s.evaluations), (DEFAULT_SAMPLES, DEFAULT_SEED, 0, 20_000, 20_000 * 5));
        // Jensen: the mean is above the nominal; the median is close to it; the interval brackets it.
        assert!(s.mean_exists);
        let (mean, median) = (s.mean.unwrap(), s.median.unwrap());
        assert!(mean.value > l && (median.value - l).abs() < 0.05 * l);
        assert!(s.q025.unwrap().value < l && l < s.q975.unwrap().value);
        assert!((s.sd.unwrap() / lin.sd - 1.0).abs() < 0.15);
        assert_eq!(s.histogram.as_ref().unwrap().counts.len(), 40);
        assert!(a.disagreement.unwrap() >= 0.0 && a.threshold == 0.10);
        assert_eq!(a.inputs[0].law, "uniform");
        assert!((a.inputs[0].mean - 1.0).abs() < 1e-12 && (a.inputs[0].sd - 0.03).abs() < 1e-12);
        assert_eq!(calls.last(), Some(&(100_000, 100_000)));
        // The same request again: the same numbers, to the last bit.
        assert_eq!(analyze(&req, &mut |_, _| {}).unwrap(), a);
        let json = serde_json::to_value(&a).unwrap();
        assert!(json["sampling"]["pUnstable"]["se"].is_number() && json["shares"][0]["first"]["value"].is_number() && json["sampling"]["shareRows"].is_number());
        assert_eq!(json["sampling"]["meanExists"], true);
    }

    /// The other branch: the same question with lognormal rates (± 3 % as standard deviations).
    /// A lognormal has density at every ρ, L grows like 1/(1 − ρ), so E[L | stable] is infinite
    /// although not one of the 20 000 draws overloads. No mean, standard deviation or sampled
    /// share is given as a number; the median, the interval and the chance of overload are, the
    /// shares are the linear route's, and the pick-freeze design is not run. A uniform range that
    /// reaches ρ = 1 is the same case; a utilisation, which is bounded, keeps its mean.
    #[test]
    fn no_mean_is_reported_where_the_laws_allow_overload() {
        let req = request("networkNumber", vec![input("arrival", "arrival", SRC, sd(0.03)), input("service1", "service", S1, sd(0.03)), input("service2", "service", S2, sd(0.03))], false);
        let a = analyze(&req, &mut |_, _| {}).unwrap();
        let s = a.sampling.clone().unwrap();
        assert_eq!((s.mean_exists, s.unstable, s.mean, s.sd), (false, 0, None, None));
        assert!(s.median.is_some() && s.q025.is_some() && s.q975.is_some() && s.histogram.is_some());
        assert_eq!((s.share_rows, s.evaluations), (0, DEFAULT_SAMPLES));
        for (row, share) in a.shares.iter().zip([2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0]) {
            assert!((row.linear - share).abs() < 1e-9);
            assert_eq!((row.first, row.total), (None, None));
        }
        // The two 95 % intervals are still compared (as fractions of the sampled interval's width).
        assert!(a.disagreement.unwrap() < 0.3, "{:?}", a.disagreement);
        let json = serde_json::to_value(&a).unwrap();
        assert_eq!(json["sampling"]["meanExists"], false);
        assert!(json["sampling"]["mean"].is_null() && json["sampling"]["sd"].is_null() && json["shares"][0]["first"].is_null());

        // A uniform arrival range up to 1.5: ρ = 0.7·1.5 > 1 at its upper end.
        let reach = request("networkSojourn", vec![input("arrival", "arrival", SRC, serde_json::json!({ "kind": "intervalRange", "low": 0.8, "high": 1.5 }))], false);
        let s = analyze(&reach, &mut |_, _| {}).unwrap().sampling.unwrap();
        assert!(!s.mean_exists && s.mean.is_none() && s.unstable > 0);
        // … and up to 1.4: ρ ≤ 0.98, a mean exists.
        let short = request("networkSojourn", vec![input("arrival", "arrival", SRC, serde_json::json!({ "kind": "intervalRange", "low": 0.8, "high": 1.4 }))], false);
        let s = analyze(&short, &mut |_, _| {}).unwrap().sampling.unwrap();
        assert!(s.mean_exists && s.mean.is_some() && s.sd.is_some() && s.unstable == 0);
        // A utilisation is at most 1 over the stable cases: its mean exists under any law.
        let mut bounded = request("stationUtilisation", vec![input("arrival", "arrival", SRC, sd(0.2))], false);
        bounded.measure.station_id = Some(S1.into());
        let s = analyze(&bounded, &mut |_, _| {}).unwrap().sampling.unwrap();
        assert!(s.mean_exists && s.mean.is_some());
    }

    /// Near saturation the answer changes character: with γ ± 20 % at ρ = 0.7 about 3 % of the
    /// cases overload (P(γ ≥ 1/0.7): the lognormal's own tail, checked here in closed form), and
    /// the linear approximation is flagged.
    #[test]
    fn a_wide_uncertainty_reports_the_chance_of_overload_and_flags_the_linear_route() {
        let req = request("networkSojourn", vec![input("arrival", "arrival", SRC, sd(0.2))], false);
        let a = analyze(&req, &mut |_, _| {}).unwrap();
        let s = a.sampling.clone().unwrap();
        let p = 1.0 - Law::relative_sd(1.0, 0.2).unwrap().cdf(1.0 / 0.7);
        assert!(p > 0.02 && p < 0.04, "{p}");
        assert!((s.p_unstable.value - p).abs() < 4.0 * (p * (1.0 - p) / 20_000.0f64).sqrt(), "{:?} vs {p}", s.p_unstable);
        assert!(a.disagreement.unwrap() > a.threshold);
        // One factor: all the variance is its.
        assert_eq!(a.shares.len(), 1);
        assert_eq!((a.shares[0].linear, a.shares[0].first), (1.0, None), "no mean, so no sampled share: the linear route's");
        assert!(!s.mean_exists && s.mean.is_none());
    }

    #[test]
    fn the_request_is_checked_and_a_network_with_no_closed_form_says_why() {
        let none = analyze(&request("networkNumber", vec![input("arrival", "arrival", SRC, sd(0.0))], false), &mut |_, _| {}).unwrap_err();
        assert_eq!(none.message, NOTHING_UNCERTAIN);
        let wide = analyze(&request("networkNumber", vec![input("arrival", "arrival", SRC, serde_json::json!({ "kind": "relativeRange", "value": 1.2 }))], false), &mut |_, _| {}).unwrap_err();
        assert!(wide.message.contains("±100 %"));
        let servers = analyze(&request("networkNumber", vec![input("servers", "servers", S1, sd(0.1))], false), &mut |_, _| {}).unwrap_err();
        assert_eq!(servers.message, "Only arrival rates and service rates can be given an uncertainty.");
        let mut req = request("networkNumber", vec![input("arrival", "arrival", SRC, sd(0.1))], false);
        req.document = example("MM1K.d1.c1.fin");
        let a = analyze(&req, &mut |_, _| {}).unwrap();
        assert_eq!((a.available, a.reason), (false, Some("notJackson")));
        assert!(a.sentence.unwrap().contains("not an open Jackson network"));
        // An interval read as a 95 % interval, and as a range.
        let mut req = request("networkNumber", vec![input("arrival", "arrival", SRC, serde_json::json!({ "kind": "interval95", "low": 0.9, "high": 1.1 })), input("service1", "service", S1, serde_json::json!({ "kind": "intervalRange", "low": 2.0, "high": 2.1 }))], false);
        req.samples = Some(1000);
        let a = analyze(&req, &mut |_, _| {}).unwrap();
        assert_eq!((a.inputs[0].law, a.inputs[1].law), ("lognormal", "uniform"));
        assert!((a.inputs[0].low - 0.9).abs() < 1e-12 && (a.inputs[0].high - 1.1).abs() < 1e-12);
        assert!((a.inputs[1].mean - 2.05).abs() < 1e-12);
        assert_eq!(a.sampling.unwrap().samples, 1000);
    }

    /// `uncertainty_linear` is route 2 again: given the exact derivatives it returns exactly what
    /// `uncertainty_analyze` gives as its linear part — also with the arrival rates together.
    #[test]
    fn the_linear_command_is_the_same_delta_method() {
        for together in [false, true] {
            let req = request("networkSojourn", vec![input("arrival", "arrival", SRC, sd(0.05)), input("service1", "service", S1, serde_json::json!({ "kind": "relativeRange", "value": 0.1 }))], together);
            let a = analyze(&req, &mut |_, _| {}).unwrap();
            let lin = linear(&LinearRequest {
                value: a.value.unwrap(),
                inputs: a.inputs.iter().zip(&req.inputs).map(|(row, r)| LinearInput { id: row.id.clone(), kind: r.parameter.kind.clone(), current: if row.id == "arrival" { 1.0 } else { 1.0 / 0.49 }, derivative: row.derivative, spread: r.spread.clone() }).collect(),
                arrivals_together: together,
            })
            .unwrap();
            let (x, y) = (lin.linear.unwrap(), a.linear.unwrap());
            assert!((x.sd - y.sd).abs() < 1e-12 * y.sd && (x.low - y.low).abs() < 1e-9);
            for (p, q) in lin.shares.iter().zip(&a.shares) {
                assert!((p.linear - q.linear).abs() < 1e-9 && p.ids == q.ids && p.first.is_none());
            }
            assert!(lin.sampling.is_none() && lin.disagreement.is_none());
        }
        assert!(linear(&LinearRequest { value: f64::NAN, inputs: vec![], arrivals_together: false }).is_err());
    }
}
