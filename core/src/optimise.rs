//! Capacity planning for an open Jackson network (new in 2.1, ROADMAP D5): the cheapest numbers of
//! servers — or, for single-server stations, the cheapest service rates — that meet a target.
//!
//! **Servers.** The throughputs α do not depend on the numbers of servers, so station i's offered
//! load aᵢ = αᵢ/μᵢ is fixed and its mean number Lᵢ(cᵢ) = L(cᵢ, aᵢ) (`jackson::mmc`) depends on
//! its own servers only. Every target offered here reduces to one of two shapes:
//!
//! - a bound on one station (its utilisation aᵢ/cᵢ ≤ u, its mean wait Lqᵢ(cᵢ)/αᵢ ≤ w): both fall
//!   as cᵢ grows, so the bound is a smallest cᵢ — a lower limit, found by counting up;
//! - a bound on the network (mean number Σ Lᵢ ≤ N; mean delay W = Σ Lᵢ/Λ ≤ T by Little's law):
//!   a single separable constraint Σ Lᵢ(cᵢ) ≤ N* with N* the tightest of them.
//!
//! So the problem is: minimise Σ kᵢcᵢ subject to Σ Lᵢ(cᵢ) ≤ N*, loᵢ ≤ cᵢ ≤ hiᵢ — the classic
//! server-allocation problem. L(c, a) is decreasing and convex in c for c > a (Dyer & Proll 1977,
//! "On the validity of marginal analysis for allocating servers in M/M/c queues", Management
//! Science 23:1019–1022; Weber 1980, "On the marginal benefit of adding servers to G/GI/m queues",
//! Management Science 26:946–951). For a separable convex objective **marginal allocation** —
//! start at the lower limits, always add the server with the largest fall of L per unit of cost —
//! generates only efficient allocations (Fox 1966, "Discrete optimization via marginal analysis",
//! Management Science 13:210–216), and when every free station's server costs the same, the
//! allocation after n steps has the smallest Σ L of all allocations with n added servers, so the
//! first one that meets the target is a cheapest one: the greedy answer is optimal.
//!
//! With unequal costs the efficient allocations are the corners of the cost–congestion frontier
//! and the cheapest feasible allocation may lie between two of them (a knapsack effect), so the
//! greedy answer (then trimmed of every server it can lose) is only an upper bound. `plan`
//! therefore also runs an **exact search**: any allocation cheaper than the greedy one has
//! cᵢ ≤ loᵢ + (C_greedy − C_lo)/kᵢ, a finite box, searched depth-first with the cost and the
//! best-possible-congestion bounds. The search certifies the answer (or replaces it with a
//! cheaper one) when it finishes within `SEARCH_NODE_LIMIT` nodes; otherwise the greedy answer is
//! reported as good but not proven best. The tests hold greedy = exhaustive enumeration on random
//! networks for equal costs, and search = exhaustive enumeration for unequal ones.
//!
//! **Service rates.** For single-server stations with a linear cost Σ dᵢμᵢ and a bound
//! Σ αᵢ/(μᵢ − αᵢ) ≤ N the optimum is Kleinrock's square-root capacity assignment (Kleinrock,
//! *Queueing Systems, Volume 2: Computer Applications*, 1976, §5.7): by Lagrange's condition
//! dᵢ = β·αᵢ/(μᵢ − αᵢ)²,
//!
//!   μᵢ = αᵢ + √(αᵢ/dᵢ) · S/N,   S = Σⱼ √(αⱼdⱼ),   least cost = Σ dᵢαᵢ + S²/N.
//!
//! Each station first gets the rate it cannot do without (αᵢ) and the rest is shared in
//! proportion to √(αᵢ/dᵢ). Tested against Kleinrock's budget form (μᵢ = αᵢ + (D_e/dᵢ)·√(αᵢdᵢ)/S,
//! T = S²/(Λ·D_e) with D_e = D − Σ dᵢαᵢ) and against a numerical minimisation.
//!
//! Nothing here is a second copy of queueing arithmetic: every mean is `jackson::mmc`'s, summed in
//! station order as `jackson::solve` sums them, so the proposed allocation re-solved by `solve`
//! gives the same numbers to the last bit.

use crate::jackson::{self, mmc, JacksonError, JacksonModel};
use crate::model::{Network, NodeKind};
use crate::naming;
use crate::traffic;

/// The most depth-first nodes the exact search may visit before it gives up (a second or so).
pub const SEARCH_NODE_LIMIT: u64 = 2_000_000;
/// The most greedy steps taken (servers added) before the target is called out of reach.
pub const GREEDY_STEP_LIMIT: usize = 20_000;
/// How many more steps of the greedy path are kept after the target is met, for the trade-off curve.
pub const PATH_TAIL: usize = 6;
/// The most points of the greedy path kept for the curve (the first ones and the last are always kept).
pub const PATH_POINTS: usize = 240;

/// A target. Station indices are in export order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Constraint {
    /// Mean time from arrival to departure ≤ T.
    NetworkSojourn(f64),
    /// Mean number in the whole network ≤ N.
    NetworkNumber(f64),
    /// Every station's utilisation ≤ u (0 < u ≤ 1; a station is always kept below 1).
    Utilisation(f64),
    /// One station's mean wait before service ≤ w.
    StationWait(usize, f64),
}

impl Constraint {
    pub fn unit(self) -> &'static str {
        match self {
            Constraint::NetworkSojourn(_) | Constraint::StationWait(..) => "time",
            Constraint::NetworkNumber(_) => "customers",
            Constraint::Utilisation(_) => "ratio",
        }
    }

    pub fn target(self) -> f64 {
        match self {
            Constraint::NetworkSojourn(t) | Constraint::NetworkNumber(t) | Constraint::Utilisation(t) | Constraint::StationWait(_, t) => t,
        }
    }
}

/// The offered loads of a model and what the constraints are measured with.
#[derive(Clone, Debug, PartialEq)]
pub struct Loads {
    /// Throughput αᵢ and offered load aᵢ = αᵢ/μᵢ.
    pub alpha: Vec<f64>,
    pub a: Vec<f64>,
    /// Total external arrival rate Λ.
    pub total_arrivals: f64,
}

impl Loads {
    pub fn new(model: &JacksonModel) -> Result<Loads, JacksonError> {
        let alpha = jackson::throughputs(model).ok_or_else(|| JacksonError::Network("The routing returns every job to a station it has left, so no arrival rates can be computed.".into()))?;
        for i in 0..alpha.len() {
            if !(model.mu[i] > 0.0) || !(alpha[i] > 0.0) || !alpha[i].is_finite() {
                return Err(JacksonError::Unstable(model.names[i].clone(), 0.0));
            }
        }
        let a = alpha.iter().zip(&model.mu).map(|(x, mu)| x / mu).collect();
        Ok(Loads { alpha, a, total_arrivals: model.gamma.iter().sum() })
    }

    /// Mean number at station i with c servers; infinite when c servers cannot carry the load.
    pub fn number(&self, i: usize, c: i64) -> f64 {
        if (c as f64) > self.a[i] { mmc(c, self.a[i]).number } else { f64::INFINITY }
    }

    /// Mean wait before service at station i with c servers (Little's law: Lq/α).
    pub fn wait(&self, i: usize, c: i64) -> f64 {
        if (c as f64) > self.a[i] { mmc(c, self.a[i]).queue / self.alpha[i] } else { f64::INFINITY }
    }

    pub fn utilisation(&self, i: usize, c: i64) -> f64 {
        self.a[i] / c.max(1) as f64
    }

    /// Σ Lᵢ(cᵢ), summed in station order (as `JacksonSolution::network_number`).
    pub fn network_number(&self, c: &[i64]) -> f64 {
        (0..c.len()).map(|i| self.number(i, c[i])).sum()
    }

    /// The value a constraint bounds, at allocation `c`.
    pub fn value(&self, constraint: Constraint, c: &[i64]) -> f64 {
        match constraint {
            Constraint::NetworkNumber(_) => self.network_number(c),
            Constraint::NetworkSojourn(_) => self.network_number(c) / self.total_arrivals,
            Constraint::Utilisation(_) => (0..c.len()).map(|i| self.utilisation(i, c[i])).fold(0.0, f64::max),
            Constraint::StationWait(i, _) => self.wait(i, c[i]),
        }
    }

