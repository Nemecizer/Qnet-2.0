//! An open Jackson network in closed form, in process (new in 2.1, ROADMAP D1).
//!
//! `JacksonModel` is the station-level description of a network that `tractability::assess` finds
//! to be an exact open Jackson network (Poisson arrivals, exponential service, infinite buffers,
//! one class at each station): external arrival rates γ, the routing matrix P, per-server service
//! rates μ and the numbers of servers. `solve` gives its exact stationary means: the throughputs
//! from the traffic equations α = γ + Pᵀα (`traffic::solve_traffic_equations`, the solver every
//! other analysis uses) and, per station, the M/M/c means by Erlang's formulas.
//!
//! Nothing here changes 0.90.34's arithmetic: the model is read off `traffic::compute` and
//! `tractability::assess`, and a test holds `solve`'s means to the means `assess` reports.
//!
//! Sources. Jackson (1957), "Networks of waiting lines", Oper. Res. 5:518–521 (product form).
//! Gross, Shortle, Thompson & Harris, *Fundamentals of Queueing Theory*, 4th ed., §2.3 (M/M/c:
//! Lq = C(c, a)·ρ/(1 − ρ), L = Lq + a) and §4.2 (open Jackson networks). The Erlang B recursion
//! B(0) = 1, B(n) = a·B(n−1)/(n + a·B(n−1)) is Jagerman (1974), Bell Syst. Tech. J. 53:525–551.

use crate::model::{Distribution, Network, Node, NodeKind};
use crate::naming;
use crate::tractability::{self, Kind};
use crate::traffic::{self, SrbmData};

/// The station-level data of an open Jackson network, stations in export order.
#[derive(Clone, Debug, PartialEq)]
pub struct JacksonModel {
    /// Station node ids and names.
    pub ids: Vec<String>,
    pub names: Vec<String>,
    /// External arrival rate into each station (all sources together).
    pub gamma: Vec<f64>,
    /// p[i][j]: the probability that a job leaving station i goes to station j next.
    pub p: Vec<Vec<f64>>,
    /// Per-server service rate.
    pub mu: Vec<f64>,
    pub servers: Vec<i64>,
}

/// Why a network has no Jackson model, in a sentence for the interface.
#[derive(Clone, Debug, PartialEq)]
pub enum JacksonError {
    /// The traffic equations could not be set up or solved (the analysis' own sentence).
    Network(String),
    /// A station at utilisation ≥ 1 (or with no traffic): name and utilisation.
    Unstable(String, f64),
    /// Stable, but not an open Jackson network.
    NotJackson,
}

impl JacksonError {
    pub fn message(&self) -> String {
        match self {
            JacksonError::Network(s) => s.clone(),
            JacksonError::Unstable(name, rho) if *rho >= 1.0 => format!("{name} is overloaded (utilisation {rho:.3}), so the network has no steady state."),
            JacksonError::Unstable(name, _) => format!("{name} receives no traffic, so it has no steady state to analyse."),
            JacksonError::NotJackson => "The network is not an open Jackson network (Poisson arrivals, exponential service times, infinite buffers and one customer class at each station), so no closed formula applies.".into(),
        }
    }
}

/// The exact stationary means of a Jackson model.
#[derive(Clone, Debug, PartialEq)]
pub struct JacksonSolution {
    /// Throughput α_i.
    pub alpha: Vec<f64>,
    /// Utilisation ρ_i = α_i / (c_i μ_i).
    pub rho: Vec<f64>,
    /// Mean number in system and in queue.
    pub number: Vec<f64>,
    pub queue: Vec<f64>,
    /// Total external arrival rate Λ = Σ γ_i (the network's throughput).
    pub total_arrivals: f64,
}

impl JacksonSolution {
    /// Mean number in the whole network.
    pub fn network_number(&self) -> f64 {
        self.number.iter().sum()
    }

    /// Mean time from arrival to departure, by Little's law: W = L / Λ.
    pub fn network_sojourn(&self) -> f64 {
        self.network_number() / self.total_arrivals
    }
}

/// Erlang's loss probability B(c, a) for offered load a on c servers, by the stable recursion.
pub fn erlang_b(servers: i64, a: f64) -> f64 {
    let mut b = 1.0;
    for n in 1..=servers.max(0) {
        b = a * b / (n as f64 + a * b);
    }
    b
}

/// An M/M/c queue at offered load a = λ/μ: the probability of waiting, the mean queue length and
/// their derivatives with respect to a (the number of servers held fixed).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mmc {
    /// Erlang's delay probability C(c, a).
    pub wait_probability: f64,
    /// Mean number waiting, Lq = C·ρ/(1 − ρ) with ρ = a/c.
    pub queue: f64,
    /// Mean number in system, L = Lq + a.
    pub number: f64,
    /// dLq/da and dL/da = dLq/da + 1.
    pub d_queue: f64,
    pub d_number: f64,
}

/// The M/M/c means at offered load `a` (0 ≤ a < c), with their derivatives in a.
///
/// With B = B(c, a): dB/da = B·(c/a − 1 + B) (differentiate ln B = c·ln a − ln Σ_{k≤c} aᵏ/k!, whose
/// sum has derivative Σ_{k<c} aᵏ/k! = (1 − B)·Σ). C = B/D with D = 1 − ρ(1 − B), ρ = a/c, so
/// dC/da = (B′D − B·D′)/D², D′ = −(1 − B)/c + ρB′; and dLq/da = C′·ρ/(1 − ρ) + C/(c(1 − ρ)²).
/// For one server this is L = ρ/(1 − ρ), dL/dρ = 1/(1 − ρ)².
pub fn mmc(servers: i64, a: f64) -> Mmc {
    let c = servers.max(1) as f64;
    let rho = a / c;
    if !(a > 0.0) {
        // An empty queue: C ~ aᶜ/c!, so Lq and its slope vanish (for c = 1, Lq = ρ²/(1 − ρ)).
        return Mmc { wait_probability: 0.0, queue: 0.0, number: 0.0, d_queue: 0.0, d_number: 1.0 };
    }
    let b = erlang_b(servers.max(1), a);
    let db = b * (c / a - 1.0 + b);
    let d = 1.0 - rho * (1.0 - b);
    let dd = -(1.0 - b) / c + rho * db;
    let wait = b / d;
    let dwait = (db * d - b * dd) / (d * d);
    let queue = wait * rho / (1.0 - rho);
    let d_queue = dwait * rho / (1.0 - rho) + wait / (c * (1.0 - rho) * (1.0 - rho));
    Mmc { wait_probability: wait, queue, number: queue + a, d_queue, d_number: d_queue + 1.0 }
}

