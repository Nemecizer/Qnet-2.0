//! A random multi-class open network at a target utilisation (0.90.34 `RandomNetworkGenerator`).
//!
//! Each customer class gets one Poisson source and its own routing matrix; every (station, class)
//! pair gets a random service law with mean about 1; and the external arrival rates are solved so
//! that every station sits at the target ρ, or below it where the routing pushes more work into a
//! station than the target allows. The layout is one row: the sources stacked on the left, then
//! B1 → S1 → B2 → S2 → … → Sd, then the sink.
//!
//! The four topologies decide which routing entries can be positive:
//!
//! - feed-forward: station i routes only to later stations and the sink;
//! - Jackson feedback: feed-forward plus, from every station but the first, 0.05–0.20 back to one
//!   random earlier station;
//! - general P-matrix: every station routes to every other station, keeping 0.30–0.60 for the sink;
//! - re-entrant: feed-forward rows, plus for each class, with probability 0.6, one class-change
//!   link back to an earlier buffer.
//!
//! Whatever the topology, a routing entry that points back to an earlier station is not kept as a
//! same-class link: it becomes a class-change link onto a new derived class, which has its own
//! feed-forward rows from that station on and its own service laws. So every generated network's
//! class-expanded routing is feed-forward, and "feedback" networks are re-entrant multi-class
//! lines.
//!
//! What the target promises (checked by `traffic::compute` in the tests): for feed-forward and
//! re-entrant networks the busiest station is at the target ρ; for the other two topologies no
//! station is above it, and the busiest may be below it, because the backward entries' derived
//! classes don't carry the load the target was solved for. Source rates are printed to six
//! decimals and service parameters to three or four, so "at" means within about 1e-5.
//!
//! One change from 0.90.34 (ledger GEN-022, decision D5): a one-station general P-matrix network
//! routed only its sink probability (0.30–0.60) out of the station, a row that didn't sum to 1;
//! here the row is 1 to the sink. The same random number is still drawn, so every other value,
//! and every larger network, comes out as 0.90.34 made it.

// The loops index as 0.90.34's did, so the arithmetic happens in the same order, and its guards
// are kept as negated comparisons (`!(a > b)`), which treat NaN as Swift's `guard a > b` did.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use std::collections::{BTreeMap, BTreeSet};

use super::layout::{SINK_GAP, SOURCE_SPACING, X_ROW_START, X_SOURCE_COLUMN, X_STEP, Y_ROW};
use super::rng::SplitMix64;
use super::{swift_max, IdSource};
use crate::cfmt;
use crate::model::{Distribution, Link, Network, Node, NodeKind, ServiceConfig, StationPicture};

/// The routing structure of a generated network. The raw values are what 0.90.34 stored in its
/// test-set settings (`Topology.rawValue`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Topology {
    FeedForward,
    JacksonFeedback,
    GeneralPMatrix,
    ReentrantFeedback,
}

impl Topology {
    pub const ALL: [Topology; 4] =
        [Topology::FeedForward, Topology::JacksonFeedback, Topology::GeneralPMatrix, Topology::ReentrantFeedback];

    /// 0, 1, 2, 3, in the order above.
    pub fn raw(self) -> i64 {
        match self {
            Topology::FeedForward => 0,
            Topology::JacksonFeedback => 1,
            Topology::GeneralPMatrix => 2,
            Topology::ReentrantFeedback => 3,
        }
    }

    pub fn from_raw(raw: i64) -> Option<Topology> {
        Topology::ALL.into_iter().find(|t| t.raw() == raw)
    }

    /// The word `Qnet --gen-random` takes: "ff", "jfb", "gp" or "reent".
    pub fn cli_tag(self) -> &'static str {
        match self {
            Topology::FeedForward => "ff",
            Topology::JacksonFeedback => "jfb",
            Topology::GeneralPMatrix => "gp",
            Topology::ReentrantFeedback => "reent",
        }
    }

    pub fn from_cli_tag(tag: &str) -> Option<Topology> {
        Topology::ALL.into_iter().find(|t| t.cli_tag() == tag)
    }
}

/// What to generate. The defaults are 0.90.34's: 4 stations, 3 classes, infinite buffers, ρ 0.9,
/// feed-forward, no seed.
#[derive(Clone, Debug, PartialEq)]
pub struct Parameters {
    /// Service stations d. The generator takes any value and uses at least 1; the Generate Random
    /// Network sheet offered 1–20 ([`Parameters::STATION_RANGE`]).
    pub stations: i64,
    /// Customer classes K, one source each. At least 1 is used; the sheet offered 1–8.
    pub classes: i64,
    /// Infinite buffers give each buffer size 1; finite buffers give each a capacity of 10.
    pub infinite_buffers: bool,
    /// The utilisation every station is scaled towards. Not clamped by the generator; the sheet
    /// accepted 0.10–0.99.
    pub target_rho: f64,
    pub topology: Topology,
    /// The same seed and parameters give the same network, the one 0.90.34 gave. None draws a
    /// fresh seed.
    pub seed: Option<u64>,
}

