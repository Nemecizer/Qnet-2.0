//! Exact mean values for one single-server station with batch Poisson arrivals (new in 2.1,
//! ledger SCI-1011…): the arithmetic of the method "Exact Batch-Arrival Queue" (`batch_exact`).
//!
//! **M^X/G/1.** Batches arrive in a Poisson process of rate λ; a batch holds X customers
//! (E[X], E[X²]), served one at a time, first come first served (within a batch in random
//! order), service time S (E[S], E[S²]). With ρ = λ·E[X]·E[S] < 1, the mean wait before service
//! of an arbitrary customer is
//!
//!   Wq = λ·E[X]·E[S²] / (2(1 − ρ))  +  E[X(X − 1)]·E[S] / (2·E[X]·(1 − ρ)).
//!
//! The first term is the Pollaczek–Khinchine wait of the customer's *batch* (a batch is one
//! "super-customer" with service time the sum of its X services, whose second moment is
//! E[X]·Var[S] + E[X²]·E[S]²) and the second is the mean service of the customers ahead of it
//! in its own batch: a random customer sits in a batch of size n with probability n·P(X = n)/E[X]
//! and has (n − 1)/2 others ahead of it on average. (Chaudhry & Templeton, *A First Course in
//! Bulk Queues*, 1983, ch. 3; Gross, Shortle, Thompson & Harris, *Fundamentals of Queueing
//! Theory*, 4th ed., §3.2 for exponential service.)
//! Then W = Wq + E[S], L = λ·E[X]·W, Lq = λ·E[X]·Wq (Little, with the customer rate λ·E[X]).
//!
//! For exponential service (M^X/M/1) this is Gross et al.'s L = ρ·(E[X] + E[X²]) / (2·E[X]·(1 − ρ)):
//! with a constant batch size K, L = ((K + 1)/2)·ρ/(1 − ρ); with geometric batches
//! P(X = n) = (1 − α)·α^(n−1), L = ρ / ((1 − α)(1 − ρ)). The tests hold all three, and the
//! reduction to M/M/1 and to Pollaczek–Khinchine at batch size 1.
//!
//! **Not covered.** Several servers (M^X/M/c has no closed form: its solution needs the roots
//! of a characteristic equation, and nothing here was validated for it), several sources, and
//! anything beyond one station: batches that leave a station are not a batch Poisson process.
//! Those are for the simulator.

use crate::extended::{self, Feature};
use crate::model::{BatchSize, Network, NodeKind};
use crate::naming;
use crate::priority;

