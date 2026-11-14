//! Steady-state estimates with confidence intervals from the discrete-event simulator of
//! `sim.rs` (new in 2.1, ledger SIM-101…): the arithmetic of the method "Replicated Simulation"
//! (`sim_inproc`, runner `methods/siminproc.rs`). `sim.rs` alone is one random run for a picture;
//! this file turns many runs into numbers that say how sure they are.
//!
//! **The estimator: independent replications with a deleted initial transient.**
//!
//! 1. R replications are run, each from its own seed (SplitMix64 of the base seed, so a seed
//!    gives the same answer on every machine and with any number of threads), each for the same
//!    model time T. T is chosen so that a replication holds a stated number of service
//!    completions in the long run: T = completions / Σ_i X_i, with the X_i of the traffic
//!    equations (open) or of the exact closed solution's visit rates (closed).
//! 2. Each replication is cut into [`BATCHES`] × 5 equal time slices and the time-average number
//!    at each station is taken over each; five consecutive slices make one batch mean.
//! 3. **Warm-up, by MSER on 200 batch means.** The MSER statistic is White's ("An effective
//!    truncation heuristic for bias reduction in simulation output", Simulation 69(6), 1997;
//!    White, Cobb & Spratt, WSC 2000). It is *not* the rule those papers call MSER-5 (batches
//!    of five raw observations of one run): here the series is [`BATCHES`] time-batch means of
//!    fixed length, of the process averaged over the replications. For a station,
//!    with Z_1 … Z_n its batch means *averaged over the replications* (Welch's averaging: the
//!    average is smooth, so the cut is a property of the model and not of one run's noise), the
//!    cut is the d in 0..=n/2 that minimises
//!
//!    ```text
//!    MSER(d) = Σ_{j>d} (Z_j − mean(Z_{d+1..n}))² / (n − d)²
//!    ```
//!
//!    the squared standard error of the mean of what is kept. The latest cut over the stations
//!    is deleted from every replication, so all replications are cut at the same time (a closed
//!    network's total number is constant, which is why the rule looks at each station and not at
//!    the total). A minimum at n/2, the last point the rule may choose, means the run is too
//!    short to show where the transient ends: half of each replication is deleted (the fixed
//!    fraction fallback) and the outcome says so ([`Outcome::warm_up_inconclusive`]).
//!    [`WarmUp::Fraction`] deletes a stated fraction instead.
//! 4. Per replication r and station i, over what is kept (length τ):
//!    L = ∫N dt/τ (mean number), Lq = ∫(number waiting) dt/τ, utilisation = (L − Lq)/c (the mean
//!    fraction of busy servers), X = departures/τ, and the customer averages by Little's law
//!    within the window, W = ∫N dt/departures (time at the station per visit) and
//!    Wq = ∫(number waiting) dt/departures. W differs from the average of the observed sojourn
//!    times only by the customers present at the window's two ends, O(1/τ). W and Wq are given
//!    only when every replication saw a departure from the station.
//! 5. The estimate is the mean of the R replication values, and the interval is Student's:
//!    mean ± t_{R−1, 1−α/2}·s/√R at 90, 95 or 99 % ([`t_quantile`], exact for whole degrees of
//!    freedom; never the normal quantile). Replications are independent and identically
//!    distributed by construction, which is the whole point of the method: the only
//!    approximation in the interval is that a replication's average is close to normal, and that
//!    is what long replications buy. The tests below measure the coverage.
//!
//! **Sequential stopping (optional).** With a target relative half-width γ, replications are
//! added until every station's mean number has half-width ≤ γ·|estimate|, in a few large steps
//! (the count the current variance predicts, at least half as many again, at most four times as
//! many — few looks, because every look at the data costs a little coverage), up to hard caps on
//! replications, events and wall time. The first replications are always run whole (the event
//! cap refuses a first batch that is too large before it starts; Stop ends one that is too slow). The replication count depends only on the seed unless
//! the wall-time cap stops the run, and the outcome says which rule stopped it.
//!
//! **What is refused.** Whatever `sim::Simulator` refuses (finite buffers: the blocking rule is
//! not part of the network), a network with a station at utilisation ≥ 1, which has no
//! steady state to estimate, and a network with a time-varying arrival rate, which has no
//! single steady state either ([`transient_means`] is the estimator for it).
//!
//! **Per class** (new with priorities, ledger SCI-1005). Where a station serves several classes
//! the same estimator gives, for each class, the mean number of that class at the station and,
//! by Little's law within the window, its mean time there (∫N_k dt / departures of class k).
//!
//! **The mean at a time t** ([`transient_means`], ledger SCI-1023): for a network that has no
//! steady state to average over (a time-varying arrival rate), R independent replications are
//! run from the empty network and the number at each station is read at each requested time.
//! The R readings at one time are independent and identically distributed, so their mean
//! estimates E[N_i(t)] without bias and the interval is Student's across replications. A single
//! reading is a small whole number, far from normal, so R must be large for the interval to
//! hold its level: at least [`MIN_TRANSIENT_REPLICATIONS`], and the tests measure the coverage
//! against the exact transient solution of `transient.rs`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::model::Network;
use crate::sim::{Refusal, Simulator};
use crate::uncertainty::splitmix64;

