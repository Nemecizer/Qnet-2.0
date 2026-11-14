//! `qnet-cli methods` and `qnet-cli solve`: which methods apply to a network, why, and the one
//! Solve would run (new in 2.1).
//!
//! In the app these rules live in three places, and this file repeats them for the command line:
//! the network's side (`MethodDomain`, src-tauri/src/analysis_windows/advice.rs — a crate the CLI
//! does not link), the Method Chooser's rows (src/windows/methodchooser/advice.ts and the
//! sentences of its words.ts) and Solve's walk over them (src/panes/results/agreement/plan.ts).
//! One fixture holds the three together, cli/tests/fixtures/methods.json: this file must produce
//! it (cli/tests/cli_json.rs), the app's `domain()` must give its domains (advice.rs's tests),
//! and the interface's `recommendations` and `solveChoice` must give its rows and choices
//! (src/windows/methodchooser/cli-parity.test.ts). A rule changed in one place fails the others.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use qnet_core::dist::parse_params;
use qnet_core::editor::class_index_of_source;
use qnet_core::export::{product_form, qbd};
use qnet_core::json::Json;
use qnet_core::model::{Distribution, Network, Node, NodeKind};
use qnet_core::results::model::{Fidelity, MethodMetadata};
use qnet_core::{closed, flags, report, traffic};
use qnet_runner::resolver::{Outcome, PythonRequest, Resolver, DEFAULT_GROUPS};

/// The name 0.90.34 gave the exporters when it only asked whether they would accept the network.
const PREVIEW_NAME: &str = "Applicability preview";

/// The network's side of the Method Chooser (`MethodDomain`).
#[derive(Clone, Debug, PartialEq)]
pub struct Domain {
    pub infinite_buffers: bool,
    pub station_count: usize,
    pub class_count: usize,
    pub warning_count: usize,
    pub has_feedback: bool,
    /// exact, title, detail, explanation.
    pub analytical: Option<(bool, String, String, String)>,
    pub sources_are_poisson: bool,
    pub services_are_exponential: bool,
    pub class_transitions: bool,
    pub class_independent_service: bool,
    pub heavy_jackson: bool,
    pub product_form_refusal: Option<String>,
    pub qbd_refusal: Option<String>,
    /// Why Replicated Simulation cannot estimate the network (`simstat::plan`), or None.
    pub replicated_simulation_refusal: Option<String>,
    /// For a network drawn as a closed one: its population and why `closed.rs` cannot solve it.
    pub closed: Option<(Option<i64>, Option<String>)>,
    /// For a network that uses a model feature new in 2.1 (priorities, batch arrivals, a rate
    /// profile): core's one answer (`extended::methods_domain`).
    pub extended: Option<qnet_core::extended::MethodsDomain>,
}

fn class_independent_service(net: &Network) -> bool {
    let mut classes: BTreeSet<i64> = net.links.iter().flat_map(|l| [l.class, l.exit_class()]).collect();
    for source in net.nodes.iter().filter(|n| n.kind == NodeKind::Source) {
        classes.insert(class_index_of_source(&net.nodes, &source.id) as i64);
    }
    if classes.is_empty() {
        classes.insert(0);
    }
    net.nodes.iter().filter(|n| n.kind == NodeKind::Station).all(|station| {
        let rates: Vec<f64> = classes
            .iter()
            .filter_map(|c| {
                let (distribution, parameters) = station.service_by_class.get(c).map(|s| (s.distribution, s.parameters.as_str())).unwrap_or((station.distribution, station.parameters.as_str()));
                if distribution != Distribution::Exponential {
                    return None;
                }
                parse_params(parameters).get("rate").copied()
            })
            .collect();
        let Some(&first) = rates.first() else { return false };
        if rates.len() != classes.len() || !first.is_finite() || first <= 0.0 {
            return false;
        }
        rates.iter().all(|r| r.is_finite() && *r > 0.0 && (r - first).abs() <= 1e-10 * 1f64.max(first.abs().max(r.abs())))
    })
}

