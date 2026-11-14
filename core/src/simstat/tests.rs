//! The checks of `simstat.rs` (ledger SIM-101…104).
//!
//! **Coverage is the bar.** For each model with a known exact answer the whole method is run
//! 200 times from fixed, distinct seeds, and for every station and measure the number of
//! runs whose 95 % interval contains the exact value is counted. A correct 95 % interval covers
//! in each run with probability 0.95, so the count is Binomial(200, 0.95): mean 190, standard
//! deviation 3.08. The acceptance band is **182 to 198 of 200 (91 % to 99 %)**:
//! P(count ≤ 181) = 0.6 % and P(count ≥ 199) = 0.04 % for a correct method, while a method whose
//! true coverage is 88 % (the kind of shortfall a normal quantile with 10 replications, an
//! undeleted transient or correlated "replications" produce) lands at or below 181 with
//! probability 93 %. The seeds are fixed, so a test that passes keeps passing; the band is what
//! a *change* to the method has to stay inside.
//!
//! **What runs when.** Those 200-run experiments take minutes of every core without
//! optimisation, and run beside the suite's timed tests they starve them (review finding
//! FIX-207). So each experiment is written once ([`experiment!`]) and exists twice:
//!
//! - `coverage_*`, `#[ignore]`d: the experiment itself, 200 runs, band 182–198, on every core.
//!   `scripts/coverage-experiments.sh` runs them all in release mode; the release checklist
//!   (README) calls it. These are what the claims in the ledger and the help article rest on.
//! - `quick_coverage_*`, in the default suite: the first [`QUICK_RUNS`] = 12 of the same seeds,
//!   on at most [`QUICK_WORKERS`] = 4 threads, one experiment at a time. Its band is **9 to 12
//!   of 12**: a correct method lands at 8 or below with probability 0.22 %. It is a smoke
//!   check and is not offered as evidence of coverage: a method whose true coverage is 88 %
//!   passes it 95 times in 100 and one at 70 % still passes half the time; it catches a method
//!   that is broken (coverage 50 %: caught 93 times in 100), a changed seed stream, and a
//!   crash. With fixed seeds it is deterministic.
//!
//! Both run the method with 10 replications of 20,000 completions — a tenth of the default run
//! length, which is the harder case for coverage (shorter replications are less normal). The
//! `coverage_at_the_default_settings` and sequential experiments run the shipped defaults
//! (20 × 200,000) and the sequential rule.

use super::*;
use crate::bnet;
use crate::closed;
use crate::jackson;
use crate::model::{Distribution, Link, Network, Node, NodeKind};

// ── Networks ────────────────────────────────────────────────────────────────────────────────

fn node(kind: NodeKind, name: &str, d: Distribution, params: &str, servers: i64) -> Node {
    let mut n = Node::new(name, kind, name, (0.0, 0.0));
    n.distribution = d;
    n.parameters = params.to_string();
    n.servers = servers;
    n
}

fn link(from: &str, to: &str, p: f64) -> Link {
    Link { id: format!("{from}>{to}"), from: from.into(), to: to.into(), probability: p, class: 0, to_class: None }
}

