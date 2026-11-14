//! The one rule about the model features that are new in 2.1 (ledger SCI-1001…): priority
//! service at a station, batch arrivals at a source, and a time-varying arrival rate at a source.
//!
//! Every method and analysis Qnet had before these features reads a network as first-come-first-
//! served stations fed by sources that emit single customers at a constant rate. Run on a network
//! that uses a new feature, such a method would silently compute the answer of a *different*
//! network. So each of them asks this file first ([`classical_only`]) and refuses with one plain
//! sentence; the methods that do model a feature (`priority.rs`, `batch.rs`, the simulator
//! `sim.rs` and `simstat.rs`, and `transient.rs` for rate profiles) say so themselves.
//!
//! The interface's copy of the rule is `src/extended/shape.ts`, checked against this one on the
//! cases of `src/extended/shape.fixtures.json` (shape.test.ts there, and
//! `the_interface_and_core_agree_on_the_new_features` in src-tauri/src/live.rs).
//!
//! **What counts as using a feature** is what the file says, never a judgement about values:
//! a station whose `serviceDiscipline` is a priority one; a source with a `batchSize`; a source
//! with a `rateProfile`. (A batch law that always gives one customer still counts: the file asks
//! for batches. The inspector removes the key when "one at a time" is chosen.)
//!
//! **Load.** The effective arrival rate of a batch source is (batch rate) × (mean batch size),
//! and the long-run rate of a periodic profile is its time-average. `traffic.rs` is 0.90.34's
//! arithmetic and is not touched: [`traffic_view`] hands it a copy of the network whose sources
//! carry the effective rate (every inter-arrival family is a scale family, so the law is the
//! same law on a faster clock), and [`traffic`] is `traffic::compute` on that copy. For a network
//! without the features the copy is the network itself.

use std::borrow::Cow;
use std::collections::BTreeMap;

use crate::closed;
use crate::dist;
use crate::model::{Discipline, Distribution, Network, Node, NodeKind};
use crate::traffic::{self, SrbmData, SrbmError};

/// A model feature new in 2.1. The raw values are the interface's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Feature {
    Priorities,
    BatchArrivals,
    TimeVaryingRates,
}

impl Feature {
    pub const ALL: [Feature; 3] = [Feature::Priorities, Feature::BatchArrivals, Feature::TimeVaryingRates];

    pub fn raw(self) -> &'static str {
        match self {
            Feature::Priorities => "priorities",
            Feature::BatchArrivals => "batchArrivals",
            Feature::TimeVaryingRates => "timeVaryingRates",
        }
    }

    /// The feature in a sentence, before "at <names>".
    fn phrase(self) -> &'static str {
        match self {
            Feature::Priorities => "priority service",
            Feature::BatchArrivals => "batch arrivals",
            Feature::TimeVaryingRates => "a time-varying arrival rate",
        }
    }
}

/// True when `node` uses `feature` (see the module text: what the file says).
pub fn node_uses(node: &Node, feature: Feature) -> bool {
    match feature {
        Feature::Priorities => node.kind == NodeKind::Station && node.discipline != Discipline::Fcfs,
        Feature::BatchArrivals => node.kind == NodeKind::Source && node.batch.is_some(),
        Feature::TimeVaryingRates => node.kind == NodeKind::Source && node.rate_profile.is_some(),
    }
}

/// The features `net` uses, each with the names of the nodes that use it, in document order.
pub fn features(net: &Network) -> Vec<(Feature, Vec<String>)> {
    Feature::ALL
        .into_iter()
        .filter_map(|f| {
            let names: Vec<String> = net.nodes.iter().filter(|n| node_uses(n, f)).map(|n| n.name.clone()).collect();
            (!names.is_empty()).then_some((f, names))
        })
        .collect()
}

pub fn uses(net: &Network, feature: Feature) -> bool {
    net.nodes.iter().any(|n| node_uses(n, feature))
}

pub fn uses_any(net: &Network) -> bool {
    Feature::ALL.into_iter().any(|f| uses(net, f))
}

/// The reason code the interface is given for a network that uses a new feature.
pub const REASON: &str = "extended";

