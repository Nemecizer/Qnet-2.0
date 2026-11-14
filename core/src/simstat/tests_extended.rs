//! The simulator and its estimators held to the exact results for the model features new in 2.1
//! (ledger SCI-1004, SCI-1005, SCI-1012, SCI-1023): priority service (`priority.rs`), batch
//! arrivals (`batch.rs`) and time-varying rates (`transient.rs`).
//!
//! As in `tests.rs`, **coverage is the bar**: the whole method is run 200 times from fixed
//! seeds and the runs whose 95 % interval contains the exact value are counted; a correct
//! interval gives a Binomial(200, 0.95) count, accepted in 182..=198 (see `tests.rs` for the
//! error probabilities of that band). Beside it the *bias* is tested: the mean over the 200 runs
//! of (estimate − exact) must be within 4 of its standard errors of zero, which catches a
//! simulator that is slightly wrong long before coverage does.
//!
//! As there, each experiment exists twice (`experiment!`): the 200-run `coverage_*` behind
//! `#[ignore]` (`scripts/coverage-experiments.sh`), and `quick_coverage_*` in the default suite
//! on the first 12 seeds, band 9–12 of 12, a smoke check and not evidence of coverage.
//!
//! A priority test counts eleven measures at once, so the chance that *some* correct measure
//! leaves the band is eleven times one measure's 0.6 %. The seeds and run lengths below are the
//! ones recorded as passing; with replications half as long (30,000 completions) the
//! preemptive test's class-1 throughput — a plain Poisson count, the same under any discipline —
//! covered 180 of 200, one below the band, with no bias (z = +1.5). That is the band's own
//! error rate showing, and is why the run length here is 60,000.

use super::*;
use crate::batch;
use crate::model::{BatchSize, Discipline, Distribution, Link, Network, Node, NodeKind, RateProfile, RateSegment, ServiceConfig};
use crate::priority;
use crate::sim::Kind;
use crate::transient;

use super::tests::{band, full_experiment, par_map, runs};

fn node(kind: NodeKind, name: &str, d: Distribution, params: &str, servers: i64) -> Node {
    let mut n = Node::new(name, kind, name, (0.0, 0.0));
    n.distribution = d;
    n.parameters = params.to_string();
    n.servers = servers;
    n
}

fn link(from: &str, to: &str, class: i64) -> Link {
    Link { id: format!("{from}>{to}:{class}"), from: from.into(), to: to.into(), probability: 1.0, class, to_class: None }
}

