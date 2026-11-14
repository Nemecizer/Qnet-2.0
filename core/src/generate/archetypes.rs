//! The archetype library: the five starting networks the gallery offers (0.90.34
//! `NetworkArchetypes.swift`).
//!
//! Every archetype obeys three rules the rest of the app depends on. Each station is fed by its
//! own buffer and nothing else, so feedback arcs go to a buffer, never to a station. Service rates
//! are solved from the traffic equations as μ = α / (ρ · c), so every station sits at exactly the
//! ρ asked for. And there is one source, one class and exponential service everywhere, so with
//! infinite buffers the network is an exact Jackson network with a closed-form answer.
//!
//! [`archetype`] is the network as 0.90.34's builder made it, with the block's source column at
//! x = 80 on the main row. [`archetype_as_inserted`] is what Insert Archetype put on an empty
//! canvas: the same network moved so its top-left corner is at (80, 220), which only shifts the
//! Fork and Merge, whose upper branch sits 90 pt above the row. Inserting next to an existing
//! network (moved clear of it, numbering continued, classes remapped) is the editor's business
//! (ledger CAN-184), not this module's.

use super::layout::{SINK_GAP, X_ROW_START, X_SOURCE_COLUMN, X_STEP, Y_ROW};
use super::{swift_max, swift_min, IdSource};
use crate::cfmt;
use crate::model::{Distribution, Link, Network, Node, NodeKind};

/// The starting networks, in catalogue order. The raw values are 0.90.34's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Archetype {
    /// One station with c servers: M/M/c.
    MmcStation,
    /// d stations in series, no feedback.
    TandemLine,
    /// One station splitting evenly into two parallel stations.
    ForkStyleSplit,
    /// A tandem line where each station reworks a fraction p of its own output.
    OpenJacksonFeedback,
    /// Two stations with a routing cycle between them.
    ReentrantTwoStation,
}

impl Archetype {
    pub const ALL: [Archetype; 5] = [
        Archetype::MmcStation,
        Archetype::TandemLine,
        Archetype::ForkStyleSplit,
        Archetype::OpenJacksonFeedback,
        Archetype::ReentrantTwoStation,
    ];

    pub fn raw(self) -> &'static str {
        match self {
            Archetype::MmcStation => "mmcStation",
            Archetype::TandemLine => "tandemLine",
            Archetype::ForkStyleSplit => "forkStyleSplit",
            Archetype::OpenJacksonFeedback => "openJacksonFeedback",
            Archetype::ReentrantTwoStation => "reentrantTwoStation",
        }
    }

    pub fn from_raw(s: &str) -> Option<Archetype> {
        Archetype::ALL.into_iter().find(|a| a.raw() == s)
    }
}

/// A knob the gallery can show. A blueprint lists the ones that change the network it builds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Knob {
    Stations,
    Servers,
    TargetRho,
    FeedbackProbability,
    Buffers,
    ArrivalRate,
}

impl Knob {
    pub fn raw(self) -> &'static str {
        match self {
            Knob::Stations => "stations",
            Knob::Servers => "servers",
            Knob::TargetRho => "targetRho",
            Knob::FeedbackProbability => "feedbackProbability",
            Knob::Buffers => "buffers",
            Knob::ArrivalRate => "arrivalRate",
        }
    }
}

/// One gallery entry: its section, title, one-line route and knobs.
#[derive(Clone, Debug, PartialEq)]
pub struct Blueprint {
    pub id: Archetype,
    pub group: &'static str,
    pub title: &'static str,
    pub subtitle: &'static str,
    pub knobs: &'static [Knob],
}

impl Blueprint {
    pub fn uses(&self, knob: Knob) -> bool {
        self.knobs.contains(&knob)
    }
}