impl Default for Parameters {
    fn default() -> Parameters {
        Parameters {
            stations: 4,
            classes: 3,
            infinite_buffers: true,
            target_rho: 0.9,
            topology: Topology::FeedForward,
            seed: None,
        }
    }
}

impl Parameters {
    /// The sheet's station range (0.90.34 `GenerateRandomNetworkSheet.stationRange`).
    pub const STATION_RANGE: (i64, i64) = (1, 20);
    /// The sheet's class range.
    pub const CLASS_RANGE: (i64, i64) = (1, 8);
    /// The sheet's ρ range.
    pub const RHO_RANGE: (f64, f64) = (0.1, 0.99);

    /// A copy with stations, classes and ρ held to the sheet's ranges, as the sheet's Generate
    /// button did before calling the generator.
    pub fn sheet_clamped(&self) -> Parameters {
        let mut p = self.clone();
        p.stations = self.stations.clamp(Self::STATION_RANGE.0, Self::STATION_RANGE.1);
        p.classes = self.classes.clamp(Self::CLASS_RANGE.0, Self::CLASS_RANGE.1);
        p.target_rho = swift_max(Self::RHO_RANGE.0, super::swift_min(Self::RHO_RANGE.1, self.target_rho));
        p
    }
}

/// A seed for a network nobody asked to reproduce, from the process's randomly keyed hasher and
/// the clock.
pub fn fresh_seed() -> u64 {
    use std::hash::BuildHasher;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    std::collections::hash_map::RandomState::new().hash_one(now)
}

/// One class-change edge: jobs of `from_class` leaving station `src_station` go to buffer
/// `to_buffer` as `to_class` with probability `prob`.
struct ClassTransition {
    from_class: usize,
    src_station: usize,
    to_buffer: usize,
    to_class: usize,
    prob: f64,
}

/// The arrays the post-passes grow as derived classes are added.
struct Expansion {
    d: usize,
    /// p[k][i][j]: class k from station i to station j (j < d) or the sink (j == d).
    p: Vec<Vec<Vec<f64>>>,
    service_rate: Vec<Vec<f64>>,
    lambda_ext: Vec<Vec<f64>>,
    transitions: Vec<ClassTransition>,
    k_total: usize,
}

impl Expansion {
    /// Adds a derived class entered from (from_class, src_station) at to_buffer, with its own
    /// feed-forward rows from that station on and a fresh service law at every station
    /// (`addClassTransition`).
    fn add_transition(
        &mut self,
        rng: &mut SplitMix64,
        stations: &mut [Node],
        from_class: usize,
        src_station: usize,
        to_buffer: usize,
        prob: f64,
    ) {
        let d = self.d;
        let derived = self.k_total;
        self.k_total += 1;
        self.transitions.push(ClassTransition { from_class, src_station, to_buffer, to_class: derived, prob });

        let mut rows = vec![vec![0.0; d + 1]; d];
        for (i, row) in rows.iter_mut().enumerate().skip(to_buffer) {
            *row = sample_routing_row(i, d, Topology::FeedForward, rng);
        }
        self.p.push(rows);

        let mut rates = vec![1.0; d];
        for (i, station) in stations.iter_mut().enumerate() {
            let cfg = random_service_config(rng);
            rates[i] = mean_service_rate(Some(&cfg));
            station.service_by_class.insert(derived as i64, cfg);
        }
        self.service_rate.push(rates);
        self.lambda_ext.push(vec![0.0; d]);
    }
}