/// Batch means per replication (each of five time slices); the warm-up rule is MSER on these.
pub const BATCHES: usize = 200;
/// The default replications, completions per replication and fixed warm-up fraction.
pub const DEFAULT_REPLICATIONS: usize = 20;
pub const DEFAULT_COMPLETIONS: u64 = 200_000;
pub const DEFAULT_FRACTION: f64 = 0.1;
/// Fewer replications than this give a variance estimate too poor to stop on.
pub const MIN_SEQUENTIAL_REPLICATIONS: usize = 10;
pub const MAX_REPLICATIONS: usize = 10_000;
pub const DEFAULT_MAX_EVENTS: u64 = 2_000_000_000;
pub const DEFAULT_MAX_SECONDS: f64 = 60.0;

pub const FINITE_SENTENCE: &str = "Replicated Simulation covers infinite buffers. With finite buffers what happens at a full buffer depends on a blocking rule (loss, or blocking after service) that is chosen for each run and is not part of the network. Use Monte Carlo for a finite-buffer network: it asks for the rule.";

pub const TIME_VARYING_SENTENCE: &str = "This network has a time-varying arrival rate, so it has no single steady state for a long-run average to estimate. The Transient view computes how the mean numbers move in time, and Run ▸ Animate shows it.";
/// The fewest replications `transient_means` accepts.
pub const MIN_TRANSIENT_REPLICATIONS: usize = 100;

// ── Student's t ─────────────────────────────────────────────────────────────────────────────

/// P(|T_ν| ≤ t) for Student's t with ν ≥ 1 whole degrees of freedom, t ≥ 0: the finite sums of
/// Abramowitz & Stegun 26.7.3 and 26.7.4. With θ = atan(t/√ν):
///
/// - ν = 1: 2θ/π;
/// - ν odd: (2/π)·[θ + sin θ·(cos θ + (2/3)cos³θ + … + (2·4···(ν−3))/(3·5···(ν−2))·cos^{ν−2}θ)];
/// - ν even: sin θ·[1 + (1/2)cos²θ + (1·3)/(2·4)cos⁴θ + … + (1·3···(ν−3))/(2·4···(ν−2))·cos^{ν−2}θ].
pub fn t_central_probability(df: u32, t: f64) -> f64 {
    let nu = df as f64;
    let theta = (t / nu.sqrt()).atan();
    let (s, c) = (theta.sin(), theta.cos());
    let c2 = c * c;
    if df % 2 == 1 {
        let mut sum = 0.0;
        if df > 1 {
            let mut term = c;
            sum = term;
            let mut k = 3.0;
            while k <= nu - 2.0 {
                term *= c2 * (k - 1.0) / k;
                sum += term;
                k += 2.0;
            }
        }
        std::f64::consts::FRAC_2_PI * (theta + s * sum)
    } else {
        let mut term = 1.0;
        let mut sum = 1.0;
        let mut k = 2.0;
        while k <= nu - 2.0 {
            term *= c2 * (k - 1.0) / k;
            sum += term;
            k += 2.0;
        }
        s * sum
    }
}

/// The two-sided Student quantile: the t with P(|T_ν| ≤ t) = `level` (0.95 gives t_{ν, 0.975}).
/// Bisection on the exact distribution function above, to 1e-12 relative. `None` for ν = 0 or a
/// level outside (0, 1).
pub fn t_quantile(df: usize, level: f64) -> Option<f64> {
    if df == 0 || !(level > 0.0 && level < 1.0) {
        return None;
    }
    // Beyond this the sum is long and the answer is the normal quantile to 7 digits anyway;
    // the last tabled row stands in (it errs on the wide side).
    let df = df.min(1_000_000) as u32;
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    while t_central_probability(df, hi) < level {
        hi *= 2.0;
        if hi > 1e300 {
            return None;
        }
    }
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if t_central_probability(df, mid) < level {
            lo = mid;
        } else {
            hi = mid;
        }
        if hi - lo <= 1e-13 * hi {
            break;
        }
    }
    Some(0.5 * (lo + hi))
}

// ── MSER ────────────────────────────────────────────────────────────────────────────────────