/// The catalogue, in gallery order (0.90.34 `NetworkArchetypeBuilder.blueprints`).
pub const BLUEPRINTS: [Blueprint; 5] = [
    Blueprint {
        id: Archetype::MmcStation,
        group: "Single Station",
        title: "M/M/c Station",
        subtitle: "Src1 → B1 → S1 → Sink1, with c parallel servers",
        knobs: &[Knob::Servers, Knob::TargetRho, Knob::ArrivalRate, Knob::Buffers],
    },
    Blueprint {
        id: Archetype::TandemLine,
        group: "Lines",
        title: "Tandem Line",
        subtitle: "Src1 → B1 → S1 → … → Sd → Sink1, every station at the same ρ",
        knobs: &[Knob::Stations, Knob::Servers, Knob::TargetRho, Knob::ArrivalRate, Knob::Buffers],
    },
    Blueprint {
        id: Archetype::ForkStyleSplit,
        group: "Lines",
        title: "Fork and Merge",
        subtitle: "S1 splits its output evenly into S2 and S3, both to Sink1",
        knobs: &[Knob::Servers, Knob::TargetRho, Knob::ArrivalRate, Knob::Buffers],
    },
    Blueprint {
        id: Archetype::OpenJacksonFeedback,
        group: "Feedback",
        title: "Line with Rework",
        subtitle: "Every station returns a fraction p of its output to its own buffer",
        knobs: &[
            Knob::Stations,
            Knob::Servers,
            Knob::TargetRho,
            Knob::FeedbackProbability,
            Knob::ArrivalRate,
            Knob::Buffers,
        ],
    },
    Blueprint {
        id: Archetype::ReentrantTwoStation,
        group: "Feedback",
        title: "Re-entrant Pair",
        subtitle: "S1 → S2, and S2 sends a fraction p back to B1 — a two-station cycle",
        knobs: &[Knob::Servers, Knob::TargetRho, Knob::FeedbackProbability, Knob::ArrivalRate, Knob::Buffers],
    },
];

/// The catalogue entry for an archetype.
pub fn blueprint(archetype: Archetype) -> &'static Blueprint {
    BLUEPRINTS.iter().find(|b| b.id == archetype).unwrap_or(&BLUEPRINTS[0])
}

/// The gallery's sections in catalogue order: "Single Station", "Lines", "Feedback".
pub fn groups() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for b in &BLUEPRINTS {
        if !out.contains(&b.group) {
            out.push(b.group);
        }
    }
    out
}

/// The values behind the knobs. Every field is clamped to its range before building
/// ([`ArchetypeParameters::clamped`]), whatever the caller passes.
#[derive(Clone, Debug, PartialEq)]
pub struct ArchetypeParameters {
    /// Stations in a line (Tandem Line, Line with Rework), 1–12; default 3.
    pub stations: i64,
    /// Servers at every station, 1–16; default 1.
    pub servers: i64,
    /// The utilisation of every station, 0.05–0.99; default 0.9.
    pub target_rho: f64,
    /// The fraction fed back (Line with Rework, Re-entrant Pair), 0–0.9; default 0.3. At 0 the
    /// feedback link is left out.
    pub feedback_probability: f64,
    /// Infinite buffers (each buffer size 1) or finite ones of `buffer_capacity`; default infinite.
    pub infinite_buffers: bool,
    /// The waiting room of every buffer when buffers are finite, 1–500; default 10.
    pub buffer_capacity: i64,
    /// The source's rate λ, 0.001–1000; default 1.
    pub arrival_rate: f64,
}

impl Default for ArchetypeParameters {
    fn default() -> ArchetypeParameters {
        ArchetypeParameters {
            stations: 3,
            servers: 1,
            target_rho: 0.9,
            feedback_probability: 0.3,
            infinite_buffers: true,
            buffer_capacity: 10,
            arrival_rate: 1.0,
        }
    }
}

impl ArchetypeParameters {
    pub const STATION_RANGE: (i64, i64) = (1, 12);
    pub const SERVER_RANGE: (i64, i64) = (1, 16);
    /// Stops short of 1, the edge of instability.
    pub const RHO_RANGE: (f64, f64) = (0.05, 0.99);
    /// Stops short of 1, where α = λ / (1 − p) diverges.
    pub const FEEDBACK_RANGE: (f64, f64) = (0.0, 0.9);
    pub const CAPACITY_RANGE: (i64, i64) = (1, 500);
    pub const ARRIVAL_RATE_RANGE: (f64, f64) = (0.001, 1000.0);

