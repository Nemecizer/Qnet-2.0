//! Problems with a network as a typed list, for the canvas's badges and its Problems list (new in
//! 2.1, ROADMAP C4; ledger UX-301…). Nothing here is new arithmetic: the loads, the traffic
//! equations and their refusals are core's (`traffic::compute`, `traffic::rate`), the link rules
//! are `report::validate_link_structure`, and the stability rule is the one the runs use (an
//! infinite-buffer station at ρ ≥ 1 has no steady state; a finite one is blocked, not unstable).
//! What is added is only *where* each problem is (node and link ids) and the numbers a fix needs,
//! so the interface can show a problem on the node it belongs to and offer an edit that cures it.
//!
//! The sentences are the interface's (src/canvas/validation/words.ts), written for a student;
//! `Values::detail` carries core's own sentence for the refusals that have no code of their own.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;
use serde_json::Value;

use qnet_core::model::{Distribution, Link, Network, Node, NodeKind};
use qnet_core::traffic::{self, NetworkError, SrbmError};
use qnet_core::closed::{self, ClosedError};
use qnet_core::{bnet, naming, report};

use crate::errors::QnError;

/// The load a suggested fix aims for.
pub const TARGET_RHO: f64 = 0.8;
/// From this load up a stable station is "nearly unstable".
pub const NEAR_RHO: f64 = 0.95;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// A run would be refused, or its answer would mean nothing.
    Error,
    /// It runs, but probably not as intended.
    Warning,
    Info,
}

/// The names and numbers a diagnostic's sentence and its fixes use; only what applies is sent.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Values {
    /// The node the sentence is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A second node (a link's other end, the station a source can't reach).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other: Option<String>,
    /// ρ = λ / (c·μ).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rho: Option<f64>,
    /// λ: the work arriving per unit time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arrival_rate: Option<f64>,
    /// μ: what one server completes per unit time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub servers: Option<i64>,
    /// The fewest servers that bring ρ to `TARGET_RHO` or under.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_servers: Option<i64>,
    /// A service rate (two significant figures, rounded up) that brings ρ to about `TARGET_RHO`;
    /// only for a station with one exponential service law, where the rate is one parameter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_rate: Option<f64>,
    /// That rate as the station's parameter text ("rate=1.3").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_parameters: Option<String>,
    /// A customer class, counted from 0.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_index: Option<i64>,
    /// A routing row's sum.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sum: Option<f64>,
    /// For a routing row over 1: the probability each of `link_ids` gets when the row is scaled
    /// (same order), present only when the scaled network lets the class leave and is stable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_probabilities: Option<Vec<f64>>,
    /// With `suggested_probabilities`: what the station's own links into a sink keep (they are not
    /// changed), when it has any. For `routingSinkOverOne`: what the row's other links leave under
    /// 1, which is what leaves the network there whatever the sink links say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<f64>,
    /// A buffer's size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    /// Core's own sentence, for a refusal without a code of its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A closed network's population: the one set, or the one a fix would set (new in 2.1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub population: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: Severity,
    /// What is wrong (src/canvas/validation/model.ts `DiagnosticCode`).
    pub code: &'static str,
    /// The nodes it is shown on; the first is the one a fix edits. Empty for the whole network.
    pub node_ids: Vec<String>,
    /// The links it marks.
    pub link_ids: Vec<String>,
    pub values: Values,
}

fn diag(severity: Severity, code: &'static str, nodes: &[&Node], values: Values) -> Diagnostic {
    Diagnostic { severity, code, node_ids: nodes.iter().map(|n| n.id.clone()).collect(), link_ids: Vec::new(), values }
}

fn named(node: &Node) -> Values {
    Values { name: Some(node.name.clone()), ..Values::default() }
}

/// Every id reachable from `starts` along `next`.
fn reach<'a>(starts: impl Iterator<Item = &'a str>, next: &HashMap<&'a str, Vec<&'a str>>) -> HashSet<&'a str> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<&str> = starts.collect();
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id) {
            continue;
        }
        if let Some(out) = next.get(id) {
            queue.extend(out.iter().copied());
        }
    }
    seen
}

/// `v` rounded up to two significant figures, and written without float noise ("1.3", "25").
fn round_up_2(v: f64) -> Option<(f64, String)> {
    if !(v.is_finite() && v > 0.0) {
        return None;
    }
    let exp = v.log10().floor() as i32 - 1;
    let unit = 10f64.powi(exp);
    // A value already on two figures stays (1.25 / 0.05 is 25.000000000000004).
    let steps = (v / unit - 1e-9).ceil();
    let decimals = (-exp).max(0) as usize;
    let text = format!("{:.*}", decimals, steps * unit);
    let text = if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.').to_string() } else { text };
    let value: f64 = text.parse().ok()?;
    Some((value, text))
}

/// What a fix for a station at load `rho` needs: λ, μ, c, and the server count and service rate
/// that would bring it to about `TARGET_RHO`.
fn load_values(station: &Node, rho: f64, alpha: f64, mu: f64, servers: i64) -> Values {
    let mut v = named(station);
    v.rho = Some(rho);
    v.arrival_rate = Some(alpha);
    v.service_rate = Some(mu);
    v.servers = Some(servers);
    if mu > 0.0 && alpha.is_finite() {
        let need = (alpha / (TARGET_RHO * mu) - 1e-9).ceil();
        if need.is_finite() && need <= 10_000.0 && (need as i64) > servers {
            v.suggested_servers = Some(need as i64);
        }
    }
    if station.distribution == Distribution::Exponential && station.service_by_class.is_empty() && servers >= 1 {
        if let Some((rate, text)) = round_up_2(alpha / (servers as f64 * TARGET_RHO)) {
            if rate > mu {
                v.suggested_rate = Some(rate);
                v.suggested_parameters = Some(format!("rate={text}"));
            }
        }
    }
    v
}

/// A routing row over 1, scaled in proportion: `(link id, new probability)` for the station's links
/// of `class` that do not enter a sink, and what its links into a sink keep. The row is scaled to
/// 1 less that explicit exit (core's traffic equations take whatever a row leaves under 1 as
/// leaving the network; the regenerative and finite exporters count the sink links in the row), so
/// a station whose sink links already carry 1 or more has no scaling that is well defined: None.
/// Rounded down in the third place (the sixth when that would lose a link), so the numbers can be
/// said on a button and the row cannot sum past its target again.
fn scale_row(net: &Network, station: &Node, class: i64, sum: f64) -> Option<(Vec<(String, f64)>, Option<f64>)> {
    let kind = |id: &str| net.nodes.iter().rev().find(|n| n.id == id).map(|n| n.kind);
    let row: Vec<&Link> = net.links.iter().filter(|l| l.from == station.id && l.class == class && kind(&l.to).is_some()).collect();
    let (to_sink, onward): (Vec<&Link>, Vec<&Link>) = row.into_iter().partition(|l| kind(&l.to) == Some(NodeKind::Sink));
    let exit = to_sink.iter().map(|l| l.probability).filter(|p| *p > 0.0).fold(0.0, |a, b| a + b);
    if !(sum.is_finite() && sum > 1.0 && exit < 1.0) || onward.is_empty() || onward.iter().any(|l| !(l.probability.is_finite() && l.probability >= 0.0)) {
        return None;
    }
    let target = 1.0 - exit;
    for places in [1e3, 1e6] {
        let scaled: Vec<(String, f64)> = onward.iter().map(|l| (l.id.clone(), (l.probability * target / sum * places + 1e-6).floor() / places)).collect();
        if onward.iter().zip(&scaled).all(|(l, (_, p))| *p > 0.0 || l.probability == 0.0) {
            return Some((scaled, (exit > 0.0).then_some(exit)));
        }
    }
    None
}