/// The MSER truncation point of a series of batch means: the d in 0..=n/2 minimising
/// Σ_{j>d}(z_j − mean)²/(n − d)², the smallest such d. 0 for a series shorter than 4.
pub fn mser(z: &[f64]) -> usize {
    let n = z.len();
    if n < 4 {
        return 0;
    }
    // Suffix sums, so each candidate costs O(1).
    let (mut s1, mut s2) = (0.0, 0.0);
    let mut suffix = vec![(0.0, 0.0); n + 1];
    for j in (0..n).rev() {
        s1 += z[j];
        s2 += z[j] * z[j];
        suffix[j] = (s1, s2);
    }
    let mut best = (f64::INFINITY, 0);
    for d in 0..=n / 2 {
        let m = (n - d) as f64;
        let (a, b) = suffix[d];
        let ss = (b - a * a / m).max(0.0);
        let g = ss / (m * m);
        if g < best.0 {
            best = (g, d);
        }
    }
    best.1
}

// ── Options and outcome ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WarmUp {
    /// MSER on 200 batch means on the replication-averaged number at each station; the latest cut.
    Mser,
    /// Delete this fraction (0 ≤ f < 1) of every replication.
    Fraction(f64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    /// Replications (the first batch of them, with sequential stopping). At least 2.
    pub replications: usize,
    /// Service completions per replication over the whole network, in the long run.
    pub completions: u64,
    pub warm_up: WarmUp,
    pub seed: u64,
    /// 0.90, 0.95 or 0.99.
    pub level: f64,
    /// Sequential stopping: the relative half-width every station's mean number must reach.
    pub target: Option<f64>,
    pub max_replications: usize,
    /// Hard cap on arrivals and service completions simulated in all.
    pub max_events: u64,
    /// Hard cap on wall time, seconds, for the adding of replications (sequential stopping).
    pub max_seconds: f64,
    /// Worker threads; 0 takes the machine's. The answer does not depend on it.
    pub threads: usize,
}

impl Default for Options {
    fn default() -> Options {
        Options { replications: DEFAULT_REPLICATIONS, completions: DEFAULT_COMPLETIONS, warm_up: WarmUp::Mser, seed: 12_345, level: 0.95, target: None, max_replications: MAX_REPLICATIONS, max_events: DEFAULT_MAX_EVENTS, max_seconds: DEFAULT_MAX_SECONDS, threads: 0 }
    }
}

/// A mean over replications with its Student interval.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Estimate {
    pub mean: f64,
    pub standard_error: f64,
    pub low: f64,
    pub high: f64,
}

impl Estimate {
    /// From the replication values, with the two-sided quantile `t` for their count less one.
    pub fn of(values: &[f64], t: f64) -> Estimate {
        let n = values.len() as f64;
        let mean = values.iter().sum::<f64>() / n;
        let var = if values.len() > 1 { values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / (n - 1.0) } else { 0.0 };
        let se = (var / n).sqrt();
        Estimate { mean, standard_error: se, low: mean - t * se, high: mean + t * se }
    }

    pub fn half_width(&self) -> f64 {
        (self.high - self.low) / 2.0
    }

    pub fn covers(&self, x: f64) -> bool {
        self.low <= x && x <= self.high
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StationEstimates {
    pub id: String,
    pub name: String,
    pub servers: usize,
    /// L: mean number at the station, customers.
    pub number: Estimate,
    /// Lq: mean number waiting, customers.
    pub queue: Estimate,
    /// Mean fraction of busy servers.
    pub utilisation: Estimate,
    /// Service completions per time unit.
    pub throughput: Estimate,
    /// W: mean time at the station per visit; None when a replication saw no departure.
    pub sojourn: Option<Estimate>,
    /// Wq: mean wait before service per visit.
    pub waiting: Option<Estimate>,
    /// Per class, when the station's network has more than one (else empty).
    pub classes: Vec<ClassEstimates>,
}

/// One class at one station.
#[derive(Clone, Debug, PartialEq)]
pub struct ClassEstimates {
    /// The network's class index (0-based).
    pub class: usize,
    /// Mean number of this class at the station, customers.
    pub number: Estimate,
    /// Its service completions per time unit.
    pub throughput: Estimate,
    /// Its mean time at the station per visit; None when a replication saw no departure of it.
    pub sojourn: Option<Estimate>,
}

/// Why the run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    /// The stated number of replications was run (no target).
    Fixed,
    TargetMet,
    MaxReplications,
    MaxEvents,
    MaxSeconds,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub stations: Vec<StationEstimates>,
    pub replications: usize,
    pub level: f64,
    /// The Student quantile used, t_{R−1, (1+level)/2}.
    pub t: f64,
    /// Model time per replication, and how much of it was deleted from the start.
    pub run_time: f64,
    pub warm_up_time: f64,
    /// MSER found its minimum at the last admissible point: the run is too short for the rule.
    pub warm_up_inconclusive: bool,
    /// Arrivals and service completions simulated in all.
    pub events: u64,
    pub stopped: Stopped,
    /// With a target: the largest relative half-width of a station's mean number at the end.
    pub relative_half_width: Option<f64>,
    pub population: Option<usize>,
    pub seeds: Vec<u64>,
}

/// Why no estimate was made.
#[derive(Clone, Debug, PartialEq)]
pub enum Failure {
    /// The network is not one this method simulates.
    Refused(Refusal),
    /// The options are not usable (a sentence).
    Options(String),
    /// `progress` asked to stop.
    Stopped,
    /// The first replications alone are more than the cap on events.
    Cap(String),
    /// The run did not behave as a stable network's does (a sentence).
    Run(String),
}

impl Failure {
    pub fn message(&self) -> String {
        match self {
            Failure::Refused(r) => r.message.clone(),
            Failure::Options(s) | Failure::Cap(s) | Failure::Run(s) => s.clone(),
            Failure::Stopped => "Stopped.".into(),
        }
    }
}

/// What a run of this network would be: the simulator's layout facts the method needs.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub stations: usize,
    pub population: Option<usize>,
    /// Service completions per time unit over the network in the long run.
    pub event_rate: f64,
}