/// Poisson sources (one per class, rates `lambda`) → B1 → S1 → Out, with a per-class service law.
fn station(lambda: &[f64], service: &[(Distribution, &str)], servers: i64, discipline: Discipline, order: &[i64]) -> Network {
    let mut nodes = Vec::new();
    let mut links = Vec::new();
    for (k, l) in lambda.iter().enumerate() {
        nodes.push(node(NodeKind::Source, &format!("Src{}", k + 1), Distribution::Poisson, &format!("lambda={l}"), 1));
        links.push(link(&format!("Src{}", k + 1), "B1", k as i64));
        links.push(link("S1", "Out", k as i64));
    }
    nodes.push(node(NodeKind::Buffer, "B1", Distribution::Exponential, "", 1));
    let mut s = node(NodeKind::Station, "S1", service[0].0, service[0].1, servers);
    for (k, (d, p)) in service.iter().enumerate() {
        s.service_by_class.insert(k as i64, ServiceConfig { distribution: *d, parameters: p.to_string() });
    }
    s.discipline = discipline;
    s.priority_order = order.to_vec();
    nodes.push(s);
    nodes.push(node(NodeKind::Sink, "Out", Distribution::Exponential, "", 1));
    links.push(link("B1", "S1", 0));
    Network { nodes, links, infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
}

fn quick() -> Options {
    Options { replications: 10, completions: 20_000, ..Options::default() }
}

/// Counts coverage and bias of named (estimate, exact) pairs over [`runs`] runs of the method
/// (200 in an experiment, 12 in a quick check, where the bias test is as wide as its few runs make it).
fn holds(what: &str, net: &Network, opts: &Options, base: u64, pick: impl Fn(&Outcome) -> Vec<(String, Estimate, f64)> + Sync) {
    let (runs, band) = (runs(), band());
    let rows = par_map(runs, |k| pick(&estimate(net, &Options { seed: base + k as u64, threads: 1, ..opts.clone() }, &mut |_| true).unwrap()));
    let mut failures = Vec::new();
    let mut line = Vec::new();
    for m in 0..rows[0].len() {
        let (name, _, exact) = &rows[0][m];
        let covered = rows.iter().filter(|r| r[m].1.covers(*exact)).count();
        let bias = Estimate::of(&rows.iter().map(|r| r[m].1.mean - exact).collect::<Vec<_>>(), 1.0);
        let z = if bias.standard_error > 0.0 { bias.mean / bias.standard_error } else { 0.0 };
        line.push(format!("{name} {covered} (z {z:+.2})"));
        if !band.contains(&covered) {
            failures.push(format!("{name}: covered {covered} of {runs}"));
        }
        if z.abs() > 4.0 {
            failures.push(format!("{name}: biased by {} ({z:+.1} standard errors) around {exact}", bias.mean));
        }
    }
    println!("coverage of {runs} [{what}]: {}", line.join(", "));
    assert!(failures.is_empty(), "{what}: {failures:?}");
}

/// The per-class and station measures of a priority station against `priority::solve`.
fn priority_rows(net: &Network) -> impl Fn(&Outcome) -> Vec<(String, Estimate, f64)> + Sync {
    let model = priority::from_network(net).unwrap();
    let exact = priority::solve(&model).unwrap();
    move |o: &Outcome| {
        let s = &o.stations[0];
        let mut rows = vec![("L".to_string(), s.number, exact.number), ("Lq".to_string(), s.queue, exact.queue), ("W".to_string(), s.sojourn.unwrap(), exact.sojourn), ("Wq".to_string(), s.waiting.unwrap(), exact.wait), ("util".to_string(), s.utilisation, exact.utilisation)];
        for c in &exact.classes {
            let e = s.classes.iter().find(|x| x.class == c.class).expect("every class is estimated");
            rows.push((format!("L[class {}]", c.class + 1), e.number, c.number));
            rows.push((format!("T[class {}]", c.class + 1), e.sojourn.unwrap(), c.sojourn));
            rows.push((format!("X[class {}]", c.class + 1), e.throughput, c.lambda));
        }
        rows
    }
}

const EXP1: (Distribution, &str) = (Distribution::Exponential, "rate=1.0");

experiment!(
    /// Cobham's formula: two classes on one server, the low class with Erlang-2 service of mean 2
    /// (ρ = 0.3 + 0.4), the low class named *first* in the file so that the order, not the class
    /// number, decides.
    quick_coverage_non_preemptive_priority_mg1,
    coverage_non_preemptive_priority_mg1,
    {
        let net = station(&[0.2, 0.3], &[(Distribution::Erlang, "k=2,rate=1.0"), EXP1], 1, Discipline::NonPreemptive, &[1, 0]);
        holds("M/G/1 non-preemptive, 2 classes", &net, &Options { completions: 60_000, ..quick() }, 310_000, priority_rows(&net));
    }
);

experiment!(
    /// Preemptive-resume with non-exponential service: the interrupted customer must resume with
    /// exactly what it had left, or the low class's time comes out wrong (preemptive-*repeat* with
    /// resampling would shorten Erlang services and lengthen none: a different, biased answer).
    quick_coverage_preemptive_resume_priority_mg1,
    coverage_preemptive_resume_priority_mg1,
    {
        let net = station(&[0.3, 0.2], &[EXP1, (Distribution::Erlang, "k=2,rate=1.0")], 1, Discipline::PreemptiveResume, &[0, 1]);
        holds("M/G/1 preemptive-resume, 2 classes", &net, &Options { completions: 60_000, ..quick() }, 320_000, priority_rows(&net));
    }
);

/// Three classes with deterministic, uniform and exponential service, both disciplines.
#[test]
#[ignore = "slow without optimisation: cargo test --release -p qnet-core simstat::tests_extended -- --ignored --nocapture"]
fn coverage_priority_three_classes_and_several_servers() {
    full_experiment();
    let laws = [(Distribution::Constant, "value=1.0"), (Distribution::Uniform, "min=0.5,max=2.5"), (Distribution::Exponential, "rate=2.0")];
    for (d, base) in [(Discipline::NonPreemptive, 330_000), (Discipline::PreemptiveResume, 340_000)] {
        let net = station(&[0.2, 0.15, 0.5], &laws, 1, d, &[2, 0, 1]);
        holds(&format!("M/G/1 {d:?}, 3 classes"), &net, &Options::default(), base, priority_rows(&net));
        // Several servers, equal exponential rates (Kella & Yechiali; Buzen & Bondi).
        let net = station(&[0.9, 0.8, 0.7], &[EXP1, EXP1, EXP1], 3, d, &[0, 1, 2]);
        holds(&format!("M/M/3 {d:?}, 3 classes"), &net, &Options::default(), base + 5_000, priority_rows(&net));
    }
}

fn batch_rows(net: &Network) -> impl Fn(&Outcome) -> Vec<(String, Estimate, f64)> + Sync {
    let exact = batch::solve(&batch::from_network(net).unwrap()).unwrap();
    move |o: &Outcome| {
        let s = &o.stations[0];
        vec![("L".to_string(), s.number, exact.number), ("Lq".to_string(), s.queue, exact.queue), ("util".to_string(), s.utilisation, exact.utilisation), ("X".to_string(), s.throughput, exact.throughput), ("W".to_string(), s.sojourn.unwrap(), exact.sojourn), ("Wq".to_string(), s.waiting.unwrap(), exact.wait)]
    }
}

fn batch_station(rate: f64, law: BatchSize, service: (Distribution, &str)) -> Network {
    let mut net = station(&[rate], &[service], 1, Discipline::Fcfs, &[]);
    net.nodes[0].batch = Some(law);
    net.nodes[2].service_by_class.clear();
    net
}

experiment!(
    /// M^X/M/1 with geometric batches of mean 2.5 at ρ = 0.6.
    quick_coverage_batch_arrivals_geometric,
    coverage_batch_arrivals_geometric,
    {
        let net = batch_station(0.24, BatchSize::Geometric { mean: 2.5 }, EXP1);
        holds("M^X/M/1 geometric", &net, &Options { completions: 40_000, ..quick() }, 350_000, batch_rows(&net));
    }
);

experiment!(
    /// M^X/G/1: batches by an explicit pmf, Erlang-2 service (ρ = 0.25·1.9·1.5 = 0.7125).
    quick_coverage_batch_arrivals_pmf_with_general_service,
    coverage_batch_arrivals_pmf_with_general_service,
    {
        let net = batch_station(0.25, BatchSize::Pmf(vec![0.5, 0.3, 0.0, 0.2]), (Distribution::Erlang, "k=2,rate=1.3333333333333333"));
        holds("M^X/E2/1 pmf", &net, &Options { completions: 40_000, ..quick() }, 360_000, batch_rows(&net));
    }
);

#[test]
#[ignore = "slow without optimisation"]
fn coverage_batch_arrivals_at_the_default_settings() {
    full_experiment();
    let net = batch_station(0.3, BatchSize::Constant(2), (Distribution::Constant, "value=1.0"));
    holds("default M^X/D/1 constant 2", &net, &Options::default(), 370_000, batch_rows(&net));
    let net = batch_station(0.24, BatchSize::Geometric { mean: 2.5 }, EXP1);
    holds("default M^X/M/1 geometric", &net, &Options::default(), 380_000, batch_rows(&net));
}

// ── The simulator itself ────────────────────────────────────────────────────────────────────

/// Work conservation, every discipline, one and two servers: the work a station has done,
/// ∫ (busy servers) dt, equals the service times drawn for the customers that have started less
/// what those customers still have left — an interrupted customer keeps its remaining time to the
/// last digit. And preemption really happens, never at a first-come-first-served or
/// non-preemptive station, and under preemptive-resume no higher class ever waits while a lower
/// one is served.
#[test]
fn work_is_conserved_and_preemption_follows_the_order() {
    let laws = [(Distribution::Erlang, "k=3,rate=3.0"), (Distribution::Uniform, "min=0.2,max=1.2"), EXP1];
    for servers in [1i64, 2] {
        for d in Discipline::ALL {
            let lambda = [0.25 * servers as f64, 0.3 * servers as f64, 0.2 * servers as f64];
            let net = station(&lambda, &laws, servers, d, if d == Discipline::Fcfs { &[] } else { &[1, 2, 0] });
            let rank = |class: u32| [2usize, 0, 1][class as usize];
            let mut sim = Simulator::new(&net, 77 + servers as u64).unwrap();
            let (mut preempted, mut started) = (0u64, 0u64);
            for _ in 0..200 {
                for e in sim.advance(500, f64::INFINITY) {
                    match e.kind {
                        Kind::Preempt => preempted += 1,
                        Kind::Start => started += 1,
                        _ => {}
                    }
                }
                let st = sim.stats();
                let done = st.area_number[0] - st.area_queue[0];
                let accounted = st.work_started[0] - st.work_left[0];
                assert!((done - accounted).abs() <= 1e-9 * done.max(1.0), "{d:?}, {servers} servers: work done {done} vs drawn less left {accounted}");
                let by_class: f64 = st.area_class[0].iter().sum();
                assert!((by_class - st.area_number[0]).abs() <= 1e-9 * by_class.max(1.0), "the classes add up to the station");
                let snap = sim.snapshot();
                assert!(snap.queues[0].is_empty() || snap.servers[0].iter().all(|s| s.is_some()), "no server idles beside a queue");
                if d == Discipline::PreemptiveResume {
                    let worst_served = snap.servers[0].iter().flatten().map(|(_, c)| rank(*c)).max();
                    let best_waiting = snap.queues[0].iter().map(|(_, c)| rank(*c)).min();
                    if let (Some(s), Some(w)) = (worst_served, best_waiting) {
                        assert!(w >= s, "a higher class waits while a lower one is served");
                    }
                }
                if d != Discipline::Fcfs {
                    let ranks: Vec<usize> = snap.queues[0].iter().map(|(_, c)| rank(*c)).collect();
                    assert!(ranks.windows(2).all(|w| w[0] <= w[1]), "the queue is in priority order");
                }
            }
            assert_eq!(preempted > 0, d == Discipline::PreemptiveResume, "{d:?}: {preempted} preemptions");
            let st = sim.stats();
            // Every start is a first start or a resumption.
            assert!(started >= st.departures[0] && started <= st.arrivals[0] + preempted);
        }
    }
}

/// Batches arrive whole: with a constant batch of 3 every arrival epoch creates exactly three
/// customers; the batch sizes drawn have the law's mean; and the load is counted in customers.
#[test]
fn batches_arrive_together_and_have_the_stated_law() {
    let net = batch_station(0.2, BatchSize::Constant(3), EXP1);
    let mut sim = Simulator::new(&net, 5).unwrap();
    let events = sim.advance(30_000, f64::INFINITY);
    let arrivals: Vec<f64> = events.iter().filter(|e| e.kind == Kind::Arrive).map(|e| e.time).collect();
    assert!(arrivals.len() > 3000);
    for chunk in arrivals.chunks(3).take(arrivals.len() / 3) {
        assert!(chunk[0] == chunk[1] && chunk[1] == chunk[2], "three at one instant");
    }
    assert!(arrivals.chunks(3).take(arrivals.len() / 3 - 1).zip(arrivals.chunks(3).skip(1)).all(|(a, b)| b[0] > a[0]), "and the next batch later");
    assert!((sim.layout().event_rate - 0.6).abs() < 1e-12, "0.2 batches × 3 customers per time unit");
    for (law, seed) in [(BatchSize::Geometric { mean: 2.5 }, 6u64), (BatchSize::Pmf(vec![0.5, 0.3, 0.0, 0.2]), 7)] {
        let net = batch_station(0.1, law.clone(), EXP1);
        let mut sim = Simulator::new(&net, seed).unwrap();
        let mut sizes: Vec<f64> = Vec::new();
        let mut last = f64::NAN;
        for e in sim.advance(400_000, f64::INFINITY).iter().filter(|e| e.kind == Kind::Arrive) {
            if e.time == last {
                *sizes.last_mut().unwrap() += 1.0;
            } else {
                sizes.push(1.0);
                last = e.time;
            }
        }
        let n = sizes.len() as f64;
        let mean = sizes.iter().sum::<f64>() / n;
        let second = sizes.iter().map(|x| x * x).sum::<f64>() / n;
        let sd = ((law.second_moment() - law.mean() * law.mean()) / n).sqrt();
        assert!(n > 20_000.0 && (mean - law.mean()).abs() < 4.0 * sd, "{law:?}: mean batch {mean} vs {}", law.mean());
        assert!((second / law.second_moment() - 1.0).abs() < 0.06, "{law:?}: E[X²] {second} vs {}", law.second_moment());
        if let BatchSize::Pmf(_) = law {
            assert!(sizes.iter().all(|x| *x != 3.0 && *x <= 4.0), "a size of probability 0 never occurs");
        }
    }
}

fn profiled(lambda: f64, mu: f64, servers: i64, periodic: bool, segments: &[(f64, f64)]) -> Network {
    let mut net = station(&[lambda], &[(Distribution::Exponential, &format!("rate={mu}"))], servers, Discipline::Fcfs, &[]);
    net.nodes[0].rate_profile = Some(RateProfile { periodic, segments: segments.iter().map(|(until, multiplier)| RateSegment { until: *until, multiplier: *multiplier }).collect() });
    net
}

/// Thinning gives the stated rate on every piece: the arrivals on a piece of length ℓ at
/// multiplier m are Poisson(λ·m·ℓ) (4 standard deviations, summed over many periods), and none
/// arrive while the multiplier is 0.
#[test]
fn thinning_gives_each_piece_its_rate() {
    let net = profiled(4.0, 100.0, 1, true, &[(1.0, 0.5), (3.0, 2.0), (4.0, 0.0), (6.0, 1.0)]);
    let mut sim = Simulator::new(&net, 11).unwrap();
    let periods = 600.0;
    let mut counts = [0.0f64; 4];
    for e in sim.advance(usize::MAX, 6.0 * periods).iter().filter(|e| e.kind == Kind::Arrive) {
        let t = e.time % 6.0;
        counts[if t < 1.0 { 0 } else if t < 3.0 { 1 } else if t < 4.0 { 2 } else { 3 }] += 1.0;
    }
    for (j, (len, m)) in [(1.0, 0.5), (2.0, 2.0), (1.0, 0.0), (2.0, 1.0)].iter().enumerate() {
        let want: f64 = 4.0 * m * len * periods;
        assert!((counts[j] - want).abs() <= 4.0 * want.sqrt(), "piece {j}: {} arrivals, expected {want}", counts[j]);
    }
    assert_eq!(counts[2], 0.0);
    // A one-off profile ends and the source's own rate is back for good.
    let net = profiled(4.0, 100.0, 1, false, &[(5.0, 0.0)]);
    let mut sim = Simulator::new(&net, 12).unwrap();
    let events = sim.advance(usize::MAX, 505.0);
    let n = events.iter().filter(|e| e.kind == Kind::Arrive).count() as f64;
    assert!(events.iter().all(|e| e.time >= 5.0) && (n - 2000.0).abs() < 4.0 * 2000f64.sqrt(), "{n}");
}

experiment!(
    /// The estimator of the mean at a time, against the exact transient solution: for an M_t/M/1
    /// and an M_t/M/2 queue with several breakpoints (one piece overloading the single server), the
    /// number at each of five times is estimated from 400 replications, 200 times over, and the
    /// exact mean of `transient::exact` (uniformisation, its missing mass below 1e-8) must be
    /// covered by the 95 % interval in 182..=198 of the 200, without bias.
    quick_coverage_of_the_mean_at_a_time_against_the_exact_transient,
    coverage_of_the_mean_at_a_time_against_the_exact_transient,
    {
        let times = [1.5, 4.0, 6.5, 9.0, 14.0];
        for (what, net, base) in [
            ("M_t/M/1", profiled(0.6, 1.0, 1, false, &[(2.0, 0.5), (5.0, 1.8), (8.0, 0.2)]), 410_000u64),
            ("M_t/M/2 periodic", profiled(1.0, 0.8, 2, true, &[(3.0, 1.4), (5.0, 0.3)]), 420_000),
        ] {
            let model = crate::jackson::from_network(&net).unwrap();
            let profile = transient::profile_of(&net, &model, 16.0).unwrap();
            assert!(profile.is_some());
            let exact = transient::exact(&model, &transient::Request { horizon: 16.0, intervals: 32, profile, ..transient::Request::default() }, &mut |_| true).unwrap();
            assert!(exact.missing_mass.iter().all(|m| *m < 1e-7));
            let want: Vec<f64> = times.iter().map(|t| exact.mean[0][exact.times.iter().position(|x| (x - t).abs() < 1e-9).unwrap()]).collect();
            let (n, band) = (runs(), band());
            let runs = par_map(n, |k| transient_means(&net, &times, 400, base + k as u64, 0.95, 1, &mut |_| true).unwrap());
            let mut failures = Vec::new();
            let mut line = Vec::new();
            for (j, t) in times.iter().enumerate() {
                let covered = runs.iter().filter(|o| o.mean[0][j].covers(want[j])).count();
                let bias = Estimate::of(&runs.iter().map(|o| o.mean[0][j].mean - want[j]).collect::<Vec<_>>(), 1.0);
                let z = bias.mean / bias.standard_error;
                line.push(format!("t={t}: {covered} (z {z:+.2}, exact {:.4})", want[j]));
                if !band.contains(&covered) || z.abs() > 4.0 {
                    failures.push(format!("t={t}: covered {covered}, bias {z:+.1} SE"));
                }
            }
            println!("coverage of {n} [{what}, mean at a time]: {}", line.join(", "));
            assert!(failures.is_empty(), "{what}: {failures:?}");
        }
    }
);

#[test]
fn the_estimators_refuse_what_they_do_not_estimate() {
    let varying = profiled(0.5, 1.0, 1, true, &[(1.0, 0.5), (2.0, 1.5)]);
    let r = plan(&varying).unwrap_err();
    assert_eq!((r.code, r.message.as_str()), ("timeVarying", TIME_VARYING_SENTENCE));
    assert!(matches!(transient_means(&varying, &[1.0], 50, 1, 0.95, 1, &mut |_| true), Err(Failure::Options(_))), "too few replications");
    assert!(matches!(transient_means(&varying, &[2.0, 1.0], 100, 1, 0.95, 1, &mut |_| true), Err(Failure::Options(_))), "times out of order");
    let a = transient_means(&varying, &[1.0, 2.0], 100, 9, 0.95, 1, &mut |_| true).unwrap();
    let b = transient_means(&varying, &[1.0, 2.0], 100, 9, 0.95, 4, &mut |_| true).unwrap();
    assert_eq!(a, b, "a seed gives one answer whatever the threads");
    // A priority order that leaves out a class is refused by the simulator, in the sentence Problems shows.
    let bad = station(&[0.2, 0.2], &[EXP1, EXP1], 1, Discipline::NonPreemptive, &[0]);
    let r = plan(&bad).unwrap_err();
    assert!(r.code == "settings" && r.message.contains("priority order is missing Class 2"), "{}", r.message);
    // A plain network has no class rows and its estimates are what they were.
    let plain = station(&[0.5], &[EXP1], 1, Discipline::Fcfs, &[]);
    assert!(estimate(&plain, &Options { replications: 2, completions: 2_000, ..Options::default() }, &mut |_| true).unwrap().stations[0].classes.is_empty());
}

/// Review finding FIX-206: an overloaded preemptive-resume station. The exact method says
/// class 1 (ρ₁ = 0.3) keeps its M/M/1 steady state while class 2 falls behind; the simulator
/// agrees on class 1 (its time-average number over 10 independent runs of 20,000 time units
/// after 1,000 of warm-up, 99 % Student interval, against L₁ = 0.3/0.7), class 2's number grows
/// with the horizon, and the replicated estimator refuses the network rather than give a
/// steady-state interval for a station that has no steady state.
#[test]
fn an_overloaded_preemptive_station_keeps_its_top_class_and_is_not_given_a_steady_state_interval() {
    let net = station(&[0.3, 0.9], &[EXP1, EXP1], 1, Discipline::PreemptiveResume, &[0, 1]);
    let refusal = priority::from_network(&net).unwrap_err();
    assert!(refusal.contains("Class 1 (mean time at the station 1.42857) keeps a steady state, exactly, and Class 2 falls behind without limit."), "{refusal}");
    assert_eq!(plan(&net).unwrap_err().code, "unstable");
    assert!(matches!(estimate(&net, &quick(), &mut |_| true), Err(Failure::Refused(_))));

    let (warm, horizon) = (1_000.0, 21_000.0);
    let mut top = Vec::new();
    let mut low = Vec::new();
    for seed in 0..10u64 {
        let mut sim = Simulator::new(&net, 900 + seed).unwrap();
        sim.skip(usize::MAX, warm);
        let a = sim.stats();
        sim.skip(usize::MAX, horizon);
        let b = sim.stats();
        top.push((b.area_class[0][0] - a.area_class[0][0]) / (horizon - warm));
        low.push((b.area_class[0][1] - a.area_class[0][1]) / (horizon - warm));
    }
    let l1 = Estimate::of(&top, t_quantile(9, 0.99).unwrap());
    assert!(l1.covers(0.3 / 0.7) && l1.half_width() < 0.05, "L₁ = {} [{}, {}] against {}", l1.mean, l1.low, l1.high, 0.3 / 0.7);
    // Class 2 gains (0.3 + 0.9 − 1) = 0.2 customers per time unit: about 2,200 on average over the window.
    let l2 = low.iter().sum::<f64>() / 10.0;
    assert!(l2 > 1_500.0 && l2 < 3_000.0, "class 2's average number over the window: {l2}");
}
