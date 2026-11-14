//! The exact open product-form input (BNApf's `solver.py` with `model_type` `open_bcmp`), 0.90.34
//! `ProductFormExporter.swift`.
//!
//! Exact open FCFS BCMP/Jackson analysis needs what the regenerative simulation needs, Poisson
//! arrivals, exponential service with one rate per station, class-preserving Markov routing, and
//! also infinite queues. So, as in 0.90.34, this exporter first refuses the two topologies the
//! source/sink translation would otherwise hide (a route out of a sink, a route into a source),
//! then runs the regenerative exporter as the shared strict validator, decodes its document
//! again, and rewrites it: per class only the stations it can reach, mean service times
//! 1/rate, routing rows as lists with their exit probability. A refusal from the shared
//! validator is reworded for this method ("Exact open product form requires …").
//!
//! The document is `JSONEncoder` with `[.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]`.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::json::{self, Json};
use crate::model::{Network, Node, NodeKind};
use crate::naming;

use super::regenerative::{self, StrictNetwork};

/// The default server safety limit (0.90.34 `defaultMaximumServers`).
pub const DEFAULT_MAXIMUM_SERVERS: i64 = 100_000;

/// Why the network has no exact open product-form input (0.90.34 `ProductFormExportError`).
#[derive(Clone, Debug, PartialEq)]
pub enum ProductFormError {
    FiniteBuffers,
    /// The limit given.
    InvalidMaximumServers(i64),
    /// Station, its servers, the limit.
    ServerLimit(String, i64, i64),
    UnvisitedStation(String),
    /// Sink, the node it routes to.
    OutgoingFromSink(String, String),
    /// Origin, the source it routes into.
    IncomingToSource(String, String),
    /// The shared validator's sentence, reworded for product form.
    UnsupportedModel(String),
    InternalContract(String),
    Encoding(String),
}

impl ProductFormError {
    /// The sentence 0.90.34 showed (`errorDescription`).
    pub fn message(&self) -> String {
        use ProductFormError::*;
        match self {
            FiniteBuffers => "Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method.".into(),
            InvalidMaximumServers(v) => format!("The product-form server safety limit is {v}. Set it to a positive integer."),
            ServerLimit(station, count, limit) => format!(
                "{station} has {count} servers, above the product-form safety limit of {limit}. Raise the explicit limit only if an O(servers) Erlang-C normalization is acceptable."
            ),
            UnvisitedStation(station) => format!(
                "{station} is not reachable from any external arrival class. Connect it to an active route or remove it before exact product-form analysis."
            ),
            OutgoingFromSink(sink, destination) => format!(
                "Exit sink {sink} has a positive-probability route to {destination}. Product form treats a sink as final departure; delete that outgoing route."
            ),
            IncomingToSource(origin, source) => format!(
                "The route from {origin} enters source {source}. External sources may create customers but cannot receive routed customers; route to a station or sink instead."
            ),
            UnsupportedModel(message) => message.clone(),
            InternalContract(message) => format!("The strict queue-model adapter produced inconsistent intermediate data: {message}"),
            Encoding(message) => format!("The exact open product-form input could not be encoded: {message}"),
        }
    }
}

/// The shared validator's sentence at this method's level (0.90.34 `productFormMessage`).
fn product_form_message(original: &str) -> String {
    original
        .replace("Regenerative simulation requires", "Exact open product form requires")
        .replace("Regenerative simulation currently requires", "Exact open product form requires")
        .replace("regenerative steady state requires", "an exact open product-form steady state requires")
        .replace("regenerative simulation input", "exact open product-form input")
}

/// Swift's `max(x, y)` and `min(x, y)` on Doubles.
fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

fn swift_min(x: f64, y: f64) -> f64 {
    if y < x {
        y
    } else {
        x
    }
}