/// The warnings the app's silent analysis lists (`networkWarnings` then `validateLinkStructure`),
/// or the sentence saying why the station model cannot be built.
pub fn warnings(net: &Network) -> Result<Vec<String>, String> {
    // At the sources' long-run customer rates, as the app's silent analysis (`extended::traffic`
    // is `traffic::compute` itself for a network without batches or rate profiles).
    let data = qnet_core::extended::traffic(net, net.infinite_buffers, false, false).map_err(|e| e.message())?;
    let mut w = report::network_warnings(&data, net.infinite_buffers);
    w.extend(report::validate_link_structure(&net.nodes, &net.links, net.infinite_buffers));
    Ok(w)
}

pub fn domain(net: &Network) -> Domain {
    let stations: Vec<&Node> = net.nodes.iter().filter(|n| n.kind == NodeKind::Station).collect();
    let mut class_ids: BTreeSet<i64> = net.links.iter().flat_map(|l| [l.class, l.to_class.unwrap_or(l.class)]).collect();
    class_ids.extend(stations.iter().flat_map(|s| s.service_by_class.keys().copied()));
    // The silent analysis (src-tauri/src/analysis.rs `analyse`): nothing for an empty or a closed
    // network or one whose station model fails; otherwise the warnings and the flag-bar state.
    let analysed = if net.nodes.is_empty() || qnet_core::extended::classical_only(net, "").is_some() {
        None
    } else {
        traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).ok()
    };
    let (warning_count, fl) = match &analysed {
        Some(data) => {
            let mut w = report::network_warnings(data, net.infinite_buffers);
            w.extend(report::validate_link_structure(&net.nodes, &net.links, net.infinite_buffers));
            (w.len(), Some(flags::assess(data, &net.nodes, net.infinite_buffers)))
        }
        None => (0, None),
    };
    let analytical = fl.as_ref().filter(|f| f.is_analytically_tractable).map(|f| (f.tractability_is_exact, f.tractability_title.clone(), f.tractability_detail.clone(), f.tractability_explanation.clone()));
    let heavy_jackson = fl.as_ref().is_some_and(|f| f.tractability_is_exact && f.tractability_means_label.to_lowercase().contains("jackson") && f.tractability_means.iter().sum::<f64>() > 20.0);
    Domain {
        infinite_buffers: net.infinite_buffers,
        station_count: stations.len(),
        class_count: class_ids.len().max(1),
        warning_count,
        has_feedback: fl.as_ref().is_some_and(|f| f.has_feedback),
        analytical,
        sources_are_poisson: net.nodes.iter().filter(|n| n.kind == NodeKind::Source).all(|n| matches!(n.distribution, Distribution::Poisson | Distribution::Exponential)),
        services_are_exponential: stations.iter().all(|s| s.distribution == Distribution::Exponential && s.service_by_class.values().all(|c| c.distribution == Distribution::Exponential)),
        class_transitions: net.links.iter().any(|l| l.has_class_transition()),
        class_independent_service: class_independent_service(net),
        heavy_jackson,
        product_form_refusal: product_form::export(net, PREVIEW_NAME, product_form::DEFAULT_MAXIMUM_SERVERS).err().map(|e| e.message()),
        qbd_refusal: qbd::export(net, PREVIEW_NAME, &qbd::QbdOptions::default()).err().map(|e| e.message()),
        replicated_simulation_refusal: qnet_core::simstat::plan(net).err().map(|r| r.message),
        closed: closed::looks_closed(net).then(|| (net.population, qnet_core::extended::problems(net).into_iter().next().map(|p| p.message).or_else(|| closed::from_network(net).err().map(|e| e.message())))),
        extended: qnet_core::extended::methods_domain(net),
    }
}

/// Whether each solver the Chooser asks about is installed: key → the reason it is not.
/// `None` for a key means available.
pub type Availability = BTreeMap<&'static str, Option<String>>;

pub const RUNTIME_KEYS: [&str; 9] = ["productForm", "qbd", "regenerative", "truncatedCtmc", "adaptiveBar", "barBounds", "multiclass", "genericCtmc", "decomposition"];

/// Every solver counted as installed: the network's side of the answer alone.
pub fn all_installed() -> Availability {
    RUNTIME_KEYS.iter().map(|k| (*k, None)).collect()
}