/// Whether the method applies to `net`, and if not the sentence that says why.
pub fn plan(net: &Network) -> Result<Plan, Refusal> {
    let sim = Simulator::new(net, 0).map_err(|r| if r.code == "finiteBuffers" { Refusal { code: r.code, message: FINITE_SENTENCE.into() } } else { r })?;
    let layout = sim.layout();
    if crate::extended::uses(net, crate::extended::Feature::TimeVaryingRates) {
        return Err(Refusal { code: "timeVarying", message: TIME_VARYING_SENTENCE.into() });
    }
    if !layout.unstable.is_empty() {
        let names = layout.unstable.join(", ");
        return Err(Refusal { code: "unstable", message: format!("No steady state exists: utilisation is 1 or more at {names}, so the queue there grows without bound and a long-run average has nothing to converge to. Lower the load or add servers; Run ▸ Animate shows the queue growing.") });
    }
    if !(layout.event_rate.is_finite() && layout.event_rate > 0.0) {
        return Err(Refusal { code: "network", message: "Nothing flows through this network (every throughput is zero), so there is nothing to simulate.".into() });
    }
    Ok(Plan { stations: layout.stations.len(), population: layout.population, event_rate: layout.event_rate })
}

/// The seed of replication `r` (0-based) of base seed `seed`.
pub fn replication_seed(seed: u64, r: usize) -> u64 {
    let mut state = seed ^ 0x51D_1A7E_5EED_u64.wrapping_mul(r as u64 + 1);
    splitmix64(&mut state)
}

// ── One replication ─────────────────────────────────────────────────────────────────────────

/// Cumulative totals at the batch boundaries 0..=BATCHES, per station.
struct Series {
    number: Vec<Vec<f64>>,
    queue: Vec<Vec<f64>>,
    departures: Vec<Vec<u64>>,
    /// `[boundary][station][class]`; empty rows when the network has one class.
    class_number: Vec<Vec<Vec<f64>>>,
    class_departures: Vec<Vec<Vec<u64>>>,
    steps: u64,
}

fn replicate(net: &Network, seed: u64, run_time: f64, max_steps: u64, stop: &AtomicBool, done: &AtomicUsize) -> Result<Series, Failure> {
    let mut sim = Simulator::new(net, seed).map_err(Failure::Refused)?;
    let d = sim.layout().stations.len();
    let classes = sim.layout().classes;
    let mut s = Series { number: Vec::with_capacity(BATCHES + 1), queue: Vec::with_capacity(BATCHES + 1), departures: Vec::with_capacity(BATCHES + 1), class_number: Vec::new(), class_departures: Vec::new(), steps: 0 };
    if classes > 1 {
        s.class_number.push(vec![vec![0.0; classes]; d]);
        s.class_departures.push(vec![vec![0; classes]; d]);
    }
    s.number.push(vec![0.0; d]);
    s.queue.push(vec![0.0; d]);
    s.departures.push(vec![0; d]);
    for b in 1..=BATCHES {
        if stop.load(Ordering::Relaxed) {
            return Err(Failure::Stopped);
        }
        let until = run_time * b as f64 / BATCHES as f64;
        let left = max_steps.saturating_sub(s.steps);
        s.steps += sim.skip(left.min(usize::MAX as u64) as usize, until) as u64;
        if sim.halted().is_some() || sim.time() < until {
            return Err(Failure::Run("The run produced far more events than a stable network of this size should, and was stopped. Check the loads with Network ▸ Analyze.".into()));
        }
        let st = sim.stats();
        s.number.push(st.area_number);
        s.queue.push(st.area_queue);
        s.departures.push(st.departures);
        if classes > 1 {
            s.class_number.push(st.area_class);
            s.class_departures.push(st.departures_class);
        }
        done.fetch_add(1, Ordering::Relaxed);
    }
    Ok(s)
}