/// Generates a network (0.90.34 `RandomNetworkGenerator.generate`). Nodes come back as the sources,
/// the buffers, the stations, then the sink; ids are drawn from `ids` in the order 0.90.34 created
/// them (each source, then each buffer and its station, the sink, then every link).
pub fn generate(params: &Parameters, ids: &mut impl IdSource) -> Network {
    let mut rng = SplitMix64::new(params.seed.unwrap_or_else(fresh_seed));
    let d = params.stations.max(1) as usize;
    let k_primary = params.classes.max(1) as usize;

    // Nodes.
    let column_height = (k_primary - 1) as f64 * SOURCE_SPACING;
    let y_top = Y_ROW - column_height / 2.0;
    let mut sources: Vec<Node> = (0..k_primary)
        .map(|k| {
            let y = if k_primary == 1 { Y_ROW } else { y_top + k as f64 * SOURCE_SPACING };
            let mut n = Node::new(ids.next_id(), NodeKind::Source, format!("Src{}", k + 1), (X_SOURCE_COLUMN, y));
            n.distribution = Distribution::Poisson;
            n.parameters = "lambda=1.0".into();
            n
        })
        .collect();

    let mut buffers = Vec::with_capacity(d);
    let mut stations = Vec::with_capacity(d);
    for i in 0..d {
        let x_b = X_ROW_START + i as f64 * X_STEP;
        let x_s = x_b + X_STEP / 2.0;
        let mut b = Node::new(ids.next_id(), NodeKind::Buffer, format!("B{}", i + 1), (x_b, Y_ROW));
        b.buffer_size = if params.infinite_buffers { 1 } else { 10 };
        buffers.push(b);

        let svc: BTreeMap<i64, ServiceConfig> =
            (0..k_primary).map(|k| (k as i64, random_service_config(&mut rng))).collect();
        let mut s = Node::new(ids.next_id(), NodeKind::Station, format!("S{}", i + 1), (x_s, Y_ROW));
        s.distribution = svc[&0].distribution;
        s.parameters = svc[&0].parameters.clone();
        s.service_by_class = svc;
        stations.push(s);
    }
    let sink = Node::new(ids.next_id(), NodeKind::Sink, "Sink1", (X_ROW_START + d as f64 * X_STEP + SINK_GAP, Y_ROW));

    // Routing per class. The re-entrant topology starts from feed-forward rows.
    let routing_topology =
        if params.topology == Topology::ReentrantFeedback { Topology::FeedForward } else { params.topology };
    let mut p = vec![vec![vec![0.0; d + 1]; d]; k_primary];
    for class_rows in p.iter_mut() {
        for (i, row) in class_rows.iter_mut().enumerate() {
            *row = sample_routing_row(i, d, routing_topology, &mut rng);
        }
    }

    let service_rate: Vec<Vec<f64>> = (0..k_primary)
        .map(|k| (0..d).map(|i| mean_service_rate(stations[i].service_by_class.get(&(k as i64)))).collect())
        .collect();

    // Target ρ at every station: each class brings (ρ/K)·μ of work, and λ = (I − Pᵀ)α with
    // negatives clamped to zero.
    let target = params.target_rho;
    let mut lambda_ext = vec![vec![0.0; d]; k_primary];
    for k in 0..k_primary {
        let alpha_target: Vec<f64> = (0..d).map(|i| (target / k_primary as f64) * service_rate[k][i]).collect();
        for i in 0..d {
            let mut lam = alpha_target[i];
            for j in (0..d).filter(|&j| j != i) {
                lam -= p[k][j][i] * alpha_target[j];
            }
            lambda_ext[k][i] = swift_max(0.0, lam);
        }
    }

    // Clamping leaves some station above target: solve forward and shrink every λ until the
    // busiest station is at the target (two passes).
    for _ in 0..2 {
        let alpha: Vec<Vec<f64>> = (0..k_primary).map(|k| forward_solve(&p[k], &lambda_ext[k], d)).collect();
        let rho_max = busiest(&alpha, &service_rate, k_primary, d);
        if !(rho_max > target + 1e-6) {
            break;
        }
        let shrink = target / rho_max;
        for row in lambda_ext.iter_mut() {
            for v in row.iter_mut() {
                *v *= shrink;
            }
        }
    }

    let mut ex = Expansion { d, p, service_rate, lambda_ext, transitions: Vec::new(), k_total: k_primary };

    // Every backward routing entry becomes a class change onto a derived class.
    if d >= 2 {
        for k in 0..k_primary {
            let mut feedbacks = Vec::new();
            for i in 0..d {
                for j in 0..i {
                    if ex.p[k][i][j] > 1e-9 {
                        feedbacks.push((i, j, ex.p[k][i][j]));
                    }
                }
            }
            for (i, j, prob) in feedbacks {
                ex.p[k][i][j] = 0.0;
                ex.add_transition(&mut rng, &mut stations, k, i, j, prob);
            }
        }
    }

    // The re-entrant topology's own feedback: per class, with probability 0.6, one class change
    // of 0.10–0.20 from a random station back to a random earlier buffer.
    if params.topology == Topology::ReentrantFeedback && d >= 2 {
        for k in 0..k_primary {
            if !(rng.double_in_closed(0.0, 1.0) < 0.6) {
                continue;
            }
            let src = rng.int_in_range(1, d as i64) as usize;
            let to = rng.int_in_range(0, src as i64) as usize;
            let p_cc = rng.double_in_closed(0.10, 0.20);
            if ex.p[k][src][d] >= p_cc + 1e-9 {
                ex.p[k][src][d] -= p_cc;
            } else {
                let non_sink = ex.p[k][src][..d].iter().fold(0.0, |a, b| a + b);
                if !(non_sink > p_cc + 1e-6) {
                    continue;
                }
                let scale = (non_sink - p_cc) / non_sink;
                for v in ex.p[k][src][..d].iter_mut() {
                    *v *= scale;
                }
            }
            ex.add_transition(&mut rng, &mut stations, k, src, to, p_cc);
        }
    }

    // Derived classes add load: recompute ρ over every class and shrink the primary λ (up to
    // three passes).
    if ex.k_total > k_primary {
        for _ in 0..3 {
            let mut alpha = vec![vec![0.0; d]; ex.k_total];
            for k in 0..k_primary {
                alpha[k] = forward_solve(&ex.p[k], &ex.lambda_ext[k], d);
            }
            for tr in &ex.transitions {
                let mut lam = vec![0.0; d];
                lam[tr.to_buffer] = tr.prob * alpha[tr.from_class][tr.src_station];
                alpha[tr.to_class] = forward_solve(&ex.p[tr.to_class], &lam, d);
            }
            let rho_max = busiest(&alpha, &ex.service_rate, ex.k_total, d);
            if !(rho_max > target + 1e-6) {
                break;
            }
            let shrink = target / rho_max;
            for row in ex.lambda_ext.iter_mut().take(k_primary) {
                for v in row.iter_mut() {
                    *v *= shrink;
                }
            }
        }
    }

    // One source per class: its total rate, split over the buffers in proportion to λ.
    let mut split = vec![vec![0.0; d]; k_primary];
    for k in 0..k_primary {
        let total = ex.lambda_ext[k].iter().fold(0.0, |a, b| a + b);
        if total > 1e-12 {
            for i in 0..d {
                split[k][i] = ex.lambda_ext[k][i] / total;
            }
        } else {
            split[k][0] = 1.0;
        }
        sources[k].parameters = cfmt::f("lambda=%.6f", total);
    }

    // Links: sources to buffers, stations onward per class (class changes last), then one
    // buffer → station link per class that reaches the buffer.
    let mut links = Vec::new();
    let mut link = |from: &Node, to: &Node, probability: f64, class: usize, to_class: Option<usize>| {
        links.push(Link {
            id: ids.next_id(),
            from: from.id.clone(),
            to: to.id.clone(),
            probability,
            class: class as i64,
            to_class: to_class.map(|c| c as i64),
        });
    };
    for k in 0..k_primary {
        for i in 0..d {
            if split[k][i] > 1e-9 {
                link(&sources[k], &buffers[i], split[k][i], k, None);
            }
        }
    }
    for i in 0..d {
        for k in 0..ex.k_total {
            for j in (0..d).filter(|&j| j != i) {
                if ex.p[k][i][j] > 1e-9 {
                    link(&stations[i], &buffers[j], ex.p[k][i][j], k, None);
                }
            }
            if ex.p[k][i][d] > 1e-9 {
                link(&stations[i], &sink, ex.p[k][i][d], k, None);
            }
        }
        for tr in ex.transitions.iter().filter(|t| t.src_station == i) {
            link(&stations[i], &buffers[tr.to_buffer], tr.prob, tr.from_class, Some(tr.to_class));
        }
    }
    for i in 0..d {
        let mut reaching = BTreeSet::new();
        reaching.extend((0..k_primary).filter(|&k| split[k][i] > 1e-9));
        for j in (0..d).filter(|&j| j != i) {
            reaching.extend((0..ex.k_total).filter(|&k| ex.p[k][j][i] > 1e-9));
        }
        reaching.extend(ex.transitions.iter().filter(|t| t.to_buffer == i).map(|t| t.to_class));
        if reaching.is_empty() {
            reaching.insert(0);
        }
        for k in reaching {
            link(&buffers[i], &stations[i], 1.0, k, None);
        }
    }

    let mut nodes = sources;
    nodes.extend(buffers);
    nodes.extend(stations);
    nodes.push(sink);
    debug_assert!(nodes.iter().all(|n| n.picture == StationPicture::None));
    Network {
        nodes,
        links,
        infinite_buffers: params.infinite_buffers,
        canvas_scale: 1.0,
        canvas_pan_offset: (0.0, 0.0),
        population: None,
    }
}