/// What a method or analysis that reads a network the classical way says of a network that uses
/// a new feature, or None. `analysis` starts the second sentence ("Sensitivity analysis",
/// "Whitt QNA").
pub fn refusal(net: &Network, analysis: &str) -> Option<String> {
    refusal_except(net, analysis, &[])
}

/// [`refusal`] for an analysis that does model the features in `modelled`: only the others are named.
pub fn refusal_except(net: &Network, analysis: &str, modelled: &[Feature]) -> Option<String> {
    let used: Vec<(Feature, Vec<String>)> = features(net).into_iter().filter(|(f, _)| !modelled.contains(f)).collect();
    if used.is_empty() {
        return None;
    }
    let what: Vec<String> = used.iter().map(|(f, names)| format!("{} at {}", f.phrase(), names.join(", "))).collect();
    let advice = if used.iter().any(|(f, _)| *f == Feature::TimeVaryingRates) {
        "A network whose arrival rate changes in time has no single steady state: the Transient view computes how it moves, and Run ▸ Animate shows it."
    } else {
        "Replicated Simulation models it, and so does the exact single-station formula where it applies."
    };
    Some(format!("This network uses {}. {analysis} does not model that, and would answer for a different network. {advice}", what.join(" and ")))
}

/// [`closed::open_only`] and [`refusal`] in one question, for an analysis of classical open
/// networks: the reason code ("closed", "closedNoPopulation" or "extended") and the sentence.
pub fn classical_only(net: &Network, analysis: &str) -> Option<(&'static str, String)> {
    closed::open_only(net, analysis).or_else(|| refusal(net, analysis).map(|s| (REASON, s)))
}

// ── Load ────────────────────────────────────────────────────────────────────────────────────

/// The parameter text of the same family on a clock `factor` times faster: the law of X/factor,
/// whose rate is `factor` times the rate of X. Missing parameters are filled with the family's
/// defaults, as `traffic::rate` fills them. `factor` must be positive.
pub fn scale_rate(d: Distribution, parameters: &str, factor: f64) -> String {
    let mut p: BTreeMap<String, f64> = dist::parameter_defs(d).into_iter().map(|def| (def.key.to_string(), def.default)).collect();
    p.extend(dist::parse_params_numeric_last(parameters));
    let mut times = |key: &str, f: f64| {
        if let Some(v) = p.get_mut(key) {
            *v *= f;
        }
    };
    match d {
        Distribution::Exponential | Distribution::Erlang => times("rate", factor),
        Distribution::Poisson => times("lambda", factor),
        Distribution::Gamma | Distribution::Weibull | Distribution::Pareto => times("scale", 1.0 / factor),
        Distribution::Constant => times("value", 1.0 / factor),
        Distribution::Uniform => {
            times("min", 1.0 / factor);
            times("max", 1.0 / factor);
        }
        Distribution::Lognormal => {
            if let Some(v) = p.get_mut("mu") {
                *v -= factor.ln();
            }
        }
    }
    p.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",")
}

/// The factor by which a source's long-run customer rate exceeds what its inter-arrival law
/// alone gives: (mean batch size) × (the long-run mean of its rate profile). 1 for a plain
/// source, and for a law or profile that is not valid (Problems reports those).
pub fn rate_factor(source: &Node) -> f64 {
    if source.kind != NodeKind::Source {
        return 1.0;
    }
    let batch = source.batch.as_ref().filter(|b| b.problem().is_none()).map(|b| b.mean()).unwrap_or(1.0);
    let profile = source.rate_profile.as_ref().filter(|r| r.problem().is_none()).map(|r| r.long_run_mean()).unwrap_or(1.0);
    batch * profile
}

/// The largest factor a source's customer rate ever takes: (mean batch size) × (the profile's peak).
pub fn peak_factor(source: &Node) -> f64 {
    if source.kind != NodeKind::Source {
        return 1.0;
    }
    let batch = source.batch.as_ref().filter(|b| b.problem().is_none()).map(|b| b.mean()).unwrap_or(1.0);
    let profile = source.rate_profile.as_ref().filter(|r| r.problem().is_none()).map(|r| r.peak()).unwrap_or(1.0);
    batch * profile
}

