//! The finite-buffer simulator's input text (fBNAsim), exactly as Qnet 0.90.34's
//! `NetworkExporter.export` wrote it, apart from the time in its `# Generated:` line.
//!
//! The simulator takes one arrival stream per class and one entry station per class, so each
//! source is split into one synthetic class per station it feeds: the stream is thinned by the
//! link's share of the source's resolved probability (exactly, as `lambda=%.6f` or `rate=%.6f`,
//! for Poisson and exponential; other laws are copied unchanged). Each synthetic class is then
//! followed breadth-first through the network to find the customer class it travels as at each
//! station, after class changes, and that label picks the station's service law and the routing
//! the class follows. Routing matrices are printed `%.6f` (`cfmt::f`).
//!
//! The second line is `# Generated: <time>`. 0.90.34 wrote
//! `DateFormatter.localizedString(from: Date(), dateStyle: .short, timeStyle: .medium)`, the
//! current time in the Mac's locale: "11/10/26, 14:11:04" in the golden corpus (an en_US region
//! with a 24-hour clock), "11/10/26, 2:11:04 PM" (with U+202F before "PM") in en_US on a 12-hour
//! clock. The caller passes that text in as `generated`, so the rest is deterministic; it is the
//! one line the golden comparison skips.
//!
//! Refusals are `traffic::NetworkError` (0.90.34's `NetworkExportError`). This exporter never
//! returns `TrafficSingular` or `SourceNotConnectedToStation1`, which 0.90.34 declared here but
//! did not use. The corpus compares every example (tests/golden_export_text.rs).

// The loops index as 0.90.34 did, and `!(x > y)` keeps Swift's NaN behaviour in its guards.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use std::collections::{BTreeMap, HashMap, VecDeque};

use crate::cfmt;
use crate::dist::{parse_parameter_strings, swift_double};
use crate::export::jackson_sim::{feeding_buffers, resolve_one_hop};
use crate::model::{Distribution, Link, Node, NodeKind};
use crate::naming;
use crate::traffic::NetworkError;

/// One simulator class: a source's stream into one entry station.
struct SynthClass {
    /// The source's index in export order, its customer class.
    qnet_class: i64,
    entry_station: usize,
    distribution: Distribution,
    parameters: String,
}

/// Swift's `reduce(0, +)`: a left fold from +0.0.
fn total(v: &[f64]) -> f64 {
    v.iter().fold(0.0, |a, b| a + b)
}

/// `scaleArrivalParameters`: a Poisson λ or an exponential rate multiplied by `factor` and
/// printed `%.6f`; anything else, or a value that isn't a number, verbatim.
fn scale_arrival_parameters(d: Distribution, parameters: &str, factor: f64) -> String {
    let parsed = parse_parameter_strings(parameters);
    let number = |k: &str| swift_double(parsed.get(k).map(String::as_str).unwrap_or(""));
    match d {
        Distribution::Poisson => {
            if let Some(lam) = number("lambda") {
                return cfmt::f("lambda=%.6f", lam * factor);
            }
        }
        Distribution::Exponential => {
            if let Some(r) = number("rate") {
                return cfmt::f("rate=%.6f", r * factor);
            }
        }
        _ => {}
    }
    parameters.to_string()
}