/// α = λ + Pᵀα for one class, or λ itself when the system is singular.
fn forward_solve(p: &[Vec<f64>], lambda: &[f64], d: usize) -> Vec<f64> {
    let a: Vec<Vec<f64>> =
        (0..d).map(|i| (0..d).map(|j| (if i == j { 1.0 } else { 0.0 }) - p[j][i]).collect()).collect();
    solve_linear_system(&a, lambda).unwrap_or_else(|| lambda.to_vec())
}

/// The busiest station's ρ = Σ_k α_ki / μ_ki, as Swift's `max()` picks it.
fn busiest(alpha: &[Vec<f64>], service_rate: &[Vec<f64>], classes: usize, d: usize) -> f64 {
    let mut rho = vec![0.0; d];
    for (i, r) in rho.iter_mut().enumerate() {
        for k in 0..classes {
            *r += alpha[k][i] / swift_max(1e-12, service_rate[k][i]);
        }
    }
    rho.iter().skip(1).fold(rho[0], |m, &v| if m < v { v } else { m })
}

/// One routing row for station i of d: entries 0..d are the stations, entry d the sink
/// (`sampleRoutingRow`).
fn sample_routing_row(i: usize, d: usize, topology: Topology, rng: &mut SplitMix64) -> Vec<f64> {
    let mut row = vec![0.0; d + 1];
    match topology {
        Topology::FeedForward | Topology::ReentrantFeedback => {
            if i == d - 1 {
                row[d] = 1.0;
            } else {
                let sink = rng.double_in_closed(0.55, 0.85);
                let rem = 1.0 - sink;
                let w: Vec<f64> = (0..d - i - 1).map(|_| rng.double_in_closed(0.2, 1.0)).collect();
                let sum = w.iter().fold(0.0, |a, b| a + b);
                for (off, wi) in w.iter().enumerate() {
                    row[i + 1 + off] = rem * wi / sum;
                }
                row[d] = sink;
            }
        }
        Topology::JacksonFeedback => {
            let sink = rng.double_in_closed(0.45, 0.75);
            let mut feedback = 0.0;
            let mut feedback_target = None;
            if i > 0 {
                feedback = rng.double_in_closed(0.05, 0.20);
                feedback_target = Some(rng.int_in_range(0, i as i64) as usize);
            }
            let rem = swift_max(0.0, 1.0 - sink - feedback);
            if i == d - 1 {
                row[d] = 1.0 - feedback;
            } else {
                let w: Vec<f64> = (0..d - i - 1).map(|_| rng.double_in_closed(0.2, 1.0)).collect();
                let sum = w.iter().fold(0.0, |a, b| a + b);
                for (off, wi) in w.iter().enumerate() {
                    row[i + 1 + off] = rem * wi / sum;
                }
                row[d] = sink;
            }
            if let Some(t) = feedback_target {
                row[t] = feedback;
            }
        }
        Topology::GeneralPMatrix => {
            let sink = rng.double_in_closed(0.30, 0.60);
            let rem = 1.0 - sink;
            let w: Vec<f64> = (0..d - 1).map(|_| rng.double_in_closed(0.1, 1.0)).collect();
            let sum = w.iter().fold(0.0, |a, b| a + b);
            for (wi, j) in (0..d).filter(|&j| j != i).enumerate() {
                row[j] = rem * w[wi] / sum;
            }
            // GEN-022 (D5): with no other station to take the remainder, everything goes to the
            // sink. 0.90.34 left the row at the sink probability.
            row[d] = if d == 1 { 1.0 } else { sink };
        }
    }
    row
}