/// The lookups the app's chooser makes (advice.rs `RUNTIMES`, `lookup_reason`), through `resolver`.
pub fn installed(resolver: &Resolver) -> Availability {
    // key, file, folder, group ("" for the native solver, looked up in both groups).
    const RUNTIMES: [(&str, &str, &str, &str); 9] = [
        ("productForm", "solver.py", "BNApf", "infinite"),
        ("qbd", "qbd_solver.py", "BNAqbd", "infinite"),
        ("regenerative", "regenerative_mc.py", "BNArmc", "infinite"),
        ("truncatedCtmc", "truncated_ctmc.py", "BNAtc", "infinite"),
        ("adaptiveBar", "low_rank_bar.py", "BNAalr", "infinite"),
        ("barBounds", "solver.py", "BNAbb", "infinite"),
        ("multiclass", "mc_solver", "BNAmd", ""),
        ("genericCtmc", "solver.py", "fBNAgc", "finite"),
        ("decomposition", "fbna_decomp.py", "fBNAdecomp", "finite"),
    ];
    RUNTIMES
        .iter()
        .map(|(key, name, dir, group)| {
            let found = if group.is_empty() { resolver.resolve_executable_in(name, dir, DEFAULT_GROUPS, Duration::from_millis(800)) } else { resolver.resolve_python_support_file_in(name, dir, &[group], &PythonRequest::default()) };
            let reason = if found.resolution.is_some() {
                None
            } else {
                let attempt = found.attempts.iter().rev().find(|a| matches!(a.outcome, Outcome::RuntimeUnavailable | Outcome::NotReadable | Outcome::LoaderRejected)).map(|a| a.detail.clone());
                Some(attempt.or_else(|| found.declared_unavailable_reason.clone().filter(|r| !r.is_empty())).unwrap_or_default())
            };
            (*key, reason)
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Suitability {
    Recommended,
    Applicable,
    Caution,
    Experimental,
    Unavailable,
}

impl Suitability {
    pub fn raw(self) -> &'static str {
        match self {
            Suitability::Recommended => "recommended",
            Suitability::Applicable => "applicable",
            Suitability::Caution => "caution",
            Suitability::Experimental => "experimental",
            Suitability::Unavailable => "unavailable",
        }
    }
}

/// One row of the Method Chooser.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// The Chooser's id ("qna", "open-product-form").
    pub id: &'static str,
    pub name: String,
    /// "exactQueue", "queueSimulation", "queueApproximation", "srbmNumerical", "srbmAnalytical".
    pub layer: &'static str,
    pub suitability: Suitability,
    /// The Chooser's sentence: what the method does here, or why it cannot be used.
    pub summary: String,
}

impl Row {
    /// The `qnet-cli run` label, or None for the row with no run of its own (Analytical solution).
    pub fn label(&self, infinite: bool) -> Option<&'static str> {
        Some(match self.id {
            "simulation-infinite" => "inf_sim",
            "open-product-form" => "product_form",
            "closed-product-form" => "closed_pf",
            "simulation-inprocess" => "sim_inproc",
            "priority-exact" => "priority_exact",
            "batch-exact" => "batch_exact",
            "qbd" => "qbd",
            "spectral-infinite" => "inf_sm",
            "qna" => "qna",
            "rqna" => "rqna",
            "sbd" => "sbd",
            "mlmc" => "mlmc",
            "lp-infinite" => "lp",
            "truncated-ctmc" => "truncated_ctmc",
            "regenerative-mc" => "regenerative_mc",
            "adaptive-low-rank-bar" => "adaptive_bar",
            "bar-moment-bounds" => "bar_bounds",
            "multiclass-srbm" => "mc",
            "simulation-finite" => "sim",
            "ctmc" => "generic_ctmc",
            "finite-decomposition" => "fb_decomp",
            "spectral-finite" => "sm",
            "fem-finite" => "fm",
            "lp-finite" => "flp",
            _ => {
                let _ = infinite;
                return None;
            }
        })
    }

    /// "exact", "simulation" or "approximation": the pass of Solve's walk the row belongs to.
    pub fn kind(&self) -> &'static str {
        match self.layer {
            "exactQueue" => "exact",
            "queueSimulation" => "simulation",
            _ => "approximation",
        }
    }
}

/// The tier a record of this fidelity is shown under (src/results/insight.ts `tierOf`).
pub fn tier(fidelity: Fidelity) -> &'static str {
    match fidelity {
        Fidelity::ExactQueue => "exact",
        Fidelity::QueueSimulation => "simulation",
        Fidelity::QueueApproximation => "approximation",
        Fidelity::SrbmNumerical | Fidelity::SrbmSimulation => "diffusion",
        Fidelity::SrbmBoundRelaxation => "bound",
        _ => "mixed",
    }
}