/// `scale_row` for the row core refused, offered only when it cures the network: with it applied
/// (and any further row over 1 scaled the same way) the traffic equations must have a solution —
/// every class can leave — and no infinite-buffer station may be left with ρ ≥ 1. A fix must never
/// turn "adds up to more than 1" into "never leaves".
fn routing_suggestion(net: &Network, station: &Node, class: i64, sum: f64) -> Option<(Vec<(String, f64)>, Option<f64>)> {
    let first = scale_row(net, station, class, sum)?;
    let mut trial = net.clone();
    let mut next = first.0.clone();
    for _ in 0..=net.links.len() {
        for (id, p) in &next {
            for l in trial.links.iter_mut().filter(|l| &l.id == id) {
                l.probability = *p;
            }
        }
        match qnet_core::extended::traffic(&trial, trial.infinite_buffers, false, false) {
            Ok(data) => {
                let unstable = trial.infinite_buffers && (0..data.d).any(|i| !(data.rho(i) < 1.0));
                return (!unstable).then_some(first);
            }
            Err(SrbmError::Network(NetworkError::RoutingExceedsOne(name, s, c))) => {
                let other = trial.nodes.iter().find(|n| n.kind == NodeKind::Station && n.name == name)?.clone();
                next = scale_row(&trial, &other, c, s)?.0;
            }
            Err(_) => return None,
        }
    }
    None
}

/// A routing row that is within 1 for core's traffic equations (which do not read the number on a
/// link into a sink: whatever the other links leave under 1 leaves the network) but over 1 once
/// its sink links are counted, as the regenerative exporter (BNArmc, and BNApf and BNAqbd, which
/// start from its document) and the finite Markov exporter (fBNAgc, fBNAdecomp, BNAtc) count them
/// and refuse. Returns the row's sink links (positive ones, document order), the full sum, what
/// the other links leave, and — when it is well defined — what each sink link gets so the row
/// sums to 1 at most: the sink links share what is left in proportion, rounded down. That edit
/// changes nothing the traffic-equation methods compute.
struct SinkRow {
    link_ids: Vec<String>,
    sum: f64,
    left: f64,
    suggested: Option<Vec<f64>>,
}

fn sink_row(net: &Network, station: &Node, class: i64) -> Option<SinkRow> {
    let kind = |id: &str| net.nodes.iter().rev().find(|n| n.id == id).map(|n| n.kind);
    // The exporters' own sum: every link of the class out of the station, in document order.
    let row: Vec<&Link> = net.links.iter().filter(|l| l.from == station.id && l.class == class).collect();
    let sum = row.iter().fold(0.0, |a, l| a + l.probability);
    let to_sink: Vec<&Link> = row.iter().copied().filter(|l| kind(&l.to) == Some(NodeKind::Sink) && l.probability > 0.0).collect();
    let onward = row.iter().filter(|l| kind(&l.to) != Some(NodeKind::Sink)).fold(0.0, |a, l| a + l.probability);
    // 1e-12 is the regenerative exporter's tolerance (the finite Markov one allows 1e-9); a row
    // whose other links are over 1 on their own is `routingOverOne`, core's refusal.
    if to_sink.is_empty() || !sum.is_finite() || sum <= 1.0 + 1e-12 || onward > 1.0 + 1e-9 || row.iter().any(|l| l.probability < 0.0) {
        return None;
    }
    let left = (1.0 - onward).max(0.0);
    let exit = to_sink.iter().fold(0.0, |a, l| a + l.probability);
    let mut suggested = None;
    for places in [1e3, 1e6] {
        let ps: Vec<f64> = to_sink.iter().map(|l| (l.probability * left / exit * places + 1e-6).floor() / places).collect();
        let total = onward + ps.iter().fold(0.0, |a, p| a + p);
        if ps.iter().all(|p| *p > 0.0) && total <= 1.0 + 1e-12 {
            suggested = Some(ps);
            break;
        }
    }
    Some(SinkRow { link_ids: to_sink.iter().map(|l| l.id.clone()).collect(), sum, left, suggested })
}

fn positive(rate: f64) -> bool {
    rate.is_finite() && rate > 0.0
}

/// The population "Make this a closed network" starts with: two customers per station, so there
/// is some queueing to see. A starting point for the student to change, not a recommendation.
fn suggested_population(net: &Network) -> i64 {
    (2 * net.nodes.iter().filter(|n| n.kind == NodeKind::Station).count() as i64).max(2)
}

/// The problems of a closed network (new in 2.1; ledger SCI-507), from `closed::from_network`'s
/// refusal; and, for a network drawn without a source and a sink but with no population, the note
/// that offers to make it closed. A population on a network that has a source or a sink is flagged
/// as ignored. The structural problems every network shares (a station without its buffer, a bad
/// rate, no servers) are found node by node in `diagnose` and not repeated here.
fn closed_problems(net: &Network, out: &mut Vec<Diagnostic>) {
    use Severity::*;
    let network_wide = |severity, code, values| Diagnostic { severity, code, node_ids: Vec::new(), link_ids: Vec::new(), values };
    let stations = |names: &[String]| -> Vec<&Node> { names.iter().filter_map(|n| net.nodes.iter().find(|x| x.kind == NodeKind::Station && &x.name == n)).collect() };
    if !closed::looks_closed(net) {
        if net.population.is_some() && net.nodes.iter().any(|n| n.kind == NodeKind::Station) {
            out.push(network_wide(Warning, "populationIgnored", Values { population: net.population, ..Values::default() }));
        }
        return;
    }
    if net.population.is_none() {
        // Offered once the stations are joined at all: a lone station is a network being started.
        if closed::drawn_as(net) == closed::Drawn::ClosedNoPopulation {
            out.push(network_wide(Info, "closedCandidate", Values { population: Some(suggested_population(net)), ..Values::default() }));
        }
        return;
    }
    let Err(e) = closed::from_network(net) else { return };
    let detail = Some(e.message());
    match &e {
        // `diagnose` has found these on the node itself; NotClosed and NoStations cannot be here.
        ClosedError::StationMissingBuffer(_) | ClosedError::StationMultipleBuffers(_) | ClosedError::BadServiceRate(_) | ClosedError::NoServers(_) | ClosedError::NotClosed | ClosedError::NoStations | ClosedError::PopulationMissing => {}
        ClosedError::PopulationOutOfRange(n) => out.push(network_wide(Error, "closedPopulationRange", Values { population: Some(*n), detail, ..Values::default() })),
        ClosedError::MultiClass => out.push(network_wide(Error, "closedMultiClass", Values { detail, ..Values::default() })),
        ClosedError::NotExponential(names) => {
            for s in stations(names) {
                out.push(diag(Error, "closedNotExponential", &[s], named(s)));
            }
        }
        ClosedError::BufferTooSmall(name, capacity) => {
            let at = stations(std::slice::from_ref(name));
            out.push(diag(Error, "closedBufferTooSmall", &at, Values { name: Some(name.clone()), size: Some(*capacity), population: net.population, ..Values::default() }));
        }
        ClosedError::RoutingExceedsOne(name, sum) => {
            let at = stations(std::slice::from_ref(name));
            let mut d = diag(Error, "routingOverOne", &at, Values { name: Some(name.clone()), sum: Some(*sum), class_index: Some(0), ..Values::default() });
            if let Some(s) = at.first() {
                d.link_ids = net.links.iter().filter(|l| l.from == s.id).map(|l| l.id.clone()).collect();
            }
            out.push(d);
        }
        ClosedError::RoutingLeaks(name, sum) => {
            let at = stations(std::slice::from_ref(name));
            out.push(diag(Error, "closedRoutingLeaks", &at, Values { name: Some(name.clone()), sum: Some(*sum), ..Values::default() }));
        }
        ClosedError::Unreachable(names) => {
            for s in stations(names) {
                out.push(diag(Error, "closedUnreachable", &[s], named(s)));
            }
        }
        ClosedError::Reducible(names) => {
            let at = stations(names);
            out.push(diag(Error, "closedReducible", &at, Values { name: names.first().cloned(), other: names.get(1).cloned(), ..Values::default() }));
        }
    }
}

