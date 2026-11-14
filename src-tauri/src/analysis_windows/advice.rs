//! What the Method Chooser (Run ▸ Choose a Method…) needs to know, as two separate questions
//! (ledger INV-033, ANA-202…ANA-225; 0.90.34 MethodChooserView.swift `MethodAdvisor`):
//!
//! 1. [`method_domain`]: is the network in each method's domain? Everything `MethodAdvisor`
//!    computed from the editor — the class count, the warnings, feedback and tractability (the same
//!    silent analysis the flag bar shows), whether sources are Poisson and services exponential,
//!    class transitions, class-independent exponential service rates (relative tolerance 1e-10),
//!    the heavy-Jackson test, and the Product Form and QBD exporters' verdicts on the network
//!    (0.90.34 ran `ProductFormExporter.export` / `QBDExporter.export` with the name
//!    "Applicability preview").
//! 2. [`method_availability`]: is each method's solver installed? The Python solver files and the
//!    multiclass executable, through the runner's resolver as 0.90.34's chooser looked them up,
//!    with the reason a lookup failed (`pythonRuntimeReason`).
//!
//! The page combines the two into the chooser's rows, suitabilities and words
//! (src/windows/methodchooser/advice.ts).

use std::collections::BTreeSet;
use std::time::Duration;

use qnet_core::dist::parse_params;
use qnet_core::editor::class_index_of_source;
use qnet_core::export::{product_form, qbd};
use qnet_core::model::{Distribution, Network, NodeKind, ServiceConfig};
use qnet_core::bnet;
use qnet_runner::resolver::{Outcome, PythonRequest, Resolver, SolverLookup};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::analysis::analyse;
use crate::errors::QnError;
use crate::runs::Runs;

/// The name 0.90.34 gave the exporters when it only asked whether they would accept the network.
pub const PREVIEW_NAME: &str = "Applicability preview";

/// The tractability match the "analytical" row is built from, when there is one.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticalMatch {
    pub exact: bool,
    pub title: String,
    pub detail: String,
    pub explanation: String,
}

/// The network's side of the chooser (src/lib/types.ts `MethodDomain`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MethodDomain {
    pub infinite_buffers: bool,
    pub station_count: usize,
    /// max(1, distinct classes over the links' entry and exit classes and the stations' per-class
    /// service keys).
    pub class_count: usize,
    /// The silent analysis's warnings (networkWarningList).
    pub warning_count: usize,
    pub has_feedback: bool,
    pub analytical: Option<AnalyticalMatch>,
    /// Every source is Poisson or Exponential.
    pub sources_are_poisson: bool,
    /// Every station's own law, and every per-class law, is Exponential.
    pub services_are_exponential: bool,
    /// Some link changes the job's class.
    pub class_transitions: bool,
    /// Each station serves every class at one exponential rate (`hasClassIndependentService`).
    pub class_independent_service: bool,
    /// An exact Jackson match whose means sum to more than 20.
    pub heavy_jackson: bool,
    /// The Product Form exporter's refusal, or null when it accepts the network.
    pub product_form_refusal: Option<String>,
    /// The QBD exporter's refusal, or null when it accepts the network.
    pub qbd_refusal: Option<String>,
    /// Why Replicated Simulation (new in 2.1, `qnet_core::simstat::plan`) cannot estimate this
    /// network — finite buffers, no steady state, what the simulator refuses — or null when it can.
    pub replicated_simulation_refusal: Option<String>,
    /// Present when the network is drawn as a closed one (no source, no sink; new in 2.1): its
    /// population, and why `closed.rs` cannot solve it, or null when it can.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<ClosedDomain>,
    /// For a network that uses a model feature new in 2.1 (priorities, batch arrivals, a rate
    /// profile): core's one answer (`extended::methods_domain`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended: Option<ExtendedDomain>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtendedDomain {
    pub features: Vec<&'static str>,
    /// What every method that reads a network the classical way says of it.
    pub others: String,
    pub exact: Vec<ExactMethodDomain>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExactMethodDomain {
    pub id: &'static str,
    pub name: &'static str,
    pub ready: &'static str,
    pub refusal: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClosedDomain {
    pub population: Option<i64>,
    pub refusal: Option<String>,
}

fn service_of(node: &qnet_core::model::Node, class: i64) -> ServiceConfig {
    node.service_by_class.get(&class).cloned().unwrap_or(ServiceConfig { distribution: node.distribution, parameters: node.parameters.clone() })
}

/// `hasClassIndependentService`: every station has one finite positive exponential rate for all
/// the classes the network names (links' entry and exit classes, and each source's class).
pub fn class_independent_service(net: &Network) -> bool {
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
                let config = service_of(station, *c);
                if config.distribution != Distribution::Exponential {
                    return None;
                }
                parse_params(&config.parameters).get("rate").copied()
            })
            .collect();
        let Some(&first) = rates.first() else { return false };
        if rates.len() != classes.len() || !first.is_finite() || first <= 0.0 {
            return false;
        }
        rates.iter().all(|r| r.is_finite() && *r > 0.0 && (r - first).abs() <= 1e-10 * 1f64.max(first.abs().max(r.abs())))
    })
}