fn network(nodes: Vec<Node>, links: Vec<Link>) -> Network {
    Network { nodes, links, infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
}

/// Source → B1 → S1 → Sink: M/M/c with arrival rate λ and per-server rate μ.
fn mm(lambda: f64, mu: f64, servers: i64) -> Network {
    network(
        vec![node(NodeKind::Source, "A1", Distribution::Poisson, &format!("lambda={lambda}"), 1), node(NodeKind::Buffer, "B1", Distribution::Exponential, "", 1), node(NodeKind::Station, "S1", Distribution::Exponential, &format!("rate={mu}"), servers), node(NodeKind::Sink, "Out", Distribution::Exponential, "", 1)],
        vec![link("A1", "B1", 1.0), link("B1", "S1", 1.0), link("S1", "Out", 1.0)],
    )
}

/// A closed cycle S1 → S2 → S3 → S1.
fn cycle(mu: [f64; 3], servers: [i64; 3], population: i64) -> Network {
    let mut nodes = Vec::new();
    let mut links = Vec::new();
    for i in 0..3 {
        nodes.push(node(NodeKind::Buffer, &format!("B{}", i + 1), Distribution::Exponential, "", 1));
        nodes.push(node(NodeKind::Station, &format!("S{}", i + 1), Distribution::Exponential, &format!("rate={}", mu[i]), servers[i]));
        links.push(link(&format!("B{}", i + 1), &format!("S{}", i + 1), 1.0));
    }
    links.push(link("S1", "B2", 1.0));
    links.push(link("S2", "B3", 1.0));
    links.push(link("S3", "B1", 1.0));
    let mut net = network(nodes, links);
    net.population = Some(population);
    net
}

fn example(name: &str) -> Network {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(name);
    bnet::read(&std::fs::read_to_string(path).unwrap()).unwrap()
}

// ── Exact answers ───────────────────────────────────────────────────────────────────────────

/// Per station: L, Lq, utilisation, X, W, Wq.
type Exact = Vec<[f64; 6]>;
const MEASURES: [&str; 6] = ["L", "Lq", "utilisation", "X", "W", "Wq"];

/// M/M/c by the Erlang C formula (`jackson::mmc`; Kleinrock, Queueing Systems I, §3.5).
fn exact_mmc(lambda: f64, mu: f64, servers: i64) -> Exact {
    let m = jackson::mmc(servers, lambda / mu);
    vec![[m.number, m.queue, lambda / (servers as f64 * mu), lambda, m.number / lambda, m.queue / lambda]]
}

/// An open Jackson network by the traffic equations and M/M/c marginals (`jackson::solve`).
fn exact_jackson(net: &Network) -> Exact {
    let model = jackson::from_network(net).unwrap();
    let s = jackson::solve(&model).unwrap();
    (0..model.mu.len()).map(|i| [s.number[i], s.queue[i], s.rho[i], s.alpha[i], s.number[i] / s.alpha[i], s.queue[i] / s.alpha[i]]).collect()
}

/// A closed network by Buzen's convolution (`closed::convolution`).
fn exact_closed(net: &Network) -> Exact {
    let model = closed::from_network(net).unwrap();
    let s = closed::convolution(&model).unwrap();
    (0..model.mu.len()).map(|i| [s.number[i], s.queue[i], s.utilisation[i].unwrap(), s.station_throughput[i], s.residence[i], s.queue[i] / s.station_throughput[i]]).collect()
}

fn measures(s: &StationEstimates) -> [Estimate; 6] {
    [s.number, s.queue, s.utilisation, s.throughput, s.sojourn.unwrap(), s.waiting.unwrap()]
}

// ── Coverage ────────────────────────────────────────────────────────────────────────────────

pub(super) const FULL_RUNS: usize = 200;
pub(super) const FULL_BAND: std::ops::RangeInclusive<usize> = 182..=198;
pub(super) const QUICK_RUNS: usize = 12;
pub(super) const QUICK_BAND: std::ops::RangeInclusive<usize> = 9..=12;
/// The threads a quick check may use; and only one quick check runs at a time.
pub(super) const QUICK_WORKERS: usize = 4;
static ONE_QUICK_CHECK_AT_A_TIME: Mutex<()> = Mutex::new(());

thread_local! {
    /// Set by the `#[ignore]`d experiments: this test thread runs the full 200.
    static FULL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Called first by an experiment that runs in full.
pub(super) fn full_experiment() {
    FULL.with(|f| f.set(true));
}

pub(super) fn is_full() -> bool {
    FULL.with(|f| f.get())
}

/// How many times the method is run, and how many of them must cover.
pub(super) fn runs() -> usize {
    if is_full() { FULL_RUNS } else { QUICK_RUNS }
}

pub(super) fn band() -> std::ops::RangeInclusive<usize> {
    if is_full() { FULL_BAND } else { QUICK_BAND }
}

/// One experiment, twice: `$quick` in the default suite (12 runs, 4 threads) and `$full`
/// behind `#[ignore]` (200 runs, every core; `scripts/coverage-experiments.sh`).
macro_rules! experiment {
    ($(#[$doc:meta])* $quick:ident, $full:ident, $body:block) => {
        $(#[$doc])*
        #[test]
        fn $quick() $body

        $(#[$doc])*
        #[test]
        #[ignore = "a 200-run coverage experiment: scripts/coverage-experiments.sh"]
        fn $full() {
            $crate::simstat::tests::full_experiment();
            $body
        }
    };
}

/// `f(k)` for k in 0..n, in order: a full experiment on the machine's threads, a quick check
/// on [`QUICK_WORKERS`] and after any other quick check has finished.
pub(super) fn par_map<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let full = is_full();
    let _turn = (!full).then(|| ONE_QUICK_CHECK_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner()));
    let threads = if full { std::thread::available_parallelism().map(|x| x.get()).unwrap_or(1) } else { QUICK_WORKERS }.clamp(1, n.max(1));
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<T>>> = Mutex::new((0..n).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                if k >= n {
                    break;
                }
                let v = f(k);
                out.lock().unwrap()[k] = Some(v);
            });
        }
    });
    out.into_inner().unwrap().into_iter().map(|v| v.unwrap()).collect()
}