    pub fn meets(&self, constraint: Constraint, c: &[i64]) -> bool {
        (0..c.len()).all(|i| (c[i] as f64) > self.a[i]) && self.value(constraint, c) <= constraint.target()
    }

    /// The fewest servers with a steady state: ⌊a⌋ + 1.
    pub fn minimal_stable(&self, i: usize) -> i64 {
        self.a[i].floor() as i64 + 1
    }
}

/// What is asked. Every vector has one entry per station of `model`, in its order.
#[derive(Clone, Debug, PartialEq)]
pub struct Problem {
    /// The network as drawn (its numbers of servers are "now", and stay for a station that is not free).
    pub model: JacksonModel,
    pub constraints: Vec<Constraint>,
    /// Cost of one server at each station (positive).
    pub cost: Vec<f64>,
    /// Whether the station's number of servers may change.
    pub free: Vec<bool>,
    /// The fewest and the most servers a free station may have.
    pub lower: Vec<i64>,
    pub upper: Vec<Option<i64>>,
}

impl Problem {
    /// Every station free, one unit of cost per server, no limits.
    pub fn new(model: JacksonModel, constraints: Vec<Constraint>) -> Problem {
        let d = model.mu.len();
        Problem { model, constraints, cost: vec![1.0; d], free: vec![true; d], lower: vec![1; d], upper: vec![None; d] }
    }
}

/// Why no allocation meets the targets.
#[derive(Clone, Debug, PartialEq)]
pub enum Infeasible {
    /// A target that is not a positive finite number (or a utilisation above 1): the constraint's index.
    BadTarget(usize),
    /// A cost that is not positive and finite, or limits that cross: the station.
    BadStation(usize),
    /// A station that may not change is overloaded as drawn.
    FixedOverloaded(usize),
    /// A station's upper limit is below what it needs for a steady state.
    LimitOverloaded(usize),
    /// A bound on one station (`constraint`) cannot be met within that station's limits; `best` is
    /// the constraint's value at the most servers the station may have.
    StationLimit { constraint: usize, station: usize, best: f64 },
    /// The network bound (`constraint`) lies at or below the least the network can reach, `floor`
    /// (in the constraint's unit). `service_only`: no limit binds — the floor is the service
    /// itself (for a delay, the visit-weighted sum of service times Σ aᵢ/Λ), which no number of
    /// servers shortens. Otherwise the upper limits or the stations that may not change hold it up.
    Floor { constraint: usize, floor: f64, service_only: bool },
    /// More than `GREEDY_STEP_LIMIT` servers would be needed.
    TooMany,
}

/// A point of the greedy path: the allocation's cost and mean number in the network.
#[derive(Clone, Debug, PartialEq)]
pub struct PathPoint {
    pub cost: f64,
    pub number: f64,
    /// The station that got the server that led here (none for the starting point).
    pub added: Option<usize>,
    /// Whether every target is met here.
    pub feasible: bool,
}

/// How the answer is known to be a cheapest one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proof {
    /// Marginal allocation with equal costs (Fox 1966): optimal by theorem.
    Marginal,
    /// The exact search finished: no cheaper allocation exists.
    Search,
    /// Unequal costs and the search space was too large: good, not proven best.
    None,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    /// The proposed number of servers at each station.
    pub servers: Vec<i64>,
    /// Σ kᵢcᵢ over all stations, as drawn and as proposed.
    pub cost_now: f64,
    pub cost: f64,
    pub proof: Proof,
    /// Whether the exact search ran to its end, and how many nodes it visited.
    pub searched: bool,
    pub search_nodes: u64,
    /// The search found an allocation cheaper than the greedy one.
    pub improved: bool,
    /// The greedy path from the lower limits (thinned to `PATH_POINTS`).
    pub path: Vec<PathPoint>,
    /// The allocation the path starts from.
    pub start: Vec<i64>,
}

fn total_cost(cost: &[f64], c: &[i64]) -> f64 {
    c.iter().zip(cost).map(|(c, k)| *c as f64 * k).sum()
}

/// The lower and upper limits the search runs between: a station that is not free is held at its
/// number as drawn, a free one starts at the fewest servers that give a steady state and meet
/// every bound on that station alone.
pub fn limits(p: &Problem, loads: &Loads) -> Result<(Vec<i64>, Vec<Option<i64>>), Infeasible> {
    let d = p.model.mu.len();
    for (k, c) in p.constraints.iter().enumerate() {
        let t = c.target();
        let ok = t.is_finite() && t > 0.0 && !matches!(c, Constraint::Utilisation(u) if *u > 1.0) && !matches!(c, Constraint::StationWait(i, _) if *i >= d);
        if !ok {
            return Err(Infeasible::BadTarget(k));
        }
    }
    let mut lo = vec![1i64; d];
    let mut hi = vec![None; d];
    for i in 0..d {
        if !(p.cost[i] > 0.0) || !p.cost[i].is_finite() {
            return Err(Infeasible::BadStation(i));
        }
        let stable = loads.minimal_stable(i);
        if !p.free[i] {
            let now = p.model.servers[i].max(1);
            if now < stable {
                return Err(Infeasible::FixedOverloaded(i));
            }
            lo[i] = now;
            hi[i] = Some(now);
            continue;
        }
        if let Some(u) = p.upper[i] {
            if u < p.lower[i].max(1) {
                return Err(Infeasible::BadStation(i));
            }
            if u < stable {
                return Err(Infeasible::LimitOverloaded(i));
            }
        }
        lo[i] = p.lower[i].max(1).max(stable);
        hi[i] = p.upper[i];
    }
    // The bounds on single stations, each a smallest number of servers.
    for (k, c) in p.constraints.iter().enumerate() {
        let stations: Vec<usize> = match c {
            Constraint::Utilisation(_) => (0..d).collect(),
            Constraint::StationWait(i, _) => vec![*i],
            _ => continue,
        };
        for i in stations {
            let value = |n: i64| match c {
                Constraint::Utilisation(_) => loads.utilisation(i, n),
                _ => loads.wait(i, n),
            };
            let mut n = lo[i];
            // Utilisation: straight to ⌈a/u⌉, then the loop settles any rounding.
            if let Constraint::Utilisation(u) = c {
                n = n.max((loads.a[i] / u).ceil() as i64 - 1);
            }
            let mut steps = 0;
            while value(n) > c.target() {
                if hi[i].map_or(false, |h| n >= h) {
                    return Err(Infeasible::StationLimit { constraint: k, station: i, best: value(n) });
                }
                n += 1;
                steps += 1;
                if steps > GREEDY_STEP_LIMIT {
                    return Err(Infeasible::TooMany);
                }
            }
            lo[i] = n;
        }
    }
    Ok((lo, hi))
}

/// The network bounds of a problem, as (index, constraint).
fn network_bounds(p: &Problem) -> Vec<(usize, Constraint)> {
    p.constraints.iter().copied().enumerate().filter(|(_, c)| matches!(c, Constraint::NetworkNumber(_) | Constraint::NetworkSojourn(_))).collect()
}

/// The greedy (marginal-allocation) path from `lo`: at each step the server with the largest fall
/// of the mean number per unit of cost. Stops `tail` steps after every network bound is met (at
/// once with none), or when nothing can be added. Returns every point and the index of the first
/// feasible one.
pub fn greedy(loads: &Loads, cost: &[f64], lo: &[i64], hi: &[Option<i64>], bounds: &[Constraint], tail: usize) -> (Vec<(Vec<i64>, PathPoint)>, Option<usize>) {
    let d = lo.len();
    let mut c = lo.to_vec();
    let feasible = |c: &[i64]| bounds.iter().all(|b| loads.meets(*b, c));
    let mut out = vec![(c.clone(), PathPoint { cost: total_cost(cost, &c), number: loads.network_number(&c), added: None, feasible: feasible(&c) })];
    let mut first = out[0].1.feasible.then_some(0);
    let mut after = 0;
    while out.len() <= GREEDY_STEP_LIMIT {
        if first.is_some() {
            if after >= tail {
                break;
            }
            after += 1;
        }
        let mut best: Option<(usize, f64)> = None;
        for i in 0..d {
            if hi[i].map_or(false, |h| c[i] >= h) {
                continue;
            }
            let gain = (loads.number(i, c[i]) - loads.number(i, c[i] + 1)) / cost[i];
            if gain > 0.0 && best.map_or(true, |(_, g)| gain > g) {
                best = Some((i, gain));
            }
        }
        let Some((i, _)) = best else { break };
        c[i] += 1;
        let ok = feasible(&c);
        out.push((c.clone(), PathPoint { cost: total_cost(cost, &c), number: loads.network_number(&c), added: Some(i), feasible: ok }));
        if ok && first.is_none() {
            first = Some(out.len() - 1);
        }
    }
    (out, first)
}