/// The network's side of the chooser for `net`.
pub fn domain(net: &Network) -> MethodDomain {
    let stations: Vec<_> = net.nodes.iter().filter(|n| n.kind == NodeKind::Station).collect();
    let mut class_ids: BTreeSet<i64> = net.links.iter().flat_map(|l| [l.class, l.to_class.unwrap_or(l.class)]).collect();
    class_ids.extend(stations.iter().flat_map(|s| s.service_by_class.keys().copied()));
    let a = analyse(net);
    let analytical = a.is_analytically_tractable.then(|| AnalyticalMatch {
        exact: a.tractability_is_exact,
        title: a.tractability_title.clone(),
        detail: a.tractability_detail.clone(),
        explanation: a.tractability_explanation.clone(),
    });
    let means_sum: f64 = a.tractability_means.iter().map(|m| m.0).sum();
    let heavy_jackson = a.tractability_is_exact && a.tractability_means_label.to_lowercase().contains("jackson") && means_sum > 20.0;
    MethodDomain {
        infinite_buffers: net.infinite_buffers,
        station_count: stations.len(),
        class_count: class_ids.len().max(1),
        warning_count: a.warnings.len(),
        has_feedback: a.has_feedback,
        analytical,
        sources_are_poisson: net
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::Source)
            .all(|n| matches!(n.distribution, Distribution::Poisson | Distribution::Exponential)),
        services_are_exponential: stations
            .iter()
            .all(|s| s.distribution == Distribution::Exponential && s.service_by_class.values().all(|c| c.distribution == Distribution::Exponential)),
        class_transitions: net.links.iter().any(|l| l.has_class_transition()),
        class_independent_service: class_independent_service(net),
        heavy_jackson,
        product_form_refusal: product_form::export(net, PREVIEW_NAME, product_form::DEFAULT_MAXIMUM_SERVERS).err().map(|e| e.message()),
        qbd_refusal: qbd::export(net, PREVIEW_NAME, &qbd::QbdOptions::default()).err().map(|e| e.message()),
        replicated_simulation_refusal: qnet_core::simstat::plan(net).err().map(|r| r.message),
        closed: qnet_core::closed::looks_closed(net).then(|| ClosedDomain { population: net.population, refusal: qnet_core::extended::problems(net).into_iter().next().map(|p| p.message).or_else(|| qnet_core::closed::from_network(net).err().map(|e| e.message())) }),
        extended: qnet_core::extended::methods_domain(net).map(|x| ExtendedDomain { features: x.features, others: x.others, exact: x.exact.into_iter().map(|e| ExactMethodDomain { id: e.id, name: e.name, ready: e.ready, refusal: e.refusal }).collect() }),
    }
}

/// Run ▸ Choose a Method…: the network's side of the advice for a tab's document.
#[tauri::command]
pub fn method_domain(document: Value) -> Result<MethodDomain, QnError> {
    let text = serde_json::to_string(&document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the tab's network.").with_detail(e.to_string()))?;
    Ok(domain(&net))
}

/// One runtime the chooser asks about (src/lib/types.ts `RuntimeAvailability`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAvailability {
    /// "productForm", "qbd", "regenerative", "truncatedCtmc", "adaptiveBar", "barBounds",
    /// "multiclass", "genericCtmc", "decomposition".
    pub key: &'static str,
    pub available: bool,
    /// Why not (`pythonRuntimeReason`: the last attempt that was rejected, else the build's declared
    /// reason); null when available, or when nothing more is known (the page then says "the
    /// Python-backed solver support is unavailable in this installation").
    pub reason: Option<String>,
}