/// The fBNAsim input text for a network (0.90.34 `NetworkExporter.export`), with `generated` as
/// the time on its second line, or the reason it is refused. The text ends with a blank line.
pub fn export(nodes: &[Node], links: &[Link], generated: &str) -> Result<String, NetworkError> {
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

    let qnet_class_count = sources.len();
    let d = stations.len();

    let buffer_sizes: Vec<i64> = feeding_buffers(nodes, links, &stations)?.iter().map(|b| b.buffer_size).collect();

    let index: HashMap<&str, usize> = stations.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
    let resolve = |id: &str| resolve_one_hop(nodes, links, &index, id);

    // Per-source-class routing, built only for its row-sum check, as in 0.90.34.
    for class in 0..qnet_class_count {
        let mut matrix = vec![vec![0.0; d]; d];
        for (i, station) in stations.iter().enumerate() {
            for link in links.iter().filter(|l| l.from == station.id && l.class == class as i64) {
                if let Some(t) = resolve(&link.to) {
                    matrix[i][t] += link.probability;
                }
            }
            let row_sum = total(&matrix[i]);
            if row_sum > 1.0 + 1e-9 {
                return Err(NetworkError::RoutingExceedsOne(station.name.clone(), row_sum, class as i64));
            }
        }
    }

    // One synthetic class per (source, entry station), entries in station order.
    let mut synth: Vec<SynthClass> = Vec::new();
    for source in &sources {
        let qnet_class = sources.iter().position(|s| s.id == source.id).unwrap_or(0) as i64;
        let outgoing: Vec<&Link> = links.iter().filter(|l| l.from == source.id).collect();
        if outgoing.is_empty() {
            return Err(NetworkError::SourceUnresolvedEntry(source.name.clone()));
        }
        let mut prob_by_entry: BTreeMap<usize, f64> = BTreeMap::new();
        for link in outgoing {
            let Some(entry) = resolve(&link.to) else { continue };
            *prob_by_entry.entry(entry).or_insert(0.0) += link.probability;
        }
        if prob_by_entry.is_empty() {
            return Err(NetworkError::SourceUnresolvedEntry(source.name.clone()));
        }
        // 0.90.34 summed a Dictionary's values in its (per-process hash) order; this sums them
        // in station order. The two agree for one or two entries.
        let sum = prob_by_entry.values().fold(0.0, |a, b| a + b);
        if !(sum > 1e-9) {
            return Err(NetworkError::SourceUnresolvedEntry(source.name.clone()));
        }
        for (&entry, &prob) in &prob_by_entry {
            let p = prob / sum;
            synth.push(SynthClass {
                qnet_class,
                entry_station: entry,
                distribution: source.distribution,
                parameters: scale_arrival_parameters(source.distribution, &source.parameters, p),
            });
        }
    }

    // Each synthetic class's label at each station (the first seen wins) and its routing.
    let mut label_at_station: Vec<Vec<Option<i64>>> = Vec::with_capacity(synth.len());
    let mut routing_per_synth: Vec<Vec<Vec<f64>>> = Vec::with_capacity(synth.len());
    for cls in &synth {
        let mut labels: Vec<Option<i64>> = vec![None; d];
        let mut matrix = vec![vec![0.0; d]; d];
        labels[cls.entry_station] = Some(cls.qnet_class);
        let mut queue: VecDeque<(usize, i64)> = VecDeque::from([(cls.entry_station, cls.qnet_class)]);
        while let Some((i, label)) = queue.pop_front() {
            let station = stations[i];
            for link in links.iter().filter(|l| l.from == station.id && l.class == label) {
                let Some(t) = resolve(&link.to) else { continue };
                matrix[i][t] += link.probability;
                let new_label = link.exit_class();
                if labels[t].is_none() {
                    labels[t] = Some(new_label);
                    queue.push_back((t, new_label));
                }
            }
        }
        label_at_station.push(labels);
        routing_per_synth.push(matrix);
    }

    let mut lines: Vec<String> = vec![
        "# fBNA Queueing Network Export".into(),
        format!("# Generated: {generated}"),
        String::new(),
        "# num_classes".into(),
        synth.len().to_string(),
        String::new(),
        "# dimension".into(),
        d.to_string(),
        String::new(),
        "# arrival_distributions".into(),
    ];
    for cls in &synth {
        lines.push(format!("{} {}", cls.distribution.raw(), cls.parameters));
    }
    lines.push(String::new());

    lines.push("# arrival_stations".into());
    lines.push(synth.iter().map(|c| (c.entry_station + 1).to_string()).collect::<Vec<_>>().join(" "));
    lines.push(String::new());

    lines.push("# servers_per_station".into());
    lines.push(stations.iter().map(|s| s.servers.to_string()).collect::<Vec<_>>().join(" "));
    lines.push(String::new());

    lines.push("# buffer_sizes".into());
    lines.push(buffer_sizes.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(" "));
    lines.push(String::new());

    lines.push("# service_distributions".into());
    for (s, station) in stations.iter().enumerate() {
        let parts: Vec<String> = synth
            .iter()
            .enumerate()
            .map(|(c, cls)| {
                let label = label_at_station[c][s].unwrap_or(cls.qnet_class);
                match station.service_by_class.get(&label) {
                    Some(cfg) => format!("{} {}", cfg.distribution.raw(), cfg.parameters),
                    None => format!("{} {}", station.distribution.raw(), station.parameters),
                }
            })
            .collect();
        lines.push(parts.join(" | "));
    }
    lines.push(String::new());

    for (idx, matrix) in routing_per_synth.iter().enumerate() {
        lines.push(format!("# routing_matrix_class_{}", idx + 1));
        for row in matrix {
            lines.push(row.iter().map(|x| cfmt::f("%.6f", *x)).collect::<Vec<_>>().join(" "));
        }
        lines.push(String::new());
    }

    Ok(lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ServiceConfig;

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
        export(nodes, links, "now").unwrap_err().message()
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
    fn a_station_routing_more_than_one_is_refused_with_its_row_sum() {
        let (nodes, mut links) = single();
        links.push(link("S1", "B1", 0.75, 0, None));
        links.push(link("S1", "S1", 0.5, 0, None));
        assert_eq!(refusal(&nodes, &links), "Routing probabilities from S1 for Class 1 sum to 1.2500, which exceeds 1.0.");
    }

    #[test]
    fn a_source_that_reaches_no_station_is_refused() {
        let want = "Source Src1 is not connected to a station (directly or via a buffer).";
        let (nodes, mut links) = single();
        links[0] = link("B1", "S1", 0.0, 0, None);
        assert_eq!(refusal(&nodes, &links), want, "no outgoing link");
        let (nodes, mut links) = single();
        links[0] = link("Src1", "Sink1", 1.0, 0, None);
        assert_eq!(refusal(&nodes, &links), want, "a link that resolves to no station");
        let (nodes, mut links) = single();
        links[0].probability = 0.0;
        assert_eq!(refusal(&nodes, &links), want, "a total probability of zero");
    }

    #[test]
    fn a_source_never_needs_to_reach_s1() {
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Station, "S2", Distribution::Exponential, "rate=1.0"));
        nodes.push(node(NodeKind::Buffer, "B2", Distribution::Exponential, "rate=1.0"));
        links[0] = link("Src1", "B2", 1.0, 0, None);
        links.push(link("B2", "S2", 1.0, 0, None));
        let text = export(&nodes, &links, "now").unwrap();
        assert!(text.contains("# arrival_stations\n2\n"), "{text}");
    }

    #[test]
    fn only_poisson_and_exponential_streams_are_scaled_when_a_source_splits() {
        assert_eq!(scale_arrival_parameters(Distribution::Poisson, "lambda=0.9", 1.0 / 3.0), "lambda=0.300000");
        assert_eq!(scale_arrival_parameters(Distribution::Exponential, "rate = 2", 0.25), "rate=0.500000");
        assert_eq!(scale_arrival_parameters(Distribution::Exponential, "rate=x", 0.25), "rate=x", "a rate that isn't a number is copied");
        assert_eq!(scale_arrival_parameters(Distribution::Poisson, "rate=1", 0.5), "rate=1", "no lambda, copied");
        assert_eq!(scale_arrival_parameters(Distribution::Gamma, "shape=2,scale=1", 0.5), "shape=2,scale=1");
    }

    #[test]
    fn a_split_source_becomes_one_class_per_entry_station_in_station_order_with_normalised_shares() {
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Station, "S2", Distribution::Exponential, "rate=2.0"));
        nodes.push(node(NodeKind::Buffer, "B2", Distribution::Exponential, "rate=1.0"));
        links.push(link("B2", "S2", 1.0, 0, None));
        links.push(link("S2", "Sink1", 1.0, 0, None));
        links[0] = link("Src1", "B2", 0.3, 0, None);
        links.push(link("Src1", "B1", 0.1, 0, None));
        links.push(link("Src1", "S1", 0.4, 0, None));
        let text = export(&nodes, &links, "now").unwrap();
        assert!(text.contains("# num_classes\n2\n"), "{text}");
        assert!(text.contains("# arrival_distributions\npoisson lambda=0.312500\npoisson lambda=0.187500\n"), "{text}");
        assert!(text.contains("# arrival_stations\n1 2\n"), "{text}");
        assert!(text.ends_with("0.000000 0.000000\n\n"), "{text}");
    }

    #[test]
    fn a_class_change_picks_the_service_law_of_the_label_first_seen_at_each_station() {
        let (mut nodes, mut links) = single();
        nodes.push(node(NodeKind::Station, "S2", Distribution::Exponential, "rate=2.0"));
        nodes.push(node(NodeKind::Buffer, "B2", Distribution::Exponential, "rate=1.0"));
        nodes[4].service_by_class.insert(1, ServiceConfig { distribution: Distribution::Constant, parameters: "value=.25".into() });
        links[2] = link("S1", "B2", 1.0, 0, Some(1));
        links.push(link("B2", "S2", 1.0, 0, None));
        links.push(link("S2", "Sink1", 1.0, 1, None));
        let text = export(&nodes, &links, "now").unwrap();
        assert!(text.contains("# service_distributions\nexponential rate=1.0\nconstant value=.25\n"), "{text}");
        assert!(text.contains("# routing_matrix_class_1\n0.000000 1.000000\n0.000000 0.000000\n"), "{text}");
        assert!(text.starts_with("# fBNA Queueing Network Export\n# Generated: now\n\n"));
    }
}