const RUNTIME_FALLBACK: &str = "the Python-backed solver support is unavailable in this installation";

fn row(id: &'static str, name: &str, layer: &'static str, suitability: Suitability, summary: impl Into<String>) -> Row {
    Row { id, name: name.to_string(), layer, suitability, summary: summary.into() }
}

fn infinite_rows(d: &Domain, a: &Availability) -> Vec<Row> {
    use Suitability::*;
    let ready = |k: &str| a.get(k).is_some_and(|r| r.is_none());
    let reason = |k: &str| a.get(k).and_then(|r| r.clone()).filter(|r| !r.is_empty()).unwrap_or_else(|| RUNTIME_FALLBACK.to_string());
    let diffusion = if d.warning_count > 0 { Caution } else { Applicable };
    let truncated = d.class_count == 1 && d.sources_are_poisson && d.services_are_exponential;
    let regenerative = d.sources_are_poisson && d.services_are_exponential && !d.class_transitions && d.class_independent_service;
    let n = d.station_count;
    let multiclass = d.class_count > 1 && ready("multiclass");
    let exact = |refusal: &Option<String>, key: &str, ready_text: &str| match refusal {
        Some(r) => (Unavailable, r.clone()),
        None if !ready(key) => (Unavailable, format!("The model qualifies, but {}.", reason(key))),
        None => (Recommended, ready_text.to_string()),
    };
    let (pf, pf_text) = exact(&d.product_form_refusal, "productForm", "Computes exact M/M/c station measures analytically without truncating the infinite state space.");
    let (qb, qb_text) = exact(&d.qbd_refusal, "qbd", "The network maps exactly to a scalar, level-independent QBD.");
    let heavy = if d.heavy_jackson { Caution } else { Applicable };
    vec![
        row("open-product-form", "Exact Open Product Form", "exactQueue", pf, pf_text),
        row("qbd", "Exact Matrix-Analytic QBD", "exactQueue", qb, qb_text),
        row("simulation-infinite", "Monte Carlo", "queueSimulation", Recommended, "Directly simulates the queueing process and supplies the main cross-model reference."),
        replicated_row(d, false),
        row(
            "regenerative-mc",
            "Regenerative Monte Carlo",
            "queueSimulation",
            if regenerative && ready("regenerative") { heavy } else { Unavailable },
            if !regenerative {
                "Requires class-preserving Poisson/exponential Markov primitives and one service rate per station across classes.".to_string()
            } else if !ready("regenerative") {
                reason("regenerative")
            } else {
                "Uses complete empty-to-empty cycles and stops when every monitored precision requirement is met.".to_string()
            },
        ),
        row(
            "qna",
            "Whitt QNA",
            "queueApproximation",
            if d.has_feedback { Caution } else { Recommended },
            if d.has_feedback { "Fast two-moment approximation; feedback can weaken renewal assumptions." } else { "Fast first estimate for station means and delays." },
        ),
        row(
            "truncated-ctmc",
            "Adaptive Truncated CTMC",
            "queueApproximation",
            if truncated && ready("truncatedCtmc") { heavy } else { Unavailable },
            if !truncated {
                "Requires one class, Poisson arrivals and exponential service.".to_string()
            } else if !ready("truncatedCtmc") {
                reason("truncatedCtmc")
            } else {
                "Solves sparse finite caps until boundary mass and successive queue moments stabilize.".to_string()
            },
        ),
        row(
            "adaptive-low-rank-bar",
            "Adaptive Low-Rank BAR",
            "srbmNumerical",
            if n <= 32 && ready("adaptiveBar") { Experimental } else { Unavailable },
            if n > 32 {
                "The maintained Halton construction is limited to thirty-two SRBM dimensions.".to_string()
            } else if !ready("adaptiveBar") {
                reason("adaptiveBar")
            } else {
                "Fits an adaptive low-rank exponential mixture and validates it on held-out BAR points.".to_string()
            },
        ),
        row(
            "bar-moment-bounds",
            "BAR Moment Bounds",
            "srbmNumerical",
            if !ready("barBounds") {
                Unavailable
            } else if n <= 4 {
                Experimental
            } else {
                Caution
            },
            if !ready("barBounds") {
                reason("barBounds")
            } else if n == 1 {
                "Returns a certified exact stationary workload moment for the one-dimensional SRBM.".to_string()
            } else {
                "Builds a Stieltjes moment-SDP outer relaxation; an optional SDP backend is needed for general numerical bounds.".to_string()
            },
        ),
        row("rqna", "Whitt–You RQNA", "queueApproximation", if d.has_feedback { Recommended } else { Applicable }, "Propagates variability over multiple time scales and is useful when a scalar SCV is insufficient."),
        row("sbd", "Sequential Bottleneck Decomposition", "srbmNumerical", diffusion, "Decomposes the heavy-traffic network into bottleneck RBM subproblems."),
        row("spectral-infinite", "Spectral Method", "srbmNumerical", if n > 8 { Caution } else { diffusion }, "Global Galerkin approximation of the stationary SRBM density."),
        row("mlmc", "SRBM MLMC", "srbmNumerical", diffusion, "Monte Carlo estimator for the stationary reflected Brownian model, with confidence intervals."),
        row(
            "lp-infinite",
            "Linear Program",
            "srbmNumerical",
            if n > 15 {
                Unavailable
            } else if n > 8 {
                Caution
            } else {
                diffusion
            },
            "BAR occupation-measure relaxation for SRBM stationary moments.",
        ),
        row(
            "multiclass-srbm",
            "Multi-Class SRBM",
            "srbmNumerical",
            if multiclass { Experimental } else { Unavailable },
            if multiclass {
                "Experimental class-aware service moments, traffic equations and routing covariance."
            } else if d.class_count <= 1 {
                "The current network has only one customer class."
            } else {
                "The optional solver is unavailable in this build; its dependency manifest explains why."
            },
        ),
    ]
}

