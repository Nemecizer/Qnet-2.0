//! The machine interface (new in 2.1; docs/CLI.md): subcommands that print one JSON document,
//! `{"schema": 1, "command": …, "fingerprint": …, …}`, for scripts and for the Python package
//! `qnet` (python/qnet), which is written over them.
//!
//! - `build`: a network from a JSON description (`qnet_core::build`), written as a `.bnet` file.
//! - `describe`: the description of a file, its station model, warnings and parameters.
//! - `methods`: the Method Chooser's rows and Solve's choice (methods.rs).
//! - `live`, `sensitivity`, `capacity`, `uncertainty`, `transient`: the in-process analyses of
//!   `qnet_core` (jackson, closed, sensitivity, optimise, uncertainty, transient). Every number
//!   comes from those modules' functions; this file only reads the options and lays the answer
//!   out, as src-tauri's commands of the same names do for the interface.
//!
//! An analysis that does not cover the network answers `"available": false` with the reason in a
//! sentence and exits 0: that is an answer. A file that cannot be read, or options that make no
//! sense, print a sentence to stderr and exit 1; a usage error exits 2.

use std::collections::BTreeMap;
use std::path::Path;

use qnet_core::jackson::{self, JacksonError, JacksonModel};
use qnet_core::json::{self, Json};
use qnet_core::model::{Network, NodeKind};
use qnet_core::optimise::{self, Constraint, Infeasible, Loads, Problem, Proof, RateInfeasible};
use qnet_core::results::model::{MethodMetadata, NetworkSnapshot, RunRecord};
use qnet_core::sensitivity::{self, Context, Inversion, Measure, ParamSpec, Why};
use qnet_core::transient::{self, Initial, Refusal, Request, Surge};
use qnet_core::uncertainty::{self, Input, Law, Options};
use qnet_core::{bnet, build, closed, existence, naming, scenarios, tractability};
use qnet_runner::resolver::{Resolver, ResolverConfig};

use crate::{load, methods};

pub type Failure = (u8, String);

/// The schema version of every document this file prints. A change that removes or renames a
/// key, or changes a unit or a meaning, raises it; added keys do not.
pub const SCHEMA: i64 = 1;

pub const USAGE: &str = "  qnet-cli build <description.json|-> [out.bnet]
                                             a network from a JSON description (to stdout without [out])
  qnet-cli describe <file.bnet>              the description, station model, warnings and parameters, as JSON
  qnet-cli methods <file.bnet> [--assume-installed]
                                             every method, whether it applies and why, and Solve's choice, as JSON
  qnet-cli solve <file.bnet> [run's options]  run the method Solve would choose (see run)
  qnet-cli live <file.bnet>                  the exact closed form (open Jackson or closed network), as JSON
  qnet-cli sensitivity <file.bnet> [options]  derivatives, elasticities, what it would take
  qnet-cli capacity <file.bnet> <options>    the cheapest servers or service rates that meet targets
  qnet-cli uncertainty <file.bnet> <options>  the answer's distribution when rates are uncertain
  qnet-cli transient <file.bnet> [options]   mean numbers over time, exact and fluid
                                             options: a JSON object, @file, or - for stdin (docs/CLI.md)";

// ── JSON helpers ────────────────────────────────────────────────────────────────────────────

type Obj = BTreeMap<String, Json>;

pub fn obj(pairs: Vec<(&str, Json)>) -> Json {
    Json::Object(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// A number, or null where there is none to give (JSON has no NaN or infinity).
pub fn num(v: f64) -> Json {
    if v.is_finite() {
        Json::num(v)
    } else {
        Json::Null
    }
}

fn onum(v: Option<f64>) -> Json {
    v.map(num).unwrap_or(Json::Null)
}

fn ostr(v: Option<impl Into<String>>) -> Json {
    v.map(|s| Json::String(s.into())).unwrap_or(Json::Null)
}

fn nums(v: &[f64]) -> Json {
    Json::Array(v.iter().map(|x| num(*x)).collect())
}

fn int(v: usize) -> Json {
    Json::int(v as i64)
}

pub fn print(v: &Json) -> String {
    json::to_pretty_unescaped_slashes(v) + "\n"
}

/// The file's network: the variant `--scenario` names, else the one it was saved showing. What
/// the file's scenarios are is remembered for `envelope` (load.rs).
fn read(path: &str) -> Result<Network, Failure> {
    Ok(load::load(path)?.net)
}

/// `list`, after the sentence saying the numbers are a scenario's when the reader did not choose.
fn with_scenario_warning(list: Vec<String>) -> Json {
    Json::Array(load::note().and_then(|n| n.warning()).into_iter().chain(list).map(Json::String).collect())
}

/// What every document starts with.
pub fn envelope(command: &str, net: &Network, file: &str) -> Vec<(&'static str, Json)> {
    let title = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| file.to_string());
    let mut doc = vec![
        ("schema", Json::int(SCHEMA)),
        ("command", Json::str(command)),
        ("qnetVersion", Json::str(env!("CARGO_PKG_VERSION"))),
        ("fingerprint", Json::str(NetworkSnapshot::of(net).fingerprint())),
        ("network", obj(vec![("title", Json::str(title)), ("buffers", Json::str(if net.infinite_buffers { "infinite" } else { "finite" })), ("population", net.population.map(Json::int).unwrap_or(Json::Null))])),
    ];
    // A file with scenarios (new in 2.1, ledger WF-503): which it has, which it was saved showing,
    // and whose values this document's numbers are. A document without a `warnings` list of its
    // own gets one when there is something to say; the others add the sentence to theirs.
    if let Some(note) = load::note() {
        doc.push(("scenario", obj(vec![("active", ostr(note.active.clone())), ("names", Json::Array(note.names.iter().map(|n| Json::str(n.clone())).collect())), ("shown", ostr(note.shown.clone()))])));
        if note.warning().is_some() {
            doc.push(("warnings", with_scenario_warning(Vec::new())));
        }
    }
    doc
}

/// The options argument: a JSON object, `@file`, `-` for stdin, or nothing (an empty object).
fn options(arg: Option<&str>) -> Result<Obj, Failure> {
    let text = match arg {
        None => return Ok(Obj::new()),
        Some("-") => {
            let mut s = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| (1, format!("Couldn't read the options from standard input: {e}.")))?;
            s
        }
        Some(a) if a.starts_with('@') => std::fs::read_to_string(&a[1..]).map_err(|e| (1, format!("Couldn't read {}: {e}.", &a[1..])))?,
        Some(a) => a.to_string(),
    };
    match json::parse(&text) {
        Ok(Json::Object(m)) => Ok(m),
        Ok(_) => Err((1, "The options must be a JSON object ({ … }).".into())),
        Err(e) => Err((1, format!("The options aren't valid JSON: {e}."))),
    }
}

fn bad(message: impl Into<String>) -> Failure {
    (1, message.into())
}

fn get<'a>(m: &'a Obj, key: &str) -> Option<&'a Json> {
    m.get(key).filter(|v| **v != Json::Null)
}

fn get_str<'a>(m: &'a Obj, key: &str) -> Result<Option<&'a str>, Failure> {
    get(m, key).map(|v| v.as_str().ok_or_else(|| bad(format!("“{key}” must be text.")))).transpose()
}

fn get_num(m: &Obj, key: &str) -> Result<Option<f64>, Failure> {
    get(m, key).map(|v| v.as_f64().filter(|x| x.is_finite()).ok_or_else(|| bad(format!("“{key}” must be a number.")))).transpose()
}

fn get_int(m: &Obj, key: &str) -> Result<Option<i64>, Failure> {
    get(m, key).map(|v| v.as_i64().ok_or_else(|| bad(format!("“{key}” must be a whole number.")))).transpose()
}

fn get_bool(m: &Obj, key: &str) -> Result<Option<bool>, Failure> {
    get(m, key).map(|v| v.as_bool().ok_or_else(|| bad(format!("“{key}” must be true or false.")))).transpose()
}

fn get_obj<'a>(m: &'a Obj, key: &str) -> Result<Option<&'a Obj>, Failure> {
    get(m, key).map(|v| v.as_object().ok_or_else(|| bad(format!("“{key}” must be an object ({{ … }}).")))).transpose()
}

fn get_list<'a>(m: &'a Obj, key: &str) -> Result<Option<&'a [Json]>, Failure> {
    get(m, key).map(|v| v.as_array().ok_or_else(|| bad(format!("“{key}” must be a list.")))).transpose()
}

/// A node named by its id or by its name (a name must then belong to one node).
fn node_id(net: &Network, reference: &str, kind: Option<NodeKind>) -> Result<String, Failure> {
    let of_kind = |n: &&qnet_core::model::Node| kind.is_none_or(|k| n.kind == k);
    if let Some(n) = net.nodes.iter().filter(of_kind).find(|n| n.id.eq_ignore_ascii_case(reference)) {
        return Ok(n.id.clone());
    }
    let named: Vec<_> = net.nodes.iter().filter(of_kind).filter(|n| n.name == reference).collect();
    let what = kind.map(|k| k.raw()).unwrap_or("node");
    match named.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => Err(bad(format!("There is no {what} called “{reference}” in this network."))),
        _ => Err(bad(format!("More than one {what} is called “{reference}”; name it by its id."))),
    }
}

