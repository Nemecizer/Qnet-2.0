//! Closed queueing networks in closed form, in process (new in 2.1, ROADMAP D3).
//!
//! A closed network has no source and no sink: a fixed population of N customers circulates among
//! the stations for ever. With exponential service, state-independent routing and room for every
//! customer at every station it is a Gordon–Newell network, whose stationary law is the product
//! form
//!
//!   π(n₁, …, n_M) = (1/G(N)) · Π_i f_i(n_i),   n₁ + … + n_M = N,
//!   f_i(n) = y_iⁿ / Π_{k=1..n} min(k, c_i)   (c_i servers),   f_i(n) = y_iⁿ / n!   (a delay station),
//!
//! where y_i = v_i/μ_i is the relative load and v the visit ratios: the solution of v = vP with
//! v = 1 at the **reference station, the first station in export order** (`naming::in_export_order`,
//! "S1"). Every throughput reported is therefore in visits per time unit: X is the rate at which
//! customers pass the reference station, and X_i = v_i·X.
//!
//! Two independent routes to the same numbers:
//!
//! - [`convolution`]: Buzen's algorithm. G is the convolution of the stations' factors; the
//!   throughput is X = G(N−1)/G(N), and each station's marginal law is
//!   p_i(n) = f_i(n)·G₍₋ᵢ₎(N−n)/G(N), with G₍₋ᵢ₎ the convolution of all the other stations.
//!   Handles any number of servers and delay stations, and gives the whole marginal distribution.
//! - [`mva`]: exact Mean Value Analysis, a recursion on the population through the arrival
//!   theorem: a customer arriving at a station sees the network in equilibrium with one customer
//!   fewer, so R_i(n) = (1 + L_i(n−1))/μ_i at a single server and R_i = 1/μ_i at a delay station;
//!   then X(n) = n/Σ v_i R_i(n) and L_i(n) = X(n) v_i R_i(n). It never forms G or a distribution,
//!   and is used for load-independent stations only (one server, or delay): the multi-server
//!   recursion needs the marginal probabilities and loses accuracy near saturation, which is
//!   exactly where convolution is safe.
//!
//! Numerics. The loads are scaled by α so the busiest queueing station has (αy)/c = 1, each factor
//! is formed in logarithms and divided by its largest entry, and every convolution is divided by
//! its largest entry with the logarithm of the divisor kept. Whatever underflows is then a
//! probability below 1e-290. The normalising constant is reported as ln G(N).
//!
//! Sources. Gordon & Newell (1967), "Closed queuing systems with exponential servers", Oper. Res.
//! 15:254–265 (the product form). Buzen (1973), "Computational algorithms for closed queueing
//! networks with exponential servers", Comm. ACM 16:527–531 (convolution, X = G(N−1)/G(N), the
//! marginals). Reiser & Lavenberg (1980), "Mean-value analysis of closed multichain queuing
//! networks", J. ACM 27:313–322 (MVA and the arrival theorem). Lazowska, Zahorjan, Graham &
//! Sevcik (1984), *Quantitative System Performance*, ch. 6 (Algorithm 6.2, exact MVA).
//!
//! Nothing here touches 0.90.34's arithmetic: the open-network analysis (`traffic`, `jackson`,
//! `tractability`) refuses a network without a source, and this module is asked instead.

use std::collections::HashMap;

use crate::model::{Distribution, Network, NodeKind};
use crate::naming;
use crate::traffic;

/// The largest population solved: the convolution is O(N²) per multi-server station.
pub const MAX_POPULATION: i64 = 10_000;

/// Row sums of the routing matrix may differ from 1 by this much (the tolerance
/// `traffic::compute` uses for a row over 1).
pub const ROW_TOLERANCE: f64 = 1e-9;

/// The station-level data of a closed network, stations in export order.
#[derive(Clone, Debug, PartialEq)]
pub struct ClosedModel {
    pub ids: Vec<String>,
    pub names: Vec<String>,
    /// p[i][j]: the probability that a customer leaving station i goes to station j next. Every
    /// row sums to 1.
    pub p: Vec<Vec<f64>>,
    /// Per-server service rate.
    pub mu: Vec<f64>,
    /// Number of servers (ignored for a delay station).
    pub servers: Vec<i64>,
    /// A delay (infinite-server) station: every customer is served at once.
    pub delay: Vec<bool>,
    /// N: the number of customers circulating.
    pub population: usize,
}

/// Why a network has no closed product-form solution.
#[derive(Clone, Debug, PartialEq)]
pub enum ClosedError {
    /// It has a source or a sink: it is an open network.
    NotClosed,
    NoStations,
    /// No population is set.
    PopulationMissing,
    /// The population is below 1 or above [`MAX_POPULATION`].
    PopulationOutOfRange(i64),
    StationMissingBuffer(String),
    StationMultipleBuffers(String),
    /// A link names a class other than Class 1, or changes class.
    MultiClass,
    /// Stations whose service time is not exponential.
    NotExponential(Vec<String>),
    /// A station with no positive, finite service rate.
    BadServiceRate(String),
    NoServers(String),
    /// With finite buffers: a station that cannot hold the whole population (blocking).
    BufferTooSmall(String, i64),
    /// A routing row over 1: station, sum.
    RoutingExceedsOne(String, f64),
    /// A routing row under 1: customers would leave, and nothing brings them back.
    RoutingLeaks(String, f64),
    /// Stations that customers leave and never return to (transient in the routing chain).
    Unreachable(Vec<String>),
    /// The routing splits into groups of stations that never exchange customers: one station of
    /// each group.
    Reducible(Vec<String>),
}

impl ClosedError {
    /// A sentence for the interface.
    pub fn message(&self) -> String {
        let list = |v: &[String]| v.join(", ");
        match self {
            ClosedError::NotClosed => "The network has a source or a sink, so it is an open network, not a closed one.".into(),
            ClosedError::NoStations => "The network has no stations.".into(),
            ClosedError::PopulationMissing => "The network has no source and no sink, but no number of customers is set. Set the population to make it a closed network.".into(),
            ClosedError::PopulationOutOfRange(n) if *n < 1 => format!("A closed network needs at least 1 customer (the population is {n})."),
            ClosedError::PopulationOutOfRange(n) => format!("The population is {n}; Qnet solves closed networks of up to {MAX_POPULATION} customers."),
            ClosedError::StationMissingBuffer(n) => format!("Station {n} has no buffer feeding into it."),
            ClosedError::StationMultipleBuffers(n) => format!("Station {n} has more than one buffer feeding into it."),
            ClosedError::MultiClass => "The closed-network solution is for one customer class: every link must carry Class 1 and none may change class.".into(),
            ClosedError::NotExponential(v) => format!("The closed product form needs exponential service times; {} {} another distribution.", list(v), if v.len() == 1 { "has" } else { "have" }),
            ClosedError::BadServiceRate(n) => format!("{n}'s service rate is missing or not positive."),
            ClosedError::NoServers(n) => format!("{n} has no servers."),
            ClosedError::BufferTooSmall(n, cap) => format!("{n} can hold only {cap} customers (buffer and servers), fewer than the population, so customers would be blocked and the product form does not hold. Use infinite buffers, or make the buffer at least as large as the population."),
            ClosedError::RoutingExceedsOne(n, s) => format!("Routing probabilities from {n} sum to {s:.4}, which exceeds 1."),
            ClosedError::RoutingLeaks(n, s) => format!("Routing probabilities from {n} sum to {s:.4}. In a closed network every customer that leaves a station must go to another, so they must sum to 1."),
            ClosedError::Unreachable(v) => format!("Customers leave {} and never come back, so in the long run {} empty. Remove {}, or route customers back.", list(v), if v.len() == 1 { "it stands" } else { "they stand" }, if v.len() == 1 { "it" } else { "them" }),
            ClosedError::Reducible(v) => format!("The routing splits the stations into separate groups that never exchange customers (around {}), so the long-run behaviour depends on where the customers start. Connect the groups.", list(v)),
        }
    }
}