/// Writes the exact open product-form input for `net`, named `name` (trimmed), with the server
/// safety limit `maximum_servers` (0.90.34 `ProductFormExporter.export`; the app passes
/// `DEFAULT_MAXIMUM_SERVERS`).
pub fn export(net: &Network, name: &str, maximum_servers: i64) -> Result<String, ProductFormError> {
    export_from(net, name, maximum_servers, || regenerative::export(net, name, &regenerative::Options::default()).map_err(|e| e.message()))
}

/// `export` with the shared validator's result supplied by `strict` (its document, or its
/// sentence), so the adapter can be checked on its own as 0.90.34's harness did.
fn export_from(
    net: &Network,
    name: &str,
    maximum_servers: i64,
    strict: impl FnOnce() -> Result<String, String>,
) -> Result<String, ProductFormError> {
    use ProductFormError as E;
    if !net.infinite_buffers {
        return Err(E::FiniteBuffers);
    }
    if maximum_servers <= 0 {
        return Err(E::InvalidMaximumServers(maximum_servers));
    }

    // These two topologies would otherwise disappear in the source/sink translation.
    let mut by_id: HashMap<&str, &Node> = HashMap::new();
    for n in &net.nodes {
        by_id.entry(n.id.as_str()).or_insert(n);
    }
    for link in net.links.iter().filter(|l| l.probability > 0.0) {
        let (Some(origin), Some(destination)) = (by_id.get(link.from.as_str()), by_id.get(link.to.as_str())) else {
            continue;
        };
        if origin.kind == NodeKind::Sink {
            return Err(E::OutgoingFromSink(origin.name.clone(), destination.name.clone()));
        }
        if destination.kind == NodeKind::Source {
            return Err(E::IncomingToSource(origin.name.clone(), destination.name.clone()));
        }
    }

    let text = strict().map_err(|m| E::UnsupportedModel(product_form_message(&m)))?;
    let strict: StrictNetwork = regenerative::decode_strict(&text).map_err(E::InternalContract)?;

    if strict.nodes.is_empty() || strict.classes.is_empty() {
        return Err(E::InternalContract("the station or class list is empty".into()));
    }
    let station_ids: Vec<&str> = strict.nodes.iter().map(|n| n.id.as_str()).collect();
    let station_set: BTreeSet<&str> = station_ids.iter().copied().collect();
    let class_ids: Vec<&str> = strict.classes.iter().map(|c| c.id.as_str()).collect();
    if station_set.len() != station_ids.len() {
        return Err(E::InternalContract("station identifiers are not unique".into()));
    }
    if class_ids.iter().collect::<BTreeSet<_>>().len() != class_ids.len() {
        return Err(E::InternalContract("class identifiers are not unique".into()));
    }
    let valid_p = |p: f64| p.is_finite() && p > 0.0 && p <= 1.0;

    // open_bcmp rejects routing rows a class cannot reach, so only reachable rows are written.
    let mut reachable_by_class: HashMap<&str, BTreeSet<String>> = HashMap::new();
    for class in &strict.classes {
        if class.external_arrival_rates.is_empty()
            || !class.external_arrival_rates.values().all(|r| r.is_finite() && *r > 0.0)
            || !class.external_arrival_rates.keys().all(|k| station_set.contains(k.as_str()))
        {
            return Err(E::InternalContract(format!("class {} has invalid external arrival rates", class.id)));
        }
        if !class.routing.keys().all(|k| station_set.contains(k.as_str())) {
            return Err(E::InternalContract(format!("class {} has a routing row for an unknown station", class.id)));
        }
        // 0.90.34 walked a Set in hash order; the set reached is the same in any order.
        let mut reachable: BTreeSet<String> = class.external_arrival_rates.keys().cloned().collect();
        let mut frontier: Vec<String> = reachable.iter().cloned().collect();
        let empty = BTreeMap::new();
        while let Some(source) = frontier.pop() {
            let destinations = class.routing.get(&source).unwrap_or(&empty);
            if !destinations.keys().all(|k| station_set.contains(k.as_str())) || !destinations.values().all(|p| valid_p(*p)) {
                return Err(E::InternalContract(format!("class {} has invalid routing from {source}", class.id)));
            }
            for destination in destinations.keys() {
                if reachable.insert(destination.clone()) {
                    frontier.push(destination.clone());
                }
            }
        }
        reachable_by_class.insert(class.id.as_str(), reachable);
    }

    let export_order = naming::in_export_order(net.nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);
    let display_name = |index: usize| export_order.get(index).map_or_else(|| station_ids[index].to_string(), |n| n.name.clone());
    if let Some(unvisited) = station_ids.iter().position(|id| !reachable_by_class.values().any(|r| r.contains(*id))) {
        return Err(E::UnvisitedStation(display_name(unvisited)));
    }

    let mut stations = Vec::new();
    for (index, node) in strict.nodes.iter().enumerate() {
        if !(node.servers > 0 && node.service_rate.is_finite() && node.service_rate > 0.0) {
            return Err(E::InternalContract(format!("station {} has invalid servers or service rate", node.id)));
        }
        if node.servers > maximum_servers {
            return Err(E::ServerLimit(display_name(index), node.servers, maximum_servers));
        }
        let mean_service_time = 1.0 / node.service_rate;
        if !(mean_service_time.is_finite() && mean_service_time > 0.0) {
            return Err(E::InternalContract(format!("station {} has a non-finite mean service time", node.id)));
        }
        let times: BTreeMap<String, Json> = class_ids
            .iter()
            .filter(|c| reachable_by_class.get(*c).is_some_and(|r| r.contains(&node.id)))
            .map(|c| (c.to_string(), Json::num(mean_service_time)))
            .collect();
        let mut m = BTreeMap::new();
        m.insert("id".to_string(), Json::str(node.id.clone()));
        m.insert("type".to_string(), Json::str("fcfs"));
        m.insert("servers".to_string(), Json::int(node.servers));
        m.insert("service_times".to_string(), Json::Object(times));
        stations.push(Json::Object(m));
    }

    let mut classes = Vec::new();
    for class in &strict.classes {
        let reachable = &reachable_by_class[class.id.as_str()];
        let mut rows = Vec::new();
        let empty = BTreeMap::new();
        for &station in station_ids.iter().filter(|s| reachable.contains(**s)) {
            let raw = class.routing.get(station).unwrap_or(&empty);
            if !raw.keys().all(|k| station_set.contains(k.as_str())) || !raw.values().all(|p| valid_p(*p)) {
                return Err(E::InternalContract(format!("class {} has invalid routing from {station}", class.id)));
            }
            // 0.90.34 summed a Dictionary's values in hash order; with up to two destinations
            // (all the corpus has) any order gives the same sum. Here: station order.
            let mut internal = 0.0;
            for id in &station_ids {
                if let Some(p) = raw.get(*id) {
                    internal += p;
                }
            }
            if !(internal.is_finite() && internal <= 1.0 + 1e-12) {
                return Err(E::InternalContract(format!("class {} routing from {station} exceeds one", class.id)));
            }
            let exit_probability = swift_max(0.0, swift_min(1.0, 1.0 - internal));
            let destinations: Vec<Json> = station_ids
                .iter()
                .filter_map(|id| {
                    raw.get(*id).map(|p| {
                        let mut d = BTreeMap::new();
                        d.insert("station".to_string(), Json::str(*id));
                        d.insert("probability".to_string(), Json::num(*p));
                        Json::Object(d)
                    })
                })
                .collect();
            let mut row = BTreeMap::new();
            row.insert("from_station".to_string(), Json::str(station));
            row.insert("destinations".to_string(), Json::Array(destinations));
            row.insert("exit_probability".to_string(), Json::num(exit_probability));
            rows.push(Json::Object(row));
        }
        let mut m = BTreeMap::new();
        m.insert("id".to_string(), Json::str(class.id.clone()));
        m.insert(
            "external_arrival_rates".to_string(),
            Json::Object(class.external_arrival_rates.iter().map(|(k, v)| (k.clone(), Json::num(*v))).collect()),
        );
        m.insert("routing".to_string(), Json::Array(rows));
        classes.push(Json::Object(m));
    }

    let mut solver = BTreeMap::new();
    solver.insert("max_servers".to_string(), Json::int(maximum_servers));
    let mut doc = BTreeMap::new();
    doc.insert("schema_version".to_string(), Json::int(1));
    doc.insert("model_type".to_string(), Json::str("open_bcmp"));
    doc.insert("name".to_string(), Json::str(regenerative::trim_name(name)));
    doc.insert(
        "description".to_string(),
        Json::str("Exact open FCFS BCMP/Jackson model exported from Qnet; M/M/c local factors are normalized analytically without state-space truncation."),
    );
    doc.insert("stations".to_string(), Json::Array(stations));
    doc.insert("classes".to_string(), Json::Array(classes));
    doc.insert("solver".to_string(), Json::Object(solver));
    Ok(json::to_pretty_unescaped_slashes(&Json::Object(doc)) + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Link;

    // 0.90.34's headless harness (validation/product_form_exporter/main.swift with its
    // stubs.swift) replaced `RegenerativeExporter` by a stub returning a fixed strict document,
    // so the adapter is checked on its own; `export_from` takes that document the same way.
    // The expected documents are what that harness wrote when built and run on 0.90.34's
    // ProductFormExporter.swift.

    fn node(id: &str, kind: NodeKind, name: &str) -> Node {
        Node::new(id, kind, name, (0.0, 0.0))
    }

    fn editor(infinite: bool, nodes: Vec<Node>, links: Vec<Link>) -> Network {
        Network { nodes, links, infinite_buffers: infinite, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
    }

    fn stations() -> Vec<Node> {
        vec![node("A", NodeKind::Station, "Intake"), node("B", NodeKind::Station, "Service")]
    }

    const STRICT_JSON: &str = r#"{
      "nodes": [
        {"id": "s1", "servers": 2, "service_rate": 2.0, "capacity": null},
        {"id": "s2", "servers": 1, "service_rate": 4.0, "capacity": null}
      ],
      "classes": [
        {
          "id": "c1",
          "external_arrival_rates": {"s1": 0.8},
          "routing": {"s1": {"s2": 0.5}, "s2": {}}
        },
        {
          "id": "c2",
          "external_arrival_rates": {"s1": 0.2},
          "routing": {"s1": {"s2": 0.5}, "s2": {}}
        }
      ]
    }"#;

    const DISJOINT_JSON: &str = r#"{
      "nodes": [
        {"id": "s1", "servers": 2, "service_rate": 2.0, "capacity": null},
        {"id": "s2", "servers": 1, "service_rate": 4.0, "capacity": null}
      ],
      "classes": [
        {
          "id": "c1",
          "external_arrival_rates": {"s1": 0.8},
          "routing": {"s1": {}, "s2": {}}
        },
        {
          "id": "c2",
          "external_arrival_rates": {"s2": 0.2},
          "routing": {"s1": {}, "s2": {}}
        }
      ]
    }"#;

    fn run(net: &Network, name: &str, max: i64, strict: &str) -> Result<String, ProductFormError> {
        export_from(net, name, max, || {
            if strict == "UNSUPPORTED" {
                Err("Regenerative simulation requires exponential FCFS service.".into())
            } else {
                Ok(strict.to_string())
            }
        })
    }

    fn refusal(strict: &str) -> String {
        run(&editor(true, stations(), vec![]), "x", DEFAULT_MAXIMUM_SERVERS, strict).unwrap_err().message()
    }

    #[test]
    fn harness_two_classes_through_an_mm2_are_written_as_0_90_34_wrote_them() {
        let out = run(&editor(true, stations(), vec![]), "Exporter check", DEFAULT_MAXIMUM_SERVERS, STRICT_JSON).unwrap();
        assert_eq!(out, HARNESS_PRIMARY);
        // The harness's own checks: servers kept, rates inverted, implicit and terminal exits.
        let root = json::parse(&out).unwrap();
        let s = root.as_object().unwrap()["stations"].as_array().unwrap();
        assert_eq!(s[0].as_object().unwrap()["servers"].as_i64(), Some(2));
        let times = s[0].as_object().unwrap()["service_times"].as_object().unwrap();
        assert_eq!((times["c1"].as_f64(), times["c2"].as_f64()), (Some(0.5), Some(0.5)));
        let c = root.as_object().unwrap()["classes"].as_array().unwrap();
        let rows = c[0].as_object().unwrap()["routing"].as_array().unwrap();
        assert_eq!(rows[0].as_object().unwrap()["exit_probability"].as_f64(), Some(0.5));
        assert_eq!(rows[1].as_object().unwrap()["exit_probability"].as_f64(), Some(1.0));
    }

    #[test]
    fn harness_disjoint_classes_get_only_the_stations_they_reach() {
        let out = run(&editor(true, stations(), vec![]), "Disjoint", DEFAULT_MAXIMUM_SERVERS, DISJOINT_JSON).unwrap();
        assert_eq!(out, HARNESS_DISJOINT);
    }

    #[test]
    fn harness_a_finite_buffer_model_is_refused() {
        let finite = editor(false, vec![node("A", NodeKind::Station, "Intake")], vec![]);
        assert_eq!(
            run(&finite, "finite", DEFAULT_MAXIMUM_SERVERS, STRICT_JSON).unwrap_err().message(),
            "Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method."
        );
    }

    #[test]
    fn harness_the_server_safety_limit_is_enforced() {
        assert_eq!(
            run(&editor(true, stations(), vec![]), "limit", 1, STRICT_JSON).unwrap_err().message(),
            "Intake has 2 servers, above the product-form safety limit of 1. Raise the explicit limit only if an O(servers) Erlang-C normalization is acceptable."
        );
    }

    #[test]
    fn harness_a_route_out_of_a_sink_is_not_silently_discarded() {
        let nodes = vec![node("A", NodeKind::Station, "Intake"), node("X", NodeKind::Sink, "Exit")];
        let link = Link { id: "L".into(), from: "X".into(), to: "A".into(), probability: 0.1, class: 0, to_class: None };
        assert_eq!(
            run(&editor(true, nodes, vec![link]), "bad", DEFAULT_MAXIMUM_SERVERS, STRICT_JSON).unwrap_err().message(),
            "Exit sink Exit has a positive-probability route to Intake. Product form treats a sink as final departure; delete that outgoing route."
        );
    }

    #[test]
    fn harness_the_shared_validator_s_refusal_is_reworded_for_product_form() {
        assert_eq!(refusal("UNSUPPORTED"), "Exact open product form requires exponential FCFS service.");
    }

    #[test]
    fn every_shared_wording_is_reworded() {
        assert_eq!(
            product_form_message(
                "a Regenerative simulation currently requires b; regenerative steady state requires c; the regenerative simulation input"
            ),
            "a Exact open product form requires b; an exact open product-form steady state requires c; the exact open product-form input"
        );
    }

    #[test]
    fn a_zero_server_limit_is_refused() {
        assert_eq!(
            run(&editor(true, stations(), vec![]), "x", 0, STRICT_JSON).unwrap_err().message(),
            "The product-form server safety limit is 0. Set it to a positive integer."
        );
    }

    #[test]
    fn a_route_into_a_source_is_refused_before_the_shared_validator() {
        let nodes = vec![node("A", NodeKind::Station, "Intake"), node("S", NodeKind::Source, "Arrivals")];
        let link = Link { id: "L".into(), from: "A".into(), to: "S".into(), probability: 0.5, class: 0, to_class: None };
        assert_eq!(
            run(&editor(true, nodes, vec![link]), "x", DEFAULT_MAXIMUM_SERVERS, "UNSUPPORTED").unwrap_err().message(),
            "The route from Intake enters source Arrivals. External sources may create customers but cannot receive routed customers; route to a station or sink instead."
        );
    }

    #[test]
    fn an_unreached_station_is_named_by_its_canvas_name() {
        let strict = r#"{"nodes":[{"id":"s1","servers":1,"service_rate":2},{"id":"s2","servers":1,"service_rate":2}],
            "classes":[{"id":"c1","external_arrival_rates":{"s1":1},"routing":{"s1":{},"s2":{}}}]}"#;
        assert_eq!(
            refusal(strict),
            "Service is not reachable from any external arrival class. Connect it to an active route or remove it before exact product-form analysis."
        );
    }

    macro_rules! contract {
        ($test:ident, $strict:expr, $detail:literal) => {
            #[test]
            fn $test() {
                assert_eq!(refusal($strict), concat!("The strict queue-model adapter produced inconsistent intermediate data: ", $detail));
            }
        };
    }

    contract!(an_undecodable_document_breaks_the_contract, r#"{"nodes":[]}"#, "The data couldn\u{2019}t be read because it is missing.");
    contract!(an_empty_station_list_breaks_the_contract, r#"{"nodes":[],"classes":[]}"#, "the station or class list is empty");
    contract!(
        repeated_station_ids_break_the_contract,
        r#"{"nodes":[{"id":"s1","servers":1,"service_rate":1},{"id":"s1","servers":1,"service_rate":1}],"classes":[{"id":"c1","external_arrival_rates":{"s1":1},"routing":{}}]}"#,
        "station identifiers are not unique"
    );
    contract!(
        repeated_class_ids_break_the_contract,
        r#"{"nodes":[{"id":"s1","servers":1,"service_rate":1}],"classes":[{"id":"c1","external_arrival_rates":{"s1":1},"routing":{}},{"id":"c1","external_arrival_rates":{"s1":1},"routing":{}}]}"#,
        "class identifiers are not unique"
    );
    contract!(
        an_arrival_at_an_unknown_station_breaks_the_contract,
        r#"{"nodes":[{"id":"s1","servers":1,"service_rate":1}],"classes":[{"id":"c1","external_arrival_rates":{"s9":1},"routing":{}}]}"#,
        "class c1 has invalid external arrival rates"
    );
    contract!(
        a_routing_row_for_an_unknown_station_breaks_the_contract,
        r#"{"nodes":[{"id":"s1","servers":1,"service_rate":1}],"classes":[{"id":"c1","external_arrival_rates":{"s1":1},"routing":{"s9":{}}}]}"#,
        "class c1 has a routing row for an unknown station"
    );
    contract!(
        a_zero_routing_probability_breaks_the_contract,
        r#"{"nodes":[{"id":"s1","servers":1,"service_rate":1}],"classes":[{"id":"c1","external_arrival_rates":{"s1":1},"routing":{"s1":{"s1":0}}}]}"#,
        "class c1 has invalid routing from s1"
    );
    contract!(
        zero_servers_break_the_contract,
        r#"{"nodes":[{"id":"s1","servers":0,"service_rate":1}],"classes":[{"id":"c1","external_arrival_rates":{"s1":1},"routing":{}}]}"#,
        "station s1 has invalid servers or service rate"
    );
    contract!(
        a_subnormal_rate_breaks_the_contract,
        r#"{"nodes":[{"id":"s1","servers":1,"service_rate":5e-324}],"classes":[{"id":"c1","external_arrival_rates":{"s1":1},"routing":{}}]}"#,
        "station s1 has a non-finite mean service time"
    );
    contract!(
        a_row_above_one_breaks_the_contract,
        r#"{"nodes":[{"id":"s1","servers":1,"service_rate":1},{"id":"s2","servers":1,"service_rate":1}],"classes":[{"id":"c1","external_arrival_rates":{"s1":1},"routing":{"s1":{"s1":0.75,"s2":0.75}}}]}"#,
        "class c1 routing from s1 exceeds one"
    );

    #[test]
    fn the_encoding_sentence_is_0_90_34_s() {
        assert_eq!(
            ProductFormError::Encoding("UTF-8 conversion failed.".into()).message(),
            "The exact open product-form input could not be encoded: UTF-8 conversion failed."
        );
    }

    /// What 0.90.34's harness wrote for `strict_json` (validation/product_form_exporter, run on 0.90.34's ProductFormExporter.swift).
    const HARNESS_PRIMARY: &str = r#"{
  "classes" : [
    {
      "external_arrival_rates" : {
        "s1" : 0.8
      },
      "id" : "c1",
      "routing" : [
        {
          "destinations" : [
            {
              "probability" : 0.5,
              "station" : "s2"
            }
          ],
          "exit_probability" : 0.5,
          "from_station" : "s1"
        },
        {
          "destinations" : [

          ],
          "exit_probability" : 1,
          "from_station" : "s2"
        }
      ]
    },
    {
      "external_arrival_rates" : {
        "s1" : 0.2
      },
      "id" : "c2",
      "routing" : [
        {
          "destinations" : [
            {
              "probability" : 0.5,
              "station" : "s2"
            }
          ],
          "exit_probability" : 0.5,
          "from_station" : "s1"
        },
        {
          "destinations" : [

          ],
          "exit_probability" : 1,
          "from_station" : "s2"
        }
      ]
    }
  ],
  "description" : "Exact open FCFS BCMP/Jackson model exported from Qnet; M/M/c local factors are normalized analytically without state-space truncation.",
  "model_type" : "open_bcmp",
  "name" : "Exporter check",
  "schema_version" : 1,
  "solver" : {
    "max_servers" : 100000
  },
  "stations" : [
    {
      "id" : "s1",
      "servers" : 2,
      "service_times" : {
        "c1" : 0.5,
        "c2" : 0.5
      },
      "type" : "fcfs"
    },
    {
      "id" : "s2",
      "servers" : 1,
      "service_times" : {
        "c1" : 0.25,
        "c2" : 0.25
      },
      "type" : "fcfs"
    }
  ]
}
"#;

    /// What it wrote for `disjoint_json`.
    const HARNESS_DISJOINT: &str = r#"{
  "classes" : [
    {
      "external_arrival_rates" : {
        "s1" : 0.8
      },
      "id" : "c1",
      "routing" : [
        {
          "destinations" : [

          ],
          "exit_probability" : 1,
          "from_station" : "s1"
        }
      ]
    },
    {
      "external_arrival_rates" : {
        "s2" : 0.2
      },
      "id" : "c2",
      "routing" : [
        {
          "destinations" : [

          ],
          "exit_probability" : 1,
          "from_station" : "s2"
        }
      ]
    }
  ],
  "description" : "Exact open FCFS BCMP/Jackson model exported from Qnet; M/M/c local factors are normalized analytically without state-space truncation.",
  "model_type" : "open_bcmp",
  "name" : "Disjoint",
  "schema_version" : 1,
  "solver" : {
    "max_servers" : 100000
  },
  "stations" : [
    {
      "id" : "s1",
      "servers" : 2,
      "service_times" : {
        "c1" : 0.5
      },
      "type" : "fcfs"
    },
    {
      "id" : "s2",
      "servers" : 1,
      "service_times" : {
        "c2" : 0.25
      },
      "type" : "fcfs"
    }
  ]
}
"#;
}
