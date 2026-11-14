//! The finite and truncated Markov solver inputs, ported from Qnet 0.90.34's
//! `FiniteMarkovExporter.swift`.
//!
//! Three JSON documents come out of one strict reading of the network: the exact sparse CTMC
//! (fBNAgc, `generic_ctmc`, blocking "loss"), the finite-buffer decomposition (fBNAdecomp,
//! `decomposition`, blocking "loss", "bas" or "bas_external_loss") and the adaptive truncated CTMC
//! of an infinite-buffer, single-class network (BNAtc, `truncated_infinite_ctmc`). The reading
//! refuses anything that is not Markovian (Poisson arrivals, exponential service) instead of
//! replacing it by an exponential with the same mean, and each refusal is 0.90.34's sentence.
//!
//! 0.90.34 built each document as a `[String: Any]` and wrote it with `JSONSerialization`
//! `[.prettyPrinted, .sortedKeys]`, so a Swift `Int` is written as an integer (`3`), a `Double` with
//! `%.17g` (`0.10000000000000001`, `1` for 1.0) and a `Bool` as `true`/`false`; keys follow
//! Foundation's order (`json::ns_key_order`), and the text ends with one newline. Stations are
//! numbered `s1…` in export order (by the number in their names), classes `c1…` up to the highest
//! class index any source, station or link mentions.
//!
//! One behaviour is not 0.90.34's: a number that overflows to infinity (a huge routing probability
//! times an arrival rate) made `JSONSerialization` raise an Objective-C exception, which ended
//! 0.90.34; here it is the `Encoding` refusal carrying that exception's reason.

use std::collections::{BTreeMap, HashMap};

use crate::dist::{format_significant, parse_params};
use crate::editor::class_index_of_source;
use crate::json::{self, ns_double, Json};
use crate::model::{Distribution, Link, Network, Node, NodeKind};
use crate::naming;
use crate::traffic::class_label;

/// Why a network has no finite Markov document (0.90.34 `FiniteMarkovExportError`).
#[derive(Clone, Debug, PartialEq)]
pub enum FiniteMarkovExportError {
    NoStations,
    NoSources,
    /// A station with no buffer feeding it.
    MissingBuffer(String),
    /// A station fed by more than one buffer.
    MultipleBuffers(String),
    /// Source, distribution display name.
    UnsupportedArrival(String, String),
    InvalidArrivalRate(String),
    UnresolvedSource(String),
    /// Station, class label, distribution display name.
    UnsupportedService(String, String, String),
    /// Station, class label.
    InvalidServiceRate(String, String),
    /// Station, class label, the row total.
    RoutingExceedsOne(String, String, f64),
    RequiresInfiniteBuffers,
    RequiresSingleClass,
    Encoding(String),
}

impl FiniteMarkovExportError {
    /// The sentence 0.90.34 showed (`errorDescription`).
    pub fn message(&self) -> String {
        use FiniteMarkovExportError::*;
        match self {
            NoStations => "The network has no service stations.".into(),
            NoSources => "The network has no external arrival source.".into(),
            MissingBuffer(s) => format!("{s} needs exactly one upstream buffer so its finite capacity is defined."),
            MultipleBuffers(s) => {
                format!("{s} has more than one upstream buffer; the finite Markov solvers require one total capacity per station.")
            }
            UnsupportedArrival(src, d) => format!(
                "{src} uses {d} arrivals. The finite Markov solvers require a Poisson process (Poisson or exponential inter-arrivals)."
            ),
            InvalidArrivalRate(src) => format!("{src} does not contain a positive finite arrival rate."),
            UnresolvedSource(src) => format!("{src} does not route to any service station."),
            UnsupportedService(s, c, d) => format!("{s}, {c} uses {d} service. This method requires exponential service times."),
            InvalidServiceRate(s, c) => format!("{s}, {c} does not contain a positive finite exponential service rate."),
            // DS.Number.format(total, significantDigits: 7).
            RoutingExceedsOne(s, c, total) => {
                format!("Routing probabilities from {s} for {c} total {}, above 1.", format_significant(*total, 7))
            }
            RequiresInfiniteBuffers => "This adaptive CTMC method is defined for infinite-buffer networks.".into(),
            RequiresSingleClass => {
                "The adaptive truncated CTMC currently supports one customer class with no class transitions.".into()
            }
            Encoding(m) => format!("The finite Markov input could not be encoded: {m}"),
        }
    }
}

impl std::fmt::Display for FiniteMarkovExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for FiniteMarkovExportError {}

/// The exact sparse CTMC's solver settings (`genericCTMC`'s parameters; 0.90.34's defaults).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GenericCtmcOptions {
    pub max_states: i64,
    pub tolerance: f64,
}