/// Takes away every server the allocation can lose and still meet the bounds, the dearest first.
/// (After marginal allocation with equal costs there is none.)
fn trim(loads: &Loads, cost: &[f64], lo: &[i64], bounds: &[Constraint], c: &mut [i64]) {
    let mut order: Vec<usize> = (0..c.len()).collect();
    order.sort_by(|a, b| cost[*b].partial_cmp(&cost[*a]).unwrap_or(std::cmp::Ordering::Equal));
    loop {
        let mut changed = false;
        for &i in &order {
            while c[i] > lo[i] {
                c[i] -= 1;
                if bounds.iter().all(|b| loads.meets(*b, c)) {
                    changed = true;
                } else {
                    c[i] += 1;
                    break;
                }
            }
        }
        if !changed {
            break;
        }
    }
}

/// The exact search: a cheapest allocation between `lo` and `hi` that meets `bounds`, among those
/// that cost no more than `incumbent` (a feasible allocation). Ties in cost go to the smaller mean
/// number. None when more than `node_limit` nodes would be visited. Returns the allocation and
/// the nodes visited.
pub fn search(loads: &Loads, cost: &[f64], lo: &[i64], hi: &[Option<i64>], bounds: &[Constraint], incumbent: &[i64], node_limit: u64) -> Option<(Vec<i64>, u64)> {
    let d = lo.len();
    let c_lo = total_cost(cost, lo);
    let c_inc = total_cost(cost, incumbent);
    let slack = (c_inc - c_lo).max(0.0);
    // Costs are compared with a tolerance far below any cost difference a person types.
    let eps = 1e-9 * c_inc.abs().max(1.0);
    // The box: beyond `top[i]` the station alone costs more than the incumbent.
    let top: Vec<i64> = (0..d).map(|i| (lo[i] + ((slack + eps) / cost[i]).floor() as i64).min(hi[i].unwrap_or(i64::MAX)).max(lo[i])).collect();
    let table: Vec<Vec<f64>> = (0..d).map(|i| (lo[i]..=top[i]).map(|n| loads.number(i, n)).collect()).collect();
    // The least mean number stations i.. can still contribute.
    let mut least = vec![0.0; d + 1];
    for i in (0..d).rev() {
        least[i] = least[i + 1] + table[i].last().copied().unwrap_or(0.0);
    }
    // The tightest network bound as a mean number, for pruning only (feasibility itself is decided
    // by `meets`, on the sum in station order).
    let cap = bounds
        .iter()
        .map(|b| match b {
            Constraint::NetworkNumber(n) => *n,
            Constraint::NetworkSojourn(t) => t * loads.total_arrivals,
            _ => f64::INFINITY,
        })
        .fold(f64::INFINITY, f64::min);
    struct Ctx<'a> {
        loads: &'a Loads,
        cost: &'a [f64],
        lo: &'a [i64],
        top: &'a [i64],
        table: &'a [Vec<f64>],
        least: &'a [f64],
        bounds: &'a [Constraint],
        cap: f64,
        eps: f64,
        limit: u64,
        nodes: u64,
        best: Vec<i64>,
        best_cost: f64,
        best_number: f64,
        current: Vec<i64>,
    }
    fn go(x: &mut Ctx, i: usize, extra: f64, number: f64) -> bool {
        x.nodes += 1;
        if x.nodes > x.limit {
            return false;
        }
        if i == x.lo.len() {
            if x.bounds.iter().all(|b| x.loads.meets(*b, &x.current)) {
                let n = x.loads.network_number(&x.current);
                if extra < x.best_cost - x.eps || (extra <= x.best_cost + x.eps && n < x.best_number) {
                    x.best = x.current.clone();
                    x.best_cost = extra.min(x.best_cost);
                    x.best_number = n;
                }
            }
            return true;
        }
        for (k, n) in (x.lo[i]..=x.top[i]).enumerate() {
            let e = extra + k as f64 * x.cost[i];
            if e > x.best_cost + x.eps {
                break;
            }
            // Even with every later station at the top of its box the bound is missed: more here.
            if number + x.table[i][k] + x.least[i + 1] > x.cap * (1.0 + 1e-9) {
                continue;
            }
            x.current[i] = n;
            if !go(x, i + 1, e, number + x.table[i][k]) {
                return false;
            }
        }
        x.current[i] = x.lo[i];
        true
    }
    let mut x = Ctx { loads, cost, lo, top: &top, table: &table, least: &least, bounds, cap, eps, limit: node_limit, nodes: 0, best: incumbent.to_vec(), best_cost: slack, best_number: loads.network_number(incumbent), current: lo.to_vec() };
    go(&mut x, 0, 0.0, 0.0).then(|| (x.best.clone(), x.nodes))
}

/// The cheapest allocation that meets every target, or why there is none.
pub fn plan(p: &Problem) -> Result<Plan, Infeasible> {
    plan_with(p, SEARCH_NODE_LIMIT)
}

/// `plan` with the exact search bounded at `node_limit` nodes (0: greedy only).
pub fn plan_with(p: &Problem, node_limit: u64) -> Result<Plan, Infeasible> {
    let Ok(loads) = Loads::new(&p.model) else { return Err(Infeasible::BadStation(0)) };
    let d = p.model.mu.len();
    let (lo, hi) = limits(p, &loads)?;
    let network = network_bounds(p);
    let bounds: Vec<Constraint> = network.iter().map(|(_, c)| *c).collect();
    // The least the network can reach: every station at its upper limit (with none, Lᵢ → aᵢ).
    let floor_number: f64 = (0..d).map(|i| hi[i].map_or(loads.a[i], |h| loads.number(i, h))).sum();
    let unbounded = hi.iter().any(|h| h.is_none());
    for (k, c) in &network {
        let floor = if matches!(c, Constraint::NetworkSojourn(_)) { floor_number / loads.total_arrivals } else { floor_number };
        // With a station unlimited the floor is approached and never reached.
        if c.target() < floor || (unbounded && c.target() <= floor) {
            return Err(Infeasible::Floor { constraint: *k, floor, service_only: hi.iter().all(|h| h.is_none()) });
        }
    }
    let (path, first) = greedy(&loads, &p.cost, &lo, &hi, &bounds, PATH_TAIL);
    let Some(first) = first else {
        // Nothing more can be added (limits, or gains below rounding) and a bound is still missed.
        if path.len() > GREEDY_STEP_LIMIT {
            return Err(Infeasible::TooMany);
        }
        let (k, c) = network.iter().find(|(_, c)| !loads.meets(*c, &path[path.len() - 1].0)).copied().unwrap_or(network[0]);
        let floor = if matches!(c, Constraint::NetworkSojourn(_)) { floor_number / loads.total_arrivals } else { floor_number };
        return Err(Infeasible::Floor { constraint: k, floor, service_only: hi.iter().all(|h| h.is_none()) });
    };
    let mut servers = path[first].0.clone();
    trim(&loads, &p.cost, &lo, &bounds, &mut servers);
    let greedy_cost = total_cost(&p.cost, &servers);
    let free_costs: Vec<f64> = (0..d).filter(|i| hi[*i] != Some(lo[*i])).map(|i| p.cost[i]).collect();
    let equal = free_costs.windows(2).all(|w| w[0] == w[1]);
    let found = if node_limit > 0 { search(&loads, &p.cost, &lo, &hi, &bounds, &servers, node_limit) } else { None };
    let (searched, search_nodes) = (found.is_some(), found.as_ref().map_or(0, |f| f.1));
    let mut improved = false;
    if let Some((best, _)) = found {
        improved = total_cost(&p.cost, &best) < greedy_cost - 1e-9 * greedy_cost.abs().max(1.0);
        servers = best;
    }
    let proof = if equal { Proof::Marginal } else if searched { Proof::Search } else { Proof::None };
    let now: Vec<i64> = p.model.servers.iter().map(|c| (*c).max(1)).collect();
    Ok(Plan { cost_now: total_cost(&p.cost, &now), cost: total_cost(&p.cost, &servers), servers, proof, searched, search_nodes, improved, path: thin(path.iter().map(|x| x.1.clone()).collect(), first), start: lo })
}

