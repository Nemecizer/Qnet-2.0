//! The model-level rules the editor applies as a network is drawn (0.90.34 `NetworkEditorModel`):
//! the class count, the auto-naming counters, the class index of a source, and the live stability
//! readout the station inspector shows while parameters are typed.

use crate::model::{Link, Network, Node, NodeKind};
use crate::naming;
use crate::traffic;

/// The number of customer classes: the larger of the number of sources and one more than the
/// highest class any link carries or turns into (`numberOfCustomerClasses`).
pub fn number_of_classes(net: &Network) -> i64 {
    let sources = net.nodes.iter().filter(|n| n.kind == NodeKind::Source).count() as i64;
    let max_link_class = net.links.iter().fold(-1i64, |acc, l| acc.max(l.class).max(l.to_class.unwrap_or(-1)));
    sources.max(max_link_class + 1)
}

/// The per-kind name prefixes new nodes are numbered under ("S3", "B3", "Src3", "Sink3").
pub fn name_prefix(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Station => "S",
        NodeKind::Buffer => "B",
        NodeKind::Source => "Src",
        NodeKind::Sink => "Sink",
    }
}

/// The counter a kind's next new node continues from, read off a loaded network (`maxNameIndex`):
/// the largest whole number left after dropping as many leading characters as the prefix has,
/// whether or not they are the prefix ("X12" counts 12 for stations), else 0.
pub fn max_name_index(nodes: &[Node], kind: NodeKind) -> i64 {
    let skip = name_prefix(kind).chars().count();
    nodes
        .iter()
        .filter(|n| n.kind == kind)
        // Swift's Int(String) and Rust's i64 parse take the same text: an optional sign, then ASCII digits.
        .filter_map(|n| n.name.chars().skip(skip).collect::<String>().parse::<i64>().ok())
        .max()
        .unwrap_or(0)
}

/// The class a source's jobs carry: its place among the sources in name order, 0 if it isn't one
/// (`customerClassIndex(for:)`).
pub fn class_index_of_source(nodes: &[Node], source_id: &str) -> usize {
    let sources = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Source), |n| &n.name);
    sources.iter().position(|s| s.id == source_id).unwrap_or(0)
}

/// What the station inspector shows while its fields are edited (`StationStabilityReadout`).
#[derive(Clone, Debug, PartialEq)]
pub struct StabilityReadout {
    /// λ into the station, all classes.
    pub arrival_rate: f64,
    /// c·μ.
    pub capacity: f64,
    pub servers: i64,
    /// λ per class, for the classes that reach the station.
    pub arrival_rate_per_class: Vec<(usize, f64)>,
}

impl StabilityReadout {
    /// ρ, or None without capacity.
    pub fn utilisation(&self) -> Option<f64> {
        if !(self.capacity > 1e-12) {
            return None;
        }
        let rho = self.arrival_rate / self.capacity;
        rho.is_finite().then_some(rho)
    }

    /// Unstable at ρ ≥ 1.
    pub fn is_unstable(&self) -> bool {
        self.utilisation().unwrap_or(0.0) >= 1.0
    }

    /// The heavy-traffic advisory threshold, ρ ≥ 0.95.
    pub fn is_heavy(&self) -> bool {
        self.utilisation().unwrap_or(0.0) >= 0.95
    }
}

