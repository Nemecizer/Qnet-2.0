//! A discrete-event simulation of the drawn network, for the canvas animation (new in 2.1,
//! ROADMAP Phase E). It produces a stream of events — a customer arrives, starts service, departs,
//! is routed on or leaves — in chunks, so the interface can play a run for as long as it likes
//! without holding it in memory.
//!
//! **It is an illustration: one random run.** A run of this file alone gives no confidence
//! interval and is never a method in Results or Agreement; `simstat.rs` (ledger SIM-101) is what
//! turns many runs of it into estimates with intervals. It must still be *right*, and the tests
//! below hold its long-run time averages to the closed forms of `jackson` and `closed` and to the
//! Pollaczek–Khinchine formula, and check PASTA, flow conservation, first-come-first-served order
//! and that no customer is ever in two places.
//!
//! The model, read exactly as `traffic::compute` and `closed::from_network` read it:
//!
//! - **Open networks.** Customer class k is the k-th source in export order. A source emits a
//!   renewal stream with its inter-arrival law; each arrival follows one of the source's links with
//!   that link's probability (what is left over never enters). A link into a buffer delivers to the
//!   station that buffer feeds. A class-k customer finishing at a station follows one of the
//!   station's class-k links with its probability and takes the link's exit class; with what is
//!   left over, or along a link that does not lead to a station, it leaves the network.
//! - **Stations.** c identical servers, one first-come-first-served queue, a waiting customer takes
//!   the lowest-numbered free server. The service time is drawn when service starts, from the
//!   station's law for the customer's class (its per-class law if it has one, else its own).
//! - **Buffers are infinite.** With finite buffers the behaviour depends on a blocking rule (loss,
//!   blocking after service, or blocking after service with external loss) that the finite solvers
//!   take as a per-run choice; the network does not store one, so there is no single behaviour to
//!   draw and an open network with finite buffers is refused with a sentence. No `blocked` event
//!   exists for that reason.
//! - **Closed networks** (`closed::drawn_as`): exactly the networks `closed::from_network` accepts
//!   (one class, exponential service, routing rows that sum to 1, room for everyone). The N
//!   customers start at the reference station, the first in export order.
//!
//! - **Priorities, batches and rate profiles** (new in 2.1, `extended.rs`).
//!   *Priority service*: a free server takes the waiting customer of the highest class in the
//!   station's order (first come first served within a class; a class the order leaves out ranks
//!   below all it names). Under preemptive-resume a customer that finds every server busy
//!   interrupts the service of the lowest class in service, if that class is lower than its own;
//!   the interrupted customer goes back to the head of its class's queue and later resumes with
//!   exactly the service time it had left (a [`Kind::Preempt`] event; its later start is another
//!   [`Kind::Start`]). The work a station has done always equals the service times drawn less
//!   what its customers still have left ([`Stats::work_started`], [`Stats::work_left`]).
//!   *Batch arrivals*: at each arrival epoch of a source its batch size X is drawn and X
//!   customers are created at that instant; each is routed on its own by the source's links.
//!   *Rate profiles*: a Poisson source with a profile is a non-homogeneous Poisson process,
//!   sampled by thinning (Lewis & Shedler, "Simulation of nonhomogeneous Poisson processes by
//!   thinning", Naval Res. Logist. Quart. 26:403–413, 1979): candidate epochs at the constant
//!   rate λ·m_max, each kept with probability m(t)/m_max.
//!   A setting that cannot be modelled as written (`extended::problems`) refuses the run.
//!
//! Distribution parameters are read as `traffic::rate` reads them (the last number written for a
//! key, a missing key filled with the family's default) and must pass `dist::validate_parameters`.
//! Every family is sampled exactly: inversion for Exponential, Uniform, Weibull and Pareto, the
//! sum of k exponentials for Erlang, exp(μ + σZ) for Lognormal, and Marsaglia & Tsang's method for
//! Gamma ("A simple method for generating gamma variables", ACM TOMS 26(3), 2000).
//!
//! Randomness is `uncertainty::Rng` (xoshiro256++): a seed gives the same run on every machine,
//! however the run is cut into chunks.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, HashMap, VecDeque};

use crate::closed;
use crate::dist;
use crate::extended;
use crate::jackson;
use crate::model::{BatchSize, Discipline, Distribution, Network, Node, NodeKind, RateProfile};
use crate::naming;
#[cfg(test)]
use crate::traffic;
use crate::uncertainty::Rng;

// ── Sampling ────────────────────────────────────────────────────────────────────────────────

/// A service or inter-arrival law that can be drawn from.
#[derive(Clone, Debug, PartialEq)]
pub enum Sampler {
    Exponential { rate: f64 },
    Constant { value: f64 },
    Uniform { min: f64, max: f64 },
    Erlang { k: u32, rate: f64 },
    Gamma { shape: f64, scale: f64 },
    Weibull { shape: f64, scale: f64 },
    Lognormal { mu: f64, sigma: f64 },
    Pareto { shape: f64, scale: f64 },
}

/// Erlang with more stages than this is drawn as the Gamma law it is.
const ERLANG_SUM_LIMIT: f64 = 64.0;

/// A standard Gamma(shape, 1) draw. Marsaglia & Tsang (2000): for shape ≥ 1, with d = shape − 1/3
/// and c = 1/√(9d), draw Z normal and U uniform until v = (1 + cZ)³ > 0 and
/// ln U < Z²/2 + d − dv + d·ln v; the draw is d·v. For shape < 1, Gamma(shape + 1)·U^(1/shape).
fn standard_gamma(shape: f64, rng: &mut Rng) -> f64 {
    if shape < 1.0 {
        let u = rng.uniform();
        return standard_gamma(shape + 1.0, rng) * u.powf(1.0 / shape);
    }
    let d = shape - 1.0 / 3.0;
    let c = 1.0 / (9.0 * d).sqrt();
    loop {
        let z = rng.normal();
        let v = 1.0 + c * z;
        if v <= 0.0 {
            continue;
        }
        let v = v * v * v;
        let u = rng.uniform();
        if u.ln() < 0.5 * z * z + d - d * v + d * v.ln() {
            return d * v;
        }
    }
}

impl Sampler {
    /// The sampler of a family with its parameter text, or a sentence saying what is wrong.
    /// `who` names the node in that sentence.
    pub fn new(d: Distribution, parameters: &str, who: &str) -> Result<Sampler, String> {
        let mut p: BTreeMap<String, f64> = dist::parameter_defs(d).into_iter().map(|def| (def.key.to_string(), def.default)).collect();
        p.extend(dist::parse_params_numeric_last(parameters));
        if let Some((_, msg)) = dist::validate_parameters(d, &p).into_iter().next() {
            return Err(format!("{who}: {msg}"));
        }
        let g = |k: &str| p[k];
        let s = match d {
            Distribution::Exponential => Sampler::Exponential { rate: g("rate") },
            Distribution::Poisson => Sampler::Exponential { rate: g("lambda") },
            Distribution::Constant => Sampler::Constant { value: g("value") },
            Distribution::Uniform => Sampler::Uniform { min: g("min"), max: g("max") },
            Distribution::Erlang if g("k") <= ERLANG_SUM_LIMIT => Sampler::Erlang { k: g("k") as u32, rate: g("rate") },
            Distribution::Erlang => Sampler::Gamma { shape: g("k"), scale: 1.0 / g("rate") },
            Distribution::Gamma => Sampler::Gamma { shape: g("shape"), scale: g("scale") },
            Distribution::Weibull => Sampler::Weibull { shape: g("shape"), scale: g("scale") },
            Distribution::Lognormal => Sampler::Lognormal { mu: g("mu"), sigma: g("sigma") },
            Distribution::Pareto => Sampler::Pareto { shape: g("shape"), scale: g("scale") },
        };
        let m = s.mean();
        if !(m.is_finite() && m > 0.0) {
            return Err(format!("{who}: the mean time is not a positive, finite number."));
        }
        Ok(s)
    }

    /// One draw: a time, never negative.
    pub fn sample(&self, rng: &mut Rng) -> f64 {
        match *self {
            Sampler::Exponential { rate } => -rng.uniform().ln() / rate,
            Sampler::Constant { value } => value,
            Sampler::Uniform { min, max } => min + (max - min) * rng.uniform(),
            Sampler::Erlang { k, rate } => {
                let mut sum = 0.0;
                for _ in 0..k {
                    sum -= rng.uniform().ln();
                }
                sum / rate
            }
            Sampler::Gamma { shape, scale } => scale * standard_gamma(shape, rng),
            Sampler::Weibull { shape, scale } => scale * (-rng.uniform().ln()).powf(1.0 / shape),
            Sampler::Lognormal { mu, sigma } => (mu + sigma * rng.normal()).exp(),
            Sampler::Pareto { shape, scale } => scale * rng.uniform().powf(-1.0 / shape),
        }
    }

    /// The law's mean.
    pub fn mean(&self) -> f64 {
        match *self {
            Sampler::Exponential { rate } => 1.0 / rate,
            Sampler::Constant { value } => value,
            Sampler::Uniform { min, max } => (min + max) / 2.0,
            Sampler::Erlang { k, rate } => k as f64 / rate,
            Sampler::Gamma { shape, scale } => shape * scale,
            Sampler::Weibull { shape, scale } => scale * crate::cfmt::tgamma(1.0 + 1.0 / shape),
            Sampler::Lognormal { mu, sigma } => (mu + sigma * sigma / 2.0).exp(),
            Sampler::Pareto { shape, scale } => shape * scale / (shape - 1.0),
        }
    }
}

// ── Events ──────────────────────────────────────────────────────────────────────────────────

/// What happened. The numbers are the wire format (src/animate/model.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// A new customer enters the network at `station`'s queue; `other` is the source's index.
    Arrive = 0,
    /// The customer starts service at `station` on `server`.
    Start = 1,
    /// The customer's service at `station` on `server` ends.
    Depart = 2,
    /// The customer that just departed `station` joins the queue of station `other`; `class` is
    /// the class it now travels as.
    Route = 3,
    /// The customer that just departed `station` leaves the network; `other` is the sink's index
    /// in [`Layout::sinks`], or −1 when no link leads it out.
    Leave = 4,
    /// Preemptive-resume priority (new in 2.1): the customer in service at `station` on `server`
    /// is interrupted by a higher class and goes back to the head of its class's queue there.
    Preempt = 5,
}

/// One event. Events at the same time are in the order they happened.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    pub time: f64,
    pub kind: Kind,
    pub customer: u64,
    pub class: u32,
    pub station: u32,
    /// The server, or −1 for an event that involves none.
    pub server: i32,
    pub other: i32,
}

/// Why a network cannot be animated, in a sentence for the interface.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    /// "finiteBuffers", "closed", "network", "distribution" or "settings".
    pub code: &'static str,
    pub message: String,
}