/// The throughputs of a model: α = γ + Pᵀα. None when the routing leaves them undetermined.
pub fn throughputs(model: &JacksonModel) -> Option<Vec<f64>> {
    let (alpha, singular) = traffic::solve_traffic_equations(&model.p, &model.gamma, model.mu.len());
    (singular.is_none() && alpha.iter().all(|x| x.is_finite())).then_some(alpha)
}

/// The exact means of `model`, or why it has none (an overloaded station, or no steady flow).
pub fn solve(model: &JacksonModel) -> Result<JacksonSolution, JacksonError> {
    let d = model.mu.len();
    let alpha = throughputs(model).ok_or_else(|| JacksonError::Network("The routing returns every job to a station it has left, so no arrival rates can be computed.".into()))?;
    let mut rho = vec![0.0; d];
    let mut number = vec![0.0; d];
    let mut queue = vec![0.0; d];
    for i in 0..d {
        let c = model.servers[i].max(1);
        let a = alpha[i] / model.mu[i];
        rho[i] = a / c as f64;
        if !(rho[i] < 1.0) || !(model.mu[i] > 0.0) || alpha[i] < -1e-12 {
            return Err(JacksonError::Unstable(model.names[i].clone(), rho[i]));
        }
        let m = mmc(c, a.max(0.0));
        number[i] = m.number;
        queue[i] = m.queue;
    }
    Ok(JacksonSolution { alpha, rho, number, queue, total_arrivals: model.gamma.iter().sum() })
}

/// The Jackson model of a drawn network, when `tractability::assess` finds it to be one.
pub fn from_network(net: &Network) -> Result<JacksonModel, JacksonError> {
    let data = traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).map_err(|e| JacksonError::Network(e.message()))?;
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
    for i in 0..data.d {
        let rho = data.rho(i);
        if net.infinite_buffers && (!rho.is_finite() || rho >= 1.0 || rho <= 0.0) {
            return Err(JacksonError::Unstable(stations[i].name.clone(), rho));
        }
    }
    if tractability::assess(&data, &net.nodes, net.infinite_buffers, false).kind != Kind::ExactJackson {
        return Err(JacksonError::NotJackson);
    }
    let gamma = (0..data.d).map(|i| data.class_external_arrival_rates.iter().map(|row| row[i]).sum()).collect();
    Ok(JacksonModel {
        ids: stations.iter().map(|s| s.id.clone()).collect(),
        names: stations.iter().map(|s| s.name.clone()).collect(),
        gamma,
        p: data.aggregated_p.clone(),
        mu: data.service_rates.clone(),
        servers: data.servers.clone(),
    })
}

// ── Live results (new in 2.1, ROADMAP Phase D: "live results while drawing") ─────────────────────
//
// The steady state of the network as drawn, for the canvas to show after every edit. It differs
// from `from_network` + `solve` above in two ways the canvas needs: it always answers with ρ, also
// where no closed form applies, with the reason; and it never pays for `assess`'s SRBM product
// forms (O(d⁴)) on a network that is not Jackson.
//
// Nothing is solved twice:
// - the arrival rates α, the capacities cμ and ρ = α/(cμ) are `traffic::compute`'s;
// - whether the network *is* a Jackson network, and each station's mean number in system L
//   (ρ/(1 − ρ) for one server, Erlang C otherwise), are `tractability::assess`'s;
// - the rest follows from L by identities that hold for any stable queue: the mean number in
//   service is α/μ (so the mean number waiting is Lq = L − α/μ), and Little's law gives W = L/α,
//   Wq = Lq/α and, for the network, N = Σ L_i, T = N/λ with λ the external arrival rate.
// A test holds these to `solve`'s means (Erlang B recursion, a different route) and to the recorded
// runs of the Product Form solver (golden/runs/<example>/product_form).
//
// Where no closed form applies (finite buffers, a non-exponential law, classes sharing a station,
// a station nothing reaches) only ρ is given, with the reason; where buffers are infinite and some
// ρ ≥ 1 there is no steady state and no queue length is given at all (with finite buffers there
// always is one: blocking or loss absorbs the excess, and the reason given is the finite buffers). With infinite buffers ρ is exact whatever the
// distributions (a ratio of rates); with finite buffers it is the *offered* load, before blocking
// or loss, and is labelled so.

/// How much the live results say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// A Jackson network: every quantity, exact.
    Exact,
    /// Utilisation only.
    Utilisation,
    /// Nothing: the traffic equations have no solution for the network as drawn.
    None,
}

impl Tier {
    pub fn raw(self) -> &'static str {
        match self {
            Tier::Exact => "exact",
            Tier::Utilisation => "utilisation",
            Tier::None => "none",
        }
    }
}

/// Why the live results stop at utilisation (or at nothing).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// `traffic::compute` refused the network; `detail` is its sentence.
    NoModel,
    /// Infinite buffers and some station has ρ ≥ 1: no steady state.
    Unstable,
    /// Finite buffers: blocking or loss, no product form. A finite network always has a steady
    /// state, whatever the offered load: this reason is given for ρ ≥ 1 too.
    FiniteBuffers,
    /// A station nothing reaches (ρ = 0); `tractability` does not assess such a network.
    NoTraffic,
    /// Two classes are served at one station.
    SharedStation,
    /// An inter-arrival or service law that is not exponential.
    NotExponential,
    /// Jackson's premises look met but `tractability::assess` did not certify the network.
    NotCertified,
    /// The network uses a model feature new in 2.1 (priorities, batch arrivals, a rate profile:
    /// `extended.rs`) outside the single-station cases that have an exact formula; `detail` says which.
    NewFeature,
}