impl Default for GenericCtmcOptions {
    fn default() -> Self {
        GenericCtmcOptions { max_states: 200_000, tolerance: 1e-12 }
    }
}

/// How the decomposition treats a job that finds the next buffer full.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Blocking {
    /// The job is lost ("loss").
    Loss,
    /// Blocking after service ("bas").
    Bas,
    /// Blocking after service inside the network, external arrivals lost ("bas_external_loss").
    BasExternalLoss,
}

impl Blocking {
    /// The word the decomposition solver reads.
    pub fn solver_name(self) -> &'static str {
        match self {
            Blocking::Loss => "loss",
            Blocking::Bas => "bas",
            Blocking::BasExternalLoss => "bas_external_loss",
        }
    }

    /// The blocking a solver word names, if any.
    pub fn from_solver_name(s: &str) -> Option<Blocking> {
        [Blocking::Loss, Blocking::Bas, Blocking::BasExternalLoss].into_iter().find(|b| b.solver_name() == s)
    }
}

/// The decomposition's solver settings (`decomposition`'s parameters; 0.90.34's defaults).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DecompositionOptions {
    pub tolerance: f64,
    pub max_iterations: i64,
    pub damping: f64,
}

impl Default for DecompositionOptions {
    fn default() -> Self {
        DecompositionOptions { tolerance: 1e-10, max_iterations: 1_000, damping: 0.5 }
    }
}

/// The truncated CTMC's caps (`truncatedInfiniteCTMC`'s parameters; 0.90.34's defaults).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TruncatedCtmcOptions {
    pub initial_total_cap: i64,
    pub max_total_cap: i64,
    pub max_states: i64,
}

impl Default for TruncatedCtmcOptions {
    fn default() -> Self {
        TruncatedCtmcOptions { initial_total_cap: 8, max_total_cap: 64, max_states: 200_000 }
    }
}

struct StationSpec {
    id: String,
    name: String,
    servers: i64,
    capacity: i64,
    service_rates: BTreeMap<String, f64>,
}

struct ArrivalSpec {
    station: String,
    class: String,
    rate: f64,
}

/// A routing destination; `station` and `class` are None for an exit.
struct DestinationSpec {
    station: Option<String>,
    class: Option<String>,
    probability: f64,
    exits: bool,
}

struct RoutingSpec {
    from_station: String,
    from_class: String,
    destinations: Vec<DestinationSpec>,
}

struct Model {
    classes: Vec<String>,
    stations: Vec<StationSpec>,
    arrivals: Vec<ArrivalSpec>,
    routing: Vec<RoutingSpec>,
}