enum Lookup {
    /// A Python solver: file, subdirectory, group.
    Python(&'static str, &'static str, &'static str),
    /// A native solver in either group.
    Native(&'static str, &'static str),
}

/// The lookups `MethodAdvisor` made, in its order.
const RUNTIMES: [(&str, Lookup); 9] = [
    ("productForm", Lookup::Python("solver.py", "BNApf", "infinite")),
    ("qbd", Lookup::Python("qbd_solver.py", "BNAqbd", "infinite")),
    ("regenerative", Lookup::Python("regenerative_mc.py", "BNArmc", "infinite")),
    ("truncatedCtmc", Lookup::Python("truncated_ctmc.py", "BNAtc", "infinite")),
    ("adaptiveBar", Lookup::Python("low_rank_bar.py", "BNAalr", "infinite")),
    ("barBounds", Lookup::Python("solver.py", "BNAbb", "infinite")),
    ("multiclass", Lookup::Native("mc_solver", "BNAmd")),
    ("genericCtmc", Lookup::Python("solver.py", "fBNAgc", "finite")),
    ("decomposition", Lookup::Python("fbna_decomp.py", "fBNAdecomp", "finite")),
];

/// `pythonRuntimeReason` without its last fallback sentence.
pub fn lookup_reason(lookup: &SolverLookup) -> Option<String> {
    if let Some(a) = lookup
        .attempts
        .iter()
        .rev()
        .find(|a| matches!(a.outcome, Outcome::RuntimeUnavailable | Outcome::NotReadable | Outcome::LoaderRejected))
    {
        return Some(a.detail.clone());
    }
    lookup.declared_unavailable_reason.clone().filter(|r| !r.is_empty())
}

/// Every runtime the chooser asks about, through `resolver`.
pub fn availability(resolver: &Resolver) -> Vec<RuntimeAvailability> {
    RUNTIMES
        .iter()
        .map(|(key, lookup)| {
            let found = match lookup {
                Lookup::Python(name, dir, group) => resolver.resolve_python_support_file_in(name, dir, &[group], &PythonRequest::default()),
                Lookup::Native(name, dir) => resolver.resolve_executable_in(name, dir, qnet_runner::resolver::DEFAULT_GROUPS, Duration::from_millis(800)),
            };
            let available = found.resolution.is_some();
            RuntimeAvailability { key, available, reason: if available { None } else { lookup_reason(&found) } }
        })
        .collect()
}

/// Run ▸ Choose a Method…: which methods' solvers and Python runtime are installed. The probes can
/// take seconds the first time (they are cached after), so they run off the main thread.
#[tauri::command]
pub async fn method_availability(runs: State<'_, Runs>) -> Result<Vec<RuntimeAvailability>, QnError> {
    let resolver = runs.resolver.clone();
    tauri::async_runtime::spawn_blocking(move || availability(&resolver)).await.map_err(|e| QnError::invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use qnet_runner::resolver::ResolverConfig;

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn example(name: &str) -> Network {
        bnet::read(&std::fs::read_to_string(root().join("examples").join(format!("{name}.bnet"))).unwrap()).unwrap()
    }

    fn golden(name: &str, file: &str) -> Option<String> {
        std::fs::read_to_string(root().join("golden").join(name).join(file)).ok()
    }

    fn examples() -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root().join("examples"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter_map(|f| f.strip_suffix(".bnet").map(str::to_string))
            .collect();
        names.sort();
        names
    }

    /// The chooser's Product Form and QBD verdicts are the exporters' own, as golden for every
    /// example: accepted where 0.90.34 wrote the document, refused with its sentence otherwise.
    /// The command line repeats this file's `domain` (cli/src/methods.rs, for `qnet-cli methods`
    /// and `solve`): both must give the domains of cli/tests/fixtures/methods.json.
    #[test]
    fn the_command_lines_domains_are_this_files() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(root().join("cli/tests/fixtures/methods.json")).unwrap()).unwrap();
        assert!(cases.len() >= 51);
        for c in &cases {
            let name = c["example"].as_str().unwrap();
            assert_eq!(serde_json::to_value(domain(&example(name))).unwrap(), c["domain"], "{name}");
        }
    }

    #[test]
    fn the_exact_rows_verdicts_are_the_exporters_for_every_example() {
        for name in examples() {
            let d = domain(&example(&name));
            for (refusal, file) in [(&d.product_form_refusal, "product-form.json"), (&d.qbd_refusal, "qbd.json")] {
                match golden(&name, &format!("{file}.error.txt")) {
                    Some(sentence) => assert_eq!(refusal.as_deref(), Some(sentence.trim_end_matches('\n')), "{name} {file}"),
                    None => assert!(refusal.is_none() && golden(&name, file).is_some(), "{name} {file}: {refusal:?}"),
                }
            }
        }
    }

