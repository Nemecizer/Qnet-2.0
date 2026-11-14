//! Sensitivity of an open Jackson network, in closed form (new in 2.1, ROADMAP D1): how a
//! measure moves when one parameter does, and what value of one parameter reaches a target.
//!
//! A parameter is a one-parameter family of Jackson models (`Family`): at value θ the external
//! rates are γ + (θ − θ₀)·dγ, the routing matrix is P + (θ − θ₀)·dP, and one station's service
//! rate or number of servers may be θ itself. For a continuous parameter the derivative is exact:
//!
//!   α = γ + Pᵀα            ⇒  (I − Pᵀ)·dα = dγ + dPᵀ·α        (differentiate the traffic equations)
//!   aᵢ = αᵢ/μᵢ             ⇒  daᵢ = dαᵢ/μᵢ − αᵢ·dμᵢ/μᵢ²
//!   Lᵢ = L(cᵢ, aᵢ) (M/M/c) ⇒  dLᵢ = L′(cᵢ, aᵢ)·daᵢ            (`jackson::mmc`, Erlang C differentiated)
//!   L = Σ Lᵢ,  W = L/Λ with Λ = Σ γᵢ (Little's law)  ⇒  dW = (dL·Λ − L·dΛ)/Λ²
//!
//! solved with the same elimination the traffic equations use. For one M/M/1 queue this is the
//! textbook dL/dλ = 1/(μ(1 − ρ)²), dL/dμ = −ρ/(μ(1 − ρ)²). The elasticity is (dM/dθ)·θ/M: the
//! percentage change of the measure per 1 % change of the parameter. A number of servers is a
//! whole number, so it has no derivative: its effect is the exact change from one more server.
//!
//! `invert` finds the value of one parameter at which the measure equals a target. The measure is
//! a closed formula in θ, so the equation is solved by bracketing and bisection to the last bit
//! and the result is re-evaluated there; when no value reaches the target the reason is given
//! (no effect, the end of the parameter's range, or overload first).
//!
//! Every formula is tested against a closed form or against central differences of the means
//! `tractability::assess` reports (the arithmetic 0.90.34 shipped), with the tolerance stated.

use crate::jackson::{self, mmc, JacksonError, JacksonModel, JacksonSolution};
use crate::model::{Network, NodeKind};
use crate::naming;
use crate::traffic;

/// What is measured. Station indices are in export order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Measure {
    /// Mean number of customers in the whole network.
    NetworkNumber,
    /// Mean time from arrival to departure.
    NetworkSojourn,
    StationNumber(usize),
    StationQueue(usize),
    StationSojourn(usize),
    StationUtilisation(usize),
    StationThroughput(usize),
}

impl Measure {
    /// The unit, as the result records name it.
    pub fn unit(self) -> &'static str {
        match self {
            Measure::NetworkNumber | Measure::StationNumber(_) | Measure::StationQueue(_) => "customers",
            Measure::NetworkSojourn | Measure::StationSojourn(_) => "time",
            Measure::StationUtilisation(_) => "ratio",
            Measure::StationThroughput(_) => "customers / time",
        }
    }

    pub fn value(self, sol: &JacksonSolution) -> f64 {
        match self {
            Measure::NetworkNumber => sol.network_number(),
            Measure::NetworkSojourn => sol.network_sojourn(),
            Measure::StationNumber(i) => sol.number[i],
            Measure::StationQueue(i) => sol.queue[i],
            Measure::StationSojourn(i) => sol.number[i] / sol.alpha[i],
            Measure::StationUtilisation(i) => sol.rho[i],
            Measure::StationThroughput(i) => sol.alpha[i],
        }
    }
}

/// One parameter: the models it sweeps through, and the values it may take.
#[derive(Clone, Debug, PartialEq)]
pub struct Family {
    /// Its value in the network as drawn.
    pub current: f64,
    /// A whole number (servers).
    pub integer: bool,
    /// The smallest value; `low_open` when the value itself is excluded (a rate must be positive).
    pub low: f64,
    pub low_open: bool,
    /// The largest value, when there is one (a probability's row sum).
    pub high: Option<f64>,
    /// dγ/dθ per station.
    pub d_gamma: Vec<f64>,
    /// dP/dθ as (from, to, weight).
    pub d_p: Vec<(usize, usize, f64)>,
    /// The station whose service rate is θ.
    pub service: Option<usize>,
    /// The station whose number of servers is θ.
    pub servers: Option<usize>,
}

impl Family {
    fn blank(d: usize, current: f64) -> Family {
        Family { current, integer: false, low: 0.0, low_open: true, high: None, d_gamma: vec![0.0; d], d_p: Vec::new(), service: None, servers: None }
    }

    /// External arrivals that grow by `d_gamma` per unit of θ (a source's rate: its share to each station).
    pub fn arrival(d_gamma: Vec<f64>, current: f64) -> Family {
        Family { d_gamma, ..Family::blank(0, current) }
    }

    /// Every external rate times θ (θ = 1 is the network as drawn).
    pub fn load(model: &JacksonModel) -> Family {
        Family::arrival(model.gamma.clone(), 1.0)
    }

    pub fn service(model: &JacksonModel, station: usize) -> Family {
        Family { service: Some(station), ..Family::blank(model.mu.len(), model.mu[station]) }
    }

    pub fn servers(model: &JacksonModel, station: usize) -> Family {
        Family { servers: Some(station), integer: true, low: 1.0, low_open: false, ..Family::blank(model.mu.len(), model.servers[station].max(1) as f64) }
    }

    /// A probability θ in [0, `row_sum`] whose change moves `d_gamma` and `d_p` (a sibling link takes the rest).
    pub fn routing(d_gamma: Vec<f64>, d_p: Vec<(usize, usize, f64)>, current: f64, row_sum: f64) -> Family {
        Family { current, integer: false, low: 0.0, low_open: false, high: Some(row_sum), d_gamma, d_p, service: None, servers: None }
    }