/// The exact stationary quantities of a closed model.
#[derive(Clone, Debug, PartialEq)]
pub struct ClosedSolution {
    /// Visit ratios v (v = 1 at the reference station, index 0).
    pub visits: Vec<f64>,
    /// X: visits per time unit at the reference station.
    pub throughput: f64,
    /// X_i = v_i X.
    pub station_throughput: Vec<f64>,
    /// ρ_i = X_i/(c_i μ_i): the fraction of time a server is busy. `None` for a delay station.
    pub utilisation: Vec<Option<f64>>,
    /// L_i: mean number at the station (waiting and in service).
    pub number: Vec<f64>,
    /// Lq_i = L_i − X_i/μ_i: mean number waiting (0 at a delay station).
    pub queue: Vec<f64>,
    /// W_i = L_i/X_i: mean time at the station per visit.
    pub residence: Vec<f64>,
    /// ln G(N) for the visit ratios above. `None` from MVA when not accumulated.
    pub ln_g: f64,
    /// p_i(n), n = 0..=N: the marginal law of the number at station i. Empty from MVA.
    pub marginals: Vec<Vec<f64>>,
}

impl ClosedSolution {
    /// Mean time for one cycle, between two passes of a customer through the reference station:
    /// N/X (Little's law over the whole network).
    pub fn cycle_time(&self, population: usize) -> f64 {
        population as f64 / self.throughput
    }

    /// The limit of X_i's bound: the throughput at the reference station cannot exceed
    /// min_i c_i μ_i / v_i.
    pub fn bottleneck(&self) -> Vec<usize> {
        crate::jackson::most_loaded(&self.utilisation)
    }
}

// ── Visit ratios ────────────────────────────────────────────────────────────────────────────────

/// The strongly connected components of the graph i → j when p[i][j] > 0, each sorted, in order
/// of their smallest member (Tarjan's algorithm, iterative).
fn components(p: &[Vec<f64>]) -> Vec<Vec<usize>> {
    let n = p.len();
    let mut index = vec![usize::MAX; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut next = 0usize;
    let mut out: Vec<Vec<usize>> = Vec::new();
    for root in 0..n {
        if index[root] != usize::MAX {
            continue;
        }
        // (node, next successor to look at)
        let mut work: Vec<(usize, usize)> = vec![(root, 0)];
        while let Some(&(v, j)) = work.last() {
            if j == 0 {
                index[v] = next;
                low[v] = next;
                next += 1;
                stack.push(v);
                on_stack[v] = true;
            }
            let mut pushed = false;
            let mut k = j;
            while k < n {
                if p[v][k] > 0.0 {
                    if index[k] == usize::MAX {
                        work.last_mut().unwrap().1 = k + 1;
                        work.push((k, 0));
                        pushed = true;
                        break;
                    } else if on_stack[k] {
                        low[v] = low[v].min(index[k]);
                    }
                }
                k += 1;
            }
            if pushed {
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                low[parent] = low[parent].min(low[v]);
            }
            if low[v] == index[v] {
                let mut comp = Vec::new();
                loop {
                    let w = stack.pop().unwrap();
                    on_stack[w] = false;
                    comp.push(w);
                    if w == v {
                        break;
                    }
                }
                comp.sort_unstable();
                out.push(comp);
            }
        }
    }
    out.sort_by_key(|c| c[0]);
    out
}

/// What is wrong with a routing matrix as the chain of a closed network: nothing (irreducible),
/// transient stations, or several closed groups. Station indices.
#[derive(Clone, Debug, PartialEq)]
pub enum Structure {
    Irreducible,
    /// Stations outside the one closed group.
    Transient(Vec<usize>),
    /// One representative (the smallest index) of each closed group, when there are several.
    SeveralClosed(Vec<usize>),
}

/// Classifies the routing chain.
pub fn structure(p: &[Vec<f64>]) -> Structure {
    let comps = components(p);
    if comps.len() <= 1 {
        return Structure::Irreducible;
    }
    let mut owner = vec![0usize; p.len()];
    for (c, members) in comps.iter().enumerate() {
        for &m in members {
            owner[m] = c;
        }
    }
    // A component is closed when no positive probability leaves it.
    let closed: Vec<usize> = (0..comps.len()).filter(|&c| comps[c].iter().all(|&i| (0..p.len()).all(|j| !(p[i][j] > 0.0) || owner[j] == c))).collect();
    if closed.len() > 1 {
        return Structure::SeveralClosed(closed.iter().map(|&c| comps[c][0]).collect());
    }
    let keep = closed.first().copied();
    Structure::Transient((0..p.len()).filter(|&i| Some(owner[i]) != keep).collect())
}

/// The visit ratios of an irreducible routing matrix: the solution of v = vP with
/// v[reference] = 1, by Gaussian elimination with partial pivoting on (I − Pᵀ)v = 0 with the
/// reference station's equation replaced by v[reference] = 1. `None` when the system is singular
/// (the chain is not irreducible).
pub fn visit_ratios(p: &[Vec<f64>], reference: usize) -> Option<Vec<f64>> {
    let d = p.len();
    if d == 0 || reference >= d {
        return None;
    }
    let mut a = vec![vec![0.0; d + 1]; d];
    for i in 0..d {
        for j in 0..d {
            a[i][j] = (if i == j { 1.0 } else { 0.0 }) - p[j][i];
        }
    }
    for j in 0..=d {
        a[reference][j] = if j == reference || j == d { 1.0 } else { 0.0 };
    }
    for col in 0..d {
        let pivot = (col..d).max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))?;
        if !(a[pivot][col].abs() > 1e-12) {
            return None;
        }
        a.swap(col, pivot);
        for row in 0..d {
            if row != col {
                let f = a[row][col] / a[col][col];
                if f != 0.0 {
                    for j in col..=d {
                        a[row][j] -= f * a[col][j];
                    }
                }
            }
        }
    }
    let v: Vec<f64> = (0..d).map(|i| a[i][d] / a[i][i]).collect();
    v.iter().all(|x| x.is_finite() && *x > 0.0).then_some(v)
}

// ── Convolution (Buzen 1973) ────────────────────────────────────────────────────────────────────

/// A vector of non-negative weights with a common factor exp(`ln_scale`) taken out.
#[derive(Clone, Debug)]
struct Scaled {
    v: Vec<f64>,
    ln_scale: f64,
}

impl Scaled {
    fn one(n: usize) -> Scaled {
        let mut v = vec![0.0; n + 1];
        v[0] = 1.0;
        Scaled { v, ln_scale: 0.0 }
    }

    fn renormalise(&mut self) {
        let top = self.v.iter().cloned().fold(0.0f64, f64::max);
        if top > 0.0 && top.is_finite() {
            for x in &mut self.v {
                *x /= top;
            }
            self.ln_scale += top.ln();
        }
    }

    /// Folds in a single-server station of scaled load `y`: g(n) ← g(n) + y·g(n−1), in place and
    /// in increasing n (Buzen's one-line step).
    fn fold_single(&mut self, y: f64) {
        for n in 1..self.v.len() {
            self.v[n] += y * self.v[n - 1];
        }
        self.renormalise();
    }

    /// Folds in a general station factor.
    fn fold(&mut self, f: &Scaled) {
        let n = self.v.len();
        let mut out = vec![0.0; n];
        for (m, o) in out.iter_mut().enumerate() {
            let mut s = 0.0;
            for k in 0..=m {
                s += f.v[k] * self.v[m - k];
            }
            *o = s;
        }
        self.v = out;
        self.ln_scale += f.ln_scale;
        self.renormalise();
    }
}