fn scaled(net: &Network, factor: impl Fn(&Node) -> f64) -> Cow<'_, Network> {
    if !net.nodes.iter().any(|n| {
        let f = factor(n);
        f != 1.0 && f > 0.0 && f.is_finite()
    }) {
        return Cow::Borrowed(net);
    }
    let mut copy = net.clone();
    for n in copy.nodes.iter_mut() {
        let f = factor(n);
        if f != 1.0 && f > 0.0 && f.is_finite() {
            n.parameters = scale_rate(n.distribution, &n.parameters, f);
        }
    }
    Cow::Owned(copy)
}

/// The network as `traffic.rs` should read it: every source at its long-run customer rate
/// ([`rate_factor`]). The network itself when no source needs scaling.
pub fn traffic_view(net: &Network) -> Cow<'_, Network> {
    scaled(net, rate_factor)
}

/// The network with every source at its peak customer rate ([`peak_factor`]).
pub fn peak_view(net: &Network) -> Cow<'_, Network> {
    scaled(net, peak_factor)
}

/// `traffic::compute` at the long-run customer rates: what utilisation means for a network with
/// batch arrivals or a periodic rate profile. Identical to `traffic::compute` for any other network.
pub fn traffic(net: &Network, infinite: bool, loss: bool, bas: bool) -> Result<SrbmData, SrbmError> {
    let view = traffic_view(net);
    traffic::compute(&view.nodes, &view.links, infinite, loss, bas)
}

/// Why a solver input file is not written for a network that uses a new feature: every
/// exporter (core/src/export) writes first-come-first-served stations and plain sources, so the
/// file would describe a different network (review finding FIX-202). None for any other network.
pub fn export_refusal(net: &Network) -> Option<String> {
    refusal(net, "A solver input file")
}

// ── The reports of the station model ────────────────────────────────────────────────────────

/// What Analyze Network, Show Network Primitives and `dump-rho` work from (review finding
/// FIX-202: they read a batch, priority or profile network as a plain one).
#[derive(Clone, Debug)]
pub enum ReportModel {
    /// A network without the new features: `traffic::compute`'s own data, and the report 0.90.34 printed.
    Classical(SrbmData),
    /// A network that uses one: the report's SRBM and closed-form parts are for first-come-
    /// first-served stations and plain sources and would describe a different network, so
    /// `text` is printed in their place: `sentence` ([`refusal`]) and the station model at the
    /// sources' long-run customer rates (`data`, [`traffic`]), which does hold.
    Extended { data: SrbmData, sentence: String, text: String },
}

impl ReportModel {
    pub fn data(&self) -> &SrbmData {
        match self {
            ReportModel::Classical(data) | ReportModel::Extended { data, .. } => data,
        }
    }
}

/// The one gate of the three reports (the silent analysis's: [`traffic`] for the load,
/// [`refusal`] for what is classical only). `analysis` names the report in the sentence.
/// The error is the sentence to abort with: a setting that cannot be modelled ([`problems`]),
/// or the traffic equations' own refusal.
pub fn report_model(net: &Network, analysis: &str) -> Result<ReportModel, String> {
    let Some(sentence) = refusal(net, analysis) else {
        return traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).map(ReportModel::Classical).map_err(|e| e.message());
    };
    if let Some(p) = problems(net).into_iter().next() {
        return Err(p.message);
    }
    let data = traffic(net, net.infinite_buffers, false, false).map_err(|e| e.message())?;
    let mut text = format!("{sentence}\n\nWhat holds for this network is the station model below: arrival rates and utilisation from the traffic equations");
    text += if uses(net, Feature::BatchArrivals) || uses(net, Feature::TimeVaryingRates) { ", at the sources' long-run customer rates (batch rate × mean batch size; a rate profile's long-run average).\n\n" } else { ", which do not depend on the order of service.\n\n" };
    text += &crate::dump::station_model(net, &data);
    Ok(ReportModel::Extended { data, sentence, text })
}

// ── Live results and the Method Chooser ─────────────────────────────────────────────────────