struct Coverage {
    /// Per station and measure: runs whose interval covered the exact value.
    covered: Vec<[usize; 6]>,
    /// Per station and measure: the mean over runs of (estimate − exact), and its standard error.
    bias: Vec<[(f64, f64); 6]>,
    replications: f64,
}

/// Runs the method [`runs`] times from seeds `base + k` and counts.
fn coverage(net: &Network, exact: &Exact, opts: &Options, base: u64) -> Coverage {
    let outcomes = par_map(runs(), |k| estimate(net, &Options { seed: base + k as u64, threads: 1, ..opts.clone() }, &mut |_| true).unwrap());
    let d = exact.len();
    let mut covered = vec![[0usize; 6]; d];
    let mut bias = vec![[(0.0, 0.0); 6]; d];
    for i in 0..d {
        for m in 0..6 {
            let errors: Vec<f64> = outcomes.iter().map(|o| measures(&o.stations[i])[m].mean - exact[i][m]).collect();
            covered[i][m] = outcomes.iter().filter(|o| measures(&o.stations[i])[m].covers(exact[i][m])).count();
            let e = Estimate::of(&errors, 1.0);
            bias[i][m] = (e.mean, e.standard_error);
        }
    }
    Coverage { covered, bias, replications: outcomes.iter().map(|o| o.replications as f64).sum::<f64>() / runs() as f64 }
}

/// Every station and measure covers within the band, and prints the counts (`--nocapture`).
fn holds(what: &str, net: &Network, exact: &Exact, opts: &Options, base: u64) {
    let c = coverage(net, exact, opts, base);
    let (runs, band) = (runs(), band());
    let mut failures = Vec::new();
    for (i, row) in c.covered.iter().enumerate() {
        let line: Vec<String> = (0..6).map(|m| format!("{} {}", MEASURES[m], row[m])).collect();
        println!("coverage of {runs} [{what}] station {}: {} (mean replications {})", i + 1, line.join(", "), c.replications);
        for m in 0..6 {
            if !band.contains(&row[m]) {
                failures.push(format!("station {} {}: {} of {runs}", i + 1, MEASURES[m], row[m]));
            }
        }
    }
    assert!(failures.is_empty(), "{what}: coverage outside {band:?}: {failures:?}");
}

/// The quick settings of the default suite: a tenth of the shipped run length.
fn quick() -> Options {
    Options { replications: 10, completions: 20_000, ..Options::default() }
}

experiment!(
    quick_coverage_mm1_at_half_load,
    coverage_mm1_at_half_load,
    {
        holds("M/M/1 ρ=0.5", &mm(0.5, 1.0, 1), &exact_mmc(0.5, 1.0, 1), &quick(), 10_000);
    }
);