/// At most `PATH_POINTS` points: the start, the first feasible point and the end always kept.
fn thin(path: Vec<PathPoint>, first: usize) -> Vec<PathPoint> {
    if path.len() <= PATH_POINTS {
        return path;
    }
    let step = path.len().div_ceil(PATH_POINTS - 2);
    let last = path.len() - 1;
    path.into_iter().enumerate().filter(|(i, _)| i % step == 0 || *i == first || *i == last).map(|(_, p)| p).collect()
}

// ── Service rates: the square-root rule ─────────────────────────────────────────────────────────

/// Kleinrock's square-root assignment: the service rates μᵢ > αᵢ that minimise Σ dᵢμᵢ subject to
/// Σ αᵢ/(μᵢ − αᵢ) ≤ `number` (single-server stations). None unless every α and d is positive and
/// the bound is.
pub fn square_root_rates(alpha: &[f64], d: &[f64], number: f64) -> Option<Vec<f64>> {
    let ok = |x: &f64| *x > 0.0 && x.is_finite();
    if alpha.is_empty() || alpha.len() != d.len() || !alpha.iter().all(ok) || !d.iter().all(ok) || !ok(&number) {
        return None;
    }
    let s: f64 = alpha.iter().zip(d).map(|(a, d)| (a * d).sqrt()).sum();
    Some(alpha.iter().zip(d).map(|(a, d)| a + (a / d).sqrt() * s / number).collect())
}

/// The same assignment for a budget: the rates that minimise Σ αᵢ/(μᵢ − αᵢ) subject to
/// Σ dᵢμᵢ = `budget` (Kleinrock's own form). None unless the budget exceeds Σ dᵢαᵢ.
pub fn square_root_rates_for_budget(alpha: &[f64], d: &[f64], budget: f64) -> Option<Vec<f64>> {
    let ok = |x: &f64| *x > 0.0 && x.is_finite();
    if alpha.is_empty() || alpha.len() != d.len() || !alpha.iter().all(ok) || !d.iter().all(ok) {
        return None;
    }
    let excess = budget - alpha.iter().zip(d).map(|(a, d)| a * d).sum::<f64>();
    if !(excess > 0.0) || !excess.is_finite() {
        return None;
    }
    let s: f64 = alpha.iter().zip(d).map(|(a, d)| (a * d).sqrt()).sum();
    Some(alpha.iter().zip(d).map(|(a, d)| a + (excess / d) * (a * d).sqrt() / s).collect())
}

/// Why the square-root rule gives no answer.
#[derive(Clone, Debug, PartialEq)]
pub enum RateInfeasible {
    BadTarget,
    /// A cost that is not positive and finite: the station.
    BadStation(usize),
    /// A free station has several servers: the closed form is for single-server stations.
    SeveralServers(usize),
    /// A station that may not change is overloaded as drawn.
    FixedOverloaded(usize),
    /// No station is free.
    NothingFree,
    /// The stations that may not change already hold `fixed` customers on average, at or above
    /// the bound (in the target's unit).
    FixedTooFull { fixed: f64 },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RatePlan {
    /// The proposed service rate at each station (unchanged where the station is not free).
    pub mu: Vec<f64>,
    /// Σ dᵢμᵢ over the free stations, as drawn and as proposed.
    pub cost_now: f64,
    pub cost: f64,
}

/// The cheapest service rates of the free (single-server) stations that bring the network's mean
/// number to `number` exactly (the bound is tight at the optimum). `rate_cost` is dᵢ.
pub fn plan_rates(model: &JacksonModel, number: f64, rate_cost: &[f64], free: &[bool]) -> Result<RatePlan, RateInfeasible> {
    let Ok(loads) = Loads::new(model) else { return Err(RateInfeasible::BadTarget) };
    if !(number > 0.0) || !number.is_finite() {
        return Err(RateInfeasible::BadTarget);
    }
    let d = model.mu.len();
    let mut fixed = 0.0;
    let mut idx = Vec::new();
    for i in 0..d {
        if free[i] {
            if !(rate_cost[i] > 0.0) || !rate_cost[i].is_finite() {
                return Err(RateInfeasible::BadStation(i));
            }
            if model.servers[i].max(1) != 1 {
                return Err(RateInfeasible::SeveralServers(i));
            }
            idx.push(i);
        } else {
            let c = model.servers[i].max(1);
            if !((c as f64) > loads.a[i]) {
                return Err(RateInfeasible::FixedOverloaded(i));
            }
            fixed += loads.number(i, c);
        }
    }
    if idx.is_empty() {
        return Err(RateInfeasible::NothingFree);
    }
    if !(number > fixed) {
        return Err(RateInfeasible::FixedTooFull { fixed });
    }
    let alpha: Vec<f64> = idx.iter().map(|i| loads.alpha[*i]).collect();
    let costs: Vec<f64> = idx.iter().map(|i| rate_cost[*i]).collect();
    let rates = square_root_rates(&alpha, &costs, number - fixed).ok_or(RateInfeasible::BadTarget)?;
    let mut mu = model.mu.clone();
    for (k, i) in idx.iter().enumerate() {
        mu[*i] = rates[k];
    }
    let cost = |mu: &[f64]| idx.iter().map(|i| rate_cost[*i] * mu[*i]).sum();
    Ok(RatePlan { cost_now: cost(&model.mu), cost: cost(&mu), mu })
}

// ── From a drawn network ────────────────────────────────────────────────────────────────────

/// The Jackson model of a drawn network for planning. Unlike `jackson::from_network` it also
/// answers for a network that is overloaded as drawn — the case capacity planning is for: the
/// throughputs do not depend on the numbers of servers, so the network is read with each
/// overloaded station given just enough servers for a steady state, and the model is handed back
/// with the numbers as drawn.
pub fn planning_model(net: &Network) -> Result<JacksonModel, JacksonError> {
    match jackson::from_network(net) {
        Err(JacksonError::Unstable(_, rho)) if rho >= 1.0 && net.infinite_buffers => {
            let data = traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).map_err(|e| JacksonError::Network(e.message()))?;
            let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
            let mut relieved = net.clone();
            let mut drawn = Vec::with_capacity(data.d);
            for i in 0..data.d {
                let c = stations[i].servers.max(1);
                drawn.push(stations[i].servers);
                let rho = data.rho(i);
                if rho.is_finite() && rho >= 1.0 {
                    let needed = (rho * c as f64).floor() as i64 + 1;
                    if let Some(n) = relieved.nodes.iter_mut().find(|n| n.id == stations[i].id) {
                        n.servers = needed;
                    }
                }
            }
            let mut model = jackson::from_network(&relieved)?;
            model.servers = drawn;
            Ok(model)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Distribution, Link, Node};

    fn model(gamma: &[f64], mu: &[f64], servers: &[i64]) -> JacksonModel {
        // Parallel stations: each has its own external arrivals and sends its jobs out.
        let d = mu.len();
        JacksonModel { ids: (0..d).map(|i| format!("id{i}")).collect(), names: (0..d).map(|i| format!("S{}", i + 1)).collect(), gamma: gamma.to_vec(), p: vec![vec![0.0; d]; d], mu: mu.to_vec(), servers: servers.to_vec() }
    }

    /// A tandem with feedback: γ into S1, S1 → S2, S2 → S1 with probability r, out otherwise:
    /// α₁ = α₂ = γ/(1 − r).
    fn feedback(gamma: f64, r: f64, mu: [f64; 2], servers: [i64; 2]) -> JacksonModel {
        let mut m = model(&[gamma, 0.0], &mu, &servers);
        m.p = vec![vec![0.0, 1.0], vec![r, 0.0]];
        m
    }

    /// A fixed-seed generator (Numerical Recipes' LCG): the tests draw the same networks every run.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }
        fn between(&mut self, a: f64, b: f64) -> f64 {
            a + (b - a) * self.next()
        }
    }