/// A random service law with mean about 1 and SCV 0.15–1.5: exponential, Erlang-2 or -3, gamma or
/// uniform, equally likely (`randomServiceConfig`).
fn random_service_config(rng: &mut SplitMix64) -> ServiceConfig {
    match rng.int_in_closed(0, 3) {
        0 => {
            let rate = rng.double_in_closed(0.8, 1.4);
            ServiceConfig { distribution: Distribution::Exponential, parameters: cfmt::f("rate=%.4f", rate) }
        }
        1 => {
            let k = rng.int_in_closed(2, 3);
            let rate = k as f64 * rng.double_in_closed(0.9, 1.2);
            ServiceConfig {
                distribution: Distribution::Erlang,
                parameters: format!("k={k},rate={}", cfmt::f("%.4f", rate)),
            }
        }
        2 => {
            let shape = rng.double_in_closed(1.0, 2.5);
            let scale = rng.double_in_closed(0.85, 1.15) / shape;
            ServiceConfig {
                distribution: Distribution::Gamma,
                parameters: format!("shape={},scale={}", cfmt::f("%.3f", shape), cfmt::f("%.3f", scale)),
            }
        }
        _ => {
            let low = rng.double_in_closed(0.1, 0.3);
            let high = low + rng.double_in_closed(1.4, 2.0);
            ServiceConfig {
                distribution: Distribution::Uniform,
                parameters: format!("min={},max={}", cfmt::f("%.3f", low), cfmt::f("%.3f", high)),
            }
        }
    }
}