impl Reason {
    pub fn raw(self) -> &'static str {
        match self {
            Reason::NoModel => "noModel",
            Reason::Unstable => "unstable",
            Reason::FiniteBuffers => "finiteBuffers",
            Reason::NoTraffic => "noTraffic",
            Reason::SharedStation => "sharedStation",
            Reason::NotExponential => "notExponential",
            Reason::NotCertified => "notCertified",
            Reason::NewFeature => "extended",
        }
    }
}

/// One station. The queue quantities are `None` unless the tier is exact.
#[derive(Clone, Debug, PartialEq)]
pub struct StationLive {
    pub id: String,
    pub name: String,
    pub servers: i64,
    /// α: jobs per time unit through the station.
    pub throughput: f64,
    /// μ: jobs per time unit one server completes (throughput-weighted over classes).
    pub service_rate: f64,
    /// ρ = α/(cμ); `None` when the station has no capacity.
    pub utilisation: Option<f64>,
    /// L: mean number in system (waiting and in service), customers.
    pub mean_in_system: Option<f64>,
    /// Lq: mean number waiting, customers.
    pub mean_waiting: Option<f64>,
    /// W: mean time in system per visit, time units.
    pub mean_sojourn: Option<f64>,
    /// Wq: mean wait before service per visit, time units.
    pub mean_wait: Option<f64>,
}

/// The whole network, for the exact tier.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NetworkLive {
    /// λ: external arrivals per time unit, which is what leaves in steady state.
    pub throughput: f64,
    /// N = Σ L_i, customers.
    pub mean_number: f64,
    /// T = N/λ: mean time from arrival to departure, time units.
    pub mean_delay: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LiveResults {
    pub tier: Tier,
    /// Why the tier is not exact.
    pub reason: Option<Reason>,
    /// The station(s) the reason is about, or `traffic`'s sentence for `NoModel`.
    pub detail: String,
    /// Stations in export order.
    pub stations: Vec<StationLive>,
    pub network: Option<NetworkLive>,
    /// True when ρ is the true long-run utilisation (infinite buffers, stable); false when it is
    /// the offered load only (finite buffers, or no steady state).
    pub utilisation_exact: bool,
    /// The station(s) with the highest ρ: several when they tie within [`TIE_TOLERANCE`].
    pub bottlenecks: Vec<String>,
}

/// Utilisations closer than this are a tie for the bottleneck: half a unit of the fourth decimal,
/// so two stations that both read "70.00 %" are never told apart. The interface's copy is
/// `BOTTLENECK_TIE` in src/results/insight.ts.
pub const TIE_TOLERANCE: f64 = 5e-5;

/// The indices of the most loaded stations: every one whose ρ is within [`TIE_TOLERANCE`] of the
/// highest, in order. Empty when no station has a positive, finite ρ.
pub fn most_loaded(rho: &[Option<f64>]) -> Vec<usize> {
    let top = rho.iter().flatten().filter(|r| r.is_finite()).fold(0.0f64, |m, r| m.max(*r));
    if !(top > 0.0) {
        return Vec::new();
    }
    (0..rho.len()).filter(|&i| rho[i].is_some_and(|r| r.is_finite() && top - r < TIE_TOLERANCE)).collect()
}

/// Jackson's premises, read off the model (the ones `tractability`'s Jackson test checks): `Ok`
/// when they all hold, else the first that fails and the station(s) concerned. A screen only:
/// `assess` has the last word, and a test holds the two together on every example.
fn could_be_jackson(data: &SrbmData, nodes: &[Node], stations: &[&Node], infinite: bool) -> Result<(), (Reason, String)> {
    let names = |pick: &dyn Fn(usize) -> bool| -> String {
        (0..data.d).filter(|&i| pick(i)).map(|i| stations[i].name.clone()).collect::<Vec<_>>().join(", ")
    };
    // ρ exactly as `assess` reads it: no capacity counts as ρ = 1.
    let rho = |i: usize| if data.capacity[i] > 1e-12 { data.alpha[i] / data.capacity[i] } else { 1.0 };
    // Finite buffers first: such a network has a steady state at any offered load (blocking or
    // loss absorbs the excess), so ρ ≥ 1 there is not "no steady state".
    if !infinite {
        return Err((Reason::FiniteBuffers, String::new()));
    }
    if (0..data.d).any(|i| rho(i) >= 1.0) {
        return Err((Reason::Unstable, names(&|i| rho(i) >= 1.0)));
    }
    if (0..data.d).any(|i| rho(i) <= 0.0) {
        return Err((Reason::NoTraffic, names(&|i| rho(i) <= 0.0)));
    }
    let visitors = |i: usize| (0..data.k).filter(|&k| data.alpha_per_class[k][i] > 1e-12).collect::<Vec<_>>();
    if (0..data.d).any(|i| visitors(i).len() != 1) {
        return Err((Reason::SharedStation, names(&|i| visitors(i).len() > 1)));
    }
    let mut odd: Vec<String> = nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Source && !matches!(n.distribution, Distribution::Poisson | Distribution::Exponential))
        .map(|n| n.name.clone())
        .collect();
    for (i, st) in stations.iter().enumerate() {
        let class = visitors(i)[0] as i64;
        let law = st.service_by_class.get(&class).map(|c| c.distribution).unwrap_or(st.distribution);
        if law != Distribution::Exponential {
            odd.push(st.name.clone());
        }
    }
    if !odd.is_empty() {
        return Err((Reason::NotExponential, odd.join(", ")));
    }
    Ok(())
}