/// ρ = 0.9 is where a simulation's interval is easiest to get wrong: the queue's relaxation
/// time is 1/(μ(1 − √ρ)²) = 380 service times (Cohen, The Single Server Queue, §III.7.3), so a
/// replication of 20,000 completions is only 58 relaxation times and its average is visibly
/// skewed. Replications are still independent, which is why the Student interval holds; the run
/// is 10× longer here than in the other quick tests so that its replications are as many
/// relaxation times long as theirs.
/// (Full experiment only: 200,000 completions a replication is too much work for the default
/// suite, and 20,000 is too short at this load for the interval to be held to anything.)
#[test]
#[ignore = "a 200-run coverage experiment: scripts/coverage-experiments.sh"]
fn coverage_mm1_at_ninety_percent_load() {
    full_experiment();
    holds("M/M/1 ρ=0.9", &mm(0.9, 1.0, 1), &exact_mmc(0.9, 1.0, 1), &Options { completions: 200_000, ..quick() }, 20_000);
}

experiment!(
    quick_coverage_mmc,
    coverage_mmc,
    {
        holds("M/M/3 ρ=0.8", &mm(2.4, 1.0, 3), &exact_mmc(2.4, 1.0, 3), &quick(), 30_000);
    }
);

experiment!(
    quick_coverage_jackson_with_feedback,
    coverage_jackson_with_feedback,
    {
        let net = example("OpenJackson.d2.feedback.p50.inf.bnet");
        holds("OpenJackson.d2.feedback.p50", &net, &exact_jackson(&net), &Options { completions: 60_000, ..quick() }, 40_000);
    }
);

experiment!(
    quick_coverage_closed_cycle,
    coverage_closed_cycle,
    {
        let net = cycle([1.0, 1.5, 2.0], [1, 1, 2], 6);
        holds("closed cycle N=6", &net, &exact_closed(&net), &quick(), 50_000);
    }
);

experiment!(
    quick_coverage_bundled_central_server,
    coverage_bundled_central_server,
    {
        let net = example("closed/ClosedCentralServer.d3.N8.bnet");
        holds("ClosedCentralServer.d3.N8", &net, &exact_closed(&net), &quick(), 60_000);
    }
);

/// The shipped defaults (20 replications of 200,000 completions) on every model above.
#[test]
#[ignore = "minutes without optimisation: cargo test --release -p qnet-core simstat -- --ignored --nocapture"]
fn coverage_at_the_default_settings() {
    full_experiment();
    let d = Options::default();
    holds("default M/M/1 ρ=0.5", &mm(0.5, 1.0, 1), &exact_mmc(0.5, 1.0, 1), &d, 110_000);
    holds("default M/M/1 ρ=0.9", &mm(0.9, 1.0, 1), &exact_mmc(0.9, 1.0, 1), &d, 120_000);
    holds("default M/M/3 ρ=0.8", &mm(2.4, 1.0, 3), &exact_mmc(2.4, 1.0, 3), &d, 130_000);
    let j = example("OpenJackson.d2.feedback.p50.inf.bnet");
    holds("default OpenJackson p50", &j, &exact_jackson(&j), &d, 140_000);
    let c = cycle([1.0, 1.5, 2.0], [1, 1, 2], 6);
    holds("default closed cycle", &c, &exact_closed(&c), &d, 150_000);
    let b = example("closed/ClosedCentralServer.d3.N8.bnet");
    holds("default central server", &b, &exact_closed(&b), &d, 160_000);
}

/// Sequential stopping looks at the data to decide when to stop, which costs coverage when the
/// looks are many and the replications few; the rule here starts from at least 10 replications
/// and grows in a few large steps. Held to the same band.
#[test]
#[ignore = "slow without optimisation"]
fn coverage_with_sequential_stopping() {
    full_experiment();
    let o = Options { target: Some(0.03), completions: 20_000, ..Options::default() };
    holds("sequential M/M/1 ρ=0.5", &mm(0.5, 1.0, 1), &exact_mmc(0.5, 1.0, 1), &o, 210_000);
    let c = example("closed/ClosedCentralServer.d3.N8.bnet");
    holds("sequential central server", &c, &exact_closed(&c), &Options { target: Some(0.01), ..o }, 220_000);
}