    /// Every allocation with lo ≤ c ≤ lo + span, the cheapest feasible one's cost (and its mean number).
    fn enumerate(loads: &Loads, cost: &[f64], lo: &[i64], span: i64, bounds: &[Constraint]) -> Option<(f64, f64, Vec<i64>)> {
        let d = lo.len();
        let mut c = lo.to_vec();
        let mut best: Option<(f64, f64, Vec<i64>)> = None;
        loop {
            if bounds.iter().all(|b| loads.meets(*b, &c)) {
                let (k, n) = (total_cost(cost, &c), loads.network_number(&c));
                if best.as_ref().map_or(true, |b| k < b.0 - 1e-9 || (k <= b.0 + 1e-9 && n < b.1)) {
                    best = Some((k, n, c.clone()));
                }
            }
            let mut i = 0;
            loop {
                if i == d {
                    return best;
                }
                if c[i] < lo[i] + span {
                    c[i] += 1;
                    break;
                }
                c[i] = lo[i];
                i += 1;
            }
        }
    }

    // ── The property the method rests on ────────────────────────────────────────────────────

    /// L(c, a) and Lq(c, a) fall and are convex in c for c > a (Dyer & Proll 1977; Weber 1980):
    /// L(c) > L(c+1) and L(c) − L(c+1) ≥ L(c+1) − L(c+2), over offered loads from 0.05 to 80
    /// (including whole numbers, where ⌊a⌋ + 1 = a + 1) and forty servers past the fewest. The
    /// tolerance, 1e-12 relative to L, is the rounding of two subtractions of numbers of size L;
    /// strict decrease is asserted while the queue is above 1e-9 (below that Lq is lost in a).
    #[test]
    fn the_mmc_mean_number_falls_and_is_convex_in_the_number_of_servers() {
        let mut loads = vec![0.05, 0.3, 0.5, 0.9, 0.99, 1.0, 1.5, 2.0, 2.999, 3.0, 4.2, 7.5, 10.0, 16.0, 25.3, 40.0, 79.99, 80.0];
        let mut rng = Rng(20261113);
        for _ in 0..200 {
            loads.push(rng.between(0.01, 60.0));
        }
        for a in loads {
            let c0 = a.floor() as i64 + 1;
            for c in c0..c0 + 40 {
                let (l0, l1, l2) = (mmc(c, a), mmc(c + 1, a), mmc(c + 2, a));
                let tol = 1e-12 * l0.number;
                assert!(l1.number <= l0.number && l1.queue <= l0.queue, "falls: a={a} c={c}");
                if l0.queue > 1e-9 {
                    assert!(l1.number < l0.number && l1.queue < l0.queue, "falls strictly: a={a} c={c}");
                }
                assert!((l0.number - l1.number) - (l1.number - l2.number) >= -tol, "L convex: a={a} c={c}: {} {} {}", l0.number, l1.number, l2.number);
                assert!((l0.queue - l1.queue) - (l1.queue - l2.queue) >= -tol, "Lq convex: a={a} c={c}");
                // And the floor: L → a from above.
                assert!(l0.number >= a, "floor: a={a} c={c}");
            }
        }
    }

    // ── Hand-worked answers ─────────────────────────────────────────────────────────────────

    /// One M/M/c queue, λ = 2, μ = 1 (a = 2). Erlang C (Gross et al., §2.3): C(3, 2) = 4/9 so
    /// Lq(3) = (4/9)(2/3)/(1/3) = 8/9 and W(3) = (2 + 8/9)/2 = 13/9 ≈ 1.444; C(4, 2) = 4/23 so
    /// Lq(4) = 4/23 and W(4) = (2 + 4/23)/2 = 25/23 ≈ 1.087. A delay target of 1.2 therefore needs
    /// 4 servers; 1.5 needs 3; the wait target Wq ≤ 0.1 needs 4 (Wq(3) = 4/9, Wq(4) = 2/23).
    #[test]
    fn one_station_gets_the_fewest_servers_that_meet_the_target() {
        let m = model(&[2.0], &[1.0], &[3]);
        let loads = Loads::new(&m).unwrap();
        assert!((loads.number(0, 3) - (2.0 + 8.0 / 9.0)).abs() < 1e-12);
        assert!((loads.number(0, 4) - (2.0 + 4.0 / 23.0)).abs() < 1e-12);
        assert!((loads.wait(0, 4) - 2.0 / 23.0).abs() < 1e-12);
        let servers = |c: Constraint| plan(&Problem::new(m.clone(), vec![c])).unwrap().servers;
        assert_eq!(servers(Constraint::NetworkSojourn(1.2)), [4]);
        assert_eq!(servers(Constraint::NetworkSojourn(1.5)), [3]);
        assert_eq!(servers(Constraint::NetworkSojourn(13.0 / 9.0 + 1e-12)), [3]);
        assert_eq!(servers(Constraint::NetworkNumber(2.2)), [4]);
        assert_eq!(servers(Constraint::StationWait(0, 0.1)), [4]);
        assert_eq!(servers(Constraint::StationWait(0, 0.5)), [3]);
        // Utilisation a/c ≤ u: c = ⌈a/u⌉ — 0.7 → 3 (0.667), 0.5 → 4, 0.45 → 5 (0.4), 1 → 3 (never 2: ρ < 1).
        assert_eq!(servers(Constraint::Utilisation(0.7)), [3]);
        assert_eq!(servers(Constraint::Utilisation(0.5)), [4]);
        assert_eq!(servers(Constraint::Utilisation(0.45)), [5]);
        assert_eq!(servers(Constraint::Utilisation(1.0)), [3]);
        let p = plan(&Problem::new(m.clone(), vec![Constraint::NetworkSojourn(1.2)])).unwrap();
        assert_eq!((p.cost_now, p.cost, p.proof, p.start.clone()), (3.0, 4.0, Proof::Marginal, vec![3]));
        // The path starts at the fewest stable servers and each point is one server more.
        assert_eq!(p.path[0], PathPoint { cost: 3.0, number: 2.0 + 8.0 / 9.0, added: None, feasible: false });
        assert!(p.path[1].feasible && p.path[1].added == Some(0) && p.path.len() == 2 + PATH_TAIL);
    }

    /// Two stations, several targets at once: each single-station bound is a lower limit, and the
    /// network bound is met from there. γ = (3, 1), μ = (1, 2): a = (3, 0.5).
    #[test]
    fn several_targets_are_met_together() {
        let m = model(&[3.0, 1.0], &[1.0, 2.0], &[4, 1]);
        let loads = Loads::new(&m).unwrap();
        let cs = vec![Constraint::Utilisation(0.6), Constraint::StationWait(1, 0.01), Constraint::NetworkSojourn(0.95)];
        let p = plan(&Problem::new(m.clone(), cs.clone())).unwrap();
        // Utilisation: c₁ ≥ 5 (3/5 = 0.6), c₂ ≥ 1. Wait at S2 ≤ 0.01: Wq(1) = 0.5, Wq(2) = 1/30, Wq(3) ≈ 0.0030 → c₂ ≥ 3.
        assert_eq!(p.start, [5, 3]);
        assert!(cs.iter().all(|c| loads.meets(*c, &p.servers)));
        assert_eq!(p.proof, Proof::Marginal);
        // Minimal: one server fewer anywhere breaks a target.
        for i in 0..2 {
            let mut c = p.servers.clone();
            c[i] -= 1;
            assert!(c[i] < 1 || !cs.iter().all(|k| loads.meets(*k, &c)), "station {i}");
        }
    }

    // ── Greedy against exhaustive enumeration ───────────────────────────────────────────────