/// The mean service rate the generator designs with, read back from the printed parameters, so
/// the rounding in the file is the rounding in the design (`meanServiceRate`). Its defaults for a
/// missing parameter are its own, not the analysis's.
fn mean_service_rate(cfg: Option<&ServiceConfig>) -> f64 {
    let Some(cfg) = cfg else { return 1.0 };
    let p = parse_params(&cfg.parameters);
    let g = |key: &str, default: f64| p.get(key).copied().unwrap_or(default);
    match cfg.distribution {
        Distribution::Exponential => swift_max(1e-6, g("rate", 1.0)),
        Distribution::Erlang => swift_max(1e-6, g("rate", 1.0) / g("k", 2.0)),
        Distribution::Gamma => swift_max(1e-6, 1.0 / (g("shape", 2.0) * g("scale", 0.5))),
        Distribution::Uniform => swift_max(1e-6, 2.0 / (g("min", 0.5) + g("max", 1.5))),
        Distribution::Constant => swift_max(1e-6, 1.0 / g("value", 1.0)),
        Distribution::Weibull | Distribution::Lognormal | Distribution::Pareto | Distribution::Poisson => 1.0,
    }
}

/// "k=2,rate=2.1" → {k: 2, rate: 2.1}; a piece that isn't one key and one number is skipped.
fn parse_params(s: &str) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for token in s.split(',').filter(|t| !t.is_empty()) {
        let pair: Vec<&str> = token.split('=').filter(|t| !t.is_empty()).collect();
        if pair.len() == 2 {
            if let Ok(v) = pair[1].trim().parse::<f64>() {
                out.insert(pair[0].trim().to_string(), v);
            }
        }
    }
    out
}