// ── Warm-up ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn mser_finds_the_end_of_a_transient_and_says_when_it_cannot() {
    // A level series with a ramp in front: the cut is where the ramp ends.
    let noise = |j: usize| ((j * 7919) % 13) as f64 / 13.0 - 0.5;
    let ramp: Vec<f64> = (0..200).map(|j| if j < 30 { 10.0 - j as f64 / 3.0 } else { 0.0 } + noise(j)).collect();
    let d = mser(&ramp);
    assert!((27..=33).contains(&d), "cut at {d}");
    // A stationary series loses next to nothing.
    let flat: Vec<f64> = (0..200).map(|j| 5.0 + noise(j)).collect();
    assert!(mser(&flat) <= 10, "cut at {}", mser(&flat));
    // A series still drifting at its end: the minimum is at the last admissible point.
    let drift: Vec<f64> = (0..200).map(|j| j as f64).collect();
    assert_eq!(mser(&drift), 100);
    assert_eq!(mser(&[1.0, 2.0]), 0);
}

experiment!(
    /// The bias the rule removes. A closed cycle of 200 customers, all starting at S1 (rate 5); S2
    /// (rate 1) is the bottleneck, so in steady state nearly everyone waits at S2 and the exact
    /// L at S1 is 0.25. S1 needs about 200/(5 − 1) = 50 time units to drain, 5 % of a replication of
    /// 3,000 completions. Without deletion the estimate of L at S1 is many standard errors too high
    /// in every run; with MSER on 200 batch means the mean error over 200 runs is within 3 of its standard errors of
    /// zero, and the cut is at least the drain time and not inconclusive.
    quick_the_warm_up_rule_removes_the_initial_transient_bias,
    the_warm_up_rule_removes_the_initial_transient_bias,
    {
        let net = cycle([5.0, 1.0, 5.0], [1, 1, 1], 200);
        let exact = exact_closed(&net);
        let short = Options { replications: 10, completions: 3_000, ..Options::default() };
        let none = coverage(&net, &exact, &Options { warm_up: WarmUp::Fraction(0.0), ..short.clone() }, 70_000);
        let (bias, se) = none.bias[0][0];
        // (20 standard errors over 200 runs is 20·√(12/200) ≈ 5 over the quick check's 12.)
        let (runs, band) = (runs(), band());
        assert!(bias > 2.0 && bias > if is_full() { 20.0 } else { 5.0 } * se, "undeleted: bias {bias} ± {se}");
        assert!(none.covered[0][0] * 10 < runs, "undeleted intervals miss: {} of {runs} cover", none.covered[0][0]);

        let with = coverage(&net, &exact, &short, 70_000);
        let (bias, se) = with.bias[0][0];
        println!("warm-up: L at S1 exact {}, undeleted bias {} ± {}, MSER on 200 batch means bias {bias} ± {se}, coverage {}", exact[0][0], none.bias[0][0].0, none.bias[0][0].1, with.covered[0][0]);
        assert!(bias.abs() <= 3.0 * se, "MSER on 200 batch means: bias {bias} ± {se}");
        assert!(band.contains(&with.covered[0][0]), "MSER on 200 batch means coverage {}", with.covered[0][0]);
        let o = estimate(&net, &Options { threads: 1, ..short }, &mut |_| true).unwrap();
        assert!(o.warm_up_time >= 50.0 && o.warm_up_time < 0.5 * o.run_time && !o.warm_up_inconclusive, "cut at {} of {}", o.warm_up_time, o.run_time);
    }
);

