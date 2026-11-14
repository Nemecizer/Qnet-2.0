//! Transient analysis of an open network (new in 2.1, ROADMAP D4): how the mean number at each
//! station moves in time before the steady state is reached, and after a surge of arrivals.
//!
//! Two tiers, each labelled in the interface.
//!
//! **Exact** (`exact`), for an open Jackson network (`jackson::JacksonModel`: Poisson arrivals,
//! exponential service, c servers, infinite buffers). The state is the vector n of numbers at the
//! stations; the transitions are an arrival at i (rate γ_i), a service completion at i (rate
//! μ_i·min(n_i, c_i)) followed by a move to j (probability p_ij) or a departure (1 − Σ_j p_ij).
//! The chain is cut to the box 0 ≤ n_i ≤ K_i; a transition that would leave the box is *dropped*
//! (its rate stays in the diagonal), so the computed vector is the distribution of the paths that
//! never left the box. The transient distribution is computed by uniformisation (Jensen 1953;
//! Grassmann 1977; Stewart, *Introduction to the Numerical Solution of Markov Chains*, 1994,
//! §8.2): with Λ ≥ every exit rate and P = I + Q/Λ,
//!
//!   p(t + h) = Σ_{n ≥ 0} e^{−Λh}(Λh)ⁿ/n! · p(t)·Pⁿ,
//!
//! the sum stopped at N. Every term is non-negative, so the computed vector p̂ is elementwise at
//! most the true distribution of the infinite chain, and the whole error is one number:
//!
//!   ‖p_true(t) − p̂(t)‖₁ = 1 − Σ_x p̂_x(t)        (the *missing mass*, reported),
//!
//! which holds whatever the cause (the Poisson tail or paths that left the box). The Poisson
//! tails are also bounded beforehand: Σ_{n>N} w_n ≤ w_{N+1}/(1 − Λh/(N + 2)) for N + 2 > Λh (a
//! geometric majorant of the ratio w_{n+1}/w_n = Λh/(n + 1)); N is the smallest number that
//! keeps the sum of these bounds over all steps below the tolerance asked for. Rates that change
//! at known times (a surge: γ multiplied by a factor on [from, until]) are handled by making the
//! change times grid points: each step has constant rates, so the solution is continuous there.
//!
//! **The means are lower bounds, and how far below is bounded only by an argument about the
//! tail.** m̂_i(t) = Σ_{x in the box} x_i·p̂_x(t) ≤ E[N_i(t)]. The missing mass alone does not
//! bound the shortfall: the lost paths are the ones with long queues. Splitting the true mean
//! over the box and its outside, and using x_i ≤ K_i inside the box,
//!
//!   0 ≤ E[N_i(t)] − m̂_i(t) ≤ K_i·(missing mass at t) + E[(N_i(t) − K_i)⁺].            (★)
//!
//! (Outside the box, x_i ≤ K_i + (x_i − K_i)⁺; the mass outside and the mass lost inside add up
//! to the missing mass.) The last term needs the true law, and is bounded by *stochastic
//! domination*. An open Jackson network with c-server stations is a monotone Markov process in
//! the componentwise order: two copies with x ≤ y and arrival rates γ ≤ γ′ are coupled by giving
//! them the same arrivals (the larger one some more) and, at station i, joint service
//! completions with the same routing at rate μ_i·min(x_i, c_i) and completions of the larger
//! copy alone at rate μ_i·(min(y_i, c_i) − min(x_i, c_i)), which is positive only when
//! y_i > x_i; every transition keeps x ≤ y (Massey 1987, "Stochastic orderings for Markov
//! processes on partially ordered spaces", Math. Oper. Res. 12:350–367; Lindvall, *Lectures on
//! the Coupling Method*, 1992, ch. IV). So, with F the largest arrival factor in force at any
//! time up to t (1 without a surge, and before an upward surge starts) and π^F the stationary
//! product form of the network with arrivals F·γ, **when that network is stable**:
//!
//! - started empty, or in the steady state π¹ of the network as drawn (π¹ ≤_st π^F as F ≥ 1):
//!   N(t) ≤_st π^F for every t, so E[(N_i(t) − K_i)⁺] ≤ T_i^F(K_i) = Σ_{n>K_i} (n − K_i)·π_i^F(n);
//! - started from given numbers n⁰: the point mass at n⁰ is dominated by π^F conditioned on
//!   {N ≥ n⁰}, an event of probability q^F = Π_i π_i^F(N_i ≥ n⁰_i), so for the non-negative
//!   increasing function (x_i − K_i)⁺ the bound is T_i^F(K_i)/q^F.
//!
//! T is a closed form: beyond c − 1 the M/M/c marginal is geometric, T(K) = P(N > K)/(1 − ρ).
//! `Exact::shortfall` is the right-hand side of (★) with this bound, per station and time.
//! **Where the surged network is overloaded there is no stationary law to dominate with, and no
//! bound is given** from the start of the surge on (`None`): the means are then lower bounds and
//! no more. A settling time is reported only when the whole interval [m̂, m̂ + bound] is inside
//! the band from then on (`Exact::uncertified` says when it could not be).
//!
//! The levels K_i come from the product form: the smallest K with T_i(K)/q ≤ ε/(d·E) — the mean
//! beyond K, which is at least the mass P(N_i > K) — in the stationary M/M/c marginal (Jackson
//! 1957), E the expected number of events in the horizon (at least 1). For a surge they are the
//! surged network's levels when that is stable and the box is not too large, otherwise the
//! fluid peak plus a margin (then the bound, if there is one, may be wide); a given initial
//! state adds its customers.
//!
//! **Stored rate profiles** (new in 2.1, ledger SCI-1021). A source may carry a piecewise-
//! constant rate profile (`model::RateProfile`: several breakpoints, each source its own,
//! optionally periodic). [`Profile`] is what that makes of the external arrival rates: the times
//! at which any source's multiplier changes, and the vector γ on each piece between them. The
//! exact tier treats it exactly as it treats a surge: every breakpoint is a grid point and each
//! step has constant rates, so nothing is approximated. The bound (★) uses the same domination
//! argument with, in place of the surged network, the network whose external rate into each
//! station is the *largest that has been in force up to t* (componentwise, and at least the
//! drawn network's when the start is its steady state): the true process is below the
//! stationary process of that network by the coupling above, which needs γ ≤ γ′ componentwise
//! at every instant and nothing else. As soon as a piece has been in force that makes that
//! dominating network unstable there is no stationary law to dominate with, and **no bound is
//! given from then on**, as for a surge.
//!
//! **The pointwise stationary approximation** ([`psa`]; Green & Kolesar, "The pointwise
//! stationary approximation for queues with nonstationary arrivals", Management Sci. 37:84–97,
//! 1991): at each time t, the steady-state mean of the network whose rates are frozen at their
//! values at t. It is an approximation with known failure modes, shown beside the exact curve
//! so they can be seen: it jumps the instant the rate changes while the true mean needs time to
//! follow (it ignores the relaxation time, so it is poor when the rate changes faster than the
//! queue relaxes); it lags not at all, so it puts the peak congestion at the peak rate, where
//! the true peak comes later; and it is infinite (not defined) while a piece overloads the
//! network, however short the piece.
//!
//! **M_t/M/∞** ([`infinite_server_mean`]): with infinitely many servers the number present at t
//! from an empty start is Poisson with mean m(t) = ∫₀ᵗ λ(u)·e^{−μ(t−u)} du (Eick, Massey & Whitt,
//! "The physics of the M_t/G/∞ queue", Oper. Res. 41:731–742, 1993; for exponential service this
//! is the solution of m′ = λ(t) − μ·m). It is used as a test of the profile machinery: a
//! station with more servers than its truncation level is an infinite-server station.
//!
//! **Fluid** (`fluid`), for any open single-class-per-station network: the deterministic fluid
//! limit of Chen & Mandelbaum (1991, "Discrete flow networks: bottleneck analysis and fluid
//! approximations", Math. Oper. Res. 16:408–446). With capacity κ_i = c_i·μ_i, station i works at
//! rate D_i = κ_i while it holds fluid and at D_i = min(κ_i, γ_i + Σ_j p_ji·D_j) while empty, and
//!
//!   dQ_i/dt = γ_i + Σ_j p_ji·D_j − D_i.
//!
//! Between events (a station running empty, a change of rates) the rates are constant and Q is
//! linear, so the path is followed exactly from event to event: no step-size error. The model
//! ignores randomness: in a stable network it drains to zero, where the true mean settles at L.
//!
//! Tests (below) hold the exact tier to closed forms (two-state chain, M/M/∞, the Jackson
//! stationary means) and to an independent Runge–Kutta integration of the forward equations, and
//! the fluid tier to its closed forms.

use crate::extended::{self, Feature};
use crate::jackson::{self, JacksonModel};
use crate::model::{Network, NodeKind};
use crate::naming;
use crate::traffic;

/// Where the network starts.
#[derive(Clone, Debug, PartialEq)]
pub enum Initial {
    /// No customers anywhere.
    Empty,
    /// The steady state of the network as drawn (only interesting with a surge).
    Steady,
    /// A given number at each station, in export order.
    Given(Vec<u32>),
}

/// External arrival rates multiplied by `factor` during [from, until].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Surge {
    pub factor: f64,
    pub from: f64,
    pub until: f64,
}

/// External arrival rates that change at known times (the network's stored rate profiles).
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    /// The times, ascending and inside (0, horizon), at which a rate changes.
    pub breaks: Vec<f64>,
    /// `breaks.len() + 1` vectors: `gamma[j][i]` is the external rate into station i on piece j,
    /// which runs from `breaks[j − 1]` (0 for the first) to `breaks[j]` (the horizon for the last).
    pub gamma: Vec<Vec<f64>>,
    /// True when a source's profile repeats, so the rates never return to the drawn network's for good.
    pub periodic: bool,
}

impl Profile {
    /// The piece in force at time `t` (a piece holds from its start, inclusive, to its end).
    pub fn piece_at(&self, t: f64) -> usize {
        self.breaks.iter().filter(|b| **b <= t).count()
    }

    fn start_of(&self, piece: usize) -> f64 {
        if piece == 0 { 0.0 } else { self.breaks[piece - 1] }
    }

