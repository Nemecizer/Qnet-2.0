//! Network › Analyze Network and Network › Show Network Primitives, as text (0.90.34
//! `QnetGUIApp.formatNetworkAnalysis`, `formatNetworkPrimitives`, `networkWarnings` and
//! `validateLinkStructure`).
//!
//! Analyze checks every primitive against the assumptions of heavy-traffic SRBM theory and, for
//! each issue, says why it hurts accuracy, what to change, and which measures to distrust, then
//! scores the network. Primitives prints the station model itself (arrival rates, throughputs,
//! service rates, routing, reflection, covariance) with the warnings the canvas shows. Both are
//! reproduced line for line (tests/golden_reports.rs compares all 50 examples with 0.90.34).
//!
//! The ledger's Changed row ANA-180 applies here: the μ_i legend line names the harmonic mean the
//! code computes, where 0.90.34 called it an arithmetic mean (owner's D5 decision, 2026-11-10).

use crate::cfmt::f;
use crate::existence::{self, Outcome};
use crate::model::{Link, Node, NodeKind};
use crate::traffic::SrbmData;

/// Swift's `min` and `max` on Doubles: `y < x ? y : x` and `y >= x ? y : x`.
fn smin(x: f64, y: f64) -> f64 {
    if y < x {
        y
    } else {
        x
    }
}