#[test]
fn a_run_too_short_to_show_its_transient_says_so_and_a_fixed_fraction_is_what_it_says() {
    // 2,000 customers leave S1 at rate 1 − 0.2: 2,500 time units, and a replication of 1,000
    // completions is 1,000/0.6 = 1,667 long. The whole run is transient.
    let net = cycle([1.0, 0.2, 1.0], [1, 1, 1], 2_000);
    let o = estimate(&net, &Options { replications: 4, completions: 1_000, threads: 1, ..Options::default() }, &mut |_| true).unwrap();
    assert!(o.warm_up_inconclusive);
    assert!((o.warm_up_time - 0.5 * o.run_time).abs() < 1e-9 * o.run_time, "the fallback deletes half");
    let f = estimate(&mm(0.5, 1.0, 1), &Options { replications: 4, completions: 2_000, warm_up: WarmUp::Fraction(0.25), threads: 1, ..Options::default() }, &mut |_| true).unwrap();
    assert!((f.warm_up_time - 0.25 * f.run_time).abs() < 1e-9 * f.run_time && !f.warm_up_inconclusive);
    // T = completions / Σ X_i.
    assert!((f.run_time - 2_000.0 / 0.5).abs() < 1e-9);
}

// ── Reproducibility, stopping, refusals ─────────────────────────────────────────────────────

#[test]
fn a_seed_gives_the_same_answer_whatever_the_threads_and_another_seed_another() {
    let net = example("closed/ClosedCentralServer.d3.N8.bnet");
    let o = Options { replications: 6, completions: 5_000, ..Options::default() };
    let one = estimate(&net, &Options { threads: 1, ..o.clone() }, &mut |_| true).unwrap();
    let four = estimate(&net, &Options { threads: 4, ..o.clone() }, &mut |_| true).unwrap();
    assert_eq!(one, four);
    assert_eq!(one, estimate(&net, &Options { threads: 0, ..o.clone() }, &mut |_| true).unwrap());
    let other = estimate(&net, &Options { seed: 54_321, ..o }, &mut |_| true).unwrap();
    assert_ne!(one.stations[0].number.mean, other.stations[0].number.mean);
    assert_eq!(one.seeds.len(), 6);
    assert!(one.seeds.iter().collect::<std::collections::HashSet<_>>().len() == 6, "distinct streams");
    // A closed network conserves its customers in every replication, so in the estimate too.
    let total: f64 = one.stations.iter().map(|s| s.number.mean).sum();
    assert!((total - 8.0).abs() < 1e-9, "Σ L = {total}");
    assert_eq!(one.population, Some(8));
}

#[test]
fn sequential_stopping_adds_replications_until_the_target_or_a_cap() {
    let net = mm(0.5, 1.0, 1);
    let base = Options { replications: 4, completions: 5_000, target: Some(0.03), threads: 1, ..Options::default() };
    let met = estimate(&net, &base, &mut |_| true).unwrap();
    assert_eq!(met.stopped, Stopped::TargetMet);
    assert!(met.replications > MIN_SEQUENTIAL_REPLICATIONS && met.relative_half_width.unwrap() <= 0.03, "{} replications, ±{:?}", met.replications, met.relative_half_width);
    let s = &met.stations[0].number;
    assert!(s.half_width() / s.mean <= 0.03);
    // The same seed stops at the same count.
    assert_eq!(met, estimate(&net, &Options { threads: 3, ..base.clone() }, &mut |_| true).unwrap());

    let capped = estimate(&net, &Options { max_replications: 12, ..base.clone() }, &mut |_| true).unwrap();
    assert_eq!((capped.stopped, capped.replications), (Stopped::MaxReplications, 12));
    assert!(capped.relative_half_width.unwrap() > 0.03);

    // 10 replications × 5,000 completions × 2 (arrivals) fit the cap; the next step does not.
    let events = estimate(&net, &Options { max_events: 120_000, ..base.clone() }, &mut |_| true).unwrap();
    assert_eq!((events.stopped, events.replications), (Stopped::MaxEvents, MIN_SEQUENTIAL_REPLICATIONS));
    assert!(events.events <= 120_000);
    assert!(matches!(estimate(&net, &Options { max_events: 50_000, ..base.clone() }, &mut |_| true), Err(Failure::Cap(_))));

    let no_target = estimate(&net, &Options { target: None, ..base }, &mut |_| true).unwrap();
    assert_eq!((no_target.stopped, no_target.replications, no_target.relative_half_width), (Stopped::Fixed, 4, None));
}