    /// A copy with every value held to its range. A NaN stays NaN, as in 0.90.34.
    pub fn clamped(&self) -> ArchetypeParameters {
        let clamp_f = |x: f64, (lo, hi): (f64, f64)| swift_min(swift_max(x, lo), hi);
        let clamp_i = |x: i64, (lo, hi): (i64, i64)| x.max(lo).min(hi);
        ArchetypeParameters {
            stations: clamp_i(self.stations, Self::STATION_RANGE),
            servers: clamp_i(self.servers, Self::SERVER_RANGE),
            target_rho: clamp_f(self.target_rho, Self::RHO_RANGE),
            feedback_probability: clamp_f(self.feedback_probability, Self::FEEDBACK_RANGE),
            infinite_buffers: self.infinite_buffers,
            buffer_capacity: clamp_i(self.buffer_capacity, Self::CAPACITY_RANGE),
            arrival_rate: clamp_f(self.arrival_rate, Self::ARRIVAL_RATE_RANGE),
        }
    }
}

/// Where the block's top-left corner goes on an empty canvas: the source column, on the main row.
pub const CANVAS_ORIGIN: (f64, f64) = (X_SOURCE_COLUMN, Y_ROW);

/// How far a parallel branch sits from the main row: half a station column.
const BRANCH_OFFSET: f64 = 90.0;

/// The archetype as 0.90.34's builder made it (`NetworkArchetypeBuilder.build` at the canvas
/// origin). Ids are drawn in the order it created nodes and links.
pub fn archetype(kind: Archetype, params: &ArchetypeParameters, ids: &mut impl IdSource) -> Network {
    let p = params.clamped();
    let mut a = Assembly { params: &p, origin: CANVAS_ORIGIN, ids, nodes: Vec::new(), links: Vec::new() };
    match kind {
        Archetype::MmcStation => build_chain(&mut a, 1),
        Archetype::TandemLine => build_chain(&mut a, p.stations as usize),
        Archetype::OpenJacksonFeedback => build_rework(&mut a),
        Archetype::ReentrantTwoStation => build_reentrant_pair(&mut a),
        Archetype::ForkStyleSplit => build_fork(&mut a),
    }
    let (nodes, links) = (a.nodes, a.links);
    Network { nodes, links, infinite_buffers: p.infinite_buffers, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
}

/// What Insert Archetype put on an empty canvas: the built network renamed in node order (S1…,
/// B1…, Src1, Sink1, which is how it was built), moved so the block's top-left corner is at
/// [`CANVAS_ORIGIN`], with the archetype's buffer regime (`insertSubnetwork` on an empty
/// document).
pub fn archetype_as_inserted(kind: Archetype, params: &ArchetypeParameters, ids: &mut impl IdSource) -> Network {
    let mut net = archetype(kind, params, ids);
    let min_x = net.nodes.iter().map(|n| n.position.0).fold(f64::INFINITY, f64::min);
    let min_y = net.nodes.iter().map(|n| n.position.1).fold(f64::INFINITY, f64::min);
    let (dx, dy) = (CANVAS_ORIGIN.0 - min_x, CANVAS_ORIGIN.1 - min_y);
    let mut counts = [0usize; 4];
    for n in &mut net.nodes {
        let (slot, prefix) = match n.kind {
            NodeKind::Station => (0, "S"),
            NodeKind::Buffer => (1, "B"),
            NodeKind::Source => (2, "Src"),
            NodeKind::Sink => (3, "Sink"),
        };
        counts[slot] += 1;
        n.name = format!("{prefix}{}", counts[slot]);
        n.position = (n.position.0 + dx, n.position.1 + dy);
    }
    net
}

/// The one-line summary the gallery's footer and the insert's status line show: "3 stations,
/// 8 nodes, 7 links, λ = 1.000, ρ = 0.900 at every station" (`NetworkArchetypeBuilder.summary`).
pub fn summary(kind: Archetype, params: &ArchetypeParameters) -> String {
    let p = params.clamped();
    let mut n = 0u64;
    let net = archetype(kind, &p, &mut || {
        n += 1;
        n.to_string()
    });
    let stations = net.nodes_of(NodeKind::Station).count();
    format!(
        "{stations} station{}, {} nodes, {} links, λ = {}, ρ = {} at every station",
        if stations == 1 { "" } else { "s" },
        net.nodes.len(),
        net.links.len(),
        display_number(p.arrival_rate, 3),
        display_number(p.target_rho, 3)
    )
}

/// 0.90.34's `DS.Number.display`: fixed decimals, scientific below 10⁻ᵈ or from 1e9, no "-0".
fn display_number(value: f64, decimals: i64) -> String {
    if value.is_nan() {
        return "—".into();
    }
    if value.is_infinite() {
        return if value < 0.0 { "-∞".into() } else { "∞".into() };
    }
    let d = decimals.clamp(0, 9);
    let small = d > 0 && value.abs() < 10f64.powf(-(d as f64));
    let large = value.abs() >= 1e9;
    let text = if value != 0.0 && (small || large) {
        cfmt::f(&format!("%.{}e", (d - 1).max(1)), value)
    } else {
        cfmt::f(&format!("%.{d}f"), value)
    };
    match text.strip_prefix('-') {
        Some(rest) if rest.parse::<f64>() == Ok(0.0) => rest.to_string(),
        _ => text,
    }
}

/// μ = α / (ρ · c): the rate that puts a station carrying α at the target.
fn service_rate(alpha: f64, p: &ArchetypeParameters) -> f64 {
    alpha / (p.target_rho * p.servers as f64)
}

/// A rate as a parameter value: `%.8g`, with ".0" added when there is no point or exponent, so
/// λ = 1 reads "1.0" and λ/0.9 reads "1.1111111".
fn rate_literal(value: f64) -> String {
    let text = cfmt::f("%.8g", value);
    if text.contains('.') || text.contains('e') {
        text
    } else {
        text + ".0"
    }
}

/// Accumulates nodes and links on the shared grid: the source has its own column, column i is the
/// i-th buffer/station pair, the sink takes the column after the last, and `row` counts branch
/// offsets from the main row.
struct Assembly<'a, I: IdSource> {
    params: &'a ArchetypeParameters,
    origin: (f64, f64),
    ids: &'a mut I,
    nodes: Vec<Node>,
    links: Vec<Link>,
}

