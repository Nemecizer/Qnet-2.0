//! The `.sim` file for the infinite-buffer simulator `jackson_sim` (BNAsim), exactly as Qnet
//! 0.90.34's `BNANetworkExporter.export` wrote it.
//!
//! The simulator knows only "virtual classes", one per (customer class, station) pair: class
//! index k·d + i is customer class k at station i. Each gets a block with its external arrival
//! (always exponential, at the source's rate thinned by the link probability), its station, its
//! service law and a routing vector over all K·d virtual classes, so a link that changes the
//! customer class simply routes into another class's block. Numbers are C's `%g` (`cfmt::f`).
//!
//! 0.90.34's refusals here are a subset of `NetworkExportError`'s, with the same sentences, so
//! this exporter returns `traffic::NetworkError` (only `NoStations`, `NoSource`, `NoSink`,
//! `StationMissingBuffer`, `StationMultipleBuffers`, `RoutingExceedsOne` and
//! `SourceNotConnectedToStation1`). The corpus compares every example (tests/golden_export_text.rs).

// The loops index as 0.90.34 did, and `!(x > y)` keeps Swift's NaN behaviour in its guards.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use std::collections::HashMap;

use crate::cfmt;
use crate::export::qna::parse_params;
use crate::model::{Distribution, Link, Node, NodeKind};
use crate::naming;
use crate::traffic::{self, class_label, NetworkError};