#[test]
fn stop_and_the_time_cap_end_the_run() {
    let net = mm(0.5, 1.0, 1);
    let long = Options { replications: 4, completions: 50_000_000, threads: 2, ..Options::default() };
    let mut calls = 0;
    let started = Instant::now();
    let r = estimate(&net, &long, &mut |f| {
        calls += 1;
        assert!((0.0..=1.0).contains(&f));
        calls < 3
    });
    assert_eq!(r, Err(Failure::Stopped));
    assert!(started.elapsed() < Duration::from_secs(20));
    // The wall-time cap ends the adding of replications; the first ones stand, with their intervals.
    let capped = estimate(&net, &Options { replications: 10, completions: 5_000, target: Some(1e-6), max_seconds: 0.0, threads: 2, ..Options::default() }, &mut |_| true).unwrap();
    assert_eq!((capped.stopped, capped.replications), (Stopped::MaxSeconds, 10));
}

#[test]
fn what_cannot_be_estimated_is_refused_with_a_sentence() {
    // Finite buffers: the blocking rule is not part of the network.
    let finite = example("Tandem2.MM1.K5.fin.bnet");
    let r = plan(&finite).unwrap_err();
    assert_eq!((r.code, r.message.as_str()), ("finiteBuffers", FINITE_SENTENCE));
    assert!(matches!(estimate(&finite, &Options::default(), &mut |_| true), Err(Failure::Refused(_))));
    // No steady state.
    let r = plan(&mm(1.2, 1.0, 1)).unwrap_err();
    assert_eq!(r.code, "unstable");
    assert!(r.message.starts_with("No steady state exists: utilisation is 1 or more at S1,"), "{}", r.message);
    assert_eq!(plan(&mm(1.0, 1.0, 1)).unwrap_err().code, "unstable");
    // A closed network without a population is not closed yet.
    let mut bare = cycle([1.0, 1.0, 1.0], [1, 1, 1], 3);
    bare.population = None;
    assert_eq!(plan(&bare).unwrap_err().code, "closed");
    // Options.
    let net = mm(0.5, 1.0, 1);
    for bad in [Options { replications: 1, ..Options::default() }, Options { completions: 10, ..Options::default() }, Options { level: 0.8, ..Options::default() }, Options { warm_up: WarmUp::Fraction(0.95), ..Options::default() }, Options { target: Some(0.0), ..Options::default() }] {
        assert!(matches!(estimate(&net, &bad, &mut |_| true), Err(Failure::Options(_))), "{bad:?}");
    }
    assert_eq!(plan(&net).unwrap(), Plan { stations: 1, population: None, event_rate: 0.5 });
}

/// General service is simulated as drawn: M/G/1 against the Pollaczek–Khinchine formula
/// L = ρ + ρ²(1 + c²)/(2(1 − ρ)) (Kleinrock I, eq. 5.63), here Erlang-2 service (c² = ½), ρ = 0.6.
/// One run at 99 %: a regression check that the estimator reads non-exponential laws, not a
/// coverage experiment.
#[test]
fn an_mg1_queue_is_estimated_at_its_pollaczek_khinchine_value() {
    let net = network(
        vec![node(NodeKind::Source, "A1", Distribution::Poisson, "lambda=0.6", 1), node(NodeKind::Buffer, "B1", Distribution::Exponential, "", 1), node(NodeKind::Station, "S1", Distribution::Erlang, "k=2,rate=2", 1), node(NodeKind::Sink, "Out", Distribution::Exponential, "", 1)],
        vec![link("A1", "B1", 1.0), link("B1", "S1", 1.0), link("S1", "Out", 1.0)],
    );
    let exact = 0.6 + 0.36 * 1.5 / (2.0 * 0.4);
    let o = estimate(&net, &Options { replications: 10, completions: 40_000, level: 0.99, threads: 2, ..Options::default() }, &mut |_| true).unwrap();
    let l = o.stations[0].number;
    assert!(l.covers(exact) && l.half_width() < 0.05 * exact, "L = {} [{}, {}], exact {exact}", l.mean, l.low, l.high);
}