/// The live results of a station model `data` computed from `nodes`.
pub fn live_from_model(data: &SrbmData, nodes: &[Node], infinite: bool) -> LiveResults {
    let stations = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| n.name.as_str());
    let d = data.d.min(stations.len());
    let rho: Vec<Option<f64>> = (0..d).map(|i| Some(data.rho(i)).filter(|r| r.is_finite())).collect();

    let mut reason = None;
    let mut detail = String::new();
    let mut means: Option<Vec<f64>> = None;
    if stations.len() != data.d {
        reason = Some(Reason::NotCertified);
    } else {
        match could_be_jackson(data, nodes, &stations, infinite) {
            Err((r, which)) => {
                reason = Some(r);
                detail = which;
            }
            Ok(()) => {
                let a = tractability::assess(data, nodes, infinite, false);
                if a.kind == Kind::ExactJackson && a.means.len() == d && a.means.iter().all(|m| m.is_finite() && *m >= 0.0) {
                    means = Some(a.means);
                } else {
                    reason = Some(Reason::NotCertified);
                }
            }
        }
    }

    let stable = reason != Some(Reason::Unstable);
    let out: Vec<StationLive> = (0..d)
        .map(|i| {
            let (alpha, mu) = (data.alpha[i], data.service_rates[i]);
            let l = means.as_ref().map(|m| m[i]);
            // Mean number in service is α/μ for any stable queue; a rounding error must not
            // leave a negative queue.
            let lq = l.map(|l| (l - alpha / mu).max(0.0));
            StationLive {
                id: stations[i].id.clone(),
                name: stations[i].name.clone(),
                servers: data.servers[i],
                throughput: alpha,
                service_rate: mu,
                utilisation: rho[i],
                mean_in_system: l,
                mean_waiting: lq,
                mean_sojourn: l.map(|l| l / alpha),
                mean_wait: lq.map(|q| q / alpha),
            }
        })
        .collect();

    let network = means.as_ref().and_then(|m| {
        let lambda: f64 = data.class_external_arrivals.iter().sum();
        let n: f64 = m.iter().sum();
        (lambda > 0.0).then(|| NetworkLive { throughput: lambda, mean_number: n, mean_delay: n / lambda })
    });
    let bottlenecks = most_loaded(&rho).into_iter().map(|i| out[i].id.clone()).collect();

    LiveResults {
        tier: if means.is_some() { Tier::Exact } else { Tier::Utilisation },
        reason,
        detail,
        stations: out,
        network,
        utilisation_exact: infinite && stable,
        bottlenecks,
    }
}