pub const FINITE_SENTENCE: &str = "The animation covers infinite buffers. With finite buffers what happens at a full buffer depends on a blocking rule (loss, or blocking after service) that is chosen for each run and is not part of the network, so there is no single behaviour to draw. To animate this network, choose Network ▸ Buffer Model ▸ Infinite buffers (a new, empty network starts with finite buffers). To keep finite buffers, use Run ▸ Solve instead.";

/// One station of the run.
#[derive(Clone, Debug, PartialEq)]
pub struct StationInfo {
    pub id: String,
    pub name: String,
    pub servers: usize,
    /// The buffer in front of it, where its queue is drawn.
    pub buffer_id: String,
    /// The exact long-run mean number in system, when a closed form applies (`jackson::live`, or
    /// `closed::means`), customers.
    pub exact_number: Option<f64>,
    /// With priority service (new in 2.1): each class's rank at the station, 0 the highest, by
    /// class index. Empty for first come, first served.
    pub priority_rank: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub class: u32,
}

/// What the run is of: the nodes the events refer to by index.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    /// Stations in export order.
    pub stations: Vec<StationInfo>,
    /// Sources in export order (empty for a closed network).
    pub sources: Vec<SourceInfo>,
    /// The ids of the sinks customers leave by.
    pub sinks: Vec<String>,
    pub classes: usize,
    /// A closed network's population.
    pub population: Option<usize>,
    /// Stations with utilisation ≥ 1: with these, no steady state exists and their queues grow.
    pub unstable: Vec<String>,
    /// Service completions per time unit over the whole network in the long run (Σ α_i), by which
    /// the interface chooses how fast "1×" plays.
    pub event_rate: f64,
}

/// Who is where: per station, the queue from its head and each server's customer.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub time: f64,
    /// (customer, class), head first.
    pub queues: Vec<Vec<(u64, u32)>>,
    pub servers: Vec<Vec<Option<(u64, u32)>>>,
}

/// Running totals since time 0, per station.
#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub time: f64,
    /// ∫ N_i(t) dt: divide by `time` for the time-average number in system.
    pub area_number: Vec<f64>,
    /// ∫ (number waiting) dt.
    pub area_queue: Vec<f64>,
    /// Customers that have joined each station's queue, and that have finished service there.
    pub arrivals: Vec<u64>,
    pub departures: Vec<u64>,
    /// Customers created by sources, and customers that have left the network.
    pub created: u64,
    pub left: u64,
    /// `[station][class]`: ∫ (number of that class at the station) dt, and its service completions.
    pub area_class: Vec<Vec<f64>>,
    pub departures_class: Vec<Vec<u64>>,
    /// Per station: the sum of the service times drawn for customers that have started service,
    /// and how much of it is still to be done (customers in service, and interrupted ones
    /// waiting to resume). Their difference is the work done: ∫ (busy servers) dt.
    pub work_started: Vec<f64>,
    pub work_left: Vec<f64>,
}

// ── The simulator ───────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
enum Target {
    Station(usize),
    /// Out of the network, by the sink of that index or by none.
    Out(i32),
}

#[derive(Clone, Debug)]
struct Branch {
    /// Cumulative probability up to and including this branch.
    upto: f64,
    target: Target,
    class: u32,
}

/// Chooses a branch: `u` uniform on (0, 1). None when `u` falls in what the branches leave over.
fn choose(branches: &[Branch], u: f64) -> Option<&Branch> {
    branches.iter().find(|b| u < b.upto)
}

/// Cumulative branches from (probability, target, class). A row that sums to 1 (within
/// `closed::ROW_TOLERANCE`) has its last branch take whatever rounding left over, so a customer
/// that must go somewhere always does.
fn cumulative(items: Vec<(f64, Target, u32)>) -> Vec<Branch> {
    let mut sum = 0.0;
    let mut out: Vec<Branch> = items
        .into_iter()
        .filter(|(p, _, _)| *p > 0.0)
        .map(|(p, target, class)| {
            sum += p;
            Branch { upto: sum, target, class }
        })
        .collect();
    if sum >= 1.0 - closed::ROW_TOLERANCE {
        if let Some(last) = out.last_mut() {
            last.upto = f64::INFINITY;
        }
    }
    out
}

/// Why a source whose links sum above 1 is not simulated.
pub fn source_over_one_sentence(name: &str, sum: f64) -> String {
    format!("The links out of {name} carry probabilities that sum to {}, more than 1: a source cannot send more customers than it produces. Lower them so that they sum to 1 at most.", crate::cfmt::f("%.4g", sum))
}

/// The sources whose links that deliver to a station sum above 1, with the sum: (id, name, sum).
/// The traffic equations read such a source as producing that multiple of its rate; the
/// simulator refuses it ([`source_over_one_sentence`]).
pub fn sources_over_one(net: &Network) -> Vec<(String, String, f64)> {
    let stations: Vec<&Node> = net.nodes_of(NodeKind::Station).collect();
    let index: HashMap<&str, usize> = stations.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
    net.nodes_of(NodeKind::Source)
        .filter_map(|s| {
            let sum = net.links.iter().filter(|l| l.from == s.id && resolve(net, &index, &l.to).is_some()).map(|l| l.probability.max(0.0)).sum::<f64>();
            (sum > 1.0 + closed::ROW_TOLERANCE).then(|| (s.id.clone(), s.name.clone(), sum))
        })
        .collect()
}

struct Source {
    sampler: Sampler,
    class: u32,
    branches: Vec<Branch>,
    /// The batch-size law, when customers arrive in batches.
    batch: Option<BatchSize>,
    /// The rate profile and its peak multiplier, when the rate varies in time (thinning).
    profile: Option<(RateProfile, f64)>,
}

/// One draw of a batch size (≥ 1). A constant uses no random number.
fn draw_batch(b: &BatchSize, rng: &mut Rng) -> u64 {
    match b {
        BatchSize::Constant(k) => (*k).max(1) as u64,
        // Inversion: P(X > n) = α^n, so X = 1 + ⌊ln U / ln α⌋.
        BatchSize::Geometric { mean } => {
            let alpha = 1.0 - 1.0 / mean;
            if !(alpha > 0.0) {
                return 1;
            }
            1 + (rng.uniform().ln() / alpha.ln()).floor().min(1e15) as u64
        }
        BatchSize::Pmf(p) => {
            let u = rng.uniform();
            let mut sum = 0.0;
            for (i, x) in p.iter().enumerate() {
                sum += x;
                if u < sum {
                    return i as u64 + 1;
                }
            }
            // Rounding left u at or above the sum: the largest size with positive probability.
            p.iter().rposition(|x| *x > 0.0).map(|i| i as u64 + 1).unwrap_or(1)
        }
    }
}

/// A waiting customer; `left` is the service time an interrupted customer still needs.
#[derive(Clone, Copy, Debug)]
struct Waiting {
    customer: u64,
    class: u32,
    left: Option<f64>,
}

struct Station {
    servers: Vec<Option<(u64, u32)>>,
    /// Per server: when its service ends, and the sequence number of that scheduled completion
    /// (a completion whose number is no longer the server's was cancelled by a preemption).
    ends: Vec<f64>,
    tokens: Vec<u64>,
    /// One queue per priority rank, the highest first; first come first served has one.
    queues: Vec<VecDeque<Waiting>>,
    /// Customers waiting: the queues' lengths together.
    waiting: usize,
    /// Per class: its rank (0 the highest).
    rank: Vec<usize>,
    preemptive: bool,
    /// Per class.
    service: Vec<Sampler>,
    routes: Vec<Vec<Branch>>,
    // Statistics.
    last: f64,
    area_number: f64,
    area_queue: f64,
    arrivals: u64,
    departures: u64,
    /// Per class: the number at the station now, its time integral, its completions.
    in_class: Vec<usize>,
    area_class: Vec<f64>,
    departures_class: Vec<u64>,
    work_started: f64,
}

impl Station {
    fn new(servers: usize, node: &Node, service: Vec<Sampler>, routes: Vec<Vec<Branch>>) -> Station {
        let classes = service.len();
        // A class the order does not name ranks below every class it names.
        let rank: Vec<usize> = match node.discipline {
            Discipline::Fcfs => vec![0; classes],
            _ => priority_rank(node, classes).into_iter().map(|r| r as usize).collect(),
        };
        let ranks = rank.iter().copied().max().unwrap_or(0) + 1;
        Station {
            servers: vec![None; servers],
            ends: vec![0.0; servers],
            tokens: vec![0; servers],
            queues: (0..ranks).map(|_| VecDeque::new()).collect(),
            waiting: 0,
            rank,
            preemptive: node.discipline == Discipline::PreemptiveResume,
            service,
            routes,
            last: 0.0,
            area_number: 0.0,
            area_queue: 0.0,
            arrivals: 0,
            departures: 0,
            in_class: vec![0; classes],
            area_class: vec![0.0; classes],
            departures_class: vec![0; classes],
            work_started: 0.0,
        }
    }

    fn busy(&self) -> usize {
        self.servers.iter().filter(|s| s.is_some()).count()
    }

    /// Brings the time integrals up to `t`; called before every change of state.
    fn account(&mut self, t: f64) {
        let dt = t - self.last;
        if dt > 0.0 {
            self.area_queue += self.waiting as f64 * dt;
            self.area_number += (self.waiting + self.busy()) as f64 * dt;
            if self.in_class.len() > 1 {
                for (a, n) in self.area_class.iter_mut().zip(&self.in_class) {
                    *a += *n as f64 * dt;
                }
            }
            self.last = t;
        }
    }