fn finite_rows(d: &Domain, a: &Availability) -> Vec<Row> {
    use Suitability::*;
    let ready = |k: &str| a.get(k).is_some_and(|r| r.is_none());
    let reason = |k: &str| a.get(k).and_then(|r| r.clone()).filter(|r| !r.is_empty()).unwrap_or_else(|| RUNTIME_FALLBACK.to_string());
    let diffusion = if d.warning_count > 0 { Caution } else { Applicable };
    let markovian = d.sources_are_poisson && d.services_are_exponential;
    let regenerative = markovian && !d.class_transitions && d.class_independent_service;
    let ctmc = markovian && d.station_count <= 6;
    vec![
        row("simulation-finite", "Monte Carlo", "queueSimulation", Recommended, "Direct queue-process reference for loss, BAS, or BAS with external loss."),
        row(
            "regenerative-mc",
            "Regenerative Monte Carlo",
            "queueSimulation",
            if regenerative && ready("regenerative") { Applicable } else { Unavailable },
            if !regenerative {
                "Requires class-preserving Poisson/exponential primitives and one service rate per station across classes.".to_string()
            } else if !ready("regenerative") {
                reason("regenerative")
            } else {
                "Cycle-level fixed-width simulation for the finite loss-on-full queueing process.".to_string()
            },
        ),
        row(
            "ctmc",
            "Exact Sparse CTMC",
            "exactQueue",
            if ctmc && ready("genericCtmc") { Applicable } else { Unavailable },
            if !ctmc {
                if markovian { "The Markov assumptions hold, but the state space may be large; the solver will stop safely at its configured limit." } else { "Requires Poisson arrivals and exponential service for every represented class." }.to_string()
            } else if !ready("genericCtmc") {
                reason("genericCtmc")
            } else {
                "Exact queue-process benchmark with reachable-state enumeration and a hard state-space safety limit.".to_string()
            },
        ),
        row(
            "finite-decomposition",
            "Finite-Buffer Decomposition",
            "queueApproximation",
            if markovian && ready("decomposition") { Recommended } else { Unavailable },
            if !markovian {
                "Requires Poisson arrivals and exponential FCFS service.".to_string()
            } else if !ready("decomposition") {
                reason("decomposition")
            } else {
                "A fast M/M/c/K fixed point for networks too large for exact state enumeration.".to_string()
            },
        ),
        row("spectral-finite", "Finite Spectral Method", "srbmNumerical", diffusion, "Global polynomial approximation of a bounded SRBM on the buffer hypercube."),
        row("fem-finite", "Finite Element", "srbmNumerical", diffusion, "Local Hermite finite-element approximation of the bounded SRBM density."),
        row("lp-finite", "Finite-Buffer LP", "srbmNumerical", diffusion, "BAR relaxation with lower- and upper-face occupation measures."),
    ]
}