/// Gaussian elimination with partial pivoting; None when a pivot is below 1e-14
/// (`solveLinearSystem`).
fn solve_linear_system(a: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let n = b.len();
    if n == 0 {
        return Some(Vec::new());
    }
    let mut m = a.to_vec();
    let mut rhs = b.to_vec();
    for i in 0..n {
        let mut piv = i;
        let mut best = m[i][i].abs();
        for r in i + 1..n {
            if m[r][i].abs() > best {
                best = m[r][i].abs();
                piv = r;
            }
        }
        if best < 1e-14 {
            return None;
        }
        if piv != i {
            m.swap(i, piv);
            rhs.swap(i, piv);
        }
        for r in i + 1..n {
            let f = m[r][i] / m[i][i];
            if f == 0.0 {
                continue;
            }
            for c in i..n {
                m[r][c] -= f * m[i][c];
            }
            rhs[r] -= f * rhs[i];
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut s = rhs[i];
        for c in i + 1..n {
            s -= m[i][c] * x[c];
        }
        x[i] = s / m[i][i];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::CountingIds;
    use crate::traffic;

    fn make(stations: i64, classes: i64, rho: f64, topology: Topology, seed: u64) -> Network {
        let p = Parameters { stations, classes, infinite_buffers: true, target_rho: rho, topology, seed: Some(seed) };
        generate(&p, &mut CountingIds::new())
    }

    fn spread() -> Vec<Network> {
        let mut v = Vec::new();
        for t in Topology::ALL {
            for (d, k, rho, seed) in
                [(1, 1, 0.1, 1), (2, 3, 0.5, 2), (4, 3, 0.9, 3), (7, 2, 0.99, 4), (12, 8, 0.75, 5), (20, 8, 0.95, 6)]
            {
                v.push(make(d, k, rho, t, seed));
            }
        }
        v
    }

    fn ids_of(net: &Network, kind: NodeKind) -> Vec<&str> {
        net.nodes_of(kind).map(|n| n.id.as_str()).collect()
    }

    #[test]
    fn the_defaults_are_0_90_34s() {
        let p = Parameters::default();
        assert_eq!((p.stations, p.classes, p.infinite_buffers, p.target_rho), (4, 3, true, 0.9));
        assert_eq!((p.topology, p.seed), (Topology::FeedForward, None));
    }

    #[test]
    fn stations_and_classes_below_one_are_raised_to_one() {
        let net = make(0, -3, 0.9, Topology::FeedForward, 1);
        let names: Vec<&str> = net.nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["Src1", "B1", "S1", "Sink1"]);
    }

    #[test]
    fn the_sheet_clamps_stations_classes_and_rho_to_its_ranges() {
        let p = Parameters { stations: 99, classes: 0, target_rho: 1.5, ..Parameters::default() }.sheet_clamped();
        assert_eq!((p.stations, p.classes, p.target_rho), (20, 1, 0.99));
        let q = Parameters { stations: -1, classes: 9, target_rho: 0.01, ..Parameters::default() }.sheet_clamped();
        assert_eq!((q.stations, q.classes, q.target_rho), (1, 8, 0.1));
    }

    #[test]
    fn topologies_round_trip_through_their_raw_values_and_cli_tags() {
        for t in Topology::ALL {
            assert_eq!(Topology::from_raw(t.raw()), Some(t));
            assert_eq!(Topology::from_cli_tag(t.cli_tag()), Some(t));
        }
        assert_eq!(Topology::from_cli_tag("tree"), None);
    }

    #[test]
    fn the_same_seed_gives_the_same_network_and_another_seed_a_different_one() {
        let a = make(5, 3, 0.9, Topology::GeneralPMatrix, 11);
        assert_eq!(a, make(5, 3, 0.9, Topology::GeneralPMatrix, 11));
        assert_ne!(a, make(5, 3, 0.9, Topology::GeneralPMatrix, 12));
    }

    #[test]
    fn no_seed_draws_a_fresh_one() {
        let p = Parameters::default();
        let a = generate(&p, &mut CountingIds::new());
        let b = generate(&p, &mut CountingIds::new());
        assert_ne!(a, b, "two unseeded networks are different (with overwhelming probability)");
    }

    #[test]
    fn nodes_are_sources_buffers_stations_then_the_sink_on_one_grid() {
        let net = make(3, 3, 0.9, Topology::FeedForward, 1);
        let names: Vec<&str> = net.nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["Src1", "Src2", "Src3", "B1", "B2", "B3", "S1", "S2", "S3", "Sink1"]);
        let pos: Vec<(f64, f64)> = net.nodes.iter().map(|n| n.position).collect();
        assert_eq!(&pos[..3], &[(80.0, 156.0), (80.0, 220.0), (80.0, 284.0)]);
        assert_eq!(&pos[3..6], &[(200.0, 220.0), (330.0, 220.0), (460.0, 220.0)]);
        assert_eq!(&pos[6..9], &[(265.0, 220.0), (395.0, 220.0), (525.0, 220.0)]);
        assert_eq!(pos[9], (630.0, 220.0));
    }

    #[test]
    fn finite_buffers_hold_ten_and_infinite_ones_one() {
        let finite = generate(
            &Parameters { infinite_buffers: false, seed: Some(3), ..Parameters::default() },
            &mut CountingIds::new(),
        );
        assert!(!finite.infinite_buffers);
        assert!(finite.nodes_of(NodeKind::Buffer).all(|b| b.buffer_size == 10));
        let infinite = make(4, 3, 0.9, Topology::FeedForward, 3);
        assert!(infinite.nodes_of(NodeKind::Buffer).all(|b| b.buffer_size == 1));
    }

    #[test]
    fn every_station_is_fed_by_exactly_one_buffer_its_own() {
        for net in spread() {
            let buffers = ids_of(&net, NodeKind::Buffer);
            for (i, s) in net.nodes_of(NodeKind::Station).enumerate() {
                let feeders: BTreeSet<&str> =
                    net.links.iter().filter(|l| l.to == s.id).map(|l| l.from.as_str()).collect();
                assert_eq!(feeders.into_iter().collect::<Vec<_>>(), [buffers[i]], "{}", s.name);
            }
        }
    }

    #[test]
    fn no_link_leaves_a_class_with_more_than_all_of_its_jobs() {
        for net in spread() {
            let mut sums: BTreeMap<(&str, i64), f64> = BTreeMap::new();
            for l in &net.links {
                *sums.entry((l.from.as_str(), l.class)).or_default() += l.probability;
            }
            for ((from, class), sum) in sums {
                assert!(sum <= 1.0 + 1e-9, "{from} class {class}: {sum}");
            }
        }
    }

    #[test]
    fn station_rows_sum_to_one_including_a_single_general_p_matrix_station() {
        for net in spread() {
            for s in net.nodes_of(NodeKind::Station) {
                let mut sums: BTreeMap<i64, f64> = BTreeMap::new();
                for l in net.links.iter().filter(|l| l.from == s.id) {
                    *sums.entry(l.class).or_default() += l.probability;
                }
                for (class, sum) in sums {
                    assert!((sum - 1.0).abs() < 1e-9, "{} class {class}: {sum}", s.name);
                }
            }
        }
        let one = make(1, 2, 0.9, Topology::GeneralPMatrix, 9);
        assert!(one.links.iter().filter(|l| l.to == one.nodes.last().unwrap().id).all(|l| l.probability == 1.0));
    }

    #[test]
    fn every_class_change_goes_back_to_an_earlier_buffer_onto_a_class_of_its_own() {
        for net in spread() {
            let buffers = ids_of(&net, NodeKind::Buffer);
            let stations = ids_of(&net, NodeKind::Station);
            let k = net.nodes_of(NodeKind::Source).count() as i64;
            let mut derived = BTreeSet::new();
            for l in net.links.iter().filter(|l| l.to_class.is_some()) {
                let from = stations.iter().position(|s| *s == l.from).unwrap();
                let to = buffers.iter().position(|b| *b == l.to).unwrap();
                assert!(to < from, "a class change always goes upstream");
                assert!(l.class < k, "only primary classes change class");
                assert!(derived.insert(l.to_class.unwrap()), "one way into each derived class");
            }
            assert!(derived.iter().copied().eq(k..k + derived.len() as i64), "derived classes are numbered on from K");
            // Apart from class changes, every station link runs forward.
            for l in net.links.iter().filter(|l| l.to_class.is_none()) {
                if let (Some(from), Some(to)) =
                    (stations.iter().position(|s| *s == l.from), buffers.iter().position(|b| *b == l.to))
                {
                    assert!(to > from, "same-class station links run downstream");
                }
            }
        }
    }

    #[test]
    fn feed_forward_networks_have_no_class_changes() {
        for (d, k, seed) in [(2, 1, 1), (6, 4, 2), (20, 8, 3)] {
            assert!(make(d, k, 0.9, Topology::FeedForward, seed).links.iter().all(|l| l.to_class.is_none()));
        }
    }

    #[test]
    fn service_laws_have_mean_about_one_for_every_station_and_class() {
        for net in spread() {
            let classes = net.links.iter().map(|l| l.exit_class().max(l.class)).max().unwrap() + 1;
            for s in net.nodes_of(NodeKind::Station) {
                assert_eq!(s.service_by_class.len() as i64, classes, "{}", s.name);
                assert_eq!(
                    (s.distribution, &s.parameters),
                    (s.service_by_class[&0].distribution, &s.service_by_class[&0].parameters)
                );
                for c in s.service_by_class.values() {
                    let mean = 1.0 / mean_service_rate(Some(c));
                    assert!((0.7..1.3).contains(&mean), "{}: {} {}", s.name, c.distribution.raw(), c.parameters);
                }
            }
        }
    }

    fn utilisations(net: &Network) -> Vec<f64> {
        let data =
            traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).expect("a valid network");
        (0..data.d).map(|i| data.rho(i)).collect()
    }

    #[test]
    fn feed_forward_and_reentrant_networks_put_the_busiest_station_at_the_target() {
        for t in [Topology::FeedForward, Topology::ReentrantFeedback] {
            for (d, k, rho, seed) in [(1, 1, 0.1, 1), (3, 2, 0.5, 2), (4, 3, 0.9, 3), (8, 5, 0.99, 4), (20, 8, 0.75, 5)]
            {
                let rhos = utilisations(&make(d, k, rho, t, seed));
                let max = rhos.iter().cloned().fold(f64::MIN, f64::max);
                assert!((max - rho).abs() < 1e-4, "{t:?} d{d} k{k}: max ρ {max}, target {rho}");
            }
        }
    }

    #[test]
    fn a_feed_forward_network_puts_every_unclamped_station_at_the_target() {
        // Seed 1, d 4, K 3 needs no clamping, so every station carries exactly the target.
        let rhos = utilisations(&make(4, 3, 0.9, Topology::FeedForward, 1));
        assert!(rhos.iter().all(|r| (r - 0.9).abs() < 1e-4), "{rhos:?}");
    }

    #[test]
    fn feedback_networks_keep_every_station_at_or_below_the_target() {
        // Kept small: every backward entry is a derived class, and the class-expanded traffic
        // equations grow with (classes × stations)², a few hundred derived classes at d = 20.
        for t in [Topology::JacksonFeedback, Topology::GeneralPMatrix] {
            for (d, k, rho, seed) in [(1, 1, 0.1, 1), (3, 2, 0.5, 2), (4, 3, 0.9, 3), (6, 3, 0.99, 4), (8, 2, 0.75, 5)]
            {
                for r in utilisations(&make(d, k, rho, t, seed)) {
                    assert!(r <= rho + 1e-4, "{t:?} d{d} k{k}: ρ {r} above {rho}");
                    assert!(r > 0.0);
                }
            }
        }
    }

    #[test]
    fn the_linear_solver_solves_and_refuses_a_singular_system() {
        let x = solve_linear_system(&[vec![0.0, 2.0], vec![1.0, 1.0]], &[4.0, 3.0]).unwrap();
        assert_eq!(x, vec![1.0, 2.0]);
        assert!(solve_linear_system(&[vec![1.0, 1.0], vec![1.0, 1.0]], &[1.0, 2.0]).is_none());
    }

    #[test]
    fn parameters_are_read_back_as_0_90_34_parsed_them() {
        let p = parse_params("k=2, rate = 2.5,,junk,a=b,x==3");
        assert_eq!(p.get("k"), Some(&2.0));
        assert_eq!(p.get("rate"), Some(&2.5));
        assert_eq!(p.get("x"), Some(&3.0), "split drops the empty piece between two =");
        assert_eq!(p.len(), 3);
        let erlang = ServiceConfig { distribution: Distribution::Erlang, parameters: "k=3,rate=3.0".into() };
        assert_eq!(mean_service_rate(Some(&erlang)), 1.0);
        let gamma = ServiceConfig { distribution: Distribution::Gamma, parameters: "shape=2.0".into() };
        assert_eq!(mean_service_rate(Some(&gamma)), 1.0, "the generator's own default scale is 0.5");
        assert_eq!(mean_service_rate(None), 1.0);
    }
}