    /// The largest rate into each station over the pieces that start before `t` (and `floor`).
    fn largest_before(&self, t: f64, floor: &[f64]) -> Vec<f64> {
        let mut out = floor.to_vec();
        for (j, g) in self.gamma.iter().enumerate() {
            if j == 0 || self.start_of(j) < t {
                for i in 0..out.len() {
                    out[i] = out[i].max(g[i]);
                }
            }
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    /// The last time computed; time starts at 0.
    pub horizon: f64,
    /// Equal intervals the horizon is cut into (the surge's ends are added as grid points).
    pub intervals: usize,
    pub initial: Initial,
    pub surge: Option<Surge>,
    /// The network's stored rate profiles ([`profile_of`]); not together with a surge.
    pub profile: Option<Profile>,
    /// "Settled" means within this fraction of the stationary mean from then on (0.05: 5 %).
    pub settle_fraction: f64,
    /// Stationary probability the truncation may neglect, and the bound on the Poisson tails.
    pub epsilon: f64,
    /// The exact tier refuses a state space larger than this.
    pub max_states: usize,
}

impl Default for Request {
    fn default() -> Request {
        Request { horizon: 10.0, intervals: 200, initial: Initial::Empty, surge: None, profile: None, settle_fraction: 0.05, epsilon: 1e-8, max_states: MAX_STATES }
    }
}

/// The largest state space the exact tier builds.
pub const MAX_STATES: usize = 200_000;
/// The most work the exact tier accepts: matrix-vector products × states (about a minute).
pub const MAX_WORK: f64 = 2.0e10;

/// Why a request cannot be computed at all.
pub fn validate(model: &JacksonModel, req: &Request) -> Result<(), String> {
    if !(req.horizon > 0.0) || !req.horizon.is_finite() {
        return Err("The time horizon must be a positive number.".into());
    }
    if req.intervals < 2 || req.intervals > 5000 {
        return Err("The number of time points must be between 2 and 5000.".into());
    }
    if !(req.settle_fraction > 0.0 && req.settle_fraction < 1.0) {
        return Err("The settling band must be between 0 % and 100 %.".into());
    }
    if let Some(s) = req.surge {
        if !(s.factor >= 0.0) || !s.factor.is_finite() {
            return Err("The surge factor must be zero or a positive number.".into());
        }
        if !(s.from >= 0.0) || !(s.until > s.from) || !s.until.is_finite() {
            return Err("The surge must start at time 0 or later and end after it starts.".into());
        }
    }
    if let Initial::Given(n) = &req.initial {
        if n.len() != model.mu.len() {
            return Err("The starting numbers must name one number for each station.".into());
        }
    }
    if let Some(p) = &req.profile {
        if req.surge.is_some() {
            return Err("The network's own rate profile is in force; a surge cannot be added on top of it.".into());
        }
        let ordered = p.breaks.windows(2).all(|w| w[1] > w[0]) && p.breaks.iter().all(|b| *b > 0.0 && *b < req.horizon);
        let shaped = p.gamma.len() == p.breaks.len() + 1 && p.gamma.iter().all(|g| g.len() == model.mu.len() && g.iter().all(|x| x.is_finite() && *x >= 0.0));
        if !ordered || !shaped {
            return Err("The rate profile does not fit the network or the horizon.".into());
        }
    }
    Ok(())
}

/// The output times: 0, horizon·k/intervals and the surge's ends inside the horizon, ascending.
pub fn time_grid(req: &Request) -> Vec<f64> {
    let mut t: Vec<f64> = (0..=req.intervals).map(|k| req.horizon * k as f64 / req.intervals as f64).collect();
    let ends: Vec<f64> = req.surge.map(|s| vec![s.from, s.until]).unwrap_or_default().into_iter().chain(req.profile.iter().flat_map(|p| p.breaks.iter().copied())).collect();
    for b in ends {
        if b > 0.0 && b < req.horizon {
            if !t.iter().any(|x| (x - b).abs() <= 1e-12 * req.horizon) {
                t.push(b);
            }
        }
    }
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t
}

/// The external arrival rates on the grid interval [a, b] (grid intervals never straddle a
/// change of rates).
fn rates_on(model: &JacksonModel, req: &Request, a: f64, b: f64) -> Vec<f64> {
    match &req.profile {
        Some(p) => p.gamma[p.piece_at(0.5 * (a + b))].clone(),
        None => {
            let f = factor_on(req.surge, a, b);
            model.gamma.iter().map(|g| g * f).collect()
        }
    }
}

/// The external arrival rates in force at time `t` (from `t` on: right-continuous).
fn rates_at(model: &JacksonModel, req: &Request, t: f64) -> Vec<f64> {
    match (&req.profile, req.surge) {
        (Some(p), _) => p.gamma[p.piece_at(t)].clone(),
        (None, Some(s)) if t >= s.from && t < s.until => model.gamma.iter().map(|g| g * s.factor).collect(),
        _ => model.gamma.clone(),
    }
}

/// The pointwise stationary approximation (module text): `[i][k]` is the steady-state mean
/// number at station i of the network with its rates frozen at their values at `times[k]`, or
/// None where that network is overloaded. **An approximation**, exact only where the rates have
/// been constant for long.
pub fn psa(model: &JacksonModel, req: &Request) -> Vec<Vec<Option<f64>>> {
    let times = time_grid(req);
    let d = model.mu.len();
    let mut out = vec![Vec::with_capacity(times.len()); d];
    let mut last: Option<(Vec<f64>, Option<Vec<f64>>)> = None;
    for &t in &times {
        let gamma = rates_at(model, req, t);
        if last.as_ref().map(|(g, _)| g != &gamma).unwrap_or(true) {
            let frozen = JacksonModel { gamma: gamma.clone(), ..model.clone() };
            last = Some((gamma, jackson::solve(&frozen).ok().map(|s| s.number)));
        }
        let numbers = &last.as_ref().unwrap().1;
        for i in 0..d {
            out[i].push(numbers.as_ref().map(|n| n[i]));
        }
    }
    out
}

/// The exact mean number in an M_t/M/∞ station started empty, at time `t`: with the arrival rate
/// `rates[j]` on [`breaks[j − 1]`, `breaks[j]`) (0 before the first break, for good after the
/// last), m(t) = Σ_j (rates[j]/μ)·(e^{−μ(t − b_j)} − e^{−μ(t − a_j)}) over the pieces [a_j, b_j]
/// cut at t: the integral ∫₀ᵗ λ(u)·e^{−μ(t−u)} du piece by piece.
pub fn infinite_server_mean(breaks: &[f64], rates: &[f64], mu: f64, t: f64) -> f64 {
    let mut m = 0.0;
    for (j, rate) in rates.iter().enumerate() {
        let a = if j == 0 { 0.0 } else { breaks[j - 1] };
        let b = breaks.get(j).copied().unwrap_or(f64::INFINITY).min(t);
        if b > a {
            m += rate / mu * ((-mu * (t - b)).exp() - (-mu * (t - a)).exp());
        }
    }
    m
}

/// The arrival factor on the grid interval [a, b] (grid intervals never straddle a surge end).
fn factor_on(surge: Option<Surge>, a: f64, b: f64) -> f64 {
    match surge {
        Some(s) if 0.5 * (a + b) >= s.from && 0.5 * (a + b) < s.until => s.factor,
        _ => 1.0,
    }
}

/// The relaxation time of an M/M/1 queue, 1/(√μ − √λ)²: its distance to the steady state decays
/// like e^{−t/τ} (Morse 1955; Cohen, *The Single Server Queue*, 1982, §II.4.4; the spectral gap
/// of the birth–death generator is (√μ − √λ)²). For c servers the capacity cμ stands in for μ,
/// which is a rough scale only. Infinite when the queue is not stable.
pub fn relaxation_time(arrival: f64, capacity: f64) -> f64 {
    if !(arrival < capacity) {
        return f64::INFINITY;
    }
    let g = capacity.sqrt() - arrival.max(0.0).sqrt();
    1.0 / (g * g)
}

/// A horizon to suggest: long enough for the slowest station to settle from empty. From empty an
/// M/M/1 mean comes within 5 % of ρ/(1 − ρ) after about 1.1τ to 1.5τ (ρ from 0.9 down to 0.3;
/// the test `the_suggested_horizon_covers_settling_from_empty` holds this), so 2·max τ, and never
/// less than five mean service times, rounded up to two significant figures.
pub fn suggested_horizon(model: &JacksonModel, alpha: &[f64]) -> f64 {
    let mut h: f64 = 0.0;
    for i in 0..model.mu.len() {
        let cap = model.servers[i].max(1) as f64 * model.mu[i];
        let tau = relaxation_time(alpha[i], cap);
        let floor = if model.mu[i] > 0.0 { 5.0 / model.mu[i] } else { 0.0 };
        h = h.max(if tau.is_finite() { (2.0 * tau).max(floor) } else { floor.max(10.0 / cap.max(1e-12)) });
    }
    round_up_2(h.max(1e-9))
}

fn round_up_2(x: f64) -> f64 {
    let e = x.log10().floor();
    let unit = 10f64.powf(e - 1.0);
    ((x / unit) - 1e-9).ceil() * unit
}

// ── Poisson weights and the uniformisation step ──────────────────────────────────────────────────

/// e^{−a}aⁿ/n! for n = 0…N, with a bound on the weight beyond N.
#[derive(Clone, Debug)]
pub struct PoissonWeights {
    pub weights: Vec<f64>,
    /// Σ_{n>N} w_n ≤ this (geometric majorant, see the module text).
    pub tail_bound: f64,
}

/// The weights of Poisson(a), cut at the smallest N whose tail bound is at most `eps`.
pub fn poisson_weights(a: f64, eps: f64) -> PoissonWeights {
    if !(a > 0.0) {
        return PoissonWeights { weights: vec![1.0], tail_bound: 0.0 };
    }
    // Relative to the mode m = ⌊a⌋ (weight 1 there), by the ratio w_{n+1}/w_n = a/(n + 1) in
    // both directions, then divided by the whole sum (Fox & Glynn 1988, "Computing Poisson
    // probabilities", Comm. ACM 31:440–445): no e^{−a} to underflow, and rounding of a few ulps.
    let mode = a.floor() as usize;
    let mut down = Vec::with_capacity(mode + 1); // w_m, w_{m−1}, …, w_0
    let mut x = 1.0;
    down.push(x);
    for n in (1..=mode).rev() {
        x *= n as f64 / a;
        down.push(x);
    }
    let mut up = Vec::new(); // w_{m+1}, …: until nothing is left to add
    x = 1.0;
    let mut n = mode;
    loop {
        x *= a / (n + 1) as f64;
        n += 1;
        up.push(x);
        if x < 1e-300 || ((n + 1) as f64 > a && x / (1.0 - a / (n + 1) as f64) < 1e-25) {
            break;
        }
    }
    // Summed smallest first.
    let total: f64 = down.iter().rev().sum::<f64>() + up.iter().rev().sum::<f64>();
    let mut weights: Vec<f64> = down.iter().rev().map(|w| w / total).collect();
    // Cut at the smallest N ≥ m whose tail bound w_{N+1}/(1 − a/(N + 2)) is at most eps.
    for (k, w) in up.iter().enumerate() {
        let n_next = mode + 1 + k; // w is w_{N+1} for N = n_next − 1
        let bound = (w / total) / (1.0 - a / (n_next + 1) as f64);
        if (n_next + 1) as f64 > a && bound <= eps {
            return PoissonWeights { weights, tail_bound: bound };
        }
        weights.push(w / total);
    }
    PoissonWeights { weights, tail_bound: 1e-25 }
}

/// The computation was stopped by the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stopped;

/// One uniformisation step: p ← Σ_{n ≤ N} w_n·p·Pⁿ with `step(v, out)` computing out = v·P and
/// w the weights of Poisson(a) (a = Λh). Returns the bound on the neglected weight. `tick` is
/// called once per product and stops the computation by returning false.
pub fn uniformised_step(p: &mut Vec<f64>, a: f64, eps: f64, step: &mut dyn FnMut(&[f64], &mut [f64]), tick: &mut dyn FnMut() -> bool) -> Result<f64, Stopped> {
    let w = poisson_weights(a, eps);
    let mut v = p.clone();
    let mut next = vec![0.0; p.len()];
    for x in p.iter_mut() {
        *x *= w.weights[0];
    }
    for &wn in &w.weights[1..] {
        if !tick() {
            return Err(Stopped);
        }
        step(&v, &mut next);
        std::mem::swap(&mut v, &mut next);
        if wn > 0.0 {
            for (acc, x) in p.iter_mut().zip(&v) {
                *acc += wn * x;
            }
        }
    }
    Ok(w.tail_bound)
}

// ── The truncated chain of a Jackson network ─────────────────────────────────────────────────────

/// The stationary distribution of the number at an M/M/c station with offered load a = α/μ, for
/// n = 0…`upto` (true probabilities, not renormalised), and the mass beyond.
pub fn mmc_marginal(servers: i64, a: f64, upto: usize) -> (Vec<f64>, f64) {
    let c = servers.max(1) as usize;
    let rho = a / c as f64;
    // Unnormalised terms t_n = aⁿ/n! (n ≤ c), t_c·ρ^{n−c} beyond; Σ = Σ_{n<c} t_n + t_c/(1 − ρ).
    let mut t = 1.0;
    let mut sum = 0.0;
    for n in 0..c {
        sum += t;
        t *= a / (n + 1) as f64;
    }
    let total = sum + t / (1.0 - rho);
    let mut pmf = Vec::with_capacity(upto + 1);
    let mut term = 1.0;
    for n in 0..=upto {
        pmf.push(term / total);
        term *= if n < c { a / (n + 1) as f64 } else { rho };
    }
    // Beyond `upto`: geometric when upto ≥ c − 1, else what is left.
    let beyond = if upto + 1 >= c { (term / total) / (1.0 - rho) } else { (1.0 - pmf.iter().sum::<f64>()).max(0.0) };
    (pmf, beyond)
}

/// The smallest K with P(N > K) ≤ eps in the M/M/c marginal.
pub fn truncation_level(servers: i64, a: f64, eps: f64) -> usize {
    let c = servers.max(1) as usize;
    let rho = a / c as f64;
    let mut k = 0usize;
    loop {
        let (_, beyond) = mmc_marginal(servers, a, k);
        if beyond <= eps {
            return k;
        }
        // Past c the tail is geometric: jump straight to the level that reaches eps.
        if k + 1 >= c && rho > 0.0 {
            let more = ((eps / beyond).ln() / rho.ln()).ceil().max(1.0) as usize;
            let (_, b2) = mmc_marginal(servers, a, k + more);
            return if b2 <= eps { k + more } else { k + more + 1 };
        }
        k += 1;
    }
}

/// P(N ≥ m) in the M/M/c marginal, summed from the tail (no 1 − Σ cancellation).
pub fn at_least(servers: i64, a: f64, m: usize) -> f64 {
    if m == 0 {
        return 1.0;
    }
    let c = servers.max(1) as usize;
    let top = (m - 1).max(c.saturating_sub(1));
    let (pmf, beyond) = mmc_marginal(servers, a, top);
    beyond + pmf[m..=top].iter().rev().sum::<f64>()
}

/// E[(N − k)⁺] = Σ_{n>k} (n − k)·π(n) = Σ_{j≥k} P(N > j) in the M/M/c marginal with offered load
/// a < c: the mean number beyond level k. From c − 1 on the tail is geometric with ratio ρ, so
/// Σ_{j≥K} P(N > j) = P(N > K)/(1 − ρ) there; below, the finite part is added term by term.
pub fn mean_beyond(servers: i64, a: f64, k: usize) -> f64 {
    let c = servers.max(1) as usize;
    let rho = a / c as f64;
    let top = k.max(c.saturating_sub(1));
    let (pmf, beyond) = mmc_marginal(servers, a, top);
    let mut total = beyond / (1.0 - rho);
    let mut tail = beyond;
    for j in (k..top).rev() {
        tail += pmf[j + 1];
        total += tail;
    }
    total
}

/// The smallest K found with E[(N − K)⁺] ≤ eps (and so P(N > K) ≤ eps) in the M/M/c marginal.
pub fn truncation_level_for_mean(servers: i64, a: f64, eps: f64) -> usize {
    let rho = a / servers.max(1) as f64;
    let mut k = truncation_level(servers, a, eps * (1.0 - rho));
    while mean_beyond(servers, a, k) > eps {
        k += 1;
    }
    k
}

/// q^F of the module text: the stationary probability, with arrivals `factor`·γ, of at least the
/// starting numbers at every station. 1 for an empty start and for a start in the steady state
/// of the network as drawn (which needs `factor` ≥ 1, as the callers ensure).
fn start_probability(model: &JacksonModel, alpha: &[f64], factor: f64, initial: &Initial) -> f64 {
    match initial {
        Initial::Empty | Initial::Steady => 1.0,
        Initial::Given(n0) => (0..model.mu.len()).map(|i| at_least(model.servers[i], factor * alpha[i] / model.mu[i], n0.get(i).copied().unwrap_or(0) as usize)).product(),
    }
}

/// True when the network with arrivals `factor`·γ has a steady state (with the margin `choose_levels` uses).
fn stable_at(model: &JacksonModel, alpha: &[f64], factor: f64) -> bool {
    (0..model.mu.len()).all(|i| factor * alpha[i] < model.servers[i].max(1) as f64 * model.mu[i] * (1.0 - 1e-9))
}

/// The bound on E[(N_i(t) − K_i)⁺] of the module text for the regime with arrivals `factor`·γ
/// (`factor` ≥ 1): T_i^F(K_i)/q^F per station, or None when that regime has no steady state (or
/// the starting numbers are so far out that q^F is not a positive number).
pub fn mean_beyond_bound(model: &JacksonModel, alpha: &[f64], factor: f64, levels: &[usize], initial: &Initial) -> Option<Vec<f64>> {
    if !stable_at(model, alpha, factor) {
        return None;
    }
    let q = start_probability(model, alpha, factor, initial);
    if !(q > 0.0) {
        return None;
    }
    let out: Vec<f64> = (0..model.mu.len()).map(|i| mean_beyond(model.servers[i], factor * alpha[i] / model.mu[i], levels[i]) / q).collect();
    out.iter().all(|x| x.is_finite()).then_some(out)
}

/// The chain on the box 0 ≤ n_i ≤ levels[i], states numbered with station 0 fastest.
struct Chain {
    d: usize,
    levels: Vec<usize>,
    stride: Vec<usize>,
    states: usize,
    mu: Vec<f64>,
    servers: Vec<usize>,
    /// For station i: (j, p_ij) for every j ≠ i with p_ij > 0.
    routes: Vec<Vec<(usize, f64)>>,
    /// 1 − Σ_j p_ij: the probability of leaving the network after service at i.
    exit: Vec<f64>,
    /// The uniformisation rate Λ.
    rate: f64,
}

impl Chain {
    fn new(model: &JacksonModel, levels: &[usize], max_factor: f64) -> Chain {
        let d = model.mu.len();
        let mut stride = vec![1usize; d];
        for i in 1..d {
            stride[i] = stride[i - 1] * (levels[i - 1] + 1);
        }
        let states = stride[d - 1] * (levels[d - 1] + 1);
        let routes: Vec<Vec<(usize, f64)>> = (0..d).map(|i| (0..d).filter(|&j| j != i && model.p[i][j] > 0.0).map(|j| (j, model.p[i][j])).collect()).collect();
        let exit: Vec<f64> = (0..d).map(|i| (1.0 - model.p[i].iter().sum::<f64>()).max(0.0)).collect();
        let servers: Vec<usize> = model.servers.iter().map(|&c| c.max(1) as usize).collect();
        let rate = model.gamma.iter().sum::<f64>() * max_factor.max(1.0) + (0..d).map(|i| servers[i] as f64 * model.mu[i] * (1.0 - model.p[i][i]).max(0.0)).sum::<f64>();
        Chain { d, levels: levels.to_vec(), stride, states, mu: model.mu.clone(), servers, routes, exit, rate }
    }

    /// Walks every state with its coordinates.
    fn for_each_state(&self, mut f: impl FnMut(usize, &[usize])) {
        let mut n = vec![0usize; self.d];
        for x in 0..self.states {
            f(x, &n);
            for i in 0..self.d {
                if n[i] < self.levels[i] {
                    n[i] += 1;
                    break;
                }
                n[i] = 0;
            }
        }
    }

    /// out = v·P, P = I + Q/Λ with external arrival rates `arrivals`. Transitions that would
    /// leave the box are dropped, so the mass of `out` is at most that of `v`.
    fn apply(&self, arrivals: &[f64], v: &[f64], out: &mut [f64]) {
        out.iter_mut().for_each(|x| *x = 0.0);
        let inv = 1.0 / self.rate;
        let mut n = vec![0usize; self.d];
        for x in 0..self.states {
            let w = v[x];
            if w != 0.0 {
                let mut leaving = 0.0;
                for i in 0..self.d {
                    let a = arrivals[i];
                    if a > 0.0 {
                        leaving += a;
                        if n[i] < self.levels[i] {
                            out[x + self.stride[i]] += w * a * inv;
                        }
                    }
                    if n[i] > 0 {
                        let s = self.mu[i] * n[i].min(self.servers[i]) as f64;
                        let base = x - self.stride[i];
                        for &(j, pij) in &self.routes[i] {
                            leaving += s * pij;
                            if n[j] < self.levels[j] {
                                out[base + self.stride[j]] += w * s * pij * inv;
                            }
                        }
                        if self.exit[i] > 0.0 {
                            leaving += s * self.exit[i];
                            out[base] += w * s * self.exit[i] * inv;
                        }
                    }
                }
                out[x] += w * (1.0 - leaving * inv).max(0.0);
            }
            for i in 0..self.d {
                if n[i] < self.levels[i] {
                    n[i] += 1;
                    break;
                }
                n[i] = 0;
            }
        }
    }

    fn index(&self, n: &[usize]) -> usize {
        (0..self.d).map(|i| n[i] * self.stride[i]).sum()
    }
}

/// The exact tier's answer. Station vectors are in the model's order; `[i][k]` is station i at
/// `times[k]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Exact {
    pub times: Vec<f64>,
    /// E[number at the station] (customers): a lower bound on the true mean. How far below is
    /// `shortfall`; the missing mass alone does not bound it (module text, (★)).
    pub mean: Vec<Vec<f64>>,
    /// `[i][k]`: a proven upper bound on (true mean − `mean[i][k]`), customers:
    /// K_i·missing mass + the stationary mean beyond K_i of the dominating regime; None where
    /// no bound holds (from the start of a surge that overloads the network).
    pub shortfall: Vec<Vec<Option<f64>>>,
    /// P(station empty).
    pub empty: Vec<Vec<f64>>,
    /// Total-variation distance between the distribution at t and the stationary one, at most.
    pub distance: Vec<f64>,
    /// 1 − Σ p̂(t): the whole ℓ₁ error of the distribution at each time.
    pub missing_mass: Vec<f64>,
    /// The stationary means L_i the curves are compared with (`jackson::solve`).
    pub stationary: Vec<f64>,
    /// The first time after which the mean stays within the band of L_i up to the horizon, or
    /// none when it is still outside at the horizon. Counted from `settle_from`.
    pub settling: Vec<Option<f64>>,
    /// True when a settling time could not be certified for the station: the computed mean (a
    /// lower bound) is not outside the band at the horizon, but its error interval
    /// [mean, mean + shortfall] is not inside the band either, or has no upper end.
    pub uncertified: Vec<bool>,
    /// Settling is looked for from this time on: 0, or the end of the surge.
    pub settle_from: f64,
    pub levels: Vec<usize>,
    pub states: usize,
    pub uniformisation_rate: f64,
    /// Matrix–vector products done.
    pub products: usize,
    /// The sum of the Poisson tail bounds over all steps (a priori, ℓ₁).
    pub poisson_bound: f64,
    /// Stationary probability outside the box.
    pub stationary_tail: f64,
}

/// Why the exact tier does not answer, in a sentence for the interface.
#[derive(Clone, Debug, PartialEq)]
pub enum Refusal {
    /// No steady state, or the traffic equations fail (`jackson`'s sentence).
    Model(String),
    TooManyStates { states: f64, limit: usize },
    TooMuchWork { products: f64, states: usize },
    Stopped,
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Refusal::Model(s) => s.clone(),
            Refusal::TooManyStates { states, limit } => format!(
                "The exact calculation would need about {} states (the limit is {}): too many stations, or stations too heavily loaded. The fluid approximation still applies.",
                group(*states),
                group(*limit as f64)
            ),
            Refusal::TooMuchWork { products, states } => format!(
                "The exact calculation would need about {} steps on {} states, which would take too long. Shorten the time horizon, or read the fluid approximation.",
                group(*products),
                group(*states as f64)
            ),
            Refusal::Stopped => "The calculation was stopped.".into(),
        }
    }
}