/// The live results of a network that uses a new feature (`jackson::live` hands such a network
/// here). Utilisation is at the sources' long-run customer rates ([`traffic`]). The means are
/// given only where an exact formula covers the whole network — one priority station
/// (`priority.rs`) or one batch-arrival station (`batch.rs`) — and otherwise the reason is
/// [`Reason::NewFeature`](crate::jackson::Reason::NewFeature) with a sentence saying what applies.
pub fn live(net: &Network) -> crate::jackson::LiveResults {
    use crate::jackson::{LiveResults, NetworkLive, Reason, Tier};
    let none = |detail: String| LiveResults { tier: Tier::None, reason: Some(Reason::NoModel), detail, stations: Vec::new(), network: None, utilisation_exact: false, bottlenecks: Vec::new() };
    if let Some(p) = problems(net).into_iter().next() {
        return none(p.message);
    }
    let data = match traffic(net, net.infinite_buffers, false, false) {
        Ok(d) => d,
        Err(e) => return none(e.message()),
    };
    let mut out = crate::jackson::live_from_model(&data, &net.nodes, net.infinite_buffers);
    // Whatever closed form `jackson` found is for first-come-first-served stations and plain
    // sources: not this network's.
    let kept = out.reason.filter(|r| matches!(r, Reason::Unstable | Reason::FiniteBuffers));
    for s in out.stations.iter_mut() {
        (s.mean_in_system, s.mean_waiting, s.mean_sojourn, s.mean_wait) = (None, None, None, None);
    }
    out.tier = Tier::Utilisation;
    out.network = None;
    if kept.is_some() {
        out.reason = kept;
        return out;
    }
    let exact = if uses(net, Feature::TimeVaryingRates) {
        Err("The arrival rate changes in time, so there is no single steady state; the utilisation shown is at the long-run average rate. The Transient view computes how the mean numbers move.".to_string())
    } else if uses(net, Feature::Priorities) {
        crate::priority::from_network(net).and_then(|m| crate::priority::solve(&m)).map(|s| (s.number, s.queue, s.sojourn, s.wait, s.throughput))
    } else {
        crate::batch::from_network(net).and_then(|m| crate::batch::solve(&m)).map(|s| (s.number, s.queue, s.sojourn, s.wait, s.throughput))
    };
    match exact {
        Ok((number, queue, sojourn, wait, throughput)) if out.stations.len() == 1 => {
            let s = &mut out.stations[0];
            (s.mean_in_system, s.mean_waiting, s.mean_sojourn, s.mean_wait) = (Some(number), Some(queue), Some(sojourn), Some(wait));
            out.tier = Tier::Exact;
            out.reason = None;
            out.detail = String::new();
            out.network = Some(NetworkLive { throughput, mean_number: number, mean_delay: sojourn });
        }
        Ok(_) => {
            out.reason = Some(Reason::NewFeature);
            out.detail = String::new();
        }
        Err(sentence) => {
            out.reason = Some(Reason::NewFeature);
            out.detail = sentence;
        }
    }
    out
}

/// One exact single-station method of a new feature, as the Method Chooser lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct ExactMethod {
    /// The Chooser's row id and the run label.
    pub id: &'static str,
    pub label: &'static str,
    pub name: &'static str,
    /// What the row says when the method applies.
    pub ready: &'static str,
    /// Why it does not apply to this network, or None.
    pub refusal: Option<String>,
}

/// The Method Chooser's side of a network that uses a new feature.
#[derive(Clone, Debug, PartialEq)]
pub struct MethodsDomain {
    /// The features in use ([`Feature::raw`]).
    pub features: Vec<&'static str>,
    /// What every method that reads a network the classical way says of it.
    pub others: String,
    /// The exact methods of the features in use (none for a rate profile alone).
    pub exact: Vec<ExactMethod>,
}

pub const PRIORITY_READY: &str = "Exact for this station: the closed-form mean values of a priority queue with Poisson arrivals (Cobham's formula and its relatives), for the station and for each class.";
pub const BATCH_READY: &str = "Exact for this station: the mean-value formula of the single-server queue with batch Poisson arrivals (M^X/G/1).";