/// The readout for one station of a draft network, or None when there is no source, the traffic
/// equations fail, or the numbers aren't finite (`stabilityReadout`).
pub fn stability_readout(station_id: &str, draft_nodes: &[Node], links: &[Link], infinite: bool) -> Option<StabilityReadout> {
    if !draft_nodes.iter().any(|n| n.kind == NodeKind::Source) {
        return None;
    }
    let station = draft_nodes.iter().find(|n| n.id == station_id && n.kind == NodeKind::Station)?;
    let data = traffic::compute(draft_nodes, links, infinite, false, false).ok()?;
    let stations = naming::in_export_order(draft_nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);
    let k = stations.iter().position(|s| s.id == station.id).filter(|k| *k < data.d)?;
    let (capacity, arrival) = (data.capacity[k], data.alpha[k]);
    if !(capacity.is_finite() && arrival.is_finite()) {
        return None;
    }
    let arrival_rate_per_class = (0..data.k)
        .filter(|c| *c < data.alpha_per_class.len() && k < data.alpha_per_class[*c].len())
        .map(|c| (c, data.alpha_per_class[c][k]))
        .filter(|(_, v)| v.is_finite() && *v > 0.0)
        .collect();
    Some(StabilityReadout { arrival_rate: arrival, capacity, servers: station.servers, arrival_rate_per_class })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Node;

    fn node(kind: NodeKind, name: &str) -> Node {
        Node::new(format!("ID-{name}"), kind, name, (0.0, 0.0))
    }

    #[test]
    fn counters_continue_from_the_largest_number_after_the_prefix_length() {
        let nodes = vec![node(NodeKind::Station, "S2"), node(NodeKind::Station, "X12"), node(NodeKind::Station, "S3a"), node(NodeKind::Source, "Src7"), node(NodeKind::Sink, "Out")];
        assert_eq!(max_name_index(&nodes, NodeKind::Station), 12, "the first character is dropped whatever it is");
        assert_eq!(max_name_index(&nodes, NodeKind::Source), 7);
        assert_eq!(max_name_index(&nodes, NodeKind::Sink), 0, "no number after four characters");
        assert_eq!(max_name_index(&nodes, NodeKind::Buffer), 0);
    }

    #[test]
    fn the_stability_readout_follows_the_draft_and_flags_heavy_and_unstable_load() {
        let mut src = node(NodeKind::Source, "Src1");
        src.distribution = crate::model::Distribution::Poisson;
        src.parameters = "lambda=0.96".into();
        let buf = node(NodeKind::Buffer, "B1");
        let mut st = node(NodeKind::Station, "S1");
        st.servers = 2;
        st.parameters = "rate=0.5".into();
        let sink = node(NodeKind::Sink, "Sink1");
        let l = |from: &str, to: &str| Link { id: format!("{from}>{to}"), from: from.into(), to: to.into(), probability: 1.0, class: 0, to_class: None };
        let links = vec![l("ID-Src1", "ID-B1"), l("ID-B1", "ID-S1"), l("ID-S1", "ID-Sink1")];
        let nodes = vec![src.clone(), buf.clone(), st.clone(), sink.clone()];
        let r = stability_readout("ID-S1", &nodes, &links, true).unwrap();
        assert_eq!((r.arrival_rate, r.capacity, r.servers), (0.96, 1.0, 2));
        assert_eq!(r.arrival_rate_per_class, vec![(0, 0.96)]);
        assert!(r.is_heavy() && !r.is_unstable(), "ρ = 0.96");
        let mut faster = nodes.clone();
        faster[2].servers = 1;
        assert!(stability_readout("ID-S1", &faster, &links, true).unwrap().is_unstable(), "one server: ρ = 1.92");
        assert_eq!(stability_readout("ID-B1", &nodes, &links, true), None, "only stations have a readout");
        assert_eq!(stability_readout("ID-S1", &[buf, st, sink], &links, true), None, "no source, no readout");
    }

    #[test]
    fn classes_are_counted_from_sources_and_from_the_classes_links_name() {
        let mut net = Network { nodes: vec![node(NodeKind::Source, "Src1"), node(NodeKind::Source, "Src2")], links: vec![], infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None };
        assert_eq!(number_of_classes(&net), 2);
        net.links.push(Link { id: "L".into(), from: "a".into(), to: "b".into(), probability: 1.0, class: 0, to_class: Some(3) });
        assert_eq!(number_of_classes(&net), 4, "a class change to class 3 makes four classes");
        assert_eq!(class_index_of_source(&net.nodes, "ID-Src2"), 1);
        assert_eq!(class_index_of_source(&net.nodes, "nobody"), 0);
    }
}