fn obj(entries: Vec<(&str, Json)>) -> Json {
    Json::Object(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// The exact sparse CTMC input for fBNAgc (`genericCTMC`).
pub fn generic_ctmc(net: &Network, name: &str, options: &GenericCtmcOptions) -> Result<String, FiniteMarkovExportError> {
    let model = model(net)?;
    let stations = model
        .stations
        .iter()
        .map(|s| {
            obj(vec![
                ("id", Json::str(&s.id)),
                ("servers", Json::int(s.servers)),
                ("capacity", Json::int(s.capacity)),
                ("service_rates", rates_json(&s.service_rates)),
            ])
        })
        .collect();
    let arrivals = model
        .arrivals
        .iter()
        .map(|a| obj(vec![("station", Json::str(&a.station)), ("class", Json::str(&a.class)), ("rate", ns_double(a.rate))]))
        .collect();
    let document = obj(vec![
        ("schema_version", Json::int(1)),
        ("name", Json::str(name)),
        ("blocking", Json::str("loss")),
        ("service_discipline", Json::str("fcfs")),
        ("classes", Json::Array(model.classes.iter().map(Json::str).collect())),
        ("stations", Json::Array(stations)),
        ("external_arrivals", Json::Array(arrivals)),
        ("routing", Json::Array(model.routing.iter().map(ctmc_routing).collect())),
        (
            "solver",
            obj(vec![
                ("tolerance", ns_double(options.tolerance)),
                ("max_iterations", Json::int(200_000)),
                ("max_states", Json::int(options.max_states)),
            ]),
        ),
    ]);
    encode(&document)
}

/// The finite-buffer decomposition input for fBNAdecomp (`decomposition`).
pub fn decomposition(
    net: &Network,
    name: &str,
    blocking: Blocking,
    options: &DecompositionOptions,
) -> Result<String, FiniteMarkovExportError> {
    let model = model(net)?;
    let stations = model
        .stations
        .iter()
        .map(|s| {
            obj(vec![
                ("id", Json::str(&s.id)),
                ("name", Json::str(&s.name)),
                ("servers", Json::int(s.servers)),
                ("capacity", Json::int(s.capacity)),
                ("service_rates", rates_json(&s.service_rates)),
            ])
        })
        .collect();
    let classes = model
        .classes
        .iter()
        .map(|c| {
            // Dictionary(grouping:) then Dictionary(uniqueKeysWithValues:): the arrivals are already
            // merged per station and class, so each station appears once.
            let external: BTreeMap<String, Json> =
                model.arrivals.iter().filter(|a| &a.class == c).map(|a| (a.station.clone(), ns_double(a.rate))).collect();
            obj(vec![("id", Json::str(c)), ("name", Json::str(class_name(c))), ("external_arrivals", Json::Object(external))])
        })
        .collect();
    let mut routes = Vec::new();
    for row in &model.routing {
        for d in &row.destinations {
            let (false, Some(station), Some(class)) = (d.exits, &d.station, &d.class) else { continue };
            let mut route = vec![
                ("class", Json::str(&row.from_class)),
                ("from", Json::str(&row.from_station)),
                ("to", Json::str(station)),
                ("probability", ns_double(d.probability)),
            ];
            if *class != row.from_class {
                route.push(("to_class", Json::str(class)));
            }
            routes.push(obj(route));
        }
    }
    let document = obj(vec![
        ("schema_version", Json::int(1)),
        ("name", Json::str(name)),
        ("blocking", Json::str(blocking.solver_name())),
        ("stations", Json::Array(stations)),
        ("classes", Json::Array(classes)),
        ("routes", Json::Array(routes)),
        (
            "solver",
            obj(vec![
                ("tolerance", ns_double(options.tolerance)),
                ("max_iterations", Json::int(options.max_iterations)),
                ("damping", ns_double(options.damping)),
            ]),
        ),
    ]);
    encode(&document)
}

/// The adaptive truncated CTMC input for BNAtc (`truncatedInfiniteCTMC`): an infinite-buffer
/// network with one class and no class changes, whose population counts are then Markov.
pub fn truncated_infinite_ctmc(net: &Network, name: &str, options: &TruncatedCtmcOptions) -> Result<String, FiniteMarkovExportError> {
    use FiniteMarkovExportError as E;
    if !net.infinite_buffers {
        return Err(E::RequiresInfiniteBuffers);
    }
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| &n.name);
    if stations.is_empty() {
        return Err(E::NoStations);
    }
    let sources = naming::in_export_order(net.nodes_of(NodeKind::Source), |n| &n.name);
    if sources.is_empty() {
        return Err(E::NoSources);
    }

    let single_class = sources.iter().all(|s| class_index_of_source(&net.nodes, &s.id) == 0)
        && stations.iter().all(|s| s.service_by_class.keys().all(|&k| k == 0))
        && net.links.iter().all(|l| l.class == 0 && l.exit_class() == 0);
    if !single_class || net.links.iter().any(|l| l.has_class_transition()) {
        return Err(E::RequiresSingleClass);
    }

    let station_index = station_index(&stations);
    let mut external = vec![0.0f64; stations.len()];
    for source in &sources {
        let rate = arrival_rate(source)?;
        let mut resolved = false;
        for link in net.links.iter().filter(|l| l.from == source.id && l.probability > 0.0) {
            let Some(destination) = resolve_station(&link.to, net, &station_index) else { continue };
            external[destination] += rate * link.probability;
            resolved = true;
        }
        if !resolved {
            return Err(E::UnresolvedSource(source.name.clone()));
        }
    }

    let mut routing = vec![vec![0.0f64; stations.len()]; stations.len()];
    let mut node_documents = Vec::new();
    for (index, station) in stations.iter().enumerate() {
        let service_rate = service_rate(station, 0)?;
        let outgoing: Vec<&Link> = net.links.iter().filter(|l| l.from == station.id && l.class == 0).collect();
        let total = outgoing.iter().fold(0.0, |acc, l| acc + l.probability);
        if !(total <= 1.0 + 1e-9) {
            return Err(E::RoutingExceedsOne(station.name.clone(), class_label(0), total));
        }
        for link in outgoing.iter().filter(|l| l.probability > 0.0) {
            if let Some(destination) = resolve_station(&link.to, net, &station_index) {
                routing[index][destination] += link.probability;
            }
        }
        node_documents.push(obj(vec![
            ("name", Json::str(&station.name)),
            ("external_arrival_rate", ns_double(external[index])),
            ("service_rate_per_server", ns_double(service_rate)),
            ("servers", Json::int(station.servers)),
        ]));
    }

    let document = obj(vec![
        ("schema_version", Json::int(1)),
        ("process", Json::str("open_single_class_markovian_network")),
        ("name", Json::str(name)),
        ("nodes", Json::Array(node_documents)),
        ("routing", Json::Array(routing.iter().map(|row| Json::Array(row.iter().map(|&p| ns_double(p)).collect())).collect())),
        (
            "solver",
            obj(vec![
                ("initial_total_cap", Json::int(options.initial_total_cap.max(1))),
                ("max_total_cap", Json::int(options.initial_total_cap.max(options.max_total_cap))),
                ("growth_factor", ns_double(1.6)),
                ("minimum_cap_increment", Json::int(2)),
                ("max_states", Json::int(options.max_states.max(1))),
                ("stationary_tolerance", ns_double(1e-13)),
                ("stationary_max_iterations", Json::int(200_000)),
                ("boundary_mass_tolerance", ns_double(1e-8)),
                ("refinement_relative_tolerance", ns_double(1e-7)),
                ("stability_tolerance", ns_double(1e-12)),
                ("routing_tolerance", ns_double(1e-12)),
                ("tail_levels", Json::Array([0, 1, 5, 10, 20].into_iter().map(Json::int).collect())),
                ("top_state_count", Json::int(0)),
                ("include_state_probabilities", Json::Bool(false)),
            ]),
        ),
    ]);
    encode(&document)
}

fn rates_json(rates: &BTreeMap<String, f64>) -> Json {
    Json::Object(rates.iter().map(|(k, &v)| (k.clone(), ns_double(v))).collect())
}

fn station_index<'a>(stations: &[&'a Node]) -> HashMap<&'a str, usize> {
    stations.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect()
}