/// Indexes of one buffer/station pair in `Assembly::nodes`.
#[derive(Clone, Copy)]
struct Stage {
    buffer: usize,
    station: usize,
}

impl<I: IdSource> Assembly<'_, I> {
    fn point(&self, x: f64, row: i64) -> (f64, f64) {
        let dx = self.origin.0 - X_SOURCE_COLUMN;
        let dy = self.origin.1 - Y_ROW;
        (x + dx, Y_ROW + row as f64 * BRANCH_OFFSET + dy)
    }

    fn buffer_x(column: usize) -> f64 {
        X_ROW_START + column as f64 * X_STEP
    }

    fn add_source(&mut self, rate: f64) -> usize {
        let mut n = Node::new(self.ids.next_id(), NodeKind::Source, "Src1", self.point(X_SOURCE_COLUMN, 0));
        n.distribution = Distribution::Poisson;
        n.parameters = format!("lambda={}", rate_literal(rate));
        self.nodes.push(n);
        self.nodes.len() - 1
    }

    /// A buffer and its station, and the buffer → station link every station needs.
    fn add_stage(&mut self, index: usize, column: usize, row: i64, mu: f64) -> Stage {
        let x_b = Self::buffer_x(column);
        let mut buffer = Node::new(self.ids.next_id(), NodeKind::Buffer, format!("B{index}"), self.point(x_b, row));
        buffer.buffer_size = if self.params.infinite_buffers { 1 } else { self.params.buffer_capacity };
        let mut station =
            Node::new(self.ids.next_id(), NodeKind::Station, format!("S{index}"), self.point(x_b + X_STEP / 2.0, row));
        station.servers = self.params.servers;
        station.parameters = format!("rate={}", rate_literal(mu));
        self.nodes.push(buffer);
        self.nodes.push(station);
        let stage = Stage { buffer: self.nodes.len() - 2, station: self.nodes.len() - 1 };
        self.link(stage.buffer, stage.station, 1.0);
        stage
    }

    fn add_sink(&mut self, column: usize) -> usize {
        let position = self.point(Self::buffer_x(column) + SINK_GAP, 0);
        self.nodes.push(Node::new(self.ids.next_id(), NodeKind::Sink, "Sink1", position));
        self.nodes.len() - 1
    }

    fn link(&mut self, from: usize, to: usize, probability: f64) {
        let id = self.ids.next_id();
        self.links.push(Link {
            id,
            from: self.nodes[from].id.clone(),
            to: self.nodes[to].id.clone(),
            probability,
            class: 0,
            to_class: None,
        });
    }
}

