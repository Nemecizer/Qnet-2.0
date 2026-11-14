//! The exact matrix-analytic QBD input (BNAqbd's `qbd_solver.py` and `bna_qbd`), 0.90.34
//! `QBDExporter.swift`.
//!
//! Only one network maps exactly onto a scalar, level-independent continuous-time QBD: one
//! source and one single-server exponential station with infinite queue, possibly feeding back
//! to itself with probability p. The level is the number in system; arrivals move it up at rate
//! λ, and only a service completion that does not feed back moves it down, at rate μ(1 − p). As
//! in 0.90.34, the exporter checks that shape, then runs the regenerative exporter as the shared
//! strict validator, decodes its document again and reads λ, μ and p from it. A refusal from the
//! shared validator is reworded for this method ("The exact one-phase QBD mapping requires …").
//!
//! None of the 50 examples has that shape, so the corpus holds only refusals; the success path
//! is checked by 0.90.34's own harness case (an M/M/1 with λ = 1, μ = 4, p = 0.5), ported below.
//!
//! The document is `JSONEncoder` with `[.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]`.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::cfmt;
use crate::json::{self, Json};
use crate::model::{Network, Node, NodeKind};
use crate::naming;

use super::regenerative::{self, StrictNetwork};

/// Why the network has no QBD input (0.90.34 `QBDExportError`).
#[derive(Clone, Debug, PartialEq)]
pub enum QbdError {
    FiniteBuffers,
    /// The number of stations.
    StationCount(i64),
    /// The number of sources.
    SourceCount(i64),
    /// Station, its servers.
    ServerCount(String, i64),
    InvalidOptions(String),
    /// Sink, the node it routes to.
    OutgoingFromSink(String, String),
    /// Origin, the source it routes into.
    IncomingToSource(String, String),
    /// A sentence of its own, or the shared validator's reworded for QBD.
    UnsupportedModel(String),
    InternalContract(String),
    Encoding(String),
}

impl QbdError {
    /// The sentence 0.90.34 showed (`errorDescription`).
    pub fn message(&self) -> String {
        use QbdError::*;
        match self {
            FiniteBuffers => "The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.".into(),
            StationCount(n) => format!(
                "The current QBD adapter supports exactly one service station; this network has {n}. Use product form or another network method for multiple stations."
            ),
            SourceCount(n) => {
                format!("The current QBD adapter supports exactly one external customer class/source; this network has {n}.")
            }
            ServerCount(station, n) => format!(
                "{station} has {n} servers. The current scalar QBD level mapping is exact only for one exponential server (M/M/1)."
            ),
            InvalidOptions(m) => format!("The QBD reporting settings are invalid: {m}"),
            OutgoingFromSink(sink, destination) => format!(
                "Exit sink {sink} routes back to {destination}. A sink must be final departure for the one-queue QBD mapping."
            ),
            IncomingToSource(origin, source) => {
                format!("The route from {origin} enters external source {source}. Route feedback to the station, not to its source.")
            }
            UnsupportedModel(m) => m.clone(),
            InternalContract(m) => format!("The strict M/M/1 adapter produced inconsistent intermediate data: {m}"),
            Encoding(m) => format!("The QBD input could not be encoded: {m}"),
        }
    }
}

/// The solver's reporting settings (0.90.34 `QBDExportOptions`); `Default` is 0.90.34's.
#[derive(Clone, Debug, PartialEq)]
pub struct QbdOptions {
    pub maximum_iterations: i64,
    pub maximum_report_level: i64,
    /// Written deduplicated and sorted.
    pub tail_levels: Vec<i64>,
}

impl Default for QbdOptions {
    fn default() -> Self {
        QbdOptions { maximum_iterations: 100_000, maximum_report_level: 20, tail_levels: vec![0, 1, 2, 5, 10, 20] }
    }
}

fn validate(o: &QbdOptions) -> Option<QbdError> {
    let fail = |m: &str| Some(QbdError::InvalidOptions(m.into()));
    if o.maximum_iterations <= 0 {
        return fail("maximum iterations must be positive.");
    }
    if o.maximum_report_level < 0 {
        return fail("maximum report level cannot be negative.");
    }
    if !o.tail_levels.iter().all(|&t| t >= 0) {
        return fail("tail levels must be nonnegative integers.");
    }
    None
}