/// A source's Poisson rate: `lambda` of a Poisson source, `rate` of an exponential one.
fn arrival_rate(source: &Node) -> Result<f64, FiniteMarkovExportError> {
    let parameters = parse_params(&source.parameters);
    let rate = match source.distribution {
        Distribution::Poisson => parameters.get("lambda").copied(),
        Distribution::Exponential => parameters.get("rate").copied(),
        d => return Err(FiniteMarkovExportError::UnsupportedArrival(source.name.clone(), d.display_name().into())),
    };
    match rate {
        Some(r) if r.is_finite() && r > 0.0 => Ok(r),
        _ => Err(FiniteMarkovExportError::InvalidArrivalRate(source.name.clone())),
    }
}

/// A station's exponential rate for a class: its per-class law, else its own.
fn service_rate(station: &Node, class: i64) -> Result<f64, FiniteMarkovExportError> {
    let (distribution, parameters) = match station.service_by_class.get(&class) {
        Some(c) => (c.distribution, c.parameters.as_str()),
        None => (station.distribution, station.parameters.as_str()),
    };
    if distribution != Distribution::Exponential {
        return Err(FiniteMarkovExportError::UnsupportedService(
            station.name.clone(),
            class_label(class),
            distribution.display_name().into(),
        ));
    }
    match parse_params(parameters).get("rate").copied() {
        Some(r) if r.is_finite() && r > 0.0 => Ok(r),
        _ => Err(FiniteMarkovExportError::InvalidServiceRate(station.name.clone(), class_label(class))),
    }
}