/// Src1 → B1 → S1 → … → Sd → Sink1. Every station carries λ.
fn build_chain<I: IdSource>(a: &mut Assembly<'_, I>, d: usize) {
    let lambda = a.params.arrival_rate;
    let source = a.add_source(lambda);
    let mu = service_rate(lambda, a.params);
    let mut previous = source;
    for i in 0..d {
        let stage = a.add_stage(i + 1, i, 0, mu);
        a.link(previous, stage.buffer, 1.0);
        previous = stage.station;
    }
    let sink = a.add_sink(d);
    a.link(previous, sink, 1.0);
}

/// A line where every station sends p back to its own buffer and 1 − p on; every station carries
/// α = λ / (1 − p).
fn build_rework<I: IdSource>(a: &mut Assembly<'_, I>) {
    let p = a.params;
    let d = p.stations as usize;
    let forward = 1.0 - p.feedback_probability;
    let mu = service_rate(p.arrival_rate / swift_max(forward, 1e-9), p);
    let source = a.add_source(p.arrival_rate);
    let stages: Vec<Stage> = (0..d).map(|i| a.add_stage(i + 1, i, 0, mu)).collect();
    let sink = a.add_sink(d);
    a.link(source, stages[0].buffer, 1.0);
    for (i, stage) in stages.iter().enumerate() {
        // The rework arc first: link order is the order the inspector lists them in.
        if p.feedback_probability > 0.0 {
            a.link(stage.station, stage.buffer, p.feedback_probability);
        }
        let next = if i + 1 < stages.len() { stages[i + 1].buffer } else { sink };
        a.link(stage.station, next, forward);
    }
}

/// S1 → S2, and S2 sends p back to B1 and 1 − p to the sink; both carry α = λ / (1 − p).
fn build_reentrant_pair<I: IdSource>(a: &mut Assembly<'_, I>) {
    let p = a.params;
    let forward = 1.0 - p.feedback_probability;
    let mu = service_rate(p.arrival_rate / swift_max(forward, 1e-9), p);
    let source = a.add_source(p.arrival_rate);
    let first = a.add_stage(1, 0, 0, mu);
    let second = a.add_stage(2, 1, 0, mu);
    let sink = a.add_sink(2);
    a.link(source, first.buffer, 1.0);
    a.link(first.station, second.buffer, 1.0);
    if p.feedback_probability > 0.0 {
        a.link(second.station, first.buffer, p.feedback_probability);
    }
    a.link(second.station, sink, forward);
}