/// The station a link into `node_id` delivers to, as 0.90.34's simulator exporters resolve it: the
/// node itself if it is a station; for a buffer, the target of its first outgoing link (in document
/// order) that ends at a station; otherwise none.
pub(crate) fn resolve_one_hop(nodes: &[Node], links: &[Link], index: &HashMap<&str, usize>, node_id: &str) -> Option<usize> {
    let node = nodes.iter().find(|n| n.id == node_id)?;
    match node.kind {
        NodeKind::Station => index.get(node.id.as_str()).copied(),
        NodeKind::Buffer => {
            for link in links.iter().filter(|l| l.from == node.id) {
                if let Some(target) = nodes.iter().find(|n| n.id == link.to) {
                    if target.kind == NodeKind::Station {
                        return index.get(target.id.as_str()).copied();
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// Each station must be fed by exactly one buffer (a buffer with a link into it); returns the
/// buffers in station order, or the first station that fails.
pub(crate) fn feeding_buffers<'a>(nodes: &'a [Node], links: &[Link], stations: &[&Node]) -> Result<Vec<&'a Node>, NetworkError> {
    let mut out = Vec::with_capacity(stations.len());
    for station in stations {
        let feeding: Vec<&Node> =
            nodes.iter().filter(|c| c.kind == NodeKind::Buffer && links.iter().any(|l| l.from == c.id && l.to == station.id)).collect();
        if feeding.is_empty() {
            return Err(NetworkError::StationMissingBuffer(station.name.clone()));
        }
        if feeding.len() != 1 {
            return Err(NetworkError::StationMultipleBuffers(station.name.clone()));
        }
        out.push(feeding[0]);
    }
    Ok(out)
}

/// Swift's `reduce(0, +)`: a left fold from +0.0.
fn total(v: &[f64]) -> f64 {
    v.iter().fold(0.0, |a, b| a + b)
}

fn g(x: f64) -> String {
    cfmt::f("%g", x)
}

/// Swift's `Int(Double)` truncates toward zero; it traps for NaN, infinities and values outside
/// Int's range, where this saturates instead.
fn swift_int(x: f64) -> i64 {
    x as i64
}

/// A service law in `jackson_sim`'s words (`formatDistribution`), missing parameters taking the
/// family's default.
fn format_distribution(d: Distribution, parameters: &str) -> String {
    let p = parse_params(parameters);
    let v = |k: &str, default: f64| p.get(k).copied().unwrap_or(default);
    match d {
        Distribution::Exponential => format!("exponential {}", g(v("rate", 1.0))),
        Distribution::Gamma => format!("gamma {} {}", g(v("shape", 2.0)), g(v("scale", 1.0))),
        Distribution::Uniform => format!("uniform {} {}", g(v("min", 0.5)), g(v("max", 1.5))),
        Distribution::Constant => format!("deterministic {}", g(v("value", 1.0))),
        Distribution::Weibull => format!("weibull {} {}", g(v("shape", 1.5)), g(v("scale", 1.0))),
        Distribution::Erlang => format!("erlang {} {}", swift_int(v("k", 2.0)), g(v("rate", 1.0))),
        Distribution::Lognormal => format!("lognormal {} {}", g(v("mu", 0.0)), g(v("sigma", 0.25))),
        Distribution::Pareto => format!("pareto {} {}", g(v("shape", 2.5)), g(v("scale", 1.0))),
        // jackson_sim's `exponential X` is a rate, and a Poisson process's gaps are Exp(λ).
        Distribution::Poisson => format!("exponential {}", g(v("lambda", 1.0))),
    }
}

/// A source's events per unit time, 1/mean for a non-Poisson law (`extractSourceRate`).
fn extract_source_rate(d: Distribution, parameters: &str) -> f64 {
    let p = parse_params(parameters);
    let v = |k: &str, default: f64| p.get(k).copied().unwrap_or(default);
    match d {
        Distribution::Exponential => v("rate", 1.0),
        Distribution::Poisson => v("lambda", 1.0),
        Distribution::Gamma => 1.0 / (v("shape", 2.0) * v("scale", 1.0)),
        Distribution::Uniform => 2.0 / (v("min", 0.5) + v("max", 1.5)),
        Distribution::Constant => {
            let x = v("value", 1.0);
            if x > 0.0 {
                1.0 / x
            } else {
                0.0
            }
        }
        Distribution::Weibull => 1.0 / (v("scale", 1.0) * cfmt::tgamma(1.0 + 1.0 / v("shape", 1.5))),
        Distribution::Erlang => v("rate", 1.0) / v("k", 2.0),
        Distribution::Lognormal => {
            let (mu, sigma) = (v("mu", 0.0), v("sigma", 0.25));
            1.0 / (mu + sigma * sigma / 2.0).exp()
        }
        Distribution::Pareto => {
            let (a, s) = (v("shape", 2.5), v("scale", 1.0));
            if a > 1.0 {
                (a - 1.0) / (a * s)
            } else {
                0.0
            }
        }
    }
}

/// The `.sim` text for a network (0.90.34 `BNANetworkExporter.export`), or the reason it is
/// refused. The text ends with a newline.
pub fn export(nodes: &[Node], links: &[Link]) -> Result<String, NetworkError> {
    let sources = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Source), |n| &n.name);
    let sinks = nodes.iter().filter(|n| n.kind == NodeKind::Sink).count();
    let stations = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);

    if stations.is_empty() {
        return Err(NetworkError::NoStations);
    }
    if sources.is_empty() {
        return Err(NetworkError::NoSource);
    }
    if sinks == 0 {
        return Err(NetworkError::NoSink);
    }

    let max_link_class = links.iter().fold(-1i64, |acc, l| acc.max(l.class).max(l.to_class.unwrap_or(-1)));
    let k_count = (sources.len() as i64).max(max_link_class + 1) as usize;
    let d = stations.len();

    feeding_buffers(nodes, links, &stations)?;

    if !traffic::path_exists(&sources[0].id, &stations[0].id, links) {
        return Err(NetworkError::SourceNotConnectedToStation1);
    }

    let index: HashMap<&str, usize> = stations.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
    let resolve = |id: &str| resolve_one_hop(nodes, links, &index, id);

    // Routing in the class-expanded space: from (class k, station i) to (exit class, station j).
    let n = k_count * d;
    let mut routing = vec![vec![vec![0.0; n]; d]; k_count];
    for class in 0..k_count {
        for (i, station) in stations.iter().enumerate() {
            for link in links.iter().filter(|l| l.from == station.id && l.class == class as i64) {
                let Some(t) = resolve(&link.to) else { continue };
                let exit = link.to_class.unwrap_or(class as i64);
                if !(exit >= 0 && (exit as usize) < k_count) {
                    continue;
                }
                routing[class][i][exit as usize * d + t] += link.probability;
            }
            let row_sum = total(&routing[class][i]);
            if row_sum > 1.0 + 1e-9 {
                return Err(NetworkError::RoutingExceedsOne(station.name.clone(), row_sum, class as i64));
            }
        }
    }

    // External arrivals per (class, station), thinned by each link's probability.
    let mut external = vec![vec![0.0; d]; k_count];
    for (k, source) in sources.iter().enumerate() {
        let rate = extract_source_rate(source.distribution, &source.parameters);
        for link in links.iter().filter(|l| l.from == source.id) {
            if let Some(i) = resolve(&link.to) {
                external[k][i] += rate * link.probability;
            }
        }
    }

    let mut lines: Vec<String> = vec![
        "# Jackson Network Simulation Input File".into(),
        "# Generated by BNAGUI".into(),
        String::new(),
        format!("stations {d}"),
        format!("classes {n}"),
        format!("customer_classes {k_count}"),
        String::new(),
        format!("servers {}", stations.iter().map(|s| s.servers.to_string()).collect::<Vec<_>>().join(" ")),
        String::new(),
    ];
    for k in 0..k_count {
        for (i, station) in stations.iter().enumerate() {
            let idx = k * d + i;
            let label = if k_count > 1 { format!(" ({} at {})", class_label(k as i64), station.name) } else { format!(" ({})", station.name) };
            lines.push(format!("# Class {idx}{label}"));
            lines.push(format!("class {idx}"));
            let rate = external[k][i];
            if rate > 1e-12 {
                lines.push(format!("    arrival exponential {}", g(rate)));
            } else {
                lines.push("    arrival none".into());
            }
            lines.push(format!("    station {i}"));
            let service = match station.service_by_class.get(&(k as i64)) {
                Some(c) => format_distribution(c.distribution, &c.parameters),
                None => format_distribution(station.distribution, &station.parameters),
            };
            lines.push(format!("    service {service}"));
            lines.push(format!("    routing {}", routing[k][i].iter().map(|x| g(*x)).collect::<Vec<_>>().join(" ")));
            lines.push("end_class".into());
            lines.push(String::new());
        }
    }
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

    /// Src1 → B1 → S1 → Sink1.
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
    fn a_station_needs_exactly_one_buffer_feeding_it() {
        let (nodes, mut links) = single();
        links[1] = link("Src1", "S1", 1.0, 0, None);
        assert_eq!(refusal(&nodes, &links), "Station S1 has no buffer feeding into it.");
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Buffer, "B2", Distribution::Exponential, "rate=1.0"));
        links.push(link("B2", "S1", 1.0, 0, None));
        assert_eq!(refusal(&nodes, &links), "Station S1 has more than one buffer feeding into it.");
    }

    #[test]
    fn a_first_source_that_cannot_reach_s1_is_refused() {
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Station, "S2", Distribution::Exponential, "rate=1.0"));
        nodes.push(node(NodeKind::Buffer, "B2", Distribution::Exponential, "rate=1.0"));
        links[0] = link("Src1", "B2", 1.0, 0, None);
        links.push(link("B2", "S2", 1.0, 0, None));
        assert_eq!(refusal(&nodes, &links), "The source must connect (possibly via a buffer) to station S1.");
    }

    #[test]
    fn a_class_routing_more_than_one_in_the_expanded_space_is_refused() {
        let (nodes, mut links) = single();
        links.push(link("S1", "B1", 0.75, 0, None));
        links.push(link("S1", "B1", 0.5, 0, Some(1)));
        assert_eq!(refusal(&nodes, &links), "Routing probabilities from S1 for Class 1 sum to 1.2500, which exceeds 1.0.", "a sink takes no share of the row");
    }

    #[test]
    fn every_service_law_is_written_in_jackson_sims_words_with_its_defaults() {
        let want = [
            (Distribution::Exponential, "exponential 1"),
            (Distribution::Gamma, "gamma 2 1"),
            (Distribution::Uniform, "uniform 0.5 1.5"),
            (Distribution::Constant, "deterministic 1"),
            (Distribution::Weibull, "weibull 1.5 1"),
            (Distribution::Erlang, "erlang 2 1"),
            (Distribution::Lognormal, "lognormal 0 0.25"),
            (Distribution::Pareto, "pareto 2.5 1"),
            (Distribution::Poisson, "exponential 1"),
        ];
        for (d, text) in want {
            assert_eq!(format_distribution(d, ""), text);
        }
        assert_eq!(format_distribution(Distribution::Erlang, "k=3.9,rate=0.125"), "erlang 3 0.125", "Int(k) truncates");
    }

    #[test]
    fn a_source_with_no_finite_rate_writes_no_arrival() {
        let (mut nodes, links) = single();
        nodes[0] = node(NodeKind::Source, "Src1", Distribution::Pareto, "shape=1,scale=1");
        let text = export(&nodes, &links).unwrap();
        assert!(text.contains("# Class 0 (S1)\nclass 0\n    arrival none\n    station 0\n    service exponential 1\n    routing 0\nend_class\n"), "{text}");
    }

    #[test]
    fn a_class_change_routes_into_the_other_classs_block() {
        let (mut nodes, mut links) = single();
        nodes[2].service_by_class.insert(1, crate::model::ServiceConfig { distribution: Distribution::Constant, parameters: "value=0.5".into() });
        links[2] = link("S1", "B1", 1.0, 0, Some(1));
        links.push(link("S1", "Sink1", 1.0, 1, None));
        let text = export(&nodes, &links).unwrap();
        assert!(text.contains("classes 2\ncustomer_classes 2\n"), "{text}");
        assert!(text.contains("# Class 0 (Class 1 at S1)\nclass 0\n    arrival exponential 0.5\n    station 0\n    service exponential 1\n    routing 0 1\n"), "{text}");
        assert!(text.contains("# Class 1 (Class 2 at S1)\nclass 1\n    arrival none\n    station 0\n    service deterministic 0.5\n    routing 0 0\n"), "{text}");
    }
}