/// The CTMC and decomposition exporters' shared reading of the network (`model(editor:)`).
fn model(net: &Network) -> Result<Model, FiniteMarkovExportError> {
    use FiniteMarkovExportError as E;
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| &n.name);
    if stations.is_empty() {
        return Err(E::NoStations);
    }
    let sources = naming::in_export_order(net.nodes_of(NodeKind::Source), |n| &n.name);
    if sources.is_empty() {
        return Err(E::NoSources);
    }
    let station_index = station_index(&stations);

    let class_indices = sources
        .iter()
        .map(|s| class_index_of_source(&net.nodes, &s.id) as i64)
        .chain(stations.iter().flat_map(|s| s.service_by_class.keys().copied()))
        .chain(net.links.iter().flat_map(|l| [l.class, l.exit_class()]));
    let maximum_class = class_indices.max().unwrap_or(0).max(0);
    let classes: Vec<String> = (0..=maximum_class).map(class_id).collect();

    let mut station_specs = Vec::new();
    for (index, station) in stations.iter().enumerate() {
        let feeding: Vec<&Node> = net
            .nodes
            .iter()
            .filter(|c| c.kind == NodeKind::Buffer && net.links.iter().any(|l| l.from == c.id && l.to == station.id))
            .collect();
        if feeding.is_empty() {
            return Err(E::MissingBuffer(station.name.clone()));
        }
        if feeding.len() != 1 {
            return Err(E::MultipleBuffers(station.name.clone()));
        }
        let mut rates = BTreeMap::new();
        for class in 0..=maximum_class {
            rates.insert(class_id(class), service_rate(station, class)?);
        }
        station_specs.push(StationSpec {
            id: station_id(index),
            name: station.name.clone(),
            servers: station.servers,
            capacity: station.servers + feeding[0].buffer_size,
            service_rates: rates,
        });
    }

    let mut arrivals = Vec::new();
    for source in &sources {
        let source_class = class_index_of_source(&net.nodes, &source.id) as i64;
        let rate = arrival_rate(source)?;
        let mut resolved = false;
        for link in net.links.iter().filter(|l| l.from == source.id && l.probability > 0.0) {
            let Some(destination) = resolve_station(&link.to, net, &station_index) else { continue };
            resolved = true;
            arrivals.push(ArrivalSpec {
                station: station_id(destination),
                class: class_id(if link.has_class_transition() { link.exit_class() } else { source_class }),
                rate: rate * link.probability,
            });
        }
        if !resolved {
            return Err(E::UnresolvedSource(source.name.clone()));
        }
    }

    let mut routing = Vec::new();
    for (from_index, station) in stations.iter().enumerate() {
        for class in 0..=maximum_class {
            let outgoing: Vec<&Link> = net.links.iter().filter(|l| l.from == station.id && l.class == class).collect();
            if outgoing.is_empty() {
                continue;
            }
            let total = outgoing.iter().fold(0.0, |acc, l| acc + l.probability);
            if !(total <= 1.0 + 1e-9) {
                return Err(E::RoutingExceedsOne(station.name.clone(), class_label(class), total));
            }
            let destinations = outgoing
                .iter()
                .filter(|l| l.probability > 0.0)
                .map(|link| match resolve_station(&link.to, net, &station_index) {
                    Some(d) => DestinationSpec {
                        station: Some(station_id(d)),
                        class: Some(class_id(link.exit_class())),
                        probability: link.probability,
                        exits: false,
                    },
                    None => DestinationSpec { station: None, class: None, probability: link.probability, exits: true },
                })
                .collect();
            routing.push(RoutingSpec { from_station: station_id(from_index), from_class: class_id(class), destinations });
        }
    }
    Ok(Model { classes, stations: station_specs, arrivals: aggregate(arrivals), routing })
}

/// The station a link's end leads to (`resolveStation`): the station itself, or for a buffer the
/// station its first link to a station reaches; nothing for a sink or source (an exit).
fn resolve_station(node_id: &str, net: &Network, station_index: &HashMap<&str, usize>) -> Option<usize> {
    let node = net.node(node_id)?;
    if node.kind == NodeKind::Station {
        return station_index.get(node.id.as_str()).copied();
    }
    if node.kind != NodeKind::Buffer {
        return None;
    }
    for link in net.links.iter().filter(|l| l.from == node.id) {
        if let Some(target) = net.node(&link.to) {
            if target.kind == NodeKind::Station {
                return station_index.get(target.id.as_str()).copied();
            }
        }
    }
    None
}

/// One arrival per station and class, rates summed in link order, sorted by (station, class) as
/// strings (`aggregate`).
fn aggregate(arrivals: Vec<ArrivalSpec>) -> Vec<ArrivalSpec> {
    let mut groups: Vec<ArrivalSpec> = Vec::new();
    for a in arrivals {
        match groups.iter_mut().find(|g| g.station == a.station && g.class == a.class) {
            Some(g) => g.rate += a.rate,
            // `group.reduce(0) { $0 + $1.rate }` starts from 0.
            None => groups.push(ArrivalSpec { rate: 0.0 + a.rate, ..a }),
        }
    }
    groups.sort_by(|x, y| (&x.station, &x.class).cmp(&(&y.station, &y.class)));
    groups
}

fn ctmc_routing(row: &RoutingSpec) -> Json {
    let destinations = row
        .destinations
        .iter()
        .map(|d| {
            if d.exits {
                return obj(vec![("exit", Json::Bool(true)), ("probability", ns_double(d.probability))]);
            }
            obj(vec![
                ("station", Json::str(d.station.clone().unwrap_or_default())),
                ("class", Json::str(d.class.clone().unwrap_or_else(|| row.from_class.clone()))),
                ("probability", ns_double(d.probability)),
            ])
        })
        .collect();
    obj(vec![
        ("from_station", Json::str(&row.from_station)),
        ("from_class", Json::str(&row.from_class)),
        ("destinations", Json::Array(destinations)),
    ])
}