/// The shared validator's sentence at this method's level (0.90.34 `qbdMessage`).
fn qbd_message(original: &str) -> String {
    original
        .replace("Regenerative simulation currently requires", "The exact one-phase QBD mapping requires")
        .replace("Regenerative simulation requires", "The exact one-phase QBD mapping requires")
        .replace("regenerative steady state requires", "the exact QBD steady state requires")
        .replace("regenerative simulation input", "QBD input")
}

fn number(v: f64) -> String {
    if v.is_finite() {
        cfmt::f("%.7g", v)
    } else {
        cfmt::swift_description(v)
    }
}

/// Writes the QBD input for `net`, named `name` (trimmed), or refuses it with 0.90.34's sentence
/// (0.90.34 `QBDExporter.export`).
pub fn export(net: &Network, name: &str, options: &QbdOptions) -> Result<String, QbdError> {
    export_from(net, name, options, || regenerative::export(net, name, &regenerative::Options::default()).map_err(|e| e.message()))
}

/// `export` with the shared validator's result supplied by `strict`, as 0.90.34's harness did.
fn export_from(
    net: &Network,
    name: &str,
    options: &QbdOptions,
    strict: impl FnOnce() -> Result<String, String>,
) -> Result<String, QbdError> {
    use QbdError as E;
    if !net.infinite_buffers {
        return Err(E::FiniteBuffers);
    }
    let stations = naming::in_export_order(net.nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);
    if stations.len() != 1 {
        return Err(E::StationCount(stations.len() as i64));
    }
    let sources = net.nodes.iter().filter(|n| n.kind == NodeKind::Source).count();
    if sources != 1 {
        return Err(E::SourceCount(sources as i64));
    }
    if stations[0].servers != 1 {
        return Err(E::ServerCount(stations[0].name.clone(), stations[0].servers));
    }
    if let Some(problem) = validate(options) {
        return Err(problem);
    }

    let ids: BTreeSet<&str> = net.nodes.iter().map(|n| n.id.as_str()).collect();
    if ids.len() != net.nodes.len() {
        return Err(E::InternalContract("the document contains duplicate node identifiers".into()));
    }
    let by_id: HashMap<&str, &Node> = net.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
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

    let text = strict().map_err(|m| E::UnsupportedModel(qbd_message(&m)))?;
    let strict: StrictNetwork = regenerative::decode_strict(&text).map_err(E::InternalContract)?;
    if strict.nodes.len() != 1 || strict.classes.len() != 1 {
        return Err(E::InternalContract("expected one exported station and one exported class".into()));
    }
    let node = &strict.nodes[0];
    let class = &strict.classes[0];
    if !(node.servers == 1 && node.service_rate.is_finite() && node.service_rate > 0.0) {
        return Err(E::InternalContract("invalid exponential service rate".into()));
    }
    let external = match class.external_arrival_rates.get(&node.id) {
        Some(&r) if class.external_arrival_rates.len() == 1 && r.is_finite() && r > 0.0 => r,
        _ => return Err(E::InternalContract("the external arrival rate does not target the sole station".into())),
    };
    let empty = BTreeMap::new();
    let route = class.routing.get(&node.id).unwrap_or(&empty);
    if !route.keys().all(|k| *k == node.id) || !route.values().all(|p| p.is_finite() && *p > 0.0 && *p <= 1.0) {
        return Err(E::InternalContract("routing contains a destination outside the sole station".into()));
    }
    let feedback = route.get(&node.id).copied().unwrap_or(0.0);
    if !(feedback < 1.0) {
        return Err(E::UnsupportedModel("Feedback probability is one, so no customer can depart. Add a positive exit probability.".into()));
    }
    let down = node.service_rate * (1.0 - feedback);
    if !(down.is_finite() && down > 0.0) {
        return Err(E::InternalContract("the non-feedback service-completion rate is not positive and finite".into()));
    }
    let intensity = external / down;
    if !(intensity.is_finite() && intensity < 1.0) {
        return Err(E::UnsupportedModel(format!(
            "The effective M/M/1 load is {}; steady state requires external rate / [service rate \u{d7} (1 \u{2212} feedback)] < 1.",
            number(intensity)
        )));
    }

    let same = -(external + down);
    let one = |v: f64| Json::Array(vec![Json::Array(vec![Json::num(v)])]);
    let mut boundary = BTreeMap::new();
    boundary.insert("level_0_same".to_string(), one(-external));
    boundary.insert("level_0_up".to_string(), one(external));
    boundary.insert("level_1_down".to_string(), one(down));
    boundary.insert("level_1_same".to_string(), one(same));
    let mut interior = BTreeMap::new();
    interior.insert("down".to_string(), one(down));
    interior.insert("same".to_string(), one(same));
    interior.insert("up".to_string(), one(external));
    let tail: BTreeSet<i64> = options.tail_levels.iter().copied().collect();
    let mut solver = BTreeMap::new();
    solver.insert("max_iterations".to_string(), Json::int(options.maximum_iterations));
    solver.insert("max_report_level".to_string(), Json::int(options.maximum_report_level));
    solver.insert("tail_levels".to_string(), Json::Array(tail.into_iter().map(Json::int).collect()));
    let mut doc = BTreeMap::new();
    doc.insert("schema_version".to_string(), Json::int(1));
    doc.insert("process".to_string(), Json::str("continuous_time_qbd"));
    doc.insert("name".to_string(), Json::str(regenerative::trim_name(name)));
    doc.insert("boundary".to_string(), Json::Object(boundary));
    doc.insert("interior".to_string(), Json::Object(interior));
    doc.insert("solver".to_string(), Json::Object(solver));
    Ok(json::to_pretty_unescaped_slashes(&Json::Object(doc)) + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Link;

    // 0.90.34's headless harness (validation/qbd_exporter/main.swift with its stubs.swift)
    // replaced `RegenerativeExporter` by a stub returning a fixed strict document; `export_from`
    // takes that document the same way. The expected document is what that harness wrote when
    // built and run on 0.90.34's QBDExporter.swift; qbd_exporter_check.sh then solved it with
    // qbd_solver.py and found ρ = 0.5 and a mean queue length of 1.

    const STRICT_JSON: &str = r#"{
      "nodes": [
        {"id": "s1", "servers": 1, "service_rate": 4.0, "capacity": null}
      ],
      "classes": [
        {
          "id": "c1",
          "external_arrival_rates": {"s1": 1.0},
          "routing": {"s1": {"s1": 0.5}}
        }
      ]
    }"#;

    fn node(id: &str, kind: NodeKind, name: &str, servers: i64) -> Node {
        let mut n = Node::new(id, kind, name, (0.0, 0.0));
        n.servers = servers;
        n
    }

    fn editor(infinite: bool, nodes: Vec<Node>, links: Vec<Link>) -> Network {
        Network { nodes, links, infinite_buffers: infinite, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
    }

    fn source() -> Node {
        node("A", NodeKind::Source, "Arrivals", 1)
    }

    fn station() -> Node {
        node("B", NodeKind::Station, "Server", 1)
    }

    fn run(net: &Network, name: &str, options: &QbdOptions, strict: &str) -> Result<String, QbdError> {
        export_from(net, name, options, || {
            if strict == "UNSUPPORTED" {
                Err("Regenerative simulation requires exponential FCFS service.".into())
            } else {
                Ok(strict.to_string())
            }
        })
    }

    fn refusal(strict: &str) -> String {
        run(&editor(true, vec![source(), station()], vec![]), "x", &QbdOptions::default(), strict).unwrap_err().message()
    }

    #[test]
    fn harness_a_feedback_mm1_is_written_as_0_90_34_wrote_it() {
        let out = run(&editor(true, vec![source(), station()], vec![]), "Feedback M/M/1", &QbdOptions::default(), STRICT_JSON).unwrap();
        assert_eq!(out, HARNESS_OUTPUT);
        // The harness's own checks: λ up, μ(1 − p) down, −(λ + μ(1 − p)) on the diagonal.
        let root = json::parse(&out).unwrap();
        let m = root.as_object().unwrap();
        assert_eq!(m["schema_version"].as_i64(), Some(1));
        assert_eq!(m["process"].as_str(), Some("continuous_time_qbd"));
        let at = |block: &str, key: &str| m[block].as_object().unwrap()[key].as_array().unwrap()[0].as_array().unwrap()[0].as_f64();
        assert_eq!(at("boundary", "level_0_up"), Some(1.0));
        assert_eq!(at("boundary", "level_1_down"), Some(2.0));
        assert_eq!(at("interior", "same"), Some(-3.0));
    }

    #[test]
    fn harness_a_finite_queue_is_refused() {
        assert_eq!(
            run(&editor(false, vec![source(), station()], vec![]), "finite", &QbdOptions::default(), STRICT_JSON).unwrap_err().message(),
            "The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite."
        );
    }

    #[test]
    fn harness_an_mm2_is_refused() {
        let net = editor(true, vec![source(), node("C", NodeKind::Station, "Pool", 2)], vec![]);
        assert_eq!(
            run(&net, "M/M/2", &QbdOptions::default(), STRICT_JSON).unwrap_err().message(),
            "Pool has 2 servers. The current scalar QBD level mapping is exact only for one exponential server (M/M/1)."
        );
    }

    #[test]
    fn harness_a_two_station_network_is_refused() {
        let net = editor(true, vec![source(), station(), node("D", NodeKind::Station, "Second", 1)], vec![]);
        assert_eq!(
            run(&net, "network", &QbdOptions::default(), STRICT_JSON).unwrap_err().message(),
            "The current QBD adapter supports exactly one service station; this network has 2. Use product form or another network method for multiple stations."
        );
    }

    #[test]
    fn the_shared_validator_s_refusal_is_reworded_for_qbd() {
        assert_eq!(refusal("UNSUPPORTED"), "The exact one-phase QBD mapping requires exponential FCFS service.");
        assert_eq!(
            qbd_message(
                "Regenerative simulation currently requires a; regenerative steady state requires b; regenerative simulation input"
            ),
            "The exact one-phase QBD mapping requires a; the exact QBD steady state requires b; QBD input"
        );
    }

    fn options_refusal(o: QbdOptions) -> String {
        run(&editor(true, vec![source(), station()], vec![]), "x", &o, STRICT_JSON).unwrap_err().message()
    }

    #[test]
    fn zero_iterations_are_refused() {
        assert_eq!(
            options_refusal(QbdOptions { maximum_iterations: 0, ..Default::default() }),
            "The QBD reporting settings are invalid: maximum iterations must be positive."
        );
    }

    #[test]
    fn a_negative_report_level_is_refused() {
        assert_eq!(
            options_refusal(QbdOptions { maximum_report_level: -1, ..Default::default() }),
            "The QBD reporting settings are invalid: maximum report level cannot be negative."
        );
    }

    #[test]
    fn a_negative_tail_level_is_refused() {
        assert_eq!(
            options_refusal(QbdOptions { tail_levels: vec![3, -1], ..Default::default() }),
            "The QBD reporting settings are invalid: tail levels must be nonnegative integers."
        );
    }

    #[test]
    fn tail_levels_are_written_once_each_in_order() {
        let o = QbdOptions { maximum_iterations: 7, maximum_report_level: 0, tail_levels: vec![9, 0, 9, 3] };
        let out = run(&editor(true, vec![source(), station()], vec![]), "x", &o, STRICT_JSON).unwrap();
        assert!(out.ends_with(
            "\"solver\" : {\n    \"max_iterations\" : 7,\n    \"max_report_level\" : 0,\n    \"tail_levels\" : [\n      0,\n      3,\n      9\n    ]\n  }\n}\n"
        ), "{out}");
    }

    #[test]
    fn zero_or_two_sources_are_refused() {
        let none = editor(true, vec![station()], vec![]);
        assert_eq!(
            run(&none, "x", &QbdOptions::default(), STRICT_JSON).unwrap_err().message(),
            "The current QBD adapter supports exactly one external customer class/source; this network has 0."
        );
        let two = editor(true, vec![source(), station(), node("E", NodeKind::Source, "More", 1)], vec![]);
        assert_eq!(
            run(&two, "x", &QbdOptions::default(), STRICT_JSON).unwrap_err().message(),
            "The current QBD adapter supports exactly one external customer class/source; this network has 2."
        );
    }

    #[test]
    fn a_route_into_the_source_is_refused() {
        let link = Link { id: "L".into(), from: "B".into(), to: "A".into(), probability: 0.5, class: 0, to_class: None };
        assert_eq!(
            run(&editor(true, vec![source(), station()], vec![link]), "x", &QbdOptions::default(), STRICT_JSON).unwrap_err().message(),
            "The route from Server enters external source Arrivals. Route feedback to the station, not to its source."
        );
    }

    #[test]
    fn a_sink_routing_back_is_refused() {
        let sink = node("Z", NodeKind::Sink, "Exit", 1);
        let link = Link { id: "L".into(), from: "Z".into(), to: "B".into(), probability: 0.5, class: 0, to_class: None };
        assert_eq!(
            run(&editor(true, vec![source(), station(), sink], vec![link]), "x", &QbdOptions::default(), STRICT_JSON)
                .unwrap_err()
                .message(),
            "Exit sink Exit routes back to Server. A sink must be final departure for the one-queue QBD mapping."
        );
    }

    #[test]
    fn duplicate_node_ids_break_the_contract() {
        let net = editor(true, vec![source(), station(), node("B", NodeKind::Sink, "Exit", 1)], vec![]);
        assert_eq!(
            run(&net, "x", &QbdOptions::default(), STRICT_JSON).unwrap_err().message(),
            "The strict M/M/1 adapter produced inconsistent intermediate data: the document contains duplicate node identifiers"
        );
    }

    fn one_station(rate: &str, servers: &str, external: &str, routing: &str) -> String {
        format!(
            r#"{{"nodes":[{{"id":"s1","servers":{servers},"service_rate":{rate}}}],"classes":[{{"id":"c1","external_arrival_rates":{external},"routing":{routing}}}]}}"#
        )
    }

    #[test]
    fn feedback_with_probability_one_is_refused() {
        assert_eq!(
            refusal(&one_station("4", "1", r#"{"s1":1}"#, r#"{"s1":{"s1":1}}"#)),
            "Feedback probability is one, so no customer can depart. Add a positive exit probability."
        );
    }

    #[test]
    fn an_effective_load_of_one_is_refused() {
        assert_eq!(
            refusal(&one_station("4", "1", r#"{"s1":2}"#, r#"{"s1":{"s1":0.5}}"#)),
            "The effective M/M/1 load is 1; steady state requires external rate / [service rate \u{d7} (1 \u{2212} feedback)] < 1."
        );
    }

    macro_rules! contract {
        ($test:ident, $strict:expr, $detail:literal) => {
            #[test]
            fn $test() {
                assert_eq!(refusal(&$strict), concat!("The strict M/M/1 adapter produced inconsistent intermediate data: ", $detail));
            }
        };
    }

    contract!(
        an_undecodable_document_breaks_the_contract,
        String::from("[]"),
        "The data couldn\u{2019}t be read because it isn\u{2019}t in the correct format."
    );
    contract!(
        two_exported_stations_break_the_contract,
        String::from(r#"{"nodes":[],"classes":[]}"#),
        "expected one exported station and one exported class"
    );
    contract!(two_exported_servers_break_the_contract, one_station("4", "2", r#"{"s1":1}"#, "{}"), "invalid exponential service rate");
    contract!(
        an_arrival_elsewhere_breaks_the_contract,
        one_station("4", "1", r#"{"s2":1}"#, "{}"),
        "the external arrival rate does not target the sole station"
    );
    contract!(
        a_route_elsewhere_breaks_the_contract,
        one_station("4", "1", r#"{"s1":1}"#, r#"{"s1":{"s2":0.5}}"#),
        "routing contains a destination outside the sole station"
    );
    contract!(
        an_underflowing_departure_rate_breaks_the_contract,
        one_station("5e-324", "1", r#"{"s1":1}"#, r#"{"s1":{"s1":0.5}}"#),
        "the non-feedback service-completion rate is not positive and finite"
    );

    #[test]
    fn the_encoding_sentence_is_0_90_34_s() {
        assert_eq!(QbdError::Encoding("x".into()).message(), "The QBD input could not be encoded: x");
    }

    /// What 0.90.34's harness wrote (validation/qbd_exporter, run on 0.90.34's QBDExporter.swift).
    const HARNESS_OUTPUT: &str = r#"{
  "boundary" : {
    "level_0_same" : [
      [
        -1
      ]
    ],
    "level_0_up" : [
      [
        1
      ]
    ],
    "level_1_down" : [
      [
        2
      ]
    ],
    "level_1_same" : [
      [
        -3
      ]
    ]
  },
  "interior" : {
    "down" : [
      [
        2
      ]
    ],
    "same" : [
      [
        -3
      ]
    ],
    "up" : [
      [
        1
      ]
    ]
  },
  "name" : "Feedback M/M/1",
  "process" : "continuous_time_qbd",
  "schema_version" : 1,
  "solver" : {
    "max_iterations" : 100000,
    "max_report_level" : 20,
    "tail_levels" : [
      0,
      1,
      2,
      5,
      10,
      20
    ]
  }
}
"#;
}
