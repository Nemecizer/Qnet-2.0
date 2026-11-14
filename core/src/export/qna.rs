//! The `.qna` file that BNAqna, BNArqna and BNAsbd read, exactly as Qnet 0.90.34's
//! `QNAExporter.export` wrote it.
//!
//! The file has two parts. The first is Whitt's QNA input for a single-class network: the station
//! count, servers, external arrival rates and SCVs, mean service times and SCVs, and the routing
//! matrix. A multi-class network is folded into it by throughput weighting: each station serves
//! the FCFS mixture of its classes (its first two moments matched), and the routing matrix is the
//! per-class matrices weighted by each class's share of the station's throughput. The second part,
//! after `customer_classes K`, is what the per-class solvers need: the workload factor, the
//! throughputs, the per-class rates and SCVs, the per-class external arrivals, the class-expanded
//! (K·d)×(K·d) routing matrix that carries class changes, and the per-class external SCVs.
//!
//! Every number is C's `%g` (`cfmt::f`), every loop is in 0.90.34's order, and the refusals are
//! 0.90.34's sentences (`QnaError::message`). The corpus compares every example's file or refusal
//! (tests/golden_export_text.rs).
//!
//! This exporter reads parameters with its own copy of 0.90.34's `parseParams` (`parse_params`
//! here), which keeps the last key whose value is a number; `dist::parse_params` keeps the last
//! key's text and then drops it when it is not a number, which differs only for a repeated key
//! with an unreadable second value.

// The loops index as 0.90.34 did, and `!(x > y)` keeps Swift's NaN behaviour in its guards.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::cfmt;
use crate::dist::{is_swift_whitespace, swift_double};
use crate::model::{Distribution, Link, Node, NodeKind};
use crate::naming;
use crate::traffic::{self, class_label};

/// Why 0.90.34 refused to write a `.qna` file (`QNAExportError`).
#[derive(Clone, Debug, PartialEq)]
pub enum QnaError {
    NoStations,
    NoSource,
    NoSink,
    /// Station, the row sum, the class index.
    RoutingExceedsOne(String, f64, i64),
    SourceNotConnectedToStation1,
    /// A source whose rate, or a station whose service rate, is not positive.
    InfiniteMean(String),
    InfiniteVariance(String),
    /// Station and its traffic intensity ρ ≥ 1.
    StationOverloaded(String, f64),
    /// Station and class index: a closed routing cycle makes the throughput unbounded.
    TrafficSingular(String, i64),
}

impl QnaError {
    /// The sentence 0.90.34 showed (`errorDescription`).
    pub fn message(&self) -> String {
        match self {
            QnaError::NoStations => "The network has no stations.".into(),
            QnaError::NoSource => "The network has no source node.".into(),
            QnaError::NoSink => "The network has no sink node.".into(),
            QnaError::RoutingExceedsOne(n, sum, k) => {
                format!("Routing probabilities from {n} for {} sum to {}, which exceeds 1.0.", class_label(*k), cfmt::f("%.4f", *sum))
            }
            QnaError::SourceNotConnectedToStation1 => "The source must connect (possibly via a buffer) to station S1.".into(),
            QnaError::InfiniteMean(n) => format!("{n} has a distribution with infinite mean (e.g. Pareto with shape <= 1)."),
            QnaError::InfiniteVariance(n) => format!("{n} has a distribution with infinite variance (e.g. Pareto with shape <= 2)."),
            QnaError::StationOverloaded(n, rho) => format!(
                "{n} has traffic intensity rho = {} >= 1. The arrival rate must not exceed the service capacity.",
                cfmt::f("%.4f", *rho)
            ),
            QnaError::TrafficSingular(n, k) => format!(
                "Routing for {} returns every job that reaches {n} to {n}, so its throughput is unbounded and no arrival rate can be computed. Lower a routing probability on that cycle, or send part of it to a sink.",
                class_label(*k)
            ),
        }
    }
}