/// `JSONSerialization` `[.prettyPrinted, .sortedKeys]` plus a newline. Foundation refuses a
/// non-finite number with the reason below (0.90.34 then stopped; see the module comment).
fn encode(document: &Json) -> Result<String, FiniteMarkovExportError> {
    if let Some(kind) = first_non_finite(document) {
        return Err(FiniteMarkovExportError::Encoding(format!("Invalid number value ({kind}) in JSON write")));
    }
    Ok(json::to_pretty_serialization(document) + "\n")
}

/// The first non-finite number in writing order, as Foundation names it ("NaN" or "infinite").
fn first_non_finite(v: &Json) -> Option<&'static str> {
    match v {
        Json::Number(t) => match t.parse::<f64>() {
            Ok(x) if x.is_finite() => None,
            Ok(x) if x.is_infinite() => Some("infinite"),
            _ if t.contains("inf") => Some("infinite"),
            _ => Some("NaN"),
        },
        Json::Array(a) => a.iter().find_map(first_non_finite),
        Json::Object(m) => {
            let mut entries: Vec<(&String, &Json)> = m.iter().collect();
            entries.sort_by(|(a, _), (b, _)| json::ns_key_order(a, b));
            entries.into_iter().find_map(|(_, x)| first_non_finite(x))
        }
        _ => None,
    }
}

fn station_id(index: usize) -> String {
    format!("s{}", index + 1)
}

fn class_id(index: i64) -> String {
    format!("c{}", index + 1)
}

