//! The flag bar's state: what the analysis that runs after every edit decides about a network
//! (0.90.34 `QnetGUIApp.applyTractability`, `describeFeedback`, `stationsInLongerCycles` and
//! `diffusionFriendlinessAssessment`).
//!
//! Three pills read it. Analytical shows the closed form `tractability::assess` found, except that
//! an asymptotic (GCDG) match is withheld on a re-entrant network, where its multi-scaling regime is
//! unreliable, and on a finite-buffer one, where its orthant formulas don't respect the buffer.
//! Re-entrant describes the routing cycles and grades the network against four diffusion
//! criteria. Warnings (report::network_warnings) is the third. The Status lines the analysis writes
//! are returned too, so the interface can log them. Checked against 0.90.34 for every example
//! (golden/<example>/flags.txt, tests/golden_flags.rs).

use crate::cfmt::f;
use crate::model::Node;
use crate::tractability;
use crate::traffic::SrbmData;

/// The Re-entrant pill's colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedbackQuality {
    /// No routing cycles: the pill stays grey.
    NotReentrant,
    Green,
    Yellow,
    Red,
}

impl FeedbackQuality {
    /// Swift's case name, as `"\(quality)"` printed it.
    pub fn case_name(self) -> &'static str {
        match self {
            FeedbackQuality::NotReentrant => "notReentrant",
            FeedbackQuality::Green => "green",
            FeedbackQuality::Yellow => "yellow",
            FeedbackQuality::Red => "red",
        }
    }
}