    #[test]
    fn the_domain_follows_the_network_and_its_analysis() {
        let j = domain(&example("OpenJackson.d2.feedback.p50.inf"));
        assert!(j.infinite_buffers && j.has_feedback && j.sources_are_poisson && j.services_are_exponential);
        assert_eq!((j.station_count, j.class_count, j.warning_count), (2, 1, 0));
        assert!(j.class_independent_service && !j.class_transitions && !j.heavy_jackson);
        assert!(j.analytical.as_ref().is_some_and(|a| a.exact), "{:?}", j.analytical);

        let t = domain(&example("2dtandem"));
        assert!(!t.infinite_buffers && t.warning_count == 2 && t.analytical.is_none());

        let k = domain(&example("KumarSeidman90.d2.c4.reentrant.inf"));
        assert!(k.class_count > 1 && k.class_transitions && k.has_feedback);
    }

    #[test]
    fn class_independent_service_needs_one_exponential_rate_per_station() {
        let mut net = example("OpenJackson.d2.feedback.p50.inf");
        assert!(class_independent_service(&net));
        let s = net.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap();
        s.service_by_class.insert(0, ServiceConfig { distribution: Distribution::Exponential, parameters: format!("{},", s.parameters) });
        assert!(class_independent_service(&net), "the same rate, written differently");
        let s = net.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap();
        s.service_by_class.insert(0, ServiceConfig { distribution: Distribution::Exponential, parameters: "rate=9.5".into() });
        assert!(class_independent_service(&net), "one class: one rate, whatever it is");
        net.links[0].to_class = Some(1);
        assert!(!class_independent_service(&net), "class 0 at 9.5, class 1 at the station's own rate");
        let s = net.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap();
        s.service_by_class.insert(0, ServiceConfig { distribution: Distribution::Gamma, parameters: "shape=2,rate=2".into() });
        assert!(!class_independent_service(&net), "not exponential");
    }

    fn empty_resolver(dir: &Path) -> Resolver {
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), dir.as_os_str().to_os_string());
        Resolver::new(ResolverConfig { bundle_resources: None, env, current_dir: dir.to_path_buf(), executable_dir: None, development_roots: vec![dir.to_path_buf()] })
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qnet-advice-{tag}-{}", crate::analysis_windows::upper_uuid()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn availability_reports_a_missing_solver() {
        let dir = scratch("missing");
        let all = availability(&empty_resolver(&dir));
        assert_eq!(all.iter().map(|r| r.key).collect::<Vec<_>>(), RUNTIMES.iter().map(|r| r.0).collect::<Vec<_>>());
        assert!(all.iter().all(|r| !r.available), "{all:?}");
        // Nothing was found and nothing was declared: the page says the support is unavailable.
        assert!(all.iter().all(|r| r.reason.is_none()), "{all:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_solver_file_without_a_python_names_the_runtime_problem() {
        let dir = scratch("nopython");
        std::fs::create_dir_all(dir.join("infinite/BNApf")).unwrap();
        std::fs::write(dir.join("infinite/BNApf/solver.py"), "print('x')\n").unwrap();
        let all = availability(&empty_resolver(&dir));
        let pf = all.iter().find(|r| r.key == "productForm").unwrap();
        // The script is found. Without a python3 on this PATH or at a standard location the
        // runtime's diagnostic is the reason; with one (a Mac with Python installed) it is ready.
        if pf.available {
            assert!(pf.reason.is_none());
        } else {
            assert!(pf.reason.as_deref().is_some_and(|r| r.contains("Python")), "{pf:?}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_manifest_that_declares_a_solver_unavailable_gives_its_reason() {
        let dir = scratch("manifest");
        std::fs::write(dir.join(qnet_runner::resolver::MANIFEST_NAME), "unavailable\tnative\tinfinite/BNAmd/mc_solver\tcJSON was not installed when this app was built\n").unwrap();
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), dir.as_os_str().to_os_string());
        env.insert("QNET_SOLVER_ROOT".into(), dir.as_os_str().to_os_string());
        let r = Resolver::new(ResolverConfig { bundle_resources: None, env, current_dir: dir.clone(), executable_dir: None, development_roots: vec![] });
        let mc = availability(&r).into_iter().find(|r| r.key == "multiclass").unwrap();
        assert!(!mc.available);
        assert_eq!(mc.reason.as_deref(), Some("cJSON was not installed when this app was built"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
