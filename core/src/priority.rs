//! Exact mean values for one station with priority service (new in 2.1, ledger SCI-1002…): the
//! arithmetic of the method "Exact Priority Queue" (`priority_exact`).
//!
//! The station is fed by independent Poisson streams, one per class, class k at rate λ_k with
//! service time S_k (mean E[S_k], second moment E[S_k²]), ρ_k = λ_k·E[S_k]. Classes are numbered
//! here in priority order, 1 the highest; σ_k = ρ_1 + … + ρ_k, σ_0 = 0. Within a class service is
//! first come, first served. All results need σ_K < 1 (c servers: Σλ_k/(cμ) < 1).
//!
//! **One server, non-preemptive (head of the line), general service.** Cobham's formula (Cobham,
//! "Priority assignment in waiting line problems", Oper. Res. 2:70–76, 1954; Kleinrock,
//! *Queueing Systems* vol. 2, 1976, ch. 3): with W₀ = Σ_i λ_i·E[S_i²]/2 the mean
//! residual service found by an arrival,
//!
//!   Wq_k = W₀ / ((1 − σ_{k−1})(1 − σ_k)).
//!
//! **One server, preemptive-resume, general service** (Kleinrock vol. 2 ch. 3; Conway,
//! Maxwell & Miller, *Theory of Scheduling*, 1967, §8-6): the mean time in system of class k is
//!
//!   T_k = E[S_k]/(1 − σ_{k−1}) + (Σ_{i≤k} λ_i·E[S_i²]/2) / ((1 − σ_{k−1})(1 − σ_k)),
//!
//! (lower classes are invisible to class k), and its mean time not in service is T_k − E[S_k]:
//! waiting before the first start and during interruptions together.
//!
//! **c servers, exponential service at one rate μ for every class, non-preemptive** (Cobham 1954;
//! Kella & Yechiali, "Waiting times in the non-preemptive priority M/M/c queue", Stochastic
//! Models 1:257–262, 1985): with ρ_k = λ_k/(cμ) and C the Erlang delay probability at the total
//! load,
//!
//!   Wq_k = C/(cμ) / ((1 − σ_{k−1})(1 − σ_k)).
//!
//! **c servers, exponential service at one rate μ, preemptive-resume** (Buzen & Bondi, "The
//! response times of priority classes under preemptive resume in M/M/m queues", Oper. Res.
//! 31:456–465, 1983). With equal exponential rates the number of customers of classes 1..k is a
//! birth–death process whatever happens among and below them: it rises at rate Λ_k = Σ_{i≤k} λ_i
//! and falls at rate μ·min(n, c), because the n highest customers hold min(n, c) servers and
//! preemption wastes no work. So it is the M/M/c number at load Λ_k/μ, and
//!
//!   L_k = L_{M/M/c}(Λ_k/μ) − L_{M/M/c}(Λ_{k−1}/μ),   T_k = L_k/λ_k.
//!
//! With one server this equals the M/G/1 formula above for exponential service (a test holds it).
//! Other multi-server cases (unequal rates, non-exponential service) have no closed form and
//! are refused with a sentence; the simulator handles them.
//!
//! From the class results: L_k = λ_k·T_k and Lq_k = λ_k·(T_k − E[S_k]) (Little), and the station
//! totals are their sums. **Scope**: exactly one station, fed directly by Poisson sources, with
//! infinite waiting room and no feedback. The departures of a priority queue are not Poisson
//! processes class by class, so nothing here is claimed for a station downstream of another.
//!
//! Tests: hand computations from the formulas, Kleinrock's conservation law Σρ_k·Wq_k =
//! ρ·W₀/(1 − ρ) across every order of the classes, the two-class closed forms, the reductions to
//! Pollaczek–Khinchine (one class; identical classes) and to M/M/c, and agreement between the
//! M/G/1 and M/M/c routes where both apply. The simulator is held to these in `simstat/tests.rs`.

use crate::closed;
use crate::extended::{self, Feature};
use crate::jackson;
use crate::model::{Discipline, Distribution, Network, Node, NodeKind};
use crate::naming;
use crate::sim::Sampler;
use crate::traffic;