    /// Marginal allocation is optimal when servers cost the same (Fox 1966): on 300 random
    /// networks of 2 to 4 stations (seed fixed), with a delay target between the floor and the
    /// start, the greedy answer costs exactly what the cheapest of *every* allocation in a box
    /// costs (the box reaches one server past the greedy answer's total at each station, so
    /// nothing cheaper lies outside it), with no search behind it (`plan_with(…, 0)`).
    #[test]
    fn greedy_is_the_exhaustive_optimum_when_costs_are_equal() {
        let mut rng = Rng(701);
        let mut compared = 0;
        for trial in 0..300 {
            let d = 2 + (rng.next() * 3.0) as usize;
            let gamma: Vec<f64> = (0..d).map(|_| rng.between(0.2, 4.0)).collect();
            let mu: Vec<f64> = (0..d).map(|_| rng.between(0.3, 3.0)).collect();
            let m = model(&gamma, &mu, &vec![1; d]);
            let loads = Loads::new(&m).unwrap();
            let lo: Vec<i64> = (0..d).map(|i| loads.minimal_stable(i)).collect();
            let floor: f64 = loads.a.iter().sum();
            let start = loads.network_number(&lo);
            let cap = floor + (start - floor) * rng.between(0.02, 0.9);
            let constraint = if trial % 2 == 0 { Constraint::NetworkNumber(cap) } else { Constraint::NetworkSojourn(cap / loads.total_arrivals) };
            let p = plan_with(&Problem::new(m.clone(), vec![constraint]), 0).unwrap();
            assert!(!p.searched && p.proof == Proof::Marginal);
            assert!(loads.meets(constraint, &p.servers), "trial {trial}");
            let added: i64 = p.servers.iter().zip(&lo).map(|(c, l)| c - l).sum();
            if (added + 2).pow(d as u32) > 200_000 {
                continue;
            }
            let (best, _, _) = enumerate(&loads, &vec![1.0; d], &lo, added + 1, &[constraint]).unwrap();
            assert_eq!(p.cost, best, "trial {trial}: greedy {:?}", p.servers);
            compared += 1;
        }
        assert!(compared > 250, "{compared} networks compared");
    }

    /// With unequal costs the cheapest allocation is found by the exact search: on 200 random
    /// networks its cost is the exhaustive optimum's over the same box, it never costs more than
    /// the greedy answer, and on some of them it is strictly cheaper (the knapsack effect the
    /// module describes — which is why greedy alone is not called proven there).
    #[test]
    fn the_exact_search_is_the_exhaustive_optimum_when_costs_differ() {
        let mut rng = Rng(702);
        let (mut compared, mut cheaper) = (0, 0);
        for trial in 0..200 {
            let d = 2 + (rng.next() * 3.0) as usize;
            let gamma: Vec<f64> = (0..d).map(|_| rng.between(0.2, 3.0)).collect();
            let mu: Vec<f64> = (0..d).map(|_| rng.between(0.3, 3.0)).collect();
            let cost: Vec<f64> = (0..d).map(|_| (1.0 + (rng.next() * 9.0).floor()) / 2.0).collect();
            let m = model(&gamma, &mu, &vec![1; d]);
            let loads = Loads::new(&m).unwrap();
            let lo: Vec<i64> = (0..d).map(|i| loads.minimal_stable(i)).collect();
            let floor: f64 = loads.a.iter().sum();
            let cap = floor + (loads.network_number(&lo) - floor) * rng.between(0.05, 0.9);
            let constraint = Constraint::NetworkNumber(cap);
            let problem = Problem { cost: cost.clone(), ..Problem::new(m.clone(), vec![constraint]) };
            let greedy_only = plan_with(&problem, 0).unwrap();
            let p = plan(&problem).unwrap();
            assert!(p.searched && loads.meets(constraint, &p.servers));
            assert!(p.cost <= greedy_only.cost + 1e-9, "trial {trial}");
            // Nothing cheaper than the greedy answer has more than this many extra servers anywhere.
            let slack = greedy_only.cost - total_cost(&cost, &lo);
            let span = cost.iter().map(|k| (slack / k).floor() as i64).max().unwrap() + 1;
            if (span + 1).pow(d as u32) > 300_000 {
                continue;
            }
            let (best, _, _) = enumerate(&loads, &cost, &lo, span, &[constraint]).unwrap();
            assert!((p.cost - best).abs() < 1e-9, "trial {trial}: search {} against {best}", p.cost);
            compared += 1;
            if p.improved {
                cheaper += 1;
                assert!(p.cost < greedy_only.cost);
            }
            let free_equal = cost.windows(2).all(|w| w[0] == w[1]);
            assert_eq!(p.proof, if free_equal { Proof::Marginal } else { Proof::Search });
            assert_eq!(greedy_only.proof, if free_equal { Proof::Marginal } else { Proof::None });
        }
        assert!(compared > 150 && cheaper > 0, "{compared} compared, {cheaper} improved by the search");
    }

    /// The search gives up, and says so, when its box is too large: the answer is then the greedy
    /// one, marked not proven.
    #[test]
    fn a_search_cut_short_leaves_the_greedy_answer_unproven() {
        let d = 8;
        let gamma: Vec<f64> = (0..d).map(|i| 5.0 + i as f64).collect();
        let cost: Vec<f64> = (0..d).map(|i| 1.0 + 0.37 * i as f64).collect();
        let m = model(&gamma, &vec![1.0; d], &vec![1; d]);
        let loads = Loads::new(&m).unwrap();
        let floor: f64 = loads.a.iter().sum();
        let problem = Problem { cost, ..Problem::new(m, vec![Constraint::NetworkNumber(floor * 1.0005)]) };
        let p = plan_with(&problem, 50).unwrap();
        assert_eq!((p.searched, p.proof, p.improved), (false, Proof::None, false));
        assert_eq!(p.servers, plan_with(&problem, 0).unwrap().servers);
    }

    // ── The proposed allocation, solved again ───────────────────────────────────────────────

    /// The proposed allocation re-solved by `jackson::solve` (the closed form every other view
    /// uses) gives the very numbers the plan was made with, meets the target, and is minimal:
    /// taking one server from any station breaks the target or the steady state. On a network
    /// with feedback (α₁ = α₂ = γ/(1 − r)) and on 100 random ones.
    #[test]
    fn the_plan_resolved_by_the_jackson_solver_meets_the_target_and_is_minimal() {
        let mut rng = Rng(703);
        let mut models = vec![feedback(1.2, 0.4, [1.0, 0.9], [3, 3])];
        for _ in 0..100 {
            let d = 1 + (rng.next() * 5.0) as usize;
            models.push(model(&(0..d).map(|_| rng.between(0.2, 6.0)).collect::<Vec<_>>(), &(0..d).map(|_| rng.between(0.3, 3.0)).collect::<Vec<_>>(), &vec![1; d]));
        }
        for (k, m) in models.into_iter().enumerate() {
            let loads = Loads::new(&m).unwrap();
            let lo: Vec<i64> = (0..m.mu.len()).map(|i| loads.minimal_stable(i)).collect();
            let floor: f64 = loads.a.iter().sum::<f64>() / loads.total_arrivals;
            let start = loads.network_number(&lo) / loads.total_arrivals;
            let target = floor + (start - floor) * rng.between(0.03, 0.8);
            let p = plan(&Problem::new(m.clone(), vec![Constraint::NetworkSojourn(target)])).unwrap();
            let mut solved = m.clone();
            solved.servers = p.servers.clone();
            let sol = jackson::solve(&solved).unwrap();
            assert!(sol.network_sojourn() <= target, "model {k}");
            assert_eq!(sol.network_sojourn(), loads.value(Constraint::NetworkSojourn(target), &p.servers), "model {k}: the same number, to the bit");
            for i in 0..m.mu.len() {
                let mut fewer = solved.clone();
                fewer.servers[i] -= 1;
                let broken = fewer.servers[i] < 1 || jackson::solve(&fewer).map_or(true, |s| s.network_sojourn() > target);
                assert!(broken, "model {k}: station {i} can lose a server");
            }
        }
    }

    // ── Targets that cannot be met ──────────────────────────────────────────────────────────