#[derive(Clone, Debug, PartialEq)]
pub struct BatchModel {
    pub station_id: String,
    pub station_name: String,
    pub source_name: String,
    /// Batches per time unit.
    pub batch_rate: f64,
    pub batch: BatchSize,
    /// E[S] and E[S²].
    pub mean: f64,
    pub second: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BatchSolution {
    /// Customers per time unit, λ·E[X].
    pub throughput: f64,
    pub utilisation: f64,
    pub wait: f64,
    pub sojourn: f64,
    pub number: f64,
    pub queue: f64,
    /// The two parts of the wait: for the customer's batch to reach the server, and within it.
    pub wait_for_batch: f64,
    pub wait_within_batch: f64,
}

pub const UNSTABLE: &str = "No steady state exists: customers arrive (batch rate × mean batch size) faster than the server can serve them.";

/// The exact means of `model`, or a sentence.
pub fn solve(model: &BatchModel) -> Result<BatchSolution, String> {
    if let Some(p) = model.batch.problem() {
        return Err(p);
    }
    let (ex, ex2) = (model.batch.mean(), model.batch.second_moment());
    if !(model.batch_rate > 0.0 && model.batch_rate.is_finite() && model.mean > 0.0 && model.mean.is_finite()) {
        return Err("The batch rate and the mean service time must be positive numbers.".into());
    }
    if !model.second.is_finite() {
        return Err("The service time has infinite variance, so the mean wait is infinite.".into());
    }
    let throughput = model.batch_rate * ex;
    let rho = throughput * model.mean;
    if !(rho < 1.0) {
        return Err(UNSTABLE.into());
    }
    let wait_for_batch = throughput * model.second / (2.0 * (1.0 - rho)) + (ex2 - ex) * model.mean * rho / (2.0 * ex * (1.0 - rho));
    // Of the second term of the module's formula, the part ρ/(1 − ρ) is the batch's own delay
    // above (through the E[X²] of the super-customer's service); what is left is the customers
    // ahead in the same batch: E[X(X − 1)]·E[S]/(2·E[X]).
    let wait_within_batch = (ex2 - ex) * model.mean / (2.0 * ex);
    let wait = wait_for_batch + wait_within_batch;
    let sojourn = wait + model.mean;
    Ok(BatchSolution { throughput, utilisation: rho, wait, sojourn, number: throughput * sojourn, queue: throughput * wait, wait_for_batch, wait_within_batch })
}

pub const SCOPE: &str = "The exact batch-arrival formula covers one Poisson source feeding one single-server station, with infinite buffers and no feedback; for any other network with batch arrivals use Replicated Simulation.";

/// The batch model of a drawn network, or the sentence saying why the formula does not cover it.
pub fn from_network(net: &Network) -> Result<BatchModel, String> {
    if !extended::uses(net, Feature::BatchArrivals) {
        return Err("No source of this network has batch arrivals, so there is nothing for the batch formula to compute.".into());
    }
    if let Some(p) = extended::problems(net).into_iter().next() {
        return Err(p.message);
    }
    if extended::uses(net, Feature::Priorities) || extended::uses(net, Feature::TimeVaryingRates) {
        return Err("The exact batch-arrival formula assumes first-come-first-served service and a constant batch rate; this network also has priorities or a rate profile. Use Replicated Simulation.".into());
    }
    let sources = naming::in_export_order(net.nodes_of(NodeKind::Source), |n| n.name.as_str());
    if sources.len() != 1 {
        return Err(format!("The network has {} sources. {SCOPE}", sources.len()));
    }
    // The shape (and the customer rate λ·E[X]·p into the station, p the source's routing probability).
    let (station, lambda) = priority::single_station(net, SCOPE)?;
    if station.servers != 1 {
        return Err(format!("{} has {} servers. With several servers the batch-arrival queue has no closed form. {SCOPE}", station.name, station.servers));
    }
    let batch = sources[0].batch.clone().expect("the network uses batch arrivals and has one source");
    if lambda.iter().skip(1).any(|x| *x > 0.0) {
        return Err(format!("More than one class is served at {}. {SCOPE}", station.name));
    }
    // A source that sends each customer on with probability p < 1 thins the batches: the batch
    // that arrives is then no longer the law written, so only p = 1 is covered.
    let p: f64 = net.links.iter().filter(|l| l.from == sources[0].id).map(|l| l.probability).sum();
    if (p - 1.0).abs() > 1e-12 {
        return Err(format!("{} sends on only part of what it creates (its links sum to {}), which changes the batch sizes that arrive. {SCOPE}", sources[0].name, crate::dist::format_significant(p, 6)));
    }
    let (mean, second, _) = priority::service_moments(station, 0)?;
    let model = BatchModel { station_id: station.id.clone(), station_name: station.name.clone(), source_name: sources[0].name.clone(), batch_rate: lambda[0] / batch.mean(), batch, mean, second };
    solve(&model)?;
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(rate: f64, batch: BatchSize, mean: f64, scv: f64) -> BatchModel {
        BatchModel { station_id: "S".into(), station_name: "S".into(), source_name: "A".into(), batch_rate: rate, batch, mean, second: mean * mean * (1.0 + scv) }
    }

    fn close(a: f64, b: f64, what: &str) {
        assert!((a - b).abs() <= 1e-13 * b.abs().max(1.0), "{what}: {a} vs {b}");
    }

    /// Batch size 1 is M/M/1 (L = ρ/(1 − ρ)) and, for general service, Pollaczek–Khinchine.
    #[test]
    fn batches_of_one_reduce_to_mm1_and_pollaczek_khinchine() {
        for b in [BatchSize::Constant(1), BatchSize::Geometric { mean: 1.0 }, BatchSize::Pmf(vec![1.0])] {
            let s = solve(&model(0.6, b, 1.25, 1.0)).unwrap();
            close(s.number, 0.75 / 0.25, "M/M/1 L");
            close(s.wait, 0.75 * 1.25 / 0.25, "M/M/1 Wq = ρ/(μ − λ)");
            assert_eq!(s.wait_within_batch, 0.0);
        }
        let (lambda, mean, scv) = (0.5, 1.2, 0.3);
        let s = solve(&model(lambda, BatchSize::Constant(1), mean, scv)).unwrap();
        close(s.wait, lambda * mean * mean * (1.0 + scv) / (2.0 * (1.0 - lambda * mean)), "P–K");
    }

    /// Constant batches of K at an exponential server (Gross et al., 4th ed., §3.2):
    /// L = ((K + 1)/2)·ρ/(1 − ρ). For K = 2, batches at rate 1, μ = 3: ρ = 2/3, L = 1.5·2 = 3.
    #[test]
    fn constant_batches_of_two_give_the_textbook_value() {
        let s = solve(&model(1.0, BatchSize::Constant(2), 1.0 / 3.0, 1.0)).unwrap();
        close(s.utilisation, 2.0 / 3.0, "ρ");
        close(s.number, 3.0, "L");
        close(s.sojourn, 1.5, "W = L/(λ·K)");
        close(s.queue, 3.0 - 2.0 / 3.0, "Lq = L − ρ");
        for k in [1i64, 3, 7] {
            let s = solve(&model(0.1, BatchSize::Constant(k), 1.0, 1.0)).unwrap();
            let rho = 0.1 * k as f64;
            close(s.number, (k as f64 + 1.0) / 2.0 * rho / (1.0 - rho), "L, constant K");
        }
    }

    /// Geometric batches P(X = n) = (1 − α)α^(n−1) at an exponential server (Gross et al., §3.2):
    /// L = ρ/((1 − α)(1 − ρ)), ρ = λ/(μ(1 − α)).
    #[test]
    fn geometric_batches_give_the_closed_form() {
        for (lambda, mu, alpha) in [(0.4, 2.0, 0.5), (1.0, 5.0, 0.75), (0.2, 1.0, 0.1)] {
            let s = solve(&model(lambda, BatchSize::Geometric { mean: 1.0 / (1.0 - alpha) }, 1.0 / mu, 1.0)).unwrap();
            let rho = lambda / (mu * (1.0 - alpha));
            close(s.utilisation, rho, "ρ");
            close(s.number, rho / ((1.0 - alpha) * (1.0 - rho)), "L");
        }
    }

    /// Any batch law at an exponential server: L = ρ(E[X] + E[X²])/(2E[X](1 − ρ)) (Gross et al.,
    /// §3.2). And a pmf that spells out a constant or a truncated law agrees with it.
    #[test]
    fn the_general_formula_matches_gross_for_exponential_service_and_a_pmf_matches_its_law() {
        let pmf = BatchSize::Pmf(vec![0.5, 0.3, 0.0, 0.2]);
        let (ex, ex2) = (0.5 + 0.6 + 0.8, 0.5 + 1.2 + 3.2);
        close(pmf.mean(), ex, "E[X]");
        close(pmf.second_moment(), ex2, "E[X²]");
        let s = solve(&model(0.3, pmf, 1.0, 1.0)).unwrap();
        let rho = 0.3 * ex;
        close(s.number, rho * (ex + ex2) / (2.0 * ex * (1.0 - rho)), "L");
        let a = solve(&model(0.2, BatchSize::Pmf(vec![0.0, 0.0, 1.0]), 0.7, 0.4)).unwrap();
        let b = solve(&model(0.2, BatchSize::Constant(3), 0.7, 0.4)).unwrap();
        close(a.number, b.number, "pmf of a constant");
        // The geometric law's second moment m(2m − 1) against its series.
        let m: f64 = 2.5;
        let alpha = 1.0 - 1.0 / m;
        let series: f64 = (1..4000).map(|n| (n * n) as f64 * (1.0 - alpha) * alpha.powi(n - 1)).sum();
        close(BatchSize::Geometric { mean: m }.second_moment(), series, "E[X²], geometric");
    }

    /// M^X/G/1 as an M/G/1 queue of batches: the wait of a batch is Pollaczek–Khinchine with the
    /// batch's total service time B = S_1 + … + S_X, E[B] = E[X]E[S],
    /// E[B²] = E[X]·Var[S] + E[X²]·E[S]² (Wald). An independent route to `wait_for_batch`.
    #[test]
    fn the_wait_of_a_batch_is_pollaczek_khinchine_for_the_super_customer() {
        let (lambda, mean, scv) = (0.25, 0.8, 2.0);
        let b = BatchSize::Pmf(vec![0.2, 0.5, 0.3]);
        let s = solve(&model(lambda, b.clone(), mean, scv)).unwrap();
        let var = scv * mean * mean;
        let eb2 = b.mean() * var + b.second_moment() * mean * mean;
        close(s.wait_for_batch, lambda * eb2 / (2.0 * (1.0 - lambda * b.mean() * mean)), "P–K on batches");
    }

    #[test]
    fn an_overloaded_or_invalid_queue_is_refused() {
        assert_eq!(solve(&model(0.5, BatchSize::Constant(2), 1.0, 1.0)).unwrap_err(), UNSTABLE);
        assert!(solve(&model(0.1, BatchSize::Pmf(vec![0.5, 0.2]), 1.0, 1.0)).unwrap_err().contains("sum to 0.7"));
    }
}