/// One class at the station.
#[derive(Clone, Debug, PartialEq)]
pub struct ClassInput {
    /// The network's class index (0-based: the k-th source in export order).
    pub class: usize,
    /// Arrival rate λ_k, customers per time unit.
    pub lambda: f64,
    /// E[S_k] and E[S_k²].
    pub mean: f64,
    pub second: f64,
    /// True when the service law is exponential.
    pub exponential: bool,
}

/// The station, its classes in priority order (highest first).
#[derive(Clone, Debug, PartialEq)]
pub struct PriorityModel {
    pub station_id: String,
    pub station_name: String,
    pub servers: i64,
    pub discipline: Discipline,
    pub classes: Vec<ClassInput>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClassResult {
    pub class: usize,
    pub lambda: f64,
    /// ρ_k = λ_k·E[S_k]/c.
    pub load: f64,
    /// Mean time not in service (before the first start and, with preemption, while interrupted).
    pub wait: f64,
    /// Mean time at the station.
    pub sojourn: f64,
    /// Mean number at the station, and of those not in service.
    pub number: f64,
    pub queue: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrioritySolution {
    /// In priority order, as the model's classes.
    pub classes: Vec<ClassResult>,
    /// Station totals: L, Lq, λ, utilisation (mean fraction of busy servers), and the averages
    /// over all customers W = L/λ and Wq = Lq/λ.
    pub number: f64,
    pub queue: f64,
    pub throughput: f64,
    pub utilisation: f64,
    pub sojourn: f64,
    pub wait: f64,
    /// Which formula was used, for the run's text.
    pub formula: &'static str,
}

/// How every refusal of an overloaded station starts.
pub const UNSTABLE: &str = "No steady state exists for the station as a whole: the classes together offer more work than it can do";

/// What is true of a station whose total load is 1 or more (review finding FIX-206).
///
/// **Preemptive-resume.** The classes 1..k are served as if the lower classes were not there
/// (a lower customer never holds a server a higher one wants, and resuming loses no work), so
/// they form a preemptive-resume queue of their own, with a steady state exactly when
/// σ_k < 1; the formulas of [`solve`] for those classes do not involve the lower ones
/// (Kleinrock vol. 2, §3.6; Buzen & Bondi 1983 for c servers). `stable` holds their exact
/// results. The remaining classes have σ_k ≥ 1 and fall behind without limit.
///
/// **Non-preemptive.** Nothing is given: Cobham's argument takes W₀, the mean residual service
/// an arrival finds, from the whole station in steady state, and an overloaded station has
/// none (the server is then always busy and what it is busy with is not Σλ_i·E[S_i²]/2).
#[derive(Clone, Debug, PartialEq)]
pub struct Overload {
    /// The total load Σρ_k (≥ 1).
    pub total: f64,
    /// The classes that keep a steady state, in priority order, with their exact results.
    pub stable: Vec<ClassResult>,
    /// The network class indices of the classes that grow without limit, in priority order.
    pub growing: Vec<usize>,
    pub formula: Option<&'static str>,
}

/// [`Overload`] for a model whose total load is 1 or more; None for a stable or invalid one.
pub fn overload(model: &PriorityModel) -> Option<Overload> {
    let cf = model.servers.max(1) as f64;
    if model.classes.is_empty() || model.classes.iter().any(|k| !(k.lambda > 0.0 && k.lambda.is_finite() && k.mean > 0.0 && k.mean.is_finite())) {
        return None;
    }
    let loads: Vec<f64> = model.classes.iter().map(|k| k.lambda * k.mean / cf).collect();
    let total: f64 = loads.iter().sum();
    if total < 1.0 {
        return None;
    }
    // σ_k rises with k, so the classes with σ_k < 1 are the first few.
    let mut sigma = 0.0;
    let keep = loads.iter().take_while(|l| {
        sigma += **l;
        sigma < 1.0
    }).count();
    let top = (model.discipline == Discipline::PreemptiveResume && keep > 0).then(|| solve(&PriorityModel { classes: model.classes[..keep].to_vec(), ..model.clone() }).ok()).flatten();
    match top {
        Some(s) => Some(Overload { total, stable: s.classes, growing: model.classes[keep..].iter().map(|k| k.class).collect(), formula: Some(s.formula) }),
        None => Some(Overload { total, stable: Vec::new(), growing: model.classes.iter().map(|k| k.class).collect(), formula: None }),
    }
}

/// The sentence [`solve`] refuses an overloaded station with.
fn overload_sentence(model: &PriorityModel, o: &Overload) -> String {
    let list = |names: Vec<String>| match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        n => format!("{} and {}", names[..n - 1].join(", "), names[n - 1]),
    };
    let load = crate::dist::format_significant(o.total, 3);
    if o.stable.is_empty() {
        let why = match model.discipline {
            Discipline::PreemptiveResume => "The highest class alone offers more work than the station can do, so every class falls behind without limit.",
            _ => "The exact formula is not offered when the total load is 1 or more: it takes the work an arrival finds in service from a station in steady state. (The higher classes may still wait a finite time; no formula for that is claimed here.)",
        };
        return format!("{UNSTABLE} (utilisation {load}). {why}");
    }
    let stable = list(o.stable.iter().map(|c| format!("{} (mean time at the station {})", traffic::class_label(c.class as i64), crate::dist::format_significant(c.sojourn, 6))).collect());
    let growing = list(o.growing.iter().map(|c| traffic::class_label(*c as i64)).collect());
    let (keeps, falls) = (if o.stable.len() == 1 { "keeps" } else { "keep" }, if o.growing.len() == 1 { "falls" } else { "fall" });
    format!("{UNSTABLE} (utilisation {load}), so no station result is given. With preemptive-resume a class is not delayed by the classes below it: {stable} {keeps} a steady state, exactly, and {growing} {falls} behind without limit.")
}

/// The exact means of `model`, or a sentence saying why no formula applies.
pub fn solve(model: &PriorityModel) -> Result<PrioritySolution, String> {
    let c = model.servers.max(1);
    let cf = c as f64;
    if model.classes.is_empty() {
        return Err("No class arrives at the station.".into());
    }
    if model.classes.iter().any(|k| !(k.lambda > 0.0 && k.lambda.is_finite() && k.mean > 0.0 && k.mean.is_finite())) {
        return Err("Every class needs a positive arrival rate and a positive mean service time.".into());
    }
    let loads: Vec<f64> = model.classes.iter().map(|k| k.lambda * k.mean / cf).collect();
    let total: f64 = loads.iter().sum();
    if !(total < 1.0) {
        return Err(match overload(model) {
            Some(o) => overload_sentence(model, &o),
            None => format!("{UNSTABLE}."),
        });
    }
    let preemptive = match model.discipline {
        Discipline::NonPreemptive => false,
        Discipline::PreemptiveResume => true,
        Discipline::Fcfs => return Err("The station serves first come, first served: it has no priorities to compute.".into()),
    };
    let mut sojourn = Vec::with_capacity(loads.len());
    let formula;
    if c == 1 {
        if model.classes.iter().any(|k| !k.second.is_finite()) {
            return Err("A class has a service time with infinite variance, so its mean wait is infinite.".into());
        }
        let mut sigma_before = 0.0;
        let mut residual = 0.0; // Σ_{i≤k} λ_i E[S_i²]/2
        let w0: f64 = model.classes.iter().map(|k| k.lambda * k.second / 2.0).sum();
        for (k, load) in model.classes.iter().zip(&loads) {
            let sigma = sigma_before + load;
            residual += k.lambda * k.second / 2.0;
            let t = if preemptive { k.mean / (1.0 - sigma_before) + residual / ((1.0 - sigma_before) * (1.0 - sigma)) } else { w0 / ((1.0 - sigma_before) * (1.0 - sigma)) + k.mean };
            sojourn.push(t);
            sigma_before = sigma;
        }
        formula = if preemptive { "M/G/1 preemptive-resume priority (Kleinrock vol. 2, ch. 3)" } else { "M/G/1 non-preemptive priority (Cobham 1954)" };
    } else {
        let mu = 1.0 / model.classes[0].mean;
        let same = model.classes.iter().all(|k| k.exponential && (k.mean * mu - 1.0).abs() <= 1e-12);
        if !same {
            return Err(format!("With {c} servers the exact priority formulas need exponential service at the same rate for every class. Use Replicated Simulation for this station."));
        }
        if preemptive {
            let mut below = 0.0; // Λ_{k−1}
            for k in &model.classes {
                let upto = below + k.lambda;
                let l = jackson::mmc(c, upto / mu).number - jackson::mmc(c, below / mu).number;
                sojourn.push(l / k.lambda);
                below = upto;
            }
            formula = "M/M/c preemptive-resume priority, equal service rates (Buzen & Bondi 1983)";
        } else {
            let wait_all = jackson::mmc(c, total * cf).wait_probability / (cf * mu);
            let mut sigma_before = 0.0;
            for load in &loads {
                let sigma = sigma_before + load;
                sojourn.push(wait_all / ((1.0 - sigma_before) * (1.0 - sigma)) + 1.0 / mu);
                sigma_before = sigma;
            }
            formula = "M/M/c non-preemptive priority, equal service rates (Cobham 1954; Kella & Yechiali 1985)";
        }
    }
    let classes: Vec<ClassResult> = model
        .classes
        .iter()
        .zip(&loads)
        .zip(&sojourn)
        .map(|((k, load), t)| ClassResult { class: k.class, lambda: k.lambda, load: *load, wait: t - k.mean, sojourn: *t, number: k.lambda * t, queue: k.lambda * (t - k.mean) })
        .collect();
    let throughput: f64 = classes.iter().map(|k| k.lambda).sum();
    let number: f64 = classes.iter().map(|k| k.number).sum();
    let queue: f64 = classes.iter().map(|k| k.queue).sum();
    Ok(PrioritySolution { classes, number, queue, throughput, utilisation: total, sojourn: number / throughput, wait: queue / throughput, formula })
}

/// The one sentence every refusal about the network's shape ends with.
pub const SCOPE: &str = "The exact priority formulas cover a single station fed directly by Poisson sources, with infinite buffers and no feedback; for any other network with priorities use Replicated Simulation.";

/// The service law of `class` at `station`: (mean, second moment, exponential?), or a sentence.
pub(crate) fn service_moments(station: &Node, class: usize) -> Result<(f64, f64, bool), String> {
    let (d, text) = match station.service_by_class.get(&(class as i64)) {
        Some(c) => (c.distribution, c.parameters.as_str()),
        None => (station.distribution, station.parameters.as_str()),
    };
    Sampler::new(d, text, &station.name)?;
    let rate = traffic::rate(d, text);
    let scv = traffic::scv(d, text);
    let mean = 1.0 / rate;
    Ok((mean, mean * mean * (1.0 + scv), d == Distribution::Exponential))
}

/// The single station of a network that is one station fed directly by sources, with its
/// per-class arrival rates (at the sources' long-run customer rates), or a sentence saying what
/// about the shape is not that. `scope` ends the sentence.
pub(crate) fn single_station<'a>(net: &'a Network, scope: &str) -> Result<(&'a Node, Vec<f64>), String> {
    if closed::looks_closed(net) {
        return Err(format!("This network has no source. {scope}"));
    }
    if !net.infinite_buffers {
        return Err(format!("The network has finite buffers. {scope}"));
    }
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
    if stations.len() != 1 {
        return Err(format!("The network has {} stations. {scope}", stations.len()));
    }
    let data = extended::traffic(net, true, false, false).map_err(|e| e.message())?;
    if data.aggregated_p[0][0] != 0.0 || net.links.iter().any(|l| l.from == stations[0].id && net.node(&l.to).is_some_and(|t| t.kind == NodeKind::Buffer || t.kind == NodeKind::Station)) {
        return Err(format!("Customers return to {} after service (feedback). {scope}", stations[0].name));
    }
    if let Some(s) = net.nodes_of(NodeKind::Source).find(|s| !matches!(s.distribution, Distribution::Poisson | Distribution::Exponential)) {
        return Err(format!("{} is not a Poisson source. {scope}", s.name));
    }
    Ok((stations[0], (0..data.k).map(|k| data.alpha_per_class[k][0]).collect()))
}