/// 1234567 → "1 234 567" (thin grouping for sentences); large values in two significant figures.
fn group(x: f64) -> String {
    if x >= 1e15 {
        return format!("{x:.1e}");
    }
    let s = format!("{}", x.round() as u64);
    let mut out = String::new();
    for (k, ch) in s.chars().enumerate() {
        if k > 0 && (s.len() - k) % 3 == 0 {
            out.push('\u{202F}');
        }
        out.push(ch);
    }
    out
}

/// The first time ≥ `from` after which `values` stays within `fraction`·|target| of `target`
/// up to the last grid time (crossings interpolated linearly); none when the last value is
/// still outside.
pub fn settling_time(times: &[f64], values: &[f64], target: f64, fraction: f64, from: f64) -> Option<f64> {
    let band = fraction * target.abs();
    let outside = |v: f64| (v - target).abs() > band;
    let last = times.len() - 1;
    if outside(values[last]) {
        return None;
    }
    let mut k = last;
    while k > 0 && times[k - 1] >= from - 1e-12 * times[last].abs().max(1.0) && !outside(values[k - 1]) {
        k -= 1;
    }
    if k == 0 || times[k - 1] < from - 1e-12 * times[last].abs().max(1.0) {
        return Some(times[k].max(from));
    }
    // values[k − 1] is outside, values[k] inside: the crossing of the band's edge between them.
    let (a, b) = (values[k - 1], values[k]);
    let edge = if a > target { target + band } else { target - band };
    let s = if (b - a).abs() > 0.0 { ((edge - a) / (b - a)).clamp(0.0, 1.0) } else { 1.0 };
    Some(times[k - 1] + s * (times[k] - times[k - 1]))
}

/// The settling time of a mean known only to lie in [low, low + shortfall] at each grid time:
/// the time from which the whole interval stays inside the band (so the true mean does, at the
/// grid times), and whether it could not be certified. (None, false): the true mean is outside
/// the band at the horizon for certain. (None, true): it may be inside, but the interval is not
/// (too wide, or with no upper end somewhere from `from` on), so no time is declared.
pub fn certified_settling(times: &[f64], low: &[f64], shortfall: &[Option<f64>], target: f64, fraction: f64, from: f64) -> (Option<f64>, bool) {
    let band = fraction * target.abs();
    let last = times.len() - 1;
    let tol = 1e-12 * times[last].abs().max(1.0);
    // Certainly outside at the horizon: the lower bound is above the band, or the upper bound below it.
    if low[last] > target + band || shortfall[last].is_some_and(|b| low[last] + b < target - band) {
        return (None, false);
    }
    let high: Option<Vec<f64>> = (0..times.len()).map(|k| if times[k] < from - tol { Some(low[k]) } else { shortfall[k].map(|b| low[k] + b) }).collect();
    let Some(high) = high else { return (None, true) };
    match (settling_time(times, low, target, fraction, from), settling_time(times, &high, target, fraction, from)) {
        (Some(a), Some(b)) => (Some(a.max(b)), false),
        _ => (None, true),
    }
}

/// The truncation levels for a request (see the module text) and the stationary marginals.
fn choose_levels(model: &JacksonModel, alpha: &[f64], req: &Request, margin: f64) -> Vec<usize> {
    let d = model.mu.len();
    // Paths leave the box at about (event rate) × (probability of standing at its edge) per time
    // unit, so the tail allowed shrinks with the number of events in the horizon: the tail is
    // geometric, and this costs a few levels.
    let events = (model.gamma.iter().sum::<f64>() + (0..d).map(|i| model.servers[i].max(1) as f64 * model.mu[i]).sum::<f64>()) * req.horizon;
    let eps = req.epsilon / (d as f64 * events.max(1.0));
    // The mean beyond K (not only the mass) is what the error of the means needs: T_i(K)/q ≤ eps,
    // q the stationary probability of at least the starting numbers (module text). A start so
    // far out that q underflows gets no bound, and the plain levels.
    let by_mean_at = |alpha: &[f64], factor: f64| -> Vec<usize> {
        let q = Some(start_probability(model, alpha, factor, &req.initial)).filter(|q| *q > 1e-200).unwrap_or(1.0);
        (0..d).map(|i| truncation_level_for_mean(model.servers[i], factor * alpha[i] / model.mu[i], eps * q)).collect()
    };
    let by_mean = |factor: f64| by_mean_at(alpha, factor);
    let mut levels = by_mean(1.0);
    // A stored profile: the same two routes as for a surge, with the network of the largest
    // rates of the whole horizon in the surged network's place.
    if let Some(p) = &req.profile {
        let top = p.largest_before(f64::INFINITY, &model.gamma);
        if top != model.gamma {
            let peak_alpha = jackson::throughputs(&JacksonModel { gamma: top, ..model.clone() }).unwrap_or_else(|| alpha.to_vec());
            let by_marginal: Option<Vec<usize>> = stable_at(model, &peak_alpha, 1.0).then(|| by_mean_at(&peak_alpha, 1.0));
            if let Some(m) = by_marginal.as_ref().filter(|m| m.iter().map(|&k| (k.max(1) + 1) as f64).product::<f64>() <= req.max_states as f64 / 4.0) {
                for i in 0..d {
                    levels[i] = levels[i].max(m[i]);
                }
                return with_start(levels, &req.initial);
            }
            let peak = fluid(model, &Request { initial: Initial::Empty, ..req.clone() });
            for i in 0..d {
                let top = peak.level[i].iter().cloned().fold(0.0, f64::max);
                let cap = model.servers[i].max(1) as f64 * model.mu[i];
                let sd = ((peak_alpha[i] + cap) * req.horizon).sqrt();
                let by_fluid = levels[i] + (top + margin * (7.0 * sd + 10.0)).ceil() as usize;
                let m = by_marginal.as_ref().map(|v| v[i]).unwrap_or(usize::MAX);
                levels[i] = levels[i].max(m.min(by_fluid));
            }
        }
        return with_start(levels, &req.initial);
    }
    if let Some(s) = req.surge.filter(|s| s.factor > 1.0 && s.from < req.horizon) {
        let stable = stable_at(model, alpha, s.factor);
        let by_marginal: Option<Vec<usize>> = stable.then(|| by_mean(s.factor));
        // The surged network's own levels keep the bound on the means below the tolerance: they
        // are used whenever the box they make is not too large.
        if let Some(m) = by_marginal.as_ref().filter(|m| m.iter().map(|&k| (k.max(1) + 1) as f64).product::<f64>() <= req.max_states as f64 / 4.0) {
            for i in 0..d {
                levels[i] = levels[i].max(m[i]);
            }
            return with_start(levels, &req.initial);
        }
        // Otherwise (overloaded by the surge, or stable but so close to saturation that its
        // stationary tail, never reached in a short surge, is huge): the fluid peak route.
        let window = s.until.min(req.horizon) - s.from;
        let peak = fluid(model, &Request { initial: Initial::Empty, ..req.clone() });
        let by_fluid: Vec<usize> = (0..d)
            .map(|i| {
                let top = peak.level[i].iter().cloned().fold(0.0, f64::max);
                let cap = model.servers[i].max(1) as f64 * model.mu[i];
                // Arrivals and departures over the window: Poisson-like, variance ≈ their sum.
                let sd = ((s.factor * alpha[i] + cap) * window).sqrt();
                levels[i] + (top + margin * (7.0 * sd + 10.0)).ceil() as usize
            })
            .collect();
        for i in 0..d {
            let m = by_marginal.as_ref().map(|v| v[i]).unwrap_or(usize::MAX);
            levels[i] = levels[i].max(m.min(by_fluid[i]));
        }
    }
    with_start(levels, &req.initial)
}

/// A given start adds its customers to every level: each could end up at any one station.
fn with_start(mut levels: Vec<usize>, initial: &Initial) -> Vec<usize> {
    if let Initial::Given(n0) = initial {
        let total: usize = n0.iter().map(|&n| n as usize).sum();
        for l in levels.iter_mut() {
            *l += total;
        }
    }
    levels
}