/// The live results of a network: one traffic solve, then closed forms.
pub fn live(net: &Network) -> LiveResults {
    // Priorities, batch arrivals or a rate profile: Jackson's closed form is not this network's.
    if crate::extended::uses_any(net) {
        return crate::extended::live(net);
    }
    match traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false) {
        Ok(data) => live_from_model(&data, &net.nodes, net.infinite_buffers),
        Err(e) => LiveResults {
            tier: Tier::None,
            reason: Some(Reason::NoModel),
            detail: e.message(),
            stations: Vec::new(),
            network: None,
            utilisation_exact: false,
            bottlenecks: Vec::new(),
        },
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::bnet;
    use crate::json;
    use crate::model::Link;
    use std::path::{Path, PathBuf};

    /// A network builder: `source(name, λ)`, `station(name, μ, servers)` (each with its own
    /// buffer in front) and `route(from, to, p, class)`; "SINK" is the way out.
    struct Net {
        nodes: Vec<Node>,
        links: Vec<Link>,
    }

    impl Net {
        fn new() -> Net {
            Net { nodes: vec![Node::new("SINK", NodeKind::Sink, "Sink1", (0.0, 0.0))], links: Vec::new() }
        }
        fn source(mut self, name: &str, lambda: f64) -> Net {
            let mut s = Node::new(name, NodeKind::Source, name, (0.0, 0.0));
            s.distribution = Distribution::Poisson;
            s.parameters = format!("lambda={lambda}");
            self.nodes.push(s);
            self
        }
        fn station(mut self, name: &str, mu: f64, servers: i64) -> Net {
            let mut s = Node::new(name, NodeKind::Station, name, (0.0, 0.0));
            s.parameters = format!("rate={mu}");
            s.servers = servers;
            let b = Node::new(format!("B{name}"), NodeKind::Buffer, format!("B{name}"), (0.0, 0.0));
            self.links.push(Link { id: format!("b{name}"), from: b.id.clone(), to: name.into(), probability: 1.0, class: 0, to_class: None });
            self.nodes.push(b);
            self.nodes.push(s);
            self
        }
        /// `to` is a station (the link goes to its buffer) or "SINK".
        fn route(mut self, from: &str, to: &str, p: f64, class: i64) -> Net {
            let target = if to == "SINK" { to.to_string() } else { format!("B{to}") };
            self.links.push(Link { id: format!("l{}", self.links.len()), from: from.into(), to: target, probability: p, class, to_class: None });
            self
        }
        fn build(self, infinite: bool) -> Network {
            Network { nodes: self.nodes, links: self.links, infinite_buffers: infinite, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
        }
    }

    fn single(lambda: f64, mu: f64, servers: i64) -> Network {
        Net::new().source("Src1", lambda).station("S1", mu, servers).route("Src1", "S1", 1.0, 0).route("S1", "SINK", 1.0, 0).build(true)
    }

    /// A third route to the M/M/c numbers, written from the textbook formula rather than from
    /// `tractability`'s recurrence or the Erlang B recursion above:
    /// P0 = [Σ_{n<c} aⁿ/n! + a^c/(c!(1 − ρ))]⁻¹, Lq = P0 · a^c ρ / (c! (1 − ρ)²), a = λ/μ, ρ = a/c
    /// (Gross, Shortle, Thompson and Harris, "Fundamentals of Queueing Theory", 4th ed., §2.3;
    /// Kleinrock, "Queueing Systems" vol. 1, §3.5).
    fn mmc_lq(lambda: f64, mu: f64, c: i64) -> f64 {
        let a = lambda / mu;
        let rho = a / c as f64;
        let fact = |n: i64| (1..=n).fold(1.0, |f, k| f * k as f64);
        let sum: f64 = (0..c).map(|n| a.powi(n as i32) / fact(n)).sum();
        let tail = a.powi(c as i32) / (fact(c) * (1.0 - rho));
        let p0 = 1.0 / (sum + tail);
        p0 * a.powi(c as i32) * rho / (fact(c) * (1.0 - rho) * (1.0 - rho))
    }

    fn close(x: f64, y: f64, tol: f64) -> bool {
        (x - y).abs() <= tol * y.abs().max(1.0)
    }

    /// Double-precision arithmetic on a handful of operations: 1e-12 relative leaves three orders
    /// of magnitude over the rounding error and is far below anything shown.
    const TIGHT: f64 = 1e-12;

    #[test]
    fn mm1_has_the_textbook_values() {
        // M/M/1 with λ = 0.8, μ = 1 (Kleinrock vol. 1 §3.2; Gross et al. §2.2):
        // ρ = 0.8, L = ρ/(1 − ρ) = 4, Lq = ρ²/(1 − ρ) = 3.2, W = 1/(μ − λ) = 5, Wq = ρ/(μ − λ) = 4.
        let r = live(&single(0.8, 1.0, 1));
        assert_eq!((r.tier, r.reason), (Tier::Exact, None));
        assert!(r.utilisation_exact);
        let s = &r.stations[0];
        assert!(close(s.utilisation.unwrap(), 0.8, TIGHT));
        assert!(close(s.mean_in_system.unwrap(), 4.0, TIGHT));
        assert!(close(s.mean_waiting.unwrap(), 3.2, TIGHT));
        assert!(close(s.mean_sojourn.unwrap(), 5.0, TIGHT));
        assert!(close(s.mean_wait.unwrap(), 4.0, TIGHT));
        let n = r.network.unwrap();
        assert!(close(n.throughput, 0.8, TIGHT) && close(n.mean_number, 4.0, TIGHT) && close(n.mean_delay, 5.0, TIGHT));
        assert_eq!(r.bottlenecks, ["S1"]);
    }

    #[test]
    fn mm2_has_the_closed_form_values() {
        // M/M/2 has a closed form of its own, L = 2ρ/(1 − ρ²) (Erlang C with c = 2; Gross et al.
        // §2.3). λ = 1.5, μ = 1: ρ = 0.75, L = 1.5/0.4375 = 24/7, Lq = L − 1.5 = 27/14,
        // W = L/λ = 16/7, Wq = 9/7.
        let r = live(&single(1.5, 1.0, 2));
        let s = &r.stations[0];
        assert_eq!(r.tier, Tier::Exact);
        assert!(close(s.utilisation.unwrap(), 0.75, TIGHT));
        assert!(close(s.mean_in_system.unwrap(), 24.0 / 7.0, TIGHT));
        assert!(close(s.mean_waiting.unwrap(), 27.0 / 14.0, TIGHT));
        assert!(close(s.mean_sojourn.unwrap(), 16.0 / 7.0, TIGHT));
        assert!(close(s.mean_wait.unwrap(), 9.0 / 7.0, TIGHT));
    }

    #[test]
    fn mm3_has_the_hand_computed_erlang_c_values() {
        // M/M/3 with λ = 2, μ = 1 (a = 2, ρ = 2/3), by hand from Erlang C (Gross et al. §2.3):
        // Σ_{n<3} aⁿ/n! = 1 + 2 + 2 = 5; a³/(3!(1 − ρ)) = (8/6)·3 = 4; P0 = 1/9;
        // C(3, 2) = 4/9; Lq = C·ρ/(1 − ρ) = 8/9; L = Lq + a = 26/9; Wq = 4/9; W = 13/9.
        let r = live(&single(2.0, 1.0, 3));
        let s = &r.stations[0];
        assert_eq!(r.tier, Tier::Exact);
        assert!(close(s.mean_waiting.unwrap(), 8.0 / 9.0, TIGHT));
        assert!(close(s.mean_in_system.unwrap(), 26.0 / 9.0, TIGHT));
        assert!(close(s.mean_wait.unwrap(), 4.0 / 9.0, TIGHT));
        assert!(close(s.mean_sojourn.unwrap(), 13.0 / 9.0, TIGHT));
    }

    #[test]
    fn three_routes_to_mmc_agree() {
        // `tractability`'s recurrence (what `live` shows), the textbook formula above and the
        // Erlang B recursion (`mmc`), over a grid that reaches heavy traffic and 40 servers. Lq
        // here is L − a, a difference of two numbers of size up to a few hundred, so the
        // tolerance is 1e-10 relative to L rather than `TIGHT`.
        for &c in &[1i64, 2, 3, 5, 8, 16, 40] {
            for &rho in &[0.05, 0.3, 0.5, 0.8, 0.95, 0.99] {
                let (mu, lambda) = (1.25, rho * c as f64 * 1.25);
                let r = live(&single(lambda, mu, c));
                let s = &r.stations[0];
                assert_eq!(r.tier, Tier::Exact, "c={c} ρ={rho}");
                let lq = mmc_lq(lambda, mu, c);
                let l = lq + lambda / mu;
                assert!((s.mean_in_system.unwrap() - l).abs() <= 1e-10 * l, "c={c} ρ={rho}: L {} against {l}", s.mean_in_system.unwrap());
                assert!((s.mean_waiting.unwrap() - lq).abs() <= 1e-10 * l, "c={c} ρ={rho}: Lq {} against {lq}", s.mean_waiting.unwrap());
                assert!((s.mean_sojourn.unwrap() - l / lambda).abs() <= 1e-10 * l / lambda);
                let b = mmc(c, lambda / mu);
                assert!((s.mean_in_system.unwrap() - b.number).abs() <= 1e-10 * l, "c={c} ρ={rho}: L {} against Erlang B's {}", s.mean_in_system.unwrap(), b.number);
                assert!((s.mean_waiting.unwrap() - b.queue).abs() <= 1e-10 * l, "c={c} ρ={rho}");
            }
        }
    }

    #[test]
    fn a_jackson_network_with_feedback_has_the_hand_solved_values() {
        // Two stations; λ = 1 into S1; S1 → S2 with 0.6, S1 → S1 with 0.2, out with 0.2;
        // S2 → S1 with 0.5, out with 0.5. Traffic equations (Jackson 1957):
        //   α1 = 1 + 0.2 α1 + 0.5 α2,  α2 = 0.6 α1  ⇒  α1 = 2, α2 = 1.2.
        // μ1 = 4 (one server): ρ1 = 0.5, L1 = 1. S2 has two servers at μ2 = 1: a = 1.2, ρ2 = 0.6,
        // L2 = 2ρ/(1 − ρ²) = 1.2/0.64 = 1.875. N = 2.875 and T = N/λ = 2.875 (Little).
        let net = Net::new()
            .source("Src1", 1.0)
            .station("S1", 4.0, 1)
            .station("S2", 1.0, 2)
            .route("Src1", "S1", 1.0, 0)
            .route("S1", "S2", 0.6, 0)
            .route("S1", "S1", 0.2, 0)
            .route("S1", "SINK", 0.2, 0)
            .route("S2", "S1", 0.5, 0)
            .route("S2", "SINK", 0.5, 0)
            .build(true);
        let r = live(&net);
        assert_eq!((r.tier, r.reason), (Tier::Exact, None));
        let (s1, s2) = (&r.stations[0], &r.stations[1]);
        assert!(close(s1.throughput, 2.0, TIGHT) && close(s2.throughput, 1.2, TIGHT));
        assert!(close(s1.utilisation.unwrap(), 0.5, TIGHT) && close(s2.utilisation.unwrap(), 0.6, TIGHT));
        assert!(close(s1.mean_in_system.unwrap(), 1.0, TIGHT) && close(s2.mean_in_system.unwrap(), 1.875, TIGHT));
        assert!(close(s1.mean_waiting.unwrap(), 0.5, TIGHT) && close(s2.mean_waiting.unwrap(), 0.675, TIGHT));
        // Per visit: W1 = 1/(μ − α) = 0.5; W2 = L2/α2 = 1.5625.
        assert!(close(s1.mean_sojourn.unwrap(), 0.5, TIGHT) && close(s2.mean_sojourn.unwrap(), 1.5625, TIGHT));
        let n = r.network.unwrap();
        assert!(close(n.throughput, 1.0, TIGHT) && close(n.mean_number, 2.875, TIGHT) && close(n.mean_delay, 2.875, TIGHT));
        // The delay is also Σ (visits to i) × W_i, visits = α_i/λ: 2 × 0.5 + 1.2 × 1.5625.
        assert!(close(n.mean_delay, 2.0 * 0.5 + 1.2 * 1.5625, TIGHT));
        assert_eq!(r.bottlenecks, ["S2"]);
    }

    #[test]
    fn an_unstable_station_gives_utilisation_and_no_queue() {
        let r = live(&single(1.2, 1.0, 1));
        assert_eq!((r.tier, r.reason), (Tier::Utilisation, Some(Reason::Unstable)));
        assert_eq!(r.detail, "S1");
        assert!(!r.utilisation_exact, "ρ ≥ 1 is the offered load, not a long-run fraction of time");
        let s = &r.stations[0];
        assert!(close(s.utilisation.unwrap(), 1.2, TIGHT));
        assert_eq!((s.mean_in_system, s.mean_waiting, s.mean_sojourn, s.mean_wait), (None, None, None, None));
        assert_eq!(r.network, None);
        // ρ = 1 exactly is unstable too.
        assert_eq!(live(&single(1.0, 1.0, 1)).reason, Some(Reason::Unstable));
    }

    /// M/M/1/K with λ = 1.2, μ = 1: offered load ρ = 1.2, and a steady state all the same
    /// (p_n ∝ ρⁿ on 0..=K sums for any ρ; Gross et al. §2.5). The reason is the finite buffers,
    /// never "no steady state"; ρ is given, labelled as the offered load only.
    #[test]
    fn a_finite_network_offered_more_than_it_can_serve_is_not_called_unstable() {
        for lambda in [1.2, 1.0, 5.0] {
            let mut net = single(lambda, 1.0, 1);
            net.infinite_buffers = false;
            let r = live(&net);
            assert_eq!((r.tier, r.reason), (Tier::Utilisation, Some(Reason::FiniteBuffers)), "λ = {lambda}");
            assert_eq!(r.detail, "");
            assert!(!r.utilisation_exact, "ρ is the offered load, before blocking");
            assert!(close(r.stations[0].utilisation.unwrap(), lambda, TIGHT));
            assert_eq!((r.stations[0].mean_in_system, r.network), (None, None));
        }
        // The same load with infinite buffers has no steady state.
        assert_eq!(live(&single(1.2, 1.0, 1)).reason, Some(Reason::Unstable));
    }

    /// Stations at one utilisation share the top: none is crowned. OpenJackson.d2.feedback.p30
    /// has ρ₁ = ρ₂ = 0.7 (α₁ = 1/0.7, μ₁ = 1/0.49; α₂ = 1, μ₂ = 1/0.7).
    #[test]
    fn equally_loaded_stations_are_all_named() {
        let (_, net) = examples().into_iter().find(|(n, _)| n == "OpenJackson.d2.feedback.p30.inf").unwrap();
        let r = live(&net);
        assert!(close(r.stations[0].utilisation.unwrap(), 0.7, 1e-9) && close(r.stations[1].utilisation.unwrap(), 0.7, 1e-9));
        assert_eq!(r.bottlenecks, [r.stations[0].id.clone(), r.stations[1].id.clone()]);
        // The tolerance: within 5e-5 is a tie, beyond it is not; nothing loaded, nothing named.
        assert_eq!(most_loaded(&[Some(0.7), Some(0.70004), Some(0.5), None]), [0, 1]);
        assert_eq!(most_loaded(&[Some(0.7), Some(0.70006)]), [1]);
        assert_eq!(most_loaded(&[Some(0.0), None]), Vec::<usize>::new());
        assert_eq!(most_loaded(&[Some(1.3), Some(0.9)]), [0]);
    }

    #[test]
    fn what_has_no_closed_form_says_why() {
        // Finite buffers.
        let mut fin = single(0.8, 1.0, 1);
        fin.infinite_buffers = false;
        let r = live(&fin);
        assert_eq!((r.tier, r.reason, r.utilisation_exact), (Tier::Utilisation, Some(Reason::FiniteBuffers), false));
        assert!(close(r.stations[0].utilisation.unwrap(), 0.8, TIGHT));
        assert_eq!(r.stations[0].mean_in_system, None);

        // A non-exponential service law: ρ is still exact (infinite buffers), the queue is not known.
        let mut det = single(0.8, 1.0, 1);
        let st = det.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap();
        st.distribution = Distribution::Constant;
        st.parameters = "value=1.0".into();
        let r = live(&det);
        assert_eq!((r.tier, r.reason, r.utilisation_exact), (Tier::Utilisation, Some(Reason::NotExponential), true));
        assert_eq!(r.detail, "S1");

        // Two classes at one station.
        let shared = Net::new()
            .source("Src1", 0.3)
            .source("Src2", 0.3)
            .station("S1", 1.0, 1)
            .route("Src1", "S1", 1.0, 0)
            .route("Src2", "S1", 1.0, 1)
            .route("S1", "SINK", 1.0, 0)
            .route("S1", "SINK", 1.0, 1)
            .build(true);
        let r = live(&shared);
        assert_eq!((r.tier, r.reason), (Tier::Utilisation, Some(Reason::SharedStation)));
        assert!(close(r.stations[0].utilisation.unwrap(), 0.6, TIGHT));

        // A station nothing reaches.
        let idle = Net::new().source("Src1", 0.5).station("S1", 1.0, 1).station("S2", 1.0, 1).route("Src1", "S1", 1.0, 0).route("S1", "SINK", 1.0, 0).route("S2", "SINK", 1.0, 0).build(true);
        let r = live(&idle);
        assert_eq!((r.tier, r.reason, r.detail.as_str()), (Tier::Utilisation, Some(Reason::NoTraffic), "S2"));

        // No model at all: `traffic`'s own sentence.
        let none = Network { nodes: Vec::new(), links: Vec::new(), infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None };
        let r = live(&none);
        assert_eq!((r.tier, r.reason, r.detail.as_str()), (Tier::None, Some(Reason::NoModel), "The network has no stations."));
    }

    #[test]
    fn disjoint_classes_are_one_jackson_network() {
        // Two classes that share no station: `tractability` certifies it as one Jackson network.
        let net = Net::new()
            .source("Src1", 0.5)
            .source("Src2", 0.9)
            .station("S1", 1.0, 1)
            .station("S2", 1.0, 2)
            .route("Src1", "S1", 1.0, 0)
            .route("S1", "SINK", 1.0, 0)
            .route("Src2", "S2", 1.0, 1)
            .route("S2", "SINK", 1.0, 1)
            .build(true);
        let r = live(&net);
        assert_eq!(r.tier, Tier::Exact);
        assert!(close(r.stations[0].mean_in_system.unwrap(), 1.0, TIGHT));
        // M/M/2 at ρ = 0.45: 2ρ/(1 − ρ²).
        assert!(close(r.stations[1].mean_in_system.unwrap(), 0.9 / (1.0 - 0.2025), TIGHT));
        assert!(close(r.network.unwrap().throughput, 1.4, TIGHT));
    }

    // ── The shipped examples ────────────────────────────────────────────────────────────────

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn examples() -> Vec<(String, Network)> {
        let mut out: Vec<(String, Network)> = std::fs::read_dir(root().join("examples"))
            .unwrap()
            .filter_map(|e| {
                let p = e.unwrap().path();
                let name = p.file_name()?.to_str()?.strip_suffix(".bnet")?.to_string();
                Some((name, bnet::read(&std::fs::read_to_string(&p).unwrap()).ok()?))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    #[test]
    fn the_screen_and_tractability_agree_on_every_example() {
        let all = examples();
        assert!(all.len() >= 50, "{} examples", all.len());
        let mut exact = 0;
        for (name, net) in &all {
            let Ok(data) = traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false) else { continue };
            let certified = tractability::assess(&data, &net.nodes, net.infinite_buffers, true).kind == Kind::ExactJackson;
            let r = live_from_model(&data, &net.nodes, net.infinite_buffers);
            assert_eq!(r.tier == Tier::Exact, certified, "{name}: {:?}", r.reason);
            assert_ne!(r.reason, Some(Reason::NotCertified), "{name}: the screen passed a network tractability refused");
            exact += certified as usize;
        }
        assert!(exact >= 10, "{exact} Jackson examples");
    }

    #[test]
    fn live_and_the_jackson_model_agree_on_every_jackson_example() {
        // Two routes inside core: `live` (tractability's means, Little's law) against
        // `from_network` + `solve` (its own traffic solve on the aggregated routing, Erlang B).
        // 1e-9 relative: the second traffic solve is a different elimination of the same system.
        let mut n = 0;
        for (name, net) in examples() {
            let r = live(&net);
            let model = from_network(&net);
            assert_eq!(r.tier == Tier::Exact, model.is_ok(), "{name}");
            let Ok(model) = model else { continue };
            let sol = solve(&model).unwrap();
            for (i, s) in r.stations.iter().enumerate() {
                assert_eq!(s.id, model.ids[i], "{name}");
                assert!(close(s.throughput, sol.alpha[i], 1e-9), "{name} {}", s.name);
                assert!(close(s.utilisation.unwrap(), sol.rho[i], 1e-9), "{name} {}", s.name);
                assert!(close(s.mean_in_system.unwrap(), sol.number[i], 1e-9), "{name} {}: {} against {}", s.name, s.mean_in_system.unwrap(), sol.number[i]);
                assert!((s.mean_waiting.unwrap() - sol.queue[i]).abs() <= 1e-9 * sol.number[i].max(1.0), "{name} {}", s.name);
            }
            let net_live = r.network.unwrap();
            assert!(close(net_live.mean_number, sol.network_number(), 1e-9) && close(net_live.mean_delay, sol.network_sojourn(), 1e-9), "{name}");
            n += 1;
        }
        assert!(n >= 10, "{n}");
    }

    /// A printed number is right to its last digit: one unit in the last place it shows (half for
    /// the rounding, half for a value that sits on the boundary).
    fn printed_tolerance(text: &str) -> f64 {
        let decimals = text.split_once('.').map(|(_, frac)| frac.len()).unwrap_or(0) as i32;
        1.0000001 * 10f64.powi(-decimals)
    }

    /// Every example `tractability` calls an exact Jackson network, against the run of the Exact
    /// Open Product Form solver recorded in golden/runs/<example>/product_form/record.json
    /// (solvers/product_form, a separate program): L, throughput, utilisation and stability
    /// margin at every station, to the precision the record prints.
    #[test]
    fn every_jackson_example_agrees_with_its_recorded_product_form_run() {
        let mut checked = Vec::new();
        let mut values = 0;
        for (name, net) in examples() {
            let r = live(&net);
            if r.tier != Tier::Exact {
                continue;
            }
            let path = root().join("golden/runs").join(&name).join("product_form/record.json");
            let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{name}: a Jackson example with no recorded product-form run"));
            let record = json::parse(&text).unwrap();
            let record = record.as_object().unwrap();
            assert_eq!(record["status"].as_str(), Some("completed"), "{name}");
            for m in record["measurements"].as_array().unwrap() {
                let m = m.as_object().unwrap();
                let (metric, id) = (m["metric"].as_str().unwrap(), m["stationID"].as_str().unwrap());
                let s = r.stations.iter().find(|s| s.id.eq_ignore_ascii_case(id)).unwrap_or_else(|| panic!("{name}: station {id}"));
                let ours = match metric {
                    "Mean number in system" => s.mean_in_system.unwrap(),
                    "Throughput" => s.throughput,
                    "Server utilization" => s.utilisation.unwrap(),
                    "Stability margin" => 1.0 - s.utilisation.unwrap(),
                    other => panic!("{name}: unexpected metric {other}"),
                };
                let recorded = m["estimate"].as_f64().unwrap();
                let shown = json::format_number(recorded);
                assert!((ours - recorded).abs() <= printed_tolerance(&shown), "{name} {} {metric}: live {ours} against recorded {shown}", s.name);
                values += 1;
            }
            checked.push(name);
        }
        assert!(checked.len() >= 10, "{checked:?}");
        assert!(values >= 100, "{values} values compared");
        println!("product-form agreement: {} examples, {values} values: {checked:?}", checked.len());
    }

    /// Not a check of correctness: what one live computation costs on a large network, printed
    /// for the record (`cargo test -p qnet-core --release live_tests::a_250 -- --nocapture`).
    #[test]
    fn a_250_station_network_is_solved_quickly() {
        // 250 stations (501 nodes with their buffers and the source) in a line, with feedback.
        let mut net = Net::new().source("Src1", 0.5);
        for i in 1..=250 {
            net = net.station(&format!("S{i}"), 1.0 + (i % 7) as f64 * 0.1, 1 + (i % 3) as i64);
        }
        net = net.route("Src1", "S1", 1.0, 0);
        for i in 1..250 {
            net = net.route(&format!("S{i}"), &format!("S{}", i + 1), 0.999, 0).route(&format!("S{i}"), "S1", 0.0005, 0).route(&format!("S{i}"), "SINK", 0.0005, 0);
        }
        let net = net.route("S250", "SINK", 1.0, 0).build(true);
        let t0 = std::time::Instant::now();
        let r = live(&net);
        let took = t0.elapsed();
        assert_eq!(r.tier, Tier::Exact);
        assert_eq!(r.stations.len(), 250);
        println!("live results, 250 stations / 502 nodes: {took:?}");
        // Generous: an unoptimised build on a busy machine. The measured figure is in the ledger.
        assert!(took.as_secs_f64() < 20.0, "{took:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1.0)
    }

    /// Erlang B and C at textbook values: B(1, a) = a/(1 + a); B(2, 1) = 1/5; C(2, 1) = 1/3
    /// (Gross et al., §2.3: C(2, a) = a²/(2 + a) for two servers).
    #[test]
    fn erlang_formulas_match_textbook_values() {
        assert!(close(erlang_b(1, 0.5), 0.5 / 1.5, 1e-15));
        assert!(close(erlang_b(2, 1.0), 0.2, 1e-15));
        assert!(close(mmc(2, 1.0).wait_probability, 1.0 / 3.0, 1e-15));
        for a in [0.2, 0.9, 1.4, 1.9] {
            assert!(close(mmc(2, a).wait_probability, a * a / (2.0 + a), 1e-14), "C(2, {a})");
        }
    }

    /// M/M/1: L = ρ/(1 − ρ), dL/dρ = 1/(1 − ρ)². M/M/2: L = 2ρ/(1 − ρ²) (Kleinrock, *Queueing
    /// Systems* I, §3.5), so dL/da = (1 + ρ²)/(1 − ρ²)² with a = 2ρ. Rounding only: 1e-12.
    #[test]
    fn one_and_two_servers_match_their_closed_forms() {
        for rho in [0.05, 0.3, 0.7, 0.95, 0.999] {
            let m = mmc(1, rho);
            assert!(close(m.number, rho / (1.0 - rho), 1e-12));
            assert!(close(m.d_number, 1.0 / ((1.0 - rho) * (1.0 - rho)), 1e-12));
            let m = mmc(2, 2.0 * rho);
            assert!(close(m.number, 2.0 * rho / (1.0 - rho * rho), 1e-12));
            assert!(close(m.d_number, (1.0 + rho * rho) / ((1.0 - rho * rho) * (1.0 - rho * rho)), 1e-11), "{rho}");
        }
    }

    /// The Erlang C derivative against a five-point (fourth-order) central difference of the mean
    /// itself. With step h = 10⁻³·min(a, c − a) the truncation error is of order h⁴ and rounding
    /// of order 10⁻¹⁶/h; the two routes agree to 1e-8 relative, plus 1e-12 absolute for the
    /// lightly loaded many-server cases whose queue is of order 10⁻⁶ (seen: 1e-10 or better).
    #[test]
    fn the_erlang_c_derivative_matches_a_high_order_difference() {
        for c in [1i64, 2, 3, 5, 8, 20, 60] {
            for frac in [0.1, 0.5, 0.8, 0.95] {
                let a = frac * c as f64;
                let h = 1e-3 * a.min(c as f64 - a);
                let f = |x: f64| mmc(c, x).queue;
                let fd = (-f(a + 2.0 * h) + 8.0 * f(a + h) - 8.0 * f(a - h) + f(a - 2.0 * h)) / (12.0 * h);
                let an = mmc(c, a).d_queue;
                assert!((an - fd).abs() <= 1e-8 * an.abs() + 1e-12, "c = {c}, a = {a}: analytic {an}, difference {fd}");
            }
        }
    }
}