/// None for a network that uses no new feature.
pub fn methods_domain(net: &Network) -> Option<MethodsDomain> {
    let others = refusal(net, "This method")?;
    let mut exact = Vec::new();
    if uses(net, Feature::Priorities) {
        exact.push(ExactMethod { id: "priority-exact", label: "priority_exact", name: "Exact Priority Queue", ready: PRIORITY_READY, refusal: crate::priority::from_network(net).err() });
    }
    if uses(net, Feature::BatchArrivals) {
        exact.push(ExactMethod { id: "batch-exact", label: "batch_exact", name: "Exact Batch-Arrival Queue", ready: BATCH_READY, refusal: crate::batch::from_network(net).err() });
    }
    Some(MethodsDomain { features: features(net).into_iter().map(|(f, _)| f.raw()).collect(), others, exact })
}

// ── What is wrong with the settings ─────────────────────────────────────────────────────────

/// A setting of a new feature that cannot be modelled as written.
#[derive(Clone, Debug, PartialEq)]
pub struct Problem {
    pub node_id: String,
    /// "priorityOrder", "batchSize", "rateProfile", "priorityClosed" or "rateProfileSource".
    pub code: &'static str,
    /// A whole sentence naming the node.
    pub message: String,
}

/// Every such problem in `net`, in document order.
pub fn problems(net: &Network) -> Vec<Problem> {
    let mut out = Vec::new();
    let classes = crate::editor::number_of_classes(net).max(1);
    // Which classes reach each station, when the traffic equations can say.
    let stations = crate::naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
    let data = if closed::looks_closed(net) { None } else { traffic(net, true, false, false).ok() };
    for n in &net.nodes {
        if node_uses(n, Feature::Priorities) {
            let mut push = |message: String| out.push(Problem { node_id: n.id.clone(), code: "priorityOrder", message });
            if closed::looks_closed(net) {
                out.push(Problem { node_id: n.id.clone(), code: "priorityClosed", message: format!("{} has priority service, which Qnet models in open networks only: a closed network has one customer class. Set its discipline to first come, first served.", n.name) });
                continue;
            }
            let mut seen = Vec::new();
            let mut bad = false;
            for c in &n.priority_order {
                if *c < 0 || *c >= classes {
                    push(format!("{}'s priority order names {}, which is not a class of this network.", n.name, traffic::class_label(*c)));
                    bad = true;
                } else if seen.contains(c) {
                    push(format!("{}'s priority order names {} twice.", n.name, traffic::class_label(*c)));
                    bad = true;
                }
                seen.push(*c);
            }
            if bad {
                continue;
            }
            let i = stations.iter().position(|s| s.id == n.id);
            let missing: Vec<String> = match (&data, i) {
                (Some(d), Some(i)) if d.d == stations.len() => (0..d.k).filter(|&k| d.alpha_per_class[k][i] > 0.0 && !n.priority_order.contains(&(k as i64))).map(|k| traffic::class_label(k as i64)).collect(),
                _ => Vec::new(),
            };
            if !missing.is_empty() {
                push(format!("{}'s priority order is missing {}, which {} served there. Give every class served at the station a place in the order.", n.name, missing.join(", "), if missing.len() == 1 { "is" } else { "are" }));
            }
        }
        if node_uses(n, Feature::BatchArrivals) {
            if let Some(p) = n.batch.as_ref().and_then(|b| b.problem()) {
                out.push(Problem { node_id: n.id.clone(), code: "batchSize", message: format!("{}: {}", n.name, lower_first_kept(&p)) });
            }
        }
        if node_uses(n, Feature::TimeVaryingRates) {
            if let Some(p) = n.rate_profile.as_ref().and_then(|r| r.problem()) {
                out.push(Problem { node_id: n.id.clone(), code: "rateProfile", message: format!("{}: {}", n.name, lower_first_kept(&p)) });
            }
            if !matches!(n.distribution, Distribution::Poisson | Distribution::Exponential) {
                out.push(Problem { node_id: n.id.clone(), code: "rateProfileSource", message: format!("{} has a rate profile but is not a Poisson source. A time-varying rate is defined for Poisson arrivals (a non-homogeneous Poisson process); set the source's law to Poisson or remove the profile.", n.name) });
            }
        }
    }
    out
}