/// One diffusion-friendliness check.
#[derive(Clone, Debug, PartialEq)]
pub struct Criterion {
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

/// What the analysis publishes for the flag bar (0.90.34's editor fields of the same names).
#[derive(Clone, Debug, PartialEq)]
pub struct Flags {
    pub is_analytically_tractable: bool,
    pub tractability_is_exact: bool,
    pub tractability_title: String,
    pub tractability_detail: String,
    pub tractability_means: Vec<f64>,
    pub tractability_means_label: String,
    pub tractability_explanation: String,
    pub has_feedback: bool,
    pub feedback_description: String,
    pub feedback_quality: FeedbackQuality,
    pub feedback_criteria: Vec<Criterion>,
    /// What a non-quiet analysis writes to the Status log.
    pub status: Vec<String>,
}

/// The flag-bar state for a network's station model (`applyTractability`).
pub fn assess(data: &SrbmData, nodes: &[Node], infinite: bool) -> Flags {
    let result = tractability::assess(data, nodes, infinite, true);
    let has_cycles = tractability::has_routing_cycles(&data.aggregated_p);
    let asymptotic = result.is_tractable() && !result.is_exact();
    let suppress_reentrant = has_cycles && asymptotic;
    let suppress_finite = !infinite && asymptotic;
    let mut status = Vec::new();
    let mut flags = Flags {
        is_analytically_tractable: false,
        tractability_is_exact: false,
        tractability_title: String::new(),
        tractability_detail: String::new(),
        tractability_means: Vec::new(),
        tractability_means_label: String::new(),
        tractability_explanation: String::new(),
        has_feedback: has_cycles,
        feedback_description: if has_cycles { describe_feedback(&data.aggregated_p) } else { String::new() },
        feedback_quality: FeedbackQuality::NotReentrant,
        feedback_criteria: Vec::new(),
        status: Vec::new(),
    };
    if suppress_reentrant || suppress_finite {
        let reason = if suppress_reentrant {
            "the network is re-entrant — the multi-scaling regime is unreliable here"
        } else {
            "the network has finite buffers — the GCDG asymptotic formulas are infinite-buffer predictions and don't bound the queue at the buffer"
        };
        status.push(format!("Analytical match is ASYMPTOTIC ({}) but {reason}, so the analytical column is suppressed in Run Comparison.", result.detail));
    } else {
        flags.is_analytically_tractable = result.is_tractable();
        flags.tractability_is_exact = result.is_exact();
        flags.tractability_title = result.title.clone();
        flags.tractability_detail = result.detail.clone();
        flags.tractability_means = result.means.clone();
        flags.tractability_means_label = result.means_label.clone();
        flags.tractability_explanation = result.explanation.clone();
        if asymptotic {
            status.push(format!(
                "Analytical match is ASYMPTOTIC ({}). At finite ρ, the asymptotic means may differ from algorithm/simulation values; Run Comparison's algorithm-vs-asymptotic deltas use simulation as the reference instead.",
                result.detail
            ));
        }
    }
    let (q, criteria) = diffusion_friendliness(data, has_cycles);
    flags.feedback_quality = q;
    flags.feedback_criteria = criteria;
    flags.status = status;
    flags
}

/// Grades a re-entrant network for diffusion methods (`diffusionFriendlinessAssessment`):
/// per-station ρ < 0.85, service SCV in [0.5, 2], largest re-entry probability < 0.5 (vacuous for a
/// single-class Markovian network), and no class-speed amplification at a station above ρ = 0.7.
/// The last failing alone makes it red; otherwise 0 failures green, 1–2 yellow, 3+ red.
pub fn diffusion_friendliness(data: &SrbmData, has_feedback: bool) -> (FeedbackQuality, Vec<Criterion>) {
    if !has_feedback {
        return (FeedbackQuality::NotReentrant, Vec::new());
    }
    let d = data.d;
    let mut criteria = Vec::new();
    let crit = |label: &str, ok: bool, detail: String| Criterion { label: label.into(), ok, detail };

    let rhos: Vec<f64> = (0..d).map(|i| if data.capacity[i] > 1e-12 { data.alpha[i] / data.capacity[i] } else { 0.0 }).collect();
    // Sequence.max(): the first element, replaced by each later one it is less than.
    let max_rho = rhos.iter().copied().reduce(|m, x| if m < x { x } else { m }).unwrap_or(0.0);
    let rho_ok = max_rho < 0.85;
    criteria.push(crit("Per-station ρ < 0.85", rho_ok, format!("max ρ = {}{}", f("%.3f", max_rho), if rho_ok { "" } else { " — heavy traffic amplifies the per-class burstiness gap" })));

    let mut scv_ok = true;
    let mut worst = 1.0;
    for &s in &data.effective_service_scvs {
        if s < 0.5 || s > 2.0 {
            scv_ok = false;
            if (s - 1.0f64).abs() > (worst - 1.0f64).abs() {
                worst = s;
            }
        }
    }
    criteria.push(crit(
        "Service SCV in [0.5, 2]",
        scv_ok,
        if scv_ok { "all stations within range".into() } else { format!("worst c²_s = {} (extreme variance breaks 2-moment methods)", f("%.3f", worst)) },
    ));

    let p = &data.aggregated_p;
    let mut max_loop = 0.0;
    for i in 0..d {
        if p[i][i] > max_loop {
            max_loop = p[i][i];
        }
        for j in (0..d).filter(|j| *j != i) {
            if p[i][j] > 1e-12 && p[j][i] > 1e-12 {
                // Swift's min(a, b): b < a ? b : a.
                let cyc = if p[j][i] < p[i][j] { p[j][i] } else { p[i][j] };
                if cyc > max_loop {
                    max_loop = cyc;
                }
            }
        }
    }
    let markovian = data.k == 1 && data.effective_service_scvs.iter().all(|s| (s - 1.0).abs() < 0.1);
    let p_ok = max_loop < 0.5 || markovian;
    let p_detail = if markovian && max_loop >= 0.5 {
        format!("largest cycle prob = {} — vacuous for single-class Markovian network (Jackson is exact)", f("%.3f", max_loop))
    } else if p_ok {
        format!("largest cycle prob = {}", f("%.3f", max_loop))
    } else {
        format!("largest cycle prob = {} — heavy feedback inflates the per-class temporal correlation", f("%.3f", max_loop))
    };
    criteria.push(crit("Max re-entry probability < 0.5", p_ok, p_detail));

    let mut amplify_ok = true;
    let mut worst_station: Option<usize> = None;
    let mut worst_ratio = 1.0;
    if data.k > 1 {
        for i in (0..d).filter(|i| rhos[*i] > 0.7) {
            let (mut mu_min, mut mu_max, mut seen) = (f64::INFINITY, 0.0, false);
            for k in (0..data.k).filter(|k| data.alpha_per_class[*k][i] > 1e-12) {
                let mu = data.class_service_rates[k][i];
                if mu > 0.0 {
                    if mu < mu_min {
                        mu_min = mu;
                    }
                    if mu > mu_max {
                        mu_max = mu;
                    }
                    seen = true;
                }
            }
            if seen && mu_min > 0.0 {
                let r = mu_max / mu_min;
                if r > 3.0 {
                    amplify_ok = false;
                    if r > worst_ratio {
                        worst_ratio = r;
                        worst_station = Some(i);
                    }
                }
            }
        }
    }
    let amplify_detail = if amplify_ok {
        if data.k > 1 { "no station with ρ > 0.7 has class μ-ratio > 3".to_string() } else { "single-class network — N/A".to_string() }
    } else {
        // A failure always sets the worst station (its ratio exceeds 3 > the initial 1).
        let w = worst_station.expect("a failed check names its station");
        format!("S{} has ρ = {} and class μ-ratio = {} (Kumar-Seidman / Bramson signature)", w + 1, f("%.2f", rhos[w]), f("%.1f", worst_ratio))
    };
    criteria.push(crit("No class-transition amplification at high-ρ stations", amplify_ok, amplify_detail));

    let failures = criteria.iter().filter(|c| !c.ok).count();
    let q = if !amplify_ok {
        FeedbackQuality::Red
    } else if failures == 0 {
        FeedbackQuality::Green
    } else if failures <= 2 {
        FeedbackQuality::Yellow
    } else {
        FeedbackQuality::Red
    };
    (q, criteria)
}

/// The Re-entrant popover's description of the routing cycles (`describeFeedback`): self-loops,
/// immediate two-station feedback, and the stations of any longer loop.
pub fn describe_feedback(p: &[Vec<f64>]) -> String {
    let d = p.len();
    let mut lines = Vec::new();
    let self_loops: Vec<usize> = (0..d).filter(|i| p[*i][*i] > 1e-12).map(|i| i + 1).collect();
    if !self_loops.is_empty() {
        lines.push(format!("Self-loop(s): {}.", self_loops.iter().map(|s| format!("S{s}")).collect::<Vec<_>>().join(", ")));
    }
    let mut pairs = Vec::new();
    for i in 0..d {
        for j in (i + 1)..d {
            if p[i][j] > 1e-12 && p[j][i] > 1e-12 {
                pairs.push((i + 1, j + 1));
            }
        }
    }
    if !pairs.is_empty() {
        lines.push(format!("Immediate feedback: {}.", pairs.iter().map(|(a, b)| format!("S{a} ↔ S{b}")).collect::<Vec<_>>().join(", ")));
    }
    let long = stations_in_longer_cycles(p, &self_loops, &pairs);
    if !long.is_empty() {
        lines.push(format!("Longer rework loop through: {}.", long.iter().map(|s| format!("S{s}")).collect::<Vec<_>>().join(", ")));
    }
    if lines.is_empty() {
        lines.push("Routing graph contains a directed cycle.".into());
    }
    lines.join("\n")
}

/// Stations (1-based, ascending) in a strongly connected component of two or more, apart from a
/// two-station component already reported as immediate feedback, and apart from self-looped
/// stations (`stationsInLongerCycles`, Tarjan's algorithm).
fn stations_in_longer_cycles(p: &[Vec<f64>], ignore_self_loops: &[usize], ignore_pairs: &[(usize, usize)]) -> Vec<usize> {
    struct Tarjan<'a> {
        p: &'a [Vec<f64>],
        index: usize,
        indices: Vec<Option<usize>>,
        lowlink: Vec<usize>,
        on_stack: Vec<bool>,
        stack: Vec<usize>,
        sccs: Vec<Vec<usize>>,
    }
    impl Tarjan<'_> {
        fn connect(&mut self, v: usize) {
            self.indices[v] = Some(self.index);
            self.lowlink[v] = self.index;
            self.index += 1;
            self.stack.push(v);
            self.on_stack[v] = true;
            for w in 0..self.p.len() {
                if v == w || !(self.p[v][w] > 1e-12) {
                    continue;
                }
                match self.indices[w] {
                    None => {
                        self.connect(w);
                        self.lowlink[v] = self.lowlink[v].min(self.lowlink[w]);
                    }
                    Some(iw) if self.on_stack[w] => self.lowlink[v] = self.lowlink[v].min(iw),
                    Some(_) => {}
                }
            }
            if Some(self.lowlink[v]) == self.indices[v] {
                let mut comp = Vec::new();
                while let Some(top) = self.stack.pop() {
                    self.on_stack[top] = false;
                    comp.push(top);
                    if top == v {
                        break;
                    }
                }
                if comp.len() >= 2 {
                    self.sccs.push(comp);
                }
            }
        }
    }
    let d = p.len();
    let mut t = Tarjan { p, index: 0, indices: vec![None; d], lowlink: vec![0; d], on_stack: vec![false; d], stack: Vec::new(), sccs: Vec::new() };
    for v in 0..d {
        if t.indices[v].is_none() {
            t.connect(v);
        }
    }
    let pair_set: std::collections::BTreeSet<usize> = ignore_pairs.iter().flat_map(|(a, b)| [*a, *b]).collect();
    let mut out = std::collections::BTreeSet::new();
    for comp in &t.sccs {
        if comp.len() == 2 && pair_set.contains(&(comp[0] + 1)) && pair_set.contains(&(comp[1] + 1)) {
            continue;
        }
        out.extend(comp.iter().map(|v| v + 1));
    }
    for s in ignore_self_loops {
        out.remove(s);
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_is_described_by_self_loops_pairs_and_longer_loops() {
        let p = vec![vec![0.2, 0.5, 0.0, 0.0], vec![0.3, 0.0, 0.0, 0.0], vec![0.0, 0.0, 0.0, 0.6], vec![0.0, 0.0, 0.0, 0.0]];
        assert_eq!(describe_feedback(&p), "Self-loop(s): S1.\nImmediate feedback: S1 ↔ S2.");
        let ring = vec![vec![0.0, 0.9, 0.0], vec![0.0, 0.0, 0.9], vec![0.5, 0.0, 0.0]];
        assert_eq!(describe_feedback(&ring), "Longer rework loop through: S1, S2, S3.");
        assert_eq!(describe_feedback(&[vec![0.0]]), "Routing graph contains a directed cycle.", "nothing to name, still a cycle");
    }
}