fn name_of(net: &Network, id: &str) -> String {
    net.node(id).map(|n| n.name.clone()).unwrap_or_else(|| id.to_string())
}

// ── build, describe, methods ────────────────────────────────────────────────────────────────

fn build_command(source: &str, out: Option<&str>) -> Result<String, Failure> {
    let text = if source == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| (1, format!("Couldn't read the description from standard input: {e}.")))?;
        s
    } else {
        std::fs::read_to_string(source).map_err(|e| (1, format!("Couldn't read {source}: {e}.")))?
    };
    let spec = json::parse(&text).map_err(|e| (1, format!("The description isn't valid JSON: {e}.")))?;
    // "basedOn": the file the description was read from; what the description lacks comes from it.
    // "basedOnScenario": the variant of that file the description was read as (`describe
    // --scenario`); without it, the one the file was saved showing.
    let top = spec.as_object();
    let text_key = |key: &str| top.and_then(|m| get(m, key)).and_then(Json::as_str);
    let base = match text_key("basedOn") {
        Some(path) => Some((path, load::load_as(path, None)?)),
        None => None,
    };
    load::forget_note();
    let drop = match top.and_then(|m| get(m, "scenarios")) {
        None => false,
        Some(v) if v.as_str() == Some("drop") => true,
        Some(v) if v.as_str() == Some("keep") => false,
        Some(_) => return Err(bad("“scenarios” must be \"keep\" or \"drop\".")),
    };
    // The file's scenarios shown as the description was read, so its values are compared with
    // the right variant's.
    let shown = match &base {
        Some((_, loaded)) => match (&loaded.scenarios, text_key("basedOnScenario")) {
            (Some(block), Some(which)) => {
                let (net, block) = scenarios::switch(&loaded.as_saved, block, which).map_err(|m| (1, m))?;
                Some((net, Some(block)))
            }
            (None, Some(which)) if !which.trim().eq_ignore_ascii_case(scenarios::BASELINE) => return Err(bad(format!("“basedOnScenario”: the file has no scenarios, so none is called “{which}”."))),
            (block, _) => Some((loaded.as_saved.clone(), block.clone())),
        },
        None => None,
    };
    let net = build::from_spec(&spec, shown.as_ref().map(|(n, _)| n)).map_err(|m| (1, m))?;
    // The scenarios of the file a description is based on are saved with it (ledger WF-503): a
    // changed value is the shown scenario's (or the baseline's), as an edit in the app is. A
    // network whose nodes or links changed cannot keep them, and is not saved without them unasked.
    let block = match (&shown, drop) {
        (Some((prev, Some(block))), false) => Some(scenarios::reconcile(prev, &net, block).ok_or_else(|| {
            bad(format!(
                "{} holds scenarios, and this network no longer has the same nodes, links and buffers, so the scenarios cannot be kept with it. To save the network without them, set \"scenarios\": \"drop\" in the description (in Python: save(path, scenarios=\"drop\")).",
                base.as_ref().map(|(p, _)| *p).unwrap_or_default()
            ))
        })?),
        _ => None,
    };
    let written = bnet::write_with_scenarios(&net, block.as_ref());
    match out {
        Some(out) => {
            std::fs::write(out, &written).map_err(|e| (1, format!("Couldn't write {out}: {e}.")))?;
            let mut doc = envelope("build", &net, out);
            doc.push(("wrote", Json::str(out)));
            Ok(print(&obj(doc)))
        }
        None => Ok(written),
    }
}

/// The parameters an analysis can be asked about, as `sensitivity` and `uncertainty` name them.
fn parameters(net: &Network) -> Vec<(String, Json)> {
    let mut out = Vec::new();
    let named = |kind: &str, node: &qnet_core::model::Node| (format!("{kind}:{}", node.name), obj(vec![("id", Json::str(format!("{kind}:{}", node.name))), ("kind", Json::str(kind)), ("node", Json::str(node.name.clone())), ("nodeId", Json::str(node.id.clone()))]));
    if net.nodes_of(NodeKind::Source).next().is_some() {
        out.push(("load".to_string(), obj(vec![("id", Json::str("load")), ("kind", Json::str("load"))])));
    }
    for s in naming::in_export_order(net.nodes_of(NodeKind::Source), |n| n.name.as_str()) {
        out.push(named("arrival", s));
    }
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
    for s in &stations {
        out.push(named("service", s));
    }
    for s in &stations {
        out.push(named("servers", s));
    }
    out
}

fn describe(file: &str) -> Result<String, Failure> {
    let net = read(file)?;
    let mut doc = envelope("describe", &net, file);
    doc.push(("spec", build::to_spec(&net)));
    let count = |k: NodeKind| int(net.nodes_of(k).count());
    doc.push(("counts", obj(vec![("sources", count(NodeKind::Source)), ("buffers", count(NodeKind::Buffer)), ("stations", count(NodeKind::Station)), ("sinks", count(NodeKind::Sink)), ("links", int(net.links.len()))])));
    let drawn = closed::drawn_as(&net);
    doc.push(("drawnAs", Json::str(drawn.reason().unwrap_or("open"))));
    doc.push(("parameters", Json::Array(parameters(&net).into_iter().map(|(_, v)| v).collect())));
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
    // New in 2.1: the model features in use (priorities, batch arrivals, rate profiles) and what
    // is wrong with their settings. With them the station model is at the sources' long-run
    // customer rates (batch rate × mean batch size × the profile's average), and no closed form
    // of first-come-first-served networks is claimed.
    let features = qnet_core::extended::features(&net);
    doc.push(("features", Json::Array(features.iter().map(|(f, names)| obj(vec![("feature", Json::str(f.raw())), ("nodes", Json::Array(names.iter().map(|n| Json::str(n.clone())).collect()))])).collect())));
    doc.push(("featureProblems", Json::Array(qnet_core::extended::problems(&net).into_iter().map(|p| Json::str(p.message)).collect())));
    match qnet_core::extended::traffic(&net, net.infinite_buffers, false, false) {
        Ok(data) => {
            doc.push(("modelError", Json::Null));
            doc.push(("classes", int(data.k)));
            let rows = (0..data.d)
                .map(|i| {
                    obj(vec![
                        ("id", ostr(stations.get(i).map(|s| s.id.clone()))),
                        ("name", ostr(stations.get(i).map(|s| s.name.clone()))),
                        ("servers", Json::int(data.servers[i])),
                        ("throughput", num(data.alpha[i])),
                        ("serviceRate", num(data.service_rates[i])),
                        ("capacity", num(data.capacity[i])),
                        ("utilisation", num(data.rho(i))),
                        ("throughputByClass", Json::Array((0..data.k).map(|k| num(data.alpha_per_class[k][i])).collect())),
                    ])
                })
                .collect();
            doc.push(("stations", Json::Array(rows)));
            doc.push(("externalArrivals", nums(&data.class_external_arrivals)));
            doc.push(("routing", Json::Array(data.aggregated_p.iter().map(|r| nums(r)).collect())));
            doc.push(("routingCycles", Json::Bool(tractability::has_routing_cycles(&data.aggregated_p))));
            doc.push(("warnings", with_scenario_warning(methods::warnings(&net).unwrap_or_default())));
            if features.is_empty() {
                let t = tractability::assess(&data, &net.nodes, net.infinite_buffers, true);
                doc.push(("closedForm", obj(vec![("kind", Json::str(t.kind.case_name())), ("exact", Json::Bool(t.is_exact())), ("title", Json::str(t.title)), ("detail", Json::str(t.detail)), ("means", nums(&t.means)), ("meansLabel", Json::str(t.means_label))])));
            } else {
                doc.push(("closedForm", Json::Null));
            }
            doc.push((
                "srbm",
                // The diffusion model is of a first-come-first-served network with plain sources.
                match existence::srbm_existence(&data, net.infinite_buffers).filter(|_| features.is_empty()) {
                    Some(v) => obj(vec![("existence", Json::str(v.existence.outcome.raw())), ("statement", Json::str(v.existence.statement.clone())), ("recurrence", ostr(v.recurrence.as_ref().map(|r| r.outcome.raw()))), ("recurrenceStatement", ostr(v.recurrence.as_ref().map(|r| r.statement.clone())))]),
                    None => Json::Null,
                },
            ));
        }
        Err(e) => {
            // A closed network has no arrivals for the traffic equations: say that, by core's one rule.
            let sentence = closed::open_only(&net, "The open-network station model (arrival rates from the traffic equations)").map(|(_, s)| s).unwrap_or_else(|| e.message());
            doc.push(("modelError", Json::str(sentence)));
            doc.push(("stations", Json::Array(Vec::new())));
            doc.push(("warnings", with_scenario_warning(Vec::new())));
        }
    }
    doc.push(("units", obj(vec![("throughput", Json::str("customers / time")), ("serviceRate", Json::str("customers / time")), ("capacity", Json::str("customers / time")), ("utilisation", Json::str("ratio"))])));
    Ok(print(&obj(doc)))
}

/// `methods`: the rows for `net`, with the solvers this installation has (or all of them).
pub fn method_rows(net: &Network, assume_installed: bool) -> (methods::Domain, Vec<methods::Row>) {
    let d = methods::domain(net);
    let a = if assume_installed { methods::all_installed() } else { methods::installed(&Resolver::new(ResolverConfig::from_process())) };
    let rows = methods::rows(&d, &a);
    (d, rows)
}