impl std::fmt::Display for QnaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// 0.90.34's `parseParams` in the exporters: "k=v,k=v" split on "," and "=" with empty pieces
/// dropped, a pair kept when it has exactly two pieces and its trimmed value reads as a Double;
/// a later readable value for the same trimmed key replaces an earlier one.
pub(crate) fn parse_params(s: &str) -> BTreeMap<String, f64> {
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

/// `extractRate`: 1/mean, a missing parameter taking the family's default; λ for Poisson.
fn extract_rate(d: Distribution, parameters: &str) -> f64 {
    let p = parse_params(parameters);
    let g = |k: &str, default: f64| p.get(k).copied().unwrap_or(default);
    match d {
        Distribution::Exponential => g("rate", 1.0),
        Distribution::Gamma => 1.0 / (g("shape", 2.0) * g("scale", 1.0)),
        Distribution::Uniform => 2.0 / (g("min", 0.5) + g("max", 1.5)),
        Distribution::Constant => {
            let v = g("value", 1.0);
            if v > 0.0 {
                1.0 / v
            } else {
                0.0
            }
        }
        Distribution::Weibull => 1.0 / (g("scale", 1.0) * cfmt::tgamma(1.0 + 1.0 / g("shape", 1.5))),
        Distribution::Erlang => g("rate", 1.0) / g("k", 2.0),
        Distribution::Lognormal => {
            let (mu, sigma) = (g("mu", 0.0), g("sigma", 0.25));
            1.0 / (mu + sigma * sigma / 2.0).exp()
        }
        Distribution::Pareto => {
            let (a, xm) = (g("shape", 2.5), g("scale", 1.0));
            if a <= 1.0 {
                return 0.0;
            }
            (a - 1.0) / (a * xm)
        }
        Distribution::Poisson => g("lambda", 1.0),
    }
}

/// `extractSCV`: the family's SCV, infinite for Pareto at shape ≤ 2.
fn extract_scv(d: Distribution, parameters: &str) -> f64 {
    let p = parse_params(parameters);
    let g = |k: &str, default: f64| p.get(k).copied().unwrap_or(default);
    match d {
        Distribution::Exponential | Distribution::Poisson => 1.0,
        Distribution::Gamma => 1.0 / g("shape", 2.0),
        Distribution::Uniform => {
            let (a, b) = (g("min", 0.5), g("max", 1.5));
            let (diff, sum) = (b - a, a + b);
            (diff * diff) / (3.0 * sum * sum)
        }
        Distribution::Constant => 0.0,
        Distribution::Weibull => {
            let k = g("shape", 1.5);
            let g1 = cfmt::tgamma(1.0 + 1.0 / k);
            let g2 = cfmt::tgamma(1.0 + 2.0 / k);
            (g2 - g1 * g1) / (g1 * g1)
        }
        Distribution::Erlang => 1.0 / g("k", 2.0),
        Distribution::Lognormal => {
            let s = g("sigma", 0.25);
            (s * s).exp() - 1.0
        }
        Distribution::Pareto => {
            let a = g("shape", 2.5);
            if a <= 2.0 {
                return f64::INFINITY;
            }
            1.0 / (a * (a - 2.0))
        }
    }
}

fn service_rate_for_class(station: &Node, class: usize) -> f64 {
    match station.service_by_class.get(&(class as i64)) {
        Some(c) => extract_rate(c.distribution, &c.parameters),
        None => extract_rate(station.distribution, &station.parameters),
    }
}

fn service_scv_for_class(station: &Node, class: usize) -> f64 {
    match station.service_by_class.get(&(class as i64)) {
        Some(c) => extract_scv(c.distribution, &c.parameters),
        None => extract_scv(station.distribution, &station.parameters),
    }
}

/// Swift's `max(x, y)` on Doubles: `y >= x ? y : x`.
fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

/// Swift's `reduce(0, +)`: a left fold from +0.0 (Rust's `sum` starts from −0.0).
fn total(v: &[f64]) -> f64 {
    v.iter().fold(0.0, |a, b| a + b)
}

fn row(v: &[f64]) -> String {
    v.iter().map(|x| cfmt::f("%g", *x)).collect::<Vec<_>>().join(" ")
}

/// This exporter's `resolveTargetStation`: a station is itself; a buffer resolves through its
/// outgoing links in document order, following chains of buffers, to the first that reaches a
/// station. 0.90.34 recursed without a guard, so a cycle of buffers crashed it; here a buffer
/// already on the path resolves to nothing.
fn resolve_target_station(nodes: &[Node], links: &[Link], index: &HashMap<&str, usize>, node_id: &str, path: &mut HashSet<String>) -> Option<usize> {
    let node = nodes.iter().find(|n| n.id == node_id)?;
    match node.kind {
        NodeKind::Station => index.get(node.id.as_str()).copied(),
        NodeKind::Buffer => {
            if !path.insert(node.id.clone()) {
                return None;
            }
            let mut found = None;
            for link in links.iter().filter(|l| l.from == node.id) {
                if let Some(i) = resolve_target_station(nodes, links, index, &link.to, path) {
                    found = Some(i);
                    break;
                }
            }
            path.remove(&node.id);
            found
        }
        _ => None,
    }
}

/// The `.qna` text for a network (0.90.34 `QNAExporter.export`), or the reason it is refused.
/// The text ends with a newline.
pub fn export(nodes: &[Node], links: &[Link]) -> Result<String, QnaError> {
    let sources = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Source), |n| &n.name);
    let sinks = nodes.iter().filter(|n| n.kind == NodeKind::Sink).count();
    let stations = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);

    if stations.is_empty() {
        return Err(QnaError::NoStations);
    }
    if sources.is_empty() {
        return Err(QnaError::NoSource);
    }
    if sinks == 0 {
        return Err(QnaError::NoSink);
    }

    let max_link_class = links.iter().fold(-1i64, |acc, l| acc.max(l.class).max(l.to_class.unwrap_or(-1)));
    let k_count = (sources.len() as i64).max(max_link_class + 1) as usize;
    let d = stations.len();

    if !traffic::path_exists(&sources[0].id, &stations[0].id, links) {
        return Err(QnaError::SourceNotConnectedToStation1);
    }

    let index: HashMap<&str, usize> = stations.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
    let resolve = |id: &str| resolve_target_station(nodes, links, &index, id, &mut HashSet::new());

    // Per-class external arrivals, thinned per link and superposed rate-weighted.
    let mut lambda_ext = vec![vec![0.0; d]; k_count];
    let mut arrival_scvs = vec![1.0; k_count];
    let mut ca0_weighted = vec![vec![0.0; d]; k_count];
    for (k, source) in sources.iter().enumerate() {
        let rate = extract_rate(source.distribution, &source.parameters);
        if rate <= 0.0 {
            return Err(QnaError::InfiniteMean(source.name.clone()));
        }
        let scv = extract_scv(source.distribution, &source.parameters);
        if scv.is_infinite() {
            return Err(QnaError::InfiniteVariance(source.name.clone()));
        }
        arrival_scvs[k] = scv;
        for link in links.iter().filter(|l| l.from == source.id) {
            if let Some(i) = resolve(&link.to) {
                let p = link.probability;
                let thinned_rate = rate * p;
                let thinned_scv = p * scv + (1.0 - p);
                lambda_ext[k][i] += thinned_rate;
                ca0_weighted[k][i] += thinned_rate * thinned_scv;
            }
        }
    }
    let mut ca0_pc = vec![vec![1.0; d]; k_count];
    for k in 0..k_count {
        for i in 0..d {
            if lambda_ext[k][i] > 1e-15 {
                ca0_pc[k][i] = ca0_weighted[k][i] / lambda_ext[k][i];
            }
        }
    }

    // Per-class routing matrices.
    let mut p_class: Vec<Vec<Vec<f64>>> = Vec::with_capacity(k_count);
    for class in 0..k_count {
        let mut matrix = vec![vec![0.0; d]; d];
        for (i, station) in stations.iter().enumerate() {
            for link in links.iter().filter(|l| l.from == station.id && l.class == class as i64) {
                if let Some(t) = resolve(&link.to) {
                    matrix[i][t] += link.probability;
                }
            }
            let row_sum = total(&matrix[i]);
            if row_sum > 1.0 + 1e-9 {
                return Err(QnaError::RoutingExceedsOne(station.name.clone(), row_sum, class as i64));
            }
        }
        p_class.push(matrix);
    }

    // The class-expanded routing matrix, always built because it is exported.
    let has_transitions = links.iter().any(|l| l.has_class_transition());
    let n = k_count * d;
    let mut p_ex = vec![vec![0.0; n]; n];
    for (i, station) in stations.iter().enumerate() {
        for link in links.iter().filter(|l| l.from == station.id) {
            let Some(t) = resolve(&link.to) else { continue };
            let (from_class, to_class) = (link.class, link.exit_class());
            if !(from_class >= 0 && (from_class as usize) < k_count && to_class >= 0 && (to_class as usize) < k_count) {
                continue;
            }
            p_ex[from_class as usize * d + i][to_class as usize * d + t] += link.probability;
        }
    }

    let mut alpha_per_class = vec![vec![0.0; d]; k_count];
    if !has_transitions {
        for k in 0..k_count {
            let (alpha, bad) = traffic::solve_traffic_equations(&p_class[k], &lambda_ext[k], d);
            if let Some(bad) = bad {
                return Err(QnaError::TrafficSingular(stations[bad].name.clone(), k as i64));
            }
            alpha_per_class[k] = alpha;
        }
    } else {
        let mut rhs = vec![0.0; n];
        for k in 0..k_count {
            for i in 0..d {
                rhs[k * d + i] = lambda_ext[k][i];
            }
        }
        let (alpha_ex, bad) = traffic::solve_traffic_equations(&p_ex, &rhs, n);
        if let Some(bad) = bad {
            return Err(QnaError::TrafficSingular(stations[bad % d].name.clone(), (bad / d) as i64));
        }
        for k in 0..k_count {
            for i in 0..d {
                alpha_per_class[k][i] = alpha_ex[k * d + i];
            }
        }
    }

    let mut alpha = vec![0.0; d];
    for i in 0..d {
        for apc in &alpha_per_class {
            alpha[i] += apc[i];
        }
    }

    // Effective service: the FCFS mixture's first two moments.
    let mut mu_eff = vec![0.0; d];
    let mut scv_eff = vec![0.0; d];
    for (i, station) in stations.iter().enumerate() {
        if alpha[i] > 1e-15 {
            let (mut m1, mut m2) = (0.0, 0.0);
            for (k, apc) in alpha_per_class.iter().enumerate() {
                let weight = apc[i] / alpha[i];
                let mu = service_rate_for_class(station, k);
                let scv = service_scv_for_class(station, k);
                if !(mu > 0.0) {
                    return Err(QnaError::InfiniteMean(station.name.clone()));
                }
                let mean = 1.0 / mu;
                m1 += weight * mean;
                m2 += weight * (1.0 + scv) * mean * mean;
            }
            if !(m1 > 0.0) {
                return Err(QnaError::InfiniteMean(station.name.clone()));
            }
            mu_eff[i] = 1.0 / m1;
            scv_eff[i] = swift_max(0.0, (m2 - m1 * m1) / (m1 * m1));
        } else {
            mu_eff[i] = service_rate_for_class(station, 0);
            scv_eff[i] = service_scv_for_class(station, 0);
        }
        if mu_eff[i] <= 0.0 {
            return Err(QnaError::InfiniteMean(station.name.clone()));
        }
        if scv_eff[i].is_infinite() {
            return Err(QnaError::InfiniteVariance(station.name.clone()));
        }
    }

    let mut p_agg = vec![vec![0.0; d]; d];
    for i in 0..d {
        if alpha[i] > 1e-15 {
            for j in 0..d {
                for k in 0..k_count {
                    p_agg[i][j] += (alpha_per_class[k][i] / alpha[i]) * p_class[k][i][j];
                }
            }
        }
    }

    let mut lambda0 = vec![0.0; d];
    for j in 0..d {
        for le in &lambda_ext {
            lambda0[j] += le[j];
        }
    }

    let mut ca0_sq = vec![1.0; d];
    for j in 0..d {
        if lambda0[j] > 1e-15 {
            let mut weighted = 0.0;
            for k in 0..k_count {
                weighted += lambda_ext[k][j] * arrival_scvs[k];
            }
            ca0_sq[j] = weighted / lambda0[j];
        }
    }

    for (j, station) in stations.iter().enumerate() {
        let tau = 1.0 / mu_eff[j];
        let rho = alpha[j] * tau / station.servers as f64;
        if rho >= 1.0 {
            return Err(QnaError::StationOverloaded(station.name.clone(), rho));
        }
    }

    let mut lines: Vec<String> = Vec::new();
    let mut push = |s: String| lines.push(s);
    push("# QNA input generated by BNAGUI".into());
    push(format!("# {d} stations, {k_count} customer class{}", if k_count > 1 { "es" } else { "" }));
    push(String::new());
    push(format!("{d}"));
    push(String::new());

    push("# Servers per node".into());
    push(stations.iter().map(|s| s.servers.to_string()).collect::<Vec<_>>().join(" "));
    push(String::new());

    push("# External arrival rates (lambda_0j)".into());
    push(row(&lambda0));
    push(String::new());

    push("# External arrival SCVs (c^2_{a0,j})".into());
    push(row(&ca0_sq));
    push(String::new());

    push("# Mean service times (tau_j = 1/mu_j)".into());
    push(row(&mu_eff.iter().map(|m| 1.0 / m).collect::<Vec<_>>()));
    push(String::new());

    push("# Service SCVs (c^2_{s,j})".into());
    push(row(&scv_eff));
    push(String::new());

    push("# Routing matrix Q".into());
    for r in &p_agg {
        push(row(r));
    }
    push(String::new());

    push(format!("customer_classes {k_count}"));
    push(String::new());

    push("# tau (workload conversion factor)".into());
    push(row(&(0..d).map(|i| 1.0 / (stations[i].servers as f64 * mu_eff[i])).collect::<Vec<_>>()));
    push(String::new());

    push("# Total throughput per station".into());
    push(row(&alpha));
    push(String::new());

    push("# Effective service rate per station".into());
    push(row(&mu_eff));
    push(String::new());

    push("# External arrival rate per class (lambda_k)".into());
    push(row(&lambda_ext.iter().map(|le| total(le)).collect::<Vec<_>>()));
    push(String::new());

    push("# Per-class throughput alpha[k][i] (K rows x d cols)".into());
    for r in &alpha_per_class {
        push(row(r));
    }
    push(String::new());

    push("# Per-class service rate mu[k][i] (K rows x d cols)".into());
    for k in 0..k_count {
        push(row(&stations.iter().map(|s| service_rate_for_class(s, k)).collect::<Vec<_>>()));
    }
    push(String::new());

    push("# Per-class service SCV cs[k][i] (K rows x d cols)".into());
    for k in 0..k_count {
        push(row(&stations.iter().map(|s| service_scv_for_class(s, k)).collect::<Vec<_>>()));
    }
    push(String::new());

    push("# Per-class external arrival rate at station lambda_ext[k][i] (K rows x d cols)".into());
    for r in &lambda_ext {
        push(row(r));
    }
    push(String::new());

    push("# Per-(class, station) routing P_ex[k*d+i][k'*d+j] ((K*d) x (K*d))".into());
    for r in &p_ex {
        push(row(r));
    }
    push(String::new());

    push("# Per-class external SCV ca0_pc[k][i] (K rows x d cols)".into());
    for r in &ca0_pc {
        push(row(r));
    }
    push(String::new());

    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(kind: NodeKind, name: &str, dist: Distribution, params: &str) -> Node {
        let mut n = Node::new(name, kind, name, (0.0, 0.0));
        n.distribution = dist;
        n.parameters = params.into();
        n
    }

    fn link(from: &str, to: &str, p: f64, class: i64, to_class: Option<i64>) -> Link {
        Link { id: format!("{from}-{to}-{class}"), from: from.into(), to: to.into(), probability: p, class, to_class }
    }

    /// Src1 → B1 → S1 → Sink1, Poisson(0.5) into Exponential(1).
    fn single() -> (Vec<Node>, Vec<Link>) {
        let nodes = vec![
            node(NodeKind::Source, "Src1", Distribution::Poisson, "lambda=0.5"),
            node(NodeKind::Buffer, "B1", Distribution::Exponential, "rate=1.0"),
            node(NodeKind::Station, "S1", Distribution::Exponential, "rate=1.0"),
            node(NodeKind::Sink, "Sink1", Distribution::Exponential, "rate=1.0"),
        ];
        let links = vec![link("Src1", "B1", 1.0, 0, None), link("B1", "S1", 1.0, 0, None), link("S1", "Sink1", 1.0, 0, None)];
        (nodes, links)
    }

    fn refusal(nodes: &[Node], links: &[Link]) -> String {
        export(nodes, links).unwrap_err().message()
    }

    #[test]
    fn a_network_without_stations_sources_or_sinks_is_refused() {
        let (nodes, links) = single();
        let without = |kind: NodeKind| nodes.iter().filter(|n| n.kind != kind).cloned().collect::<Vec<_>>();
        assert_eq!(refusal(&without(NodeKind::Station), &links), "The network has no stations.");
        assert_eq!(refusal(&without(NodeKind::Source), &links), "The network has no source node.");
        assert_eq!(refusal(&without(NodeKind::Sink), &links), "The network has no sink node.");
    }

    #[test]
    fn a_station_routing_more_than_one_is_refused_with_its_row_sum() {
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Station, "S2", Distribution::Exponential, "rate=1.0"));
        links.push(link("S1", "S2", 0.7, 0, None));
        links.push(link("S1", "S2", 0.5, 0, None));
        assert_eq!(refusal(&nodes, &links), "Routing probabilities from S1 for Class 1 sum to 1.2000, which exceeds 1.0.");
    }

    #[test]
    fn a_first_source_that_cannot_reach_s1_is_refused() {
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Station, "S2", Distribution::Exponential, "rate=1.0"));
        links[1] = link("B1", "S2", 1.0, 0, None);
        assert_eq!(refusal(&nodes, &links), "The source must connect (possibly via a buffer) to station S1.");
    }

    #[test]
    fn a_source_or_station_with_no_rate_has_an_infinite_mean() {
        let (mut nodes, links) = single();
        nodes[0] = node(NodeKind::Source, "Src1", Distribution::Constant, "value=0");
        assert_eq!(refusal(&nodes, &links), "Src1 has a distribution with infinite mean (e.g. Pareto with shape <= 1).");
        let (mut nodes, links) = single();
        nodes[2] = node(NodeKind::Station, "S1", Distribution::Pareto, "shape=1,scale=1");
        assert_eq!(refusal(&nodes, &links), "S1 has a distribution with infinite mean (e.g. Pareto with shape <= 1).");
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Station, "S2", Distribution::Constant, "value=0"));
        links.push(link("Src1", "S2", 0.0, 0, None));
        assert_eq!(refusal(&nodes, &links), "S2 has a distribution with infinite mean (e.g. Pareto with shape <= 1).", "an idle station is checked at its class-1 rate");
    }

    #[test]
    fn a_source_or_station_with_no_variance_bound_has_an_infinite_variance() {
        let (mut nodes, links) = single();
        nodes[0] = node(NodeKind::Source, "Src1", Distribution::Pareto, "shape=2,scale=4");
        assert_eq!(refusal(&nodes, &links), "Src1 has a distribution with infinite variance (e.g. Pareto with shape <= 2).");
        let (mut nodes, links) = single();
        nodes[2] = node(NodeKind::Station, "S1", Distribution::Pareto, "shape=2,scale=0.5");
        assert_eq!(refusal(&nodes, &links), "S1 has a distribution with infinite variance (e.g. Pareto with shape <= 2).");
    }

    #[test]
    fn a_station_at_or_above_full_load_is_refused_with_its_rho() {
        let (mut nodes, links) = single();
        nodes[0].parameters = "lambda=1.25".into();
        assert_eq!(refusal(&nodes, &links), "S1 has traffic intensity rho = 1.2500 >= 1. The arrival rate must not exceed the service capacity.");
        nodes[2].servers = 2;
        assert!(export(&nodes, &links).is_ok(), "two servers carry ρ = 0.625");
    }

    #[test]
    fn a_closed_cycle_is_refused_per_class_or_in_the_class_expanded_system() {
        let (nodes, mut links) = single();
        links[2] = link("S1", "S1", 1.0, 0, None);
        assert_eq!(
            refusal(&nodes, &links),
            "Routing for Class 1 returns every job that reaches S1 to S1, so its throughput is unbounded and no arrival rate can be computed. Lower a routing probability on that cycle, or send part of it to a sink."
        );
        links[2] = link("S1", "S1", 1.0, 0, Some(1));
        links.push(link("S1", "S1", 1.0, 1, Some(0)));
        assert_eq!(
            refusal(&nodes, &links),
            "Routing for Class 2 returns every job that reaches S1 to S1, so its throughput is unbounded and no arrival rate can be computed. Lower a routing probability on that cycle, or send part of it to a sink.",
            "the expanded index k·d + i names class k and station i"
        );
    }

    #[test]
    fn a_link_into_a_chain_of_buffers_reaches_the_station_behind_it_and_a_buffer_cycle_does_not() {
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Buffer, "B0", Distribution::Exponential, "rate=1.0"));
        links[0] = link("Src1", "B0", 1.0, 0, None);
        links.push(link("B0", "B0", 1.0, 0, None));
        links.push(link("B0", "B1", 1.0, 0, None));
        let text = export(&nodes, &links).unwrap();
        assert!(text.contains("# External arrival rates (lambda_0j)\n0.5\n"), "{text}");
    }

    #[test]
    fn thinned_streams_into_one_station_average_their_scvs_by_rate() {
        let (mut nodes, mut links) = single();
        nodes[0] = node(NodeKind::Source, "Src1", Distribution::Constant, "value=4");
        links[0] = link("Src1", "B1", 0.5, 0, None);
        links.push(link("Src1", "B1", 0.5, 0, None));
        let text = export(&nodes, &links).unwrap();
        assert!(text.contains("# Per-class external SCV ca0_pc[k][i] (K rows x d cols)\n0.5\n"), "p·c² + (1 − p) = 0.5: {text}");
        assert!(text.contains("# External arrival SCVs (c^2_{a0,j})\n0\n"), "the aggregate uses the unthinned SCV: {text}");
        assert!(text.ends_with("\n") && text.contains("# 1 stations, 1 customer class\n"));
    }

    #[test]
    fn the_exporters_parameter_reader_keeps_the_last_readable_value() {
        let p = parse_params(" rate = 2 ,rate=x,,shape==3,k=1=2");
        assert_eq!(p.get("rate"), Some(&2.0));
        assert_eq!(p.get("shape"), Some(&3.0), "empty pieces are dropped, so shape==3 is a pair");
        assert_eq!(p.get("k"), None);
    }
}