/// The sentence as it is (kept as a function so the "Name: sentence" form is made in one place).
fn lower_first_kept(s: &str) -> String {
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BatchSize, Link, RateProfile, RateSegment};

    fn node(kind: NodeKind, name: &str) -> Node {
        Node::new(name, kind, name, (0.0, 0.0))
    }

    fn link(from: &str, to: &str, class: i64) -> Link {
        Link { id: format!("{from}-{to}-{class}"), from: from.into(), to: to.into(), probability: 1.0, class, to_class: None }
    }

    /// Two Poisson sources (classes 0 and 1) into one station.
    fn two_class() -> Network {
        let mut a = node(NodeKind::Source, "Src1");
        a.distribution = Distribution::Poisson;
        a.parameters = "lambda=0.2".into();
        let mut b = node(NodeKind::Source, "Src2");
        b.distribution = Distribution::Poisson;
        b.parameters = "lambda=0.3".into();
        let nodes = vec![a, b, node(NodeKind::Buffer, "B1"), node(NodeKind::Station, "S1"), node(NodeKind::Sink, "Sink1")];
        let links = vec![link("Src1", "B1", 0), link("Src2", "B1", 1), link("B1", "S1", 0), link("S1", "Sink1", 0), link("S1", "Sink1", 1)];
        Network { nodes, links, infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
    }

    #[test]
    fn a_plain_network_uses_nothing_and_is_read_as_it_is() {
        let net = two_class();
        assert!(features(&net).is_empty() && !uses_any(&net));
        assert_eq!(refusal(&net, "Whitt QNA"), None);
        assert_eq!(classical_only(&net, "Whitt QNA"), None);
        assert!(matches!(traffic_view(&net), Cow::Borrowed(_)), "no copy, so no change, for every file 2.0 wrote");
        assert!(problems(&net).is_empty());
    }

    #[test]
    fn each_feature_is_named_with_its_nodes_in_one_sentence() {
        let mut net = two_class();
        net.nodes[3].discipline = Discipline::NonPreemptive;
        net.nodes[3].priority_order = vec![1, 0];
        assert_eq!(
            refusal(&net, "Whitt QNA").unwrap(),
            "This network uses priority service at S1. Whitt QNA does not model that, and would answer for a different network. Replicated Simulation models it, and so does the exact single-station formula where it applies."
        );
        net.nodes[0].batch = Some(BatchSize::Constant(2));
        net.nodes[1].rate_profile = Some(RateProfile { periodic: false, segments: vec![RateSegment { until: 5.0, multiplier: 2.0 }] });
        let s = refusal(&net, "Sensitivity analysis").unwrap();
        assert!(s.starts_with("This network uses priority service at S1 and batch arrivals at Src1 and a time-varying arrival rate at Src2. Sensitivity analysis does not model that"), "{s}");
        assert!(s.ends_with("the Transient view computes how it moves, and Run ▸ Animate shows it."), "{s}");
        assert_eq!(classical_only(&net, "x").unwrap().0, "extended");
        // A discipline on a buffer, or a batch law on a station, is not a use of the feature.
        let mut odd = two_class();
        odd.nodes[2].discipline = Discipline::NonPreemptive;
        odd.nodes[3].batch = Some(BatchSize::Constant(3));
        assert!(!uses_any(&odd));
    }

    /// Every family is a scale family: the scaled text has `factor` times the rate and the same SCV.
    #[test]
    fn scaling_a_law_multiplies_its_rate_and_keeps_its_shape() {
        for d in Distribution::ALL {
            for text in [d.default_parameters().to_string(), String::new()] {
                for f in [2.0, 0.37, 5.5] {
                    let scaled = scale_rate(d, &text, f);
                    let (r0, r1) = (traffic::rate(d, &text), traffic::rate(d, &scaled));
                    assert!((r1 - f * r0).abs() <= 1e-12 * r1.abs(), "{d:?} {text:?} ×{f}: {r0} → {r1}");
                    let (c0, c1) = (traffic::scv(d, &text), traffic::scv(d, &scaled));
                    assert!((c1 - c0).abs() <= 1e-12 * c0.abs().max(1.0), "{d:?}: SCV {c0} → {c1}");
                }
            }
        }
    }

    #[test]
    fn utilisation_counts_customers_not_batches_and_traffic_itself_is_untouched() {
        let mut net = two_class();
        net.nodes[3].parameters = "rate=2.0".into();
        let plain = traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
        assert!((plain.rho(0) - 0.25).abs() < 1e-15);
        net.nodes[0].batch = Some(BatchSize::Geometric { mean: 2.5 });
        net.nodes[1].rate_profile = Some(RateProfile { periodic: true, segments: vec![RateSegment { until: 1.0, multiplier: 3.0 }, RateSegment { until: 4.0, multiplier: 1.0 }] });
        // The long-run mean multiplier is (1·3 + 3·1)/4 = 1.5; the peak is 3.
        let unchanged = traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
        assert_eq!(unchanged.alpha, plain.alpha, "traffic.rs reads the inter-arrival law alone, as before");
        let eff = traffic(&net, true, false, false).unwrap();
        assert!((eff.alpha[0] - (0.2 * 2.5 + 0.3 * 1.5)).abs() < 1e-14, "{}", eff.alpha[0]);
        let view = peak_view(&net);
        let peak = traffic::compute(&view.nodes, &view.links, true, false, false).unwrap();
        assert!((peak.alpha[0] - (0.2 * 2.5 + 0.3 * 3.0)).abs() < 1e-14);
    }

    #[test]
    fn wrong_settings_are_named_in_sentences() {
        let mut net = two_class();
        net.nodes[3].discipline = Discipline::PreemptiveResume;
        net.nodes[3].priority_order = vec![1];
        let p = problems(&net);
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].code, p[0].message.as_str()), ("priorityOrder", "S1's priority order is missing Class 1, which is served there. Give every class served at the station a place in the order."));
        net.nodes[3].priority_order = vec![1, 1, 7];
        let codes: Vec<String> = problems(&net).into_iter().map(|p| p.message).collect();
        assert_eq!(codes, ["S1's priority order names Class 2 twice.", "S1's priority order names Class 8, which is not a class of this network."]);
        net.nodes[3].priority_order = vec![1, 0];
        assert!(problems(&net).is_empty());
        net.nodes[0].batch = Some(BatchSize::Pmf(vec![0.5, 0.2]));
        net.nodes[1].rate_profile = Some(RateProfile { periodic: false, segments: vec![RateSegment { until: 2.0, multiplier: 2.0 }, RateSegment { until: 2.0, multiplier: 1.0 }] });
        net.nodes[1].distribution = Distribution::Erlang;
        let p = problems(&net);
        assert_eq!(p.iter().map(|x| x.code).collect::<Vec<_>>(), ["batchSize", "rateProfile", "rateProfileSource"]);
        assert_eq!(p[0].message, "Src1: The batch-size probabilities sum to 0.7, not 1.");
        assert!(p[1].message.starts_with("Src2: Segment 2 of the rate profile has no length"), "{}", p[1].message);
    }

    #[test]
    fn a_profile_reads_its_multiplier_peak_mean_and_breakpoints() {
        let one_off = RateProfile { periodic: false, segments: vec![RateSegment { until: 2.0, multiplier: 0.5 }, RateSegment { until: 5.0, multiplier: 3.0 }] };
        assert_eq!([0.0, 1.999, 2.0, 4.9, 5.0, 99.0].map(|t| one_off.multiplier_at(t)), [0.5, 0.5, 3.0, 3.0, 1.0, 1.0]);
        assert_eq!((one_off.peak(), one_off.long_run_mean(), one_off.breakpoints(10.0)), (3.0, 1.0, vec![2.0, 5.0]));
        let daily = RateProfile { periodic: true, ..one_off.clone() };
        assert_eq!([0.0, 5.0, 6.5, 7.0, 12.5].map(|t| daily.multiplier_at(t)), [0.5, 0.5, 0.5, 3.0, 3.0]);
        assert!((daily.long_run_mean() - (2.0 * 0.5 + 3.0 * 3.0) / 5.0).abs() < 1e-15);
        assert_eq!(daily.breakpoints(12.0), vec![2.0, 5.0, 7.0, 10.0]);
        let low = RateProfile { periodic: false, segments: vec![RateSegment { until: 2.0, multiplier: 0.5 }] };
        assert_eq!(low.peak(), 1.0, "after a one-off profile the source's own rate is in force");
    }
}