/// A replication's values over the window from batch `cut` to the end, per station:
/// (L, Lq, X, ∫N, ∫Nq, departures).
struct Values {
    number: Vec<f64>,
    queue: Vec<f64>,
    throughput: Vec<f64>,
    departures: Vec<u64>,
    /// `[station][class]`: mean number and departures of the class over the window.
    class_number: Vec<Vec<f64>>,
    class_departures: Vec<Vec<u64>>,
    tau: f64,
}

fn reduce(s: &Series, cut: usize, run_time: f64) -> Values {
    let tau = run_time * (BATCHES - cut) as f64 / BATCHES as f64;
    let d = s.number[0].len();
    let dn: Vec<f64> = (0..d).map(|i| s.number[BATCHES][i] - s.number[cut][i]).collect();
    let dq: Vec<f64> = (0..d).map(|i| s.queue[BATCHES][i] - s.queue[cut][i]).collect();
    let dep: Vec<u64> = (0..d).map(|i| s.departures[BATCHES][i] - s.departures[cut][i]).collect();
    let (class_number, class_departures) = if s.class_number.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let k = s.class_number[0][0].len();
        ((0..d).map(|i| (0..k).map(|c| (s.class_number[BATCHES][i][c] - s.class_number[cut][i][c]) / tau).collect()).collect(), (0..d).map(|i| (0..k).map(|c| s.class_departures[BATCHES][i][c] - s.class_departures[cut][i][c]).collect()).collect())
    };
    Values { number: dn.iter().map(|x| x / tau).collect(), queue: dq.iter().map(|x| x / tau).collect(), throughput: dep.iter().map(|x| *x as f64 / tau).collect(), departures: dep, class_number, class_departures, tau }
}

/// Runs replications `from..to` on up to `threads` threads; `tick` is called a few times a
/// second with the batches finished in this call and returns false to stop.
fn run_round(net: &Network, opts: &Options, from: usize, to: usize, run_time: f64, max_steps: u64, threads: usize, tick: &mut dyn FnMut(usize) -> bool) -> Result<Vec<Series>, Failure> {
    let count = to - from;
    let stop = AtomicBool::new(false);
    let done = AtomicUsize::new(0);
    let next = AtomicUsize::new(0);
    let finished = AtomicUsize::new(0);
    let slots: Mutex<Vec<Option<Result<Series, Failure>>>> = Mutex::new((0..count).map(|_| None).collect());
    let workers = threads.clamp(1, count.max(1));
    let mut asked_to_stop = false;
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let k = next.fetch_add(1, Ordering::Relaxed);
                    if k >= count {
                        break;
                    }
                    let r = replicate(net, replication_seed(opts.seed, from + k), run_time, max_steps, &stop, &done);
                    if r.is_err() {
                        stop.store(true, Ordering::Relaxed);
                    }
                    slots.lock().unwrap_or_else(|p| p.into_inner())[k] = Some(r);
                }
                finished.fetch_add(1, Ordering::Relaxed);
            });
        }
        while finished.load(Ordering::Relaxed) < workers {
            std::thread::sleep(Duration::from_millis(2));
            if !asked_to_stop && !tick(done.load(Ordering::Relaxed)) {
                asked_to_stop = true;
                stop.store(true, Ordering::Relaxed);
            }
        }
    });
    if asked_to_stop {
        return Err(Failure::Stopped);
    }
    let slots = slots.into_inner().unwrap_or_else(|p| p.into_inner());
    // A real failure before a consequent "stopped".
    if let Some(e) = slots.iter().filter_map(|s| s.as_ref().and_then(|r| r.as_ref().err())).find(|e| **e != Failure::Stopped) {
        return Err(e.clone());
    }
    slots.into_iter().map(|s| s.unwrap_or(Err(Failure::Stopped))).collect()
}