    /// The waiting customers in the order they would be served.
    fn waiting_in_order(&self) -> impl Iterator<Item = (u64, u32)> + '_ {
        self.queues.iter().flat_map(|q| q.iter().map(|w| (w.customer, w.class)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum What {
    Arrival(usize),
    Done(usize, usize),
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Scheduled {
    time: f64,
    seq: u64,
    what: What,
}

impl Eq for Scheduled {}

impl Ord for Scheduled {
    /// Earliest first out of a max-heap; equal times in the order they were scheduled.
    fn cmp(&self, other: &Self) -> Ordering {
        other.time.total_cmp(&self.time).then(other.seq.cmp(&self.seq))
    }
}

impl PartialOrd for Scheduled {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub struct Simulator {
    layout: Layout,
    rng: Rng,
    now: f64,
    seq: u64,
    next_customer: u64,
    created: u64,
    left: u64,
    sources: Vec<Source>,
    stations: Vec<Station>,
    agenda: BinaryHeap<Scheduled>,
    /// Customers waiting, over all stations (the queues' lengths, kept as they change).
    waiting: usize,
    max_waiting: usize,
    /// The station whose queue was the longest when the run was stopped at [`MAX_WAITING`].
    halted: Option<usize>,
}

/// The most customers a run holds waiting. An unstable network's queues grow without bound, and
/// skipping ahead simulates millions of arrivals in one call: past this many waiting customers
/// the run stops for good and says so ([`Simulator::halted`]), rather than grow until memory or
/// the interface gives out. Far beyond anything a picture shows (ledger WF-508).
pub const MAX_WAITING: usize = 1_000_000;

/// The buffer feeding each station; `traffic::compute` / `closed::from_network` have already
/// refused a station without exactly one.
fn feeding_buffer(net: &Network, station: &Node) -> String {
    net.nodes
        .iter()
        .find(|b| b.kind == NodeKind::Buffer && net.links.iter().any(|l| l.from == b.id && l.to == station.id))
        .map(|b| b.id.clone())
        .unwrap_or_default()
}

/// The station a link into `node_id` delivers to (`traffic`'s `resolve_target_station`): the node
/// itself if it is a station; for a buffer, the target of its first link that ends at a station.
fn resolve(net: &Network, index: &HashMap<&str, usize>, node_id: &str) -> Option<usize> {
    let node = net.node(node_id)?;
    match node.kind {
        NodeKind::Station => index.get(node.id.as_str()).copied(),
        NodeKind::Buffer => net.links.iter().filter(|l| l.from == node.id).find_map(|l| net.node(&l.to).filter(|t| t.kind == NodeKind::Station).and_then(|t| index.get(t.id.as_str()).copied())),
        _ => None,
    }
}

/// Each class's rank at a priority station (a class the order leaves out ranks below all it
/// names); empty for first come, first served.
fn priority_rank(station: &Node, classes: usize) -> Vec<u32> {
    match station.discipline {
        Discipline::Fcfs => Vec::new(),
        _ => (0..classes).map(|k| station.priority_order.iter().position(|c| *c == k as i64).unwrap_or(station.priority_order.len()) as u32).collect(),
    }
}

fn service_sampler(station: &Node, class: usize) -> Result<Sampler, String> {
    match station.service_by_class.get(&(class as i64)) {
        Some(c) => Sampler::new(c.distribution, &c.parameters, &station.name),
        None => Sampler::new(station.distribution, &station.parameters, &station.name),
    }
}

impl Simulator {
    /// A run of `net` from `seed`, or why the network cannot be animated.
    pub fn new(net: &Network, seed: u64) -> Result<Simulator, Refusal> {
        if let Some(p) = extended::problems(net).into_iter().next() {
            return Err(Refusal { code: "settings", message: p.message });
        }
        match closed::drawn_as(net) {
            closed::Drawn::Open => Simulator::open(net, seed),
            closed::Drawn::Closed => Simulator::closed(net, seed),
            closed::Drawn::ClosedNoPopulation => Err(Refusal { code: "closed", message: closed::ClosedError::PopulationMissing.message() }),
        }
    }

    fn open(net: &Network, seed: u64) -> Result<Simulator, Refusal> {
        // The structure is checked by the analysis every solver starts from, read with infinite
        // buffers (what is simulated).
        // (At the sources' long-run customer rates: `extended::traffic` is `traffic::compute`
        // itself for a network without batches or rate profiles.)
        let data = extended::traffic(net, true, false, false).map_err(|e| Refusal { code: "network", message: e.message() })?;
        if !net.infinite_buffers {
            return Err(Refusal { code: "finiteBuffers", message: FINITE_SENTENCE.into() });
        }
        let bad = |message: String| Refusal { code: "distribution", message };
        let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
        let sources = naming::in_export_order(net.nodes_of(NodeKind::Source), |n| n.name.as_str());
        let index: HashMap<&str, usize> = stations.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
        let classes = data.k;
        let mut sinks: Vec<String> = Vec::new();
        let mut sink_index = |id: &str| -> i32 {
            match net.node(id) {
                Some(n) if n.kind == NodeKind::Sink => match sinks.iter().position(|s| s == id) {
                    Some(i) => i as i32,
                    None => {
                        sinks.push(id.to_string());
                        sinks.len() as i32 - 1
                    }
                },
                _ => -1,
            }
        };

        let mut sim_sources = Vec::with_capacity(sources.len());
        for (k, s) in sources.iter().enumerate() {
            let sampler = Sampler::new(s.distribution, &s.parameters, &s.name).map_err(bad)?;
            // A link from a source that reaches no station creates no customer (`compute` gives
            // it no arrival rate).
            let items: Vec<(f64, Target, u32)> = net.links.iter().filter(|l| l.from == s.id).filter_map(|l| resolve(net, &index, &l.to).map(|t| (l.probability, Target::Station(t), k as u32))).collect();
            // `traffic` gives each link its share of the source's rate, so links that sum above
            // 1 would create more customers than the source produces. There is no one reading of
            // that as a routing choice, so it is refused, not interpreted.
            let sum = items.iter().map(|(p, _, _)| p.max(0.0)).sum::<f64>();
            if sum > 1.0 + closed::ROW_TOLERANCE {
                return Err(Refusal { code: "sourceOverOne", message: source_over_one_sentence(&s.name, sum) });
            }
            let profile = s.rate_profile.as_ref().map(|r| (r.clone(), r.peak()));
            sim_sources.push(Source { sampler, class: k as u32, branches: cumulative(items), batch: s.batch.clone(), profile });
        }

        let mut sim_stations = Vec::with_capacity(stations.len());
        for s in &stations {
            if s.servers < 1 {
                return Err(bad(format!("{} has no servers.", s.name)));
            }
            let mut service = Vec::with_capacity(classes);
            let mut routes = Vec::with_capacity(classes);
            for class in 0..classes {
                service.push(service_sampler(s, class).map_err(bad)?);
                // The model's meaning is `traffic`'s: a link that delivers to a station carries
                // its stated probability; what those links leave under 1 leaves the network,
                // whatever number a link into a sink shows. The sink links' numbers only share
                // the leavers among the sinks (for the picture). The order of the links plays
                // no part. (Links to stations that sum above 1 were refused by `traffic` above.)
                let row: Vec<&crate::model::Link> = net.links.iter().filter(|l| l.from == s.id && l.class == class as i64).collect();
                let delivers = |l: &crate::model::Link| {
                    let exit = l.exit_class();
                    resolve(net, &index, &l.to).filter(|_| exit >= 0 && (exit as usize) < classes).map(|t| (t, exit as u32))
                };
                let stay: f64 = row.iter().filter(|l| delivers(l).is_some()).map(|l| l.probability.max(0.0)).sum();
                let leave = (1.0 - stay).max(0.0);
                let sink_weight: f64 = row.iter().filter(|l| delivers(l).is_none()).map(|l| l.probability.max(0.0)).sum();
                let mut items = Vec::new();
                for l in &row {
                    match delivers(l) {
                        Some((t, exit)) => items.push((l.probability, Target::Station(t), exit)),
                        None if sink_weight > 0.0 => items.push((leave * l.probability.max(0.0) / sink_weight, Target::Out(sink_index(&l.to)), class as u32)),
                        None => {}
                    }
                }
                routes.push(cumulative(items));
            }
            sim_stations.push(Station::new(s.servers as usize, s, service, routes));
        }

        // The closed forms of `jackson` are for first-come-first-served stations and plain sources.
        let plain = !extended::uses_any(net);
        let live = jackson::live(net);
        let exact = |id: &str| if plain && live.tier == jackson::Tier::Exact { live.stations.iter().find(|s| s.id == id).and_then(|s| s.mean_in_system).filter(|x| x.is_finite()) } else { None };
        let layout = Layout {
            stations: stations.iter().map(|s| StationInfo { id: s.id.clone(), name: s.name.clone(), servers: s.servers as usize, buffer_id: feeding_buffer(net, s), exact_number: exact(&s.id), priority_rank: priority_rank(s, classes) }).collect(),
            sources: sources.iter().enumerate().map(|(k, s)| SourceInfo { id: s.id.clone(), name: s.name.clone(), class: k as u32 }).collect(),
            sinks,
            classes,
            population: None,
            unstable: (0..data.d).filter(|&i| !(data.rho(i) < 1.0)).map(|i| stations[i].name.clone()).collect(),
            event_rate: data.alpha.iter().filter(|a| a.is_finite()).sum(),
        };
        let mut sim = Simulator { layout, rng: Rng::new(seed), now: 0.0, seq: 0, next_customer: 0, created: 0, left: 0, sources: sim_sources, stations: sim_stations, agenda: BinaryHeap::new(), waiting: 0, max_waiting: MAX_WAITING, halted: None };
        for k in 0..sim.sources.len() {
            let dt = sim.next_epoch(k);
            sim.schedule(dt, What::Arrival(k));
        }
        Ok(sim)
    }

    fn closed(net: &Network, seed: u64) -> Result<Simulator, Refusal> {
        let refuse = |e: closed::ClosedError| Refusal { code: "closed", message: e.message() };
        let model = closed::from_network(net).map_err(refuse)?;
        let solution = closed::means(&model).map_err(refuse)?;
        let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
        let mut sim_stations = Vec::with_capacity(stations.len());
        for (i, s) in stations.iter().enumerate() {
            let service = vec![service_sampler(s, 0).map_err(|message| Refusal { code: "distribution", message })?];
            let items = (0..stations.len()).map(|j| (model.p[i][j], Target::Station(j), 0)).collect();
            sim_stations.push(Station::new(s.servers as usize, s, service, vec![cumulative(items)]));
        }
        let layout = Layout {
            stations: stations.iter().enumerate().map(|(i, s)| StationInfo { id: s.id.clone(), name: s.name.clone(), servers: s.servers as usize, buffer_id: feeding_buffer(net, s), exact_number: Some(solution.number[i]).filter(|x| x.is_finite()), priority_rank: Vec::new() }).collect(),
            sources: Vec::new(),
            sinks: Vec::new(),
            classes: 1,
            population: Some(model.population),
            unstable: Vec::new(),
            event_rate: solution.station_throughput.iter().filter(|a| a.is_finite()).sum(),
        };
        let mut sim = Simulator { layout, rng: Rng::new(seed), now: 0.0, seq: 0, next_customer: 0, created: 0, left: 0, sources: Vec::new(), stations: sim_stations, agenda: BinaryHeap::new(), waiting: 0, max_waiting: MAX_WAITING, halted: None };
        // Everyone starts at the reference station: the first servers busy, the rest waiting.
        for _ in 0..model.population {
            let id = sim.next_customer;
            sim.next_customer += 1;
            sim.stations[0].queues[0].push_back(Waiting { customer: id, class: 0, left: None });
            sim.stations[0].waiting += 1;
            sim.stations[0].in_class[0] += 1;
            sim.waiting += 1;
        }
        sim.fill(0, None);
        Ok(sim)
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// The time the run has reached: every event up to it has been produced.
    pub fn time(&self) -> f64 {
        self.now
    }

    fn schedule(&mut self, delay: f64, what: What) -> u64 {
        self.seq += 1;
        self.agenda.push(Scheduled { time: self.now + delay, seq: self.seq, what });
        self.seq
    }

    /// The time to source `k`'s next arrival epoch: a draw of its inter-arrival law, or, with a
    /// rate profile, of the candidate process at the peak rate (thinning).
    fn next_epoch(&mut self, k: usize) -> f64 {
        let dt = self.sources[k].sampler.sample(&mut self.rng);
        match &self.sources[k].profile {
            Some((_, peak)) if *peak > 0.0 => dt / peak,
            Some(_) => f64::INFINITY,
            None => dt,
        }
    }

    /// Starts service for waiting customers at station `i` while a server is free, in the
    /// station's order; under preemptive-resume, also by interrupting a lower class.
    fn fill(&mut self, i: usize, mut out: Option<&mut Vec<Event>>) {
        loop {
            let st = &mut self.stations[i];
            if st.waiting == 0 {
                return;
            }
            let Some(r) = st.queues.iter().position(|q| !q.is_empty()) else { return };
            let server = match st.servers.iter().position(|s| s.is_none()) {
                Some(server) => server,
                None if st.preemptive => {
                    // The lowest class in service (the last such server), if lower than the head's.
                    let Some((victim, rank)) = st.servers.iter().enumerate().filter_map(|(s, c)| c.map(|(_, class)| (s, st.rank[class as usize]))).max_by_key(|(s, rank)| (*rank, *s)) else { return };
                    if rank <= r {
                        return;
                    }
                    st.account(self.now);
                    let (customer, class) = st.servers[victim].take().expect("a busy server");
                    let left = (st.ends[victim] - self.now).max(0.0);
                    st.tokens[victim] = 0;
                    st.queues[rank].push_front(Waiting { customer, class, left: Some(left) });
                    st.waiting += 1;
                    self.waiting += 1;
                    if let Some(out) = out.as_deref_mut() {
                        out.push(Event { time: self.now, kind: Kind::Preempt, customer, class, station: i as u32, server: victim as i32, other: -1 });
                    }
                    victim
                }
                None => return,
            };
            let st = &mut self.stations[i];
            st.account(self.now);
            let Waiting { customer, class, left } = st.queues[r].pop_front().unwrap();
            st.waiting -= 1;
            self.waiting -= 1;
            st.servers[server] = Some((customer, class));
            let service = match left {
                Some(left) => left,
                None => {
                    let s = st.service[class as usize].sample(&mut self.rng);
                    st.work_started += s;
                    s
                }
            };
            let token = self.schedule(service, What::Done(i, server));
            let st = &mut self.stations[i];
            st.ends[server] = self.now + service;
            st.tokens[server] = token;
            if let Some(out) = out.as_deref_mut() {
                out.push(Event { time: self.now, kind: Kind::Start, customer, class, station: i as u32, server: server as i32, other: -1 });
            }
        }
    }

    fn join(&mut self, i: usize, customer: u64, class: u32) {
        let st = &mut self.stations[i];
        st.account(self.now);
        let r = st.rank[class as usize];
        st.queues[r].push_back(Waiting { customer, class, left: None });
        st.waiting += 1;
        st.in_class[class as usize] += 1;
        st.arrivals += 1;
        self.waiting += 1;
    }

    fn step(&mut self, s: Scheduled, mut out: Option<&mut Vec<Event>>) {
        self.now = s.time;
        let mut emit = |e: Event| {
            if let Some(out) = out.as_deref_mut() {
                out.push(e);
            }
        };
        match s.what {
            What::Arrival(k) => {
                let next = self.next_epoch(k);
                self.schedule(next, What::Arrival(k));
                // Thinning: a candidate epoch of a time-varying source is kept with probability
                // m(t)/m_max.
                if let Some((profile, peak)) = &self.sources[k].profile {
                    let keep = profile.multiplier_at(self.now) / peak;
                    if !(self.rng.uniform() < keep) {
                        return;
                    }
                }
                let size = match &self.sources[k].batch {
                    Some(b) => draw_batch(b, &mut self.rng),
                    None => 1,
                };
                let class = self.sources[k].class;
                for _ in 0..size {
                    let u = self.rng.uniform();
                    let Some(Target::Station(i)) = choose(&self.sources[k].branches, u).map(|b| b.target) else { continue };
                    let customer = self.next_customer;
                    self.next_customer += 1;
                    self.created += 1;
                    self.join(i, customer, class);
                    if let Some(out) = out.as_deref_mut() {
                        out.push(Event { time: self.now, kind: Kind::Arrive, customer, class, station: i as u32, server: -1, other: k as i32 });
                    }
                    self.fill(i, out.as_deref_mut());
                }
            }
            What::Done(i, server) => {
                let st = &mut self.stations[i];
                // A completion cancelled by a preemption.
                if st.tokens[server] != s.seq {
                    return;
                }
                st.account(self.now);
                let (customer, class) = st.servers[server].take().expect("a scheduled completion has a customer in service");
                st.tokens[server] = 0;
                st.in_class[class as usize] -= 1;
                st.departures_class[class as usize] += 1;
                st.departures += 1;
                emit(Event { time: self.now, kind: Kind::Depart, customer, class, station: i as u32, server: server as i32, other: -1 });
                let u = self.rng.uniform();
                let (target, class_out) = match choose(&self.stations[i].routes[class as usize], u) {
                    Some(b) => (b.target, b.class),
                    None => (Target::Out(-1), class),
                };
                match target {
                    Target::Station(j) => {
                        self.join(j, customer, class_out);
                        emit(Event { time: self.now, kind: Kind::Route, customer, class: class_out, station: i as u32, server: -1, other: j as i32 });
                        // The station just left serves its next customer first, then the one joined.
                        self.fill(i, out.as_deref_mut());
                        if j != i {
                            self.fill(j, out);
                        }
                    }
                    Target::Out(sink) => {
                        self.left += 1;
                        emit(Event { time: self.now, kind: Kind::Leave, customer, class, station: i as u32, server: -1, other: sink });
                        self.fill(i, out);
                    }
                }
            }
        }
    }

    fn run(&mut self, max_events: usize, until: f64, mut out: Option<&mut Vec<Event>>) -> usize {
        let mut steps = 0;
        loop {
            // Stopped for good: time does not move on either.
            if self.halted.is_some() {
                return steps;
            }
            if self.waiting > self.max_waiting {
                self.halted = (0..self.stations.len()).max_by_key(|i| self.stations[*i].waiting);
                return steps;
            }
            match self.agenda.peek().copied() {
                Some(s) if s.time <= until => {
                    if steps >= max_events {
                        return steps;
                    }
                    self.agenda.pop();
                    self.step(s, out.as_deref_mut());
                    steps += 1;
                }
                _ => {
                    // Nothing more happens before `until`.
                    if until.is_finite() && until > self.now {
                        self.now = until;
                    }
                    return steps;
                }
            }
        }
    }

    /// The events up to time `until`, stopping early after `max_steps` arrivals and service
    /// completions (each gives up to four events). Afterwards [`time`](Self::time) is `until`, or
    /// the time of the last event when it stopped early.
    pub fn advance(&mut self, max_steps: usize, until: f64) -> Vec<Event> {
        let mut out = Vec::new();
        self.run(max_steps, until, Some(&mut out));
        out
    }

    /// Runs to time `until` without reporting events (skip ahead), with the same early stop.
    /// Returns the number of arrivals and completions simulated.
    pub fn skip(&mut self, max_steps: usize, until: f64) -> usize {
        self.run(max_steps, until, None)
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot { time: self.now, queues: self.stations.iter().map(|s| s.waiting_in_order().collect()).collect(), servers: self.stations.iter().map(|s| s.servers.clone()).collect() }
    }

    /// The snapshot for a picture: of each queue only the first `head` customers, and beside
    /// them how many wait at each station in all. What a picture draws is a few tokens and a
    /// count, and a queue can hold a million.
    pub fn snapshot_head(&self, head: usize) -> (Snapshot, Vec<u64>) {
        let queues = self.stations.iter().map(|s| s.waiting_in_order().take(head).collect()).collect();
        (Snapshot { time: self.now, queues, servers: self.stations.iter().map(|s| s.servers.clone()).collect() }, self.stations.iter().map(|s| s.waiting as u64).collect())
    }

    /// When the run has been stopped because more than [`MAX_WAITING`] customers were waiting:
    /// the station with the longest queue and that queue's length. The run does not go on.
    pub fn halted(&self) -> Option<(usize, usize)> {
        self.halted.map(|i| (i, self.stations[i].waiting))
    }

    /// For tests: stop at fewer waiting customers than [`MAX_WAITING`].
    pub fn set_max_waiting(&mut self, n: usize) {
        self.max_waiting = n;
    }

    /// The running totals, brought up to [`time`](Self::time).
    pub fn stats(&mut self) -> Stats {
        let now = self.now;
        for s in &mut self.stations {
            s.account(now);
        }
        Stats {
            time: now,
            area_number: self.stations.iter().map(|s| s.area_number).collect(),
            area_queue: self.stations.iter().map(|s| s.area_queue).collect(),
            arrivals: self.stations.iter().map(|s| s.arrivals).collect(),
            departures: self.stations.iter().map(|s| s.departures).collect(),
            created: self.created,
            left: self.left,
            // With one class the class integral is the station's own (and is not kept twice).
            area_class: self.stations.iter().map(|s| if s.area_class.len() == 1 { vec![s.area_number] } else { s.area_class.clone() }).collect(),
            departures_class: self.stations.iter().map(|s| s.departures_class.clone()).collect(),
            work_started: self.stations.iter().map(|s| s.work_started).collect(),
            work_left: self
                .stations
                .iter()
                .map(|s| {
                    let serving: f64 = s.servers.iter().zip(&s.ends).filter(|(c, _)| c.is_some()).map(|(_, end)| (end - now).max(0.0)).sum();
                    let interrupted: f64 = s.queues.iter().flat_map(|q| q.iter()).filter_map(|w| w.left).sum();
                    serving + interrupted
                })
                .collect(),
        }
    }

    /// The number of customers at each station now (waiting and in service).
    pub fn numbers(&self) -> Vec<usize> {
        self.stations.iter().map(|s| s.waiting + s.busy()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bnet;
    use crate::model::{Link, ServiceConfig};
    use crate::uncertainty::normal_cdf;

    // ── Networks ────────────────────────────────────────────────────────────────────────────

    fn node(kind: NodeKind, name: &str, d: Distribution, params: &str, servers: i64) -> Node {
        let mut n = Node::new(name, kind, name, (0.0, 0.0));
        n.distribution = d;
        n.parameters = params.to_string();
        n.servers = servers;
        n
    }

    fn link(from: &str, to: &str, p: f64, class: i64) -> Link {
        Link { id: format!("{from}>{to}:{class}"), from: from.into(), to: to.into(), probability: p, class, to_class: None }
    }

    fn network(nodes: Vec<Node>, links: Vec<Link>) -> Network {
        Network { nodes, links, infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
    }

    /// Source → B1 → S1 → Sink, with the given laws.
    fn single(arrival: (Distribution, &str), service: (Distribution, &str), servers: i64) -> Network {
        network(
            vec![node(NodeKind::Source, "A1", arrival.0, arrival.1, 1), node(NodeKind::Buffer, "B1", Distribution::Exponential, "", 1), node(NodeKind::Station, "S1", service.0, service.1, servers), node(NodeKind::Sink, "Out", Distribution::Exponential, "", 1)],
            vec![link("A1", "B1", 1.0, 0), link("B1", "S1", 1.0, 0), link("S1", "Out", 1.0, 0)],
        )
    }

    fn mm(lambda: f64, mu: f64, servers: i64) -> Network {
        single((Distribution::Poisson, &format!("lambda={lambda}")), (Distribution::Exponential, &format!("rate={mu}")), servers)
    }

    /// A closed cycle S1 → S2 → S3 → S1 with a branch S1 → S1 of probability `back`.
    fn cycle(mu: [f64; 3], servers: [i64; 3], back: f64, population: i64) -> Network {
        let mut nodes = Vec::new();
        let mut links = Vec::new();
        for i in 0..3 {
            nodes.push(node(NodeKind::Buffer, &format!("B{}", i + 1), Distribution::Exponential, "", 1));
            nodes.push(node(NodeKind::Station, &format!("S{}", i + 1), Distribution::Exponential, &format!("rate={}", mu[i]), servers[i]));
            links.push(link(&format!("B{}", i + 1), &format!("S{}", i + 1), 1.0, 0));
        }
        links.push(link("S1", "B2", 1.0 - back, 0));
        if back > 0.0 {
            links.push(link("S1", "B1", back, 0));
        }
        links.push(link("S2", "B3", 1.0, 0));
        links.push(link("S3", "B1", 1.0, 0));
        let mut net = network(nodes, links);
        net.population = Some(population);
        net
    }

    fn example(name: &str) -> Network {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(name);
        bnet::read(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    // ── Batch means ─────────────────────────────────────────────────────────────────────────

    /// Student's t quantile t(29, 0.9995): the two-sided 99.9 % band with 30 batches. A 99.9 %
    /// band (not 95 %) because these are fixed-seed regression tests, a dozen of them: a correct
    /// simulator should essentially never fail one, and a wrong one misses by many widths.
    const T29_999: f64 = 3.659;
    const BATCHES: usize = 30;

    struct Estimate {
        mean: f64,
        /// Half-width of the 99.9 % band.
        half: f64,
    }

    impl Estimate {
        fn of(values: &[f64]) -> Estimate {
            let n = values.len() as f64;
            let mean = values.iter().sum::<f64>() / n;
            let var = values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / (n - 1.0);
            Estimate { mean, half: T29_999 * (var / n).sqrt() }
        }

        /// The exact value lies in the band, and the band is tight enough to mean something:
        /// narrower than `power` of the exact value.
        fn holds(&self, exact: f64, power: f64, what: &str) {
            assert!(self.half < power * exact.abs(), "{what}: the band ±{} is too wide to test {exact}", self.half);
            assert!((self.mean - exact).abs() <= self.half, "{what}: simulated {} ± {} (99.9 %), exact {exact}", self.mean, self.half);
        }
    }

    /// Per station, the time-average number in system and number waiting over 30 batches of
    /// `batch` time units after a warm-up, and the throughput (departures per time unit).
    fn batch_means(sim: &mut Simulator, warm_up: f64, batch: f64) -> Vec<(Estimate, Estimate, Estimate)> {
        sim.skip(usize::MAX, warm_up);
        let d = sim.layout().stations.len();
        let mut before = sim.stats();
        let mut rows = vec![(Vec::new(), Vec::new(), Vec::new()); d];
        for b in 1..=BATCHES {
            sim.skip(usize::MAX, warm_up + b as f64 * batch);
            let after = sim.stats();
            for i in 0..d {
                rows[i].0.push((after.area_number[i] - before.area_number[i]) / batch);
                rows[i].1.push((after.area_queue[i] - before.area_queue[i]) / batch);
                rows[i].2.push((after.departures[i] - before.departures[i]) as f64 / batch);
            }
            before = after;
        }
        rows.iter().map(|(n, q, x)| (Estimate::of(n), Estimate::of(q), Estimate::of(x))).collect()
    }

    // ── Samplers ────────────────────────────────────────────────────────────────────────────

    /// P(Gamma(k, 1) ≤ x) for whole k (the Erlang law): 1 − e^(−x) Σ_{n<k} xⁿ/n!.
    fn erlang_cdf(k: u32, x: f64) -> f64 {
        let mut term = 1.0;
        let mut sum = 1.0;
        for n in 1..k {
            term *= x / n as f64;
            sum += term;
        }
        1.0 - (-x).exp() * sum
    }

    /// Every family, against its mean and SCV (`dist`) and its distribution function.
    ///
    /// Kolmogorov–Smirnov: with n = 40 000 draws, sup|F_n − F| < 1.95/√n holds with probability
    /// 99.9 % for a correct sampler (the asymptotic Kolmogorov quantile K(0.999) = 1.95).
    /// The mean is held within 4 standard errors and the SCV within 5 % (the families tested
    /// have a finite fourth moment, so the sample variance settles: Pareto is tested at α = 6).
    #[test]
    fn every_family_is_sampled_from_its_own_law() {
        use Distribution::*;
        type Cdf = Box<dyn Fn(f64) -> f64>;
        let cases: Vec<(Distribution, &str, Cdf)> = vec![
            (Exponential, "rate=2.5", Box::new(|x| 1.0 - (-2.5 * x).exp())),
            (Poisson, "lambda=0.4", Box::new(|x| 1.0 - (-0.4 * x).exp())),
            (Uniform, "min=0.5,max=2", Box::new(|x| ((x - 0.5) / 1.5).clamp(0.0, 1.0))),
            (Erlang, "k=3,rate=2", Box::new(|x| erlang_cdf(3, 2.0 * x))),
            // Whole shape: the Erlang law, reached here by Marsaglia–Tsang rather than by a sum.
            (Gamma, "shape=4,scale=0.5", Box::new(|x| erlang_cdf(4, x / 0.5))),
            // Shape ½: θ·Z²/2·2 — X/θ = Z²/2, so P(X ≤ x) = 2Φ(√(2x/θ)) − 1. Exercises shape < 1.
            (Gamma, "shape=0.5,scale=3", Box::new(|x| 2.0 * normal_cdf((2.0 * x / 3.0).sqrt()) - 1.0)),
            (Gamma, "shape=1,scale=2", Box::new(|x| 1.0 - (-x / 2.0).exp())),
            (Weibull, "shape=1.5,scale=2", Box::new(|x| 1.0 - (-(x / 2.0).powf(1.5)).exp())),
            (Lognormal, "mu=0.3,sigma=0.5", Box::new(|x| normal_cdf((x.ln() - 0.3) / 0.5))),
            (Pareto, "shape=6,scale=1.5", Box::new(|x| if x < 1.5 { 0.0 } else { 1.0 - (1.5 / x).powf(6.0) })),
            // More stages than the sum handles: drawn as Gamma(80, 1/4), whose law is Erlang's.
            (Erlang, "k=80,rate=4", Box::new(|x| erlang_cdf(80, 4.0 * x))),
        ];
        const N: usize = 40_000;
        for (i, (d, text, cdf)) in cases.iter().enumerate() {
            let s = Sampler::new(*d, text, "X").unwrap();
            let mut rng = Rng::new(1000 + i as u64);
            let mut x: Vec<f64> = (0..N).map(|_| s.sample(&mut rng)).collect();
            assert!(x.iter().all(|v| v.is_finite() && *v >= 0.0), "{d:?} {text}");
            let mean = x.iter().sum::<f64>() / N as f64;
            let var = x.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / (N as f64 - 1.0);
            let exact_mean = dist::mean_from_text(*d, text).unwrap();
            let exact_scv = dist::scv_from_text(*d, text).unwrap();
            assert!((s.mean() - exact_mean).abs() < 1e-12 * exact_mean, "{d:?} {text}: the sampler's mean is dist's");
            assert!((mean - exact_mean).abs() < 4.0 * (var / N as f64).sqrt(), "{d:?} {text}: mean {mean}, exact {exact_mean}");
            assert!((var / (mean * mean) - exact_scv).abs() < 0.05 * exact_scv, "{d:?} {text}: SCV {}, exact {exact_scv}", var / (mean * mean));
            x.sort_by(|a, b| a.total_cmp(b));
            let ks = x.iter().enumerate().map(|(j, v)| f64::max((cdf(*v) - j as f64 / N as f64).abs(), ((j + 1) as f64 / N as f64 - cdf(*v)).abs())).fold(0.0, f64::max);
            assert!(ks < 1.95 / (N as f64).sqrt(), "{d:?} {text}: Kolmogorov–Smirnov distance {ks}");
        }
        // A deterministic time is itself.
        let c = Sampler::new(Constant, "value=0.75", "X").unwrap();
        assert_eq!(c.sample(&mut Rng::new(1)), 0.75);
    }

    #[test]
    fn parameters_are_read_as_the_analysis_reads_them_and_bad_ones_are_refused() {
        // A missing key takes the family's default, as `traffic::rate` does.
        assert_eq!(Sampler::new(Distribution::Exponential, "", "S1"), Ok(Sampler::Exponential { rate: 1.0 }));
        assert_eq!(Sampler::new(Distribution::Gamma, "shape=3", "S1"), Ok(Sampler::Gamma { shape: 3.0, scale: 1.0 }));
        for d in Distribution::ALL {
            let s = Sampler::new(d, d.default_parameters(), "S1").unwrap();
            assert!((1.0 / s.mean() - traffic::rate(d, d.default_parameters())).abs() < 1e-12, "{d:?}: the sampler's rate is traffic's");
        }
        assert_eq!(Sampler::new(Distribution::Exponential, "rate=0", "S1"), Err("S1: Rate (λ) must be > 0.".into()));
        assert_eq!(Sampler::new(Distribution::Erlang, "k=2.5,rate=1", "S1"), Err("S1: Stages (k) must be a whole number.".into()));
        assert_eq!(Sampler::new(Distribution::Uniform, "min=2,max=1", "S1"), Err("S1: Max must be greater than Min.".into()));
        assert!(Sampler::new(Distribution::Pareto, "shape=1.5,scale=1", "S1").is_err(), "the model refuses a Pareto law without a variance");
    }

    // ── Long-run averages against the closed forms ──────────────────────────────────────────

    /// M/M/1 at ρ = 0.7 against `jackson::mmc` (L = ρ/(1 − ρ) = 7/3, Lq = L − ρ) and the
    /// throughput λ. 30 batches of 4000 time units after a warm-up of 2000.
    #[test]
    fn mm1_time_averages_match_the_closed_form() {
        let mut sim = Simulator::new(&mm(0.7, 1.0, 1), 11).unwrap();
        assert_eq!(sim.layout().stations[0].exact_number.map(|l| (l * 1e9).round()), Some((7.0f64 / 3.0 * 1e9).round()));
        let exact = jackson::mmc(1, 0.7);
        let r = &batch_means(&mut sim, 2000.0, 4000.0)[0];
        r.0.holds(exact.number, 0.08, "M/M/1 L");
        r.1.holds(exact.queue, 0.10, "M/M/1 Lq");
        r.2.holds(0.7, 0.02, "M/M/1 throughput");
    }

    /// M/M/3 at offered load a = 2.4 (ρ = 0.8) against Erlang C by `jackson::mmc`.
    #[test]
    fn mmc_time_averages_match_erlang_c() {
        let mut sim = Simulator::new(&mm(2.4, 1.0, 3), 12).unwrap();
        let exact = jackson::mmc(3, 2.4);
        let r = &batch_means(&mut sim, 2000.0, 4000.0)[0];
        r.0.holds(exact.number, 0.08, "M/M/3 L");
        r.1.holds(exact.queue, 0.12, "M/M/3 Lq");
        r.2.holds(2.4, 0.02, "M/M/3 throughput");
    }

    /// The shipped Jackson example with feedback (two stations, 30 % of S2's output returns to
    /// S1), read from its file: per station L and throughput against `jackson::solve`.
    #[test]
    fn a_jackson_network_with_feedback_matches_the_product_form() {
        let net = example("OpenJackson.d2.feedback.p30.inf.bnet");
        let exact = jackson::solve(&jackson::from_network(&net).unwrap()).unwrap();
        let mut sim = Simulator::new(&net, 13).unwrap();
        assert!(sim.layout().unstable.is_empty());
        let rows = batch_means(&mut sim, 2000.0, 4000.0);
        for i in 0..2 {
            rows[i].0.holds(exact.number[i], 0.08, "Jackson L");
            rows[i].1.holds(exact.queue[i], 0.10, "Jackson Lq");
            rows[i].2.holds(exact.alpha[i], 0.02, "Jackson throughput");
            let shown = sim.layout().stations[i].exact_number.unwrap();
            assert!((shown - exact.number[i]).abs() < 1e-9, "the dashed line is the product form's L");
        }
    }

    /// A closed network of three stations (one with two servers, one with feedback to itself) and
    /// 6 customers against Gordon–Newell by `closed::means`: L_i and the station throughputs.
    #[test]
    fn a_closed_cycle_matches_gordon_newell() {
        let net = cycle([1.0, 0.8, 1.5], [1, 2, 1], 0.25, 6);
        let model = closed::from_network(&net).unwrap();
        let exact = closed::means(&model).unwrap();
        let mut sim = Simulator::new(&net, 14).unwrap();
        assert_eq!(sim.layout().population, Some(6));
        let rows = batch_means(&mut sim, 1000.0, 3000.0);
        for i in 0..3 {
            rows[i].0.holds(exact.number[i], 0.05, "closed L");
            rows[i].2.holds(exact.station_throughput[i], 0.02, "closed throughput");
        }
    }

    /// Non-exponential service and two classes at one station, against Pollaczek–Khinchine
    /// (Gross et al., *Fundamentals of Queueing Theory*, 4th ed., §5.1.1):
    /// L = ρ + λ²E[S²]/(2(1 − ρ)).
    #[test]
    fn mg1_matches_pollaczek_khinchine() {
        let pk = |lambda: f64, m1: f64, m2: f64| lambda * m1 + lambda * lambda * m2 / (2.0 * (1.0 - lambda * m1));
        // M/E₂/1: Erlang(2, rate 3), mean 2/3, E[S²] = k(k+1)/rate² = 6/9.
        let mut sim = Simulator::new(&single((Distribution::Poisson, "lambda=1"), (Distribution::Erlang, "k=2,rate=3"), 1), 15).unwrap();
        batch_means(&mut sim, 2000.0, 4000.0)[0].0.holds(pk(1.0, 2.0 / 3.0, 6.0 / 9.0), 0.08, "M/E2/1 L");
        // M/D/1 at ρ = 0.8.
        let mut sim = Simulator::new(&single((Distribution::Poisson, "lambda=0.8"), (Distribution::Constant, "value=1"), 1), 16).unwrap();
        batch_means(&mut sim, 2000.0, 4000.0)[0].0.holds(pk(0.8, 1.0, 1.0), 0.08, "M/D/1 L");
        // Two classes sharing S1: class 1 at rate 0.3 with Exp(1) service, class 2 at rate 0.2
        // with Uniform(0.5, 1.5) service (per-class law). The mixture's moments:
        // E[S] = 0.6·1 + 0.4·1 = 1, E[S²] = 0.6·2 + 0.4·(1 + 1/12).
        let mut s1 = node(NodeKind::Station, "S1", Distribution::Exponential, "rate=1", 1);
        s1.service_by_class.insert(1, ServiceConfig { distribution: Distribution::Uniform, parameters: "min=0.5,max=1.5".into() });
        let net = network(
            vec![
                node(NodeKind::Source, "A1", Distribution::Poisson, "lambda=0.3", 1),
                node(NodeKind::Source, "A2", Distribution::Poisson, "lambda=0.2", 1),
                node(NodeKind::Buffer, "B1", Distribution::Exponential, "", 1),
                s1,
                node(NodeKind::Sink, "Out", Distribution::Exponential, "", 1),
            ],
            vec![link("A1", "B1", 1.0, 0), link("A2", "B1", 1.0, 1), link("B1", "S1", 1.0, 0), link("S1", "Out", 1.0, 0), link("S1", "Out", 1.0, 1)],
        );
        let mut sim = Simulator::new(&net, 17).unwrap();
        assert_eq!(sim.layout().classes, 2);
        assert_eq!(sim.layout().stations[0].exact_number, None, "two classes at a station: no closed form is claimed");
        batch_means(&mut sim, 2000.0, 4000.0)[0].0.holds(pk(0.5, 1.0, 0.6 * 2.0 + 0.4 * (1.0 + 1.0 / 12.0)), 0.08, "two-class M/G/1 L");
    }

    // ── Structure of the event stream ───────────────────────────────────────────────────────

    /// Replays events from a snapshot, checking that every one is legal: a customer is in exactly
    /// one place, a server holds one customer, service is first come first served.
    struct Replay {
        queues: Vec<VecDeque<(u64, u32)>>,
        servers: Vec<Vec<Option<(u64, u32)>>>,
        /// The customer that departed and has not yet been routed or left, with its station.
        in_hand: Option<(u64, usize)>,
        place: HashMap<u64, usize>,
        time: f64,
    }

    impl Replay {
        fn from(s: &Snapshot) -> Replay {
            let mut place = HashMap::new();
            for (i, q) in s.queues.iter().enumerate() {
                for (c, _) in q {
                    assert!(place.insert(*c, i).is_none(), "customer {c} is in two places at the start");
                }
            }
            for (i, row) in s.servers.iter().enumerate() {
                for (c, _) in row.iter().flatten() {
                    assert!(place.insert(*c, i).is_none(), "customer {c} is in two places at the start");
                }
            }
            Replay { queues: s.queues.iter().map(|q| q.iter().copied().collect()).collect(), servers: s.servers.clone(), in_hand: None, place, time: s.time }
        }

        fn apply(&mut self, e: &Event) {
            assert!(e.time >= self.time, "time runs forwards");
            self.time = e.time;
            let i = e.station as usize;
            match e.kind {
                Kind::Arrive => {
                    assert!(self.in_hand.is_none());
                    assert!(self.place.insert(e.customer, i).is_none(), "a new customer is new");
                    self.queues[i].push_back((e.customer, e.class));
                }
                Kind::Start => {
                    // First come first served: only the head of the queue starts service.
                    assert_eq!(self.queues[i].pop_front(), Some((e.customer, e.class)), "FCFS at station {i}");
                    let slot = &mut self.servers[i][e.server as usize];
                    assert!(slot.is_none(), "the server is free");
                    // The lowest-numbered free server is taken.
                    *slot = Some((e.customer, e.class));
                    assert!(self.servers[i][..e.server as usize].iter().all(|s| s.is_some()), "the lowest free server is taken");
                    assert_eq!(self.place[&e.customer], i);
                }
                Kind::Depart => {
                    assert!(self.in_hand.is_none());
                    assert_eq!(self.servers[i][e.server as usize].take(), Some((e.customer, e.class)), "the customer in that server departs");
                    self.place.remove(&e.customer);
                    self.in_hand = Some((e.customer, i));
                }
                Kind::Route => {
                    assert_eq!(self.in_hand.take(), Some((e.customer, i)), "a routed customer has just departed");
                    let j = e.other as usize;
                    self.queues[j].push_back((e.customer, e.class));
                    self.place.insert(e.customer, j);
                }
                Kind::Preempt => panic!("a first-come-first-served station never interrupts a service"),
                Kind::Leave => {
                    assert_eq!(self.in_hand.take(), Some((e.customer, i)), "a leaving customer has just departed");
                }
            }
            // No work is left undone: a station with someone waiting has no free server, once
            // the events of this instant are in (checked by the caller at chunk ends).
        }

        fn snapshot(&self) -> Snapshot {
            Snapshot { time: self.time, queues: self.queues.iter().map(|q| q.iter().copied().collect()).collect(), servers: self.servers.clone() }
        }

        fn number(&self, i: usize) -> usize {
            self.queues[i].len() + self.servers[i].iter().flatten().count()
        }
    }

    /// A network that exercises everything at once: three classes, a class change, feedback,
    /// several servers, non-exponential laws, two sinks.
    fn busy_network() -> Network {
        example("3d3ctandem.inf.bnet")
    }

    #[test]
    fn every_event_is_legal_fcfs_holds_and_no_customer_is_in_two_places() {
        for (net, seed) in [(busy_network(), 21), (example("OpenJackson.d2.feedback.p50.inf.bnet"), 22), (mm(2.4, 1.0, 3), 23), (cycle([1.0, 0.8, 1.5], [1, 2, 1], 0.25, 6), 24), (example("Bramson94.d2.c5.reentrant.inf.bnet"), 25)] {
            let mut sim = Simulator::new(&net, seed).unwrap();
            let mut replay = Replay::from(&sim.snapshot());
            let d = sim.layout().stations.len();
            let mut joined = vec![0u64; d];
            let mut served = vec![0u64; d];
            let (mut created, mut left) = (0u64, 0u64);
            let start: Vec<usize> = (0..d).map(|i| replay.number(i)).collect();
            let mut total = 0;
            while total < 60_000 {
                let events = sim.advance(500, f64::INFINITY);
                assert!(!events.is_empty());
                total += events.len();
                for e in &events {
                    replay.apply(e);
                    match e.kind {
                        Kind::Arrive => {
                            joined[e.station as usize] += 1;
                            created += 1;
                        }
                        Kind::Route => joined[e.other as usize] += 1,
                        Kind::Depart => served[e.station as usize] += 1,
                        Kind::Leave => left += 1,
                        Kind::Start | Kind::Preempt => {}
                    }
                }
                // The replayed state is the simulator's, and no server idles beside a queue.
                assert_eq!(replay.snapshot(), sim.snapshot());
                assert!(replay.in_hand.is_none());
                for i in 0..d {
                    assert!(replay.queues[i].is_empty() || replay.servers[i].iter().all(|s| s.is_some()), "work-conserving at station {i}");
                    // Flow conservation at each station: in − out = the change in its content.
                    assert_eq!(start[i] as i64 + joined[i] as i64 - served[i] as i64, replay.number(i) as i64);
                }
                // …and for the network: created − left = in the network (constant when closed).
                let inside: usize = (0..d).map(|i| replay.number(i)).sum();
                assert_eq!(start.iter().sum::<usize>() as i64 + created as i64 - left as i64, inside as i64);
                if let Some(n) = sim.layout().population {
                    assert_eq!(inside, n, "a closed network keeps its population");
                    assert_eq!((created, left), (0, 0));
                }
                let stats = sim.stats();
                assert_eq!((&stats.arrivals, &stats.departures, stats.created, stats.left), (&joined, &served, created, left), "the running totals are the events'");
            }
        }
    }

    /// Ledger WF-508: a run whose queues grow without limit stops at a stated number waiting,
    /// keeps its state, and never moves again; a picture's snapshot names only the queue's head.
    #[test]
    fn an_overloaded_run_stops_at_its_size_limit_and_a_snapshot_for_a_picture_is_small() {
        let mut net = example("OpenJackson.d2.feedback.p30.inf.bnet");
        for n in net.nodes.iter_mut().filter(|n| n.kind == NodeKind::Source) {
            n.parameters = "lambda=40.0".into();
        }
        let mut sim = Simulator::new(&net, 11).unwrap();
        sim.set_max_waiting(5_000);
        assert_eq!(sim.halted(), None);
        sim.skip(usize::MAX, 1e9);
        let (station, length) = sim.halted().expect("stopped at the limit");
        let whole = sim.snapshot();
        let waiting: usize = whole.queues.iter().map(Vec::len).sum();
        assert_eq!(waiting, 5_001, "one past the limit, and no more");
        assert_eq!(whole.queues[station].len(), length);
        assert!(whole.queues.iter().all(|q| q.len() <= length));
        let stopped_at = sim.time();
        assert!(stopped_at < 1e9, "time stops where the run did");
        assert!(sim.advance(1000, f64::INFINITY).is_empty());
        assert_eq!(sim.skip(1000, 2e9), 0);
        assert_eq!((sim.time(), sim.snapshot()), (stopped_at, whole.clone()));
        let (head, counts) = sim.snapshot_head(6);
        assert_eq!(counts, whole.queues.iter().map(|q| q.len() as u64).collect::<Vec<_>>());
        for (h, q) in head.queues.iter().zip(&whole.queues) {
            assert_eq!(h[..], q[..q.len().min(6)]);
        }
        assert_eq!(head.servers, whole.servers);
        // A stable run never comes near the limit.
        let mut calm = Simulator::new(&example("OpenJackson.d2.feedback.p30.inf.bnet"), 11).unwrap();
        calm.skip(200_000, 1e9);
        assert_eq!(calm.halted(), None);
    }

    /// The time integrals the simulator keeps are those of the event stream: ∫N dt rebuilt from
    /// the events alone, to rounding. (The interface's own bookkeeping is held to the same
    /// numbers through a recorded fixture, src/animate/fixtures.)
    #[test]
    fn the_running_areas_are_the_integrals_of_the_event_stream() {
        let mut sim = Simulator::new(&example("OpenJackson.d2.feedback.p30.inf.bnet"), 31).unwrap();
        let mut n = [0f64; 2];
        let mut area = [0f64; 2];
        let mut last = 0.0;
        for _ in 0..40 {
            let until = sim.time() + 25.0;
            for e in sim.advance(usize::MAX, until) {
                for i in 0..2 {
                    area[i] += n[i] * (e.time - last);
                }
                last = e.time;
                match e.kind {
                    Kind::Arrive => n[e.station as usize] += 1.0,
                    Kind::Route => n[e.other as usize] += 1.0,
                    Kind::Depart => n[e.station as usize] -= 1.0,
                    _ => {}
                }
            }
            assert_eq!(sim.time(), until, "a chunk ends at the time asked for");
            let stats = sim.stats();
            for i in 0..2 {
                let mine = area[i] + n[i] * (until - last);
                assert!((stats.area_number[i] - mine).abs() < 1e-9 * (1.0 + mine), "{} vs {mine}", stats.area_number[i]);
            }
        }
    }

    /// PASTA (Wolff 1982, "Poisson arrivals see time averages", Oper. Res. 30:223–231): in M/M/1
    /// the fraction of arrivals that find n customers is the fraction of time there are n,
    /// (1 − ρ)ρⁿ. Both are estimated from one run of 120 000 time units after a warm-up and held
    /// to the exact value within 0.012 (about 5 standard errors of the more variable of the two
    /// at these run lengths: the arrival fractions come from ~84 000 correlated arrivals).
    #[test]
    fn poisson_arrivals_see_time_averages() {
        let rho = 0.7;
        let mut sim = Simulator::new(&mm(rho, 1.0, 1), 41).unwrap();
        sim.skip(usize::MAX, 1000.0);
        let mut n = { let s = sim.snapshot(); s.queues[0].len() + s.servers[0].iter().flatten().count() };
        let mut seen = [0f64; 4];
        let mut time_at = [0f64; 4];
        let (mut arrivals, mut last) = (0f64, sim.time());
        let end = 121_000.0;
        for e in sim.advance(usize::MAX, end) {
            if n < 4 {
                time_at[n] += e.time - last;
            }
            last = e.time;
            match e.kind {
                Kind::Arrive => {
                    if n < 4 {
                        seen[n] += 1.0;
                    }
                    arrivals += 1.0;
                    n += 1;
                }
                Kind::Depart => n -= 1,
                _ => {}
            }
        }
        if n < 4 {
            time_at[n] += end - last;
        }
        for k in 0..4 {
            let exact = (1.0 - rho) * rho.powi(k as i32);
            let (by_arrivals, by_time) = (seen[k] / arrivals, time_at[k] / (end - 1000.0));
            assert!((by_arrivals - exact).abs() < 0.012, "arrivals finding {k}: {by_arrivals}, exact {exact}");
            assert!((by_time - exact).abs() < 0.012, "time with {k}: {by_time}, exact {exact}");
            assert!((by_arrivals - by_time).abs() < 0.012, "PASTA at {k}: {by_arrivals} against {by_time}");
        }
    }

    #[test]
    fn a_seed_gives_one_run_however_it_is_cut_into_chunks() {
        let net = busy_network();
        let whole = Simulator::new(&net, 7).unwrap().advance(usize::MAX, 300.0);
        assert!(whole.len() > 1000);
        // The same seed again.
        assert_eq!(Simulator::new(&net, 7).unwrap().advance(usize::MAX, 300.0), whole);
        // In small chunks by count, and in chunks by time.
        let mut sim = Simulator::new(&net, 7).unwrap();
        let mut pieces = Vec::new();
        while sim.time() < 300.0 {
            let before = sim.time();
            pieces.extend(sim.advance(7, 300.0));
            assert!(sim.time() >= before);
        }
        assert_eq!(pieces, whole);
        let mut sim = Simulator::new(&net, 7).unwrap();
        let mut pieces = Vec::new();
        for step in 1..=60 {
            pieces.extend(sim.advance(usize::MAX, step as f64 * 5.0));
        }
        assert_eq!(pieces, whole);
        // Skipping produces the same state as playing.
        let mut played = Simulator::new(&net, 7).unwrap();
        played.advance(usize::MAX, 300.0);
        let mut skipped = Simulator::new(&net, 7).unwrap();
        skipped.skip(usize::MAX, 300.0);
        assert_eq!(played.snapshot(), skipped.snapshot());
        assert_eq!(played.stats(), skipped.stats());
        // Another seed is another run.
        assert_ne!(Simulator::new(&net, 8).unwrap().advance(usize::MAX, 300.0), whole);
    }

    #[test]
    fn events_name_sources_sinks_and_class_changes() {
        // Bramson's re-entrant line: one source, three classes by class-changing links, one sink.
        let net = example("Bramson94.d2.c5.reentrant.inf.bnet");
        let mut sim = Simulator::new(&net, 51).unwrap();
        let layout = sim.layout().clone();
        assert_eq!((layout.sources.len(), layout.classes, layout.sinks.len()), (1, 3, 1));
        assert!(layout.stations.iter().all(|s| net.node(&s.buffer_id).is_some_and(|b| b.kind == NodeKind::Buffer)));
        let events = sim.advance(20_000, f64::INFINITY);
        assert!(events.iter().filter(|e| e.kind == Kind::Arrive).all(|e| e.class == 0 && e.other == 0));
        assert!(events.iter().filter(|e| e.kind == Kind::Leave).all(|e| e.class == 2 && e.other == 0), "customers leave as class 3, by the sink");
        // A routed customer keeps its class or moves up one (the class-changing links), and both happen.
        let mut changes = 0;
        let mut class: HashMap<u64, u32> = HashMap::new();
        for e in &events {
            match e.kind {
                Kind::Arrive => {
                    class.insert(e.customer, e.class);
                }
                Kind::Route => {
                    let before = class.insert(e.customer, e.class).unwrap();
                    assert!(e.class == before || e.class == before + 1);
                    changes += (e.class != before) as usize;
                }
                _ => {}
            }
        }
        assert!(changes > 1000);
    }

    // ── What is refused, and what is merely unstable ────────────────────────────────────────

    #[test]
    fn finite_buffers_a_missing_population_and_bad_laws_are_refused_with_a_sentence() {
        let refusal = |net: &Network| Simulator::new(net, 1).err().unwrap();
        let mut finite = mm(0.7, 1.0, 1);
        finite.infinite_buffers = false;
        assert_eq!(refusal(&finite), Refusal { code: "finiteBuffers", message: FINITE_SENTENCE.into() });
        assert_eq!(refusal(&example("MM1K.d1.c1.fin.bnet")).code, "finiteBuffers");
        let mut no_population = cycle([1.0, 1.0, 1.0], [1, 1, 1], 0.0, 3);
        no_population.population = None;
        assert_eq!(refusal(&no_population), Refusal { code: "closed", message: closed::ClosedError::PopulationMissing.message() });
        // A closed network the product form does not cover is refused in `closed`'s words.
        let mut general = cycle([1.0, 1.0, 1.0], [1, 1, 1], 0.0, 3);
        general.nodes[1].distribution = Distribution::Constant;
        general.nodes[1].parameters = "value=1".into();
        assert_eq!(refusal(&general).code, "closed");
        // A network the analysis refuses is refused in the analysis' words.
        let mut no_sink = mm(0.7, 1.0, 1);
        no_sink.nodes.retain(|n| n.kind != NodeKind::Sink);
        no_sink.links.retain(|l| l.to != "Out");
        assert_eq!(refusal(&no_sink), Refusal { code: "network", message: "The network has no sink node.".into() });
        let bad = single((Distribution::Poisson, "lambda=1"), (Distribution::Erlang, "k=2.5,rate=4"), 1);
        assert_eq!(refusal(&bad), Refusal { code: "distribution", message: "S1: Stages (k) must be a whole number.".into() });
        // A closed network with finite buffers that hold everyone never blocks: it is animated.
        let mut roomy = cycle([1.0, 1.0, 1.0], [1, 1, 1], 0.0, 3);
        roomy.infinite_buffers = false;
        for n in roomy.nodes.iter_mut().filter(|n| n.kind == NodeKind::Buffer) {
            n.buffer_size = 5;
        }
        assert!(Simulator::new(&roomy, 1).is_ok());
    }

    /// An overloaded station is animated, flagged, and its queue grows at λ − μ.
    #[test]
    fn an_unstable_network_runs_and_is_flagged() {
        let mut sim = Simulator::new(&mm(1.5, 1.0, 1), 61).unwrap();
        assert_eq!(sim.layout().unstable, vec!["S1".to_string()]);
        assert_eq!(sim.layout().stations[0].exact_number, None);
        sim.skip(usize::MAX, 20_000.0);
        let s = sim.snapshot();
        let n = s.queues[0].len() as f64 + 1.0;
        assert!((n / 20_000.0 - 0.5).abs() < 0.02, "the queue grows at λ − μ = 0.5 per time unit: {n} after 20 000");
    }

    #[test]
    fn the_pace_is_the_networks_completion_rate() {
        // Jackson example: α = (1/0.7, 1).
        let sim = Simulator::new(&example("OpenJackson.d2.feedback.p30.inf.bnet"), 1).unwrap();
        assert!((sim.layout().event_rate - (1.0 / 0.7 + 1.0)).abs() < 1e-9);
        let net = cycle([1.0, 0.8, 1.5], [1, 2, 1], 0.25, 6);
        let exact = closed::means(&closed::from_network(&net).unwrap()).unwrap();
        let sim = Simulator::new(&net, 1).unwrap();
        assert!((sim.layout().event_rate - exact.station_throughput.iter().sum::<f64>()).abs() < 1e-12);
    }

    /// Every bundled example (subfolders too), sorted, with how the simulator takes it:
    /// "ok" or the refusal's code.
    fn bundled_acceptance() -> Vec<(String, String)> {
        fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
            entries.sort();
            for path in entries {
                if path.is_dir() {
                    walk(&path, root, out);
                } else if path.extension().is_some_and(|e| e == "bnet") {
                    let name = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    let how = match bnet::read(&std::fs::read_to_string(&path).unwrap()) {
                        Ok(net) => match Simulator::new(&net, 1) {
                            Ok(_) => "ok".to_string(),
                            Err(r) => r.code.to_string(),
                        },
                        Err(_) => "unreadable".to_string(),
                    };
                    out.push((name, how));
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples");
        let mut out = Vec::new();
        walk(&root, &root, &mut out);
        out
    }

    /// S1's row is [Out 0.7, S2 0.6] or the same two links the other way round: the model
    /// (`traffic`) sends 0.6 to S2 and lets the remaining 0.4 leave, whatever the sink link says.
    fn over_one_with_a_sink(sink_first: bool) -> Network {
        let mut links = vec![link("A1", "B1", 1.0, 0), link("B1", "S1", 1.0, 0), link("B2", "S2", 1.0, 0), link("S2", "Out", 1.0, 0)];
        let row = [link("S1", "Out", 0.7, 0), link("S1", "B2", 0.6, 0)];
        if sink_first {
            links.extend(row);
        } else {
            links.extend(row.into_iter().rev());
        }
        network(
            vec![
                node(NodeKind::Source, "A1", Distribution::Poisson, "lambda=1", 1),
                node(NodeKind::Buffer, "B1", Distribution::Exponential, "", 1),
                node(NodeKind::Station, "S1", Distribution::Exponential, "rate=2", 1),
                node(NodeKind::Buffer, "B2", Distribution::Exponential, "", 1),
                node(NodeKind::Station, "S2", Distribution::Exponential, "rate=2", 1),
                node(NodeKind::Sink, "Out", Distribution::Exponential, "", 1),
            ],
            links,
        )
    }

    /// Review finding FIX-201: the simulator read a row over 1 in link order, so with the sink
    /// link first S2 got 0.3 of S1's output where the traffic equations give it 0.6. Checked
    /// through the replicated estimator at 99 % against `traffic`/`jackson` (ρ₂ = 0.6·1/2 = 0.30).
    #[test]
    fn a_row_over_one_with_a_sink_link_means_what_the_traffic_equations_say_in_either_link_order() {
        use crate::simstat::{estimate, Options};
        for sink_first in [true, false] {
            let net = over_one_with_a_sink(sink_first);
            let data = crate::traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
            assert!((data.rho(1) - 0.30).abs() < 1e-12);
            let exact = jackson::solve(&jackson::from_network(&net).unwrap()).unwrap();
            assert!((exact.rho[1] - 0.30).abs() < 1e-12);
            let o = estimate(&net, &Options { replications: 10, completions: 40_000, level: 0.99, threads: 2, ..Options::default() }, &mut |_| true).unwrap();
            let (u, x, l) = (o.stations[1].utilisation, o.stations[1].throughput, o.stations[1].number);
            assert!(u.covers(0.30) && u.half_width() < 0.02, "sink first {sink_first}: ρ₂ = {} [{}, {}]", u.mean, u.low, u.high);
            assert!(x.covers(0.60) && x.half_width() < 0.03, "sink first {sink_first}: X₂ = {}", x.mean);
            assert!(l.covers(exact.number[1]), "sink first {sink_first}: L₂ = {} against {}", l.mean, exact.number[1]);
        }
    }

    /// The leavers are shared among the sinks in proportion to the sink links' numbers, and a
    /// row under 1 with no sink link still lets the remainder leave (by no sink).
    #[test]
    fn leavers_are_shared_among_the_sinks_by_the_sink_links_numbers() {
        let mut net = over_one_with_a_sink(true);
        net.nodes.push(node(NodeKind::Sink, "Out2", Distribution::Exponential, "", 1));
        net.links.push(link("S1", "Out2", 0.35, 0));
        let mut sim = Simulator::new(&net, 3).unwrap();
        let events = sim.advance(200_000, f64::INFINITY);
        let from_s1: Vec<&Event> = events.iter().filter(|e| e.station == 0 && matches!(e.kind, Kind::Leave | Kind::Route)).collect();
        let n = from_s1.len() as f64;
        let share = |f: &dyn Fn(&Event) -> bool| from_s1.iter().filter(|e| f(e)).count() as f64 / n;
        let out = sim.layout().sinks.iter().position(|s| s == "Out").unwrap() as i32;
        let out2 = sim.layout().sinks.iter().position(|s| s == "Out2").unwrap() as i32;
        // 0.6 stays; 0.4 leaves, two thirds of it by Out (0.7 : 0.35). Binomial standard
        // deviation at n ≈ 60,000 is 0.002; the band is 5 of them.
        for (what, got, want) in [("to S2", share(&|e| e.kind == Kind::Route), 0.6), ("by Out", share(&|e| e.kind == Kind::Leave && e.other == out), 0.4 * 2.0 / 3.0), ("by Out2", share(&|e| e.kind == Kind::Leave && e.other == out2), 0.4 / 3.0)] {
            assert!((got - want).abs() < 0.01, "{what}: {got} against {want} of {n}");
        }
    }

    #[test]
    fn rows_with_no_single_meaning_are_refused_with_a_sentence() {
        // The links to stations alone exceed 1: the traffic equations refuse it, and so do we.
        let mut over = over_one_with_a_sink(true);
        over.links.push(link("S1", "B1", 0.6, 0));
        let r = Simulator::new(&over, 1).err().unwrap();
        assert_eq!(r.code, "network");
        assert!(r.message.contains("S1") && r.message.contains("1.2"), "{}", r.message);
        // A source whose links sum above 1 (traffic would create 1.3 times its rate).
        let mut source = over_one_with_a_sink(true);
        source.links[0].probability = 0.7;
        source.links.push(link("A1", "B2", 0.6, 0));
        let r = Simulator::new(&source, 1).err().unwrap();
        assert_eq!((r.code, r.message.as_str()), ("sourceOverOne", "The links out of A1 carry probabilities that sum to 1.3, more than 1: a source cannot send more customers than it produces. Lower them so that they sum to 1 at most."));
        assert_eq!(crate::simstat::plan(&source).unwrap_err().code, "sourceOverOne");
        // Under 1 is thinning, as the traffic equations read it.
        source.links[0].probability = 0.3;
        assert!(Simulator::new(&source, 1).is_ok());
    }

    /// What the simulator accepted and refused among the bundled examples before the routing
    /// rows were given the traffic equations' meaning (FIX-201): unchanged by it.
    #[test]
    fn the_bundled_examples_are_accepted_and_refused_as_before() {
        let finite = ["2d2cfin.bnet", "2dtandem.bnet", "3d2cfin.bnet", "3d3cfin.bnet", "4d3c.fin.bnet", "DaiHarrison91.d2.c1.fin.bnet", "MM1K.d1.c1.fin.bnet", "ShenChenDaiDai02.d2.c1.1.fin.bnet", "ShenChenDaiDai02.d3.c1.1.fin.bnet", "ShenChenDaiDai02.d3.c1.2.fin.bnet", "ShenChenDaiDai02.d3.c1.3.fin.bnet", "ShenChenDaiDai02.d3.c1.4.fin.bnet", "ShenChenDaiDai02.d3.c1.4.fin.bnet.bnet", "Tandem2.MM1.K5.fin.bnet", "random1.fin.test.bnet"];
        let all = bundled_acceptance();
        assert_eq!(all.len(), 54);
        for (name, how) in all {
            let want = if finite.contains(&name.as_str()) { "finiteBuffers" } else { "ok" };
            assert_eq!(how, want, "{name}");
        }
    }
}