    /// The delay floor. With unlimited servers Lᵢ → aᵢ, so W → Σ aᵢ/Λ: the visit-weighted sum of
    /// service times. For the feedback network γ = 1.2, r = 0.4: α = 2 at both stations, service
    /// times 1 and 1/0.9, visits 2/1.2 each: floor = (2·1 + 2/0.9)/1.2 = 3.5185…. A target at or
    /// below it is refused with the floor; one just above it is met.
    #[test]
    fn a_delay_target_below_the_pure_service_time_is_infeasible() {
        let m = feedback(1.2, 0.4, [1.0, 0.9], [3, 3]);
        let floor = (2.0 + 2.0 / 0.9) / 1.2;
        for target in [1.0, floor * 0.999, floor] {
            match plan(&Problem::new(m.clone(), vec![Constraint::NetworkSojourn(target)])) {
                Err(Infeasible::Floor { constraint: 0, floor: f, service_only: true }) => assert!((f - floor).abs() < 1e-12, "{f}"),
                other => panic!("target {target}: {other:?}"),
            }
        }
        let p = plan(&Problem::new(m.clone(), vec![Constraint::NetworkSojourn(floor * 1.001)])).unwrap();
        assert!(Loads::new(&m).unwrap().meets(Constraint::NetworkSojourn(floor * 1.001), &p.servers));
        // The same for the mean number: floor Σ aᵢ = 2 + 2/0.9.
        assert!(matches!(plan(&Problem::new(m.clone(), vec![Constraint::NetworkNumber(4.0)])), Err(Infeasible::Floor { service_only: true, .. })));
    }

    #[test]
    fn limits_and_fixed_stations_are_respected_and_explained() {
        let m = model(&[2.0, 1.0], &[1.0, 1.0], &[3, 2]);
        let loads = Loads::new(&m).unwrap();
        let base = Problem::new(m.clone(), vec![Constraint::NetworkSojourn(1.35)]);
        // S1 may not change: only S2 moves.
        let p = plan(&Problem { free: vec![false, true], ..base.clone() }).unwrap();
        assert_eq!(p.servers[0], 3);
        assert_eq!(p.servers[1], 3);
        assert!(loads.meets(Constraint::NetworkSojourn(1.35), &p.servers));
        // With S1 held at 3 the least the network reaches is L₁(3) + a₂ = 2.889 + 1, a delay of 1.296: 1.25 cannot be met.
        match plan(&Problem { free: vec![false, true], constraints: vec![Constraint::NetworkSojourn(1.25)], ..base.clone() }) {
            Err(Infeasible::Floor { floor, service_only: false, .. }) => assert!((floor - (2.0 + 8.0 / 9.0 + 1.0) / 3.0).abs() < 1e-12),
            other => panic!("{other:?}"),
        }
        // Upper limits: at most 3 and 2 servers gives (2.889 + 1.333)/3 = 1.407 at best; reached exactly, it is feasible.
        let limited = Problem { upper: vec![Some(3), Some(2)], ..base.clone() };
        let best = (2.0 + 8.0 / 9.0 + 1.0 + 1.0 / 3.0) / 3.0;
        assert!(matches!(plan(&Problem { constraints: vec![Constraint::NetworkSojourn(1.4)], ..limited.clone() }), Err(Infeasible::Floor { service_only: false, .. })));
        assert_eq!(plan(&Problem { constraints: vec![Constraint::NetworkSojourn(best + 1e-12)], ..limited.clone() }).unwrap().servers, [3, 2]);
        // A lower limit above what the target needs is kept.
        assert_eq!(plan(&Problem { lower: vec![6, 1], constraints: vec![Constraint::NetworkSojourn(5.0)], ..base.clone() }).unwrap().servers, [6, 2]);
        // A station bound that its limit forbids; a fixed station that is overloaded; an upper limit below the load.
        assert!(matches!(plan(&Problem { upper: vec![Some(3), None], constraints: vec![Constraint::Utilisation(0.5)], ..base.clone() }), Err(Infeasible::StationLimit { constraint: 0, station: 0, .. })));
        let mut over = m.clone();
        over.servers = vec![2, 2];
        assert_eq!(plan(&Problem { free: vec![false, true], ..Problem::new(over.clone(), vec![Constraint::Utilisation(0.9)]) }), Err(Infeasible::FixedOverloaded(0)));
        assert_eq!(plan(&Problem { upper: vec![Some(2), None], ..base.clone() }), Err(Infeasible::LimitOverloaded(0)));
        // Bad input.
        assert_eq!(plan(&Problem { constraints: vec![Constraint::NetworkSojourn(0.0)], ..base.clone() }), Err(Infeasible::BadTarget(0)));
        assert_eq!(plan(&Problem { constraints: vec![Constraint::Utilisation(1.2)], ..base.clone() }), Err(Infeasible::BadTarget(0)));
        assert_eq!(plan(&Problem { cost: vec![1.0, 0.0], ..base.clone() }), Err(Infeasible::BadStation(1)));
        // An overloaded network as drawn is planned all the same (that is what planning is for).
        assert_eq!(plan(&Problem::new(over, vec![Constraint::Utilisation(0.9)])).unwrap().servers, [3, 2]);
    }

    // ── The square-root rule ────────────────────────────────────────────────────────────────

    /// Against Kleinrock's closed form (vol. 2, §5.7, eq. 5.26–5.27 in budget form): with budget D
    /// and D_e = D − Σ dᵢαᵢ, μᵢ = αᵢ + (D_e/dᵢ)·√(αᵢdᵢ)/Σ√(αⱼdⱼ) and T = (Σ√(αᵢdᵢ))²/(Λ·D_e).
    /// The target form is its dual: the rates for the mean number N cost D = Σ dᵢαᵢ + S²/N, and
    /// the budget form at that D gives the same rates back and exactly N. Worked numbers:
    /// α = (1, 4), d = (1, 1), N = 3: S = 3, μ = (1 + 1·3/3, 4 + 2·3/3) = (2, 6); L = 1 + 2 = 3.
    #[test]
    fn the_square_root_rule_is_kleinrocks_closed_form() {
        assert_eq!(square_root_rates(&[1.0, 4.0], &[1.0, 1.0], 3.0).unwrap(), [2.0, 6.0]);
        let mut rng = Rng(704);
        for _ in 0..200 {
            let d = 1 + (rng.next() * 6.0) as usize;
            let alpha: Vec<f64> = (0..d).map(|_| rng.between(0.1, 5.0)).collect();
            let cost: Vec<f64> = (0..d).map(|_| rng.between(0.2, 4.0)).collect();
            let n = rng.between(0.2, 20.0);
            let mu = square_root_rates(&alpha, &cost, n).unwrap();
            let number: f64 = alpha.iter().zip(&mu).map(|(a, m)| a / (m - a)).sum();
            assert!((number - n).abs() < 1e-10 * n, "the bound is tight: {number} against {n}");
            let s: f64 = alpha.iter().zip(&cost).map(|(a, k)| (a * k).sqrt()).sum();
            let spent: f64 = mu.iter().zip(&cost).map(|(m, k)| m * k).sum();
            let base: f64 = alpha.iter().zip(&cost).map(|(a, k)| a * k).sum();
            assert!((spent - (base + s * s / n)).abs() < 1e-10 * spent, "least cost Σdα + S²/N");
            // Kleinrock's budget form at that budget: the same rates, and T = S²/(Λ·D_e).
            let back = square_root_rates_for_budget(&alpha, &cost, spent).unwrap();
            for i in 0..d {
                assert!((back[i] - mu[i]).abs() < 1e-9 * mu[i], "station {i}: {} against {}", back[i], mu[i]);
                assert!((mu[i] - (alpha[i] + ((spent - base) / cost[i]) * (alpha[i] * cost[i]).sqrt() / s)).abs() < 1e-9 * mu[i]);
            }
            let lambda: f64 = alpha.iter().sum();
            assert!((number / lambda - s * s / (lambda * (spent - base))).abs() < 1e-9 * number / lambda);
        }
        assert!(square_root_rates(&[1.0], &[0.0], 1.0).is_none() && square_root_rates(&[1.0], &[1.0], 0.0).is_none());
        assert!(square_root_rates_for_budget(&[1.0, 2.0], &[1.0, 1.0], 3.0).is_none(), "a budget that only covers the load");
    }