/// How a station enters the product form.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Single,
    Multi(usize),
    Delay,
}

fn kind_of(model: &ClosedModel, i: usize) -> Kind {
    if model.delay[i] {
        Kind::Delay
    } else if model.servers[i] <= 1 {
        Kind::Single
    } else {
        Kind::Multi(model.servers[i] as usize)
    }
}

/// f(n) for n = 0..=N at scaled load `y`, divided by its largest entry.
fn factor(kind: Kind, y: f64, n_max: usize) -> Scaled {
    let ln_y = y.ln();
    let mut ln = vec![0.0; n_max + 1];
    for n in 1..=n_max {
        let rate = match kind {
            Kind::Single => 1.0,
            Kind::Multi(c) => n.min(c) as f64,
            Kind::Delay => n as f64,
        };
        ln[n] = ln[n - 1] + ln_y - rate.ln();
    }
    let top = ln.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    Scaled { v: ln.iter().map(|x| (x - top).exp()).collect(), ln_scale: top }
}

fn check(model: &ClosedModel) -> Result<Vec<f64>, ClosedError> {
    let m = model.mu.len();
    if m == 0 {
        return Err(ClosedError::NoStations);
    }
    if model.population < 1 || model.population as i64 > MAX_POPULATION {
        return Err(ClosedError::PopulationOutOfRange(model.population as i64));
    }
    for i in 0..m {
        if !(model.mu[i].is_finite() && model.mu[i] > 0.0) {
            return Err(ClosedError::BadServiceRate(model.names[i].clone()));
        }
        if !model.delay[i] && model.servers[i] < 1 {
            return Err(ClosedError::NoServers(model.names[i].clone()));
        }
        let sum: f64 = model.p[i].iter().sum();
        if sum > 1.0 + ROW_TOLERANCE {
            return Err(ClosedError::RoutingExceedsOne(model.names[i].clone(), sum));
        }
        if sum < 1.0 - ROW_TOLERANCE || !sum.is_finite() {
            return Err(ClosedError::RoutingLeaks(model.names[i].clone(), sum));
        }
    }
    let names = |ix: &[usize]| ix.iter().map(|&i| model.names[i].clone()).collect::<Vec<_>>();
    match structure(&model.p) {
        Structure::Irreducible => {}
        Structure::Transient(ix) => return Err(ClosedError::Unreachable(names(&ix))),
        Structure::SeveralClosed(ix) => return Err(ClosedError::Reducible(names(&ix))),
    }
    visit_ratios(&model.p, 0).ok_or_else(|| ClosedError::Reducible(vec![model.names[0].clone()]))
}

/// The scale α that brings the busiest queueing station's load per server to 1 (the largest delay
/// load, when there are only delay stations).
fn load_scale(model: &ClosedModel, y: &[f64]) -> f64 {
    let m = y.len();
    let queueing = (0..m).filter(|&i| !model.delay[i]).map(|i| y[i] / model.servers[i].max(1) as f64).fold(0.0f64, f64::max);
    let top = if queueing > 0.0 { queueing } else { y.iter().cloned().fold(0.0f64, f64::max) };
    1.0 / top
}

/// Buzen's convolution algorithm: every quantity, with the marginal distributions.
pub fn convolution(model: &ClosedModel) -> Result<ClosedSolution, ClosedError> {
    let visits = check(model)?;
    let m = visits.len();
    let n = model.population;
    let y: Vec<f64> = (0..m).map(|i| visits[i] / model.mu[i]).collect();
    let alpha = load_scale(model, &y);
    let kinds: Vec<Kind> = (0..m).map(|i| kind_of(model, i)).collect();
    let factors: Vec<Scaled> = (0..m).map(|i| factor(kinds[i], alpha * y[i], n)).collect();

    // G without station `skip` (all of them for None): the general factors first, then the
    // single-server ones by the one-line step.
    let fold_all = |skip: Option<usize>| -> Scaled {
        let mut g = Scaled::one(n);
        for i in (0..m).filter(|&i| Some(i) != skip && kinds[i] != Kind::Single) {
            g.fold(&factors[i]);
        }
        for i in (0..m).filter(|&i| Some(i) != skip && kinds[i] == Kind::Single) {
            g.fold_single(alpha * y[i]);
        }
        g
    };

    let g = fold_all(None);
    // X = G(N−1)/G(N), undoing the load scale (G′(n) = αⁿ G(n)).
    let throughput = alpha * g.v[n - 1] / g.v[n];
    let ln_g = g.v[n].ln() + g.ln_scale - n as f64 * alpha.ln();

    let mut marginals = Vec::with_capacity(m);
    for i in 0..m {
        let rest = fold_all(Some(i));
        // p_i(k) ∝ f_i(k)·G₍₋ᵢ₎(N−k); normalised by its own sum, which is G(N) up to rounding.
        let mut pk: Vec<f64> = (0..=n).map(|k| factors[i].v[k] * rest.v[n - k]).collect();
        let total: f64 = pk.iter().sum();
        for x in &mut pk {
            *x /= total;
        }
        marginals.push(pk);
    }

    let station_throughput: Vec<f64> = visits.iter().map(|v| v * throughput).collect();
    let number: Vec<f64> = marginals.iter().map(|pk| pk.iter().enumerate().map(|(k, p)| k as f64 * p).sum()).collect();
    Ok(assemble(model, visits, throughput, station_throughput, number, ln_g, marginals))
}

fn assemble(model: &ClosedModel, visits: Vec<f64>, throughput: f64, station_throughput: Vec<f64>, number: Vec<f64>, ln_g: f64, marginals: Vec<Vec<f64>>) -> ClosedSolution {
    let m = visits.len();
    let utilisation = (0..m).map(|i| (!model.delay[i]).then(|| station_throughput[i] / (model.servers[i].max(1) as f64 * model.mu[i]))).collect();
    let queue = (0..m).map(|i| if model.delay[i] { 0.0 } else { (number[i] - station_throughput[i] / model.mu[i]).max(0.0) }).collect();
    let residence = (0..m).map(|i| number[i] / station_throughput[i]).collect();
    ClosedSolution { visits, throughput, station_throughput, utilisation, number, queue, residence, ln_g, marginals }
}

// ── Mean Value Analysis (Reiser & Lavenberg 1980) ───────────────────────────────────────────────

/// True when exact MVA applies as implemented: every station has one server or is a delay station.
pub fn mva_applies(model: &ClosedModel) -> bool {
    (0..model.mu.len()).all(|i| model.delay[i] || model.servers[i] == 1)
}

/// Exact MVA for load-independent stations: the means, and ln G(N) = −Σ_{n≤N} ln X(n) (from
/// X(n) = G(n−1)/G(n), G(0) = 1). No marginals. `None` when a station has several servers.
pub fn mva(model: &ClosedModel) -> Result<Option<ClosedSolution>, ClosedError> {
    let visits = check(model)?;
    if !mva_applies(model) {
        return Ok(None);
    }
    let m = visits.len();
    let mut number = vec![0.0; m];
    let mut throughput = 0.0;
    let mut ln_g = 0.0;
    for n in 1..=model.population {
        // The arrival theorem: an arriving customer finds L_i(n − 1) ahead of it.
        let r: Vec<f64> = (0..m).map(|i| if model.delay[i] { 1.0 / model.mu[i] } else { (1.0 + number[i]) / model.mu[i] }).collect();
        let cycle: f64 = (0..m).map(|i| visits[i] * r[i]).sum();
        throughput = n as f64 / cycle;
        for i in 0..m {
            number[i] = throughput * visits[i] * r[i];
        }
        ln_g -= throughput.ln();
    }
    let station_throughput: Vec<f64> = visits.iter().map(|v| v * throughput).collect();
    Ok(Some(assemble(model, visits, throughput, station_throughput, number, ln_g, Vec::new())))
}