fn methods_command(file: &str, assume_installed: bool) -> Result<String, Failure> {
    let net = read(file)?;
    let (d, rows) = method_rows(&net, assume_installed);
    let (list, solve) = methods::rows_json(&rows, net.infinite_buffers);
    let mut doc = envelope("methods", &net, file);
    doc.push(("assumedInstalled", Json::Bool(assume_installed)));
    doc.push(("domain", methods::domain_json(&d)));
    doc.push(("methods", list));
    doc.push(("solve", solve));
    Ok(print(&obj(doc)))
}

/// The run label Solve would choose for a file, or the sentence saying there is none.
pub fn solve_label(file: &str) -> Result<&'static str, Failure> {
    let net = read(file)?;
    let (_, rows) = method_rows(&net, false);
    methods::solve_choice(&rows, net.infinite_buffers).and_then(|(r, _)| r.label(net.infinite_buffers)).ok_or_else(|| bad("No method can be run on this network as it is. `qnet-cli methods` says why for each one."))
}

// ── live ────────────────────────────────────────────────────────────────────────────────────

const LIVE_UNITS: [(&str, &str); 7] = [("throughput", "customers / time"), ("serviceRate", "customers / time"), ("utilisation", "ratio"), ("meanInSystem", "customers"), ("meanWaiting", "customers"), ("meanSojourn", "time"), ("meanWait", "time")];

fn units(pairs: &[(&str, &str)]) -> Json {
    Json::Object(pairs.iter().map(|(k, v)| (k.to_string(), Json::str(*v))).collect())
}

#[allow(clippy::too_many_arguments)]
fn live_station(id: &str, name: &str, servers: i64, throughput: f64, rate: f64, rho: Option<f64>, number: Option<f64>, queue: Option<f64>, sojourn: Option<f64>, wait: Option<f64>) -> Json {
    obj(vec![
        ("id", Json::str(id)),
        ("name", Json::str(name)),
        ("servers", Json::int(servers)),
        ("throughput", num(throughput)),
        ("serviceRate", num(rate)),
        ("utilisation", onum(rho)),
        ("meanInSystem", onum(number)),
        ("meanWaiting", onum(queue)),
        ("meanSojourn", onum(sojourn)),
        ("meanWait", onum(wait)),
    ])
}

fn live(file: &str) -> Result<String, Failure> {
    let net = read(file)?;
    let mut doc = envelope("live", &net, file);
    doc.push(("units", units(&LIVE_UNITS)));
    if closed::drawn_as(&net) != closed::Drawn::Open {
        // A closed network: Buzen's convolution, checked against MVA (`closed::means`).
        match closed::from_network(&net).and_then(|m| closed::means(&m).map(|s| (m, s))) {
            Ok((m, s)) => {
                doc.push(("tier", Json::str("exact")));
                doc.push(("method", Json::str("Closed product form (Gordon–Newell): Buzen's convolution algorithm, Mean Value Analysis")));
                doc.push(("reason", Json::Null));
                doc.push(("reasonDetail", Json::str("")));
                doc.push(("utilisationExact", Json::Bool(true)));
                let stations = (0..m.ids.len()).map(|i| live_station(&m.ids[i], &m.names[i], m.servers[i], s.station_throughput[i], m.mu[i], s.utilisation[i], Some(s.number[i]), Some(s.queue[i]), Some(s.residence[i]), Some(s.queue[i] / s.station_throughput[i]))).collect();
                doc.push(("stations", Json::Array(stations)));
                doc.push(("totals", obj(vec![("throughput", num(s.throughput)), ("meanNumber", num(m.population as f64)), ("meanDelay", num(s.cycle_time(m.population)))])));
                doc.push(("bottlenecks", Json::Array(s.bottleneck().into_iter().map(|i| Json::str(m.names[i].clone())).collect())));
                doc.push(("closed", obj(vec![("population", int(m.population)), ("referenceStation", Json::str(m.names[0].clone()))])));
            }
            Err(e) => {
                doc.push(("tier", Json::str("none")));
                doc.push(("method", Json::Null));
                doc.push(("reason", Json::str(if e == closed::ClosedError::PopulationMissing { "closedNoPopulation" } else { "closed" })));
                doc.push(("reasonDetail", Json::str(e.message())));
                doc.push(("utilisationExact", Json::Bool(false)));
                doc.push(("stations", Json::Array(Vec::new())));
                doc.push(("totals", Json::Null));
                doc.push(("bottlenecks", Json::Array(Vec::new())));
            }
        }
        return Ok(print(&obj(doc)));
    }
    let r = jackson::live(&net);
    doc.push(("tier", Json::str(r.tier.raw())));
    let method = if r.tier != jackson::Tier::Exact {
        Json::Null
    } else if qnet_core::extended::uses(&net, qnet_core::extended::Feature::Priorities) {
        Json::str("Single station with priority service: exact mean values (Cobham's formula and its relatives)")
    } else if qnet_core::extended::uses(&net, qnet_core::extended::Feature::BatchArrivals) {
        Json::str("Single-server station with batch Poisson arrivals: exact mean values (M^X/G/1)")
    } else {
        Json::str("Open Jackson network: traffic equations, an M/M/c queue at each station")
    };
    doc.push(("method", method));
    doc.push(("reason", ostr(r.reason.map(|x| x.raw()))));
    doc.push(("reasonDetail", Json::str(r.detail.clone())));
    doc.push(("utilisationExact", Json::Bool(r.utilisation_exact)));
    doc.push(("stations", Json::Array(r.stations.iter().map(|s| live_station(&s.id, &s.name, s.servers, s.throughput, s.service_rate, s.utilisation, s.mean_in_system, s.mean_waiting, s.mean_sojourn, s.mean_wait)).collect())));
    doc.push(("totals", r.network.as_ref().map(|n| obj(vec![("throughput", num(n.throughput)), ("meanNumber", num(n.mean_number)), ("meanDelay", num(n.mean_delay))])).unwrap_or(Json::Null)));
    doc.push(("bottlenecks", Json::Array(r.bottlenecks.iter().map(|id| Json::str(name_of(&net, id))).collect())));
    Ok(print(&obj(doc)))
}

// ── sensitivity ─────────────────────────────────────────────────────────────────────────────

/// Why the closed forms of an open Jackson network do not cover `net`: the reason code and sentence.
fn jackson_context(net: &Network, subject: &str) -> Result<Context, (&'static str, String)> {
    // A closed network, or one with priorities, batch arrivals or a rate profile (core's two rules).
    if let Some(refusal) = qnet_core::extended::classical_only(net, subject) {
        return Err(refusal);
    }
    Context::new(net).map_err(|e| {
        let reason = match e {
            JacksonError::Network(_) => "network",
            JacksonError::Unstable(..) => "unstable",
            JacksonError::NotJackson => "notJackson",
        };
        (reason, e.message())
    })
}