    /// Against numerical minimisation, with no formula in it. On the constraint surface
    /// Σ Lᵢ = N write Lᵢ = sᵢN with shares sᵢ > 0 summing to 1; then μᵢ = αᵢ(1 + 1/Lᵢ) and the
    /// cost Σ dᵢμᵢ is convex in the shares, so nested golden-section searches (one share for two
    /// stations, two for three) find its minimum. The rule's cost must equal it to 1e-9 relative
    /// (golden section to an interval of 1e-12 leaves a cost error of about its square) and the
    /// rates to 1e-5 (the minimum is flat: a rate is located to the square root of that).
    #[test]
    fn the_square_root_rule_matches_a_numerical_minimisation() {
        fn golden(mut lo: f64, mut hi: f64, f: &dyn Fn(f64) -> f64) -> (f64, f64) {
            let g = (5f64.sqrt() - 1.0) / 2.0;
            let (mut x1, mut x2) = (hi - g * (hi - lo), lo + g * (hi - lo));
            let (mut f1, mut f2) = (f(x1), f(x2));
            for _ in 0..200 {
                if f1 < f2 {
                    hi = x2;
                    x2 = x1;
                    f2 = f1;
                    x1 = hi - g * (hi - lo);
                    f1 = f(x1);
                } else {
                    lo = x1;
                    x1 = x2;
                    f1 = f2;
                    x2 = lo + g * (hi - lo);
                    f2 = f(x2);
                }
            }
            let x = 0.5 * (lo + hi);
            (x, f(x))
        }
        let mut rng = Rng(705);
        for trial in 0..40 {
            let d = 2 + trial % 2;
            let alpha: Vec<f64> = (0..d).map(|_| rng.between(0.2, 4.0)).collect();
            let cost: Vec<f64> = (0..d).map(|_| rng.between(0.3, 3.0)).collect();
            let n = rng.between(0.5, 12.0);
            let spend = |shares: &[f64]| -> f64 { (0..d).map(|i| cost[i] * alpha[i] * (1.0 + 1.0 / (shares[i] * n))).sum() };
            let tiny = 1e-9;
            let (shares, least) = if d == 2 {
                let (s, f) = golden(tiny, 1.0 - tiny, &|s| spend(&[s, 1.0 - s]));
                (vec![s, 1.0 - s], f)
            } else {
                let inner = |s0: f64| golden(tiny, 1.0 - s0 - tiny, &|s1| spend(&[s0, s1, 1.0 - s0 - s1]));
                let (s0, f) = golden(tiny, 1.0 - 3.0 * tiny, &|s0| inner(s0).1);
                let s1 = inner(s0).0;
                (vec![s0, s1, 1.0 - s0 - s1], f)
            };
            let mu = square_root_rates(&alpha, &cost, n).unwrap();
            let ruled: f64 = mu.iter().zip(&cost).map(|(m, k)| m * k).sum();
            assert!((ruled - least).abs() < 1e-9 * least, "trial {trial}: rule {ruled}, minimiser {least}");
            assert!(ruled <= least * (1.0 + 1e-12), "the rule is never dearer than the minimiser");
            for i in 0..d {
                let numeric = alpha[i] * (1.0 + 1.0 / (shares[i] * n));
                assert!((mu[i] - numeric).abs() < 1e-5 * mu[i], "trial {trial} station {i}: {} against {numeric}", mu[i]);
            }
        }
    }

    /// `plan_rates` on a model: the proposed rates re-solved by `jackson::solve` give the target
    /// mean number (1e-10: one division per station), a station that is not free keeps its rate
    /// and its share of the customers is taken off the bound, and the cases with no answer say why.
    #[test]
    fn the_rate_plan_resolved_by_the_jackson_solver_reaches_the_target() {
        let m = feedback(1.2, 0.4, [3.0, 2.5], [1, 1]);
        let p = plan_rates(&m, 2.0, &[1.0, 2.0], &[true, true]).unwrap();
        let mut solved = m.clone();
        solved.mu = p.mu.clone();
        assert!((jackson::solve(&solved).unwrap().network_number() - 2.0).abs() < 1e-10);
        assert!((p.cost_now - (3.0 + 5.0)).abs() < 1e-12 && (p.cost - (p.mu[0] + 2.0 * p.mu[1])).abs() < 1e-12);
        // S2 held: it keeps L₂ = 2/(2.5 − 2) = 4 of the 6 allowed, S1 gets L₁ = 2: μ₁ = α(1 + 1/2) = 3.
        let q = plan_rates(&m, 6.0, &[1.0, 2.0], &[true, false]).unwrap();
        assert!((q.mu[0] - 3.0).abs() < 1e-12 && q.mu[1] == 2.5);
        assert!(matches!(plan_rates(&m, 4.0, &[1.0, 2.0], &[true, false]), Err(RateInfeasible::FixedTooFull { fixed }) if (fixed - 4.0).abs() < 1e-12));
        assert_eq!(plan_rates(&m, 2.0, &[1.0, 2.0], &[false, false]).map(|_| ()), Err(RateInfeasible::NothingFree));
        assert_eq!(plan_rates(&feedback(1.2, 0.4, [3.0, 2.5], [1, 2]), 2.0, &[1.0, 1.0], &[true, true]).map(|_| ()), Err(RateInfeasible::SeveralServers(1)));
        assert_eq!(plan_rates(&m, 2.0, &[1.0, -1.0], &[true, true]).map(|_| ()), Err(RateInfeasible::BadStation(1)));
        assert_eq!(plan_rates(&feedback(1.2, 0.4, [3.0, 1.5], [1, 1]), 2.0, &[1.0, 1.0], &[true, false]).map(|_| ()), Err(RateInfeasible::FixedOverloaded(1)));
    }

    // ── From a drawn network ────────────────────────────────────────────────────────────────

    fn drawn(lambda: f64, stations: &[(f64, i64)]) -> Network {
        let mut net = Network { nodes: Vec::new(), links: Vec::new(), infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None };
        let mut src = Node::new("Src1", NodeKind::Source, "Src1", (0.0, 0.0));
        src.distribution = Distribution::Poisson;
        src.parameters = format!("lambda={lambda}");
        net.nodes.push(src);
        let mut from = "Src1".to_string();
        for (k, (rate, servers)) in stations.iter().enumerate() {
            let name = format!("S{}", k + 1);
            let mut n = Node::new(&name, NodeKind::Station, &name, (0.0, 0.0));
            n.parameters = format!("rate={rate}");
            n.servers = *servers;
            net.nodes.push(n);
            net.nodes.push(Node::new(format!("B{name}"), NodeKind::Buffer, format!("B{name}"), (0.0, 0.0)));
            net.links.push(Link { id: format!("{from}>B{name}"), from: from.clone(), to: format!("B{name}"), probability: 1.0, class: 0, to_class: None });
            net.links.push(Link { id: format!("B{name}>{name}"), from: format!("B{name}"), to: name.clone(), probability: 1.0, class: 0, to_class: None });
            from = name;
        }
        net.nodes.push(Node::new("Out", NodeKind::Sink, "Out", (0.0, 0.0)));
        net.links.push(Link { id: format!("{from}>Out"), from, to: "Out".into(), probability: 1.0, class: 0, to_class: None });
        net
    }

    /// A stable network's planning model is `from_network`'s; an overloaded one, which
    /// `from_network` refuses, is read all the same, with the numbers of servers as drawn — and
    /// its throughputs and rates are those of the same network with servers enough.
    #[test]
    fn an_overloaded_network_still_has_a_planning_model() {
        let stable = drawn(2.0, &[(1.0, 3), (4.0, 1)]);
        assert_eq!(planning_model(&stable).unwrap(), jackson::from_network(&stable).unwrap());
        let over = drawn(2.0, &[(1.0, 2), (0.8, 1)]);
        assert!(matches!(jackson::from_network(&over), Err(JacksonError::Unstable(..))));
        let m = planning_model(&over).unwrap();
        assert_eq!(m.servers, [2, 1]);
        let reference = jackson::from_network(&drawn(2.0, &[(1.0, 3), (0.8, 3)])).unwrap();
        assert_eq!((m.gamma.clone(), m.p.clone(), m.mu.clone()), (reference.gamma, reference.p, reference.mu));
        // a = (2, 2.5): the fewest stable servers are (3, 3); ρ ≤ 0.8 needs (3, 4).
        assert_eq!(plan(&Problem::new(m, vec![Constraint::Utilisation(0.8)])).unwrap().servers, [3, 4]);
        // A network that is not Jackson is still refused.
        let mut erlang = drawn(1.0, &[(2.0, 1)]);
        erlang.nodes[1].distribution = Distribution::Erlang;
        erlang.nodes[1].parameters = "k=2,rate=4".into();
        assert!(matches!(planning_model(&erlang), Err(JacksonError::NotJackson)));
    }
}