    /// True when no value of θ changes the model.
    pub fn is_inert(&self) -> bool {
        self.service.is_none() && self.servers.is_none() && self.d_gamma.iter().all(|x| *x == 0.0) && self.d_p.iter().all(|x| x.2 == 0.0)
    }

    /// Whether θ is a value the parameter can take.
    pub fn allows(&self, theta: f64) -> bool {
        theta.is_finite() && (if self.low_open { theta > self.low } else { theta >= self.low }) && self.high.map_or(true, |h| theta <= h) && (!self.integer || theta.fract() == 0.0)
    }

    /// The model at θ.
    pub fn at(&self, base: &JacksonModel, theta: f64) -> JacksonModel {
        let mut m = base.clone();
        let t = theta - self.current;
        for (g, dg) in m.gamma.iter_mut().zip(&self.d_gamma) {
            *g += t * dg;
        }
        for &(i, j, w) in &self.d_p {
            m.p[i][j] += t * w;
        }
        if let Some(j) = self.service {
            m.mu[j] = theta;
        }
        if let Some(j) = self.servers {
            m.servers[j] = theta.round() as i64;
        }
        m
    }
}

/// The measure at θ, or None where θ is not allowed or the network has no steady state there.
pub fn evaluate(base: &JacksonModel, measure: Measure, family: &Family, theta: f64) -> Option<f64> {
    if !family.allows(theta) {
        return None;
    }
    let model = family.at(base, theta);
    // A probability pushed below zero by rounding at the end of its range is zero.
    if model.gamma.iter().any(|g| *g < -1e-12) || model.p.iter().flatten().any(|x| *x < -1e-12) {
        return None;
    }
    let v = measure.value(&jackson::solve(&model).ok()?);
    v.is_finite().then_some(v)
}

/// dM/dθ at the network as drawn, exactly (see the module's derivation). For a continuous family.
pub fn derivative(model: &JacksonModel, sol: &JacksonSolution, measure: Measure, family: &Family) -> f64 {
    let d = model.mu.len();
    // (I − Pᵀ)·dα = dγ + dPᵀ·α
    let mut rhs = family.d_gamma.clone();
    rhs.resize(d, 0.0);
    for &(i, j, w) in &family.d_p {
        rhs[j] += w * sol.alpha[i];
    }
    let d_alpha = if rhs.iter().all(|x| *x == 0.0) { vec![0.0; d] } else { traffic::solve_traffic_equations(&model.p, &rhs, d).0 };
    let station = |i: usize| {
        let d_mu = if family.service == Some(i) { 1.0 } else { 0.0 };
        let da = d_alpha[i] / model.mu[i] - sol.alpha[i] * d_mu / (model.mu[i] * model.mu[i]);
        let m = mmc(model.servers[i].max(1), sol.alpha[i] / model.mu[i]);
        // (dL, dLq, dρ)
        (m.d_number * da, m.d_queue * da, da / model.servers[i].max(1) as f64)
    };
    match measure {
        Measure::NetworkNumber => (0..d).map(|i| station(i).0).sum(),
        Measure::NetworkSojourn => {
            let d_l: f64 = (0..d).map(|i| station(i).0).sum();
            let d_lambda: f64 = family.d_gamma.iter().sum();
            let lambda = sol.total_arrivals;
            (d_l * lambda - sol.network_number() * d_lambda) / (lambda * lambda)
        }
        Measure::StationNumber(i) => station(i).0,
        Measure::StationQueue(i) => station(i).1,
        Measure::StationSojourn(i) => (station(i).0 * sol.alpha[i] - sol.number[i] * d_alpha[i]) / (sol.alpha[i] * sol.alpha[i]),
        Measure::StationUtilisation(i) => station(i).2,
        Measure::StationThroughput(i) => d_alpha[i],
    }
}

/// How the measure answers one parameter.
#[derive(Clone, Debug, PartialEq)]
pub struct Sensitivity {
    /// dM/dθ (measure units per parameter unit); None for a whole-number parameter.
    pub derivative: Option<f64>,
    /// (dM/dθ)·θ/M: % change of the measure per 1 % change of the parameter. None for a whole
    /// number, or when the measure is zero.
    pub elasticity: Option<f64>,
    /// For a whole number: the measure with one more (None if that has no steady state).
    pub one_more: Option<f64>,
}

pub fn sensitivity(model: &JacksonModel, sol: &JacksonSolution, measure: Measure, family: &Family) -> Sensitivity {
    if family.integer {
        return Sensitivity { derivative: None, elasticity: None, one_more: evaluate(model, measure, family, family.current + 1.0) };
    }
    let dm = derivative(model, sol, measure, family);
    let value = measure.value(sol);
    Sensitivity { derivative: Some(dm), elasticity: (value != 0.0).then(|| dm * family.current / value), one_more: None }
}

/// Why no value of the parameter reaches the target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// The parameter does not move the measure at all.
    NoEffect,
    /// Even at the end of its range (`limit_value`) the measure only reaches `limit_measure`.
    RangeEnds,
    /// However far it is taken, the measure only approaches `limit_measure`.
    Levels,
    /// A station would be overloaded first; the last value with a steady state is `limit_value`.
    Overload,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Inversion {
    /// The parameter value, and the measure re-evaluated there (equal to the target for a
    /// continuous parameter; the first whole number at or past it for a count).
    Achieved { value: f64, measure: f64 },
    Infeasible { why: Why, limit_value: Option<f64>, limit_measure: Option<f64> },
}