/// The exact transient of `model`. `progress(fraction)` is called as the work advances and stops
/// the computation by returning false.
pub fn exact(model: &JacksonModel, req: &Request, progress: &mut dyn FnMut(f64) -> bool) -> Result<Exact, Refusal> {
    validate(model, req).map_err(Refusal::Model)?;
    let solution = jackson::solve(model).map_err(|e| Refusal::Model(format!("{} The exact calculation measures the distance to a steady state, so it needs one; the fluid approximation still applies.", e.message())))?;
    let mut margin = 1.0;
    loop {
        let levels = choose_levels(model, &solution.alpha, req, margin);
        let out = exact_with_levels(model, &solution, req, &levels, progress)?;
        // A surge beyond capacity: the levels were a guess from the fluid peak. Try once more
        // with a wider margin when paths left the box.
        let missing = out.missing_mass.last().copied().unwrap_or(0.0);
        if missing > 100.0 * req.epsilon && margin < 3.5 && (req.surge.is_some() || req.profile.is_some()) {
            margin *= 2.0;
            let wider = choose_levels(model, &solution.alpha, req, margin);
            if wider != levels && wider.iter().map(|&k| (k + 1) as f64).product::<f64>() <= req.max_states as f64 {
                continue;
            }
        }
        return Ok(out);
    }
}

/// The exact transient on the box given by `levels` (tests use this to study the truncation).
pub fn exact_with_levels(model: &JacksonModel, solution: &jackson::JacksonSolution, req: &Request, levels: &[usize], progress: &mut dyn FnMut(f64) -> bool) -> Result<Exact, Refusal> {
    let d = model.mu.len();
    let size: f64 = levels.iter().map(|&k| (k + 1) as f64).product();
    if size > req.max_states as f64 {
        return Err(Refusal::TooManyStates { states: size, limit: req.max_states });
    }
    let base_rate: f64 = model.gamma.iter().sum();
    let max_factor = match &req.profile {
        // The uniformisation rate must cover the busiest piece.
        Some(p) if base_rate > 0.0 => p.gamma.iter().map(|g| g.iter().sum::<f64>() / base_rate).fold(1.0, f64::max),
        Some(_) => 1.0,
        None => req.surge.map(|s| s.factor).unwrap_or(1.0),
    };
    let chain = Chain::new(model, levels, max_factor);
    let times = time_grid(req);
    let steps = times.len() - 1;
    let eps_step = req.epsilon / steps as f64;
    // The work, before any of it is done.
    let planned: f64 = (0..steps).map(|k| poisson_len(chain.rate * (times[k + 1] - times[k]), eps_step)).sum();
    if planned * chain.states as f64 > MAX_WORK {
        return Err(Refusal::TooMuchWork { products: planned, states: chain.states });
    }

    // The stationary product form on the box.
    let marginals: Vec<(Vec<f64>, f64)> = (0..d).map(|i| mmc_marginal(model.servers[i], solution.alpha[i] / model.mu[i], levels[i])).collect();
    let mut pi = vec![0.0; chain.states];
    chain.for_each_state(|x, n| pi[x] = (0..d).map(|i| marginals[i].0[n[i]]).product());
    let stationary_tail = (1.0 - pi.iter().sum::<f64>()).max(0.0);

    let mut p = match &req.initial {
        Initial::Empty => {
            let mut v = vec![0.0; chain.states];
            v[0] = 1.0;
            v
        }
        Initial::Steady => pi.clone(),
        Initial::Given(n0) => {
            let n: Vec<usize> = n0.iter().map(|&x| x as usize).collect();
            let mut v = vec![0.0; chain.states];
            v[chain.index(&n)] = 1.0;
            v
        }
    };

    let mut mean = vec![Vec::with_capacity(times.len()); d];
    let mut empty = vec![Vec::with_capacity(times.len()); d];
    let mut distance = Vec::with_capacity(times.len());
    let mut missing_mass = Vec::with_capacity(times.len());
    let mut record = |p: &[f64]| {
        let mut m = vec![0.0; d];
        let mut e = vec![0.0; d];
        let mut total = 0.0;
        let mut l1 = 0.0;
        chain.for_each_state(|x, n| {
            let w = p[x];
            total += w;
            l1 += (w - pi[x]).abs();
            for i in 0..d {
                m[i] += w * n[i] as f64;
                if n[i] == 0 {
                    e[i] += w;
                }
            }
        });
        let miss = (1.0 - total).max(0.0);
        for i in 0..d {
            mean[i].push(m[i]);
            empty[i].push(e[i]);
        }
        // Mass outside the box, or lost, counts in full.
        distance.push((0.5 * (l1 + miss + stationary_tail)).min(1.0));
        missing_mass.push(miss);
    };
    record(&p);

    let mut products = 0usize;
    let mut poisson_bound = 0.0;
    let mut arrivals = vec![0.0; d];
    for k in 0..steps {
        arrivals.copy_from_slice(&rates_on(model, req, times[k], times[k + 1]));
        let mut go = true;
        let done = &mut products;
        let bound = uniformised_step(&mut p, chain.rate * (times[k + 1] - times[k]), eps_step, &mut |v, out| chain.apply(&arrivals, v, out), &mut || {
            *done += 1;
            if *done % 16 == 0 {
                go = progress((*done as f64 / planned).min(1.0));
            }
            go
        })
        .map_err(|_| Refusal::Stopped)?;
        poisson_bound += bound;
        record(&p);
    }

    // The error of the means (module text, (★)): K_i·missing mass + the dominating regime's mean
    // beyond K_i. The regime is the network as drawn until an upward surge starts, the surged
    // network from then on (its law dominates for good: the rates only fall back afterwards).
    let up = req.surge.filter(|s| s.factor > 1.0 && s.from < req.horizon);
    let base = mean_beyond_bound(model, &solution.alpha, 1.0, levels, &req.initial);
    let surged = up.and_then(|s| mean_beyond_bound(model, &solution.alpha, s.factor, levels, &req.initial));
    // With a stored profile: per time, the network of the largest rates in force so far (module
    // text). It changes only when a new piece has started, so it is solved once per piece.
    let by_profile: Option<Vec<Option<Vec<f64>>>> = req.profile.as_ref().map(|p| {
        // A start in the drawn network's steady state needs the dominating rates to be at least
        // the drawn ones; an empty or a given start does not.
        let floor: Vec<f64> = if req.initial == Initial::Steady { model.gamma.clone() } else { vec![0.0; d] };
        let mut cache: Vec<(Vec<f64>, Option<Vec<f64>>)> = Vec::new();
        times
            .iter()
            .map(|&t| {
                let top = p.largest_before(t - 1e-12 * req.horizon, &floor);
                if let Some((_, bound)) = cache.iter().find(|(g, _)| g == &top) {
                    return bound.clone();
                }
                let bound = jackson::throughputs(&JacksonModel { gamma: top.clone(), ..model.clone() }).and_then(|a| mean_beyond_bound(model, &a, 1.0, levels, &req.initial));
                cache.push((top, bound.clone()));
                bound
            })
            .collect()
    });
    let shortfall: Vec<Vec<Option<f64>>> = (0..d)
        .map(|i| {
            (0..times.len())
                .map(|k| {
                    let regime = match (&by_profile, up) {
                        (Some(per_time), _) => &per_time[k],
                        (None, Some(s)) if times[k] > s.from + 1e-12 * req.horizon => &surged,
                        _ => &base,
                    };
                    regime.as_ref().map(|t| levels[i] as f64 * missing_mass[k] + t[i])
                })
                .collect()
        })
        .collect();

    // Settling is looked for once the rates are the drawn network's for good: after a surge, or
    // after the last breakpoint of a profile that does not repeat. A periodic profile never
    // settles (the horizon stands in, so nothing is found).
    let settle_from = match &req.profile {
        Some(p) if p.periodic => req.horizon,
        Some(p) => p.breaks.last().copied().unwrap_or(0.0),
        None => req.surge.map(|s| s.until.min(req.horizon)).unwrap_or(0.0),
    };
    let mut settling = Vec::with_capacity(d);
    let mut uncertified = Vec::with_capacity(d);
    for i in 0..d {
        let (s, u) = if req.profile.as_ref().is_some_and(|p| p.periodic) { (None, false) } else { certified_settling(&times, &mean[i], &shortfall[i], solution.number[i], req.settle_fraction, settle_from) };
        settling.push(s);
        uncertified.push(u);
    }
    Ok(Exact {
        times,
        mean,
        shortfall,
        empty,
        distance,
        missing_mass,
        stationary: solution.number.clone(),
        settling,
        uncertified,
        settle_from,
        levels: levels.to_vec(),
        states: chain.states,
        uniformisation_rate: chain.rate,
        products,
        poisson_bound,
        stationary_tail,
    })
}

/// How many products one step of Poisson mean `a` takes (the length of its weights, less one).
fn poisson_len(a: f64, eps: f64) -> f64 {
    if !(a > 0.0) {
        return 0.0;
    }
    if a > 1e6 {
        // Never computed: only to refuse. The cut is near a + 7√a for the tolerances used.
        return a + 8.0 * a.sqrt();
    }
    (poisson_weights(a, eps).weights.len() - 1) as f64
}

// ── The fluid model ──────────────────────────────────────────────────────────────────────────────

/// The fluid path: `level[i][k]` is the fluid at station i at `times[k]` (customers).
#[derive(Clone, Debug, PartialEq)]
pub struct Fluid {
    pub times: Vec<f64>,
    pub level: Vec<Vec<f64>>,
    /// The times at which a station ran empty.
    pub emptied: Vec<(usize, f64)>,
}

/// The processing rates D of the fluid network when the stations in `holding` hold fluid:
/// D_i = κ_i there, D_i = min(κ_i, γ_i + Σ_j p_ji·D_j) at the empty ones. Found by iterating
/// down from D = κ: the map is monotone, so the iterates decrease to the largest solution.
fn fluid_rates(model: &JacksonModel, gamma: &[f64], cap: &[f64], holding: &[bool]) -> Vec<f64> {
    let d = cap.len();
    let mut rate = cap.to_vec();
    for _ in 0..200_000 {
        let mut change: f64 = 0.0;
        for i in 0..d {
            if !holding[i] {
                let inflow = gamma[i] + (0..d).map(|j| model.p[j][i] * rate[j]).sum::<f64>();
                let r = cap[i].min(inflow);
                change = change.max((rate[i] - r).abs());
                rate[i] = r;
            }
        }
        if change <= 1e-15 * cap.iter().cloned().fold(1.0, f64::max) {
            break;
        }
    }
    rate
}

/// The fluid path of `model` on the request's time grid. `Initial::Steady` starts from the fluid
/// model's own rest point of a stable network, which is empty.
pub fn fluid(model: &JacksonModel, req: &Request) -> Fluid {
    let d = model.mu.len();
    let cap: Vec<f64> = (0..d).map(|i| model.servers[i].max(1) as f64 * model.mu[i]).collect();
    let times = time_grid(req);
    let mut q: Vec<f64> = match &req.initial {
        Initial::Given(n) if n.len() == d => n.iter().map(|&x| x as f64).collect(),
        _ => vec![0.0; d],
    };
    let mut level: Vec<Vec<f64>> = (0..d).map(|i| vec![q[i]]).collect();
    let mut emptied = Vec::new();
    let mut gamma = vec![0.0; d];
    for k in 0..times.len() - 1 {
        gamma.copy_from_slice(&rates_on(model, req, times[k], times[k + 1]));
        let mut t = times[k];
        let end = times[k + 1];
        // Each pass ends at the interval's end or at a station running empty: at most d of the
        // latter with constant rates, but allow more for rounding.
        for _ in 0..(4 * d + 8) {
            let holding: Vec<bool> = q.iter().map(|&x| x > 0.0).collect();
            let rate = fluid_rates(model, &gamma, &cap, &holding);
            let slope: Vec<f64> = (0..d)
                .map(|i| {
                    let s = gamma[i] + (0..d).map(|j| model.p[j][i] * rate[j]).sum::<f64>() - rate[i];
                    // An empty station cannot go below zero (rounding only).
                    if holding[i] { s } else { s.max(0.0) }
                })
                .collect();
            let mut dt = end - t;
            let mut hit = None;
            for i in 0..d {
                if holding[i] && slope[i] < 0.0 {
                    let to_empty = q[i] / -slope[i];
                    if to_empty <= dt {
                        dt = to_empty;
                        hit = Some(i);
                    }
                }
            }
            for i in 0..d {
                q[i] = (q[i] + slope[i] * dt).max(0.0);
            }
            t += dt;
            match hit {
                Some(i) => {
                    q[i] = 0.0;
                    emptied.push((i, t));
                }
                None => break,
            }
        }
        for i in 0..d {
            level[i].push(q[i]);
        }
    }
    Fluid { times, level, emptied }
}

// ── From a drawn network ─────────────────────────────────────────────────────────────────────────

/// Which tiers apply to a drawn network, with the station-level model each uses.
#[derive(Clone, Debug)]
pub struct Applicability {
    /// The model of the exact tier, or why there is none.
    pub exact: Result<JacksonModel, String>,
    /// The model of the fluid tier (the same rates; also for non-exponential laws), or why none.
    pub fluid: Result<JacksonModel, String>,
}

/// A network with a sink but no source (one drawn closed has its own sentence, `closed::open_only`).
pub const CLOSED_SENTENCE: &str = "Transient analysis covers open networks: this network has no source, so nothing arrives from outside.";
pub const FINITE_SENTENCE: &str = "Transient analysis covers networks with infinite buffers: with finite buffers the result depends on the blocking rule, which this analysis does not model.";

/// What can be computed for `net`.
pub fn applicability(net: &Network) -> Applicability {
    // A network drawn as a closed one, by the one rule (`closed::drawn_as`), in its own words.
    if let Some((_, sentence)) = crate::closed::open_only(net, "Transient analysis") {
        return Applicability { exact: Err(sentence.clone()), fluid: Err(sentence) };
    }
    if net.nodes_of(NodeKind::Source).next().is_none() {
        return Applicability { exact: Err(CLOSED_SENTENCE.into()), fluid: Err(CLOSED_SENTENCE.into()) };
    }
    if !net.infinite_buffers {
        return Applicability { exact: Err(FINITE_SENTENCE.into()), fluid: Err(FINITE_SENTENCE.into()) };
    }
    // New in 2.1: a rate profile is modelled here (`profile_of`); priorities and batches are not.
    let unmodelled = extended::refusal_except(net, "Transient analysis", &[Feature::TimeVaryingRates]).or_else(|| extended::problems(net).into_iter().next().map(|p| p.message));
    if let Some(sentence) = unmodelled {
        return Applicability { exact: Err(sentence.clone()), fluid: Err(sentence) };
    }
    let exact = jackson::from_network(net).map_err(|e| match e {
        jackson::JacksonError::NotJackson => "The exact calculation needs Poisson arrivals, exponential service times and one customer class at each station, so that the numbers at the stations form a Markov chain. The fluid approximation depends on the rates only.".to_string(),
        other => other.message(),
    });
    let fluid = match &exact {
        Ok(m) => Ok(m.clone()),
        Err(_) => fluid_model(net),
    };
    Applicability { exact, fluid }
}