/// The exact solution with the marginals (convolution), cross-checked against MVA where MVA
/// applies: the largest relative difference between the two routes over X and every L_i, or
/// `None` when a station has several servers.
pub fn solve(model: &ClosedModel) -> Result<(ClosedSolution, Option<f64>), ClosedError> {
    let conv = convolution(model)?;
    let gap = mva(model)?.map(|m| {
        let rel = |a: f64, b: f64| (a - b).abs() / a.abs().max(b.abs()).max(1e-300);
        let mut worst = rel(conv.throughput, m.throughput);
        for i in 0..conv.number.len() {
            // Relative to the population, so an almost empty station does not dominate.
            worst = worst.max((conv.number[i] - m.number[i]).abs() / model.population as f64);
        }
        worst
    });
    Ok((conv, gap))
}

/// The means by the cheaper exact route: MVA when every station is load-independent (O(MN)),
/// else convolution. For the live results.
pub fn means(model: &ClosedModel) -> Result<ClosedSolution, ClosedError> {
    match mva(model)? {
        Some(s) => Ok(s),
        None => convolution(model),
    }
}

// ── The model of a drawn network ────────────────────────────────────────────────────────────────

/// True when the network is drawn as a closed one: stations, no source and no sink.
pub fn looks_closed(net: &Network) -> bool {
    let has = |k: NodeKind| net.nodes.iter().any(|n| n.kind == k);
    has(NodeKind::Station) && !has(NodeKind::Source) && !has(NodeKind::Sink)
}

/// True when the network is a closed network: no source, no sink, and a population set.
pub fn is_closed(net: &Network) -> bool {
    net.population.is_some() && looks_closed(net)
}

/// How a network is drawn, by the one rule every part of Qnet uses to tell a closed network from
/// an open one (the live results, the runner, the problems list, and every analysis that covers
/// open networks only). The interface's copy is `src/closed/shape.ts`, checked against this one on
/// the cases of `src/closed/shape.fixtures.json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drawn {
    /// It has a source or a sink (a population, if one is set, is ignored), or it is a network
    /// still being started: stations with nothing leaving any of them and no population.
    Open,
    /// Stations, no source, no sink, and a population: a closed network.
    Closed,
    /// Stations joined to one another, no source and no sink, but no population yet.
    ClosedNoPopulation,
}

impl Drawn {
    /// The reason code the interface is given.
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Drawn::Open => None,
            Drawn::Closed => Some("closed"),
            Drawn::ClosedNoPopulation => Some("closedNoPopulation"),
        }
    }
}

/// The rule (see [`Drawn`]).
pub fn drawn_as(net: &Network) -> Drawn {
    if !looks_closed(net) {
        return Drawn::Open;
    }
    if net.population.is_some() {
        return Drawn::Closed;
    }
    // A lone station is a network being started, and is told what an open network still needs.
    let routed = net.links.iter().any(|l| net.node(&l.from).is_some_and(|n| n.kind == NodeKind::Station));
    if routed {
        Drawn::ClosedNoPopulation
    } else {
        Drawn::Open
    }
}

/// What an analysis that covers open networks only says of a network drawn as a closed one: the
/// reason code and the sentence, or None for an open network. `analysis` starts the sentence
/// ("Capacity planning", "Uncertainty analysis").
pub fn open_only(net: &Network, analysis: &str) -> Option<(&'static str, String)> {
    let d = drawn_as(net);
    let sentence = match d {
        Drawn::Open => return None,
        Drawn::Closed => format!("This is a closed network: a fixed number of customers circulates and nothing arrives from outside. {analysis} covers open networks."),
        Drawn::ClosedNoPopulation => format!("{} {analysis} covers open networks, which have a source and a sink.", ClosedError::PopulationMissing.message()),
    };
    Some((d.reason().unwrap(), sentence))
}