/// The diagnostics of `net`, errors first, each severity in document order.
pub fn diagnose(net: &Network) -> Vec<Diagnostic> {
    use Severity::*;
    if net.nodes.is_empty() {
        return vec![Diagnostic { severity: Info, code: "emptyNetwork", node_ids: Vec::new(), link_ids: Vec::new(), values: Values::default() }];
    }
    let infinite = net.infinite_buffers;
    let mut out: Vec<Diagnostic> = Vec::new();

    // As 0.90.34's dictionaries did, the last node of a repeated id is the one a link means.
    let by_id: HashMap<&str, &Node> = net.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let live: Vec<&Link> = net.links.iter().filter(|l| by_id.contains_key(l.from.as_str()) && by_id.contains_key(l.to.as_str())).collect();
    let mut forward: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut backward: HashMap<&str, Vec<&str>> = HashMap::new();
    for l in &live {
        forward.entry(l.from.as_str()).or_default().push(l.to.as_str());
        backward.entry(l.to.as_str()).or_default().push(l.from.as_str());
    }
    let of = |kind: NodeKind| net.nodes.iter().filter(move |n| n.kind == kind);
    let (has_source, has_station, has_sink) = (of(NodeKind::Source).next().is_some(), of(NodeKind::Station).next().is_some(), of(NodeKind::Sink).next().is_some());
    let fed = reach(of(NodeKind::Source).map(|n| n.id.as_str()), &forward);
    let drains = reach(of(NodeKind::Sink).map(|n| n.id.as_str()), &backward);

    // ── The network as a whole ──────────────────────────────────────────────────────────────
    // A closed network (new in 2.1, core `closed.rs`): no source, no sink and a population. It
    // lacks neither a source nor a sink; its own problems are found below (`closed_problems`).
    let is_closed = closed::is_closed(net);
    for (missing, code) in [(!has_source && !is_closed, "noSource"), (!has_station, "noStation"), (!has_sink && !is_closed, "noSink")] {
        if missing {
            out.push(Diagnostic { severity: Error, code, node_ids: Vec::new(), link_ids: Vec::new(), values: Values::default() });
        }
    }

    // ── Node by node ────────────────────────────────────────────────────────────────────────
    let mut no_arrivals: HashSet<&str> = HashSet::new();
    let mut bad_rate: HashSet<&str> = HashSet::new();
    let mut unconnected_source: HashSet<&str> = HashSet::new();
    for node in &net.nodes {
        let id = node.id.as_str();
        let outgoing = forward.get(id).map_or(0, Vec::len);
        let incoming = backward.get(id).map_or(0, Vec::len);
        match node.kind {
            NodeKind::Source => {
                if outgoing == 0 {
                    unconnected_source.insert(id);
                    out.push(diag(Error, "sourceUnconnected", &[node], named(node)));
                }
                if !positive(traffic::rate(node.distribution, &node.parameters)) {
                    bad_rate.insert(id);
                    out.push(diag(Error, "badArrivalRate", &[node], named(node)));
                }
            }
            NodeKind::Station => {
                let buffers = backward.get(id).map_or(0, |from| from.iter().filter(|f| by_id[**f].kind == NodeKind::Buffer).collect::<HashSet<_>>().len());
                if buffers == 0 {
                    out.push(diag(Error, "stationNeedsBuffer", &[node], named(node)));
                } else if buffers > 1 {
                    out.push(diag(Error, "stationManyBuffers", &[node], named(node)));
                }
                let own = positive(traffic::rate(node.distribution, &node.parameters));
                let per_class = node.service_by_class.values().all(|c| positive(traffic::rate(c.distribution, &c.parameters)));
                if !(own && per_class) {
                    bad_rate.insert(id);
                    let mut v = named(node);
                    // A class's own law is edited in the Inspector, not by resetting the station's.
                    v.class_index = if own { node.service_by_class.iter().find(|(_, c)| !positive(traffic::rate(c.distribution, &c.parameters))).map(|(k, _)| *k) } else { None };
                    out.push(diag(Error, "badServiceRate", &[node], v));
                }
                if node.servers < 1 {
                    let mut v = named(node);
                    v.servers = Some(node.servers);
                    out.push(diag(Error, "noServers", &[node], v));
                }
            }
            NodeKind::Buffer => {
                if !infinite && node.buffer_size < 1 {
                    let mut v = named(node);
                    v.size = Some(node.buffer_size);
                    out.push(diag(Warning, "bufferSizeZero", &[node], v));
                }
            }
            NodeKind::Sink => {
                if incoming == 0 {
                    out.push(diag(Info, "sinkUnused", &[node], named(node)));
                }
            }
        }
        if has_source && matches!(node.kind, NodeKind::Station | NodeKind::Buffer) && !fed.contains(id) {
            no_arrivals.insert(id);
            out.push(diag(Warning, "noArrivals", &[node], named(node)));
        }
        if has_sink && node.kind != NodeKind::Sink && !drains.contains(id) && !unconnected_source.contains(id) {
            out.push(diag(Warning, if outgoing == 0 { "noWayOut" } else { "noPathToSink" }, &[node], named(node)));
        }
    }

    // ── Link by link ────────────────────────────────────────────────────────────────────────
    for link in &live {
        let (from, to) = (by_id[link.from.as_str()], by_id[link.to.as_str()]);
        let both = || Values { name: Some(from.name.clone()), other: Some(to.name.clone()), ..Values::default() };
        // Core's rule decides; the kinds only choose the words.
        if !report::validate_link_structure(&net.nodes, std::slice::from_ref(*link), infinite).is_empty() {
            let code = if from.kind == NodeKind::Sink {
                "linkOutOfSink"
            } else if from.kind == NodeKind::Source {
                "sourceMustFeedBuffer"
            } else {
                "sinkFedByBuffer"
            };
            // A link out of a sink is ignored by every exporter (report.rs): it stops nothing.
            let mut d = diag(if code == "linkOutOfSink" { Warning } else { Error }, code, &[], both());
            d.link_ids.push(link.id.clone());
            out.push(d);
        } else if !(link.probability > 0.0) {
            let mut d = diag(Warning, "linkNeverUsed", &[], both());
            d.link_ids.push(link.id.clone());
            out.push(d);
        }
    }

    // ── Routing rows that only some exporters accept (`sink_row`) ───────────────────────────
    // A warning: the traffic-equation methods run (and ignore the sink link's number); the
    // regenerative simulation, product form, QBD and the finite Markov methods refuse.
    let max_class = net.links.iter().map(|l| l.class).max().unwrap_or(0);
    for station in of(NodeKind::Station) {
        for class in 0..=max_class {
            if let Some(row) = sink_row(net, station, class) {
                let mut d = diag(Warning, "routingSinkOverOne", &[station], Values { name: Some(station.name.clone()), sum: Some(row.sum), class_index: Some(class), exit: Some(row.left), suggested_probabilities: row.suggested, ..Values::default() });
                d.link_ids = row.link_ids;
                out.push(d);
            }
        }
    }

    // ── A source whose links sum above 1 (review finding FIX-201) ───────────────────────────
    // The traffic-equation methods read each link as that share of the source's rate, so the
    // source counts for more than its rate; a simulation has no one reading of it and refuses.
    for (id, name, sum) in qnet_core::sim::sources_over_one(net) {
        // A link from the source straight into a station is an error of its own
        // (`sourceMustFeedBuffer`); removing it is the fix, and the sum is said once it is gone.
        if net.links.iter().any(|l| l.from == id && net.node(&l.to).is_some_and(|t| t.kind != NodeKind::Buffer && t.kind != NodeKind::Sink)) {
            continue;
        }
        let source = net.nodes.iter().find(|n| n.id == id);
        let mut d = diag(Warning, "sourceOverOne", &source.into_iter().collect::<Vec<_>>(), Values { name: Some(name.clone()), sum: Some(sum), ..Values::default() });
        d.link_ids = net.links.iter().filter(|l| l.from == id).map(|l| l.id.clone()).collect();
        out.push(d);
    }

    // ── A closed network, or one that could be made closed ──────────────────────────────────
    closed_problems(net, &mut out);

    // ── Priorities, batch arrivals, rate profiles (new in 2.1): settings that cannot be modelled
    // as written, in core's own sentences (`extended::problems`) ─────────────────────────────
    for p in qnet_core::extended::problems(net) {
        let node = net.nodes.iter().find(|n| n.id == p.node_id);
        out.push(diag(Error, "featureSetting", &node.into_iter().collect::<Vec<_>>(), Values { name: node.map(|n| n.name.clone()), detail: Some(p.message), ..Values::default() }));
    }
    // A rate profile whose peak overloads a station that the long-run average does not: the
    // queue grows through the peak and drains after it. Worth knowing, not an error.
    if qnet_core::extended::uses(net, qnet_core::extended::Feature::TimeVaryingRates) && infinite {
        let peak = qnet_core::extended::peak_view(net);
        if let (Ok(at_peak), Ok(mean)) = (traffic::compute(&peak.nodes, &peak.links, infinite, false, false), qnet_core::extended::traffic(net, infinite, false, false)) {
            let ordered = naming::in_export_order(of(NodeKind::Station), |n| n.name.as_str());
            for (i, station) in ordered.iter().copied().enumerate().take(at_peak.d.min(mean.d)) {
                let (top, usual) = (at_peak.rho(i), mean.rho(i));
                if top.is_finite() && top >= 1.0 && usual < 1.0 {
                    let detail = format!("{} is overloaded while the arrival rate is at its peak (utilisation {} then, {} on average): its queue grows through the peak and drains afterwards. The Transient view shows by how much.", station.name, qnet_core::dist::format_significant(top, 3), qnet_core::dist::format_significant(usual, 3));
                    out.push(diag(Warning, "featurePeakOverload", &[station], Values { name: Some(station.name.clone()), rho: Some(top), detail: Some(detail), ..Values::default() }));
                }
            }
        }
    }

    // ── What the station model says: its refusal, or each station's load ────────────────────
    let stations = naming::in_export_order(of(NodeKind::Station), |n| n.name.as_str());
    let sources = naming::in_export_order(of(NodeKind::Source), |n| n.name.as_str());
    let station_named = |name: &str| stations.iter().copied().find(|s| s.name == name);
    // (At the sources' long-run customer rates: batch rate × mean batch size × a periodic
    // profile's average. `extended::traffic` is `traffic::compute` itself for any other network.)
    match qnet_core::extended::traffic(net, infinite, false, false) {
        Err(SrbmError::Network(e)) => match &e {
            // Found above, for every station at once.
            NetworkError::NoStations | NetworkError::NoSource | NetworkError::NoSink | NetworkError::StationMissingBuffer(_) | NetworkError::StationMultipleBuffers(_) => {}
            NetworkError::RoutingExceedsOne(name, sum, class) => {
                let station = station_named(name);
                let mut d = diag(Error, "routingOverOne", &station.into_iter().collect::<Vec<_>>(), Values { name: Some(name.clone()), sum: Some(*sum), class_index: Some(*class), ..Values::default() });
                if let Some(s) = station {
                    d.link_ids = live.iter().filter(|l| l.from == s.id && l.class == *class && by_id[l.to.as_str()].kind != NodeKind::Sink).map(|l| l.id.clone()).collect();
                    if let Some((scaled, exit)) = routing_suggestion(net, s, *class, *sum) {
                        // In `link_ids`' order, and only when every marked link has its number.
                        let ps: Vec<f64> = d.link_ids.iter().filter_map(|id| scaled.iter().find(|(i, _)| i == id).map(|(_, p)| *p)).collect();
                        if ps.len() == d.link_ids.len() {
                            d.values.suggested_probabilities = Some(ps);
                            d.values.exit = exit;
                        }
                    }
                }
                out.push(d);
            }
            NetworkError::TrafficSingular(name, class) => {
                // `population` is what "Make this a closed network" would set (the fix removes the
                // sources and sinks); offered for one class only, which is what `closed.rs` solves.
                let population = (net.links.iter().all(|l| l.class == 0 && !l.has_class_transition())).then(|| suggested_population(net));
                out.push(diag(Error, "closedLoop", &station_named(name).into_iter().collect::<Vec<_>>(), Values { name: Some(name.clone()), class_index: Some(*class), population, ..Values::default() }));
            }
            NetworkError::SourceNotConnectedToStation1 => {
                if let (Some(source), Some(station)) = (sources.first().copied(), stations.first().copied()) {
                    if !unconnected_source.contains(source.id.as_str()) {
                        out.push(diag(Error, "sourceCannotReachFirstStation", &[source, station], Values { name: Some(source.name.clone()), other: Some(station.name.clone()), ..Values::default() }));
                    }
                }
            }
            NetworkError::SourceUnresolvedEntry(name) => {
                let source = sources.iter().copied().find(|s| &s.name == name);
                if !source.is_some_and(|s| unconnected_source.contains(s.id.as_str())) {
                    out.push(diag(Error, "modelRefused", &source.into_iter().collect::<Vec<_>>(), Values { name: Some(name.clone()), detail: Some(e.message()), ..Values::default() }));
                }
            }
        },
        Err(e @ SrbmError::InfiniteMean(_)) | Err(e @ SrbmError::InfiniteVariance(_)) => {
            let (SrbmError::InfiniteMean(name) | SrbmError::InfiniteVariance(name)) = &e else { unreachable!() };
            let node = net.nodes.iter().find(|n| &n.name == name && matches!(n.kind, NodeKind::Source | NodeKind::Station));
            if !node.is_some_and(|n| bad_rate.contains(n.id.as_str())) {
                let (severity, code) = if matches!(e, SrbmError::InfiniteMean(_)) { (Error, "modelRefused") } else { (Warning, "infiniteVariance") };
                out.push(diag(severity, code, &node.into_iter().collect::<Vec<_>>(), Values { name: Some(name.clone()), detail: Some(e.message()), ..Values::default() }));
            }
        }
        Err(SrbmError::DegenerateCovariance) => {
            out.push(Diagnostic { severity: Info, code: "noRandomness", node_ids: Vec::new(), link_ids: Vec::new(), values: Values::default() });
        }
        Ok(data) => {
            for (i, station) in stations.iter().copied().enumerate().take(data.d) {
                let rho = data.rho(i);
                if !rho.is_finite() {
                    continue;
                }
                let values = || load_values(station, rho, data.alpha[i], data.service_rates[i], data.servers[i]);
                if rho >= 1.0 {
                    // The runs' rule (quiet_runs.rs): only an infinite-buffer network can be unstable.
                    // An error because no steady state exists, not because every run is refused:
                    // QNA, the orthant SRBM and the regenerative simulation refuse ρ ≥ 1, the
                    // other simulations run and never settle.
                    out.push(if infinite { diag(Error, "unstable", &[station], values()) } else { diag(Warning, "overloaded", &[station], values()) });
                } else if rho >= NEAR_RHO {
                    out.push(diag(Warning, "nearlyUnstable", &[station], values()));
                } else if rho <= 1e-9 && !no_arrivals.contains(station.id.as_str()) {
                    out.push(diag(Warning, "noArrivals", &[station], named(station)));
                }
            }
        }
    }

    out.sort_by_key(|d| d.severity);
    out
}