/// What the stored rate profiles of `net`'s sources make of the external arrival rates of
/// `model` (the exact or the fluid model of the same network) up to `horizon`: None when no
/// source has a profile. Class k is the k-th source in export order, as in `traffic::compute`;
/// the rate into station i on a piece is Σ_k m_k(t)·λ_{k,i}.
pub fn profile_of(net: &Network, model: &JacksonModel, horizon: f64) -> Result<Option<Profile>, String> {
    if !extended::uses(net, Feature::TimeVaryingRates) {
        return Ok(None);
    }
    let data = traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).map_err(|e| e.message())?;
    let sources = naming::in_export_order(net.nodes_of(NodeKind::Source), |n| n.name.as_str());
    let d = model.mu.len();
    if data.d != d || sources.len() > data.k {
        return Err("The sources of the network could not be matched to its traffic equations.".into());
    }
    let mut breaks: Vec<f64> = sources.iter().filter_map(|s| s.rate_profile.as_ref()).flat_map(|r| r.breakpoints(horizon)).collect();
    breaks.sort_by(|a, b| a.partial_cmp(b).unwrap());
    breaks.dedup_by(|a, b| (*a - *b).abs() <= 1e-12 * horizon);
    if breaks.len() > 2_000 {
        return Err("The rate profile changes more than 2,000 times within the horizon. Shorten the horizon.".into());
    }
    let pieces = breaks.len() + 1;
    let gamma = (0..pieces)
        .map(|j| {
            let a = if j == 0 { 0.0 } else { breaks[j - 1] };
            let b = breaks.get(j).copied().unwrap_or(horizon);
            let mid = 0.5 * (a + b);
            (0..d).map(|i| (0..data.k).map(|k| data.class_external_arrival_rates[k][i] * sources.get(k).and_then(|s| s.rate_profile.as_ref()).map(|r| r.multiplier_at(mid)).unwrap_or(1.0)).sum()).collect()
        })
        .collect();
    Ok(Some(Profile { breaks, gamma, periodic: sources.iter().any(|s| s.rate_profile.as_ref().is_some_and(|r| r.periodic)) }))
}