fn summarise(values: &[Values], servers: &[usize], t: f64) -> Vec<(Estimate, Estimate, Estimate, Estimate, Option<Estimate>, Option<Estimate>)> {
    let d = servers.len();
    (0..d)
        .map(|i| {
            let col = |f: &dyn Fn(&Values) -> f64| -> Vec<f64> { values.iter().map(f).collect() };
            let number = Estimate::of(&col(&|v| v.number[i]), t);
            let queue = Estimate::of(&col(&|v| v.queue[i]), t);
            let util = Estimate::of(&col(&|v| (v.number[i] - v.queue[i]) / servers[i].max(1) as f64), t);
            let throughput = Estimate::of(&col(&|v| v.throughput[i]), t);
            let seen = values.iter().all(|v| v.departures[i] > 0);
            let sojourn = seen.then(|| Estimate::of(&col(&|v| v.number[i] / v.throughput[i]), t));
            let waiting = seen.then(|| Estimate::of(&col(&|v| v.queue[i] / v.throughput[i]), t));
            (number, queue, util, throughput, sojourn, waiting)
        })
        .collect()
}

/// The largest relative half-width of a station's mean number (stations whose mean is 0 in
/// every replication have nothing to estimate and are left out).
fn worst_relative(values: &[Values], t: f64) -> f64 {
    let d = values[0].number.len();
    (0..d)
        .filter_map(|i| {
            let e = Estimate::of(&values.iter().map(|v| v.number[i]).collect::<Vec<_>>(), t);
            (e.mean.abs() > 0.0).then(|| e.half_width() / e.mean.abs())
        })
        .fold(0.0, f64::max)
}