/// The diagnostics of a tab's document (the `.bnet` JSON object the interface holds). Off the main
/// thread: a 500-node network's traffic equations must not hold up the window.
#[tauri::command(async)]
pub fn network_diagnostics(document: Value) -> Result<Vec<Diagnostic>, QnError> {
    let text = serde_json::to_string(&document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't check this network: it isn't complete.").with_detail(e.to_string()))?;
    Ok(diagnose(&net))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn example(name: &str) -> Network {
        bnet::read(&std::fs::read_to_string(root().join("examples").join(format!("{name}.bnet"))).unwrap()).unwrap()
    }

    fn codes(ds: &[Diagnostic]) -> Vec<&'static str> {
        ds.iter().map(|d| d.code).collect()
    }

    fn node<'a>(net: &'a mut Network, name: &str) -> &'a mut Node {
        net.nodes.iter_mut().find(|n| n.name == name).unwrap_or_else(|| panic!("no node {name}"))
    }

    fn id(net: &Network, name: &str) -> String {
        net.nodes.iter().find(|n| n.name == name).unwrap().id.clone()
    }

    /// New in 2.1 (ledger SCI-1042): the bundled examples of priorities, batch arrivals and a
    /// rate profile have no problems; a wrong setting is an error on its node in core's own
    /// sentence; the load counts customers; and a peak that overloads is a warning.
    #[test]
    fn the_new_features_settings_are_checked_and_the_load_counts_customers() {
        use qnet_core::model::{BatchSize, RateSegment};
        for name in ["extended/PriorityHelpDesk.mg1.2class", "extended/BatchArrivals.mx-m-1.geometric", "extended/RushHour.mt-m-2.daily"] {
            assert_eq!(codes(&diagnose(&example(name))), Vec::<&str>::new(), "{name}");
        }
        let mut net = example("extended/PriorityHelpDesk.mg1.2class");
        node(&mut net, "S1").priority_order = vec![0];
        let ds = diagnose(&net);
        assert_eq!(codes(&ds), ["featureSetting"]);
        assert_eq!((ds[0].severity, ds[0].node_ids.clone()), (Severity::Error, vec![id(&net, "S1")]));
        assert_eq!(ds[0].values.detail.as_deref(), Some("S1's priority order is missing Class 2, which is served there. Give every class served at the station a place in the order."));

        // Batches of mean 2.5 at 0.24 per time unit load the unit-rate server to 0.6; of mean 4.5, to 1.08.
        let mut net = example("extended/BatchArrivals.mx-m-1.geometric");
        node(&mut net, "Src1").batch = Some(BatchSize::Geometric { mean: 4.5 });
        let ds = diagnose(&net);
        assert_eq!(codes(&ds), ["unstable"]);
        assert!((ds[0].values.rho.unwrap() - 1.08).abs() < 1e-12, "{:?}", ds[0].values.rho);
        node(&mut net, "Src1").batch = Some(BatchSize::Pmf(vec![0.5, 0.2]));
        let ds = diagnose(&net);
        assert_eq!(ds[0].values.detail.as_deref(), Some("Src1: The batch-size probabilities sum to 0.7, not 1."));

        // A peak of 1.9 × (1/1.6) overloads the two servers; the average does not.
        let mut net = example("extended/RushHour.mt-m-2.daily");
        node(&mut net, "Src1").rate_profile.as_mut().unwrap().segments[1].multiplier = 1.9;
        let ds = diagnose(&net);
        assert_eq!(codes(&ds), ["featurePeakOverload"]);
        assert_eq!(ds[0].severity, Severity::Warning);
        assert!(ds[0].values.detail.as_deref().unwrap().starts_with("S1 is overloaded while the arrival rate is at its peak (utilisation 1.19 then, 0.583 on average)"), "{:?}", ds[0].values.detail);
        node(&mut net, "Src1").rate_profile.as_mut().unwrap().segments[2] = RateSegment { until: 10.0, multiplier: 1.0 };
        assert!(diagnose(&net).iter().any(|d| d.code == "featureSetting" && d.values.detail.as_deref().unwrap().starts_with("Src1: Segment 3 of the rate profile has no length")));
    }

    fn only<'a>(ds: &'a [Diagnostic], code: &str) -> &'a Diagnostic {
        let found: Vec<&Diagnostic> = ds.iter().filter(|d| d.code == code).collect();
        assert_eq!(found.len(), 1, "{code} in {:?}", codes(ds));
        found[0]
    }

    /// Every shipped example is a network a run accepts: no errors. (Warnings are allowed: several
    /// examples are deliberately at or near ρ = 1.)
    #[test]
    fn no_shipped_example_has_an_error() {
        let mut names: Vec<String> = std::fs::read_dir(root().join("examples"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter_map(|f| f.strip_suffix(".bnet").map(str::to_string))
            .collect();
        names.sort();
        assert_eq!(names.len(), 50);
        for name in names {
            let ds = diagnose(&example(&name));
            let errors: Vec<&Diagnostic> = ds.iter().filter(|d| d.severity == Severity::Error).collect();
            assert!(errors.is_empty(), "{name}: {errors:?}");
            // No example's rows depend on which exporter reads them.
            assert!(!codes(&ds).contains(&"routingSinkOverOne"), "{name}");
            // Sorted, and every id is a node or link of the document.
            assert!(ds.windows(2).all(|w| w[0].severity <= w[1].severity), "{name}");
            let net = example(&name);
            for d in &ds {
                assert!(d.node_ids.iter().all(|i| net.node(i).is_some()), "{name}: {d:?}");
                assert!(d.link_ids.iter().all(|i| net.links.iter().any(|l| &l.id == i)), "{name}: {d:?}");
            }
        }
    }

    #[test]
    fn the_examples_warnings_are_the_expected_ones() {
        // A stable Jackson network at ρ = 0.7: nothing to say.
        assert_eq!(diagnose(&example("OpenJackson.d2.feedback.p50.inf")), vec![]);

        // Finite buffers at ρ = 1: blocked, not unstable, and both stations say so with what a fix needs.
        let net = example("2dtandem");
        let ds = diagnose(&net);
        assert_eq!(codes(&ds), vec!["overloaded", "overloaded"]);
        assert!(ds.iter().all(|d| d.severity == Severity::Warning));
        // S1 serves in a constant time, so only servers are suggested; S2 is exponential.
        let v = &ds[0].values;
        assert_eq!((v.name.as_deref(), v.suggested_servers, v.suggested_rate), (Some("S1"), Some(2), None));
        let v = &ds[1].values;
        assert_eq!((v.rho, v.arrival_rate, v.service_rate, v.servers), (Some(1.0), Some(1.0), Some(1.0), Some(1)));
        assert_eq!((v.suggested_servers, v.suggested_rate, v.suggested_parameters.as_deref()), (Some(2), Some(1.3), Some("rate=1.3")));
        let stations: Vec<&str> = ds.iter().map(|d| d.node_ids[0].as_str()).collect();
        assert!(stations.iter().all(|s| net.node(s).unwrap().kind == NodeKind::Station) && stations[0] != stations[1]);

        // A heavy-traffic example: stable, but close enough to 1 that a simulation is slow.
        let ds = diagnose(&example("GuangChenDaiGlynn25.sec3.1.2d.inf"));
        assert!(ds.iter().all(|d| d.severity != Severity::Error));
        for d in ds.iter().filter(|d| d.code == "nearlyUnstable") {
            let rho = d.values.rho.unwrap();
            assert!((NEAR_RHO..1.0).contains(&rho), "{rho}");
        }
    }

    #[test]
    fn an_overloaded_infinite_station_is_unstable_with_fixes_that_reach_the_target() {
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        // S1 carries α = 2 against μ = 2.857…; slow it to μ = 1.6, so ρ = 1.25.
        let s1 = node(&mut net, "S1");
        s1.parameters = "rate=1.6".into();
        let s1 = s1.id.clone();
        let ds = diagnose(&net);
        let d = only(&ds, "unstable");
        assert_eq!((d.severity, &d.node_ids), (Severity::Error, &vec![s1]));
        let v = &d.values;
        assert!((v.rho.unwrap() - 1.25).abs() < 1e-12, "{v:?}");
        assert_eq!((v.arrival_rate, v.service_rate, v.servers), (Some(2.0), Some(1.6), Some(1)));
        // Two servers: ρ = 0.625; rate 2.5: ρ = 0.8.
        assert_eq!((v.suggested_servers, v.suggested_rate, v.suggested_parameters.as_deref()), (Some(2), Some(2.5), Some("rate=2.5")));

        // Applying either suggestion clears it.
        let mut more = net.clone();
        node(&mut more, "S1").servers = 2;
        assert!(!codes(&diagnose(&more)).contains(&"unstable"));
        let mut faster = net.clone();
        node(&mut faster, "S1").parameters = "rate=2.5".into();
        assert_eq!(diagnose(&faster), vec![]);

        // Nearly unstable: ρ = 2 / 2.05.
        node(&mut net, "S1").parameters = "rate=2.05".into();
        let ds = diagnose(&net);
        let d = only(&ds, "nearlyUnstable");
        assert_eq!(d.severity, Severity::Warning);
        assert_eq!(d.values.suggested_rate, Some(2.5));

        // A station whose rate is not one parameter gets the server fix only.
        let mut gamma = example("OpenJackson.d2.feedback.p50.inf");
        let s = node(&mut gamma, "S1");
        s.distribution = Distribution::Gamma;
        s.parameters = "shape=2.0,scale=0.5".into();
        let ds = diagnose(&gamma);
        let v = &only(&ds, "unstable").values;
        assert_eq!((v.suggested_rate, v.suggested_servers), (None, Some(3)));
    }

    #[test]
    fn two_figures_round_up_without_float_noise() {
        assert_eq!(round_up_2(1.25).unwrap(), (1.3, "1.3".into()));
        assert_eq!(round_up_2(2.5).unwrap(), (2.5, "2.5".into()));
        assert_eq!(round_up_2(25.0).unwrap(), (25.0, "25".into()));
        assert_eq!(round_up_2(123.4).unwrap(), (130.0, "130".into()));
        assert_eq!(round_up_2(0.0123).unwrap(), (0.013, "0.013".into()));
        assert_eq!(round_up_2(0.0), None);
        assert_eq!(round_up_2(f64::NAN), None);
    }

    #[test]
    fn an_empty_canvas_is_information_and_a_half_built_network_names_what_is_missing() {
        let mut net = example("2dtandem");
        net.nodes.clear();
        net.links.clear();
        let ds = diagnose(&net);
        assert_eq!((codes(&ds), ds[0].severity), (vec!["emptyNetwork"], Severity::Info));

        // One source alone: nothing to serve it, nowhere to go, and it is connected to nothing.
        let mut net = example("2dtandem");
        net.nodes.retain(|n| n.kind == NodeKind::Source);
        net.links.clear();
        let ds = diagnose(&net);
        assert_eq!(codes(&ds), vec!["noStation", "noSink", "sourceUnconnected"]);
        assert!(ds.iter().all(|d| d.severity == Severity::Error));
        assert_eq!(ds[2].node_ids, vec![net.nodes[0].id.clone()]);

        let mut no_sink = example("2dtandem");
        no_sink.nodes.retain(|n| n.kind != NodeKind::Sink);
        assert_eq!(codes(&diagnose(&no_sink)), vec!["noSink"], "one message, not one per node that can't reach a sink");
    }

    #[test]
    fn structure_problems_are_found_on_the_node_they_belong_to() {
        // A station nothing reaches, with no buffer and no way out.
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        net.nodes.push(Node::new("11111111-1111-1111-1111-111111111111", NodeKind::Station, "S9", (0.0, 0.0)));
        let ds = diagnose(&net);
        assert_eq!(codes(&ds), vec!["stationNeedsBuffer", "noArrivals", "noWayOut"]);
        assert!(ds.iter().all(|d| d.node_ids == vec!["11111111-1111-1111-1111-111111111111".to_string()]));
        assert_eq!((ds[0].severity, ds[1].severity, ds[2].severity), (Severity::Error, Severity::Warning, Severity::Warning));

        // A sink nothing reaches is only information.
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        net.nodes.push(Node::new("22222222-2222-2222-2222-222222222222", NodeKind::Sink, "Sink9", (0.0, 0.0)));
        let ds = diagnose(&net);
        assert_eq!((codes(&ds), ds[0].severity), (vec!["sinkUnused"], Severity::Info));

        // A second buffer into one station.
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        let s1 = id(&net, "S1");
        net.nodes.push(Node::new("33333333-3333-3333-3333-333333333333", NodeKind::Buffer, "B9", (0.0, 0.0)));
        net.links.push(Link { id: "44444444-4444-4444-4444-444444444444".into(), from: "33333333-3333-3333-3333-333333333333".into(), to: s1.clone(), probability: 1.0, class: 0, to_class: None });
        let ds = diagnose(&net);
        assert_eq!(only(&ds, "stationManyBuffers").node_ids, vec![s1]);
        assert_eq!(only(&ds, "noArrivals").values.name.as_deref(), Some("B9"));
    }

    #[test]
    fn parameters_that_give_no_rate_are_errors_on_their_node() {
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        let source = net.nodes.iter_mut().find(|n| n.kind == NodeKind::Source).unwrap();
        source.parameters = "lambda=0".into();
        if source.distribution != Distribution::Poisson {
            source.parameters = "rate=0".into();
        }
        let source = source.id.clone();
        node(&mut net, "S2").parameters = "rate=-1".into();
        node(&mut net, "S1").servers = 0;
        let ds = diagnose(&net);
        assert_eq!(only(&ds, "badArrivalRate").node_ids, vec![source]);
        assert_eq!(only(&ds, "badServiceRate").values.name.as_deref(), Some("S2"));
        assert_eq!(only(&ds, "noServers").values.servers, Some(0));
        assert!(!codes(&ds).contains(&"modelRefused"), "core's refusal of the same rate is not said twice: {:?}", codes(&ds));

        // A finite buffer with no waiting room, which the editor never makes but a file can hold.
        let mut net = example("2dtandem");
        let b = net.nodes.iter_mut().find(|n| n.kind == NodeKind::Buffer).unwrap();
        b.buffer_size = 0;
        let ds = diagnose(&net);
        let d = only(&ds, "bufferSizeZero");
        assert_eq!((d.severity, d.values.size), (Severity::Warning, Some(0)));
        // …and it means nothing while buffers are infinite.
        net.infinite_buffers = true;
        assert!(!codes(&diagnose(&net)).contains(&"bufferSizeZero"));
    }

    #[test]
    fn routing_problems_mark_their_links() {
        // S1 → S2 at 0.5 and the feedback raised to 0.7: Class 1's row from S1 sums over 1.
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        let s1 = id(&net, "S1");
        let from_s1: Vec<String> = net.links.iter().filter(|l| l.from == s1 && net.node(&l.to).unwrap().kind != NodeKind::Sink).map(|l| l.id.clone()).collect();
        assert!(!from_s1.is_empty());
        for l in net.links.iter_mut().filter(|l| from_s1.contains(&l.id)) {
            l.probability = 1.5 / from_s1.len() as f64;
        }
        let ds = diagnose(&net);
        let d = only(&ds, "routingOverOne");
        assert_eq!((d.severity, &d.node_ids, &d.link_ids), (Severity::Error, &vec![s1], &from_s1));
        assert!((d.values.sum.unwrap() - 1.5).abs() < 1e-12);
        assert_eq!(d.values.class_index, Some(0));

        // Every job that reaches the loop stays in it: a class that never leaves.
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        let stations: Vec<String> = net.nodes.iter().filter(|n| n.kind == NodeKind::Station).map(|n| n.id.clone()).collect();
        let sinks: Vec<String> = net.nodes.iter().filter(|n| n.kind == NodeKind::Sink).map(|n| n.id.clone()).collect();
        net.links.retain(|l| !sinks.contains(&l.to));
        let (s1, s2) = (id(&net, "S1"), id(&net, "S2"));
        let b1 = net.links.iter().find(|l| l.to == s1 && net.node(&l.from).unwrap().kind == NodeKind::Buffer).unwrap().from.clone();
        net.links.push(Link { id: "66666666-6666-6666-6666-666666666666".into(), from: s2, to: b1, probability: 1.0, class: 0, to_class: None });
        let ds = diagnose(&net);
        let d = only(&ds, "closedLoop");
        assert_eq!((d.severity, d.values.class_index), (Severity::Error, Some(0)));
        assert!(stations.contains(&d.node_ids[0]));

        // A source straight into a station breaks core's link rule, and a link that carries nothing is noted.
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        let source = net.nodes.iter().find(|n| n.kind == NodeKind::Source).unwrap().id.clone();
        net.links.push(Link { id: "55555555-5555-5555-5555-555555555555".into(), from: source, to: id(&net, "S2"), probability: 1.0, class: 0, to_class: None });
        let unused = net.links.iter().find(|l| stations.contains(&l.from) && net.node(&l.to).unwrap().kind != NodeKind::Sink).unwrap().id.clone();
        net.links.iter_mut().find(|l| l.id == unused).unwrap().probability = 0.0;
        let ds = diagnose(&net);
        let d = only(&ds, "sourceMustFeedBuffer");
        assert_eq!((d.severity, &d.link_ids, d.values.other.as_deref()), (Severity::Error, &vec!["55555555-5555-5555-5555-555555555555".to_string()], Some("S2")));
        assert!(d.node_ids.is_empty());
        assert_eq!(only(&ds, "linkNeverUsed").link_ids, vec![unused]);
    }

    /// Review finding: scaling a row over 1 to exactly 1 left nothing for the sink. The numbers a
    /// fix applies are worked out here, and applying them leaves no error.
    #[test]
    fn a_routing_row_over_one_is_scaled_only_to_a_network_the_class_can_leave() {
        let apply = |net: &mut Network, d: &Diagnostic| {
            let ps = d.values.suggested_probabilities.clone().expect("a scaling is offered");
            assert_eq!(ps.len(), d.link_ids.len());
            for (id, p) in d.link_ids.iter().zip(ps) {
                net.links.iter_mut().find(|l| &l.id == id).unwrap().probability = p;
            }
        };
        let errors = |net: &Network| diagnose(net).into_iter().filter(|d| d.severity == Severity::Error).map(|d| d.code).collect::<Vec<_>>();
        // S1 sends 0.7 forward to S2 and 0.6 back to itself.
        let feedback = |net: &mut Network| {
            let (s1, s2) = (id(net, "S1"), id(net, "S2"));
            let b2 = net.links.iter().find(|l| l.to == s2).unwrap().from.clone();
            for l in net.links.iter_mut().filter(|l| l.from == s1) {
                l.probability = if l.to == b2 { 0.7 } else { 0.6 };
            }
        };

        // S2 leads to the sink, so S1's row may take everything: scaled to 1 in proportion.
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        feedback(&mut net);
        let ds = diagnose(&net);
        let d = only(&ds, "routingOverOne").clone();
        assert!((d.values.sum.unwrap() - 1.3).abs() < 1e-12);
        assert_eq!((d.values.suggested_probabilities.as_deref(), d.values.exit), (Some(&[0.538, 0.461][..]), None));
        apply(&mut net, &d);
        assert_eq!(errors(&net), Vec::<&str>::new());

        // S1's own link to the sink (0.6) is the only way out; S2 sends everything back.
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        feedback(&mut net);
        let (s1, s2, sink) = (id(&net, "S1"), id(&net, "S2"), id(&net, "Sink"));
        let b1 = net.links.iter().find(|l| l.to == s1 && l.from != s1 && net.node(&l.from).unwrap().kind == NodeKind::Buffer).unwrap().from.clone();
        net.links.iter_mut().find(|l| l.from == s2).unwrap().to = b1;
        net.links.push(Link { id: "77777777-7777-7777-7777-777777777777".into(), from: s1.clone(), to: sink, probability: 0.6, class: 0, to_class: None });
        let ds = diagnose(&net);
        let d = only(&ds, "routingOverOne").clone();
        assert!(!d.link_ids.contains(&"77777777-7777-7777-7777-777777777777".to_string()));
        // What "scale them to add up to 1" did: the class never leaves.
        let mut to_one = net.clone();
        for l in to_one.links.iter_mut().filter(|l| d.link_ids.contains(&l.id)) {
            l.probability /= 1.3;
        }
        assert_eq!(errors(&to_one), vec!["closedLoop"]);
        // The row is scaled to the 0.4 the sink link leaves, and nothing is wrong afterwards.
        assert_eq!((d.values.suggested_probabilities.as_deref(), d.values.exit), (Some(&[0.215, 0.184][..]), Some(0.6)));
        apply(&mut net, &d);
        assert_eq!(errors(&net), Vec::<&str>::new());

        // The sink link at its default 1 leaves the row nothing: no scaling is well defined.
        let mut full = to_one.clone();
        feedback(&mut full);
        full.links.iter_mut().find(|l| l.id.starts_with("7777")).unwrap().probability = 1.0;
        let ds = diagnose(&full);
        assert_eq!((only(&ds, "routingOverOne").values.suggested_probabilities.as_ref(), only(&ds, "routingOverOne").values.exit), (None, None));
        // No way out at all: scaling to 1 would only close the loop, so it is not offered.
        full.links.retain(|l| !l.id.starts_with("7777"));
        assert_eq!(only(&diagnose(&full), "routingOverOne").values.suggested_probabilities, None);
        // A scaling that would leave a station overloaded is not offered either.
        let mut slow = example("OpenJackson.d2.feedback.p50.inf");
        feedback(&mut slow);
        node(&mut slow, "S1").parameters = "rate=1.5".into();
        assert_eq!(only(&diagnose(&slow), "routingOverOne").values.suggested_probabilities, None);
    }

    /// Review finding FIX-201: a source whose links sum above 1 counts for more than its rate
    /// in the traffic equations, and the simulator refuses it; the canvas says so.
    #[test]
    fn a_source_whose_links_sum_above_one_is_flagged() {
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        assert!(!codes(&diagnose(&net)).contains(&"sourceOverOne"));
        let source = net.nodes.iter().find(|n| n.kind == NodeKind::Source).unwrap().id.clone();
        let s2 = id(&net, "S2");
        let b2 = net.links.iter().find(|l| l.to == s2 && net.node(&l.from).unwrap().kind == NodeKind::Buffer).unwrap().from.clone();
        net.links.push(Link { id: "88888888-8888-8888-8888-888888888888".into(), from: source.clone(), to: b2, probability: 0.3, class: 0, to_class: None });
        let ds = diagnose(&net);
        let d = only(&ds, "sourceOverOne");
        assert_eq!((d.severity, &d.node_ids, d.link_ids.len()), (Severity::Warning, &vec![source], 2));
        assert!((d.values.sum.unwrap() - 1.3).abs() < 1e-12);
        let refusal = qnet_core::sim::Simulator::new(&net, 1).err().unwrap();
        assert_eq!(refusal.code, "sourceOverOne");
        // At 1 in all, nothing is said and the simulator takes it.
        net.links.iter_mut().find(|l| l.id.starts_with("8888")).unwrap().probability = 0.0;
        assert!(!codes(&diagnose(&net)).contains(&"sourceOverOne"));
        // A link straight into a station is its own error; the sum is not said beside it.
        let link = net.links.iter_mut().find(|l| l.id.starts_with("8888")).unwrap();
        link.to = s2;
        link.probability = 1.0;
        let ds = diagnose(&net);
        assert!(codes(&ds).contains(&"sourceMustFeedBuffer") && !codes(&ds).contains(&"sourceOverOne"), "{:?}", codes(&ds));
    }

    /// Gap FIX-101: 0.7 into a sink and 0.6 back to the buffer is a row of 1.3 for the regenerative
    /// and finite Markov exporters, which refuse it, and a row of 0.6 for the traffic equations.
    #[test]
    fn a_row_over_one_only_with_its_sink_link_is_a_warning_the_exporters_bear_out() {
        use qnet_core::export::{finite_markov, regenerative};
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        assert!(regenerative::export(&net, "x", &Default::default()).is_ok());
        let (s2, sink) = (id(&net, "S2"), id(&net, "Sink"));
        let b2 = net.links.iter().find(|l| l.to == s2 && net.node(&l.from).unwrap().kind == NodeKind::Buffer).unwrap().from.clone();
        let out = net.links.iter().find(|l| l.from == s2 && l.to == sink).unwrap().id.clone();
        net.links.iter_mut().find(|l| l.id == out).unwrap().probability = 0.7;
        net.links.push(Link { id: "99999999-9999-9999-9999-999999999999".into(), from: s2.clone(), to: b2.clone(), probability: 0.6, class: 0, to_class: None });
        node(&mut net, "S2").parameters = "rate=5.0".into();
        assert!(net.links.iter().any(|l| l.from == s2 && l.to == b2));
        // Core's traffic equations accept it, and the exporters that count the sink link refuse.
        assert!(traffic::compute(&net.nodes, &net.links, true, false, false).is_ok());
        let refusal = regenerative::export(&net, "x", &Default::default()).unwrap_err().message();
        assert!(refusal.contains("1.3"), "{refusal}");
        let mut finite = net.clone();
        finite.infinite_buffers = false;
        assert!(finite_markov::generic_ctmc(&finite, "x", &Default::default()).unwrap_err().message().contains("1.3"));

        let ds = diagnose(&net);
        let d = only(&ds, "routingSinkOverOne").clone();
        assert_eq!((d.severity, &d.node_ids, &d.link_ids), (Severity::Warning, &vec![s2.clone()], &vec![out.clone()]));
        assert!((d.values.sum.unwrap() - 1.3).abs() < 1e-12);
        assert_eq!((d.values.class_index, d.values.exit, d.values.suggested_probabilities.as_deref()), (Some(0), Some(0.4), Some(&[0.4][..])));
        assert!(!codes(&ds).contains(&"routingOverOne"));

        // The fix is one edit; afterwards nothing is said, both exporters accept the network and
        // the station model has not moved.
        let before = traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
        net.links.iter_mut().find(|l| l.id == out).unwrap().probability = 0.4;
        assert!(!codes(&diagnose(&net)).contains(&"routingSinkOverOne"));
        assert!(diagnose(&net).iter().all(|d| d.severity != Severity::Error));
        assert!(regenerative::export(&net, "x", &Default::default()).is_ok());
        let after = traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
        assert_eq!(before.alpha, after.alpha);

        // The other links at exactly 1 leave the sink nothing: flagged, with no number to offer.
        net.links.iter_mut().find(|l| l.from == s2 && l.to == b2).unwrap().probability = 1.0;
        let ds = diagnose(&net);
        assert_eq!(only(&ds, "routingSinkOverOne").values.suggested_probabilities, None);
    }

    /// Review finding: a link out of a sink is ignored by every exporter, so it stops no run.
    #[test]
    fn a_link_out_of_a_sink_is_a_warning() {
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        let (sink, s1) = (id(&net, "Sink"), id(&net, "S1"));
        let b1 = net.links.iter().find(|l| l.to == s1 && net.node(&l.from).unwrap().kind == NodeKind::Buffer).unwrap().from.clone();
        net.links.push(Link { id: "88888888-8888-8888-8888-888888888888".into(), from: sink, to: b1, probability: 1.0, class: 0, to_class: None });
        let ds = diagnose(&net);
        let d = only(&ds, "linkOutOfSink");
        assert_eq!((d.severity, &d.link_ids), (Severity::Warning, &vec!["88888888-8888-8888-8888-888888888888".to_string()]));
        assert!(ds.iter().all(|d| d.severity != Severity::Error), "{:?}", codes(&ds));
    }

    #[test]
    fn the_command_reads_the_interfaces_json_and_writes_camel_case() {
        let text = std::fs::read_to_string(root().join("examples/2dtandem.bnet")).unwrap();
        let doc: Value = serde_json::from_str(&text).unwrap();
        let json = serde_json::to_value(network_diagnostics(doc).unwrap()).unwrap();
        assert_eq!(json[0]["severity"], "warning");
        assert_eq!(json[0]["code"], "overloaded");
        assert_eq!(json[1]["values"]["suggestedParameters"], "rate=1.3");
        assert_eq!(json[0]["values"]["arrivalRate"], 1.0);
        assert!(json[0]["values"].get("detail").is_none() && json[0]["linkIds"].as_array().unwrap().is_empty());
        assert!(json[0]["nodeIds"][0].is_string());
        assert!(network_diagnostics(serde_json::json!({"nodes": 3})).is_err());
    }

    /// A 500-node tandem (249 stations) is checked well inside the interface's debounce.
    #[test]
    fn a_five_hundred_node_network_is_checked_quickly() {
        let mut net = Network { nodes: Vec::new(), links: Vec::new(), infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None };
        let uuid = |n: usize| format!("00000000-0000-0000-0000-{n:012}");
        let link = |net: &mut Network, from: usize, to: usize| {
            let n = net.links.len();
            net.links.push(Link { id: format!("11111111-0000-0000-0000-{n:012}"), from: uuid(from), to: uuid(to), probability: 1.0, class: 0, to_class: None });
        };
        let mut src = Node::new(uuid(0), NodeKind::Source, "Src1", (0.0, 0.0));
        src.distribution = Distribution::Poisson;
        src.parameters = "lambda=1.0".into();
        net.nodes.push(src);
        for k in 0..249 {
            net.nodes.push(Node::new(uuid(1 + 2 * k), NodeKind::Buffer, format!("B{}", k + 1), (0.0, 0.0)));
            let mut s = Node::new(uuid(2 + 2 * k), NodeKind::Station, format!("S{}", k + 1), (0.0, 0.0));
            s.parameters = if k == 7 { "rate=0.9".into() } else { "rate=1.25".into() };
            net.nodes.push(s);
            link(&mut net, 2 * k, 1 + 2 * k);
            link(&mut net, 1 + 2 * k, 2 + 2 * k);
        }
        net.nodes.push(Node::new(uuid(499), NodeKind::Sink, "Sink1", (0.0, 0.0)));
        link(&mut net, 498, 499);
        assert_eq!(net.nodes.len(), 500);
        let started = std::time::Instant::now();
        let ds = diagnose(&net);
        let took = started.elapsed();
        eprintln!("diagnose(500 nodes): {took:?}");
        assert_eq!(codes(&ds), vec!["unstable"]);
        assert_eq!(ds[0].values.name.as_deref(), Some("S8"));
        assert!(took < std::time::Duration::from_secs(5), "{took:?}");
    }

    // ── Closed networks (new in 2.1; ledger SCI-507) ─────────────────────────────────────────

    fn closed_example() -> Network {
        bnet::read(&std::fs::read_to_string(root().join("examples/closed/ClosedCentralServer.d3.N8.bnet")).unwrap()).unwrap()
    }

    #[test]
    fn a_closed_network_is_not_a_problem() {
        assert_eq!(codes(&diagnose(&closed_example())), Vec::<&str>::new(), "no source and no sink is what closed means");
    }

    #[test]
    fn a_line_looped_without_source_and_sink_is_offered_a_population() {
        let mut net = closed_example();
        net.population = None;
        let ds = diagnose(&net);
        assert_eq!(codes(&ds), ["noSource", "noSink", "closedCandidate"]);
        let offer = only(&ds, "closedCandidate");
        assert_eq!((offer.severity, offer.values.population), (Severity::Info, Some(6)), "two customers per station to start with");
        // A lone station is a network being started, not a closed network in waiting.
        net.links.clear();
        assert!(!codes(&diagnose(&net)).contains(&"closedCandidate"));
    }

    #[test]
    fn closed_specific_problems_are_named_where_they_are() {
        // The population out of range.
        let mut net = closed_example();
        net.population = Some(0);
        assert_eq!(codes(&diagnose(&net)), ["closedPopulationRange"]);
        // A row that leaks: S1 keeps 0.1, sends 0.6 and now 0.2.
        let mut net = closed_example();
        let (s1, b3) = (id(&net, "S1"), id(&net, "B3"));
        net.links.iter_mut().find(|l| l.from == s1 && l.to == b3).unwrap().probability = 0.2;
        let ds = diagnose(&net);
        let leak = only(&ds, "closedRoutingLeaks");
        assert_eq!((leak.severity, leak.node_ids.clone(), leak.values.name.as_deref()), (Severity::Error, vec![s1.clone()], Some("S1")));
        assert!((leak.values.sum.unwrap() - 0.9).abs() < 1e-12);
        // A station customers leave and never return to: S1 no longer sends to S3.
        let mut net = closed_example();
        let (b1, b2) = (id(&net, "B1"), id(&net, "B2"));
        net.links.retain(|l| !(l.from == s1 && l.to == b3));
        net.links.iter_mut().find(|l| l.from == s1 && l.to == b2).unwrap().probability = 0.9;
        let ds = diagnose(&net);
        assert_eq!(only(&ds, "closedUnreachable").node_ids, vec![id(&net, "S3")]);
        // Two loops that never meet: S3 returns to itself, and S1 no longer feeds it.
        let s3 = id(&net, "S3");
        net.links.iter_mut().find(|l| l.from == s3 && l.to == b1).unwrap().to = b3.clone();
        let ds = diagnose(&net);
        let split = only(&ds, "closedReducible");
        assert_eq!((split.values.name.as_deref(), split.values.other.as_deref()), (Some("S1"), Some("S3")));
        // Not exponential, and a finite buffer too small for everyone.
        let mut net = closed_example();
        node(&mut net, "S2").distribution = Distribution::Erlang;
        assert_eq!(only(&diagnose(&net), "closedNotExponential").node_ids, vec![id(&net, "S2")]);
        let mut net = closed_example();
        net.infinite_buffers = false;
        let small = diagnose(&net);
        let d = only(&small, "closedBufferTooSmall");
        assert_eq!((d.values.name.as_deref(), d.values.size, d.values.population), (Some("S1"), Some(2), Some(8)));
        // A second class.
        let mut net = closed_example();
        net.links[0].class = 1;
        assert!(codes(&diagnose(&net)).contains(&"closedMultiClass"));
    }

    #[test]
    fn a_population_on_an_open_network_is_flagged_as_ignored_and_never_leaves_offers_to_close() {
        let mut net = example("OpenJackson.d2.feedback.p30.inf");
        assert!(!codes(&diagnose(&net)).contains(&"populationIgnored"));
        net.population = Some(5);
        let ds = diagnose(&net);
        assert_eq!(only(&ds, "populationIgnored").severity, Severity::Warning);
        // The loop that never lets work leave carries the population a conversion would set.
        let mut net = example("OpenJackson.d2.feedback.p30.inf");
        let s2 = id(&net, "S2");
        let b1 = id(&net, "B1");
        let s1 = id(&net, "S1");
        for l in net.links.iter_mut().filter(|l| l.from == s1) {
            l.probability = if l.to == b1 { 0.0 } else { 1.0 };
        }
        for l in net.links.iter_mut().filter(|l| l.from == s2) {
            l.to = b1.clone();
        }
        let ds = diagnose(&net);
        assert_eq!(only(&ds, "closedLoop").values.population, Some(4));
    }
}