/// The value of the family's parameter at which `measure` equals `target`, moving one way from
/// its current value (the way the derivative says helps).
pub fn invert(model: &JacksonModel, measure: Measure, family: &Family, target: f64) -> Inversion {
    let none = |why| Inversion::Infeasible { why, limit_value: None, limit_measure: None };
    let Ok(sol) = jackson::solve(model) else { return none(Why::Overload) };
    let m0 = measure.value(&sol);
    let t0 = family.current;
    if target == m0 {
        return Inversion::Achieved { value: t0, measure: m0 };
    }
    let up = target > m0;
    let eval = |t: f64| evaluate(model, measure, family, t);
    let reached = |m: f64| if up { m >= target } else { m <= target };

    if family.integer {
        let Some(m1) = eval(t0 + 1.0) else { return none(Why::NoEffect) };
        if m1 == m0 {
            return none(Why::NoEffect);
        }
        if (m1 > m0) == up {
            // More servers help: the first count that reaches the target.
            let mut last = m0;
            for k in 1..=10_000 {
                let t = t0 + k as f64;
                let Some(m) = eval(t) else { break };
                if reached(m) {
                    return Inversion::Achieved { value: t, measure: m };
                }
                if m == last {
                    break;
                }
                last = m;
            }
            return Inversion::Infeasible { why: Why::Levels, limit_value: None, limit_measure: Some(last) };
        }
        // Fewer servers help (the target raises the measure).
        let mut t = t0;
        let mut last = m0;
        while t - 1.0 >= family.low {
            t -= 1.0;
            match eval(t) {
                None => return Inversion::Infeasible { why: Why::Overload, limit_value: Some(t + 1.0), limit_measure: Some(last) },
                Some(m) if reached(m) => return Inversion::Achieved { value: t, measure: m },
                Some(m) => last = m,
            }
        }
        return Inversion::Infeasible { why: Why::RangeEnds, limit_value: Some(t), limit_measure: Some(last) };
    }

    let dm = derivative(model, &sol, measure, family);
    if family.is_inert() || dm == 0.0 || !dm.is_finite() {
        return none(Why::NoEffect);
    }
    let rising = (dm > 0.0) == up;
    // Points outward from the current value, each about twice as far as the one before.
    let points: Vec<f64> = if rising {
        match family.high {
            Some(h) => (0..=40).map(|k| if k == 40 { h } else { t0 + (h - t0) * 2f64.powi(k - 40) }).collect(),
            None => (1..=60).map(|k| t0 * 2f64.powi(k)).collect(),
        }
    } else if family.low_open {
        (1..=60).map(|k| family.low + (t0 - family.low) * 2f64.powi(-k)).collect()
    } else {
        (0..=40).map(|k| if k == 40 { family.low } else { t0 - (t0 - family.low) * 2f64.powi(k - 40) }).collect()
    };
    let crossed = |t: f64| eval(t).map_or(true, reached);
    let mut a = t0;
    let mut b = None;
    for &t in &points {
        if t == a {
            continue;
        }
        if crossed(t) {
            b = Some(t);
            break;
        }
        a = t;
    }
    let Some(mut b) = b else {
        let closed = if rising { family.high.is_some() } else { !family.low_open };
        return Inversion::Infeasible { why: if closed { Why::RangeEnds } else { Why::Levels }, limit_value: closed.then_some(a), limit_measure: eval(a) };
    };
    for _ in 0..200 {
        let mid = 0.5 * (a + b);
        if mid == a || mid == b {
            break;
        }
        if crossed(mid) {
            b = mid;
        } else {
            a = mid;
        }
    }
    match eval(b) {
        // The measure is continuous where it exists, so at the crossing it equals the target.
        Some(m) if (m - target).abs() <= 1e-9 * target.abs().max((m0 - target).abs()) => Inversion::Achieved { value: b, measure: m },
        _ => Inversion::Infeasible { why: Why::Overload, limit_value: Some(a), limit_measure: eval(a) },
    }
}

// ── From a drawn network ────────────────────────────────────────────────────────────────────

/// A parameter as the interface names it (src/sweeps/model.ts `SweepParameter`).
#[derive(Clone, Debug, PartialEq)]
pub enum ParamSpec {
    Load,
    /// A source's arrival rate.
    Arrival { node_id: String },
    /// A station's service rate, for one class where it has several.
    Service { node_id: String, class: Option<i64> },
    Servers { node_id: String },
    /// A link's probability; the link `complement_id` takes the rest.
    Routing { link_id: String, complement_id: String },
}

/// A Jackson network with what is needed to turn the interface's parameters into families.
#[derive(Clone, Debug)]
pub struct Context {
    pub model: JacksonModel,
    pub solution: JacksonSolution,
    /// Sources in export order: id, rate, and where each unit of rate goes (per station).
    sources: Vec<(String, f64, Vec<f64>)>,
    /// The one class that visits each station.
    owner: Vec<usize>,
}