fn unavailable(mut doc: Vec<(&'static str, Json)>, reason: &str, sentence: String) -> String {
    doc.push(("available", Json::Bool(false)));
    doc.push(("reason", Json::str(reason)));
    doc.push(("sentence", Json::str(sentence)));
    print(&obj(doc))
}

/// `{"kind": "networkSojourn"}` or `{"kind": "stationNumber", "station": "S1"}`; a bare string is the kind.
fn measure_of(net: &Network, ctx: &Context, v: Option<&Json>) -> Result<(Measure, Json), Failure> {
    let (kind, station) = match v {
        None => ("networkSojourn".to_string(), None),
        Some(Json::String(s)) => (s.clone(), None),
        Some(Json::Object(m)) => (get_str(m, "kind")?.unwrap_or("networkSojourn").to_string(), get_str(m, "station")?.map(str::to_string)),
        Some(_) => return Err(bad("“measure” must be a name or an object.")),
    };
    let index = || -> Result<usize, Failure> {
        let reference = station.as_deref().ok_or_else(|| bad(format!("The measure “{kind}” belongs to a station: name it with \"station\".")))?;
        let id = node_id(net, reference, Some(NodeKind::Station))?;
        ctx.station(&id).ok_or_else(|| bad(format!("The station “{reference}” is not part of the model.")))
    };
    let measure = match kind.as_str() {
        "networkNumber" => Measure::NetworkNumber,
        "networkSojourn" => Measure::NetworkSojourn,
        "stationNumber" => Measure::StationNumber(index()?),
        "stationQueue" => Measure::StationQueue(index()?),
        "stationSojourn" => Measure::StationSojourn(index()?),
        "stationUtilisation" => Measure::StationUtilisation(index()?),
        "stationThroughput" => Measure::StationThroughput(index()?),
        other => return Err(bad(format!("There's no measure called “{other}”. The measures are networkNumber, networkSojourn, stationNumber, stationQueue, stationSojourn, stationUtilisation and stationThroughput."))),
    };
    let said = obj(vec![("kind", Json::str(kind)), ("station", ostr(station)), ("unit", Json::str(measure.unit()))]);
    Ok((measure, said))
}

/// A parameter request: its id and what core calls it (or the sentence saying why it has none).
fn spec_of(net: &Network, m: &Obj) -> Result<(String, Result<ParamSpec, String>), Failure> {
    let kind = get_str(m, "kind")?.ok_or_else(|| bad("A parameter needs a “kind”: load, arrival, service, servers or routing."))?;
    let node = |want: NodeKind| -> Result<(String, String), Failure> {
        let reference = get_str(m, "node")?.ok_or_else(|| bad(format!("The {kind} parameter names no node.")))?;
        let id = node_id(net, reference, Some(want))?;
        Ok((name_of(net, &id), id))
    };
    let (default_id, spec) = match kind {
        "load" => ("load".to_string(), Ok(ParamSpec::Load)),
        "arrival" => {
            let (name, node_id) = node(NodeKind::Source)?;
            (format!("arrival:{name}"), Ok(ParamSpec::Arrival { node_id }))
        }
        "service" => {
            let (name, node_id) = node(NodeKind::Station)?;
            (format!("service:{name}"), Ok(ParamSpec::Service { node_id, class: get_int(m, "class")? }))
        }
        "servers" => {
            let (name, node_id) = node(NodeKind::Station)?;
            (format!("servers:{name}"), Ok(ParamSpec::Servers { node_id }))
        }
        "routing" => match (get_str(m, "link")?, get_str(m, "complement")?) {
            (Some(l), Some(c)) => (format!("routing:{l}"), Ok(ParamSpec::Routing { link_id: l.to_ascii_uppercase(), complement_id: c.to_ascii_uppercase() })),
            _ => return Err(bad("A routing parameter names two links leaving the same node, by id: “link” and “complement”.")),
        },
        "buffer" => ("buffer".to_string(), Err("A buffer's size has no effect while buffers are infinite.".to_string())),
        other => return Err(bad(format!("There's no parameter kind called “{other}”. The kinds are load, arrival, service, servers and routing."))),
    };
    Ok((get_str(m, "id")?.map(str::to_string).unwrap_or(default_id), spec))
}

fn sensitivity_command(file: &str, o: &Obj) -> Result<String, Failure> {
    let net = read(file)?;
    let mut doc = envelope("sensitivity", &net, file);
    let ctx = match jackson_context(&net, "Sensitivity analysis") {
        Ok(c) => c,
        Err((reason, sentence)) => return Ok(unavailable(doc, reason, sentence)),
    };
    let (measure, said) = measure_of(&net, &ctx, get(o, "measure"))?;
    let value = measure.value(&ctx.solution);
    let target = get_num(o, "targetChange")?.filter(|c| *c != 0.0).map(|c| value * (1.0 + c));
    let asked: Vec<Json> = match get_list(o, "parameters")? {
        Some(list) => list.to_vec(),
        None => parameters(&net).into_iter().map(|(_, v)| v).collect(),
    };
    let mut rows = Vec::new();
    for p in &asked {
        let m = p.as_object().ok_or_else(|| bad("Each parameter must be an object ({ … })."))?;
        let (id, spec) = spec_of(&net, m)?;
        let family = match spec.and_then(|spec| ctx.family(&net, &spec)) {
            Ok(f) => f,
            Err(note) => {
                rows.push(obj(vec![("id", Json::str(id)), ("kind", m.get("kind").cloned().unwrap_or(Json::Null)), ("note", Json::str(note))]));
                continue;
            }
        };
        let s = sensitivity::sensitivity(&ctx.model, &ctx.solution, measure, &family);
        let inversion = target.map(|t| match sensitivity::invert(&ctx.model, measure, &family, t) {
            Inversion::Achieved { value, measure } => obj(vec![("achieved", Json::Bool(true)), ("value", num(value)), ("measure", num(measure))]),
            Inversion::Infeasible { why, limit_value, limit_measure } => obj(vec![
                ("achieved", Json::Bool(false)),
                (
                    "why",
                    Json::str(match why {
                        Why::NoEffect => "noEffect",
                        Why::RangeEnds => "rangeEnds",
                        Why::Levels => "levels",
                        Why::Overload => "overload",
                    }),
                ),
                ("limitValue", onum(limit_value)),
                ("limitMeasure", onum(limit_measure)),
            ]),
        });
        rows.push(obj(vec![
            ("id", Json::str(id)),
            ("kind", m.get("kind").cloned().unwrap_or(Json::Null)),
            ("node", m.get("node").cloned().unwrap_or(Json::Null)),
            ("current", num(family.current)),
            ("integer", Json::Bool(family.integer)),
            ("derivative", onum(s.derivative)),
            ("elasticity", onum(s.elasticity)),
            ("oneMore", onum(s.one_more)),
            ("whatItTakes", inversion.unwrap_or(Json::Null)),
            ("note", Json::Null),
        ]));
    }
    let rho: Vec<Option<f64>> = ctx.solution.rho.iter().map(|r| Some(*r)).collect();
    doc.push(("available", Json::Bool(true)));
    doc.push(("tier", Json::str("exact")));
    doc.push(("method", Json::str("Open Jackson network: derivatives of the closed form")));
    doc.push(("measure", said));
    doc.push(("value", num(value)));
    doc.push(("unit", Json::str(measure.unit())));
    doc.push(("target", onum(target)));
    doc.push(("stations", Json::Array((0..ctx.model.ids.len()).map(|i| obj(vec![("id", Json::str(ctx.model.ids[i].clone())), ("name", Json::str(ctx.model.names[i].clone())), ("utilisation", num(ctx.solution.rho[i]))])).collect())));
    doc.push(("bottlenecks", Json::Array(jackson::most_loaded(&rho).into_iter().map(|i| Json::str(ctx.model.names[i].clone())).collect())));
    doc.push(("parameters", Json::Array(rows)));
    Ok(print(&obj(doc)))
}

// ── capacity ────────────────────────────────────────────────────────────────────────────────

fn capacity_command(file: &str, o: &Obj) -> Result<String, Failure> {
    let net = read(file)?;
    let mut doc = envelope("capacity", &net, file);
    if let Some((reason, sentence)) = qnet_core::extended::classical_only(&net, "Capacity planning") {
        return Ok(unavailable(doc, reason, sentence));
    }
    let model: JacksonModel = match optimise::planning_model(&net) {
        Ok(m) => m,
        Err(e) => {
            let reason = match e {
                JacksonError::Network(_) => "network",
                JacksonError::Unstable(..) => "noTraffic",
                JacksonError::NotJackson => "notJackson",
            };
            return Ok(unavailable(doc, reason, e.message()));
        }
    };
    let loads = match Loads::new(&model) {
        Ok(l) => l,
        Err(e) => return Ok(unavailable(doc, "noTraffic", e.message())),
    };
    let d = model.mu.len();
    let station = |reference: &str| -> Result<usize, Failure> {
        let id = node_id(&net, reference, Some(NodeKind::Station))?;
        model.ids.iter().position(|x| *x == id).ok_or_else(|| bad(format!("The station “{reference}” is not part of the model.")))
    };
    let rates = match get_str(o, "decision")? {
        None | Some("servers") => false,
        Some("rates") => true,
        Some(other) => return Err(bad(format!("“decision” must be \"servers\" or \"rates\", not “{other}”."))),
    };
    // The targets.
    let mut constraints = Vec::new();
    let mut asked = Vec::new();
    for c in get_list(o, "constraints")?.unwrap_or(&[]) {
        let m = c.as_object().ok_or_else(|| bad("Each target must be an object ({ … })."))?;
        let kind = get_str(m, "kind")?.ok_or_else(|| bad("A target needs a “kind”: networkSojourn, networkNumber, utilisation or stationWait."))?;
        let target = get_num(m, "target")?.ok_or_else(|| bad(format!("The target “{kind}” has no “target” value.")))?;
        let station_name = get_str(m, "station")?;
        constraints.push(match kind {
            "networkSojourn" => Constraint::NetworkSojourn(target),
            "networkNumber" => Constraint::NetworkNumber(target),
            "utilisation" => Constraint::Utilisation(target),
            "stationWait" => Constraint::StationWait(station(station_name.ok_or_else(|| bad("A stationWait target names its station with \"station\"."))?)?, target),
            other => return Err(bad(format!("There's no target called “{other}”. The targets are networkSojourn, networkNumber, utilisation and stationWait."))),
        });
        asked.push((kind.to_string(), station_name.map(str::to_string), target));
    }
    if constraints.is_empty() {
        return Err(bad("Capacity planning needs at least one target in “constraints”, for example {\"kind\": \"networkSojourn\", \"target\": 4}."));
    }
    // What may change at each station, and what it costs. A station not named is free, at cost 1.
    let mut free = vec![true; d];
    let mut unit_cost = vec![1.0; d];
    let mut lower = vec![1i64; d];
    let mut upper: Vec<Option<i64>> = vec![None; d];
    for s in get_list(o, "stations")?.unwrap_or(&[]) {
        let m = s.as_object().ok_or_else(|| bad("Each entry of “stations” must be an object ({ … })."))?;
        let i = station(get_str(m, "station")?.ok_or_else(|| bad("Each entry of “stations” names its station with \"station\"."))?)?;
        free[i] = get_bool(m, "free")?.unwrap_or(true);
        unit_cost[i] = if rates { get_num(m, "rateCost")? } else { get_num(m, "cost")? }.unwrap_or(1.0);
        lower[i] = get_int(m, "lower")?.unwrap_or(1);
        upper[i] = get_int(m, "upper")?;
    }
    let now: Vec<i64> = model.servers.iter().map(|c| (*c).max(1)).collect();
    let solved_now = jackson::solve(&model).ok();
    let infeasible = |why: &str, constraint: Option<usize>, at: Option<usize>, value: Option<f64>| obj(vec![("why", Json::str(why)), ("constraint", constraint.map(int).unwrap_or(Json::Null)), ("station", ostr(at.map(|i| model.names[i].clone()))), ("value", onum(value))]);

    let mut servers = now.clone();
    let mut mu = model.mu.clone();
    let mut refusal = Json::Null;
    let mut proof = Json::Null;
    let mut cost = None;
    let mut cost_now;
    let mut path = Vec::new();
    let mut search = obj(vec![("searched", Json::Bool(false)), ("nodes", Json::int(0)), ("limit", Json::int(optimise::SEARCH_NODE_LIMIT as i64)), ("improved", Json::Bool(false))]);
    let point = |cost: f64, number: f64, added: Option<usize>, feasible: bool| obj(vec![("cost", num(cost)), ("meanNumber", num(number)), ("meanDelay", num(number / loads.total_arrivals)), ("added", ostr(added.map(|i| model.names[i].clone()))), ("feasible", Json::Bool(feasible))]);
    let mut planned = false;
    if rates {
        // The square-root rule bounds the network's mean number: the tightest network target.
        let number = constraints
            .iter()
            .filter_map(|c| match c {
                Constraint::NetworkNumber(n) => Some(*n),
                Constraint::NetworkSojourn(t) => Some(t * loads.total_arrivals),
                _ => None,
            })
            .fold(f64::INFINITY, f64::min);
        cost_now = (0..d).filter(|i| free[*i]).map(|i| unit_cost[i] * model.mu[i]).sum();
        if let Some(k) = constraints.iter().position(|c| matches!(c, Constraint::Utilisation(_) | Constraint::StationWait(..))) {
            refusal = infeasible("ratesTarget", Some(k), None, None);
        } else {
            match optimise::plan_rates(&model, number, &unit_cost, &free) {
                Ok(p) => {
                    planned = true;
                    proof = Json::str("closedForm");
                    cost = Some(p.cost);
                    cost_now = p.cost_now;
                    mu = p.mu;
                }
                Err(e) => {
                    let unit = |v: f64| if constraints.iter().all(|c| matches!(c, Constraint::NetworkSojourn(_))) { v / loads.total_arrivals } else { v };
                    refusal = match e {
                        RateInfeasible::BadTarget => infeasible("badTarget", Some(0), None, None),
                        RateInfeasible::BadStation(i) => infeasible("badStation", None, Some(i), None),
                        RateInfeasible::SeveralServers(i) => infeasible("severalServers", None, Some(i), None),
                        RateInfeasible::FixedOverloaded(i) => infeasible("fixedOverloaded", None, Some(i), None),
                        RateInfeasible::NothingFree => infeasible("nothingFree", None, None, None),
                        RateInfeasible::FixedTooFull { fixed } => infeasible("fixedTooFull", None, None, Some(unit(fixed))),
                    };
                }
            }
        }
    } else {
        let problem = Problem { model: model.clone(), constraints: constraints.clone(), cost: unit_cost.clone(), free: free.clone(), lower, upper };
        cost_now = now.iter().zip(&unit_cost).map(|(c, k)| *c as f64 * k).sum();
        match optimise::plan(&problem) {
            Ok(p) => {
                planned = true;
                proof = Json::str(match p.proof {
                    Proof::Marginal => "marginal",
                    Proof::Search => "search",
                    Proof::None => "none",
                });
                cost = Some(p.cost);
                search = obj(vec![("searched", Json::Bool(p.searched)), ("nodes", Json::int(p.search_nodes as i64)), ("limit", Json::int(optimise::SEARCH_NODE_LIMIT as i64)), ("improved", Json::Bool(p.improved))]);
                path = p.path.iter().map(|x| point(x.cost, x.number, x.added, x.feasible)).collect();
                servers = p.servers;
            }
            Err(e) => {
                refusal = match e {
                    Infeasible::BadTarget(k) => infeasible("badTarget", Some(k), None, None),
                    Infeasible::BadStation(i) => infeasible("badStation", None, Some(i), None),
                    Infeasible::FixedOverloaded(i) => infeasible("fixedOverloaded", None, Some(i), None),
                    Infeasible::LimitOverloaded(i) => infeasible("limitOverloaded", None, Some(i), Some(loads.minimal_stable(i) as f64)),
                    Infeasible::StationLimit { constraint, station, best } => infeasible("stationLimit", Some(constraint), Some(station), Some(best)),
                    Infeasible::Floor { constraint, floor, service_only } => infeasible(if service_only { "serviceFloor" } else { "floor" }, Some(constraint), None, Some(floor)),
                    Infeasible::TooMany => infeasible("tooMany", None, None, None),
                };
            }
        }
    }
    // The proposal, solved again by the closed form every other view uses.
    let mut proposed = model.clone();
    proposed.servers = servers.clone();
    proposed.mu = mu.clone();
    let solved = if planned { jackson::solve(&proposed).ok() } else { None };
    let proposed_loads = Loads::new(&proposed).ok();
    doc.push(("available", Json::Bool(true)));
    doc.push(("tier", Json::str("exact")));
    doc.push(("method", Json::str(if rates { "Open Jackson network: Kleinrock's square-root rule" } else { "Open Jackson network: marginal allocation, certified by an exact search" })));
    doc.push(("decision", Json::str(if rates { "rates" } else { "servers" })));
    doc.push(("feasible", Json::Bool(planned)));
    doc.push(("infeasible", refusal));
    doc.push(("proof", proof));
    doc.push(("search", search));
    doc.push(("costNow", num(cost_now)));
    doc.push(("cost", onum(cost)));
    doc.push(("path", Json::Array(path)));
    doc.push(("meanDelayNow", onum(solved_now.as_ref().map(|s| s.network_sojourn()))));
    doc.push(("meanDelay", onum(solved.as_ref().map(|s| s.network_sojourn()))));
    doc.push(("meanNumberNow", onum(solved_now.as_ref().map(|s| s.network_number()))));
    doc.push(("meanNumber", onum(solved.as_ref().map(|s| s.network_number()))));
    doc.push(("delayFloor", num(loads.a.iter().sum::<f64>() / loads.total_arrivals)));
    doc.push(("totalArrivals", num(loads.total_arrivals)));
    doc.push((
        "constraints",
        Json::Array(
            asked
                .iter()
                .zip(&constraints)
                .map(|((kind, station, target), c)| {
                    obj(vec![
                        ("kind", Json::str(kind.clone())),
                        ("station", ostr(station.clone())),
                        ("target", num(*target)),
                        ("unit", Json::str(c.unit())),
                        ("now", onum(solved_now.as_ref().map(|_| loads.value(*c, &now)))),
                        ("proposed", onum(solved.as_ref().and(proposed_loads.as_ref()).map(|l| l.value(*c, &servers)))),
                    ])
                })
                .collect(),
        ),
    ));
    doc.push((
        "stations",
        Json::Array(
            (0..d)
                .map(|i| {
                    let (amount_now, amount) = if rates { (model.mu[i], mu[i]) } else { (now[i] as f64, servers[i] as f64) };
                    let rho_now = loads.utilisation(i, now[i]);
                    obj(vec![
                        ("id", Json::str(model.ids[i].clone())),
                        ("name", Json::str(model.names[i].clone())),
                        ("free", Json::Bool(free[i])),
                        ("load", num(loads.a[i])),
                        ("serversNow", Json::int(now[i])),
                        ("servers", Json::int(servers[i])),
                        ("rateNow", num(model.mu[i])),
                        ("rate", num(mu[i])),
                        ("unitCost", num(unit_cost[i])),
                        ("costNow", num(unit_cost[i] * amount_now)),
                        ("cost", num(unit_cost[i] * amount)),
                        ("utilisationNow", onum((rho_now < 1.0).then_some(rho_now))),
                        ("utilisation", num(loads.alpha[i] / (mu[i] * servers[i] as f64))),
                    ])
                })
                .collect(),
        ),
    ));
    doc.push(("units", units(&[("meanDelay", "time"), ("meanNumber", "customers"), ("load", "customers"), ("rate", "customers / time"), ("utilisation", "ratio"), ("delayFloor", "time"), ("totalArrivals", "customers / time")])));
    Ok(print(&obj(doc)))
}

// ── uncertainty ─────────────────────────────────────────────────────────────────────────────

pub const DEFAULT_SAMPLES: usize = 20_000;
pub const MIN_SAMPLES: usize = 1_000;
pub const MAX_SAMPLES: usize = 200_000;
pub const DEFAULT_SEED: u64 = 2_021;

fn law_of(spread: &Obj, current: f64) -> Result<Law, Failure> {
    let fraction = || get_num(spread, "value")?.ok_or_else(|| bad("The uncertainty has no size (“value”)."));
    let ends = || match (get_num(spread, "low")?, get_num(spread, "high")?) {
        (Some(a), Some(b)) => Ok((a, b)),
        _ => Err(bad("The interval needs both of its ends (“low” and “high”).")),
    };
    let law = match get_str(spread, "kind")?.unwrap_or("relativeSd") {
        "relativeSd" => Law::relative_sd(current, fraction()?),
        "relativeRange" => Law::relative_range(current, fraction()?),
        "interval95" => {
            let (a, b) = ends()?;
            Law::interval95(a, b)
        }
        "intervalRange" => {
            let (a, b) = ends()?;
            Law::interval_range(a, b)
        }
        other => Err(format!("There's no kind of uncertainty called “{other}”. The kinds are relativeSd, relativeRange, interval95 and intervalRange.")),
    };
    law.map_err(bad)
}

fn stat(s: uncertainty::Stat) -> Json {
    obj(vec![("value", num(s.value)), ("standardError", num(s.se))])
}

fn uncertainty_command(file: &str, o: &Obj) -> Result<String, Failure> {
    let net = read(file)?;
    let mut doc = envelope("uncertainty", &net, file);
    let ctx = match jackson_context(&net, "Uncertainty analysis") {
        Ok(c) => c,
        Err((reason, sentence)) => return Ok(unavailable(doc, reason, sentence)),
    };
    let (measure, said) = measure_of(&net, &ctx, get(o, "measure"))?;
    let value = measure.value(&ctx.solution);
    let (mut inputs, mut ids, mut is_arrival) = (Vec::new(), Vec::new(), Vec::new());
    for r in get_list(o, "inputs")?.unwrap_or(&[]) {
        let m = r.as_object().ok_or_else(|| bad("Each input must be an object ({ … })."))?;
        let (id, spec) = spec_of(&net, m)?;
        let spec = spec.map_err(bad)?;
        if !matches!(spec, ParamSpec::Arrival { .. } | ParamSpec::Service { .. }) {
            return Err(bad("Only arrival rates and service rates can be given an uncertainty."));
        }
        let family = ctx.family(&net, &spec).map_err(bad)?;
        let spread = get_obj(m, "spread")?.ok_or_else(|| bad(format!("The input “{id}” has no “spread”, for example {{\"kind\": \"relativeSd\", \"value\": 0.1}}.")))?;
        let law = law_of(spread, family.current)?;
        is_arrival.push(matches!(spec, ParamSpec::Arrival { .. }));
        ids.push(id);
        inputs.push(Input { family, law });
    }
    let laws: Vec<Law> = inputs.iter().map(|i| i.law).collect();
    // Which inputs vary together: each on its own, or every arrival rate as one factor.
    let together = get_bool(o, "arrivalsTogether")?.unwrap_or(false);
    let mut factors: Vec<Vec<usize>> = Vec::new();
    let mut arrivals: Option<usize> = None;
    for i in 0..laws.len() {
        if laws[i].is_fixed() {
            continue;
        }
        match (together && is_arrival[i], arrivals) {
            (true, Some(g)) => factors[g].push(i),
            (true, None) => {
                arrivals = Some(factors.len());
                factors.push(vec![i]);
            }
            _ => factors.push(vec![i]),
        }
    }
    if factors.is_empty() {
        return Err(bad("Nothing is uncertain yet: give at least one rate an uncertainty above zero."));
    }
    let derivatives = uncertainty::jackson_derivatives(&ctx.model, &ctx.solution, measure, &inputs);
    let sds: Vec<f64> = laws.iter().map(Law::sd).collect();
    let delta = uncertainty::delta(&derivatives, &sds, &factors);
    let samples = get_int(o, "samples")?.map(|n| n.max(0) as usize).unwrap_or(DEFAULT_SAMPLES).clamp(MIN_SAMPLES, MAX_SAMPLES);
    let seed = get_int(o, "seed")?.map(|s| s as u64).unwrap_or(DEFAULT_SEED);
    let mean_exists = uncertainty::mean_exists(&ctx.model, measure, &inputs);
    let p = uncertainty::propagate_jackson(&ctx.model, measure, &inputs, &factors, &Options { samples, seed, sobol: mean_exists }, &mut |_, _| {});
    let s = p.summary.as_ref();
    let disagreement = s.map(|s| if mean_exists { uncertainty::linear_disagreement(value, delta.sd, s) } else { uncertainty::interval_disagreement(value, delta.sd, s) });

    doc.push(("available", Json::Bool(true)));
    doc.push(("tier", Json::str("exact")));
    doc.push(("method", Json::str("Open Jackson network solved exactly at every sampled input; the delta method beside it")));
    doc.push(("measure", said));
    doc.push(("value", num(value)));
    doc.push(("unit", Json::str(measure.unit())));
    doc.push((
        "inputs",
        Json::Array(
            (0..ids.len())
                .map(|i| {
                    let (low, high) = laws[i].interval();
                    let law = match laws[i] {
                        Law::LogNormal { .. } => "lognormal",
                        Law::Uniform { .. } => "uniform",
                        Law::Fixed(_) => "fixed",
                    };
                    obj(vec![("id", Json::str(ids[i].clone())), ("law", Json::str(law)), ("mean", num(laws[i].mean())), ("sd", num(sds[i])), ("low", num(low)), ("high", num(high)), ("derivative", num(derivatives[i]))])
                })
                .collect(),
        ),
    ));
    doc.push((
        "shares",
        Json::Array(
            factors
                .iter()
                .enumerate()
                .map(|(g, members)| {
                    let index = p.sobol.as_ref().and_then(|s| s.indices.get(g));
                    obj(vec![
                        ("inputs", Json::Array(members.iter().map(|&i| Json::str(ids[i].clone())).collect())),
                        ("linear", num(delta.shares[g])),
                        ("first", index.map(|x| stat(x.first)).unwrap_or(Json::Null)),
                        ("total", index.map(|x| stat(x.total)).unwrap_or(Json::Null)),
                    ])
                })
                .collect(),
        ),
    ));
    doc.push(("linear", obj(vec![("tier", Json::str("approximation")), ("sd", num(delta.sd)), ("low", num(value - uncertainty::Z975 * delta.sd)), ("high", num(value + uncertainty::Z975 * delta.sd)), ("level", num(0.95))])));
    doc.push((
        "sampling",
        obj(vec![
            ("tier", Json::str("simulation")),
            ("samples", int(samples)),
            ("seed", Json::Number(seed.to_string())),
            ("unstable", int(p.unstable)),
            ("probabilityUnstable", stat(p.p_unstable)),
            ("meanExists", Json::Bool(mean_exists)),
            ("mean", s.filter(|_| mean_exists).map(|s| stat(s.mean)).unwrap_or(Json::Null)),
            ("sd", onum(s.filter(|_| mean_exists).map(|s| s.sd))),
            ("median", s.map(|s| stat(s.median)).unwrap_or(Json::Null)),
            ("q025", s.map(|s| stat(s.q025)).unwrap_or(Json::Null)),
            ("q975", s.map(|s| stat(s.q975)).unwrap_or(Json::Null)),
            ("min", onum(s.map(|s| s.min))),
            ("max", onum(s.map(|s| s.max))),
            ("histogram", s.map(|s| obj(vec![("low", num(s.histogram.lo)), ("high", num(s.histogram.hi)), ("counts", Json::Array(s.histogram.counts.iter().map(|c| int(*c)).collect())), ("above", int(s.histogram.above))])).unwrap_or(Json::Null)),
            ("shareRows", int(p.sobol.as_ref().map_or(0, |s| s.rows))),
            ("evaluations", int(samples + p.sobol.as_ref().map_or(0, |s| s.evaluations))),
        ]),
    ));
    doc.push(("disagreement", onum(disagreement)));
    doc.push(("disagreementThreshold", num(uncertainty::DISAGREE)));
    Ok(print(&obj(doc)))
}

// ── transient ───────────────────────────────────────────────────────────────────────────────

fn matrix(m: &[Vec<f64>]) -> Json {
    Json::Array(m.iter().map(|r| nums(r)).collect())
}

fn transient_command(file: &str, o: &Obj) -> Result<String, Failure> {
    let net = read(file)?;
    let mut doc = envelope("transient", &net, file);
    let a = transient::applicability(&net);
    let Some(model) = a.exact.as_ref().ok().or(a.fluid.as_ref().ok()) else {
        doc.push(("available", Json::Bool(false)));
        doc.push(("exact", Json::Null));
        doc.push(("exactReason", ostr(a.exact.err())));
        doc.push(("fluid", Json::Null));
        doc.push(("fluidReason", ostr(a.fluid.clone().err())));
        doc.push(("sentence", ostr(a.fluid.err())));
        return Ok(print(&obj(doc)));
    };
    let alpha = jackson::throughputs(model);
    let suggested = alpha.as_ref().map(|al| transient::suggested_horizon(model, al)).filter(|h| h.is_finite());
    let initial = match get(o, "initial") {
        None => Initial::Empty,
        Some(Json::String(s)) if s == "empty" => Initial::Empty,
        Some(Json::String(s)) if s == "steady" => Initial::Steady,
        Some(Json::Array(list)) => Initial::Given(list.iter().map(|x| x.as_i64().filter(|n| *n >= 0).map(|n| n as u32).ok_or_else(|| bad("The starting numbers must be whole numbers, one for each station."))).collect::<Result<_, _>>()?),
        Some(_) => return Err(bad("“initial” must be \"empty\", \"steady\" or a list of the number at each station.")),
    };
    let surge = match get_obj(o, "surge")? {
        None => None,
        Some(s) => {
            let part = |k: &str| get_num(s, k)?.ok_or_else(|| bad(format!("The surge needs “{k}”.")));
            Some(Surge { factor: part("factor")?, from: part("from")?, until: part("until")? })
        }
    };
    let defaults = Request::default();
    let horizon = match get_num(o, "horizon")? {
        Some(h) => h,
        // A stored rate profile: long enough to show it all (two periods of a periodic one).
        None => {
            let span = net.nodes.iter().filter_map(|n| n.rate_profile.as_ref()).map(|r| if r.periodic { 2.0 * r.span() } else { r.span() }).fold(0.0, f64::max);
            suggested.unwrap_or(defaults.horizon).max(span)
        }
    };
    // New in 2.1: the network's stored rate profiles (several breakpoints, each source its own).
    let profile = if horizon > 0.0 && horizon.is_finite() { transient::profile_of(&net, model, horizon).map_err(bad)? } else { None };
    let request = Request {
        horizon,
        intervals: get_int(o, "intervals")?.map(|n| n.max(1) as usize).unwrap_or(defaults.intervals),
        initial,
        surge,
        profile,
        settle_fraction: get_num(o, "settleFraction")?.unwrap_or(defaults.settle_fraction),
        ..defaults
    };
    transient::validate(model, &request).map_err(bad)?;
    let solution = jackson::solve(model).ok();
    let stations = (0..model.mu.len())
        .map(|i| {
            let cap = model.servers[i].max(1) as f64 * model.mu[i];
            obj(vec![
                ("id", Json::str(model.ids[i].clone())),
                ("name", Json::str(model.names[i].clone())),
                ("servers", Json::int(model.servers[i])),
                ("utilisation", onum(alpha.as_ref().map(|a| a[i] / cap))),
                ("stationary", onum(solution.as_ref().map(|s| s.number[i]))),
                ("relaxation", onum(alpha.as_ref().map(|a| transient::relaxation_time(a[i], cap)))),
            ])
        })
        .collect();
    let f = transient::fluid(model, &request);
    doc.push(("available", Json::Bool(true)));
    doc.push(("horizon", num(request.horizon)));
    doc.push(("suggestedHorizon", onum(suggested)));
    doc.push(("settleFraction", num(request.settle_fraction)));
    doc.push(("times", nums(&f.times)));
    doc.push(("stations", Json::Array(stations)));
    doc.push(("units", units(&[("times", "time"), ("mean", "customers"), ("level", "customers"), ("shortfall", "customers"), ("empty", "probability"), ("distance", "probability"), ("settling", "time"), ("stationary", "customers"), ("relaxation", "time"), ("utilisation", "ratio")])));
    doc.push((
        "fluid",
        obj(vec![("tier", Json::str("approximation")), ("method", Json::str("Fluid model: the network's mean flows, no randomness")), ("level", matrix(&f.level)), ("emptied", Json::Array(f.emptied.iter().map(|(i, t)| obj(vec![("station", Json::str(model.names[*i].clone())), ("time", num(*t))])).collect()))]),
    ));
    doc.push(("fluidReason", Json::Null));
    doc.push(("profile", match &request.profile {
        Some(p) => obj(vec![("breaks", nums(&p.breaks)), ("periodic", Json::Bool(p.periodic)), ("rates", matrix(&p.gamma))]),
        None => Json::Null,
    }));
    // The pointwise stationary approximation, where the rates change in time and the frozen
    // network is a Jackson network: an approximation, null where a piece overloads the network.
    doc.push(("psa", match &a.exact {
        Ok(jm) if request.profile.is_some() || request.surge.is_some() => obj(vec![
            ("tier", Json::str("approximation")),
            ("method", Json::str("Pointwise stationary approximation: at each time, the steady state of the network with its rates frozen at that time's values")),
            ("mean", Json::Array(transient::psa(jm, &request).iter().map(|row| Json::Array(row.iter().map(|x| onum(*x)).collect())).collect())),
        ]),
        _ => Json::Null,
    }));
    let (mut exact, mut exact_reason) = (Json::Null, Json::Null);
    match &a.exact {
        Err(reason) => exact_reason = Json::str(reason.clone()),
        Ok(jm) => match transient::exact(jm, &request, &mut |_| true) {
            Ok(e) => {
                exact = obj(vec![
                    ("tier", Json::str("exact")),
                    ("method", Json::str("Uniformisation of the network's Markov chain on a truncated state space, with a proven bound on what the truncation leaves out")),
                    ("mean", matrix(&e.mean)),
                    // The largest proven shortfall of each station's curve below the true mean.
                    ("shortfall", Json::Array(e.shortfall.iter().map(|row| onum(row.iter().try_fold(0.0f64, |m, b| b.map(|b| m.max(b))))).collect())),
                    ("uncertified", Json::Array(e.uncertified.iter().map(|b| Json::Bool(*b)).collect())),
                    ("empty", matrix(&e.empty)),
                    ("distance", nums(&e.distance)),
                    ("stationary", nums(&e.stationary)),
                    ("settling", Json::Array(e.settling.iter().map(|t| onum(*t)).collect())),
                    ("settleFrom", num(e.settle_from)),
                    ("levels", Json::Array(e.levels.iter().map(|l| int(*l)).collect())),
                    ("states", int(e.states)),
                    ("uniformisationRate", num(e.uniformisation_rate)),
                    ("products", int(e.products)),
                    ("poissonBound", num(e.poisson_bound)),
                    ("missingMass", num(e.missing_mass.last().copied().unwrap_or(0.0))),
                    ("stationaryTail", num(e.stationary_tail)),
                ]);
            }
            Err(Refusal::Stopped) => exact_reason = Json::str("The computation was stopped."),
            Err(r) => exact_reason = Json::str(r.message()),
        },
    }
    doc.push(("exact", exact));
    doc.push(("exactReason", exact_reason));
    Ok(print(&obj(doc)))
}

// ── run --json ──────────────────────────────────────────────────────────────────────────────

/// The interval of a measurement, by the rule the app's Agreement view reads records with
/// (src/results/insight.ts `interval`): the stated bounds, at the stated level; otherwise the
/// estimate ± z standard errors, for the levels whose z is tabled here (1.645 at 90 %, 1.96 at
/// 95 % or when none is stated, 2.576 at 99 %). A standard error stated with any other level
/// (the regenerative simulator's confidence is the person's to set) gives no interval: ±1.96
/// standard errors would be a 95 % interval labelled with another level (ledger WF-509). The
/// standard error itself is still in the document.
pub fn interval(estimate: f64, u: &qnet_core::results::model::Uncertainty) -> Option<(f64, f64, f64)> {
    let level = u.confidence_level.unwrap_or(0.95);
    if let (Some(lo), Some(hi)) = (u.lower_bound, u.upper_bound) {
        return Some((lo, hi, level));
    }
    let se = u.standard_error?;
    let z = [(0.9, 1.645), (0.95, 1.96), (0.99, 2.576)].into_iter().find(|(l, _)| (level - l).abs() < 1e-9).map(|(_, z)| z)?;
    Some((estimate - z * se, estimate + z * se, level))
}

pub fn method_json(label: &str, meta: &MethodMetadata) -> Json {
    obj(vec![
        ("label", Json::str(label)),
        ("identifier", Json::str(meta.identifier.clone())),
        ("name", Json::str(meta.display_name.clone())),
        ("shortName", Json::str(meta.short_name.clone())),
        ("tier", Json::str(methods::tier(meta.fidelity))),
        ("fidelity", Json::str(meta.fidelity.raw())),
        ("implementation", ostr(meta.implementation.clone())),
    ])
}

/// What `run --json` prints for a finished run: the record the Results workspace would hold.
/// This Mac's folders, which a document a script may keep or pass on must not spell out (ledger
/// WF-504): a record's "runtime" parameter is the solver's full path and the Python runtime's, and
/// a failure or a Status line can quote one. The home folder is written `~`, the temporary folder
/// `$TMPDIR`, the app's bundle `<Qnet.app>`: the scrubber of the app's failure reports.
pub struct Scrub(qnet_runner::scrub::Folders);

impl Scrub {
    pub fn of_process() -> Scrub {
        Scrub(qnet_runner::scrub::Folders::detect(ResolverConfig::from_process().bundle_resources.as_deref()))
    }

    pub fn text(&self, s: &str) -> String {
        self.0.scrub(s, qnet_runner::scrub::Bundle::Named("<Qnet.app>"))
    }

    fn lines(&self, lines: &[(String, String)]) -> Vec<(String, String)> {
        lines.iter().map(|(severity, text)| (severity.clone(), self.text(text))).collect()
    }
}

#[cfg(test)]
impl Scrub {
    fn with(folders: qnet_runner::scrub::Folders) -> Scrub {
        Scrub(folders)
    }
}

/// What `run --json` prints for a finished run: the record the Results workspace would hold.
pub fn run_json(file: &str, net: &Network, label: &str, record: &RunRecord, exit_code: i32, status_lines: &[(String, String)]) -> Json {
    run_json_scrubbed(file, net, label, record, exit_code, status_lines, &Scrub::of_process())
}

fn run_json_scrubbed(file: &str, net: &Network, label: &str, record: &RunRecord, exit_code: i32, status_lines: &[(String, String)], scrub: &Scrub) -> Json {
    let status_lines = &scrub.lines(status_lines)[..];
    let mut doc = envelope("run", net, file);
    doc.push(("method", method_json(label, &record.method)));
    doc.push(("status", Json::str(record.status.raw())));
    doc.push(("exitCode", Json::int(exit_code as i64)));
    doc.push(("elapsedSeconds", onum(record.elapsed_seconds)));
    doc.push(("seed", record.provenance.seed.map(|s| Json::Number(s.to_string())).unwrap_or(Json::Null)));
    doc.push(("parameters", Json::Object(record.provenance.parameters.iter().map(|(k, v)| (k.clone(), Json::str(scrub.text(v)))).collect())));
    doc.push(("failure", ostr(record.failure_message.as_deref().map(|m| scrub.text(m)))));
    doc.push(("warnings", with_scenario_warning(record.warnings.iter().map(|w| scrub.text(w)).collect())));
    doc.push(("statusLines", status_json(status_lines)));
    let values = record
        .measurements
        .iter()
        .map(|m| {
            let u = m.uncertainty.as_ref();
            let between = u.and_then(|u| interval(m.estimate, u));
            obj(vec![
                ("station", Json::str(m.station_name.clone())),
                ("stationId", ostr(m.station_id.clone())),
                ("class", m.customer_class.map(Json::int).unwrap_or(Json::Null)),
                ("metric", Json::str(m.metric.clone())),
                ("value", num(m.estimate)),
                ("unit", Json::str(m.unit.clone())),
                ("standardError", onum(u.and_then(|u| u.standard_error))),
                ("interval", between.map(|(lo, hi, level)| obj(vec![("low", num(lo)), ("high", num(hi)), ("level", num(level))])).unwrap_or(Json::Null)),
                ("sampleSize", u.and_then(|u| u.sample_size).map(Json::int).unwrap_or(Json::Null)),
                ("note", ostr(m.note.as_deref().map(|n| scrub.text(n)))),
            ])
        })
        .collect();
    doc.push(("values", Json::Array(values)));
    obj(doc)
}

pub fn status_json(lines: &[(String, String)]) -> Json {
    Json::Array(lines.iter().map(|(severity, text)| obj(vec![("severity", Json::str(severity.clone())), ("text", Json::str(text.clone()))])).collect())
}

/// What `run --json` prints for a run that did not start or filed no record.
pub fn run_refused_json(file: &str, net: &Network, label: &str, status: &str, exit_code: i32, message: Option<String>, status_lines: &[(String, String)]) -> Json {
    let scrub = Scrub::of_process();
    let (message, status_lines) = (message.map(|m| scrub.text(&m)), &scrub.lines(status_lines)[..]);
    let mut doc = envelope("run", net, file);
    doc.push(("method", MethodMetadata::for_run_label(label).map(|m| method_json(label, &m)).unwrap_or_else(|| obj(vec![("label", Json::str(label))]))));
    doc.push(("status", Json::str(status)));
    doc.push(("exitCode", Json::int(exit_code as i64)));
    doc.push(("failure", ostr(message)));
    doc.push(("warnings", with_scenario_warning(Vec::new())));
    doc.push(("statusLines", status_json(status_lines)));
    doc.push(("values", Json::Array(Vec::new())));
    obj(doc)
}

// ── dispatch ────────────────────────────────────────────────────────────────────────────────

/// Runs one of this file's commands, or says the arguments name none of them.
pub fn run(a: &[&str]) -> Option<Result<String, Failure>> {
    let usage = || Err((2, format!("Usage:\n{USAGE}")));
    Some(match a {
        ["build", source] => build_command(source, None),
        ["build", source, out] => build_command(source, Some(out)),
        ["describe", file] => describe(file),
        ["methods", file] => methods_command(file, false),
        ["methods", file, "--assume-installed"] | ["methods", "--assume-installed", file] => methods_command(file, true),
        ["live", file] => live(file),
        [command @ ("sensitivity" | "capacity" | "uncertainty" | "transient"), file, rest @ ..] if rest.len() <= 1 => options(rest.first().copied()).and_then(|o| match *command {
            "sensitivity" => sensitivity_command(file, &o),
            "capacity" => capacity_command(file, &o),
            "uncertainty" => uncertainty_command(file, &o),
            _ => transient_command(file, &o),
        }),
        ["build" | "describe" | "methods" | "live" | "sensitivity" | "capacity" | "uncertainty" | "transient", ..] => usage(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use qnet_core::results::model::Uncertainty;

    fn u(se: Option<f64>, lo: Option<f64>, hi: Option<f64>, level: Option<f64>) -> Uncertainty {
        Uncertainty { standard_error: se, lower_bound: lo, upper_bound: hi, confidence_level: level, sample_size: None }
    }

    /// src/results/insight.ts `interval`, case for case.
    #[test]
    fn an_interval_is_the_stated_bounds_or_z_standard_errors_at_the_stated_level() {
        assert_eq!(interval(10.0, &u(Some(1.0), Some(7.0), Some(12.0), None)), Some((7.0, 12.0, 0.95)), "stated bounds win");
        assert_eq!(interval(10.0, &u(Some(1.0), None, None, None)), Some((10.0 - 1.96, 10.0 + 1.96, 0.95)));
        assert_eq!(interval(10.0, &u(Some(1.0), None, None, Some(0.9))), Some((10.0 - 1.645, 10.0 + 1.645, 0.9)));
        assert_eq!(interval(10.0, &u(Some(1.0), None, None, Some(0.99))), Some((10.0 - 2.576, 10.0 + 2.576, 0.99)));
        assert_eq!(interval(10.0, &u(Some(1.0), None, None, Some(0.95))), Some((10.0 - 1.96, 10.0 + 1.96, 0.95)));
        // Ledger WF-509: ±1.96 standard errors is not an 80 % interval, so none is restated at 80 %.
        assert_eq!(interval(10.0, &u(Some(2.0), Some(7.0), None, Some(0.8))), None, "one bound alone is not an interval, and 80 % has no tabled z");
        assert_eq!(interval(10.0, &u(Some(2.0), None, None, Some(0.975))), None);
        assert_eq!(interval(10.0, &u(Some(2.0), Some(8.5), Some(11.5), Some(0.8))), Some((8.5, 11.5, 0.8)), "bounds the method stated are its own, at its level");
        assert_eq!(interval(10.0, &u(None, Some(7.0), None, None)), None);
    }

    /// Ledger WF-504: a record's "runtime" parameter is the solver's and the Python runtime's
    /// full paths, and a failure or a Status line can quote one; none leaves in `run --json`.
    #[test]
    fn run_json_does_not_spell_out_the_home_folder_or_the_bundle() {
        let text = include_str!("../../golden/runs/3dtandem.inf/qna/record.json");
        let mut record = RunRecord::parse(text).unwrap();
        record.provenance.parameters.insert("runtime".into(), "bundled solver: /Applications/Qnet.app/Contents/Resources/bin/qna; Python runtime: /Users/ann/Library/Caches/qnet/python/bin/python3".into());
        record.failure_message = Some("Couldn't read /Users/ann/Documents/line.out.".into());
        record.warnings = vec!["See /private/var/folders/ab/T/qnet-1/log.".into()];
        let net = bnet::read(include_str!("../../examples/3dtandem.inf.bnet")).unwrap();
        let scrub = Scrub::with(qnet_runner::scrub::Folders { bundle: Some("/Applications/Qnet.app".into()), temp_dir: Some("/var/folders/ab/T".into()), home: Some("/Users/ann".into()) });
        load::forget_note();
        let lines = vec![("error".to_string(), "/Users/ann/x.bnet: no such file".to_string())];
        let doc = run_json_scrubbed("/Users/ann/Documents/3dtandem.inf.bnet", &net, "qna", &record, 1, &lines, &scrub);
        let printed = print(&doc);
        assert!(!printed.contains("/Users/ann") && !printed.contains("/Applications/Qnet.app") && !printed.contains("/var/folders"), "{printed}");
        let m = doc.as_object().unwrap();
        assert_eq!(m["parameters"].as_object().unwrap()["runtime"].as_str(), Some("bundled solver: <Qnet.app>/Contents/Resources/bin/qna; Python runtime: ~/Library/Caches/qnet/python/bin/python3"));
        assert_eq!(m["failure"].as_str(), Some("Couldn't read ~/Documents/line.out."));
        assert_eq!(m["warnings"], Json::Array(vec![Json::str("See $TMPDIR/qnet-1/log.")]));
        assert_eq!(print(&m["statusLines"]).matches("~/x.bnet: no such file").count(), 1);
        // The title is the file's name, never its folder.
        assert_eq!(m["network"].as_object().unwrap()["title"].as_str(), Some("3dtandem.inf.bnet"));
    }

    #[test]
    fn a_number_that_is_not_finite_is_null_and_the_document_is_json() {
        let v = obj(vec![("a", num(f64::NAN)), ("b", num(f64::INFINITY)), ("c", num(0.1)), ("d", Json::str("x/y"))]);
        let text = print(&v);
        assert_eq!(json::parse(&text).unwrap(), obj(vec![("a", Json::Null), ("b", Json::Null), ("c", Json::num(0.1)), ("d", Json::str("x/y"))]));
        assert!(text.contains("\"x/y\"") && text.ends_with("}\n"), "{text}");
    }
}