/// S1 splits evenly between two branch stations above and below the row, both to the sink; the
/// branches carry λ/2 and are served at half S1's rate.
fn build_fork<I: IdSource>(a: &mut Assembly<'_, I>) {
    let p = a.params;
    let half = 0.5;
    let source = a.add_source(p.arrival_rate);
    let entry = a.add_stage(1, 0, 0, service_rate(p.arrival_rate, p));
    let branch_rate = service_rate(p.arrival_rate * half, p);
    let upper = a.add_stage(2, 1, -1, branch_rate);
    let lower = a.add_stage(3, 1, 1, branch_rate);
    let sink = a.add_sink(2);
    a.link(source, entry.buffer, 1.0);
    a.link(entry.station, upper.buffer, half);
    a.link(entry.station, lower.buffer, half);
    a.link(upper.station, sink, 1.0);
    a.link(lower.station, sink, 1.0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::CountingIds;
    use crate::traffic;

    fn build(kind: Archetype, p: &ArchetypeParameters) -> Network {
        archetype(kind, p, &mut CountingIds::new())
    }

    fn knobs(
        stations: i64,
        servers: i64,
        rho: f64,
        fb: f64,
        infinite: bool,
        cap: i64,
        lambda: f64,
    ) -> ArchetypeParameters {
        ArchetypeParameters {
            stations,
            servers,
            target_rho: rho,
            feedback_probability: fb,
            infinite_buffers: infinite,
            buffer_capacity: cap,
            arrival_rate: lambda,
        }
    }

    fn settings() -> Vec<ArchetypeParameters> {
        vec![
            ArchetypeParameters::default(),
            knobs(1, 1, 0.05, 0.0, false, 1, 0.001),
            knobs(12, 16, 0.99, 0.9, true, 500, 1000.0),
            knobs(5, 3, 0.75, 0.45, false, 25, 2.5),
        ]
    }

    #[test]
    fn the_defaults_are_0_90_34s() {
        let p = ArchetypeParameters::default();
        assert_eq!((p.stations, p.servers, p.target_rho, p.feedback_probability), (3, 1, 0.9, 0.3));
        assert_eq!((p.infinite_buffers, p.buffer_capacity, p.arrival_rate), (true, 10, 1.0));
    }

    #[test]
    fn every_knob_is_clamped_to_its_range() {
        let low = knobs(0, -4, 0.0, -1.0, false, 0, 0.0).clamped();
        assert_eq!(low, knobs(1, 1, 0.05, 0.0, false, 1, 0.001));
        let high = knobs(99, 99, 1.5, 1.0, true, 9999, 1e9).clamped();
        assert_eq!(high, knobs(12, 16, 0.99, 0.9, true, 500, 1000.0));
        let inside = knobs(5, 3, 0.75, 0.45, false, 25, 2.5);
        assert_eq!(inside.clamped(), inside);
        assert!(
            knobs(3, 1, f64::NAN, 0.3, true, 10, 1.0).clamped().target_rho.is_nan(),
            "NaN passes through, as in Swift"
        );
    }

    #[test]
    fn the_catalogue_is_in_gallery_order_with_its_sections() {
        let ids: Vec<&str> = BLUEPRINTS.iter().map(|b| b.id.raw()).collect();
        assert_eq!(ids, ["mmcStation", "tandemLine", "forkStyleSplit", "openJacksonFeedback", "reentrantTwoStation"]);
        assert_eq!(groups(), ["Single Station", "Lines", "Feedback"]);
        assert!(blueprint(Archetype::TandemLine).uses(Knob::Stations));
        assert!(!blueprint(Archetype::MmcStation).uses(Knob::Stations));
        assert!(!blueprint(Archetype::ForkStyleSplit).uses(Knob::FeedbackProbability));
        for a in Archetype::ALL {
            assert_eq!(Archetype::from_raw(a.raw()), Some(a));
        }
    }

    #[test]
    fn rates_are_written_with_eight_significant_digits_and_a_point() {
        assert_eq!(rate_literal(1.0), "1.0");
        assert_eq!(rate_literal(1.0 / 0.9), "1.1111111");
        assert_eq!(rate_literal(1000.0), "1000.0");
        assert_eq!(rate_literal(1e9), "1e+09");
        assert_eq!(rate_literal(0.001), "0.001");
    }

    #[test]
    fn the_summary_counts_the_built_network_and_shows_three_decimals() {
        let p = ArchetypeParameters::default();
        assert_eq!(
            summary(Archetype::TandemLine, &p),
            "3 stations, 8 nodes, 7 links, λ = 1.000, ρ = 0.900 at every station"
        );
        assert_eq!(
            summary(Archetype::MmcStation, &p),
            "1 station, 4 nodes, 3 links, λ = 1.000, ρ = 0.900 at every station"
        );
        assert_eq!(
            summary(Archetype::MmcStation, &knobs(1, 1, 0.0, 0.0, true, 1, 0.0)),
            "1 station, 4 nodes, 3 links, λ = 0.001, ρ = 0.050 at every station",
            "the summary is of the clamped values"
        );
        assert_eq!(display_number(-0.0001, 3), "-1.00e-04");
        assert_eq!(display_number(-0.0, 3), "0.000");
        assert_eq!(display_number(2e9, 3), "2.00e+09");
    }

    #[test]
    fn every_station_is_fed_by_exactly_one_buffer_its_own() {
        for kind in Archetype::ALL {
            for p in settings() {
                let net = build(kind, &p);
                for s in net.nodes_of(NodeKind::Station) {
                    let feeders: Vec<&Node> =
                        net.links.iter().filter(|l| l.to == s.id).map(|l| net.node(&l.from).unwrap()).collect();
                    assert!(
                        feeders.iter().all(|f| f.kind == NodeKind::Buffer && f.name[1..] == s.name[1..]),
                        "{kind:?} {}",
                        s.name
                    );
                }
            }
        }
    }

    #[test]
    fn every_row_sums_to_one_and_every_link_is_class_zero() {
        for kind in Archetype::ALL {
            for p in settings() {
                let net = build(kind, &p);
                assert!(net.links.iter().all(|l| l.class == 0 && l.to_class.is_none()));
                for n in net.nodes.iter().filter(|n| n.kind != NodeKind::Sink) {
                    let sum: f64 = net.links.iter().filter(|l| l.from == n.id).map(|l| l.probability).sum();
                    assert!((sum - 1.0).abs() < 1e-12, "{kind:?} {}: {sum}", n.name);
                }
            }
        }
    }

    #[test]
    fn every_station_sits_at_the_target_rho() {
        for kind in Archetype::ALL {
            for p in settings() {
                let net = build(kind, &p);
                let data = traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
                for i in 0..data.d {
                    assert!((data.rho(i) - p.target_rho).abs() < 1e-6, "{kind:?} {p:?}: ρ{i} = {}", data.rho(i));
                }
            }
        }
    }

    #[test]
    fn a_feedback_probability_of_zero_leaves_the_feedback_link_out() {
        let p = knobs(3, 1, 0.9, 0.0, true, 10, 1.0);
        assert_eq!(build(Archetype::OpenJacksonFeedback, &p).links.len(), 7);
        assert_eq!(build(Archetype::OpenJacksonFeedback, &ArchetypeParameters::default()).links.len(), 10);
        assert_eq!(build(Archetype::ReentrantTwoStation, &p).links.len(), 5);
    }

    #[test]
    fn finite_buffers_take_the_capacity_and_infinite_ones_size_one() {
        let finite = build(Archetype::TandemLine, &knobs(2, 2, 0.9, 0.3, false, 25, 1.0));
        assert!(!finite.infinite_buffers);
        assert!(finite.nodes_of(NodeKind::Buffer).all(|b| b.buffer_size == 25));
        assert!(finite.nodes_of(NodeKind::Station).all(|s| s.servers == 2 && s.buffer_size == 1));
        let infinite = build(Archetype::TandemLine, &ArchetypeParameters::default());
        assert!(infinite.nodes_of(NodeKind::Buffer).all(|b| b.buffer_size == 1));
    }

    #[test]
    fn the_fork_is_built_around_the_row_and_inserted_below_the_origin() {
        let built = build(Archetype::ForkStyleSplit, &ArchetypeParameters::default());
        let ys: Vec<f64> = built.nodes.iter().map(|n| n.position.1).collect();
        assert_eq!(ys, [220.0, 220.0, 220.0, 130.0, 130.0, 310.0, 310.0, 220.0]);
        let inserted =
            archetype_as_inserted(Archetype::ForkStyleSplit, &ArchetypeParameters::default(), &mut CountingIds::new());
        let ys: Vec<f64> = inserted.nodes.iter().map(|n| n.position.1).collect();
        assert_eq!(ys, [310.0, 310.0, 310.0, 220.0, 220.0, 400.0, 400.0, 310.0]);
        for kind in [
            Archetype::MmcStation,
            Archetype::TandemLine,
            Archetype::OpenJacksonFeedback,
            Archetype::ReentrantTwoStation,
        ] {
            let p = ArchetypeParameters::default();
            assert_eq!(
                archetype_as_inserted(kind, &p, &mut CountingIds::new()),
                build(kind, &p),
                "{kind:?} already starts at the origin"
            );
        }
    }
}