/// Replicated Simulation's row (new in 2.1): applicable wherever `simstat::plan` accepts the
/// network, never ahead of the methods that were recommended before it existed.
fn replicated_row(d: &Domain, closed: bool) -> Row {
    let ready = if closed {
        "A second, independent opinion for this closed network: simulates it inside Qnet in independent replications and gives Student-t confidence intervals to hold against the exact solution."
    } else {
        "Simulates the network inside Qnet in independent replications, deletes the warm-up by MSER on 200 batch means and gives Student-t confidence intervals."
    };
    match &d.replicated_simulation_refusal {
        Some(r) => row("simulation-inprocess", "Replicated Simulation", "queueSimulation", Suitability::Unavailable, r.clone()),
        None => row("simulation-inprocess", "Replicated Simulation", "queueSimulation", Suitability::Applicable, ready),
    }
}

const CLOSED_OTHERS: &str = "This is a closed network (no source and no sink). This method needs arrivals from a source, so it cannot be used; Exact Closed Product Form solves the network exactly.";

/// The Chooser's rows in its order: suitability, then name without regard to case.
pub fn rows(d: &Domain, a: &Availability) -> Vec<Row> {
    let mut rows = Vec::new();
    if let Some((exact, title, _, _)) = &d.analytical {
        rows.push(row("analytical", if *exact { "Analytical solution" } else { "Asymptotic product form" }, if *exact { "exactQueue" } else { "srbmAnalytical" }, Suitability::Recommended, title.clone()));
    }
    rows.extend(if d.infinite_buffers { infinite_rows(d, a) } else { finite_rows(d, a) });
    if let Some((population, refusal)) = &d.closed {
        // Replicated Simulation is the one other method that takes a closed network, whatever
        // its buffer mode; its row is rebuilt here so the others' sentence does not replace its own.
        rows.retain(|r| r.id != "simulation-inprocess");
        let others: Vec<Row> = match population {
            None => rows.clone(),
            Some(_) => rows.iter().filter(|r| r.id != "analytical").map(|r| Row { suitability: Suitability::Unavailable, summary: CLOSED_OTHERS.to_string(), ..r.clone() }).collect(),
        };
        let n = population.unwrap_or(0);
        let ready = format!("Exact for this closed network of {n} customer{}: Buzen's convolution algorithm, checked against Mean Value Analysis where every station has one server.", if n == 1 { "" } else { "s" });
        rows = vec![row("closed-product-form", "Exact Closed Product Form", "exactQueue", if refusal.is_none() { Suitability::Recommended } else { Suitability::Unavailable }, refusal.clone().unwrap_or(ready))];
        rows.push(replicated_row(d, population.is_some()));
        rows.extend(others);
    }
    if let (None, Some(x)) = (&d.closed, &d.extended) {
        // A network with priorities, batch arrivals or a rate profile (new in 2.1): its exact
        // single-station method where there is one, the simulator, and every other method
        // refused in core's one sentence, since each would answer for a different network.
        rows.retain(|r| r.id != "simulation-inprocess" && r.id != "analytical");
        let others: Vec<Row> = rows.iter().map(|r| Row { suitability: Suitability::Unavailable, summary: x.others.clone(), ..r.clone() }).collect();
        rows = x.exact.iter().map(|e| row(e.id, e.name, "exactQueue", if e.refusal.is_none() { Suitability::Recommended } else { Suitability::Unavailable }, e.refusal.clone().unwrap_or_else(|| e.ready.to_string()))).collect();
        rows.push(replicated_row(d, false));
        rows.extend(others);
    }
    rows.sort_by(|x, y| x.suitability.cmp(&y.suitability).then_with(|| x.name.to_lowercase().cmp(&y.name.to_lowercase())));
    rows
}