/// "Class n" for "cn" (`className`).
fn class_name(id: &str) -> String {
    match id.strip_prefix('c').and_then(|n| n.parse::<i64>().ok()) {
        Some(n) => class_label((n - 1).max(0)),
        None => id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ServiceConfig;

    fn node(id: &str, kind: NodeKind, name: &str) -> Node {
        Node::new(id, kind, name, (0.0, 0.0))
    }

    fn link(from: &str, to: &str, p: f64) -> Link {
        Link { id: format!("{from}-{to}"), from: from.into(), to: to.into(), probability: p, class: 0, to_class: None }
    }

    /// Src1 → B1 → S1 → Sink1, Poisson(1) arrivals, exponential(2) service.
    fn mm1(infinite: bool) -> Network {
        let mut src = node("src", NodeKind::Source, "Src1");
        src.distribution = Distribution::Poisson;
        src.parameters = "lambda=1.0".into();
        let mut s1 = node("s1", NodeKind::Station, "S1");
        s1.parameters = "rate=2.0".into();
        let mut b1 = node("b1", NodeKind::Buffer, "B1");
        b1.buffer_size = 4;
        Network {
            nodes: vec![src, b1, s1, node("k", NodeKind::Sink, "Sink1")],
            links: vec![link("src", "b1", 1.0), link("b1", "s1", 1.0), link("s1", "k", 1.0)],
            infinite_buffers: infinite,
            canvas_scale: 1.0,
            canvas_pan_offset: (0.0, 0.0),
            population: None,
        }
    }

    fn all_three(net: &Network) -> Vec<Result<String, FiniteMarkovExportError>> {
        vec![
            generic_ctmc(net, "t", &GenericCtmcOptions::default()),
            decomposition(net, "t", Blocking::Loss, &DecompositionOptions::default()),
            truncated_infinite_ctmc(net, "t", &TruncatedCtmcOptions::default()),
        ]
    }

    fn refusals(net: &Network) -> Vec<String> {
        all_three(net).into_iter().map(|r| r.unwrap_err().message()).collect()
    }

    #[test]
    fn a_network_without_stations_is_refused_by_all_three() {
        let mut net = mm1(true);
        net.nodes.retain(|n| n.kind != NodeKind::Station);
        assert_eq!(refusals(&net), vec!["The network has no service stations."; 3]);
    }

    #[test]
    fn a_network_without_sources_is_refused_by_all_three() {
        let mut net = mm1(true);
        net.nodes.retain(|n| n.kind != NodeKind::Source);
        assert_eq!(refusals(&net), vec!["The network has no external arrival source."; 3]);
    }

    #[test]
    fn a_station_without_a_buffer_has_no_capacity() {
        let mut net = mm1(false);
        net.links[0].to = "s1".into();
        net.links.remove(1);
        let e = generic_ctmc(&net, "t", &GenericCtmcOptions::default()).unwrap_err();
        assert_eq!(e.message(), "S1 needs exactly one upstream buffer so its finite capacity is defined.");
        // The truncated CTMC does not need buffers.
        net.infinite_buffers = true;
        assert!(truncated_infinite_ctmc(&net, "t", &TruncatedCtmcOptions::default()).is_ok());
    }

    #[test]
    fn a_station_with_two_buffers_has_no_single_capacity() {
        let mut net = mm1(false);
        net.nodes.push(node("b2", NodeKind::Buffer, "B2"));
        net.links.push(link("b2", "s1", 1.0));
        let e = decomposition(&net, "t", Blocking::Bas, &DecompositionOptions::default()).unwrap_err();
        assert_eq!(
            e.message(),
            "S1 has more than one upstream buffer; the finite Markov solvers require one total capacity per station."
        );
    }

    #[test]
    fn a_non_poisson_source_is_refused_with_its_family_name() {
        let mut net = mm1(true);
        net.nodes[0].distribution = Distribution::Constant;
        net.nodes[0].parameters = "value=1.0".into();
        assert_eq!(
            refusals(&net),
            vec!["Src1 uses Deterministic arrivals. The finite Markov solvers require a Poisson process (Poisson or exponential inter-arrivals)."; 3]
        );
    }

    #[test]
    fn a_source_without_a_positive_finite_rate_is_refused() {
        for params in ["lambda=0", "lambda=-1", "lambda=inf", "lambda=nan", "rate=1.0", ""] {
            let mut net = mm1(true);
            net.nodes[0].parameters = params.into();
            assert_eq!(refusals(&net), vec!["Src1 does not contain a positive finite arrival rate."; 3], "{params}");
        }
        // An exponential source reads `rate`.
        let mut net = mm1(true);
        net.nodes[0].distribution = Distribution::Exponential;
        net.nodes[0].parameters = "rate=1.0".into();
        assert!(all_three(&net).iter().all(|r| r.is_ok()));
    }

    #[test]
    fn a_source_that_reaches_no_station_is_unresolved() {
        let mut net = mm1(true);
        net.links[0].to = "k".into();
        assert_eq!(refusals(&net), vec!["Src1 does not route to any service station."; 3]);
        // A link of probability 0 does not count either.
        let mut net = mm1(true);
        net.links[0].probability = 0.0;
        assert_eq!(refusals(&net), vec!["Src1 does not route to any service station."; 3]);
    }

    #[test]
    fn a_non_exponential_station_is_refused_with_the_class_and_family() {
        let mut net = mm1(true);
        net.nodes[2].distribution = Distribution::Erlang;
        assert_eq!(refusals(&net), vec!["S1, Class 1 uses Erlang service. This method requires exponential service times."; 3]);
    }

    #[test]
    fn a_station_without_a_positive_finite_service_rate_is_refused() {
        let mut net = mm1(true);
        net.nodes[2].parameters = "rate=0".into();
        assert_eq!(refusals(&net), vec!["S1, Class 1 does not contain a positive finite exponential service rate."; 3]);
        // A per-class law overrides the station's own.
        let mut net = mm1(true);
        net.nodes[2].service_by_class.insert(0, ServiceConfig { distribution: Distribution::Exponential, parameters: "mu=3".into() });
        assert_eq!(refusals(&net), vec!["S1, Class 1 does not contain a positive finite exponential service rate."; 3]);
    }

    #[test]
    fn routing_above_one_is_refused_with_seven_significant_digits() {
        let mut net = mm1(true);
        net.nodes.push(node("k2", NodeKind::Sink, "Sink2"));
        net.links.push(link("s1", "k2", 0.123456789));
        assert_eq!(refusals(&net), vec!["Routing probabilities from S1 for Class 1 total 1.123457, above 1."; 3]);
        // Within the 1e-9 tolerance it passes.
        net.links.last_mut().unwrap().probability = 5e-10;
        assert!(all_three(&net).iter().all(|r| r.is_ok()));
    }

    #[test]
    fn the_truncated_ctmc_needs_infinite_buffers_and_one_class() {
        let net = mm1(false);
        assert_eq!(
            truncated_infinite_ctmc(&net, "t", &TruncatedCtmcOptions::default()).unwrap_err().message(),
            "This adaptive CTMC method is defined for infinite-buffer networks."
        );
        let single = "The adaptive truncated CTMC currently supports one customer class with no class transitions.";
        let mut net = mm1(true);
        net.links[2].to_class = Some(1);
        assert_eq!(truncated_infinite_ctmc(&net, "t", &TruncatedCtmcOptions::default()).unwrap_err().message(), single);
        let mut net = mm1(true);
        net.nodes[2].service_by_class.insert(1, ServiceConfig { distribution: Distribution::Exponential, parameters: "rate=1".into() });
        assert_eq!(truncated_infinite_ctmc(&net, "t", &TruncatedCtmcOptions::default()).unwrap_err().message(), single);
    }

    #[test]
    fn an_overflowing_rate_is_an_encoding_refusal_where_0_90_34_stopped() {
        let mut net = mm1(true);
        net.nodes[0].parameters = "lambda=1e308".into();
        net.links[0].probability = 10.0;
        let want = "The finite Markov input could not be encoded: Invalid number value (infinite) in JSON write";
        assert_eq!(refusals(&net), vec![want; 3]);
    }

    #[test]
    fn options_reach_the_solver_blocks() {
        let net = mm1(true);
        let g = generic_ctmc(&net, "t", &GenericCtmcOptions { max_states: 7, tolerance: 0.1 }).unwrap();
        assert!(g.contains("\"solver\" : {\n    \"max_iterations\" : 200000,\n    \"max_states\" : 7,\n    \"tolerance\" : 0.10000000000000001\n  }"), "{g}");
        let d = decomposition(&net, "t", Blocking::BasExternalLoss, &DecompositionOptions { tolerance: 1e-3, max_iterations: 5, damping: 1.0 }).unwrap();
        assert!(d.contains("\"blocking\" : \"bas_external_loss\""));
        assert!(d.contains("\"solver\" : {\n    \"damping\" : 1,\n    \"max_iterations\" : 5,\n    \"tolerance\" : 0.001\n  }"), "{d}");
        // initial cap at least 1, max cap at least the initial one, max states at least 1.
        let t = truncated_infinite_ctmc(&net, "t", &TruncatedCtmcOptions { initial_total_cap: 0, max_total_cap: -3, max_states: 0 }).unwrap();
        assert!(t.contains("\"initial_total_cap\" : 1,") && t.contains("\"max_total_cap\" : 0,") && t.contains("\"max_states\" : 1,"), "{t}");
        let t = truncated_infinite_ctmc(&net, "t", &TruncatedCtmcOptions { initial_total_cap: 100, max_total_cap: 64, max_states: 9 }).unwrap();
        assert!(t.contains("\"initial_total_cap\" : 100,") && t.contains("\"max_total_cap\" : 100,") && t.contains("\"max_states\" : 9,"), "{t}");
    }

    #[test]
    fn a_class_change_on_a_source_link_puts_the_arrival_in_the_exit_class() {
        let mut net = mm1(false);
        net.links[0].to_class = Some(1);
        let d = decomposition(&net, "t", Blocking::Loss, &DecompositionOptions::default()).unwrap();
        assert!(d.contains("\"external_arrivals\" : {\n\n      },\n      \"id\" : \"c1\""), "{d}");
        assert!(d.contains("\"external_arrivals\" : {\n        \"s1\" : 1\n      },\n      \"id\" : \"c2\",\n      \"name\" : \"Class 2\""), "{d}");
    }

    #[test]
    fn blocking_names_are_the_solver_words() {
        for b in [Blocking::Loss, Blocking::Bas, Blocking::BasExternalLoss] {
            assert_eq!(Blocking::from_solver_name(b.solver_name()), Some(b));
        }
        assert_eq!(Blocking::from_solver_name("drop"), None);
    }

    /// The order JSONSerialization's .sortedKeys gave the keys these documents use and the station
    /// and class ids (two probe documents, run on macOS 27.2).
    #[test]
    fn every_key_sorts_as_foundation_sorted_it() {
        let fields = [
            "blocking", "boundary_mass_tolerance", "capacity", "class", "classes", "damping", "destinations", "exit",
            "external_arrival_rate", "external_arrivals", "from", "from_class", "from_station", "growth_factor", "id",
            "include_state_probabilities", "initial_total_cap", "max_iterations", "max_states", "max_total_cap",
            "minimum_cap_increment", "name", "nodes", "probability", "process", "rate", "refinement_relative_tolerance", "routes",
            "routing", "routing_tolerance", "schema_version", "servers", "service_discipline", "service_rate_per_server",
            "service_rates", "solver", "stability_tolerance", "station", "stationary_max_iterations", "stationary_tolerance",
            "stations", "tail_levels", "to", "to_class", "tolerance", "top_state_count",
        ];
        let ids = [
            "c1", "c2", "c3", "c9", "c10", "c11", "c19", "c20", "c21", "c100", "s1", "s2", "s3", "s9", "s10", "s11", "s19", "s20",
            "s21", "s100",
        ];
        for want in [&fields[..], &ids[..]] {
            let mut got: Vec<&str> = want.iter().rev().copied().collect();
            got.sort_by(|a, b| json::ns_key_order(a, b));
            assert_eq!(got, want);
        }
    }
}