/// The estimates for `net`. `progress(fraction)` is called a few times a second from the calling
/// thread and returns false to stop.
pub fn estimate(net: &Network, opts: &Options, progress: &mut dyn FnMut(f64) -> bool) -> Result<Outcome, Failure> {
    let plan = plan(net).map_err(Failure::Refused)?;
    if opts.replications < 2 {
        return Err(Failure::Options("At least 2 replications are needed: an interval comes from the spread between replications.".into()));
    }
    if opts.completions < 1_000 {
        return Err(Failure::Options("A replication needs at least 1,000 service completions to mean anything.".into()));
    }
    if ![0.90, 0.95, 0.99].iter().any(|l| (opts.level - l).abs() < 1e-9) {
        return Err(Failure::Options("The confidence level is 90, 95 or 99 %.".into()));
    }
    if let WarmUp::Fraction(f) = opts.warm_up {
        if !(0.0..=0.9).contains(&f) {
            return Err(Failure::Options("The warm-up fraction is between 0 and 0.9.".into()));
        }
    }
    if let Some(g) = opts.target {
        if !(g > 0.0 && g < 1.0) {
            return Err(Failure::Options("The target relative half-width is between 0 and 1 (0.02 is ±2 %).".into()));
        }
    }
    let first = if opts.target.is_some() { opts.replications.max(MIN_SEQUENTIAL_REPLICATIONS) } else { opts.replications };
    let max_replications = opts.max_replications.clamp(first, MAX_REPLICATIONS.max(first));
    // A replication simulates about `completions` service completions and, in an open network,
    // as many arrivals again at most.
    let steps_per_replication = opts.completions.saturating_mul(if plan.population.is_some() { 1 } else { 2 });
    if steps_per_replication.saturating_mul(first as u64) > opts.max_events {
        return Err(Failure::Cap(format!("{first} replications of {} completions are more than the cap of {} events. Shorten the run or raise the cap.", opts.completions, opts.max_events)));
    }
    let run_time = opts.completions as f64 / plan.event_rate;
    let threads = if opts.threads == 0 { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) } else { opts.threads };
    let started = Instant::now();
    // Far above what a stable run needs; a run that reaches it is refused rather than left to spin.
    let step_guard = steps_per_replication.saturating_mul(20).saturating_add(1_000_000);

    let mut out_of_time = false;
    let mut batches_before = 0usize;
    let mut planned = first;
    // The wall-time cap stops the adding of replications, never the first ones: what the caller
    // asked for outright is run (Stop ends it), and bounded by the cap on events.
    let mut round = |from: usize, to: usize, planned: usize, batches_before: usize, out_of_time: &mut bool| -> Result<Vec<Series>, Failure> {
        let r = run_round(net, opts, from, to, run_time, step_guard, threads, &mut |done| {
            if from > 0 && started.elapsed().as_secs_f64() > opts.max_seconds {
                *out_of_time = true;
                return false;
            }
            progress(((batches_before + done) as f64 / (planned * BATCHES) as f64).min(1.0))
        });
        match r {
            Err(Failure::Stopped) if *out_of_time => Err(Failure::Cap(String::new())),
            other => other,
        }
    };

    // The first replications, whole, for the warm-up rule.
    let pilot = round(0, first, planned, batches_before, &mut out_of_time)?;
    batches_before += first * BATCHES;
    let d = plan.stations;
    let (cut, inconclusive) = match opts.warm_up {
        WarmUp::Fraction(f) => ((f * BATCHES as f64).ceil() as usize, false),
        WarmUp::Mser => {
            let mut cut = 0;
            for i in 0..d {
                let z: Vec<f64> = (1..=BATCHES).map(|b| pilot.iter().map(|s| s.number[b][i] - s.number[b - 1][i]).sum::<f64>()).collect();
                cut = cut.max(mser(&z));
            }
            (cut, cut >= BATCHES / 2)
        }
    };
    let mut events: u64 = pilot.iter().map(|s| s.steps).sum();
    let mut values: Vec<Values> = pilot.iter().map(|s| reduce(s, cut, run_time)).collect();
    drop(pilot);

    let quantile = |n: usize| t_quantile(n - 1, opts.level).expect("a tabled level and at least two replications");
    let mut stopped = Stopped::Fixed;
    let mut relative = None;
    if let Some(target) = opts.target {
        loop {
            let n = values.len();
            let rel = worst_relative(&values, quantile(n));
            relative = Some(rel);
            if rel <= target {
                stopped = Stopped::TargetMet;
                break;
            }
            if n >= max_replications {
                stopped = Stopped::MaxReplications;
                break;
            }
            // The count the present variance predicts, in a few large steps.
            let predicted = (n as f64 * (rel / target).powi(2) * 1.1).ceil() as usize;
            let next = predicted.clamp(n + (n / 2).max(1), 4 * n).min(max_replications);
            let per = events / n as u64;
            if events.saturating_add(per.saturating_mul((next - n) as u64)) > opts.max_events {
                stopped = Stopped::MaxEvents;
                break;
            }
            if started.elapsed().as_secs_f64() > opts.max_seconds {
                stopped = Stopped::MaxSeconds;
                break;
            }
            planned = next;
            match round(n, next, planned, batches_before, &mut out_of_time) {
                Ok(more) => {
                    batches_before += more.len() * BATCHES;
                    events += more.iter().map(|s| s.steps).sum::<u64>();
                    values.extend(more.iter().map(|s| reduce(s, cut, run_time)));
                }
                // Out of time in the middle of a step: what was complete before it stands.
                Err(Failure::Cap(_)) => {
                    stopped = Stopped::MaxSeconds;
                    break;
                }
                Err(e) => return Err(e),
            }
        }
    }

    let n = values.len();
    let t = quantile(n);
    let sim = Simulator::new(net, 0).map_err(Failure::Refused)?;
    let layout = sim.layout();
    let servers: Vec<usize> = layout.stations.iter().map(|s| s.servers).collect();
    let stations = summarise(&values, &servers, t)
        .into_iter()
        .zip(&layout.stations)
        .enumerate()
        .map(|(i, ((number, queue, utilisation, throughput, sojourn, waiting), s))| {
            // Classes that never visit the station have nothing to estimate and are left out.
            let classes = if values[0].class_number.is_empty() {
                Vec::new()
            } else {
                (0..values[0].class_number[i].len())
                    .filter(|&c| values.iter().any(|v| v.class_number[i][c] > 0.0 || v.class_departures[i][c] > 0))
                    .map(|c| {
                        let col = |f: &dyn Fn(&Values) -> f64| -> Vec<f64> { values.iter().map(f).collect() };
                        let seen = values.iter().all(|v| v.class_departures[i][c] > 0);
                        ClassEstimates {
                            class: c,
                            number: Estimate::of(&col(&|v| v.class_number[i][c]), t),
                            throughput: Estimate::of(&col(&|v| v.class_departures[i][c] as f64 / v.tau), t),
                            sojourn: seen.then(|| Estimate::of(&col(&|v| v.class_number[i][c] * v.tau / v.class_departures[i][c] as f64), t)),
                        }
                    })
                    .collect()
            };
            StationEstimates { id: s.id.clone(), name: s.name.clone(), servers: s.servers, number, queue, utilisation, throughput, sojourn, waiting, classes }
        })
        .collect();
    Ok(Outcome {
        stations,
        replications: n,
        level: opts.level,
        t,
        run_time,
        warm_up_time: run_time * cut as f64 / BATCHES as f64,
        warm_up_inconclusive: inconclusive,
        events,
        stopped,
        relative_half_width: relative,
        population: plan.population,
        seeds: (0..n).map(|r| replication_seed(opts.seed, r)).collect(),
    })
}

// ── The mean at a time ──────────────────────────────────────────────────────────────────────

/// E[N_i(t)] estimated at each requested time.
#[derive(Clone, Debug, PartialEq)]
pub struct TransientOutcome {
    pub times: Vec<f64>,
    /// `[station][time]`, stations in export order.
    pub mean: Vec<Vec<Estimate>>,
    pub station_ids: Vec<String>,
    pub station_names: Vec<String>,
    pub replications: usize,
    pub level: f64,
    pub t: f64,
    /// Arrivals and service completions simulated in all.
    pub events: u64,
}