fn smax(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

/// ρ_i with 0 for a station without capacity (the reports' convention; `--dump-rho` prints NaN).
fn rhos(data: &SrbmData) -> Vec<f64> {
    (0..data.d).map(|i| if data.capacity[i] > 1e-12 { data.alpha[i] / data.capacity[i] } else { 0.0 }).collect()
}

/// The largest and smallest of the loads strictly between 0 and 1, if any.
fn active_range(rho: &[f64]) -> Option<(f64, f64)> {
    let active: Vec<f64> = rho.iter().copied().filter(|r| *r > 1e-9 && *r < 1.0).collect();
    let first = *active.first()?;
    Some(active.iter().fold((first, first), |(lo, hi), r| (if *r < lo { *r } else { lo }, if *r > hi { *r } else { hi })))
}

/// The heavy-traffic validity warnings shown on the canvas and at the end of Primitives
/// (`networkWarnings`).
pub fn network_warnings(data: &SrbmData, infinite: bool) -> Vec<String> {
    let rho = rhos(data);
    let mut w = Vec::new();
    for (i, r) in rho.iter().enumerate() {
        if *r >= 1.0 {
            w.push(format!("station {} is overloaded (ρ = {} ≥ 1). The network is unstable in the infinite-buffer sense; the Brownian heavy-traffic approximation does not apply and analytical rho_i, Gamma_i values will be unreliable.", i + 1, f("%.4f", *r)));
        } else if *r >= 0.95 {
            // Near saturation is where heavy-traffic theory is best: no warning.
        } else if *r < 0.5 && *r > 1e-9 {
            w.push(format!("station {} has low utilization (ρ = {}). The SRBM heavy-traffic approximation is most accurate when ρ is close to 1; results here may diverge from simulation.", i + 1, f("%.4f", *r)));
        } else if *r <= 1e-9 {
            w.push(format!("station {} has no offered traffic (ρ ≈ 0); check that sources route to it.", i + 1));
        }
    }
    if let Some((lo, hi)) = active_range(&rho) {
        if hi - lo > 0.30 {
            w.push(format!("traffic intensities are unbalanced (ρ ranges from {} to {}). Balanced heavy-traffic theory assumes all stations near ρ = 1 simultaneously; single-bottleneck behavior may dominate.", f("%.3f", lo), f("%.3f", hi)));
        }
    }
    let mut sigma_min = f64::INFINITY;
    for i in 0..data.d {
        sigma_min = smin(sigma_min, data.gamma[i][i]);
    }
    if sigma_min < 1e-6 {
        w.push("Σ has a near-zero diagonal entry. SRBM requires genuine stochasticity on every coordinate; a deterministic station will make the diffusion degenerate.".into());
    }
    if let Some(v) = existence::srbm_existence(data, infinite) {
        match v.existence.outcome {
            Outcome::Fails => w.push(format!("{} Every SRBM result for this network is meaningless.", v.headline())),
            Outcome::Undecided => w.push(v.headline()),
            Outcome::Holds => {
                if v.recurrence.as_ref().is_some_and(|r| r.outcome != Outcome::Holds) && !rho.iter().any(|r| *r >= 1.0) {
                    w.push(v.headline());
                }
            }
        }
    }
    if !infinite {
        for i in 0..data.d {
            if data.a_vec[i] < 2.0 {
                w.push(format!("station {} has a very small buffer (a = {}). The SRBM is a continuous hypercube limit; with a ≤ 1 the approximation can be coarse.", i + 1, f("%g", data.a_vec[i])));
            }
        }
    }
    w
}

/// Links that break Qnet's connection rules (`validateLinkStructure`): sources feed buffers only, a
/// sink is terminal, and sinks take links from stations (infinite buffers) or stations and buffers
/// (finite buffers, for overflow).
pub fn validate_link_structure(nodes: &[Node], links: &[Link], infinite: bool) -> Vec<String> {
    // 0.90.34 kept the last node of a repeated id ([UUID: NetworkNode] assignment).
    let by_id = |id: &str| nodes.iter().rev().find(|n| n.id == id);
    let mut out = Vec::new();
    for link in links {
        let (Some(from), Some(to)) = (by_id(&link.from), by_id(&link.to)) else { continue };
        if from.kind == NodeKind::Source && to.kind != NodeKind::Buffer {
            out.push(format!("link from source '{}' goes to '{}' (kind={}); sources must route to a buffer.", from.name, to.name, to.kind.raw()));
        }
        if from.kind == NodeKind::Sink {
            out.push(format!("link out of sink '{}' goes to '{}' (kind={}); a sink is terminal, and every exporter ignores this link. Delete it, or route from the station that feeds the sink instead.", from.name, to.name, to.kind.raw()));
        }
        if to.kind == NodeKind::Sink {
            if infinite {
                if from.kind != NodeKind::Station {
                    out.push(format!("link into sink '{}' comes from '{}' (kind={}); infinite-buffer networks only allow station → sink.", to.name, from.name, from.kind.raw()));
                }
            } else if from.kind != NodeKind::Station && from.kind != NodeKind::Buffer {
                out.push(format!("link into sink '{}' comes from '{}' (kind={}); finite-buffer networks only allow station → sink or buffer → sink (overflow).", to.name, from.name, from.kind.raw()));
            }
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Severity {
    Critical = 0,
    Warning = 1,
    Info = 2,
}

struct Finding {
    severity: Severity,
    title: String,
    why: String,
    fix: String,
    affects: Vec<String>,
}

fn finding(severity: Severity, title: impl Into<String>, why: impl Into<String>, fix: impl Into<String>, affects: &[&str]) -> Finding {
    Finding { severity, title: title.into(), why: why.into(), fix: fix.into(), affects: affects.iter().map(|s| s.to_string()).collect() }
}

/// Pads by characters, as Swift's `String.count` counts them.
fn pad_r(s: &str, w: usize) -> String {
    let n = s.chars().count();
    if n >= w {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(w - n))
    }
}

fn pad_l(s: &str, w: usize) -> String {
    let n = s.chars().count();
    if n >= w {
        s.to_string()
    } else {
        format!("{}{s}", " ".repeat(w - n))
    }
}

/// Network › Analyze Network (`formatNetworkAnalysis`). `nodes` and `links` are the drawn network,
/// for the link-structure rules.
pub fn analysis(data: &SrbmData, nodes: &[Node], links: &[Link], infinite: bool) -> String {
    use Severity::*;
    let d = data.d;
    let k_classes = data.k;
    let rho = rhos(data);
    let mut fs: Vec<Finding> = Vec::new();

    for i in 0..d {
        let n = i + 1;
        let r = rho[i];
        if r >= 1.0 {
            fs.push(finding(Critical, format!("Station {n} is unstable (ρ = {} ≥ 1)", f("%.3f", r)),
                "Heavy-traffic SRBM requires every station to be stable (ρ < 1). An overloaded station has an infinite queue in the fluid limit; the diffusion approximation is undefined and E[X] values returned by the solver are meaningless.",
                format!("Reduce the effective arrival rate to station {n} (lower λ or reroute traffic) or increase capacity by adding servers / raising the service rate μ (currently {}). Target ρ < 1 with comfortable margin, ideally 0.85–0.99.", f("%.4f", data.service_rates[i])),
                &[&format!("E[X_{n}]"), &format!("sojourn_{n}"), "E[X] for every station (unstable network)"]));
        } else if r >= 0.995 {
            fs.push(finding(Warning, format!("Station {n} is near-critical (ρ = {})", f("%.3f", r)),
                "At ρ ≳ 0.995 the queue has long correlation time; finite-buffer truncation and Σ-scaling sensitivity both amplify, so E[X] can be very sensitive to mesh size and buffer choice.",
                format!("If physically accurate, keep this — SRBM is most accurate near ρ = 1. But run two mesh sizes to confirm E[X_{n}] has converged. On finite-buffer networks, increase buffer a_{n} well beyond E[X_{n}]."),
                &[&format!("E[X_{n}] (numerical stability)")]));
        } else if r < 0.5 && r > 1e-9 {
            fs.push(finding(Warning, format!("Station {n} is lightly loaded (ρ = {}, below heavy-traffic regime)", f("%.3f", r)),
                "SRBM is the heavy-traffic limit where ρ → 1. At low ρ the stationary distribution has a large atom at zero that the diffusion smooths out; the approximation systematically underestimates P(X=0) and overestimates mean queue length. Error ranges roughly 20–50% below ρ = 0.5.",
                format!("Raise α_{n} (route more traffic through station {n}) or reduce μ_{n} (currently {}) so that ρ_{n} is closer to 1. If the true load is this low, prefer an M/G/1 or M/G/s closed-form — SRBM is not the right model.", f("%.4f", data.service_rates[i])),
                &[&format!("E[X_{n}]"), &format!("sojourn_{n}"), "class waiting times"]));
        } else if r <= 1e-9 {
            fs.push(finding(Warning, format!("Station {n} has no offered traffic (ρ ≈ 0)"),
                "No class routes through this station, so α = 0. SRBM produces degenerate output; the station is effectively disconnected.",
                format!("Check your routing links — either some source should feed station {n} or this station should be removed."),
                &[&format!("station {n} metrics (undefined)")]));
        } else if r < 0.7 {
            fs.push(finding(Info, format!("Station {n} is moderately loaded (ρ = {})", f("%.3f", r)),
                "Below ρ ≈ 0.7 the heavy-traffic approximation starts to noticeably overestimate queue length. Expect 10–20% error vs simulation.",
                "If possible, run a Monte Carlo comparison; or raise ρ toward 0.85 to sit comfortably in the heavy-traffic regime.",
                &[&format!("E[X_{n}]")]));
        }
    }

    let active: Vec<f64> = rho.iter().copied().filter(|r| *r > 1e-9 && *r < 1.0).collect();
    if let Some((lo, hi)) = active_range(&rho) {
        if hi - lo > 0.30 {
            let affects: &[&str] = if active.len() > 1 { &["E[X_i] for non-bottleneck stations"] } else { &[] };
            fs.push(finding(Warning, format!("Utilizations are unbalanced (ρ range {} – {}, spread {})", f("%.3f", lo), f("%.3f", hi), f("%.2f", hi - lo)),
                "Balanced heavy-traffic theory (Harrison–Reiman) assumes every station simultaneously approaches ρ → 1. When one station dominates, the multi-dimensional SRBM degenerates toward the one-dimensional M/G/1 of the bottleneck, and non-bottleneck E[X_i] values are biased low.",
                "Balance capacities: either add servers / raise μ at the bottleneck, or combine stations whose load patterns resemble each other. Alternatively, accept that only the bottleneck's E[X] will be close to simulation.",
                affects));
        }
    }

    for i in 0..d {
        let n = i + 1;
        let scv = data.effective_service_scvs[i];
        if scv > 4.0 {
            fs.push(finding(Warning, format!("Station {n} has a highly variable service time (c²_s = {})", f("%.2f", scv)),
                "SRBM is a two-moment approximation: it only sees mean and variance of service time. With c²_s > 4 (e.g. hyperexponential / long-tail), higher moments dominate the queue dynamics and the two-moment fit systematically UNDERESTIMATES E[X] (often by 30% or more).",
                format!("If the true service distribution is long-tailed, consider simulation or a matrix-exponential method. If the SCV = {} is the result of mixing several class service times, splitting those into separate stations would reduce the aggregated SCV.", f("%.2f", scv)),
                &[&format!("E[X_{n}]"), &format!("sojourn_{n}")]));
        } else if scv <= 1e-9 {
            if data.gamma[i][i] < 1e-6 {
                fs.push(finding(Critical, format!("Station {n} has zero covariance (c²_s = 0 and no arrival variance)"),
                    "SRBM requires a non-degenerate covariance Σ. Combined zero service and arrival variance make Σ_ii = 0, which degenerates the diffusion PDE and produces unreliable or singular results.",
                    format!("Change station {n}'s service distribution away from Constant — use Erlang, Gamma, or Exponential with the same mean. Alternatively, add variability to the upstream arrival stream. Even a small c²_s (say 0.1) restores well-posedness."),
                    &[&format!("E[X_{n}]"), "entire solve (PDE singular)"]));
            } else {
                fs.push(finding(Info, format!("Station {n} has deterministic service (c²_s = 0) — M/D/1-like"),
                    "Station is well-posed (Σ_ii is kept positive by arrival variability), but the two-moment SRBM slightly overestimates queue length relative to the Pollaczek–Khinchine exact answer for M/D/1.",
                    format!("If you need high accuracy for deterministic-service stations, cross-check E[X_{n}] against the M/D/1 formula ρ²/(2(1−ρ)). {MD1_TAIL}"),
                    &[&format!("E[X_{n}]")]));
            }
        } else if scv < 0.1 {
            fs.push(finding(Warning, format!("Station {n} has near-deterministic service (c²_s = {})", f("%.3f", scv)),
                "With very low service-time variance, the two-moment SRBM OVERESTIMATES queue length compared to simulation. The true distribution has negligible tail; the diffusion's Gaussian smoothing adds spurious variance.",
                "If service really is deterministic, use a D/G/1 or simulation. Otherwise, increase the service-distribution variance (e.g. replace a Constant with an Erlang or Gamma) so c²_s ≳ 0.2.",
                &[&format!("E[X_{n}]"), &format!("sojourn_{n}")]));
        }
    }

    for c in (0..k_classes).filter(|c| *c < data.arrival_scvs.len()) {
        let n = c + 1;
        let scv = data.arrival_scvs[c];
        if !(data.class_external_arrivals[c] > 1e-12) {
            continue;
        }
        if scv > 4.0 {
            fs.push(finding(Warning, format!("Class {n} has a highly variable (bursty) arrival process (c²_a = {})", f("%.2f", scv)),
                "High arrival SCV drives station-1 covariance up linearly: Σ_11 ≈ λ·(c²_a + c²_s). With c²_a > 4 the Whitt superposition formulas used downstream break down — departure-SCV propagation becomes unreliable and E[X] at downstream stations is biased low.",
                format!("Replace class-{n}'s arrival distribution with one closer to exponential (c²_a = 1), or decompose the bursty source into several Poisson sources with different rates."),
                &[&format!("E[X_i] at every station visited by class {n}")]));
        } else if scv < 0.1 && scv > 1e-9 {
            fs.push(finding(Info, format!("Class {n} has near-periodic arrivals (c²_a = {})", f("%.3f", scv)),
                "Deterministic-like arrivals reduce Σ_ii at the entry station. The SRBM diffusion still applies but the two-moment fit slightly overestimates queue variability.",
                "Usually fine to leave as-is; SCV near 0 matters less than SCV near ∞.",
                &[]));
        }
    }

    for i in 0..d {
        if data.servers[i] > 1 {
            fs.push(finding(Info, format!("Station {} is multi-server (s = {})", i + 1, data.servers[i]),
                "SRBM is strictly correct for single-server FIFO queues; for multi-server stations BNET uses the G/G/s heavy-traffic heuristic (capacity = s·μ). This is accurate to within ~5–10% when ρ is near 1 but degrades at moderate ρ.",
                "If exact multi-server accuracy matters, compare against M/M/s closed form or simulation. Otherwise, the heuristic is usually adequate.",
                &[&format!("E[X_{}]", i + 1)]));
        }
    }

    if !infinite {
        for i in 0..d {
            let n = i + 1;
            if data.a_vec[i] < 2.0 {
                fs.push(finding(Warning, format!("Station {n} buffer is very small (a = {})", f("%g", data.a_vec[i])),
                    "The FEM mesh needs several cells to resolve the density; with a ≤ 1 the hypercube domain is too thin to represent the boundary-layer structure near x = 0.",
                    format!("Increase buffer size at station {n} to at least 4–5 units; re-check E[X] at that buffer and one larger to confirm insensitivity."),
                    &[&format!("E[X_{n}]")]));
            } else if data.a_vec[i] < 10.0 {
                fs.push(finding(Info, format!("Station {n} buffer is modest (a = {})", f("%g", data.a_vec[i])),
                    "Small buffers mean blocking effects dominate; the SRBM answer is still meaningful but the loss / blocking probability will not match classical Jackson intuition.",
                    "If you want the infinite-buffer Harrison-Reiman answer, toggle 'Infinite Buffers' instead. If you want manufacturing blocking, this is correct as-is.",
                    &[]));
            }
        }
    }

    let mut two_cycle = false;
    let mut max_self = 0.0;
    for i in 0..d {
        max_self = smax(max_self, data.aggregated_p[i][i]);
        for j in (0..d).filter(|j| *j != i) {
            if data.aggregated_p[i][j] > 1e-9 && data.aggregated_p[j][i] > 1e-9 {
                two_cycle = true;
            }
        }
    }
    if max_self > 1e-6 {
        fs.push(finding(Info, format!("Routing has self-loops (max P[i][i] = {})", f("%.3f", max_self)),
            "A customer can re-enter the same station. The arrival stream to that station is no longer the renewal superposition Whitt's formula assumes, so the computed arrival SCV (and therefore Σ) is an approximation.",
            "If the self-loop is physically meaningful, the approximation is usually fine at moderate probabilities (P < 0.3). For P close to 1 (e.g. heavy rework), consider modeling the loop as a separate station.",
            &["E[X] at looped stations"]));
    }
    if two_cycle {
        fs.push(finding(Info, "Routing has feedback cycles (i ↔ j)",
            "Departure processes from station j feed back into station i whose departures in turn feed j. The Whitt superposition/departure approximations iterate to a fixed point; the fixed-point SCV is correct only in heavy traffic and converges slowly.",
            "Raise all ρ in the cycle toward 1 to tighten the heavy-traffic limit. For lightly-loaded feedback networks, simulation is more reliable.",
            &["E[X_i] for stations in the cycle"]));
    }

    for msg in validate_link_structure(nodes, links, infinite) {
        // Swift's prefix(80) and count are in Characters; for these messages that is chars.
        let short: String = msg.chars().take(80).collect();
        let more = if msg.chars().count() > 80 { "…" } else { "" };
        fs.push(finding(Critical, format!("Illegal link: {short}{more}"),
            "Qnet's SRBM pipeline assumes sources feed buffers (so arrival variance flows through the queue) and sinks receive only stations (infinite-buffer networks) or stations plus overflowing buffers (finite-buffer networks). Links that violate these rules corrupt the exported (Γ, R, α) primitives.",
            "Delete the offending link and reconnect it via the correct node kinds. On finite-buffer networks you may add a direct buffer → sink link to represent overflow loss.",
            &["every metric (input network ill-formed)"]));
    }

    if let Some(v) = existence::srbm_existence(data, infinite) {
        let escape_fix = "Ensure every station has some escape route to the sink. If the offending stations route only to each other, add a sink probability (e.g. reduce forward / feedback probabilities so their sum < 1).";
        match v.existence.outcome {
            Outcome::Fails => fs.push(finding(Critical, "SRBM undefined: reflection matrix R is not completely-S",
                format!("An SRBM on the orthant exists, and is unique in law, only when R is completely-S (Reiman–Williams 1988; Taylor–Williams 1993). For a generalized Jackson network this means every station has a positive-probability path to the sink. Specifically, {}", v.existence.statement),
                escape_fix, &["every metric (SRBM is undefined)"])),
            Outcome::Undecided => fs.push(finding(Critical, "SRBM existence not established",
                format!("No theorem-backed test could confirm that an SRBM with this network's reflection directions exists: {}", v.existence.statement),
                escape_fix, &["every metric (SRBM may be undefined)"])),
            Outcome::Holds => {
                if let Some(r) = v.recurrence.as_ref().filter(|r| r.outcome != Outcome::Holds) {
                    if !rho.iter().any(|x| *x >= 1.0) {
                        fs.push(finding(Critical,
                            if r.outcome == Outcome::Fails { "SRBM not positive recurrent" } else { "SRBM positive recurrence undecided" },
                            format!("The SRBM exists but a stationary distribution requires positive recurrence: {}", r.statement),
                            "Lower the load on the stations named, or check the routing; every steady-state SRBM method needs a positive recurrent SRBM.",
                            &["every metric (no stationary distribution)"]));
                    }
                }
            }
        }
    }

    let mut sigma_min = f64::INFINITY;
    let mut min_idx = 0;
    for i in 0..d {
        if data.gamma[i][i] < sigma_min {
            sigma_min = data.gamma[i][i];
            min_idx = i;
        }
    }
    if sigma_min < 1e-6 {
        fs.push(finding(Critical, format!("Covariance matrix Σ is near-singular (min diag {} at station {})", f("%.2e", sigma_min), min_idx + 1),
            "SRBM is a non-degenerate diffusion — every coordinate must have positive variance. A zero on the diagonal means the PDE loses ellipticity and the solve is ill-posed.",
            format!("Add variability to station {}'s arrival or service distribution (anything non-Constant). Also check that at least one upstream source is non-deterministic.", min_idx + 1),
            &["all metrics (PDE undefined)"]));
    }

    if k_classes > 1 {
        for i in 0..d {
            let (mut min_rate, mut max_rate, mut visiting) = (f64::INFINITY, 0.0, 0);
            for k in 0..k_classes {
                let rate = data.class_service_rates[k][i];
                if data.alpha_per_class[k][i] > 1e-9 && rate > 1e-12 {
                    min_rate = smin(min_rate, rate);
                    max_rate = smax(max_rate, rate);
                    visiting += 1;
                }
            }
            if visiting >= 2 && max_rate > 0.0 && min_rate.is_finite() && max_rate / min_rate > 5.0 {
                fs.push(finding(Warning, format!("Station {} services classes with very different speeds (ratio {}x)", i + 1, f("%.1f", max_rate / min_rate)),
                    "Compound service-time aggregation (the new research flavor) computes E[S] and E[S²] from a mixture, but the stationary distribution of a multi-class FIFO queue is not fully characterized by two moments when class service times differ by more than ~5x. Expect 10–30% error on E[X] and per-class W.",
                    "If possible, dedicate separate stations to the fast and slow classes. Or use priority queueing with a different analytical model.",
                    &[&format!("E[X_{}]", i + 1), &format!("per-class waiting times at station {}", i + 1)]));
            }
        }
    }

    for i in (0..d).filter(|i| rho[*i] > 1e-9 && rho[*i] < 1.0 && data.gamma[*i][*i] > 1e-12) {
        let eta = 2.0 * (data.capacity[i] - data.alpha[i]) / data.gamma[i][i];
        if eta > 5.0 {
            fs.push(finding(Info, format!("Station {} has a sharply-peaked stationary density (η = {})", i + 1, f("%.2f", eta)),
                "The marginal SRBM decay rate 2|θ|/Σ is large, meaning the queue is rarely non-empty — the continuous diffusion is fitting what is essentially a point mass at zero. Numerically this is easy to solve but produces small E[X].",
                "Usually fine to leave as-is; but if you expected more queueing, raise ρ (increase λ or reduce μ).",
                &[]));
        }
    }

    // ── The report ──
    let count = |s: Severity| fs.iter().filter(|x| x.severity == s).count() as i64;
    let (crit, warn, info) = (count(Critical), count(Warning), count(Info));
    let score = 0i64.max(100i64.min(100 - 35 * crit - 15 * warn - 3 * info));
    let label = if crit > 0 {
        "UNRELIABLE"
    } else if score >= 85 {
        "HIGH"
    } else if score >= 65 {
        "MODERATE"
    } else if score >= 40 {
        "LOW"
    } else {
        "UNRELIABLE"
    };
    let tag = |s: Severity| match s {
        Critical => "[CRITICAL]",
        Warning => "[WARNING ]",
        Info => "[INFO    ]",
    };

    let mut out = String::new();
    out += "NETWORK ANALYSIS — Brownian Heavy-Traffic Reliability\n";
    out += "=====================================================\n\n";
    out += "NETWORK SUMMARY\n";
    out += "---------------\n";
    out += &format!("Stations:         {d}\n");
    out += &format!("Customer classes: {k_classes}\n");
    out += &format!("Buffer model:     {}\n\n", if infinite { "infinite" } else { "finite" });

    out += "KEY PRIMITIVES\n";
    out += "--------------\n";
    out += &format!("  {}  {}  {}  {}  {}  {}  {}\n", pad_r("Station", 8), pad_l("servers", 7), pad_l("μ_eff", 7), pad_l("α", 7), pad_l("ρ", 9), pad_l("c²_s_eff", 9), pad_l("buffer", 7));
    for i in 0..d {
        let buf = if infinite { "∞".to_string() } else { f("%g", data.a_vec[i]) };
        out += &format!(
            "  {}  {}  {}  {}  {}  {}  {}\n",
            pad_r(&format!("S{}", i + 1), 8),
            pad_l(&data.servers[i].to_string(), 7),
            pad_l(&f("%.4f", data.service_rates[i]), 7),
            pad_l(&f("%.4f", data.alpha[i]), 7),
            pad_l(&f("%.4f", rho[i]), 9),
            pad_l(&f("%.4f", data.effective_service_scvs[i]), 9),
            pad_l(&buf, 7)
        );
    }
    out += "\n";
    out += &format!("  {}  {}  {}\n", pad_r("Class", 8), pad_l("λ (ext)", 9), pad_l("c²_a", 7));
    for c in 0..k_classes {
        let scv = data.arrival_scvs.get(c).copied().unwrap_or(0.0);
        out += &format!("  {}  {}  {}\n", pad_r(&format!("C{}", c + 1), 8), pad_l(&f("%.4f", data.class_external_arrivals[c]), 9), pad_l(&f("%.4f", scv), 7));
    }
    out += "\n";

    out += "OVERALL RELIABILITY ASSESSMENT\n";
    out += "------------------------------\n";
    out += &format!("Score: {score} / 100  ({label})\n");
    out += &format!("Findings: {crit} critical, {warn} warning, {info} info\n\n");
    out += match label {
        "HIGH" => "The network sits comfortably inside the assumptions of heavy-traffic SRBM theory. E[X] estimates should be within ~5–10% of simulation for most primitives.\n\n",
        "MODERATE" => "Some primitives sit near the edge of the heavy-traffic regime. E[X] estimates are probably directionally correct but may have 10–30% error. See the findings below for specifics.\n\n",
        "LOW" => "Several primitives violate the assumptions used by SRBM. Treat absolute E[X] values with caution — use them for relative comparisons only, and verify against simulation.\n\n",
        _ if crit > 0 => "At least one critical issue makes the SRBM approximation inapplicable. Resolve the critical findings before trusting any output.\n\n",
        _ => "The aggregated reliability score is very low. Expect absolute E[X] errors exceeding 30%.\n\n",
    };

    // Swift's sort is stable for these, as Rust's is.
    let mut ordered: Vec<&Finding> = fs.iter().collect();
    ordered.sort_by_key(|x| x.severity);
    if fs.is_empty() {
        out += "FINDINGS\n--------\nNo issues detected — all checks passed.\n\n";
    } else {
        out += "FINDINGS (grouped by severity)\n";
        out += "------------------------------\n\n";
        for (idx, x) in ordered.iter().enumerate() {
            out += &format!("{} {}. {}\n", tag(x.severity), idx + 1, x.title);
            out += &format!("  Why:     {}\n", x.why);
            out += &format!("  Fix:     {}\n", x.fix);
            if !x.affects.is_empty() {
                out += &format!("  Affects: {}\n", x.affects.join(", "));
            }
            out += "\n";
        }
    }

    out += "PERFORMANCE METRIC RELIABILITY\n";
    out += "------------------------------\n";
    let rho_below = rho.iter().any(|r| *r > 1e-9 && *r < 0.7);
    let svc_bad = (0..d).any(|i| data.effective_service_scvs[i] > 4.0 || data.effective_service_scvs[i] < 0.1);
    let arr_bad = (0..k_classes).any(|c| c < data.arrival_scvs.len() && data.arrival_scvs[c] > 4.0);
    let unstable = rho.iter().any(|r| *r >= 1.0);
    let metric = |name: &str, level: &str, note: &str| format!("  {}  {}  {note}\n", pad_r(&format!("{name}:"), 30), pad_r(level, 10));
    if unstable {
        out += &metric("E[X_i] (queue length)", "UNRELIABLE", "network is unstable — values are meaningless");
        out += &metric("Throughput (Γ_i)", "HIGH", "throughput is bounded by capacity regardless of stability");
        out += &metric("Utilization (ρ_i)", "HIGH", "computed directly from primitives");
        out += &metric("Sojourn time", "UNRELIABLE", "Little's law applied to meaningless E[X]");
        out += &metric("Per-class W, T, N", "UNRELIABLE", "downstream of E[X]");
    } else {
        let level = if rho_below || svc_bad || arr_bad { "MODERATE" } else { "HIGH" };
        let note = if svc_bad {
            "service SCV is extreme — expect bias in E[X]"
        } else if arr_bad {
            "arrival SCV is extreme — expect bias in E[X]"
        } else if rho_below {
            "ρ below heavy-traffic regime — E[X] systematically biased"
        } else {
            "primitives inside heavy-traffic sweet spot"
        };
        out += &metric("E[X_i] (queue length)", level, note);
        out += &metric("Throughput (Γ_i)", "HIGH", "Γ = α; derived exactly from traffic equations");
        out += &metric("Utilization (ρ_i)", "HIGH", "ρ = α / (s·μ); derived exactly from primitives");
        out += &metric("Sojourn time", level, "sojourn = E[X]/Γ; inherits E[X] reliability");
        out += &metric("Per-class W, T, N", level, "Little's law applied to E[X]; inherits its reliability");
    }
    out += "\n";

    if !fs.is_empty() {
        out += "TOP ACTIONABLE SUGGESTIONS\n";
        out += "--------------------------\n";
        for (idx, x) in ordered.iter().take(3).enumerate() {
            out += &format!("{}. {}\n", idx + 1, x.fix);
        }
        out += "\n";
    }
    out
}

/// The end of the M/D/1 finding's Fix. 0.90.34 passed "…within ~10%." to String(format:), which
/// read the "%." as a conversion and dropped it, so the sentence ended "~10"; the owner chose to
/// print it whole (D5, ledger ANA-154, 2026-11-10).
pub const MD1_TAIL: &str = "Otherwise SRBM is usually within ~10%.";
/// What 0.90.34 printed, kept for the golden comparison.
pub const MD1_TAIL_0_90_34: &str = "Otherwise SRBM is usually within ~10";

/// The μ_i legend line. 0.90.34 wrote "Σ_k (α^(k)_i/α_i) μ^(k)_i", an arithmetic mean, but computes
/// the harmonic one (traffic.rs); the owner chose to fix the words (D5, ledger ANA-180).
pub const MU_LEGEND: &str = "  μ_i = 1 / Σ_k (α^(k)_i/α_i) (1/μ^(k)_i)     throughput-weighted (harmonic) service rate\n";
/// The line 0.90.34 printed, kept for the golden comparison.
pub const MU_LEGEND_0_90_34: &str = "  μ_i = Σ_k (α^(k)_i/α_i) μ^(k)_i     throughput-weighted service rate\n";

/// Network › Show Network Primitives (`formatNetworkPrimitives`), with `warnings` from
/// `network_warnings` and `validate_link_structure`.
pub fn primitives(data: &SrbmData, warnings: &[String], infinite: bool) -> String {
    let d = data.d;
    let rho = rhos(data);
    let mut s = String::new();
    s += &"=".repeat(72);
    s += "\nNETWORK PRIMITIVES (Brownian / SRBM)\n";
    s += &"=".repeat(72);
    s += "\n\n";
    s += "Structure:\n";
    s += &format!("  Stations (d):         {d}\n");
    s += &format!("  Customer classes (K): {}\n", data.k);
    s += &format!("  Buffer sizes a:       [{}]\n", data.a_vec.iter().map(|a| f("%g", *a)).collect::<Vec<_>>().join(", "));
    s += &format!("  Servers s_i:          [{}]\n\n", data.servers.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "));

    s += "External arrival rates λ_k (per class):\n";
    for k in 0..data.k {
        s += &format!("  Class {}:  {}\n", k + 1, f("%10.5f", data.class_external_arrivals[k]));
    }
    let total = data.class_external_arrivals.iter().fold(0.0, |a, b| a + b);
    s += &format!("  Total:    {}\n\n", f("%10.5f", total));

    s += "Per-station primitives:\n";
    s += "  i | servers |        α_i |        μ_i |        c_i |       ρ_i |      b_i\n";
    s += "  ";
    s += &"-".repeat(72);
    s += "\n";
    for i in 0..d {
        s += &format!(
            "  {} |   {:>3}   | {} | {} | {} | {} | {}\n",
            i + 1,
            data.servers[i],
            f("%10.5f", data.alpha[i]),
            f("%10.5f", data.service_rates[i]),
            f("%10.5f", data.capacity[i]),
            f("%9.5f", rho[i]),
            f("%+8.5f", data.alpha[i] - data.capacity[i])
        );
    }
    s += "\n";
    s += "  α_i = Σ_k α^(k)_i     offered arrival rate at station i\n";
    s += MU_LEGEND;
    s += "  c_i = s_i · μ_i       station capacity\n";
    s += "  ρ_i = α_i / c_i       nominal traffic intensity\n";
    s += "  b_i = α_i - c_i       station netput\n";
    s += if infinite {
        "  θ = (I - Pᵀ) b        SRBM drift (reflection R = I - Pᵀ)\n\n"
    } else {
        "  θ = b                 SRBM drift (lower-face reflection e_i)\n\n"
    };

    s += "Per-class throughput α^(k)_i:\n";
    s += "         ";
    for i in 0..d {
        s += &format!(" station {} ", i + 1);
    }
    s += "\n";
    for k in 0..data.k {
        s += &format!("  class {}  ", k + 1);
        for i in 0..d {
            s += &f("%10.5f ", data.alpha_per_class[k][i]);
        }
        s += "\n";
    }
    s += "\n";

    s += "Aggregated routing matrix P (row i → col j):\n";
    s += "          ";
    for j in 0..d {
        s += &format!("    →{}    ", j + 1);
    }
    s += "\n";
    for i in 0..d {
        s += &format!("  from {}  ", i + 1);
        for j in 0..d {
            s += &f(" %8.4f ", data.aggregated_p[i][j]);
        }
        s += "\n";
    }
    s += "\n";

    s += "Reflection matrix R (d × 2d, columns = [lower_1, upper_1, lower_2, upper_2, …]):\n";
    for i in 0..d {
        s += &format!("  row {}: ", i + 1);
        for col in 0..2 * d {
            s += &f("%+7.3f ", data.r[i][col]);
        }
        s += "\n";
    }
    s += "\n";

    s += "Covariance matrix Σ (diffusion coefficient):\n";
    for i in 0..d {
        s += "  ";
        for j in 0..d {
            s += &f("%10.5f ", data.gamma[i][j]);
        }
        s += "\n";
    }
    s += "\n";

    if warnings.is_empty() {
        s += "No warnings — parameters look healthy for the Brownian approximation.\n";
    } else {
        for msg in warnings {
            s += &format!("\u{1b}[1;31m!! Warning:\u{1b}[0m {msg}\n");
        }
    }
    s
}

/// Primitives' warnings as the menu command gathers them: the validity warnings, then the
/// link-structure violations.
pub fn primitives_warnings(data: &SrbmData, nodes: &[Node], links: &[Link], infinite: bool) -> Vec<String> {
    let mut w = network_warnings(data, infinite);
    w.extend(validate_link_structure(nodes, links, infinite));
    w
}