// ── Student's t ─────────────────────────────────────────────────────────────────────────────

/// Against the published table: Abramowitz & Stegun, Handbook of Mathematical Functions,
/// Table 26.10 (percentage points of the t-distribution), columns A = 0.90, 0.95, 0.99, which
/// prints three decimals; the same values are in the NIST/SEMATECH e-Handbook §1.3.6.7.2.
#[test]
fn the_t_quantile_is_the_published_one() {
    let table: [(usize, f64, f64, f64); 16] = [
        (1, 6.314, 12.706, 63.657),
        (2, 2.920, 4.303, 9.925),
        (3, 2.353, 3.182, 5.841),
        (4, 2.132, 2.776, 4.604),
        (5, 2.015, 2.571, 4.032),
        (6, 1.943, 2.447, 3.707),
        (7, 1.895, 2.365, 3.499),
        (8, 1.860, 2.306, 3.355),
        (9, 1.833, 2.262, 3.250),
        (10, 1.812, 2.228, 3.169),
        (15, 1.753, 2.131, 2.947),
        (19, 1.729, 2.093, 2.861),
        (20, 1.725, 2.086, 2.845),
        (30, 1.697, 2.042, 2.750),
        (60, 1.671, 2.000, 2.660),
        (120, 1.658, 1.980, 2.617),
    ];
    for (df, t90, t95, t99) in table {
        for (level, published) in [(0.90, t90), (0.95, t95), (0.99, t99)] {
            let t = t_quantile(df, level).unwrap();
            assert!((t - published).abs() < 6e-4, "t({df}, {level}) = {t}, published {published}");
        }
    }
    // Closed forms: ν = 1 is Cauchy, t = tan(π·level/2); ν = 2 has P(|T| ≤ t) = t/√(2 + t²).
    for level in [0.5, 0.9, 0.95, 0.99] {
        let cauchy = (std::f64::consts::FRAC_PI_2 * level).tan();
        assert!((t_quantile(1, level).unwrap() - cauchy).abs() < 1e-9 * cauchy);
        let two = level * (2.0 / (1.0 - level * level)).sqrt();
        assert!((t_quantile(2, level).unwrap() - two).abs() < 1e-9 * two);
    }
    // Many degrees of freedom: the normal quantiles 1.644854, 1.959964, 2.575829 from above.
    for (level, z) in [(0.90, 1.644_853_627), (0.95, 1.959_963_985), (0.99, 2.575_829_304)] {
        let t = t_quantile(100_000, level).unwrap();
        assert!(t > z && t - z < 1e-4, "t(1e5, {level}) = {t}");
        // Never narrower than normal, and narrowing with every degree of freedom.
        let mut last = f64::INFINITY;
        for df in 1..200 {
            let t = t_quantile(df, level).unwrap();
            assert!(t > z && t < last, "t({df}, {level})");
            last = t;
        }
    }
    // The distribution function itself: P(|T_ν| ≤ 0) = 0, → 1, and the round trip.
    for df in [1u32, 2, 3, 4, 7, 10, 25, 100] {
        assert_eq!(t_central_probability(df, 0.0), 0.0);
        assert!((t_central_probability(df, 1e9) - 1.0).abs() < 1e-8);
        let t = t_quantile(df as usize, 0.95).unwrap();
        assert!((t_central_probability(df, t) - 0.95).abs() < 1e-11);
    }
    assert_eq!(t_quantile(0, 0.95), None);
    assert_eq!(t_quantile(5, 1.0), None);
    // The interval uses it: two values 0 and 2 give 1 ± 12.706·1.
    let e = Estimate::of(&[0.0, 2.0], t_quantile(1, 0.95).unwrap());
    assert!((e.mean - 1.0).abs() < 1e-12 && (e.standard_error - 1.0).abs() < 1e-12 && (e.half_width() - 12.706_204_736).abs() < 1e-6);
}