/// The rates of the fluid model for a network that need not be Jackson: any distributions, any
/// load, but one service rate at each station (classes sharing a station at different rates
/// would make the fluid path depend on the service discipline).
fn fluid_model(net: &Network) -> Result<JacksonModel, String> {
    let data = traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).map_err(|e| e.message())?;
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
    if stations.len() != data.d {
        return Err("The stations of the network could not be matched to its traffic equations.".into());
    }
    for i in 0..data.d {
        let rates: Vec<f64> = (0..data.k).filter(|&k| data.alpha_per_class[k][i] > 1e-12).map(|k| data.class_service_rates[k][i]).collect();
        if rates.iter().any(|r| (r - rates[0]).abs() > 1e-12 * rates[0].abs()) {
            return Err(format!("{} serves customer classes at different rates, so its fluid path depends on the order of service, which this analysis does not model.", stations[i].name));
        }
        if !(data.service_rates[i] > 0.0) || !data.service_rates[i].is_finite() {
            return Err(format!("{} has no service rate.", stations[i].name));
        }
    }
    Ok(JacksonModel {
        ids: stations.iter().map(|s| s.id.clone()).collect(),
        names: stations.iter().map(|s| s.name.clone()).collect(),
        gamma: (0..data.d).map(|i| data.class_external_arrival_rates.iter().map(|row| row[i]).sum()).collect(),
        p: data.aggregated_p.clone(),
        mu: data.service_rates.clone(),
        servers: data.servers.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bnet;
    use std::path::Path;

    fn one_station(lambda: f64, mu: f64, servers: i64) -> JacksonModel {
        JacksonModel { ids: vec!["A".into()], names: vec!["S1".into()], gamma: vec![lambda], p: vec![vec![0.0]], mu: vec![mu], servers: vec![servers] }
    }

    fn tandem(lambda: f64, mu1: f64, mu2: f64) -> JacksonModel {
        JacksonModel { ids: vec!["A".into(), "B".into()], names: vec!["S1".into(), "S2".into()], gamma: vec![lambda, 0.0], p: vec![vec![0.0, 1.0], vec![0.0, 0.0]], mu: vec![mu1, mu2], servers: vec![1, 1] }
    }

    fn example(name: &str) -> Network {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(format!("{name}.bnet"));
        bnet::read(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn run(model: &JacksonModel, req: &Request) -> Exact {
        exact(model, req, &mut |_| true).unwrap()
    }

    /// The Poisson weights: they sum to 1 less at most the stated tail bound, and the bound is a
    /// bound (compared with the tail summed directly far past the cut). Small, moderate and
    /// large means; 1e-13 allows for rounding in a sum of up to 10⁴ terms.
    #[test]
    fn poisson_weights_sum_to_one_within_the_stated_tail_bound() {
        for a in [1e-3, 0.5, 7.0, 150.0, 4000.0] {
            for eps in [1e-6, 1e-10, 1e-13] {
                let w = poisson_weights(a, eps);
                let sum: f64 = w.weights.iter().sum();
                assert!(w.tail_bound <= eps, "a={a} eps={eps}");
                assert!(1.0 - sum <= w.tail_bound + 1e-13, "a={a} eps={eps}: deficit {} bound {}", 1.0 - sum, w.tail_bound);
                assert!(sum <= 1.0 + 1e-13);
                // The true tail, by continuing the recursion: below the bound.
                let n0 = w.weights.len();
                let mut term = (-a + n0 as f64 * a.ln() - (1..=n0).map(|k| (k as f64).ln()).sum::<f64>()).exp();
                let mut tail = 0.0;
                for n in n0..n0 + 2000 {
                    tail += term;
                    term *= a / (n + 1) as f64;
                }
                assert!(tail <= w.tail_bound * (1.0 + 1e-9) + 1e-300, "a={a} eps={eps}: tail {tail} bound {}", w.tail_bound);
            }
        }
    }

    /// The uniformisation kernel on a two-state chain with rates a (0→1) and b (1→0), whose
    /// transient is known in closed form: p₁(t) = a/(a+b)·(1 − e^{−(a+b)t}) from state 0
    /// (e.g. Ross, *Introduction to Probability Models*, 10th ed., Example 6.11). The error is
    /// within the stated Poisson bound (plus 1e-14 rounding), and so is the missing mass.
    #[test]
    fn a_two_state_chain_matches_its_closed_form_within_the_stated_bound() {
        let (a, b) = (3.0, 0.5);
        let rate = 3.0; // Λ = max exit rate
        let mut step = |v: &[f64], out: &mut [f64]| {
            out[0] = v[0] * (1.0 - a / rate) + v[1] * b / rate;
            out[1] = v[0] * a / rate + v[1] * (1.0 - b / rate);
        };
        for eps in [1e-4, 1e-8, 1e-12] {
            let mut p = vec![1.0, 0.0];
            let mut bound = 0.0;
            let h = 0.37;
            for k in 1..=20 {
                bound += uniformised_step(&mut p, rate * h, eps / 20.0, &mut step, &mut || true).unwrap();
                let t = h * k as f64;
                let p1 = a / (a + b) * (1.0 - (-(a + b) * t).exp());
                assert!((p[1] - p1).abs() <= bound + 1e-14, "eps={eps} t={t}: {} vs {p1}, bound {bound}", p[1]);
                assert!((p[0] - (1.0 - p1)).abs() <= bound + 1e-14);
                let missing = 1.0 - p[0] - p[1];
                assert!(missing >= -1e-14 && missing <= bound + 1e-14);
            }
            assert!(bound <= eps);
        }
    }

    /// Kolmogorov's forward equations of an M/M/1 queue cut at K, integrated by classical RK4:
    /// the independent route the exact tier is held to. Mass that would pass K is dropped, as
    /// in the exact tier, so the two solve the same equations.
    fn mm1_by_runge_kutta(lambda: f64, mu: f64, k: usize, t_end: f64, steps: usize) -> Vec<f64> {
        let deriv = |p: &[f64], out: &mut [f64]| {
            for n in 0..=k {
                let mut x = -(lambda + if n > 0 { mu } else { 0.0 }) * p[n];
                if n > 0 {
                    x += lambda * p[n - 1];
                }
                if n < k {
                    x += mu * p[n + 1];
                }
                out[n] = x;
            }
        };
        let mut p = vec![0.0; k + 1];
        p[0] = 1.0;
        let h = t_end / steps as f64;
        let (mut k1, mut k2, mut k3, mut k4, mut tmp) = (vec![0.0; k + 1], vec![0.0; k + 1], vec![0.0; k + 1], vec![0.0; k + 1], vec![0.0; k + 1]);
        for _ in 0..steps {
            deriv(&p, &mut k1);
            for n in 0..=k {
                tmp[n] = p[n] + 0.5 * h * k1[n];
            }
            deriv(&tmp, &mut k2);
            for n in 0..=k {
                tmp[n] = p[n] + 0.5 * h * k2[n];
            }
            deriv(&tmp, &mut k3);
            for n in 0..=k {
                tmp[n] = p[n] + h * k3[n];
            }
            deriv(&tmp, &mut k4);
            for n in 0..=k {
                p[n] += h / 6.0 * (k1[n] + 2.0 * k2[n] + 2.0 * k3[n] + k4[n]);
            }
        }
        p
    }

    /// M/M/1 from empty, λ = 0.8, μ = 1: the mean and P(empty) at t = 5, 20, 60 against an
    /// independent integration of the forward equations (RK4, step 1/400, on 400 states: its
    /// global error is of order h⁴·t ≈ 10⁻⁹ and the truncation at 400 loses less than 0.8⁴⁰⁰).
    /// Agreement to 1e-7 (seen: about 1e-9); the uniformisation tolerance is 1e-10.
    #[test]
    fn mm1_from_empty_matches_an_independent_integration_of_the_forward_equations() {
        let model = one_station(0.8, 1.0, 1);
        let req = Request { horizon: 60.0, intervals: 12, epsilon: 1e-10, ..Request::default() };
        let out = run(&model, &req);
        for (k, t) in [(1usize, 5.0), (4, 20.0), (12, 60.0)] {
            assert!((out.times[k] - t).abs() < 1e-12);
            let p = mm1_by_runge_kutta(0.8, 1.0, 400, t, (t * 400.0) as usize);
            let mean: f64 = p.iter().enumerate().map(|(n, x)| n as f64 * x).sum();
            assert!((out.mean[0][k] - mean).abs() < 1e-7, "t={t}: mean {} vs {mean}", out.mean[0][k]);
            assert!((out.empty[0][k] - p[0]).abs() < 1e-7, "t={t}: P0 {} vs {}", out.empty[0][k], p[0]);
        }
    }

    /// An exact identity of the M/M/1 queue, a third route: dE[N]/dt = λ − μ(1 − P₀(t)) (take
    /// expectations in the forward equations), so E[N](T) = λT − μ∫(1 − P₀). The integral by
    /// Simpson's rule on the computed P₀ (step 0.05: error of order 10⁻⁷).
    #[test]
    fn mm1_mean_and_empty_probability_satisfy_the_rate_balance_identity() {
        let (lambda, mu) = (0.6, 1.0);
        let out = run(&one_station(lambda, mu, 1), &Request { horizon: 20.0, intervals: 400, epsilon: 1e-11, ..Request::default() });
        let h = 20.0 / 400.0;
        let f: Vec<f64> = out.empty[0].iter().map(|p0| 1.0 - p0).collect();
        let mut integral = f[0] + f[400];
        for k in 1..400 {
            integral += f[k] * if k % 2 == 1 { 4.0 } else { 2.0 };
        }
        integral *= h / 3.0;
        let by_identity = lambda * 20.0 - mu * integral;
        assert!((out.mean[0][400] - by_identity).abs() < 1e-5, "{} vs {by_identity}", out.mean[0][400]);
    }

    /// M/M/∞ in closed form: from empty the number present is Poisson with mean
    /// m(t) = (λ/μ)(1 − e^{−μt}) at every t (e.g. Gross et al., *Fundamentals of Queueing
    /// Theory*, 4th ed., §2.11.1), so P(empty) = e^{−m(t)}. A station with 60 servers and
    /// offered load 2 is truncated below 60 (asserted), so inside the box it *is* M/M/∞: this
    /// checks the μ·min(n, c) rates of the generator. Tolerance 1e-7 = 10 × the tolerance asked.
    #[test]
    fn many_servers_match_the_infinite_server_closed_form() {
        let (lambda, mu) = (2.0, 1.0);
        let out = run(&one_station(lambda, mu, 60), &Request { horizon: 8.0, intervals: 40, ..Request::default() });
        assert!(out.levels[0] < 60, "level {}", out.levels[0]);
        for (k, &t) in out.times.iter().enumerate() {
            let m = lambda / mu * (1.0 - (-mu * t).exp());
            assert!((out.mean[0][k] - m).abs() < 1e-7, "t={t}: {} vs {m}", out.mean[0][k]);
            assert!((out.empty[0][k] - (-m).exp()).abs() < 1e-7, "t={t}");
        }
    }

    /// The transient of a Jackson network converges to Jackson's stationary means
    /// (`jackson::solve`; for this example L = 7/3 at both stations, the recorded Product Form
    /// run golden/runs/OpenJackson.d2.feedback.p30.inf/product_form), from empty and from a
    /// loaded start, and the distance to stationarity falls to the truncation's own size.
    /// At t = 400 (≈ 40 relaxation times) what is left is the neglected mass: 1e-5.
    #[test]
    fn the_transient_converges_to_the_jackson_stationary_means() {
        let model = jackson::from_network(&example("OpenJackson.d2.feedback.p30.inf")).unwrap();
        let sol = jackson::solve(&model).unwrap();
        assert!((sol.number[0] - 7.0 / 3.0).abs() < 1e-12 && (sol.number[1] - 7.0 / 3.0).abs() < 1e-12);
        for initial in [Initial::Empty, Initial::Given(vec![6, 3])] {
            let out = run(&model, &Request { horizon: 400.0, intervals: 100, initial: initial.clone(), ..Request::default() });
            for i in 0..2 {
                let last = *out.mean[i].last().unwrap();
                assert!((last - sol.number[i]).abs() < 1e-5, "{initial:?} station {i}: {last}");
                assert!(out.settling[i].is_some());
            }
            assert!(out.distance[0] > 0.5);
            assert!(*out.distance.last().unwrap() < 1e-5, "distance {}", out.distance.last().unwrap());
        }
    }

    /// Started in the steady state with no surge, nothing moves: the product form is stationary
    /// for the generator built here (this is Jackson's theorem checked on the generator, with
    /// feedback and two servers). What moves is the mass at the box's edge: below 1e-6.
    #[test]
    fn the_product_form_is_stationary_for_the_generator() {
        let model = JacksonModel {
            ids: vec!["A".into(), "B".into()],
            names: vec!["S1".into(), "S2".into()],
            gamma: vec![1.0, 0.3],
            p: vec![vec![0.1, 0.6], vec![0.25, 0.0]],
            mu: vec![1.2, 2.0],
            servers: vec![2, 1],
        };
        let sol = jackson::solve(&model).unwrap();
        let out = run(&model, &Request { horizon: 30.0, intervals: 30, initial: Initial::Steady, ..Request::default() });
        for i in 0..2 {
            for k in 0..out.times.len() {
                assert!((out.mean[i][k] - sol.number[i]).abs() < 1e-6, "station {i} at {}: {} vs {}", out.times[k], out.mean[i][k], sol.number[i]);
            }
            assert_eq!(out.settling[i], Some(0.0));
        }
        assert!(out.distance.iter().all(|&x| x < 1e-6));
    }

    /// Probability is conserved up to the reported missing mass, which is non-negative, never
    /// decreases, and stays small (the Poisson bound, 1e-8, plus what leaves the box: the
    /// stationary tail is 1e-8 and the paths that reach the edge in 200 time units are few).
    /// The a priori Poisson bound is within the tolerance asked for.
    #[test]
    fn mass_is_conserved_up_to_the_reported_missing_mass() {
        let model = tandem(0.7, 1.0, 0.9);
        let out = run(&model, &Request { horizon: 200.0, intervals: 50, ..Request::default() });
        assert!(out.poisson_bound <= 1e-8);
        assert!(out.missing_mass[0] == 0.0);
        for k in 1..out.times.len() {
            assert!(out.missing_mass[k] >= out.missing_mass[k - 1] - 1e-13);
        }
        assert!(*out.missing_mass.last().unwrap() < 1e-6, "missing {}", out.missing_mass.last().unwrap());
        assert!(out.stationary_tail <= 1e-8);
    }

    /// The missing mass is the whole error: with a box far too small (K = 6 for ρ = 0.8) the
    /// computed mean is below the true one (taken from a box of 150) by no more than
    /// (missing mass) × (the largest number the true chain is likely to hold) — checked in the
    /// rigorous form for a probability: |P̂(empty) − P(empty)| ≤ missing mass, and P̂ ≤ P.
    #[test]
    fn the_missing_mass_bounds_the_truncation_error() {
        let model = one_station(0.8, 1.0, 1);
        let sol = jackson::solve(&model).unwrap();
        let req = Request { horizon: 30.0, intervals: 30, ..Request::default() };
        let small = exact_with_levels(&model, &sol, &req, &[6], &mut |_| true).unwrap();
        let large = exact_with_levels(&model, &sol, &req, &[150], &mut |_| true).unwrap();
        assert!(*small.missing_mass.last().unwrap() > 0.05);
        for k in 0..small.times.len() {
            let gap = large.empty[0][k] - small.empty[0][k];
            assert!(gap >= -1e-12 && gap <= small.missing_mass[k] + 1e-9, "t={}: gap {gap}, missing {}", small.times[k], small.missing_mass[k]);
            assert!(small.mean[0][k] <= large.mean[0][k] + 1e-12);
        }
    }

    /// The mean beyond a level in closed form, against the sum taken term by term: M/M/1
    /// (Σ_{n>K}(n − K)(1 − ρ)ρⁿ = ρ^{K+1}/(1 − ρ)), and M/M/3 below and above c − 1. And
    /// P(N ≥ m) against 1 − Σ. 1e-13 relative: both are sums of positive terms.
    #[test]
    fn the_mean_beyond_a_level_matches_the_sum_taken_term_by_term() {
        assert!((mean_beyond(1, 0.75, 30) - 0.75f64.powi(31) / 0.25).abs() < 1e-18);
        assert!((mean_beyond(1, 0.75, 0) - 3.0).abs() < 1e-12, "E[N] itself at K = 0");
        for (c, a) in [(1i64, 0.9), (3, 2.4), (3, 0.3), (8, 5.0)] {
            let (pmf, _) = mmc_marginal(c, a, 4000);
            for k in [0usize, 1, 2, 5, 9, 40] {
                let direct: f64 = (k + 1..=4000).map(|n| (n - k) as f64 * pmf[n]).sum();
                let got = mean_beyond(c, a, k);
                assert!((got - direct).abs() <= 1e-12 * direct.max(1e-300) + 1e-300, "c={c} a={a} k={k}: {got} vs {direct}");
                let p: f64 = pmf[k..].iter().sum();
                assert!((at_least(c, a, k) - p).abs() <= 1e-12 * p, "c={c} a={a} k={k}");
                let level = truncation_level_for_mean(c, a, 1e-9);
                assert!(mean_beyond(c, a, level) <= 1e-9 && (level == 0 || mean_beyond(c, a, level - 1) > 1e-9));
            }
        }
    }

    /// The scenario of the false claim "short by at most K × missing mass": an M/M/1 queue with
    /// E[N] = 3 (ρ = 0.75) started in its steady state on a box of K = 30. At time 0 the
    /// computed mean is short by Σ_{n>30} n·π(n) = (K + 1 + ρ/(1 − ρ))·ρ^{K+1} = 34 × missing
    /// mass, more than K × missing mass; the stated bound K·missing + T(K) is exactly that
    /// (30 + 4 = 34), and holds at every later time against a box of 400.
    #[test]
    fn the_stated_shortfall_bounds_the_mean_where_k_times_the_missing_mass_does_not() {
        let model = one_station(0.75, 1.0, 1);
        let sol = jackson::solve(&model).unwrap();
        let req = Request { horizon: 40.0, intervals: 40, initial: Initial::Steady, ..Request::default() };
        let small = exact_with_levels(&model, &sol, &req, &[30], &mut |_| true).unwrap();
        let large = exact_with_levels(&model, &sol, &req, &[400], &mut |_| true).unwrap();
        let miss0 = small.missing_mass[0];
        assert!((miss0 - 0.75f64.powi(31)).abs() < 1e-15);
        let short0 = 3.0 - small.mean[0][0];
        assert!((short0 - 34.0 * miss0).abs() < 1e-12 && short0 > 30.0 * miss0 * 1.1, "the old claim fails: {short0} vs {}", 30.0 * miss0);
        assert!((small.shortfall[0][0].unwrap() - short0).abs() < 1e-12, "the bound is attained at time 0");
        for k in 0..small.times.len() {
            let gap = large.mean[0][k] - small.mean[0][k];
            let bound = small.shortfall[0][k].unwrap();
            assert!(gap >= -1e-12 && gap <= bound + 1e-12, "t={}: gap {gap}, bound {bound}", small.times[k]);
        }
    }

    /// The bound holds against a much larger truncation in each case the argument covers: from
    /// empty on a box far too small; a two-station network with feedback; a given start (the
    /// conditioning factor 1/q); a surge the network stays stable under, from the steady state.
    /// The reference boxes are so large that their own shortfall bound is below 1e-5 (it is the
    /// Poisson tolerance 1e-8 times the level); the reference is a lower bound too, so the
    /// comparison `gap ≤ bound` needs no allowance for it.
    #[test]
    fn the_shortfall_bound_holds_against_a_much_larger_truncation() {
        let feedback = JacksonModel { ids: vec!["a".into(), "b".into()], names: vec!["S1".into(), "S2".into()], gamma: vec![0.5, 0.0], p: vec![vec![0.0, 1.0], vec![0.3, 0.0]], mu: vec![1.0, 1.0], servers: vec![1, 1] };
        let surge = Some(Surge { factor: 1.5, from: 5.0, until: 20.0 });
        let cases: Vec<(JacksonModel, Request, Vec<usize>, Vec<usize>)> = vec![
            (one_station(0.8, 1.0, 1), Request { horizon: 30.0, intervals: 30, ..Request::default() }, vec![6], vec![200]),
            (feedback.clone(), Request { horizon: 30.0, intervals: 30, ..Request::default() }, vec![5, 4], vec![110, 110]),
            (one_station(0.6, 1.0, 1), Request { horizon: 20.0, intervals: 40, initial: Initial::Given(vec![5]), ..Request::default() }, vec![9], vec![200]),
            (feedback, Request { horizon: 20.0, intervals: 20, initial: Initial::Given(vec![2, 3]), ..Request::default() }, vec![7, 7], vec![110, 110]),
            (one_station(0.5, 1.0, 2), Request { horizon: 40.0, intervals: 40, initial: Initial::Steady, surge, ..Request::default() }, vec![8], vec![300]),
            (one_station(0.5, 1.0, 1), Request { horizon: 40.0, intervals: 40, initial: Initial::Steady, surge, ..Request::default() }, vec![10], vec![300]),
        ];
        for (n, (model, req, small_levels, large_levels)) in cases.iter().enumerate() {
            let sol = jackson::solve(model).unwrap();
            let small = exact_with_levels(model, &sol, req, small_levels, &mut |_| true).unwrap();
            let large = exact_with_levels(model, &sol, req, large_levels, &mut |_| true).unwrap();
            let mut worst = 0.0f64;
            for i in 0..model.mu.len() {
                for k in 0..small.times.len() {
                    // The reference is itself a lower bound, short by at most its own (small) bound.
                    let slack = large.shortfall[i][k].unwrap();
                    assert!(slack < 1e-5, "case {n}: the reference is not exact enough ({slack})");
                    let gap = large.mean[i][k] - small.mean[i][k];
                    let bound = small.shortfall[i][k].unwrap();
                    assert!(gap >= -slack - 1e-12 && gap <= bound + 1e-12, "case {n}, station {i}, t={}: gap {gap}, bound {bound}", small.times[k]);
                    worst = worst.max(gap);
                }
            }
            assert!(worst > 1e-3, "case {n}: the small box does lose something ({worst})");
        }
    }

    /// Where the argument does not apply no bound is given: a surge that overloads the network
    /// (λ doubles to 1.6 > μ = 1) has a bound until the surge starts and none afterwards, and a
    /// settling time is not declared (`uncertified`), although the computed curve returns to the
    /// band. With the levels the request chooses and a stable network, the bound is far below
    /// the tolerance of the settling band, and the settling time is the computed curve's.
    #[test]
    fn no_bound_is_claimed_under_an_overloading_surge_and_settling_is_not_certified() {
        let model = one_station(0.8, 1.0, 1);
        let req = Request { horizon: 400.0, intervals: 200, initial: Initial::Steady, surge: Some(Surge { factor: 2.0, from: 10.0, until: 30.0 }), ..Request::default() };
        let out = run(&model, &req);
        for k in 0..out.times.len() {
            assert_eq!(out.shortfall[0][k].is_some(), out.times[k] <= 10.0, "t={}", out.times[k]);
        }
        assert!(settling_time(&out.times, &out.mean[0], 4.0, 0.05, 30.0).is_some(), "the computed curve itself comes back");
        assert_eq!((out.settling[0], out.uncertified[0]), (None, true));

        let calm = run(&model, &Request { horizon: 200.0, intervals: 200, ..Request::default() });
        let worst = calm.shortfall[0].iter().map(|b| b.unwrap()).fold(0.0, f64::max);
        assert!(worst < 1e-6, "the levels keep the error of the mean small: {worst}");
        let plain = settling_time(&calm.times, &calm.mean[0], 4.0, 0.05, 0.0).unwrap();
        assert!((calm.settling[0].unwrap() - plain).abs() < 1e-6, "{:?} vs {plain}", calm.settling[0]);
        assert!(calm.settling[0].is_some() && !calm.uncertified[0]);
        // A stable surge chooses the surged network's levels, so the bound stays small throughout.
        let mild = run(&model, &Request { horizon: 300.0, intervals: 100, initial: Initial::Steady, surge: Some(Surge { factor: 1.1, from: 10.0, until: 30.0 }), ..Request::default() });
        assert!(mild.shortfall[0].iter().all(|b| b.unwrap() < 1e-5) && mild.settling[0].is_some() && !mild.uncertified[0]);
    }

    /// Certified settling on known intervals (target 1, band 5 %): a tight interval settles when
    /// both ends are inside; an interval wider than the band is never certified, though its
    /// lower end settles; a lower end above the band, or an upper end below it, is not settled
    /// for certain; a missing upper end after `from` cannot be certified, before `from` it is
    /// not looked at.
    #[test]
    fn a_settling_time_is_declared_only_when_the_whole_error_interval_is_inside_the_band() {
        let times: Vec<f64> = (0..=1000).map(|k| k as f64 * 0.01).collect();
        let low: Vec<f64> = times.iter().map(|t| 1.0 - (-t).exp()).collect();
        let plain = settling_time(&times, &low, 1.0, 0.05, 0.0);
        let with = |b: Option<f64>| vec![b; times.len()];
        assert_eq!(certified_settling(&times, &low, &with(Some(1e-9)), 1.0, 0.05, 0.0), (plain, false));
        assert_eq!(certified_settling(&times, &low, &with(Some(0.2)), 1.0, 0.05, 0.0), (None, true), "the band 0.2 is wider than 5 %");
        assert_eq!(certified_settling(&times, &low, &with(None), 1.0, 0.05, 0.0), (None, true));
        assert_eq!(certified_settling(&times[..200], &low[..200], &with(Some(1e-9))[..200], 1.0, 0.05, 0.0), (None, false), "still below the band for certain");
        assert_eq!(certified_settling(&times[..200], &low[..200], &with(Some(0.5))[..200], 1.0, 0.05, 0.0), (None, true), "below, but the truth may be inside");
        let above: Vec<f64> = times.iter().map(|_| 1.2).collect();
        assert_eq!(certified_settling(&times, &above, &with(None), 1.0, 0.05, 0.0), (None, false), "a lower bound above the band");
        let mut early = with(Some(1e-9));
        early[..300].iter_mut().for_each(|b| *b = None);
        assert_eq!(certified_settling(&times, &low, &early, 1.0, 0.05, 4.0), (Some(4.0), false));
        assert_eq!(certified_settling(&times, &low, &early, 1.0, 0.05, 2.0), (None, true));
    }

    /// A surge: the curves are continuous at its ends (the values at the breakpoints are grid
    /// points, and a grid twice as fine gives the same values there and on either side: 1e-7),
    /// the mean rises during it and returns to L afterwards; settling is counted from its end.
    #[test]
    fn a_surge_is_continuous_at_its_ends_and_settles_afterwards() {
        let model = one_station(0.5, 1.0, 1);
        let surge = Surge { factor: 1.8, from: 10.3, until: 21.7 };
        let req = Request { horizon: 120.0, intervals: 60, initial: Initial::Steady, surge: Some(surge), ..Request::default() };
        let out = run(&model, &req);
        let fine = run(&model, &Request { intervals: 120, ..req.clone() });
        let at = |o: &Exact, t: f64| o.mean[0][o.times.iter().position(|x| (x - t).abs() < 1e-9).unwrap()];
        for t in [10.0, 10.3, 12.0, 20.0, 21.7, 22.0, 60.0] {
            assert!((at(&out, t) - at(&fine, t)).abs() < 1e-7, "t={t}: {} vs {}", at(&out, t), at(&fine, t));
        }
        // Continuity: just before and just after each end, on a grid with points 0.01 away.
        let near = run(&model, &Request { horizon: 30.0, intervals: 3000, initial: Initial::Steady, surge: Some(surge), ..Request::default() });
        for b in [10.3, 21.7] {
            let k = near.times.iter().position(|x| (x - b).abs() < 1e-9).unwrap();
            assert!((near.mean[0][k] - near.mean[0][k - 1]).abs() < 0.02 && (near.mean[0][k + 1] - near.mean[0][k]).abs() < 0.02);
        }
        assert!((at(&out, 10.0) - 1.0).abs() < 1e-6, "steady before the surge");
        assert!(at(&out, 21.7) > 2.0, "risen: {}", at(&out, 21.7));
        assert!((out.mean[0].last().unwrap() - 1.0).abs() < 1e-3);
        assert_eq!(out.settle_from, 21.7);
        let s = out.settling[0].unwrap();
        assert!(s > 21.7 && s < 120.0, "settling {s}");
        assert!(*out.missing_mass.last().unwrap() < 1e-6);
    }

    /// A surge beyond capacity (λ doubles to 1.6 > μ = 1 for 40 time units): the levels come
    /// from the fluid peak, and hold the paths (missing mass below 1e-6). During the surge the
    /// mean grows at nearly the fluid rate λ − μ = 0.6 (the queue is seldom empty by then).
    #[test]
    fn an_overloading_surge_is_followed_with_enough_levels() {
        let model = one_station(0.8, 1.0, 1);
        let req = Request { horizon: 100.0, intervals: 100, initial: Initial::Steady, surge: Some(Surge { factor: 2.0, from: 10.0, until: 50.0 }), ..Request::default() };
        let out = run(&model, &req);
        assert!(*out.missing_mass.last().unwrap() < 1e-6, "missing {}", out.missing_mass.last().unwrap());
        let slope = (out.mean[0][50] - out.mean[0][30]) / 20.0;
        assert!((slope - 0.6).abs() < 0.02, "slope {slope}");
    }

    /// Refusals: an overloaded network has no steady state; too many states; too long a horizon.
    // ── Stored rate profiles (ledger SCI-1021…) ─────────────────────────────────────────────

    fn pieces(breaks: &[f64], gamma: &[&[f64]], periodic: bool) -> Option<Profile> {
        Some(Profile { breaks: breaks.to_vec(), gamma: gamma.iter().map(|g| g.to_vec()).collect(), periodic })
    }

    /// A profile that spells out a surge is that surge: the same means, masses and bounds.
    #[test]
    fn a_profile_that_spells_out_a_surge_gives_the_surge() {
        for (model, initial) in [(one_station(0.5, 1.0, 2), Initial::Steady), (tandem(0.4, 1.0, 0.9), Initial::Empty)] {
            let surge = Request { horizon: 40.0, intervals: 40, initial: initial.clone(), surge: Some(Surge { factor: 1.6, from: 5.0, until: 15.0 }), ..Request::default() };
            let up: Vec<f64> = model.gamma.iter().map(|g| g * 1.6).collect();
            let profile = Request { surge: None, profile: pieces(&[5.0, 15.0], &[&model.gamma, &up, &model.gamma], false), ..surge.clone() };
            let (a, b) = (run(&model, &surge), run(&model, &profile));
            assert_eq!(a.times, b.times);
            assert_eq!(a.levels, b.levels, "the same box");
            for i in 0..model.mu.len() {
                for k in 0..a.times.len() {
                    assert!((a.mean[i][k] - b.mean[i][k]).abs() <= 1e-12 * a.mean[i][k].max(1.0), "station {i} at {}", a.times[k]);
                    match (a.shortfall[i][k], b.shortfall[i][k]) {
                        (Some(x), Some(y)) => assert!((x - y).abs() <= 1e-9 * x.max(1e-30), "{x} vs {y}"),
                        (x, y) => panic!("bounds differ: {x:?} vs {y:?}"),
                    }
                }
            }
            assert_eq!((a.settle_from, a.settling.clone()), (b.settle_from, b.settling.clone()));
        }
    }

    /// M_t/M/∞ (Eick, Massey & Whitt 1993): a station with more servers than its box is an
    /// infinite-server station, whose mean from empty is ∫₀ᵗ λ(u)e^{−μ(t−u)}du exactly. Several
    /// breakpoints, rates up, down and to zero. The computed mean is a lower bound within the
    /// stated shortfall; 1e-6 is the tolerance asked of the truncation (ε = 1e-9, levels well
    /// above the Poisson mean).
    #[test]
    fn several_breakpoints_match_the_exact_infinite_server_mean() {
        let (mu, breaks, rates) = (0.5, [3.0, 7.0, 8.0, 14.0], [2.0, 6.0, 0.0, 3.5, 1.0]);
        let model = one_station(rates[0], mu, 80);
        let gamma: Vec<Vec<f64>> = rates.iter().map(|r| vec![*r]).collect();
        let req = Request { horizon: 20.0, intervals: 80, epsilon: 1e-9, profile: Some(Profile { breaks: breaks.to_vec(), gamma, periodic: false }), ..Request::default() };
        let out = run(&model, &req);
        assert!(out.levels[0] < 80, "every customer has a server: {:?}", out.levels);
        assert!(breaks.iter().all(|b| out.times.contains(b)), "the breakpoints are grid points");
        let mut largest = 0.0f64;
        for (k, &t) in out.times.iter().enumerate() {
            let want = infinite_server_mean(&breaks, &rates, mu, t);
            largest = largest.max((out.mean[0][k] - want).abs());
            assert!((out.mean[0][k] - want).abs() < 1e-6, "t = {t}: {} vs {want}", out.mean[0][k]);
            let bound = out.shortfall[0][k].expect("every piece is stable with 80 servers");
            assert!(want - out.mean[0][k] <= bound + 1e-12, "the shortfall bound holds at {t}");
        }
        assert!(largest > 0.0);
        // The formula itself against the differential equation m′ = λ(t) − μm (Runge–Kutta 4).
        let (mut m, mut t, h) = (0.0f64, 0.0f64, 1e-3);
        let lam = |t: f64| rates[breaks.iter().filter(|b| **b <= t).count()];
        while t < 16.0 - 1e-9 {
            let f = |t: f64, m: f64| lam(t) - mu * m;
            let (k1, k2) = (f(t, m), f(t + h / 2.0, m + h / 2.0 * f(t, m)));
            let k3 = f(t + h / 2.0, m + h / 2.0 * k2);
            let k4 = f(t + h, m + h * k3);
            m += h / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
            t += h;
        }
        assert!((m - infinite_server_mean(&breaks, &rates, mu, 16.0)).abs() < 2e-3, "{m}");
    }

    /// Two sources with their own profiles, one periodic, into two stations: `profile_of` puts
    /// each source's multiplier on the stations it feeds, and the exact tier follows both.
    #[test]
    fn each_source_keeps_its_own_profile_and_a_periodic_one_repeats() {
        use crate::model::{Distribution, Link, Node, RateProfile, RateSegment};
        let node = |kind, name: &str, d, params: &str, servers| {
            let mut n = Node::new(name, kind, name, (0.0, 0.0));
            n.distribution = d;
            n.parameters = params.to_string();
            n.servers = servers;
            n
        };
        let link = |from: &str, to: &str, class| Link { id: format!("{from}>{to}"), from: from.into(), to: to.into(), probability: 1.0, class, to_class: None };
        let mut a = node(NodeKind::Source, "Src1", Distribution::Poisson, "lambda=2.0", 1);
        a.rate_profile = Some(RateProfile { periodic: true, segments: vec![RateSegment { until: 2.0, multiplier: 0.5 }, RateSegment { until: 5.0, multiplier: 2.0 }] });
        let mut b = node(NodeKind::Source, "Src2", Distribution::Poisson, "lambda=1.5", 1);
        b.rate_profile = Some(RateProfile { periodic: false, segments: vec![RateSegment { until: 4.0, multiplier: 3.0 }] });
        let net = Network {
            nodes: vec![a, b, node(NodeKind::Buffer, "B1", Distribution::Exponential, "", 1), node(NodeKind::Buffer, "B2", Distribution::Exponential, "", 1), node(NodeKind::Station, "S1", Distribution::Exponential, "rate=1.0", 70), node(NodeKind::Station, "S2", Distribution::Exponential, "rate=0.8", 70), node(NodeKind::Sink, "Out", Distribution::Exponential, "", 1)],
            links: vec![link("Src1", "B1", 0), link("Src2", "B2", 1), link("B1", "S1", 0), link("B2", "S2", 0), link("S1", "Out", 0), link("S2", "Out", 1)],
            infinite_buffers: true,
            canvas_scale: 1.0,
            canvas_pan_offset: (0.0, 0.0),
            population: None,
        };
        let model = fluid_model(&net).unwrap();
        assert_eq!(model.gamma, vec![2.0, 1.5]);
        let p = profile_of(&net, &model, 12.0).unwrap().unwrap();
        assert_eq!(p.breaks, vec![2.0, 4.0, 5.0, 7.0, 10.0]);
        assert_eq!(p.gamma, vec![vec![1.0, 4.5], vec![4.0, 4.5], vec![4.0, 1.5], vec![1.0, 1.5], vec![4.0, 1.5], vec![1.0, 1.5]]);
        assert!(p.periodic);
        let out = run(&model, &Request { horizon: 12.0, intervals: 48, epsilon: 1e-9, profile: Some(p), ..Request::default() });
        for (k, &t) in out.times.iter().enumerate() {
            let s1 = infinite_server_mean(&[2.0, 5.0, 7.0, 10.0], &[1.0, 4.0, 1.0, 4.0, 1.0], 1.0, t);
            let s2 = infinite_server_mean(&[4.0], &[4.5, 1.5], 0.8, t);
            assert!((out.mean[0][k] - s1).abs() < 1e-6 && (out.mean[1][k] - s2).abs() < 1e-6, "t = {t}: {} vs {s1}, {} vs {s2}", out.mean[0][k], out.mean[1][k]);
        }
        assert!(out.settling.iter().all(|s| s.is_none()), "a periodic profile never settles");
        assert_eq!(profile_of(&example("2dtandem"), &model, 10.0).unwrap(), None, "no profile, nothing changes");
    }

    /// The bound stays honest: it is given while every rate so far leaves the dominating network
    /// stable, and withdrawn for good once a piece has overloaded it — also after the rates fall
    /// back. Before the overload it holds against a much larger box.
    #[test]
    fn the_bound_is_dropped_from_the_first_overloading_piece_on() {
        let model = one_station(0.5, 1.0, 1);
        let req = Request { horizon: 40.0, intervals: 40, profile: pieces(&[10.0, 20.0, 25.0], &[&[0.5], &[0.8], &[1.3], &[0.5]], false), ..Request::default() };
        let out = run(&model, &req);
        for (k, &t) in out.times.iter().enumerate() {
            assert_eq!(out.shortfall[0][k].is_some(), t <= 20.0, "t = {t}");
        }
        assert!(out.uncertified[0] || out.settling[0].is_none(), "nothing is certified without a bound");
        // The pieces up to 20: the dominating network is the one at rate 0.8 (after t = 10), and
        // its bound holds against a reference computed on a far larger box.
        let solution = jackson::solve(&model).unwrap();
        let small = exact_with_levels(&model, &solution, &req, &[12], &mut |_| true).unwrap();
        let wide = exact_with_levels(&model, &solution, &req, &[400], &mut |_| true).unwrap();
        for (k, &t) in small.times.iter().enumerate().filter(|(_, t)| **t <= 20.0) {
            let gap = wide.mean[0][k] - small.mean[0][k];
            assert!(gap >= -1e-12 && gap <= small.shortfall[0][k].unwrap() + 1e-12, "t = {t}: gap {gap} vs bound {:?}", small.shortfall[0][k]);
        }
        // A downward-only profile from the steady state keeps the drawn network as the dominating one.
        let down = run(&model, &Request { horizon: 20.0, intervals: 20, initial: Initial::Steady, profile: pieces(&[5.0], &[&[0.1], &[0.5]], false), ..Request::default() });
        assert!(down.shortfall[0].iter().all(|b| b.is_some()));
        assert!(down.mean[0][5] < down.stationary[0] * 0.75, "the queue drains while little arrives");
    }

    /// The pointwise stationary approximation is the frozen network's steady state: right where
    /// the rates have been constant for long, wrong just after a change, and undefined on an
    /// overloading piece.
    #[test]
    fn psa_is_the_frozen_steady_state_and_misses_the_transient() {
        let model = one_station(0.5, 1.0, 1);
        let req = Request { horizon: 300.0, intervals: 300, initial: Initial::Steady, profile: pieces(&[100.0, 200.0, 210.0], &[&[0.5], &[0.8], &[1.2], &[0.5]], false), ..Request::default() };
        let approx = psa(&model, &req);
        let out = run(&model, &req);
        let at = |t: f64| out.times.iter().position(|x| (*x - t).abs() < 1e-9).unwrap();
        assert_eq!(approx[0][at(50.0)], Some(1.0));
        assert!((approx[0][at(100.0)].unwrap() - 4.0).abs() < 1e-12, "it jumps to ρ/(1 − ρ) = 4 the instant the rate changes");
        assert!((out.mean[0][at(100.0)] - 1.0).abs() < 1e-6, "while the true mean has not moved yet");
        assert!((out.mean[0][at(101.0)] - 4.0).abs() > 2.5, "and is still far away a time unit later");
        assert_eq!(approx[0][at(205.0)], None, "no steady state on the overloaded piece");
        assert_eq!(approx[0][at(299.0)], Some(1.0));
        assert!((out.mean[0][at(199.0)] - 4.0).abs() < 0.2, "after a long constant stretch the two agree: {}", out.mean[0][at(199.0)]);
        // For a surge too.
        let surged = psa(&model, &Request { horizon: 10.0, intervals: 10, surge: Some(Surge { factor: 1.6, from: 2.0, until: 4.0 }), ..Request::default() });
        assert_eq!(surged[0].iter().map(|x| x.map(|v| (v * 1e9).round() / 1e9)).collect::<Vec<_>>()[1..5], [Some(1.0), Some(4.0), Some(4.0), Some(1.0)]);
    }

    #[test]
    fn a_profile_that_does_not_fit_is_refused_and_so_is_a_surge_on_top_of_one() {
        let model = one_station(0.5, 1.0, 1);
        let bad = |profile: Option<Profile>, surge| validate(&model, &Request { profile, surge, ..Request::default() }).is_err();
        assert!(bad(pieces(&[2.0], &[&[0.5], &[0.6]], false), Some(Surge { factor: 2.0, from: 1.0, until: 2.0 })));
        assert!(bad(pieces(&[2.0, 2.0], &[&[0.5], &[0.6], &[0.5]], false), None));
        assert!(bad(pieces(&[12.0], &[&[0.5], &[0.6]], false), None), "beyond the horizon");
        assert!(bad(pieces(&[2.0], &[&[0.5]], false), None));
        assert!(bad(pieces(&[2.0], &[&[0.5], &[-0.1]], false), None));
        assert!(!bad(pieces(&[2.0], &[&[0.5], &[0.6]], false), None));
    }

    #[test]
    fn the_exact_tier_refuses_with_a_reason() {
        let r = exact(&one_station(1.2, 1.0, 1), &Request::default(), &mut |_| true).unwrap_err();
        assert!(r.message().contains("overloaded") && r.message().contains("fluid"), "{}", r.message());
        let five = JacksonModel {
            ids: (0..5).map(|i| i.to_string()).collect(),
            names: (0..5).map(|i| format!("S{}", i + 1)).collect(),
            gamma: vec![0.9; 5],
            p: vec![vec![0.0; 5]; 5],
            mu: vec![1.0; 5],
            servers: vec![1; 5],
        };
        let r = exact(&five, &Request::default(), &mut |_| true).unwrap_err();
        assert!(matches!(r, Refusal::TooManyStates { .. }), "{r:?}");
        assert!(r.message().contains("200\u{202F}000"), "{}", r.message());
        let r = exact(&tandem(0.9, 1.0, 1.0), &Request { horizon: 1e7, ..Request::default() }, &mut |_| true).unwrap_err();
        assert!(matches!(r, Refusal::TooMuchWork { .. }), "{r:?}");
        let r = exact(&tandem(0.5, 1.0, 1.0), &Request { horizon: 50.0, ..Request::default() }, &mut |_| false).unwrap_err();
        assert_eq!(r, Refusal::Stopped);
    }

    /// Settling time on a known curve: 1 − e^{−t} comes within 5 % of 1 at t = ln 20 ≈ 2.996;
    /// on a grid of 0.01 linear interpolation finds it to 1e-4. Still outside at the horizon:
    /// none. Inside from the start: the start.
    #[test]
    fn settling_time_is_the_last_entry_into_the_band() {
        let times: Vec<f64> = (0..=1000).map(|k| k as f64 * 0.01).collect();
        let values: Vec<f64> = times.iter().map(|t| 1.0 - (-t).exp()).collect();
        let s = settling_time(&times, &values, 1.0, 0.05, 0.0).unwrap();
        assert!((s - 20f64.ln()).abs() < 1e-4, "{s}");
        assert_eq!(settling_time(&times[..200], &values[..200], 1.0, 0.05, 0.0), None);
        assert_eq!(settling_time(&times, &vec![1.0; 1001], 1.0, 0.05, 0.0), Some(0.0));
        assert_eq!(settling_time(&times, &vec![1.0; 1001], 1.0, 0.05, 4.0), Some(4.0));
        // An overshoot that leaves the band again counts: the last entry, not the first.
        let wobble: Vec<f64> = times.iter().map(|&t| if t < 2.0 { 1.0 } else if t < 3.0 { 1.2 } else { 1.0 }).collect();
        let s = settling_time(&times, &wobble, 1.0, 0.05, 0.0).unwrap();
        assert!(s > 2.99 && s <= 3.0, "{s}");
    }

    /// The relaxation time 1/(√μ − √λ)² (λ = 0.25, μ = 1: 1/(1 − 0.5)² = 4) and the horizon
    /// suggested from it: from empty, every M/M/1 queue tried settles (5 %) inside it.
    #[test]
    fn the_suggested_horizon_covers_settling_from_empty() {
        assert!((relaxation_time(0.25, 1.0) - 4.0).abs() < 1e-12);
        assert!(relaxation_time(1.0, 1.0).is_infinite());
        for rho in [0.3, 0.5, 0.7, 0.8, 0.9, 0.95] {
            let model = one_station(rho, 1.0, 1);
            let h = suggested_horizon(&model, &[rho]);
            let out = run(&model, &Request { horizon: h, intervals: 200, ..Request::default() });
            let s = out.settling[0].unwrap_or_else(|| panic!("ρ = {rho}: not settled within {h}"));
            let tau = relaxation_time(rho, 1.0);
            assert!(s < 0.9 * h, "ρ = {rho}: settles at {s}, horizon {h}");
            assert!(s > 0.2 * tau && s < 2.0 * tau, "ρ = {rho}: settling {s} against τ = {tau}");
        }
    }

    // ── Fluid ──

    /// One overloaded queue (λ = 1.5, μ = 1) from empty: Q(t) = (λ − μ)t exactly. With two
    /// servers at μ = 0.5 the capacity is the same and so is the path.
    #[test]
    fn an_overloaded_fluid_queue_grows_linearly() {
        for model in [one_station(1.5, 1.0, 1), one_station(1.5, 0.5, 2)] {
            let f = fluid(&model, &Request { horizon: 40.0, intervals: 80, ..Request::default() });
            for (k, &t) in f.times.iter().enumerate() {
                assert!((f.level[0][k] - 0.5 * t).abs() < 1e-12, "t={t}");
            }
            assert!(f.emptied.is_empty());
        }
    }

    /// One stable queue started with Q₀ = 12 (λ = 0.4, μ = 1): Q(t) = Q₀ − (μ − λ)t until it
    /// empties at exactly Q₀/(μ − λ) = 20, then stays at zero.
    #[test]
    fn a_stable_fluid_queue_drains_in_the_closed_form_time() {
        let f = fluid(&one_station(0.4, 1.0, 1), &Request { horizon: 30.0, intervals: 7, initial: Initial::Given(vec![12]), ..Request::default() });
        assert_eq!(f.emptied.len(), 1);
        assert!((f.emptied[0].1 - 20.0).abs() < 1e-12, "{}", f.emptied[0].1);
        for (k, &t) in f.times.iter().enumerate() {
            assert!((f.level[0][k] - (12.0 - 0.6 * t).max(0.0)).abs() < 1e-12, "t={t}: {}", f.level[0][k]);
        }
    }

    /// A fluid tandem (λ = 0.5, μ₁ = 2, μ₂ = 1) with 6 at the first station: while it drains
    /// (until t = 6/1.5 = 4) the second is fed at μ₁ = 2 and fills at 2 − 1 = 1, reaching 4;
    /// then it is fed at λ = 0.5 and drains at 0.5, empty at t = 4 + 8 = 12 (Chen & Mandelbaum
    /// 1991: the departure rate of an empty station is its inflow).
    #[test]
    fn a_fluid_tandem_passes_its_backlog_downstream() {
        let f = fluid(&tandem(0.5, 2.0, 1.0), &Request { horizon: 16.0, intervals: 16, initial: Initial::Given(vec![6, 0]), ..Request::default() });
        let at = |i: usize, t: usize| f.level[i][t];
        assert!((at(0, 2) - 3.0).abs() < 1e-12 && (at(1, 2) - 2.0).abs() < 1e-12);
        assert!(at(0, 4).abs() < 1e-12 && (at(1, 4) - 4.0).abs() < 1e-12);
        assert!((at(1, 8) - 2.0).abs() < 1e-12);
        assert!(at(1, 12).abs() < 1e-12 && at(1, 16) == 0.0);
        assert_eq!(f.emptied.len(), 2);
        assert!((f.emptied[0].1 - 4.0).abs() < 1e-12 && (f.emptied[1].1 - 12.0).abs() < 1e-12);
    }

    /// A fluid surge on one queue (λ = 0.8 → 1.6 on [10, 50], μ = 1): zero until 10, up at 0.6
    /// to 24 at t = 50, down at 0.2, empty at 50 + 24/0.2 = 170. Continuous at both ends by
    /// construction; the ends are grid points even when the grid would miss them.
    #[test]
    fn a_fluid_surge_rises_and_drains_in_closed_form() {
        let req = Request { horizon: 200.0, intervals: 7, surge: Some(Surge { factor: 2.0, from: 10.0, until: 50.0 }), ..Request::default() };
        let f = fluid(&one_station(0.8, 1.0, 1), &req);
        assert!(f.times.contains(&10.0) && f.times.contains(&50.0));
        for (k, &t) in f.times.iter().enumerate() {
            let want = if t <= 10.0 { 0.0 } else if t <= 50.0 { 0.6 * (t - 10.0) } else { (24.0 - 0.2 * (t - 50.0)).max(0.0) };
            assert!((f.level[0][k] - want).abs() < 1e-9, "t={t}: {} vs {want}", f.level[0][k]);
        }
        assert!((f.emptied[0].1 - 170.0).abs() < 1e-9);
    }

    /// With feedback the empty stations' rates solve the traffic equations: in a stable network
    /// from empty nothing accumulates (rates = α), and an overloaded one grows at α − κ where
    /// the traffic equations put the overload (S1 of the p30 example with λ scaled by 1.6:
    /// α₁ = 1.6/0.7, κ₁ = 1/0.7·… read off the model).
    #[test]
    fn fluid_rates_with_feedback_follow_the_traffic_equations() {
        let model = jackson::from_network(&example("OpenJackson.d2.feedback.p30.inf")).unwrap();
        let f = fluid(&model, &Request { horizon: 50.0, intervals: 10, ..Request::default() });
        assert!(f.level.iter().all(|row| row.iter().all(|&q| q == 0.0)));
        // Overload both: station 0 (fed by the source and its own feedback) holds fluid, works
        // at κ₀ and grows at γ₀·1.6 + p₀₀κ₀ − κ₀… with feedback through itself only when p₀₀ > 0;
        // in general the slope is γ·f + Pᵀ·D − D with D = κ at holding stations.
        let cap: Vec<f64> = (0..2).map(|i| model.servers[i] as f64 * model.mu[i]).collect();
        let g: Vec<f64> = model.gamma.iter().map(|x| x * 1.6).collect();
        let surged = JacksonModel { gamma: g.clone(), ..model.clone() };
        let f = fluid(&surged, &Request { horizon: 10.0, intervals: 10, ..Request::default() });
        let slope0 = g[0] + model.p[0][0] * cap[0] + model.p[1][0] * cap[1].min(g[1] + model.p[0][1] * cap[0]) - cap[0];
        assert!(slope0 > 0.0);
        assert!((f.level[0][10] - 10.0 * slope0).abs() < 1e-9, "{} vs {}", f.level[0][10], 10.0 * slope0);
    }

    // ── Drawn networks ──

    /// Which tiers apply: a Jackson example has both; finite buffers neither, with the reason;
    /// a multi-class re-entrant line with unequal rates has no fluid model here; a general
    /// single-class network has the fluid tier only.
    #[test]
    fn applicability_says_which_tiers_apply_and_why_not() {
        let a = applicability(&example("OpenJackson.d2.feedback.p30.inf"));
        assert!(a.exact.is_ok() && a.fluid.is_ok());
        let a = applicability(&example("MM1K.d1.c1.fin"));
        assert_eq!(a.exact.unwrap_err(), FINITE_SENTENCE);
        assert_eq!(a.fluid.unwrap_err(), FINITE_SENTENCE);
        let mut closed = example("OpenJackson.d2.feedback.p30.inf");
        closed.nodes.retain(|n| n.kind != NodeKind::Source);
        assert_eq!(applicability(&closed).exact.unwrap_err(), CLOSED_SENTENCE);
        // Drawn closed (no source and no sink): the closed sentence, by the one rule; with the
        // population taken away, the sentence that says none is set.
        let ring = crate::bnet::read(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../examples/closed/ClosedCentralServer.d3.N8.bnet")).unwrap()).unwrap();
        assert_eq!(applicability(&ring).fluid.unwrap_err(), "This is a closed network: a fixed number of customers circulates and nothing arrives from outside. Transient analysis covers open networks.");
        let mut bare = ring.clone();
        bare.population = None;
        assert!(applicability(&bare).exact.unwrap_err().starts_with("The network has no source and no sink, but no number of customers is set."));
        let mut general = example("OpenJackson.d2.feedback.p30.inf");
        for n in general.nodes.iter_mut().filter(|n| n.kind == NodeKind::Station) {
            n.distribution = crate::model::Distribution::Erlang;
            n.parameters = "k=2,rate=4.0".into();
        }
        let a = applicability(&general);
        assert!(a.exact.unwrap_err().contains("Markov chain"));
        let m = a.fluid.unwrap();
        assert_eq!(m.mu, vec![2.0, 2.0]);
    }
}