/// The closed model of a drawn network, or why it has none. The routing is read as
/// `traffic::compute` reads it: a link from a station into a buffer delivers to the station that
/// buffer feeds.
pub fn from_network(net: &Network) -> Result<ClosedModel, ClosedError> {
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
    if stations.is_empty() {
        return Err(ClosedError::NoStations);
    }
    if !looks_closed(net) {
        return Err(ClosedError::NotClosed);
    }
    let population = net.population.ok_or(ClosedError::PopulationMissing)?;
    if !(1..=MAX_POPULATION).contains(&population) {
        return Err(ClosedError::PopulationOutOfRange(population));
    }
    if net.links.iter().any(|l| l.class != 0 || l.has_class_transition()) {
        return Err(ClosedError::MultiClass);
    }
    let index: HashMap<&str, usize> = stations.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
    // The buffer in front of each station (exactly one), and so the station a buffer feeds.
    let mut capacity = Vec::with_capacity(stations.len());
    for s in &stations {
        let feeding: Vec<_> = net.nodes.iter().filter(|b| b.kind == NodeKind::Buffer && net.links.iter().any(|l| l.from == b.id && l.to == s.id)).collect();
        match feeding.len() {
            0 => return Err(ClosedError::StationMissingBuffer(s.name.clone())),
            1 => capacity.push(feeding[0].buffer_size.saturating_add(s.servers)),
            _ => return Err(ClosedError::StationMultipleBuffers(s.name.clone())),
        }
    }
    let resolve = |node_id: &str| -> Option<usize> {
        let node = net.nodes.iter().find(|n| n.id == node_id)?;
        match node.kind {
            NodeKind::Station => index.get(node.id.as_str()).copied(),
            NodeKind::Buffer => net.links.iter().filter(|l| l.from == node.id).find_map(|l| index.get(l.to.as_str()).copied()),
            _ => None,
        }
    };
    let d = stations.len();
    let mut p = vec![vec![0.0; d]; d];
    let mut mu = Vec::with_capacity(d);
    let mut odd = Vec::new();
    for (i, s) in stations.iter().enumerate() {
        for l in net.links.iter().filter(|l| l.from == s.id) {
            if let Some(t) = resolve(&l.to) {
                p[i][t] += l.probability;
            }
        }
        let law = s.service_by_class.get(&0).map(|c| c.distribution).unwrap_or(s.distribution);
        if law != Distribution::Exponential {
            odd.push(s.name.clone());
        }
        let rate = traffic::service_rate_for_class(s, 0);
        if !(rate.is_finite() && rate > 0.0) {
            return Err(ClosedError::BadServiceRate(s.name.clone()));
        }
        if s.servers < 1 {
            return Err(ClosedError::NoServers(s.name.clone()));
        }
        mu.push(rate);
    }
    if !odd.is_empty() {
        return Err(ClosedError::NotExponential(odd));
    }
    if !net.infinite_buffers {
        if let Some(i) = (0..d).find(|&i| capacity[i] < population) {
            return Err(ClosedError::BufferTooSmall(stations[i].name.clone(), capacity[i]));
        }
    }
    let model = ClosedModel {
        ids: stations.iter().map(|s| s.id.clone()).collect(),
        names: stations.iter().map(|s| s.name.clone()).collect(),
        p,
        mu,
        servers: stations.iter().map(|s| s.servers).collect(),
        delay: vec![false; d],
        population: population as usize,
    };
    check(&model)?;
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A model from loads: `stations` are (μ, servers, delay), routing `p`.
    fn model(stations: &[(f64, i64, bool)], p: Vec<Vec<f64>>, population: usize) -> ClosedModel {
        ClosedModel {
            ids: (0..stations.len()).map(|i| format!("id{i}")).collect(),
            names: (0..stations.len()).map(|i| format!("S{}", i + 1)).collect(),
            p,
            mu: stations.iter().map(|s| s.0).collect(),
            servers: stations.iter().map(|s| s.1).collect(),
            delay: stations.iter().map(|s| s.2).collect(),
            population,
        }
    }

    /// A cycle S1 → S2 → … → S1.
    fn cycle(d: usize) -> Vec<Vec<f64>> {
        (0..d).map(|i| (0..d).map(|j| if j == (i + 1) % d { 1.0 } else { 0.0 }).collect()).collect()
    }

    /// A central-server routing: station 0 sends to station j with q[j−1]... and back to itself
    /// with what is left; every other station returns to station 0.
    fn central(q: &[f64]) -> Vec<Vec<f64>> {
        let d = q.len() + 1;
        let mut p = vec![vec![0.0; d]; d];
        p[0][0] = 1.0 - q.iter().sum::<f64>();
        for (j, x) in q.iter().enumerate() {
            p[0][j + 1] = *x;
            p[j + 1][0] = 1.0;
        }
        p
    }

    /// A small deterministic generator (a 64-bit LCG, Knuth's MMIX constants): uniform in [0, 1).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() * n as f64) as usize
        }
    }

    /// A random irreducible routing matrix: a cycle through all stations mixed with random rows.
    fn random_routing(rng: &mut Lcg, d: usize) -> Vec<Vec<f64>> {
        let ring = cycle(d);
        (0..d)
            .map(|i| {
                let raw: Vec<f64> = (0..d).map(|_| if rng.next() < 0.6 { rng.next() } else { 0.0 }).collect();
                let total: f64 = raw.iter().sum();
                let w = if total > 0.0 { 0.25 + 0.5 * rng.next() } else { 1.0 };
                (0..d).map(|j| w * ring[i][j] + if total > 0.0 { (1.0 - w) * raw[j] / total } else { 0.0 }).collect()
            })
            .collect()
    }

    /// The definition, with no algorithm: every state (n₁, …, n_M) with Σ n_i = N, its weight
    /// Π f_i(n_i), summed directly. Returns (G, the marginals, the mean completion rate at each
    /// station Σ_n p_i(n)·μ_i·min(n, c_i)).
    fn enumerate(m: &ClosedModel, v: &[f64]) -> (f64, Vec<Vec<f64>>, Vec<f64>) {
        let d = v.len();
        let n = m.population;
        let f = |i: usize, k: usize| -> f64 {
            let y = v[i] / m.mu[i];
            (1..=k).fold(1.0, |acc, j| acc * y / if m.delay[i] { j as f64 } else { j.min(m.servers[i] as usize) as f64 })
        };
        let mut marg = vec![vec![0.0; n + 1]; d];
        let mut g = 0.0;
        let mut state = vec![0usize; d];
        fn walk(i: usize, left: usize, state: &mut Vec<usize>, each: &mut dyn FnMut(&[usize])) {
            if i + 1 == state.len() {
                state[i] = left;
                each(state);
                return;
            }
            for k in 0..=left {
                state[i] = k;
                walk(i + 1, left - k, state, each);
            }
        }
        walk(0, n, &mut state, &mut |s: &[usize]| {
            let w: f64 = (0..d).map(|i| f(i, s[i])).product();
            g += w;
            for i in 0..d {
                marg[i][s[i]] += w;
            }
        });
        for row in &mut marg {
            for x in row.iter_mut() {
                *x /= g;
            }
        }
        let rate = (0..d)
            .map(|i| (0..=n).map(|k| marg[i][k] * m.mu[i] * if m.delay[i] { k as f64 } else { k.min(m.servers[i] as usize) as f64 }).sum())
            .collect();
        (g, marg, rate)
    }

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * a.abs().max(b.abs()).max(1.0)
    }

    // ── Visit ratios and structure ──────────────────────────────────────────────────────────────

    #[test]
    fn visit_ratios_solve_v_equals_vp_with_the_first_station_as_reference() {
        // Central server: v₀ = 1, v_j = q_j.
        let v = visit_ratios(&central(&[0.5, 0.3]), 0).unwrap();
        assert!(close(v[0], 1.0, 1e-15) && close(v[1], 0.5, 1e-15) && close(v[2], 0.3, 1e-15), "{v:?}");
        // A periodic cycle is fine: every station is visited once per cycle.
        assert_eq!(visit_ratios(&cycle(4), 0).unwrap(), vec![1.0; 4]);
        // Another reference only rescales.
        let w = visit_ratios(&central(&[0.5, 0.3]), 2).unwrap();
        assert!(close(w[0], 1.0 / 0.3, 1e-14) && close(w[2], 1.0, 1e-15));
        let mut rng = Lcg(7);
        for d in 2..8 {
            let p = random_routing(&mut rng, d);
            let v = visit_ratios(&p, 0).unwrap();
            for j in 0..d {
                let back: f64 = (0..d).map(|i| v[i] * p[i][j]).sum();
                assert!((back - v[j]).abs() < 1e-13, "v = vP at {j}");
            }
        }
    }

    #[test]
    fn a_routing_that_is_not_one_closed_group_is_named() {
        // S3 feeds the cycle S1 ⇄ S2 and nothing returns: transient.
        let p = vec![vec![0.0, 1.0, 0.0], vec![1.0, 0.0, 0.0], vec![1.0, 0.0, 0.0]];
        assert_eq!(structure(&p), Structure::Transient(vec![2]));
        let m = model(&[(1.0, 1, false); 3], p, 2);
        assert_eq!(convolution(&m).unwrap_err(), ClosedError::Unreachable(vec!["S3".into()]));
        // Two separate loops.
        let p = vec![vec![0.0, 1.0, 0.0, 0.0], vec![1.0, 0.0, 0.0, 0.0], vec![0.0, 0.0, 0.0, 1.0], vec![0.0, 0.0, 1.0, 0.0]];
        assert_eq!(structure(&p), Structure::SeveralClosed(vec![0, 2]));
        assert_eq!(mva(&model(&[(1.0, 1, false); 4], p, 2)).unwrap_err(), ClosedError::Reducible(vec!["S1".into(), "S3".into()]));
        // A row that leaks, and one over 1.
        let m = model(&[(1.0, 1, false); 2], vec![vec![0.0, 0.9], vec![1.0, 0.0]], 2);
        assert!(matches!(convolution(&m).unwrap_err(), ClosedError::RoutingLeaks(n, s) if n == "S1" && (s - 0.9).abs() < 1e-12));
        let m = model(&[(1.0, 1, false); 2], vec![vec![0.2, 0.9], vec![1.0, 0.0]], 2);
        assert!(matches!(convolution(&m).unwrap_err(), ClosedError::RoutingExceedsOne(..)));
        assert_eq!(convolution(&model(&[(1.0, 1, false); 2], cycle(2), 0)).unwrap_err(), ClosedError::PopulationOutOfRange(0));
        assert_eq!(structure(&cycle(5)), Structure::Irreducible);
    }

    // ── Exact answers ───────────────────────────────────────────────────────────────────────────

    /// The two-station cyclic queue (Gross, Shortle, Thompson & Harris, *Fundamentals of Queueing
    /// Theory*, 4th ed., §4.3 "Closed Jackson networks"; Koenigsberg 1958): with y_i = 1/μ_i,
    /// G(N) = Σ_{k=0..N} y₁ᵏ y₂^{N−k} = (y₁^{N+1} − y₂^{N+1})/(y₁ − y₂), X = G(N−1)/G(N), and
    /// P(n at station 1) = y₁ⁿ y₂^{N−n}/G(N). Station 1 is an M/M/1/N queue with ρ = μ₂/μ₁... seen
    /// from station 1 arrivals come at rate μ₂ whenever station 2 is busy.
    #[test]
    fn the_two_station_cyclic_network_has_its_closed_form() {
        for &(mu1, mu2, n) in &[(1.0, 2.0, 1usize), (1.0, 2.0, 5), (3.0, 0.7, 12), (1.0, 1.25, 40)] {
            let m = model(&[(mu1, 1, false), (mu2, 1, false)], cycle(2), n);
            let (y1, y2): (f64, f64) = (1.0 / mu1, 1.0 / mu2);
            let g = |k: usize| (y1.powi(k as i32 + 1) - y2.powi(k as i32 + 1)) / (y1 - y2);
            for s in [convolution(&m).unwrap(), mva(&m).unwrap().unwrap()] {
                assert!(close(s.throughput, g(n - 1) / g(n), 1e-13), "X for μ = ({mu1}, {mu2}), N = {n}");
                assert!(close(s.ln_g, g(n).ln(), 1e-12), "ln G");
                let l1: f64 = (0..=n).map(|k| k as f64 * y1.powi(k as i32) * y2.powi((n - k) as i32) / g(n)).sum();
                assert!(close(s.number[0], l1, 1e-12) && close(s.number[1], n as f64 - l1, 1e-12), "L");
                // U_i = X/μ_i = 1 − P(station i empty).
                assert!(close(s.utilisation[0].unwrap(), 1.0 - y2.powi(n as i32) / g(n), 1e-13));
            }
            let s = convolution(&m).unwrap();
            for k in 0..=n {
                assert!(close(s.marginals[0][k], y1.powi(k as i32) * y2.powi((n - k) as i32) / g(n), 1e-13), "p₁({k})");
                assert!(close(s.marginals[1][k], s.marginals[0][n - k], 1e-13), "station 2 holds the rest");
            }
        }
    }

    /// Equal stations (y_i = y): every state is equally likely, there are C(N+M−1, M−1) of them,
    /// so G(N) = C(N+M−1, M−1)·y^N and X = N/((N + M − 1)·y), L_i = N/M (Gross et al., §4.3;
    /// Lazowska et al. 1984, §5.2 "balanced system bounds").
    #[test]
    fn a_balanced_network_has_throughput_n_over_n_plus_m_minus_1() {
        for &(d, n, mu) in &[(2usize, 3usize, 1.0), (4, 10, 2.5), (7, 30, 0.4), (3, 2000, 1.0)] {
            let m = model(&vec![(mu, 1, false); d], cycle(d), n);
            let exact = n as f64 * mu / (n + d - 1) as f64;
            let c = convolution(&m).unwrap();
            let v = mva(&m).unwrap().unwrap();
            assert!(close(c.throughput, exact, 1e-12) && close(v.throughput, exact, 1e-12), "d = {d}, N = {n}");
            for i in 0..d {
                assert!(close(c.number[i], n as f64 / d as f64, 1e-11) && close(v.number[i], n as f64 / d as f64, 1e-11));
            }
            // ln C(N+M−1, M−1) − N ln μ
            let ln_binom: f64 = (1..d).map(|k| ((n + k) as f64 / k as f64).ln()).sum();
            assert!(close(c.ln_g, ln_binom - n as f64 * mu.ln(), 1e-11) && close(v.ln_g, c.ln_g, 1e-11));
        }
    }

    /// The machine-repair (finite-source) queue M/M/c//N: N machines, each up for an Exp(λ) time,
    /// c repairers at rate μ. As a closed network: a delay station (rate λ) and a c-server
    /// station (rate μ). Gross et al., 4th ed., §2.8 "Finite-source queues":
    /// p_n ∝ C(N, n)·rⁿ for n ≤ c and C(N, n)·n!/(c!·c^{n−c})·rⁿ for n ≥ c, r = λ/μ, n the number
    /// in repair; the effective arrival rate is λ(N − L).
    #[test]
    fn the_machine_repair_queue_matches_the_finite_source_formulas() {
        for &(lambda, mu, c, n) in &[(0.2, 1.0, 1i64, 5usize), (0.5, 1.0, 2, 6), (1.0 / 3.0, 0.5, 3, 20), (0.05, 1.0, 4, 100)] {
            let m = model(&[(lambda, 1, true), (mu, c, false)], cycle(2), n);
            let s = convolution(&m).unwrap();
            let r: f64 = lambda / mu;
            let mut w = vec![1.0f64; n + 1];
            for k in 1..=n {
                // C(N, k)·k!/(Π min(j, c)) rᵏ built term by term.
                w[k] = w[k - 1] * (n - k + 1) as f64 * r / (k as i64).min(c) as f64;
            }
            let total: f64 = w.iter().sum();
            let l: f64 = (0..=n).map(|k| k as f64 * w[k] / total).sum();
            for k in 0..=n {
                assert!(close(s.marginals[1][k], w[k] / total, 1e-12), "p({k}) for c = {c}, N = {n}");
            }
            assert!(close(s.number[1], l, 1e-12), "L in repair");
            assert!(close(s.throughput, lambda * (n as f64 - l), 1e-12), "λ_eff = λ(N − L)");
            assert!(close(s.number[0], n as f64 - l, 1e-12) && s.utilisation[0].is_none() && s.queue[0] == 0.0);
            if c == 1 {
                let v = mva(&m).unwrap().unwrap();
                assert!(close(v.throughput, s.throughput, 1e-12) && close(v.number[1], l, 1e-12));
            } else {
                assert_eq!(mva(&m).unwrap(), None, "MVA is kept to load-independent stations");
            }
        }
    }

    /// Lazowska, Zahorjan, Graham & Sevcik (1984), *Quantitative System Performance*, §6.4.2
    /// "Closed Model Example (Exact Solution)", Table 6.2, p. 117 (Algorithm 6.2, exact MVA):
    /// three centres with demands D = 0.605 s (CPU), 2.1 s (Disk1) and 1.35 s (Disk2), a terminal
    /// class with think time Z = 15 s and N = 1, 2, 3 customers. The table prints
    ///   R_k:  .605 2.1 1.35 | .624 2.331 1.446 | .644 2.605 1.551
    ///   X:    .0525 | .1031 | .1515
    ///   Q_k:  .0318 .1102 .0708 | .0643 .2403 .1490 | .0976 .3947 .2350
    /// and below it R(3) = 3/.152 − 15.0 = 4.74 from the rounded X, U_CPU(3) = .092.
    /// Service demands D_k = v_k/μ_k are all the product form reads, so the model is a cycle with
    /// μ_k = 1/D_k and a delay station of rate 1/Z. Tolerance: one unit of the last printed digit
    /// (two entries, Q_Disk2(1) = 0.07085 and Q_CPU(2) = 0.06435, are printed rounded down).
    #[test]
    fn lazowska_et_al_table_6_2_is_reproduced() {
        let table: [(usize, f64, [f64; 3], [f64; 3]); 3] = [
            (1, 0.0525, [0.0318, 0.1102, 0.0708], [0.605, 2.1, 1.35]),
            (2, 0.1031, [0.0643, 0.2403, 0.1490], [0.624, 2.331, 1.446]),
            (3, 0.1515, [0.0976, 0.3947, 0.2350], [0.644, 2.605, 1.551]),
        ];
        let at = |n: usize| model(&[(1.0 / 15.0, 1, true), (1.0 / 0.605, 1, false), (1.0 / 2.1, 1, false), (1.0 / 1.35, 1, false)], cycle(4), n);
        for (n, x, q, r) in table {
            for s in [convolution(&at(n)).unwrap(), mva(&at(n)).unwrap().unwrap()] {
                assert!((s.throughput - x).abs() < 1e-4, "X({n}) = {} against {x}", s.throughput);
                for i in 0..3 {
                    assert!((s.number[i + 1] - q[i]).abs() < 1e-4, "Q{}({n}) = {} against {}", i + 1, s.number[i + 1], q[i]);
                    assert!((s.residence[i + 1] - r[i]).abs() < 1e-3, "R{}({n}) = {} against {}", i + 1, s.residence[i + 1], r[i]);
                }
            }
        }
        let s = convolution(&at(3)).unwrap();
        // The book's 4.74 comes from X rounded to .152; unrounded, R(3) = 3/X − Z = 4.80.
        assert!((3.0 / s.throughput - 15.0 - 4.80).abs() < 5e-3, "R(3) = {}", 3.0 / s.throughput - 15.0);
        assert!((3.0 / 0.152 - 15.0 - 4.74f64).abs() < 5e-3);
        assert!((s.utilisation[1].unwrap() - 0.092).abs() < 5e-4, "U_CPU(3)");
    }

    /// One customer never queues: X = 1/Σ v_i/μ_i, L_i = X v_i/μ_i, W_i = 1/μ_i, and each
    /// station holds it with probability L_i.
    #[test]
    fn one_customer_is_the_trivial_case() {
        let p = central(&[0.6, 0.3]);
        let m = model(&[(4.0, 1, false), (1.5, 3, false), (0.5, 1, true)], p, 1);
        let v = [1.0, 0.6, 0.3];
        let cycle_time: f64 = (0..3).map(|i| v[i] / m.mu[i]).sum();
        let s = convolution(&m).unwrap();
        assert!(close(s.throughput, 1.0 / cycle_time, 1e-14));
        for i in 0..3 {
            assert!(close(s.number[i], v[i] / m.mu[i] / cycle_time, 1e-14));
            assert!(close(s.residence[i], 1.0 / m.mu[i], 1e-14) && s.queue[i] < 1e-14);
            assert!(close(s.marginals[i][1], s.number[i], 1e-14) && close(s.marginals[i][0], 1.0 - s.number[i], 1e-14));
        }
        assert!(close(s.cycle_time(1), cycle_time, 1e-14));
    }

    // ── The two routes, and the definition ──────────────────────────────────────────────────────

    /// Convolution and MVA are different algorithms for the same product form: over 300 random
    /// irreducible networks of single-server and delay stations (2–8 stations, N up to 200) they
    /// agree to 1e-10 relative in X, ln G and every L_i and W_i. Both are sums of positive terms
    /// (no cancellation), so the difference is rounding accumulated over N steps.
    #[test]
    fn convolution_and_mva_agree_to_1e_10_on_random_networks() {
        let mut rng = Lcg(20261113);
        let mut worst = 0.0f64;
        for case in 0..300 {
            let d = 2 + rng.below(7);
            let n = 1 + rng.below(if case % 10 == 0 { 200 } else { 40 });
            let stations: Vec<(f64, i64, bool)> = (0..d).map(|_| (0.2 + 4.0 * rng.next(), 1, rng.next() < 0.2)).collect();
            let m = model(&stations, random_routing(&mut rng, d), n);
            let c = convolution(&m).unwrap();
            let v = mva(&m).unwrap().unwrap();
            let rel = |a: f64, b: f64| (a - b).abs() / a.abs().max(b.abs());
            let mut gap = rel(c.throughput, v.throughput).max((c.ln_g - v.ln_g).abs() / c.ln_g.abs().max(1.0));
            for i in 0..d {
                gap = gap.max(rel(c.number[i], v.number[i])).max(rel(c.residence[i], v.residence[i]));
            }
            assert!(gap < 1e-10, "case {case}: d = {d}, N = {n}, gap {gap:e}");
            worst = worst.max(gap);
            assert!(solve(&m).unwrap().1.unwrap() < 1e-10);
            assert_eq!(means(&m).unwrap(), v, "the live route is MVA here");
        }
        assert!(worst > 0.0, "the two routes are not the same arithmetic");
    }

    /// Against the definition: every state enumerated and summed, for networks with multi-server
    /// and delay stations (where MVA is not used). G, the marginals, L and the throughput as the
    /// mean completion rate Σ p_i(n) μ_i min(n, c_i) (a route that does not use G(N−1)/G(N)).
    #[test]
    fn convolution_matches_brute_force_enumeration_with_several_servers() {
        let mut rng = Lcg(501);
        for case in 0..120 {
            let d = 2 + rng.below(4);
            let n = 1 + rng.below(9);
            let stations: Vec<(f64, i64, bool)> = (0..d).map(|_| (0.2 + 3.0 * rng.next(), 1 + rng.below(4) as i64, rng.next() < 0.15)).collect();
            let m = model(&stations, random_routing(&mut rng, d), n);
            let s = convolution(&m).unwrap();
            let (g, marg, rate) = enumerate(&m, &s.visits);
            assert!(close(s.ln_g, g.ln(), 1e-11), "case {case}: ln G {} against {}", s.ln_g, g.ln());
            for i in 0..d {
                for k in 0..=n {
                    assert!((s.marginals[i][k] - marg[i][k]).abs() < 1e-12, "case {case}: p_{i}({k})");
                }
                assert!(close(s.station_throughput[i], rate[i], 1e-11), "case {case}: X_{i} = {} against {}", s.station_throughput[i], rate[i]);
                assert!((s.marginals[i].iter().sum::<f64>() - 1.0).abs() < 1e-12);
            }
            assert!((s.number.iter().sum::<f64>() - n as f64).abs() < 1e-10 * n as f64, "the customers are all somewhere");
        }
    }

    /// The arrival theorem (Sevcik & Mitrani 1981; Lavenberg & Reiser 1980), checked on the
    /// convolution's output, which does not assume it: at a single-server station
    /// W_i(N) = (1 + L_i(N−1))/μ_i, and at a c-server station the arriving customer waits when it
    /// finds c or more: Wq_i(N) = Σ_{k≥c} p_i(k | N−1)·(k − c + 1)/(c μ_i).
    #[test]
    fn the_arrival_theorem_holds_between_populations_n_and_n_minus_1() {
        let mut rng = Lcg(99);
        for _ in 0..60 {
            let d = 2 + rng.below(4);
            let n = 2 + rng.below(25);
            let stations: Vec<(f64, i64, bool)> = (0..d).map(|_| (0.3 + 3.0 * rng.next(), 1 + rng.below(3) as i64, false)).collect();
            let p = random_routing(&mut rng, d);
            let now = convolution(&model(&stations, p.clone(), n)).unwrap();
            let before = convolution(&model(&stations, p, n - 1)).unwrap();
            for i in 0..d {
                let (mu, c) = (stations[i].0, stations[i].1 as usize);
                let wait: f64 = (c..n).map(|k| before.marginals[i][k] * (k - c + 1) as f64 / (c as f64 * mu)).sum();
                assert!(close(now.residence[i], 1.0 / mu + wait, 1e-10), "W_{i}({n})");
                if c == 1 {
                    assert!(close(now.residence[i], (1.0 + before.number[i]) / mu, 1e-10));
                }
                assert!(close(now.queue[i] / now.station_throughput[i], wait, 1e-9) || wait < 1e-12);
            }
        }
    }

    /// As N grows the bottleneck saturates: X(N) increases to min_i c_i μ_i/v_i and never passes
    /// it (Lazowska et al. 1984, §5.2 asymptotic bounds; Gross et al., §4.3). With one clear
    /// bottleneck the gap closes geometrically, so N = 400 is within 1e-9.
    #[test]
    fn throughput_rises_with_n_to_the_bottleneck_capacity() {
        let p = central(&[0.5, 0.4]);
        let stations = [(3.0, 1, false), (1.0, 2, false), (0.9, 1, false)];
        // c μ/v: 3, 2/0.5 = 4, 0.9/0.4 = 2.25 → the bound is 2.25, at S3.
        let bound = 2.25;
        let mut last = 0.0;
        for n in [1usize, 2, 3, 5, 8, 13, 21, 50, 100, 400] {
            let s = convolution(&model(&stations, p.clone(), n)).unwrap();
            assert!(s.throughput > last && s.throughput < bound + 1e-12, "X({n}) = {}", s.throughput);
            assert!(s.utilisation.iter().all(|u| u.unwrap() < 1.0 + 1e-12));
            last = s.throughput;
        }
        assert!((bound - last) / bound < 1e-9, "X(400) = {last}");
        let s = convolution(&model(&stations, p, 400)).unwrap();
        assert_eq!(s.bottleneck(), vec![2]);
        assert!(s.number[2] > 380.0, "the customers pile up at the bottleneck");
    }

    /// Large populations and wildly different loads stay finite and consistent (the scaling).
    #[test]
    fn large_populations_and_extreme_loads_do_not_overflow() {
        // A think station whose demand is 5000 times the server's, 10 000 customers.
        let m = model(&[(1.0 / 5000.0, 1, true), (1.0, 1, false), (40.0, 3, false)], cycle(3), 10_000);
        let s = convolution(&m).unwrap();
        assert!(s.throughput.is_finite() && s.throughput > 0.0 && s.throughput <= 1.0 + 1e-12 && s.ln_g.is_finite());
        assert!((s.number.iter().sum::<f64>() - 10_000.0).abs() < 1e-6);
        for row in &s.marginals {
            assert!(row.iter().all(|x| x.is_finite() && *x >= 0.0) && (row.iter().sum::<f64>() - 1.0).abs() < 1e-12);
        }
        let m1 = model(&[(1.0 / 5000.0, 1, true), (1.0, 1, false), (40.0, 1, false)], cycle(3), 10_000);
        let (c, gap) = solve(&m1).unwrap();
        assert!(gap.unwrap() < 1e-9, "gap {:?}", gap);
        assert!(c.throughput <= 1.0 + 1e-12);
        assert_eq!(convolution(&model(&[(1.0, 1, false); 2], cycle(2), 10_001)).unwrap_err(), ClosedError::PopulationOutOfRange(10_001));
    }

    // ── From a drawn network ────────────────────────────────────────────────────────────────────

    pub(crate) fn drawn(mu: &[f64], servers: &[i64], routes: &[(usize, usize, f64)], population: Option<i64>) -> Network {
        use crate::model::{Link, Node};
        let mut nodes = Vec::new();
        let mut links = Vec::new();
        let id = |kind: &str, i: usize| format!("{}0000000-0000-0000-0000-{:012}", kind, i);
        for (i, m) in mu.iter().enumerate() {
            let mut b = Node::new(id("B", i), NodeKind::Buffer, format!("B{}", i + 1), (0.0, 0.0));
            b.buffer_size = 10;
            let mut s = Node::new(id("A", i), NodeKind::Station, format!("S{}", i + 1), (0.0, 0.0));
            s.parameters = format!("rate={m}");
            s.servers = servers[i];
            links.push(Link { id: id("C", i), from: b.id.clone(), to: s.id.clone(), probability: 1.0, class: 0, to_class: None });
            nodes.push(b);
            nodes.push(s);
        }
        for (k, (from, to, p)) in routes.iter().enumerate() {
            links.push(Link { id: id("D", k), from: id("A", *from), to: id("B", *to), probability: *p, class: 0, to_class: None });
        }
        Network { nodes, links, infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population }
    }

    #[test]
    fn a_drawn_central_server_network_becomes_the_model_and_is_solved() {
        let net = drawn(&[4.0, 1.5, 0.5], &[1, 2, 1], &[(0, 0, 0.1), (0, 1, 0.6), (0, 2, 0.3), (1, 0, 1.0), (2, 0, 1.0)], Some(6));
        assert!(is_closed(&net));
        let m = from_network(&net).unwrap();
        assert_eq!((m.names.clone(), m.population, m.servers.clone()), (vec!["S1".to_string(), "S2".into(), "S3".into()], 6, vec![1, 2, 1]));
        assert_eq!(m.p, vec![vec![0.1, 0.6, 0.3], vec![1.0, 0.0, 0.0], vec![1.0, 0.0, 0.0]]);
        let s = convolution(&m).unwrap();
        let (g, marg, _) = enumerate(&m, &s.visits);
        assert!(close(s.ln_g, g.ln(), 1e-12) && (s.marginals[1][3] - marg[1][3]).abs() < 1e-13);
    }

    #[test]
    fn what_is_not_a_gordon_newell_network_is_refused_with_the_reason() {
        let ring = [(0usize, 1usize, 1.0), (1, 0, 1.0)];
        let base = || drawn(&[1.0, 2.0], &[1, 1], &ring, Some(3));
        assert!(from_network(&base()).is_ok());
        let mut n = base();
        n.population = None;
        assert_eq!(from_network(&n).unwrap_err(), ClosedError::PopulationMissing);
        assert!(looks_closed(&n) && !is_closed(&n));
        assert_eq!(drawn_as(&n), Drawn::ClosedNoPopulation);
        assert_eq!((drawn_as(&base()), drawn_as(&drawn(&[1.0], &[1], &[], None))), (Drawn::Closed, Drawn::Open), "a lone station is a network being started");
        let (reason, sentence) = open_only(&n, "Capacity planning").unwrap();
        assert_eq!(reason, "closedNoPopulation");
        assert_eq!(sentence, "The network has no source and no sink, but no number of customers is set. Set the population to make it a closed network. Capacity planning covers open networks, which have a source and a sink.");
        n.population = Some(0);
        assert_eq!(from_network(&n).unwrap_err(), ClosedError::PopulationOutOfRange(0));
        let mut n = base();
        n.nodes.push(crate::model::Node::new("E0000000-0000-0000-0000-000000000000", NodeKind::Sink, "Sink1", (0.0, 0.0)));
        assert_eq!(from_network(&n).unwrap_err(), ClosedError::NotClosed);
        let mut n = base();
        n.nodes[1].distribution = Distribution::Erlang;
        assert_eq!(from_network(&n).unwrap_err(), ClosedError::NotExponential(vec!["S1".into()]));
        let mut n = base();
        n.links[2].class = 1;
        assert_eq!(from_network(&n).unwrap_err(), ClosedError::MultiClass);
        let mut n = base();
        n.links[2].probability = 0.5;
        assert!(matches!(from_network(&n).unwrap_err(), ClosedError::RoutingLeaks(name, _) if name == "S1"));
        // Finite buffers: fine while every station can hold everyone (10 + 1 ≥ N), blocking beyond.
        let mut n = base();
        n.infinite_buffers = false;
        assert!(from_network(&n).is_ok());
        n.population = Some(12);
        assert_eq!(from_network(&n).unwrap_err(), ClosedError::BufferTooSmall("S1".into(), 11));
        let mut n = base();
        n.links.remove(0);
        assert_eq!(from_network(&n).unwrap_err(), ClosedError::StationMissingBuffer("S1".into()));
        for e in [ClosedError::Unreachable(vec!["S3".into()]), ClosedError::Reducible(vec!["S1".into(), "S3".into()]), ClosedError::PopulationOutOfRange(20_000), ClosedError::MultiClass] {
            assert!(e.message().ends_with('.'));
        }
    }
}