/// The priority model of a drawn network, or the sentence saying why the exact formulas do not
/// cover it.
pub fn from_network(net: &Network) -> Result<PriorityModel, String> {
    if !extended::uses(net, Feature::Priorities) {
        return Err("No station of this network has priority service, so there is nothing for the priority formulas to compute.".into());
    }
    if let Some(p) = extended::problems(net).into_iter().next() {
        return Err(p.message);
    }
    if extended::uses(net, Feature::BatchArrivals) || extended::uses(net, Feature::TimeVaryingRates) {
        return Err("The exact priority formulas assume single Poisson arrivals at a constant rate; this network also has batch arrivals or a rate profile. Use Replicated Simulation.".into());
    }
    let (station, lambda) = single_station(net, SCOPE)?;
    let mut classes = Vec::new();
    for &c in &station.priority_order {
        let k = c as usize;
        if lambda.get(k).copied().unwrap_or(0.0) > 0.0 {
            let (mean, second, exponential) = service_moments(station, k)?;
            classes.push(ClassInput { class: k, lambda: lambda[k], mean, second, exponential });
        }
    }
    let model = PriorityModel { station_id: station.id.clone(), station_name: station.name.clone(), servers: station.servers, discipline: station.discipline, classes };
    solve(&model)?;
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class(class: usize, lambda: f64, mean: f64, scv: f64) -> ClassInput {
        ClassInput { class, lambda, mean, second: mean * mean * (1.0 + scv), exponential: scv == 1.0 }
    }

    fn model(discipline: Discipline, servers: i64, classes: Vec<ClassInput>) -> PriorityModel {
        PriorityModel { station_id: "S".into(), station_name: "S".into(), servers, discipline, classes }
    }

    fn close(a: f64, b: f64, tol: f64, what: &str) {
        assert!((a - b).abs() <= tol * b.abs().max(1.0), "{what}: {a} vs {b}");
    }

    fn permutations(n: usize) -> Vec<Vec<usize>> {
        if n == 1 {
            return vec![vec![0]];
        }
        let mut out = Vec::new();
        for p in permutations(n - 1) {
            for at in 0..n {
                let mut q = p.clone();
                q.insert(at, n - 1);
                out.push(q);
            }
        }
        out
    }

    /// Cobham's formula by hand. High class: λ = 0.3, exponential mean 1 (ρ = 0.3, E[S²] = 2);
    /// low class: λ = 0.2, exponential mean 2 (ρ = 0.4, E[S²] = 8). W₀ = (0.3·2 + 0.2·8)/2 = 1.1;
    /// Wq₁ = 1.1/0.7 = 11/7; Wq₂ = 1.1/(0.7·0.3) = 110/21.
    #[test]
    fn cobham_by_hand_two_exponential_classes() {
        let s = solve(&model(Discipline::NonPreemptive, 1, vec![class(0, 0.3, 1.0, 1.0), class(1, 0.2, 2.0, 1.0)])).unwrap();
        close(s.classes[0].wait, 11.0 / 7.0, 1e-14, "Wq1");
        close(s.classes[1].wait, 110.0 / 21.0, 1e-14, "Wq2");
        close(s.classes[0].sojourn, 11.0 / 7.0 + 1.0, 1e-14, "T1");
        close(s.classes[1].number, 0.2 * (110.0 / 21.0 + 2.0), 1e-14, "L2");
        close(s.utilisation, 0.7, 1e-15, "ρ");
        close(s.throughput, 0.5, 1e-15, "λ");
        close(s.queue, 0.3 * 11.0 / 7.0 + 0.2 * 110.0 / 21.0, 1e-14, "Lq");
    }

    /// Cobham with non-exponential service, by hand. Three classes on one server: deterministic
    /// service 1 at λ = 0.2 (E[S²] = 1), Erlang-2 mean 2 at λ = 0.1 (E[S²] = 4·1.5 = 6), and
    /// exponential mean 0.5 at λ = 0.4 (E[S²] = 0.5). ρ = 0.2, 0.2, 0.2; W₀ = (0.2 + 0.6 + 0.2)/2
    /// = 0.5. Wq = 0.5/0.8 = 0.625; 0.5/(0.8·0.6) = 25/24; 0.5/(0.6·0.4) = 25/12.
    #[test]
    fn cobham_by_hand_three_general_classes() {
        let s = solve(&model(Discipline::NonPreemptive, 1, vec![class(0, 0.2, 1.0, 0.0), class(1, 0.1, 2.0, 0.5), class(2, 0.4, 0.5, 1.0)])).unwrap();
        close(s.classes[0].wait, 0.625, 1e-14, "Wq1");
        close(s.classes[1].wait, 25.0 / 24.0, 1e-14, "Wq2");
        close(s.classes[2].wait, 25.0 / 12.0, 1e-14, "Wq3");
    }

    /// Kleinrock's conservation law (vol. 2, ch. 3, the M/G/1 conservation law): for any non-preemptive
    /// work-conserving order, Σ_k ρ_k·Wq_k = ρ·W₀/(1 − ρ). Held to 1e-12 for all 24 orders of
    /// four classes with different service laws.
    #[test]
    fn the_conservation_law_holds_for_every_priority_order() {
        let classes = [class(0, 0.15, 1.0, 0.0), class(1, 0.05, 3.0, 2.5), class(2, 0.4, 0.6, 1.0), class(3, 0.2, 0.9, 0.25)];
        let rho: f64 = classes.iter().map(|k| k.lambda * k.mean).sum();
        let w0: f64 = classes.iter().map(|k| k.lambda * k.second / 2.0).sum();
        let want = rho * w0 / (1.0 - rho);
        let mut waits_of_first = Vec::new();
        for order in permutations(4) {
            let s = solve(&model(Discipline::NonPreemptive, 1, order.iter().map(|&i| classes[i].clone()).collect())).unwrap();
            let got: f64 = s.classes.iter().map(|k| k.load * k.wait).sum();
            assert!((got - want).abs() <= 1e-12 * want, "{order:?}: {got} vs {want}");
            waits_of_first.push(s.classes[0].wait);
        }
        assert!(waits_of_first.iter().any(|w| (w - waits_of_first[0]).abs() > 0.01), "the orders do differ class by class");
    }

    /// Work conservation under preemptive-resume: the mean unfinished work is the M/G/1 workload
    /// W₀/(1 − ρ) whatever the order. With exponential service the remaining work of a class-k
    /// customer has mean 1/μ_k wherever it stands, so Σ_k L_k/μ_k = W₀/(1 − ρ); to 1e-12, all orders.
    #[test]
    fn preemptive_resume_conserves_work_for_every_order() {
        let classes = [class(0, 0.3, 0.5, 1.0), class(1, 0.1, 2.0, 1.0), class(2, 0.25, 1.2, 1.0), class(3, 0.6, 0.2, 1.0)];
        let rho: f64 = classes.iter().map(|k| k.lambda * k.mean).sum();
        let w0: f64 = classes.iter().map(|k| k.lambda * k.second / 2.0).sum();
        let want = w0 / (1.0 - rho);
        for order in permutations(4) {
            let m = model(Discipline::PreemptiveResume, 1, order.iter().map(|&i| classes[i].clone()).collect());
            let s = solve(&m).unwrap();
            let got: f64 = s.classes.iter().zip(&m.classes).map(|(r, k)| r.number * k.mean).sum();
            assert!((got - want).abs() <= 1e-12 * want, "{order:?}: {got} vs {want}");
        }
    }

    /// Two exponential classes, preemptive-resume, one server (Kleinrock vol. 2 ch. 3; Gross et
    /// al., *Fundamentals of Queueing Theory*, 4th ed., §3.4). The high class does not see the
    /// low one: T₁ = 1/(μ₁ − λ₁). The low class: T₂ = [1/μ₂ + (ρ₁/μ₁ + ρ₂/μ₂)/(1 − ρ)]/(1 − ρ₁).
    #[test]
    fn two_class_preemptive_closed_forms() {
        let (l1, m1, l2, m2) = (0.3, 1.0, 0.2, 0.5);
        let s = solve(&model(Discipline::PreemptiveResume, 1, vec![class(0, l1, 1.0 / m1, 1.0), class(1, l2, 1.0 / m2, 1.0)])).unwrap();
        let (r1, r2) = (l1 / m1, l2 / m2);
        close(s.classes[0].sojourn, 1.0 / (m1 - l1), 1e-14, "T1");
        close(s.classes[1].sojourn, (1.0 / m2 + (r1 / m1 + r2 / m2) / (1.0 - r1 - r2)) / (1.0 - r1), 1e-14, "T2");
        // Equal rates: the total number is the M/M/1 number ρ/(1 − ρ), whatever the discipline.
        for d in [Discipline::PreemptiveResume, Discipline::NonPreemptive] {
            let s = solve(&model(d, 1, vec![class(0, 0.3, 1.0, 1.0), class(1, 0.4, 1.0, 1.0)])).unwrap();
            close(s.number, 0.7 / 0.3, 1e-13, "L");
        }
    }

    /// One class, or identical classes, is M/G/1 first come first served: Pollaczek–Khinchine,
    /// Wq = λ·E[S²]/(2(1 − ρ)). Identical classes give the P–K mean over all customers.
    #[test]
    fn one_class_and_identical_classes_reduce_to_pollaczek_khinchine() {
        let (lambda, mean, scv) = (0.6, 1.2, 0.4);
        let pk = lambda * mean * mean * (1.0 + scv) / (2.0 * (1.0 - lambda * mean));
        for d in [Discipline::NonPreemptive, Discipline::PreemptiveResume] {
            let s = solve(&model(d, 1, vec![class(0, lambda, mean, scv)])).unwrap();
            close(s.classes[0].wait, pk, 1e-14, "one class");
            close(s.wait, pk, 1e-14, "station");
        }
        let s = solve(&model(Discipline::NonPreemptive, 1, (0..3).map(|k| class(k, lambda / 3.0, mean, scv)).collect())).unwrap();
        close(s.wait, pk, 1e-13, "identical classes, averaged over customers");
        assert!(s.classes[0].wait < pk && pk < s.classes[2].wait, "though each class's own wait differs");
    }

    /// Several servers. One class is M/M/c (Erlang C: Wq = C/(cμ − λ)); the non-preemptive
    /// formula obeys the same conservation law with W₀ = C/(cμ); the preemptive one gives the
    /// M/M/c total number; and with c = 1 both multi-server routes equal the M/G/1 formulas.
    #[test]
    fn several_servers_reduce_to_erlang_c_and_agree_with_the_single_server_formulas() {
        let (c, mu) = (3i64, 0.8);
        let lam = [0.5, 0.9, 0.6];
        let total: f64 = lam.iter().sum();
        let erlang = jackson::mmc(c, total / mu);
        for d in [Discipline::NonPreemptive, Discipline::PreemptiveResume] {
            let one = solve(&model(d, c, vec![class(0, total, 1.0 / mu, 1.0)])).unwrap();
            close(one.number, erlang.number, 1e-13, "one class is M/M/c");
            close(one.wait, erlang.wait_probability / (c as f64 * mu - total), 1e-13, "Erlang C wait");
            let s = solve(&model(d, c, (0..3).map(|k| class(k, lam[k], 1.0 / mu, 1.0)).collect())).unwrap();
            close(s.number, erlang.number, 1e-12, "equal rates: the total number does not depend on the order");
            assert!(s.classes[0].wait < s.classes[1].wait && s.classes[1].wait < s.classes[2].wait);
        }
        // c = 1 through the multi-server code path must equal the M/G/1 formulas. The model has
        // servers = 1, so force the comparison by computing both by hand here.
        let mu1 = 1.0;
        let lam = [0.2, 0.3, 0.25];
        let mg1 = solve(&model(Discipline::PreemptiveResume, 1, (0..3).map(|k| class(k, lam[k], 1.0 / mu1, 1.0)).collect())).unwrap();
        let mut below = 0.0;
        for k in 0..3 {
            let upto = below + lam[k];
            let l = jackson::mmc(1, upto / mu1).number - jackson::mmc(1, below / mu1).number;
            close(mg1.classes[k].number, l, 1e-13, "Buzen–Bondi at c = 1 is the M/G/1 preemptive-resume formula");
            below = upto;
        }
        let np = solve(&model(Discipline::NonPreemptive, 1, (0..3).map(|k| class(k, lam[k], 1.0 / mu1, 1.0)).collect())).unwrap();
        let wait_all = jackson::mmc(1, 0.75 / mu1).wait_probability / mu1;
        close(np.classes[1].wait, wait_all / ((1.0 - 0.2) * (1.0 - 0.5)), 1e-13, "Kella–Yechiali at c = 1 is Cobham");
    }

    #[test]
    fn what_has_no_formula_is_refused_in_a_sentence() {
        assert_eq!(
            solve(&model(Discipline::NonPreemptive, 1, vec![class(0, 0.6, 1.0, 1.0), class(1, 0.5, 1.0, 1.0)])).unwrap_err(),
            "No steady state exists for the station as a whole: the classes together offer more work than it can do (utilisation 1.1). The exact formula is not offered when the total load is 1 or more: it takes the work an arrival finds in service from a station in steady state. (The higher classes may still wait a finite time; no formula for that is claimed here.)"
        );
        let e = solve(&model(Discipline::NonPreemptive, 2, vec![class(0, 0.6, 1.0, 1.0), class(1, 0.5, 0.5, 1.0)])).unwrap_err();
        assert!(e.starts_with("With 2 servers the exact priority formulas need exponential service at the same rate for every class."), "{e}");
        assert!(solve(&model(Discipline::PreemptiveResume, 2, vec![class(0, 0.6, 1.0, 0.5)])).is_err(), "Erlang service on two servers");
        assert!(solve(&model(Discipline::Fcfs, 1, vec![class(0, 0.6, 1.0, 1.0)])).is_err());
        assert!(solve(&model(Discipline::NonPreemptive, 1, vec![ClassInput { class: 0, lambda: 0.1, mean: 1.0, second: f64::INFINITY, exponential: false }])).is_err());
    }

    /// Review finding FIX-206. Under preemptive-resume the classes with σ_k < 1 keep a steady
    /// state when the station as a whole is overloaded, with the values of the same station
    /// without the lower classes. Loads 0.3, 0.4 and 0.5 (σ = 0.3, 0.7, 1.2):
    /// T₁ = E[S]/(1 − ρ₁) = 1/0.7 for the M/M/1 queue class 1 is on its own, and by the formula
    /// T₂ = 2/0.7 + (0.3·2 + 0.2·8)/2 / (0.7·0.3) = 170/21.
    #[test]
    fn under_preemptive_resume_the_classes_above_an_overload_keep_their_exact_values() {
        let classes = vec![class(0, 0.3, 1.0, 1.0), class(1, 0.2, 2.0, 1.0), class(2, 0.5, 1.0, 1.0)];
        let m = model(Discipline::PreemptiveResume, 1, classes.clone());
        let o = overload(&m).unwrap();
        close(o.total, 1.2, 1e-14, "total load");
        assert_eq!((o.stable.len(), o.growing.clone()), (2, vec![2]));
        close(o.stable[0].sojourn, 1.0 / 0.7, 1e-14, "T1 (M/M/1 at 0.3)");
        close(o.stable[1].sojourn, 170.0 / 21.0, 1e-14, "T2");
        // The same numbers as the station without the lowest class, and as with a lowest class
        // light enough for the whole station to be stable: the lower class is invisible.
        let without = solve(&model(Discipline::PreemptiveResume, 1, classes[..2].to_vec())).unwrap();
        let light = solve(&model(Discipline::PreemptiveResume, 1, vec![classes[0].clone(), classes[1].clone(), class(2, 0.1, 1.0, 1.0)])).unwrap();
        for k in 0..2 {
            assert_eq!(o.stable[k], without.classes[k]);
            close(o.stable[k].sojourn, light.classes[k].sojourn, 1e-14, "invisible lower class");
        }
        assert_eq!(
            solve(&m).unwrap_err(),
            "No steady state exists for the station as a whole: the classes together offer more work than it can do (utilisation 1.2), so no station result is given. With preemptive-resume a class is not delayed by the classes below it: Class 1 (mean time at the station 1.42857) and Class 2 (mean time at the station 8.09524) keep a steady state, exactly, and Class 3 falls behind without limit."
        );
        // Several servers at one exponential rate (Buzen & Bondi): the top class is M/M/2 at 0.8.
        let two = model(Discipline::PreemptiveResume, 2, vec![class(0, 0.8, 1.0, 1.0), class(1, 1.5, 1.0, 1.0)]);
        let o = overload(&two).unwrap();
        close(o.stable[0].number, jackson::mmc(2, 0.8).number, 1e-14, "M/M/2 for the top class");
        assert_eq!(o.growing, vec![1]);
        // The top class alone overloads the station; and nothing is claimed without preemption.
        let hopeless = overload(&model(Discipline::PreemptiveResume, 1, vec![class(0, 1.1, 1.0, 1.0), class(1, 0.1, 1.0, 1.0)])).unwrap();
        assert!(hopeless.stable.is_empty() && hopeless.growing == vec![0, 1]);
        let head_of_line = overload(&model(Discipline::NonPreemptive, 1, classes)).unwrap();
        assert!(head_of_line.stable.is_empty() && head_of_line.formula.is_none());
        assert_eq!(overload(&light_model()), None);
    }

    fn light_model() -> PriorityModel {
        model(Discipline::PreemptiveResume, 1, vec![class(0, 0.3, 1.0, 1.0), class(1, 0.2, 2.0, 1.0)])
    }
}