impl Context {
    pub fn new(net: &Network) -> Result<Context, JacksonError> {
        let model = jackson::from_network(net)?;
        let solution = jackson::solve(&model)?;
        let data = traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).map_err(|e| JacksonError::Network(e.message()))?;
        let sources = naming::in_export_order(net.nodes_of(NodeKind::Source), |n| n.name.as_str())
            .iter()
            .enumerate()
            .map(|(k, s)| {
                // Never zero here: `traffic::compute` (inside `from_network` above) refuses a
                // source whose rate is not positive, so the share below is not 0/0 (test
                // `a_source_with_no_arrivals_is_refused_before_any_share_is_taken`).
                let rate = traffic::rate(s.distribution, &s.parameters);
                (s.id.clone(), rate, data.class_external_arrival_rates[k].iter().map(|x| x / rate).collect())
            })
            .collect();
        let owner = (0..data.d).map(|i| (0..data.k).find(|&k| data.alpha_per_class[k][i] > 1e-12).unwrap_or(0)).collect();
        Ok(Context { model, solution, sources, owner })
    }

    pub fn station(&self, node_id: &str) -> Option<usize> {
        self.model.ids.iter().position(|id| id == node_id)
    }

    /// The station a link into `node_id` delivers to: the node itself, or for a buffer the first
    /// station it feeds (the rule of `traffic::compute`).
    fn target(&self, net: &Network, node_id: &str) -> Option<usize> {
        let node = net.node(node_id)?;
        match node.kind {
            NodeKind::Station => self.station(node_id),
            NodeKind::Buffer => net.links.iter().filter(|l| l.from == node.id).find_map(|l| net.node(&l.to).filter(|t| t.kind == NodeKind::Station).and_then(|t| self.station(&t.id))),
            _ => None,
        }
    }

    /// The family of a parameter, or a sentence saying why it has none here.
    pub fn family(&self, net: &Network, spec: &ParamSpec) -> Result<Family, String> {
        let d = self.model.mu.len();
        match spec {
            ParamSpec::Load => Ok(Family::load(&self.model)),
            ParamSpec::Arrival { node_id } => {
                let (_, rate, share) = self.sources.iter().find(|s| &s.0 == node_id).ok_or("The source is no longer in the network.")?;
                Ok(Family::arrival(share.clone(), *rate))
            }
            ParamSpec::Service { node_id, class } => {
                let j = self.station(node_id).ok_or("The station is no longer in the network.")?;
                match class {
                    // A class that never reaches the station: its service rate changes nothing.
                    Some(c) if *c != self.owner[j] as i64 => Ok(Family::blank(d, traffic::service_rate_for_class(net.node(node_id).ok_or("The station is no longer in the network.")?, (*c).max(0) as usize))),
                    _ => Ok(Family::service(&self.model, j)),
                }
            }
            ParamSpec::Servers { node_id } => Ok(Family::servers(&self.model, self.station(node_id).ok_or("The station is no longer in the network.")?)),
            ParamSpec::Routing { link_id, complement_id } => {
                let find = |id: &str| net.links.iter().find(|l| l.id == id).ok_or("The link is no longer in the network.");
                let (link, other) = (find(link_id)?, find(complement_id)?);
                if link.from != other.from {
                    return Err("The two links no longer leave the same node.".into());
                }
                let row_sum = link.probability + other.probability;
                let (to, rest) = (self.target(net, &link.to), self.target(net, &other.to));
                let mut d_gamma = vec![0.0; d];
                let mut d_p = Vec::new();
                match net.node(&link.from).map(|n| n.kind) {
                    Some(NodeKind::Source) => {
                        let (_, rate, _) = self.sources.iter().find(|s| s.0 == link.from).ok_or("The source is no longer in the network.")?;
                        if let Some(t) = to {
                            d_gamma[t] += rate;
                        }
                        if let Some(t) = rest {
                            d_gamma[t] -= rate;
                        }
                    }
                    Some(NodeKind::Station) => {
                        let i = self.station(&link.from).ok_or("The station is no longer in the network.")?;
                        // Only the class that visits the station is routed there.
                        if link.class == self.owner[i] as i64 && other.class == link.class {
                            if let Some(t) = to {
                                d_p.push((i, t, 1.0));
                            }
                            if let Some(t) = rest {
                                d_p.push((i, t, -1.0));
                            }
                        }
                    }
                    _ => return Err("Only a probability on a link that leaves a source or a station is analysed.".into()),
                }
                Ok(Family::routing(d_gamma, d_p, link.probability, row_sum))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Distribution, Link, Node};
    use crate::tractability;

    // ── Networks ────────────────────────────────────────────────────────────────────────────

    struct Draw {
        net: Network,
    }

    impl Draw {
        fn new() -> Draw {
            Draw { net: Network { nodes: Vec::new(), links: Vec::new(), infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None } }
        }
        fn source(&mut self, name: &str, rate: f64) -> &mut Draw {
            let mut n = Node::new(name, NodeKind::Source, name, (0.0, 0.0));
            n.distribution = Distribution::Poisson;
            n.parameters = format!("lambda={rate}");
            self.net.nodes.push(n);
            self
        }
        /// A station `name` with its buffer "B<name>".
        fn station(&mut self, name: &str, rate: f64, servers: i64) -> &mut Draw {
            let mut n = Node::new(name, NodeKind::Station, name, (0.0, 0.0));
            n.parameters = format!("rate={rate}");
            n.servers = servers;
            self.net.nodes.push(n);
            self.net.nodes.push(Node::new(format!("B{name}"), NodeKind::Buffer, format!("B{name}"), (0.0, 0.0)));
            self.link(&format!("B{name}"), name, 1.0)
        }
        fn sink(&mut self) -> &mut Draw {
            self.net.nodes.push(Node::new("Out", NodeKind::Sink, "Out", (0.0, 0.0)));
            self
        }
        /// A link; one that ends at a station goes through its buffer.
        fn link(&mut self, from: &str, to: &str, p: f64) -> &mut Draw {
            let to = if to.starts_with('S') && !from.starts_with('B') { format!("B{to}") } else { to.to_string() };
            self.net.links.push(Link { id: format!("{from}>{to}"), from: from.into(), to, probability: p, class: 0, to_class: None });
            self
        }
    }

    /// One M/M/c queue: Src → S1 → Out.
    fn single(lambda: f64, mu: f64, servers: i64) -> Network {
        let mut d = Draw::new();
        d.source("Src1", lambda).station("S1", mu, servers).sink().link("Src1", "S1", 1.0).link("S1", "Out", 1.0);
        d.net
    }

    /// Three stations with feedback: Src → S1 → S2; S2 → S3 with probability q, back to S1 with
    /// 1 − q; S3 → Out. Throughputs α₁ = α₂ = γ/q, α₃ = γ.
    fn feedback(gamma: f64, q: f64, mu: [f64; 3]) -> Network {
        let mut d = Draw::new();
        d.source("Src1", gamma).station("S1", mu[0], 1).station("S2", mu[1], 1).station("S3", mu[2], 1).sink();
        d.link("Src1", "S1", 1.0).link("S1", "S2", 1.0).link("S2", "S3", q).link("S2", "S1", 1.0 - q).link("S3", "Out", 1.0);
        d.net
    }

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1e-300)
    }

    /// `Context::new` divides each source's external arrivals by its rate to get the share per
    /// unit of rate. A rate of zero would make that 0/0, but it cannot get there: the traffic
    /// equations refuse a source that sends nothing ("infinite mean"), alone or beside a source
    /// that is fine, and a missing or negative rate the same way. And every share that is taken
    /// is finite.
    #[test]
    fn a_source_with_no_arrivals_is_refused_before_any_share_is_taken() {
        for rate in [0.0, -1.0] {
            assert!(matches!(Context::new(&single(rate, 1.0, 1)), Err(JacksonError::Network(_))), "one source at {rate}");
            let mut d = Draw::new();
            d.source("Src1", 0.5).source("Src2", rate).station("S1", 1.0, 1).station("S2", 1.0, 1).sink();
            d.link("Src1", "S1", 1.0).link("S1", "Out", 1.0).link("S2", "Out", 1.0);
            d.net.links.push(Link { id: "Src2>BS2".into(), from: "Src2".into(), to: "BS2".into(), probability: 1.0, class: 1, to_class: None });
            d.net.links.push(Link { id: "S2>Out/1".into(), from: "S2".into(), to: "Out".into(), probability: 1.0, class: 1, to_class: None });
            match Context::new(&d.net) {
                Err(JacksonError::Network(sentence)) => assert!(sentence.contains("Src2"), "{sentence}"),
                other => panic!("a second source at {rate}: {:?}", other.map(|c| c.sources)),
            }
            // The same network with that source running is a Jackson network with finite shares.
            d.net.nodes.iter_mut().find(|n| n.id == "Src2").unwrap().parameters = "lambda=0.25".into();
            let ctx = Context::new(&d.net).unwrap();
            assert_eq!(ctx.sources.len(), 2);
            assert!(ctx.sources.iter().all(|(_, r, share)| *r > 0.0 && share.iter().all(|x| x.is_finite())));
            assert_eq!(ctx.sources[1].2, [0.0, 1.0]);
        }
    }

    // ── M/M/1 ───────────────────────────────────────────────────────────────────────────────

    /// M/M/1 with ρ = λ/μ (Gross et al., *Fundamentals of Queueing Theory*, §2.2: L = ρ/(1 − ρ),
    /// W = 1/(μ − λ), Lq = ρ²/(1 − ρ)). Differentiating: dL/dλ = 1/(μ(1 − ρ)²),
    /// dL/dμ = −ρ/(μ(1 − ρ)²), dW/dλ = 1/(μ − λ)², dW/dμ = −1/(μ − λ)², dρ/dλ = 1/μ,
    /// dLq/dλ = ρ(2 − ρ)/(μ(1 − ρ)²). Elasticities: of L in λ, 1/(1 − ρ); of W in μ, −μ/(μ − λ).
    /// Rounding only: 1e-12 relative.
    #[test]
    fn mm1_derivatives_are_the_textbook_ones() {
        for (lambda, mu) in [(0.5, 1.0), (0.9, 1.0), (3.0, 4.0), (0.02, 7.0), (9.99, 10.0)] {
            let net = single(lambda, mu, 1);
            let ctx = Context::new(&net).unwrap();
            let rho: f64 = lambda / mu;
            let arrival = ctx.family(&net, &ParamSpec::Arrival { node_id: "Src1".into() }).unwrap();
            let service = ctx.family(&net, &ParamSpec::Service { node_id: "S1".into(), class: None }).unwrap();
            assert_eq!((arrival.current, service.current), (lambda, mu));
            let d = |m, f: &Family| derivative(&ctx.model, &ctx.solution, m, f);
            assert!(close(d(Measure::NetworkNumber, &arrival), 1.0 / (mu * (1.0 - rho).powi(2)), 1e-12));
            assert!(close(d(Measure::NetworkNumber, &service), -rho / (mu * (1.0 - rho).powi(2)), 1e-12));
            assert!(close(d(Measure::NetworkSojourn, &arrival), 1.0 / (mu - lambda).powi(2), 1e-10));
            assert!(close(d(Measure::NetworkSojourn, &service), -1.0 / (mu - lambda).powi(2), 1e-10));
            assert!(close(d(Measure::StationSojourn(0), &service), -1.0 / (mu - lambda).powi(2), 1e-10));
            assert!(close(d(Measure::StationUtilisation(0), &arrival), 1.0 / mu, 1e-12));
            assert!(close(d(Measure::StationUtilisation(0), &service), -rho / mu, 1e-12));
            assert!(close(d(Measure::StationQueue(0), &arrival), rho * (2.0 - rho) / (mu * (1.0 - rho).powi(2)), 1e-11));
            assert!(close(d(Measure::StationThroughput(0), &arrival), 1.0, 1e-12));
            assert_eq!(d(Measure::StationThroughput(0), &service), 0.0);
            let s = sensitivity(&ctx.model, &ctx.solution, Measure::NetworkNumber, &arrival);
            assert!(close(s.elasticity.unwrap(), 1.0 / (1.0 - rho), 1e-12));
            let s = sensitivity(&ctx.model, &ctx.solution, Measure::NetworkSojourn, &service);
            assert!(close(s.elasticity.unwrap(), -mu / (mu - lambda), 1e-10));
            // The load factor moves the one source: its elasticity is the arrival rate's.
            let load = ctx.family(&net, &ParamSpec::Load).unwrap();
            assert!(close(sensitivity(&ctx.model, &ctx.solution, Measure::NetworkNumber, &load).elasticity.unwrap(), 1.0 / (1.0 - rho), 1e-12));
        }
    }

    // ── M/M/c ───────────────────────────────────────────────────────────────────────────────

    /// M/M/c through the whole route (network → model → derivative) against a five-point central
    /// difference of the mean `tractability::assess` reports for the network with λ or μ moved —
    /// 0.90.34's own Erlang C. Step 10⁻³ of the distance to the nearer of 0 and overload:
    /// truncation O(h⁴), rounding about 10⁻¹³; agreement to 1e-7 relative is asked (seen: 1e-9).
    #[test]
    fn mmc_derivatives_match_differences_of_the_shipped_erlang_c() {
        let shipped = |lambda: f64, mu: f64, c: i64| {
            let net = single(lambda, mu, c);
            let data = traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
            let a = tractability::assess(&data, &net.nodes, true, false);
            assert_eq!(a.kind, tractability::Kind::ExactJackson);
            a.means[0]
        };
        let five = |f: &dyn Fn(f64) -> f64, x: f64, h: f64| (-f(x + 2.0 * h) + 8.0 * f(x + h) - 8.0 * f(x - h) + f(x - 2.0 * h)) / (12.0 * h);
        for c in [1i64, 2, 3, 4, 7, 12, 30] {
            for rho in [0.2, 0.6, 0.85, 0.97] {
                let mu = 1.3;
                let lambda = rho * c as f64 * mu;
                let net = single(lambda, mu, c);
                let ctx = Context::new(&net).unwrap();
                // The mean itself is the shipped one.
                assert!(close(ctx.solution.number[0], shipped(lambda, mu, c), 1e-12), "c = {c}, ρ = {rho}");
                let h = 1e-3 * rho.min(1.0 - rho);
                let arrival = ctx.family(&net, &ParamSpec::Arrival { node_id: "Src1".into() }).unwrap();
                let an = derivative(&ctx.model, &ctx.solution, Measure::NetworkNumber, &arrival);
                let fd = five(&|x| shipped(x, mu, c), lambda, h * lambda);
                assert!(close(an, fd, 1e-7), "dL/dλ, c = {c}, ρ = {rho}: {an} against {fd}");
                let service = ctx.family(&net, &ParamSpec::Service { node_id: "S1".into(), class: None }).unwrap();
                let an = derivative(&ctx.model, &ctx.solution, Measure::NetworkNumber, &service);
                let fd = five(&|x| shipped(lambda, x, c), mu, h * mu);
                assert!(close(an, fd, 1e-7), "dL/dμ, c = {c}, ρ = {rho}: {an} against {fd}");
            }
        }
    }

    /// One more server is a difference, not a derivative: M/M/1 → M/M/2 at a = 0.8 takes L from
    /// a/(1 − a) = 4 to 2ρ/(1 − ρ²) with ρ = 0.4, which is 0.8/0.84 = 0.95238….
    #[test]
    fn one_more_server_is_the_exact_difference() {
        let net = single(0.8, 1.0, 1);
        let ctx = Context::new(&net).unwrap();
        let servers = ctx.family(&net, &ParamSpec::Servers { node_id: "S1".into() }).unwrap();
        let s = sensitivity(&ctx.model, &ctx.solution, Measure::NetworkNumber, &servers);
        assert_eq!((s.derivative, s.elasticity), (None, None));
        assert!(close(ctx.solution.number[0], 4.0, 1e-12));
        assert!(close(s.one_more.unwrap(), 0.8 / 0.84, 1e-12));
    }

    // ── A Jackson network with feedback ─────────────────────────────────────────────────────

    /// The three-station network with feedback has α₁ = α₂ = γ/q, α₃ = γ, so with ρᵢ = αᵢ/μᵢ and
    /// L = Σ ρᵢ/(1 − ρᵢ) (Jackson 1957; Gross et al. §4.2):
    ///   dL/dγ = Σᵢ (ρᵢ/γ)/(1 − ρᵢ)²,   dL/dq = −Σ_{i=1,2} (ρᵢ/q)/(1 − ρᵢ)²,
    ///   dα₁/dq = −γ/q²,   and W = L/γ.
    /// Rounding only (a 3 × 3 elimination): 1e-11 relative.
    #[test]
    fn a_three_station_network_with_feedback_matches_its_closed_form() {
        let (gamma, q, mu) = (1.0, 0.6, [2.5, 3.0, 1.6]);
        let net = feedback(gamma, q, mu);
        let ctx = Context::new(&net).unwrap();
        let rho = [gamma / q / mu[0], gamma / q / mu[1], gamma / mu[2]];
        for i in 0..3 {
            assert!(close(ctx.solution.rho[i], rho[i], 1e-13));
        }
        let l: f64 = rho.iter().map(|r| r / (1.0 - r)).sum();
        assert!(close(ctx.solution.network_number(), l, 1e-12));
        let arrival = ctx.family(&net, &ParamSpec::Arrival { node_id: "Src1".into() }).unwrap();
        let routing = ctx.family(&net, &ParamSpec::Routing { link_id: "S2>BS3".into(), complement_id: "S2>BS1".into() }).unwrap();
        assert_eq!((routing.current, routing.high), (q, Some(1.0)));
        let d = |m, f: &Family| derivative(&ctx.model, &ctx.solution, m, f);
        let dl_dgamma: f64 = rho.iter().map(|r| (r / gamma) / (1.0 - r).powi(2)).sum();
        let dl_dq: f64 = -rho[..2].iter().map(|r| (r / q) / (1.0 - r).powi(2)).sum::<f64>();
        assert!(close(d(Measure::NetworkNumber, &arrival), dl_dgamma, 1e-11));
        assert!(close(d(Measure::NetworkNumber, &routing), dl_dq, 1e-11));
        assert!(close(d(Measure::StationThroughput(0), &routing), -gamma / (q * q), 1e-11));
        assert!(d(Measure::StationThroughput(2), &routing).abs() < 1e-12);
        assert!(close(d(Measure::NetworkSojourn, &routing), dl_dq / gamma, 1e-11));
        assert!(close(d(Measure::NetworkSojourn, &arrival), (dl_dgamma * gamma - l) / (gamma * gamma), 1e-10));
        // The complement link is the same parameter seen from the other side.
        let back = ctx.family(&net, &ParamSpec::Routing { link_id: "S2>BS1".into(), complement_id: "S2>BS3".into() }).unwrap();
        assert!(close(d(Measure::NetworkNumber, &back), -dl_dq, 1e-11));
        // Service at S3 touches S3 alone: dL/dμ₃ = −ρ₃/(μ₃(1 − ρ₃)²).
        let service = ctx.family(&net, &ParamSpec::Service { node_id: "S3".into(), class: None }).unwrap();
        assert!(close(d(Measure::NetworkNumber, &service), -rho[2] / (mu[2] * (1.0 - rho[2]).powi(2)), 1e-12));
    }

    // ── The two routes agree ────────────────────────────────────────────────────────────────

    fn with_rate(net: &Network, node: &str, key: &str, value: f64) -> Network {
        let mut n = net.clone();
        n.nodes.iter_mut().find(|x| x.id == node).unwrap().parameters = format!("{key}={value}");
        n
    }

    fn with_routing(net: &Network, link: &str, other: &str, value: f64) -> Network {
        let mut n = net.clone();
        let sum: f64 = n.links.iter().filter(|l| l.id == link || l.id == other).map(|l| l.probability).sum();
        n.links.iter_mut().find(|l| l.id == link).unwrap().probability = value;
        n.links.iter_mut().find(|l| l.id == other).unwrap().probability = sum - value;
        n
    }

    /// Σ of the means `assess` reports: the network redrawn and analysed by the shipped arithmetic.
    fn shipped_number(net: &Network) -> f64 {
        let data = traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
        let a = tractability::assess(&data, &net.nodes, true, false);
        assert_eq!(a.kind, tractability::Kind::ExactJackson);
        a.means.iter().sum()
    }

    /// The analytic route against the finite-difference route on one network: a multi-server
    /// Jackson network with feedback and a split of the arrivals, every parameter. The difference
    /// route redraws the network at θ(1 ± h), h = 10⁻⁵, and reads the shipped closed form; its
    /// truncation error is O(h²) ≈ 10⁻¹⁰ and its rounding error about 10⁻¹¹, so the two must
    /// agree to 1e-6 relative (seen: 1e-8 or better). This is also what checks that each
    /// parameter is mapped to the right entries of γ and P.
    #[test]
    fn the_analytic_route_agrees_with_finite_differences_of_the_redrawn_network() {
        let mut dr = Draw::new();
        dr.source("Src1", 1.2).station("S1", 1.1, 2).station("S2", 2.4, 1).station("S3", 0.9, 3).sink();
        dr.link("Src1", "S1", 0.7).link("Src1", "S2", 0.3);
        dr.link("S1", "S2", 0.5).link("S1", "S3", 0.5).link("S2", "S1", 0.2).link("S2", "Out", 0.8).link("S3", "Out", 0.75).link("S3", "S2", 0.25);
        let net = dr.net;
        let ctx = Context::new(&net).unwrap();
        assert!(close(ctx.solution.network_number(), shipped_number(&net), 1e-12));
        let h = 1e-5;
        let check = |name: &str, spec: ParamSpec, redraw: &dyn Fn(f64) -> Network| {
            let family = ctx.family(&net, &spec).unwrap();
            let t = family.current;
            let fd = (shipped_number(&redraw(t * (1.0 + h))) - shipped_number(&redraw(t * (1.0 - h)))) / (2.0 * h * t);
            let an = derivative(&ctx.model, &ctx.solution, Measure::NetworkNumber, &family);
            assert!(an != 0.0 && close(an, fd, 1e-6), "{name}: analytic {an}, difference {fd}");
            // …and the family's own model at a moved value is the redrawn network's.
            let moved = evaluate(&ctx.model, Measure::NetworkNumber, &family, t * 1.01).unwrap();
            assert!(close(moved, shipped_number(&redraw(t * 1.01)), 1e-11), "{name} at 1.01 θ");
        };
        check("λ at Src1", ParamSpec::Arrival { node_id: "Src1".into() }, &|x| with_rate(&net, "Src1", "lambda", x));
        for s in ["S1", "S2", "S3"] {
            check(&format!("μ at {s}"), ParamSpec::Service { node_id: s.into(), class: None }, &|x| with_rate(&net, s, "rate", x));
        }
        for (link, other) in [("Src1>BS1", "Src1>BS2"), ("S1>BS2", "S1>BS3"), ("S2>BS1", "S2>Out"), ("S3>Out", "S3>BS2"), ("S3>BS2", "S3>Out")] {
            check(&format!("p on {link}"), ParamSpec::Routing { link_id: link.into(), complement_id: other.into() }, &|x| with_routing(&net, link, other, x));
        }
        check("load", ParamSpec::Load, &|x| with_rate(&net, "Src1", "lambda", 1.2 * x));
        // One more server at each station: the exact difference, against the redrawn network.
        for (i, s) in ["S1", "S2", "S3"].iter().enumerate() {
            let family = ctx.family(&net, &ParamSpec::Servers { node_id: (*s).into() }).unwrap();
            let mut more = net.clone();
            more.nodes.iter_mut().find(|n| n.id == *s).unwrap().servers += 1;
            let got = sensitivity(&ctx.model, &ctx.solution, Measure::NetworkNumber, &family).one_more.unwrap();
            assert!(close(got, shipped_number(&more), 1e-12), "servers at {s} ({i})");
        }
    }

    // ── What would it take ──────────────────────────────────────────────────────────────────

    /// M/M/1, W = 1/(μ − λ). Cutting W by 10 % means μ − λ grows by the factor 1/0.9:
    /// μ* = λ + (μ − λ)/0.9, or λ* = μ − (μ − λ)/0.9. Bisection to the last bit: 1e-12 relative.
    /// The answer is then verified by solving the network again at the proposed value.
    #[test]
    fn mm1_inversion_is_the_closed_form_and_resolves_to_the_target() {
        let (lambda, mu) = (0.8, 1.0);
        let net = single(lambda, mu, 1);
        let ctx = Context::new(&net).unwrap();
        let target = 0.9 * ctx.solution.network_sojourn();
        let service = ctx.family(&net, &ParamSpec::Service { node_id: "S1".into(), class: None }).unwrap();
        let Inversion::Achieved { value, measure } = invert(&ctx.model, Measure::NetworkSojourn, &service, target) else { panic!() };
        assert!(close(value, lambda + (mu - lambda) / 0.9, 1e-12), "{value}");
        assert!(close(measure, target, 1e-9));
        let again = Context::new(&single(lambda, value, 1)).unwrap();
        assert!(close(again.solution.network_sojourn(), target, 1e-10));

        let arrival = ctx.family(&net, &ParamSpec::Arrival { node_id: "Src1".into() }).unwrap();
        let Inversion::Achieved { value, .. } = invert(&ctx.model, Measure::NetworkSojourn, &arrival, target) else { panic!() };
        assert!(close(value, mu - (mu - lambda) / 0.9, 1e-12), "{value}");
        let again = Context::new(&single(value, mu, 1)).unwrap();
        assert!(close(again.solution.network_sojourn(), target, 1e-10));

        // Servers are whole: the first count at or past the target (two servers: W = 1/(1 − 0.16) ≈ 1.19 < 4.5).
        let servers = ctx.family(&net, &ParamSpec::Servers { node_id: "S1".into() }).unwrap();
        let Inversion::Achieved { value, measure } = invert(&ctx.model, Measure::NetworkSojourn, &servers, target) else { panic!() };
        assert_eq!(value, 2.0);
        assert!(close(measure, 1.0 / (1.0 - 0.16), 1e-12) && measure <= target);
    }

    /// In the feedback network every answer is verified by redrawing the network at the proposed
    /// value and analysing it with the shipped arithmetic; what cannot be done says why.
    #[test]
    fn inversions_in_a_network_resolve_to_the_target_or_say_why_not() {
        let (gamma, q, mu) = (1.0, 0.6, [2.5, 3.0, 1.6]);
        let net = feedback(gamma, q, mu);
        let ctx = Context::new(&net).unwrap();
        let l0 = ctx.solution.network_number();
        let target = 0.9 * l0;
        // S3: L₃ = ρ₃/(1 − ρ₃) = 5/3 of L ≈ 4.167 — a 10 % cut is within reach of μ₃.
        let service = ctx.family(&net, &ParamSpec::Service { node_id: "S3".into(), class: None }).unwrap();
        let Inversion::Achieved { value, .. } = invert(&ctx.model, Measure::NetworkNumber, &service, target) else { panic!() };
        assert!(value > mu[2]);
        assert!(close(shipped_number(&with_rate(&net, "S3", "rate", value)), target, 1e-9));
        // Routing: more jobs straight on to S3 (q up) shortens the loop.
        let routing = ctx.family(&net, &ParamSpec::Routing { link_id: "S2>BS3".into(), complement_id: "S2>BS1".into() }).unwrap();
        let Inversion::Achieved { value, .. } = invert(&ctx.model, Measure::NetworkNumber, &routing, target) else { panic!() };
        assert!(value > q && value <= 1.0);
        assert!(close(shipped_number(&with_routing(&net, "S2>BS3", "S2>BS1", value)), target, 1e-9));
        // A 60 % cut is beyond S3's service rate alone: L − L₃ = 2.5 is left however fast S3 is.
        match invert(&ctx.model, Measure::NetworkNumber, &service, 0.4 * l0) {
            Inversion::Infeasible { why: Why::Levels, limit_measure: Some(m), .. } => assert!(close(m, l0 - 5.0 / 3.0, 1e-6), "{m}"),
            other => panic!("{other:?}"),
        }
        // …and beyond the routing probability, whose range ends at 1.
        match invert(&ctx.model, Measure::NetworkNumber, &routing, 0.4 * l0) {
            Inversion::Infeasible { why: Why::RangeEnds, limit_value: Some(v), limit_measure: Some(m) } => {
                assert_eq!(v, 1.0);
                assert!(close(m, shipped_number(&with_routing(&net, "S2>BS3", "S2>BS1", 1.0)), 1e-12));
            }
            other => panic!("{other:?}"),
        }
        // Utilisation of S3 cannot be raised to 1: the network is overloaded first.
        let arrival = ctx.family(&net, &ParamSpec::Arrival { node_id: "Src1".into() }).unwrap();
        assert!(matches!(invert(&ctx.model, Measure::StationUtilisation(2), &arrival, 1.0), Inversion::Infeasible { why: Why::Overload, .. }));
        // S1's service rate does not touch S3's queue.
        let other = ctx.family(&net, &ParamSpec::Service { node_id: "S1".into(), class: None }).unwrap();
        assert!(matches!(invert(&ctx.model, Measure::StationNumber(2), &other, 1.0), Inversion::Infeasible { why: Why::NoEffect, .. }));
        // Raising a measure works the other way: L up 10 % by a faster source.
        let Inversion::Achieved { value, .. } = invert(&ctx.model, Measure::NetworkNumber, &arrival, 1.1 * l0) else { panic!() };
        assert!(value > gamma && close(shipped_number(&with_rate(&net, "Src1", "lambda", value)), 1.1 * l0, 1e-9));
    }

    /// What is not a Jackson network is refused with a sentence, never analysed as one.
    #[test]
    fn other_networks_are_refused() {
        let mut net = single(0.5, 1.0, 1);
        net.nodes.iter_mut().find(|n| n.id == "S1").unwrap().distribution = Distribution::Constant;
        net.nodes.iter_mut().find(|n| n.id == "S1").unwrap().parameters = "value=1.0".into();
        assert_eq!(Context::new(&net).unwrap_err(), JacksonError::NotJackson);
        assert!(matches!(Context::new(&single(1.5, 1.0, 1)).unwrap_err(), JacksonError::Unstable(name, rho) if name == "S1" && rho == 1.5));
        let mut finite = single(0.5, 1.0, 1);
        finite.infinite_buffers = false;
        assert_eq!(Context::new(&finite).unwrap_err(), JacksonError::NotJackson);
    }
}