/// The mean number at each station at each of `times` (ascending, ≥ 0), from `replications`
/// independent runs started empty (module text). `progress(fraction)` returns false to stop.
/// Unlike [`estimate`] this takes a network with a time-varying arrival rate, and an unstable one.
pub fn transient_means(net: &Network, times: &[f64], replications: usize, seed: u64, level: f64, threads: usize, progress: &mut dyn FnMut(f64) -> bool) -> Result<TransientOutcome, Failure> {
    let probe = Simulator::new(net, 0).map_err(|r| Failure::Refused(if r.code == "finiteBuffers" { Refusal { code: r.code, message: FINITE_SENTENCE.into() } } else { r }))?;
    if probe.layout().population.is_some() {
        return Err(Failure::Refused(Refusal { code: "closed", message: "The mean at a time is estimated for open networks, started empty.".into() }));
    }
    if replications < MIN_TRANSIENT_REPLICATIONS {
        return Err(Failure::Options(format!("At least {MIN_TRANSIENT_REPLICATIONS} replications are needed: each gives one whole number per station and time, and the interval is only as good as their average is normal.")));
    }
    if times.is_empty() || times.iter().any(|t| !(t.is_finite() && *t >= 0.0)) || times.windows(2).any(|w| w[1] < w[0]) {
        return Err(Failure::Options("The times must be non-negative numbers in ascending order.".into()));
    }
    if ![0.90, 0.95, 0.99].iter().any(|l| (level - l).abs() < 1e-9) {
        return Err(Failure::Options("The confidence level is 90, 95 or 99 %.".into()));
    }
    let d = probe.layout().stations.len();
    let workers = (if threads == 0 { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) } else { threads }).clamp(1, replications);
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let finished = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    // Per replication: [time][station] readings, and its steps.
    let slots: Mutex<Vec<Option<Result<(Vec<Vec<u32>>, u64), Failure>>>> = Mutex::new((0..replications).map(|_| None).collect());
    let mut asked_to_stop = false;
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let r = next.fetch_add(1, Ordering::Relaxed);
                    if r >= replications || stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let one = (|| {
                        let mut sim = Simulator::new(net, replication_seed(seed, r)).map_err(Failure::Refused)?;
                        let mut steps = 0u64;
                        let mut rows = Vec::with_capacity(times.len());
                        for &t in times {
                            if stop.load(Ordering::Relaxed) {
                                return Err(Failure::Stopped);
                            }
                            steps += sim.skip(usize::MAX, t) as u64;
                            if sim.halted().is_some() {
                                return Err(Failure::Run("A queue grew past a million waiting customers before the last time asked for, and the run was stopped. Shorten the horizon or lower the load.".into()));
                            }
                            rows.push(sim.numbers().into_iter().map(|n| n as u32).collect());
                        }
                        Ok((rows, steps))
                    })();
                    if one.is_err() {
                        stop.store(true, Ordering::Relaxed);
                    }
                    slots.lock().unwrap_or_else(|p| p.into_inner())[r] = Some(one);
                    done.fetch_add(1, Ordering::Relaxed);
                }
                finished.fetch_add(1, Ordering::Relaxed);
            });
        }
        while finished.load(Ordering::Relaxed) < workers {
            std::thread::sleep(Duration::from_millis(2));
            if !asked_to_stop && !progress(done.load(Ordering::Relaxed) as f64 / replications as f64) {
                asked_to_stop = true;
                stop.store(true, Ordering::Relaxed);
            }
        }
    });
    if asked_to_stop {
        return Err(Failure::Stopped);
    }
    let slots = slots.into_inner().unwrap_or_else(|p| p.into_inner());
    if let Some(e) = slots.iter().filter_map(|s| s.as_ref().and_then(|r| r.as_ref().err())).find(|e| **e != Failure::Stopped) {
        return Err(e.clone());
    }
    let runs: Vec<(Vec<Vec<u32>>, u64)> = slots.into_iter().map(|s| s.unwrap_or(Err(Failure::Stopped))).collect::<Result<_, _>>()?;
    let t = t_quantile(replications - 1, level).expect("a tabled level and many replications");
    let mean = (0..d).map(|i| (0..times.len()).map(|k| Estimate::of(&runs.iter().map(|(rows, _)| rows[k][i] as f64).collect::<Vec<_>>(), t)).collect()).collect();
    let layout = probe.layout();
    Ok(TransientOutcome { times: times.to_vec(), mean, station_ids: layout.stations.iter().map(|s| s.id.clone()).collect(), station_names: layout.stations.iter().map(|s| s.name.clone()).collect(), replications, level, t, events: runs.iter().map(|(_, n)| n).sum() })
}

#[cfg(test)]
#[macro_use]
mod tests;

#[cfg(test)]
mod tests_extended;