/// Solve's method (plan.ts `solveChoice`): the first exact method that can run; otherwise the
/// first simulation; otherwise the best-ranked approximation. The row and which pass chose it.
pub fn solve_choice(rows: &[Row], infinite: bool) -> Option<(&Row, &'static str)> {
    let candidates: Vec<&Row> = rows.iter().filter(|r| r.suitability != Suitability::Unavailable && r.label(infinite).and_then(MethodMetadata::for_run_label).is_some()).collect();
    ["exact", "simulation", "approximation"].into_iter().find_map(|kind| candidates.iter().find(|r| r.kind() == kind).map(|r| (*r, kind)))
}

fn opt(s: &Option<String>) -> Json {
    s.clone().map(Json::String).unwrap_or(Json::Null)
}

fn obj(pairs: Vec<(&str, Json)>) -> Json {
    Json::Object(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// The domain with the app's own keys (src/lib/types.ts `MethodDomain`).
pub fn domain_json(d: &Domain) -> Json {
    let mut pairs = vec![
        ("infiniteBuffers", Json::Bool(d.infinite_buffers)),
        ("stationCount", Json::int(d.station_count as i64)),
        ("classCount", Json::int(d.class_count as i64)),
        ("warningCount", Json::int(d.warning_count as i64)),
        ("hasFeedback", Json::Bool(d.has_feedback)),
        (
            "analytical",
            match &d.analytical {
                Some((exact, title, detail, explanation)) => obj(vec![("exact", Json::Bool(*exact)), ("title", Json::str(title.clone())), ("detail", Json::str(detail.clone())), ("explanation", Json::str(explanation.clone()))]),
                None => Json::Null,
            },
        ),
        ("sourcesArePoisson", Json::Bool(d.sources_are_poisson)),
        ("servicesAreExponential", Json::Bool(d.services_are_exponential)),
        ("classTransitions", Json::Bool(d.class_transitions)),
        ("classIndependentService", Json::Bool(d.class_independent_service)),
        ("heavyJackson", Json::Bool(d.heavy_jackson)),
        ("productFormRefusal", opt(&d.product_form_refusal)),
        ("qbdRefusal", opt(&d.qbd_refusal)),
        ("replicatedSimulationRefusal", opt(&d.replicated_simulation_refusal)),
    ];
    if let Some((population, refusal)) = &d.closed {
        pairs.push(("closed", obj(vec![("population", population.map(Json::int).unwrap_or(Json::Null)), ("refusal", opt(refusal))])));
    }
    if let Some(x) = &d.extended {
        pairs.push((
            "extended",
            obj(vec![
                ("features", Json::Array(x.features.iter().map(|f| Json::str(*f)).collect())),
                ("others", Json::str(x.others.clone())),
                ("exact", Json::Array(x.exact.iter().map(|e| obj(vec![("id", Json::str(e.id)), ("name", Json::str(e.name)), ("ready", Json::str(e.ready)), ("refusal", opt(&e.refusal))])).collect())),
            ]),
        ));
    }
    obj(pairs)
}

/// What `qnet-cli methods` prints under "methods" and "solve".
pub fn rows_json(rows: &[Row], infinite: bool) -> (Json, Json) {
    let list = rows
        .iter()
        .map(|r| {
            let label = r.label(infinite);
            let meta = label.and_then(MethodMetadata::for_run_label);
            obj(vec![
                ("id", Json::str(r.id)),
                ("name", Json::str(r.name.clone())),
                ("label", label.map(Json::str).unwrap_or(Json::Null)),
                ("identifier", meta.as_ref().map(|m| Json::str(m.identifier.clone())).unwrap_or(Json::Null)),
                ("tier", meta.as_ref().map(|m| Json::str(tier(m.fidelity))).unwrap_or(Json::Null)),
                ("fidelity", meta.as_ref().map(|m| Json::str(m.fidelity.raw())).unwrap_or(Json::Null)),
                ("kind", Json::str(r.kind())),
                ("layer", Json::str(r.layer)),
                ("suitability", Json::str(r.suitability.raw())),
                ("applicable", Json::Bool(r.suitability != Suitability::Unavailable)),
                ("reason", Json::str(r.summary.clone())),
            ])
        })
        .collect();
    let solve = match solve_choice(rows, infinite) {
        Some((r, why)) => obj(vec![("label", Json::str(r.label(infinite).unwrap_or_default())), ("name", Json::str(r.name.clone())), ("why", Json::str(why)), ("reason", Json::str(r.summary.clone()))]),
        None => Json::Null,
    };
    (Json::Array(list), solve)
}
