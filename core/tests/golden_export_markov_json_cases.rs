//! The strict Markovian validator's refusals that the 50 examples never reach, one network each,
//! and what the three exporters built on it (regenerative, product form, QBD) do with it.
//!
//! Every expectation here was produced by the 0.90.34 binary itself: each network was written
//! as a `.bnet` file named `net.bnet` and run through `Qnet --export-regenerative`,
//! `--export-product-form` and `--export-qbd` (so the document name is "net"), and the sentence
//! or document it wrote is the one asserted.

use qnet_core::export::{product_form, qbd, regenerative};
use qnet_core::model::{Distribution, Link, Network, Node, NodeKind, ServiceConfig};

/// A network built by name; node ids are UUIDs, as 0.90.34's files need.
struct Build {
    net: Network,
}

const GHOST: &str = "00000000-0000-4000-8000-FFFFFFFFFFFF";

fn uuid(prefix: u32, i: usize) -> String {
    format!("{prefix:08X}-0000-4000-8000-{:012X}", i + 1)
}

impl Build {
    fn new(infinite: bool) -> Build {
        Build {
            net: Network { nodes: vec![], links: vec![], infinite_buffers: infinite, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None },
        }
    }

    fn node(mut self, kind: NodeKind, name: &str, distribution: Distribution, parameters: &str, servers: i64, buffer: i64) -> Build {
        let mut n = Node::new(uuid(0, self.net.nodes.len()), kind, name, (100.0, 100.0));
        n.distribution = distribution;
        n.parameters = parameters.into();
        n.servers = servers;
        n.buffer_size = buffer;
        self.net.nodes.push(n);
        self
    }

    fn source(self, name: &str, parameters: &str) -> Build {
        self.node(NodeKind::Source, name, Distribution::Poisson, parameters, 1, 1)
    }

    fn station(self, name: &str, parameters: &str) -> Build {
        self.node(NodeKind::Station, name, Distribution::Exponential, parameters, 1, 1)
    }

    fn sink(self, name: &str) -> Build {
        self.node(NodeKind::Sink, name, Distribution::Exponential, "rate=1.0", 1, 1)
    }

    fn buffer(self, name: &str, size: i64) -> Build {
        self.node(NodeKind::Buffer, name, Distribution::Exponential, "rate=1.0", 1, size)
    }

    /// Changes the last node added.
    fn with(mut self, f: impl FnOnce(&mut Node)) -> Build {
        f(self.net.nodes.last_mut().unwrap());
        self
    }

    fn id(&self, name: &str) -> String {
        self.net.nodes.iter().find(|n| n.name == name).map_or(GHOST.to_string(), |n| n.id.clone())
    }

    fn route(self, from: &str, to: &str, p: f64) -> Build {
        self.route_class(from, to, p, 0, None)
    }

    fn route_class(mut self, from: &str, to: &str, p: f64, class: i64, to_class: Option<i64>) -> Build {
        let link =
            Link { id: uuid(0x1000_0000, self.net.links.len()), from: self.id(from), to: self.id(to), probability: p, class, to_class };
        self.net.links.push(link);
        self
    }

    fn done(self) -> Network {
        self.net
    }
}

/// An M/M/1 that every exporter accepts: λ = 1, μ = 4, feedback 0.5.
fn feedback_mm1() -> Build {
    Build::new(true)
        .source("Src1", "lambda=1.0")
        .station("S1", "rate=4.0")
        .sink("Sink1")
        .route("Src1", "S1", 1.0)
        .route("S1", "S1", 0.5)
        .route("S1", "Sink1", 0.5)
}

fn regen(net: &Network) -> Result<String, String> {
    regenerative::export(net, "net", &regenerative::Options::default()).map_err(|e| e.message())
}

fn pf(net: &Network) -> Result<String, String> {
    product_form::export(net, "net", product_form::DEFAULT_MAXIMUM_SERVERS).map_err(|e| e.message())
}

fn qbd(net: &Network) -> Result<String, String> {
    qbd::export(net, "net", &qbd::QbdOptions::default()).map_err(|e| e.message())
}

/// Every case, by name, for writing them out as `.bnet` files to run through 0.90.34.
fn cases() -> Vec<(&'static str, Network)> {
    vec![
        ("feedback_mm1", feedback_mm1().done()),
        ("no_stations", Build::new(true).source("Src1", "lambda=1.0").sink("Sink1").route("Src1", "Sink1", 1.0).done()),
        ("no_sources", Build::new(true).station("S1", "rate=1.0").sink("Sink1").route("S1", "Sink1", 1.0).done()),
        ("zero_servers", feedback_mm1().done_with(|n| n.nodes[1].servers = 0)),
        (
            "missing_buffer",
            Build::new(false)
                .source("Src1", "lambda=1.0")
                .station("S1", "rate=2.0")
                .sink("Sink1")
                .route("Src1", "S1", 1.0)
                .route("S1", "Sink1", 1.0)
                .done(),
        ),
        (
            "multiple_buffers",
            Build::new(false)
                .source("Src1", "lambda=1.0")
                .buffer("B1", 3)
                .buffer("B2", 3)
                .station("S1", "rate=2.0")
                .sink("Sink1")
                .route("Src1", "B1", 0.5)
                .route("Src1", "B2", 0.5)
                .route("B1", "S1", 1.0)
                .route("B2", "S1", 1.0)
                .route("S1", "Sink1", 1.0)
                .done(),
        ),
        ("negative_buffer", finite_line(-1, 1)),
        ("capacity_overflow", finite_line(1, i64::MAX)),
        (
            "gamma_arrivals",
            feedback_mm1().done_with(|n| {
                n.nodes[0].distribution = Distribution::Gamma;
                n.nodes[0].parameters = "shape=2.0,scale=1.0".into();
            }),
        ),
        ("zero_arrival_rate", feedback_mm1().done_with(|n| n.nodes[0].parameters = "lambda=0".into())),
        (
            "exponential_arrivals_without_rate",
            feedback_mm1().done_with(|n| {
                n.nodes[0].distribution = Distribution::Exponential;
                n.nodes[0].parameters = "lambda=1.0".into();
            }),
        ),
        (
            "source_to_sink_only",
            Build::new(true)
                .source("Src1", "lambda=1.0")
                .station("S1", "rate=2.0")
                .sink("Sink1")
                .route("Src1", "Sink1", 1.0)
                .route("S1", "Sink1", 1.0)
                .done(),
        ),
        (
            "source_class_mismatch",
            Build::new(true)
                .source("Src1", "lambda=1.0")
                .source("Src2", "lambda=1.0")
                .station("S1", "rate=4.0")
                .sink("Sink1")
                .route_class("Src1", "S1", 1.0, 1, None)
                .route_class("Src2", "S1", 1.0, 1, None)
                .route_class("S1", "Sink1", 1.0, 0, None)
                .route_class("S1", "Sink1", 1.0, 1, None)
                .done(),
        ),
        ("class_transition", feedback_mm1().done_with(|n| n.links[2].to_class = Some(1))),
        ("unknown_class", feedback_mm1().route_class("S1", "Sink1", 0.25, 3, None).done()),
        (
            "erlang_service",
            feedback_mm1().done_with(|n| {
                n.nodes[1].distribution = Distribution::Erlang;
                n.nodes[1].parameters = "k=2,rate=1.0".into();
            }),
        ),
        ("unreadable_service_rate", feedback_mm1().done_with(|n| n.nodes[1].parameters = "rate=fast".into())),
        (
            "class_dependent_service",
            Build::new(true)
                .source("Src1", "lambda=0.5")
                .source("Src2", "lambda=0.5")
                .station("S1", "rate=4.0")
                .with(|s| {
                    s.service_by_class.insert(1, ServiceConfig { distribution: Distribution::Exponential, parameters: "rate=4.5".into() });
                })
                .sink("Sink1")
                .route_class("Src1", "S1", 1.0, 0, None)
                .route_class("Src2", "S1", 1.0, 1, None)
                .route_class("S1", "Sink1", 1.0, 0, None)
                .route_class("S1", "Sink1", 1.0, 1, None)
                .done(),
        ),
        ("probability_above_one", feedback_mm1().done_with(|n| n.links[2].probability = 1.5)),
        ("negative_probability", feedback_mm1().done_with(|n| n.links[1].probability = -0.25)),
        ("station_row_above_one", feedback_mm1().done_with(|n| n.links[2].probability = 0.75)),
        ("source_row_above_one", feedback_mm1().route("Src1", "Sink1", 0.125).done()),
        ("route_from_a_missing_node", feedback_mm1().route("Ghost", "S1", 0.5).done()),
        ("route_to_a_missing_node", feedback_mm1().route("S1", "Ghost", 0.0).done()),
        ("route_into_a_source", feedback_mm1().done_with(|n| n.links[2].to = n.nodes[0].id.clone())),
        (
            "buffer_feeding_nothing",
            Build::new(true)
                .source("Src1", "lambda=1.0")
                .buffer("B1", 5)
                .station("S1", "rate=2.0")
                .sink("Sink1")
                .route("Src1", "B1", 1.0)
                .route("S1", "Sink1", 1.0)
                .done(),
        ),
        (
            "buffer_feeding_two_stations",
            Build::new(true)
                .source("Src1", "lambda=1.0")
                .buffer("B1", 5)
                .station("S1", "rate=4.0")
                .station("S2", "rate=4.0")
                .sink("Sink1")
                .route("Src1", "B1", 1.0)
                .route("B1", "S2", 1.0)
                .route("B1", "S1", 1.0)
                .route("S1", "Sink1", 1.0)
                .route("S2", "Sink1", 1.0)
                .done(),
        ),
        (
            "buffer_feeding_a_sink",
            Build::new(true)
                .source("Src1", "lambda=1.0")
                .buffer("B1", 5)
                .station("S1", "rate=2.0")
                .sink("Sink1")
                .route("Src1", "B1", 1.0)
                .route("B1", "Sink1", 1.0)
                .route("S1", "Sink1", 1.0)
                .done(),
        ),
        (
            "buffer_route_below_one",
            Build::new(true)
                .source("Src1", "lambda=1.0")
                .buffer("B1", 5)
                .station("S1", "rate=2.0")
                .sink("Sink1")
                .route("Src1", "B1", 1.0)
                .route("B1", "S1", 0.75)
                .route("S1", "Sink1", 1.0)
                .done(),
        ),
        (
            "closed_loop",
            Build::new(true)
                .source("Src1", "lambda=1.0")
                .station("S1", "rate=4.0")
                .station("S2", "rate=4.0")
                .route("Src1", "S1", 1.0)
                .route("S1", "S2", 1.0)
                .route("S2", "S1", 1.0)
                .done(),
        ),
        (
            "overflowing_traffic",
            Build::new(false)
                .source("Src1", "lambda=1e308")
                .buffer("B1", 5)
                .station("S1", "rate=2.0")
                .sink("Sink1")
                .route("Src1", "B1", 1.0)
                .route("B1", "S1", 1.0)
                .route("S1", "B1", 0.9)
                .route("S1", "Sink1", 0.1)
                .done(),
        ),
        ("nearly_closed_ring", nearly_closed_ring()),
        ("infinite_offered_load", feedback_mm1().done_with(|n| n.nodes[1].parameters = "rate=5e-324".into())),
        ("unstable_station", feedback_mm1().done_with(|n| n.nodes[0].parameters = "lambda=2.5".into())),
        ("finite_mm1", finite_line(4, 1)),
        ("route_out_of_a_sink", feedback_mm1().route("Sink1", "S1", 0.5).done()),
        ("two_servers", feedback_mm1().done_with(|n| n.nodes[1].servers = 2)),
        ("two_sources", feedback_mm1().source("Src2", "lambda=1.0").route("Src2", "S1", 1.0).done()),
        ("unreached_station", feedback_mm1().station("S2", "rate=1.0").route("S2", "Sink1", 1.0).done()),
        ("many_servers", feedback_mm1().done_with(|n| n.nodes[1].servers = 100_001)),
    ]
}

/// Src1 → B1 → S1 → Sink1 with finite buffers.
fn finite_line(buffer: i64, servers: i64) -> Network {
    Build::new(false)
        .source("Src1", "lambda=1.0")
        .buffer("B1", buffer)
        .station("S1", "rate=2.0")
        .with(|s| s.servers = servers)
        .sink("Sink1")
        .route("Src1", "B1", 1.0)
        .route("B1", "S1", 1.0)
        .route("S1", "Sink1", 1.0)
        .done()
}

/// Ten stations in a ring whose one exit has probability 2e-14: closed enough that elimination's
/// last pivot falls under its floor, open enough to pass the exit-path check.
fn nearly_closed_ring() -> Network {
    let mut b = Build::new(false).source("Src1", "lambda=1.0").sink("Sink1");
    for i in 1..=10 {
        b = b.buffer(&format!("B{i}"), 2).station(&format!("S{i}"), "rate=2.0");
    }
    b = b.route("Src1", "B1", 1.0);
    for i in 1..=10 {
        b = b.route(&format!("B{i}"), &format!("S{i}"), 1.0);
        let next = if i == 10 { 1 } else { i + 1 };
        let p = if i == 10 { 1.0 - 2e-14 } else { 1.0 };
        b = b.route(&format!("S{i}"), &format!("B{next}"), p);
    }
    b.route("S10", "Sink1", 2e-14).done()
}

trait DoneWith {
    fn done_with(self, f: impl FnOnce(&mut Network)) -> Network;
}

impl DoneWith for Build {
    fn done_with(self, f: impl FnOnce(&mut Network)) -> Network {
        let mut net = self.done();
        f(&mut net);
        net
    }
}

/// Writes every case as <dir>/<case>/net.bnet, for running through 0.90.34 by hand.
#[test]
fn every_case_can_be_written_out_for_0_90_34() {
    let Ok(dir) = std::env::var("QNET_MARKOV_CASES_DIR") else { return };
    for (name, net) in cases() {
        let folder = std::path::Path::new(&dir).join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("net.bnet"), qnet_core::bnet::write(&net)).unwrap();
        for (file, out) in [("regenerative", regen(&net)), ("product-form", pf(&net)), ("qbd", qbd(&net))] {
            let text = match out {
                Ok(t) => t,
                Err(m) => format!("ERROR: {m}\n"),
            };
            std::fs::write(folder.join(format!("{file}.rust")), text).unwrap();
        }
    }
}

/// One case's outcome from each exporter: `None` when it writes a document, else its sentence.
fn check(case: &str, regenerative: Option<&str>, product_form: Option<&str>, qbd_: Option<&str>) {
    let net = cases().into_iter().find(|(n, _)| *n == case).unwrap_or_else(|| panic!("no case {case}")).1;
    for (what, got, want) in
        [("regenerative", regen(&net), regenerative), ("product form", pf(&net), product_form), ("QBD", qbd(&net), qbd_)]
    {
        match (got, want) {
            (Ok(_), None) => {}
            (Err(m), Some(w)) => assert_eq!(m, w, "{case}: {what}"),
            (got, want) => panic!("{case}: {what}: got {got:?}, 0.90.34 {want:?}"),
        }
    }
}

macro_rules! case {
    ($test:ident, $case:literal, $regenerative:expr, $product_form:expr, $qbd:expr) => {
        #[test]
        fn $test() {
            check($case, $regenerative, $product_form, $qbd);
        }
    };
}

#[test]
fn an_mm1_with_feedback_is_written_by_all_three_exporters_as_0_90_34_wrote_it() {
    let net = feedback_mm1().done();
    assert_eq!(regen(&net).unwrap(), FEEDBACK_MM1_REGENERATIVE);
    assert_eq!(pf(&net).unwrap(), FEEDBACK_MM1_PRODUCT_FORM);
    assert_eq!(qbd(&net).unwrap(), FEEDBACK_MM1_QBD);
}

#[test]
fn the_seed_and_stream_are_written_as_given_up_to_the_largest_uint64() {
    let options = regenerative::Options { base_seed: u64::MAX, stream: 7, ..Default::default() };
    let got = regenerative::export(&feedback_mm1().done(), "net", &options).unwrap();
    // 0.90.34: Qnet --export-regenerative net.bnet out.json 18446744073709551615 7
    let want = FEEDBACK_MM1_REGENERATIVE
        .replace("\"base_seed\" : 20260904", "\"base_seed\" : 18446744073709551615")
        .replace("\"stream\" : 0", "\"stream\" : 7");
    assert_eq!(got, want);
}

#[test]
fn an_mm2_product_form_keeps_both_servers() {
    let net = cases().into_iter().find(|(n, _)| *n == "two_servers").unwrap().1;
    assert_eq!(pf(&net).unwrap(), MM2_PRODUCT_FORM);
}

#[test]
fn a_finite_station_s_capacity_is_its_servers_plus_its_buffer() {
    assert_eq!(regen(&finite_line(4, 1)).unwrap(), FINITE_MM1_REGENERATIVE);
}

#[test]
fn a_blank_name_is_refused_by_all_three_exporters() {
    let net = feedback_mm1().done();
    let o = regenerative::Options::default();
    assert_eq!(regenerative::export(&net, " \n\t", &o).unwrap_err().message(), "Enter a name for the regenerative simulation input.");
    assert_eq!(
        product_form::export(&net, " ", product_form::DEFAULT_MAXIMUM_SERVERS).unwrap_err().message(),
        "Enter a name for the exact open product-form input."
    );
    assert_eq!(qbd::export(&net, "\u{3000}", &qbd::QbdOptions::default()).unwrap_err().message(), "Enter a name for the QBD input.");
}

#[test]
fn the_name_is_written_trimmed() {
    let net = feedback_mm1().done();
    let got = regenerative::export(&net, "  net\n", &regenerative::Options::default()).unwrap();
    assert_eq!(got, FEEDBACK_MM1_REGENERATIVE);
    assert_eq!(product_form::export(&net, " net ", product_form::DEFAULT_MAXIMUM_SERVERS).unwrap(), FEEDBACK_MM1_PRODUCT_FORM);
    assert_eq!(qbd::export(&net, "net\t", &qbd::QbdOptions::default()).unwrap(), FEEDBACK_MM1_QBD);
}

case!(
    a_buffer_that_feeds_a_sink_is_refused,
    "buffer_feeding_a_sink",
    Some("B1 has a positive outgoing route to Sink1. An upstream buffer must feed exactly one service station and have no other positive outgoing routes."),
    Some("B1 has a positive outgoing route to Sink1. An upstream buffer must feed exactly one service station and have no other positive outgoing routes."),
    Some("B1 has a positive outgoing route to Sink1. An upstream buffer must feed exactly one service station and have no other positive outgoing routes.")
);

case!(
    a_buffer_that_feeds_nothing_is_refused,
    "buffer_feeding_nothing",
    Some("B1 is used as a route destination but does not feed a service station. Connect it to exactly one station."),
    Some("B1 is used as a route destination but does not feed a service station. Connect it to exactly one station."),
    Some("B1 is used as a route destination but does not feed a service station. Connect it to exactly one station.")
);

case!(
    a_buffer_that_feeds_two_stations_is_refused,
    "buffer_feeding_two_stations",
    Some("B1 is used as a route destination but feeds multiple stations (S1, S2). Split it into one buffer per station."),
    Some("B1 is used as a route destination but feeds multiple stations (S1, S2). Split it into one buffer per station."),
    Some("The current QBD adapter supports exactly one service station; this network has 2. Use product form or another network method for multiple stations.")
);

case!(
    a_buffer_route_below_one_is_refused,
    "buffer_route_below_one",
    Some("The structural route from B1 to S1 has probability 0.75. Set it to 1 so every waiting job enters that station."),
    Some("The structural route from B1 to S1 has probability 0.75. Set it to 1 so every waiting job enters that station."),
    Some("The structural route from B1 to S1 has probability 0.75. Set it to 1 so every waiting job enters that station.")
);

case!(
    a_capacity_that_overflows_an_int_is_refused,
    "capacity_overflow",
    Some("S1's server count plus waiting capacity is too large to export. Reduce one of those values."),
    Some("Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method."),
    Some("The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.")
);

case!(
    class_dependent_service_rates_are_refused,
    "class_dependent_service",
    Some("S1 has class-dependent service rates: Class 1 uses 4 and Class 2 uses 4.5. Set one common exponential rate for every class at that station."),
    Some("S1 has class-dependent service rates: Class 1 uses 4 and Class 2 uses 4.5. Set one common exponential rate for every class at that station."),
    Some("The current QBD adapter supports exactly one external customer class/source; this network has 2.")
);

case!(
    a_class_change_is_refused,
    "class_transition",
    Some("The route from S1 to Sink1 changes Class 1 to Class 2. Regenerative simulation currently requires class-preserving routing."),
    Some("The route from S1 to Sink1 changes Class 1 to Class 2. Exact open product form requires class-preserving routing."),
    Some("The route from S1 to Sink1 changes Class 1 to Class 2. The exact one-phase QBD mapping requires class-preserving routing.")
);

case!(
    a_closed_loop_is_refused,
    "closed_loop",
    Some("Class 1 cannot reach an exit from S1. Lower at least one routing row sum below 1 or add a positive-probability path to a sink."),
    Some("Class 1 cannot reach an exit from S1. Lower at least one routing row sum below 1 or add a positive-probability path to a sink."),
    Some("The current QBD adapter supports exactly one service station; this network has 2. Use product form or another network method for multiple stations.")
);

case!(
    erlang_service_is_refused,
    "erlang_service",
    Some("S1, Class 1 uses Erlang service. Regenerative simulation requires exponential FCFS service."),
    Some("S1, Class 1 uses Erlang service. Exact open product form requires exponential FCFS service."),
    Some("S1, Class 1 uses Erlang service. The exact one-phase QBD mapping requires exponential FCFS service.")
);

case!(
    exponential_arrivals_without_a_rate_are_refused,
    "exponential_arrivals_without_rate",
    Some("Src1 does not contain a positive finite arrival rate."),
    Some("Src1 does not contain a positive finite arrival rate."),
    Some("Src1 does not contain a positive finite arrival rate.")
);

case!(
    a_finite_mm1_is_simulated_but_has_no_exact_input,
    "finite_mm1",
    None,
    Some("Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method."),
    Some("The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.")
);

case!(
    gamma_arrivals_are_refused,
    "gamma_arrivals",
    Some("Src1 uses Gamma arrivals. Regenerative simulation requires a Poisson process (Poisson or exponential inter-arrivals)."),
    Some("Src1 uses Gamma arrivals. Exact open product form requires a Poisson process (Poisson or exponential inter-arrivals)."),
    Some("Src1 uses Gamma arrivals. The exact one-phase QBD mapping requires a Poisson process (Poisson or exponential inter-arrivals).")
);

case!(
    an_infinite_offered_load_is_refused_for_all_classes,
    "infinite_offered_load",
    Some("The traffic equations for all classes could not be solved reliably (the offered load at S1 is not finite). Add exit probability or move the routing probabilities farther from a closed loop."),
    Some("The traffic equations for all classes could not be solved reliably (the offered load at S1 is not finite). Add exit probability or move the routing probabilities farther from a closed loop."),
    Some("The traffic equations for all classes could not be solved reliably (the offered load at S1 is not finite). Add exit probability or move the routing probabilities farther from a closed loop.")
);

case!(
    more_servers_than_the_safety_limit_have_no_product_form,
    "many_servers",
    None,
    Some("S1 has 100001 servers, above the product-form safety limit of 100000. Raise the explicit limit only if an O(servers) Erlang-C normalization is acceptable."),
    Some("S1 has 100001 servers. The current scalar QBD level mapping is exact only for one exponential server (M/M/1).")
);

case!(
    a_finite_station_without_an_upstream_buffer_is_refused,
    "missing_buffer",
    Some("S1 needs exactly one upstream buffer to define its finite total capacity."),
    Some("Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method."),
    Some("The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.")
);

case!(
    a_finite_station_with_two_upstream_buffers_is_refused,
    "multiple_buffers",
    Some("S1 has more than one upstream buffer. Use one buffer per station before exporting a finite network."),
    Some("Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method."),
    Some("The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.")
);

case!(
    a_numerically_singular_ring_is_refused,
    "nearly_closed_ring",
    Some("The traffic equations for Class 1 could not be solved reliably (the routing matrix is closed or numerically singular). Add exit probability or move the routing probabilities farther from a closed loop."),
    Some("Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method."),
    Some("The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.")
);

case!(
    a_negative_waiting_capacity_is_refused,
    "negative_buffer",
    Some("B1 has waiting capacity -1. Finite regenerative simulation requires a nonnegative waiting capacity."),
    Some("Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method."),
    Some("The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.")
);

case!(
    a_negative_routing_probability_is_refused,
    "negative_probability",
    Some("A route from S1 has probability -0.25. Routing probabilities must be finite and between 0 and 1."),
    Some("A route from S1 has probability -0.25. Routing probabilities must be finite and between 0 and 1."),
    Some("A route from S1 has probability -0.25. Routing probabilities must be finite and between 0 and 1.")
);

case!(
    a_network_without_sources_is_refused,
    "no_sources",
    Some("The network has no external arrival source. Add at least one source before exporting."),
    Some("The network has no external arrival source. Add at least one source before exporting."),
    Some("The current QBD adapter supports exactly one external customer class/source; this network has 0.")
);

case!(
    a_network_without_stations_is_refused,
    "no_stations",
    Some("The network has no service stations. Add at least one station before exporting."),
    Some("The network has no service stations. Add at least one station before exporting."),
    Some("The current QBD adapter supports exactly one service station; this network has 0. Use product form or another network method for multiple stations.")
);

case!(
    traffic_that_overflows_is_refused,
    "overflowing_traffic",
    Some("The traffic equations for Class 1 could not be solved reliably (the numerical solution is not finite). Add exit probability or move the routing probabilities farther from a closed loop."),
    Some("Exact open product form requires infinite-capacity queues. Change Buffer Model to Infinite, or use a finite-buffer method."),
    Some("The exact one-phase QBD mapping requires an infinite-capacity queue. Change Buffer Model to Infinite.")
);

case!(
    a_routing_probability_above_one_is_refused,
    "probability_above_one",
    Some("A route from S1 has probability 1.5. Routing probabilities must be finite and between 0 and 1."),
    Some("A route from S1 has probability 1.5. Routing probabilities must be finite and between 0 and 1."),
    Some("A route from S1 has probability 1.5. Routing probabilities must be finite and between 0 and 1.")
);

case!(
    a_route_from_a_missing_node_is_refused,
    "route_from_a_missing_node",
    Some("A route starts at a node that is no longer in the document. Delete that route and reconnect the remaining nodes."),
    Some("A route starts at a node that is no longer in the document. Delete that route and reconnect the remaining nodes."),
    Some("A route starts at a node that is no longer in the document. Delete that route and reconnect the remaining nodes.")
);

case!(
    a_route_into_a_source_is_refused,
    "route_into_a_source",
    Some("A route from S1 points to source Src1. Routes may lead only to a station, an upstream buffer, or an exit sink."),
    Some("The route from S1 enters source Src1. External sources may create customers but cannot receive routed customers; route to a station or sink instead."),
    Some("The route from S1 enters external source Src1. Route feedback to the station, not to its source.")
);

case!(
    a_route_out_of_a_sink_is_refused_only_by_the_exact_methods,
    "route_out_of_a_sink",
    None,
    Some("Exit sink Sink1 has a positive-probability route to S1. Product form treats a sink as final departure; delete that outgoing route."),
    Some("Exit sink Sink1 routes back to S1. A sink must be final departure for the one-queue QBD mapping.")
);

case!(
    a_route_to_a_missing_node_is_refused_even_at_probability_zero,
    "route_to_a_missing_node",
    Some("A route from S1 points to a node that is no longer in the document. Delete or reconnect that route."),
    Some("A route from S1 points to a node that is no longer in the document. Delete or reconnect that route."),
    Some("A route from S1 points to a node that is no longer in the document. Delete or reconnect that route.")
);

case!(
    a_source_route_labelled_with_another_class_is_refused,
    "source_class_mismatch",
    Some("A route from Src1 is labelled Class 2, but that source creates Class 1. Change the route to preserve the source class."),
    Some("A route from Src1 is labelled Class 2, but that source creates Class 1. Change the route to preserve the source class."),
    Some("The current QBD adapter supports exactly one external customer class/source; this network has 2.")
);

case!(
    a_source_row_summing_above_one_is_refused,
    "source_row_above_one",
    Some("Routing probabilities from Src1 for Class 1 total 1.125, above 1. Reduce the outgoing probabilities so their sum is at most 1."),
    Some("Routing probabilities from Src1 for Class 1 total 1.125, above 1. Reduce the outgoing probabilities so their sum is at most 1."),
    Some("Routing probabilities from Src1 for Class 1 total 1.125, above 1. Reduce the outgoing probabilities so their sum is at most 1.")
);

case!(
    a_source_that_reaches_no_station_is_refused,
    "source_to_sink_only",
    Some("Src1 does not send positive-rate arrivals to a service station. Connect it directly, or through a buffer, to one or more stations."),
    Some("Src1 does not send positive-rate arrivals to a service station. Connect it directly, or through a buffer, to one or more stations."),
    Some("Src1 does not send positive-rate arrivals to a service station. Connect it directly, or through a buffer, to one or more stations.")
);

case!(
    a_station_row_summing_above_one_is_refused,
    "station_row_above_one",
    Some("Routing probabilities from S1 for Class 1 total 1.25, above 1. Reduce the outgoing probabilities so their sum is at most 1."),
    Some("Routing probabilities from S1 for Class 1 total 1.25, above 1. Reduce the outgoing probabilities so their sum is at most 1."),
    Some("Routing probabilities from S1 for Class 1 total 1.25, above 1. Reduce the outgoing probabilities so their sum is at most 1.")
);

case!(
    an_mm2_has_a_product_form_but_no_qbd,
    "two_servers",
    None,
    None,
    Some("S1 has 2 servers. The current scalar QBD level mapping is exact only for one exponential server (M/M/1).")
);

case!(
    two_sources_are_refused,
    "two_sources",
    Some("A route from Src2 is labelled Class 1, but that source creates Class 2. Change the route to preserve the source class."),
    Some("A route from Src2 is labelled Class 1, but that source creates Class 2. Change the route to preserve the source class."),
    Some("The current QBD adapter supports exactly one external customer class/source; this network has 2.")
);

case!(
    a_route_class_without_a_source_is_refused,
    "unknown_class",
    Some("A route from S1 uses class 4, but there is no matching external source. Add the source or change the route class."),
    Some("A route from S1 uses class 4, but there is no matching external source. Add the source or change the route class."),
    Some("A route from S1 uses class 4, but there is no matching external source. Add the source or change the route class.")
);

case!(
    an_unreached_station_is_simulated_but_has_no_product_form,
    "unreached_station",
    None,
    Some("S2 is not reachable from any external arrival class. Connect it to an active route or remove it before exact product-form analysis."),
    Some("The current QBD adapter supports exactly one service station; this network has 2. Use product form or another network method for multiple stations.")
);

case!(
    an_unreadable_service_rate_is_refused,
    "unreadable_service_rate",
    Some("S1, Class 1 does not contain a positive finite exponential service rate."),
    Some("S1, Class 1 does not contain a positive finite exponential service rate."),
    Some("S1, Class 1 does not contain a positive finite exponential service rate.")
);

case!(
    an_unstable_station_is_refused,
    "unstable_station",
    Some("S1 has infinite-buffer offered load 1.25, but regenerative steady state requires load below 1. Reduce arrivals/routing or add service capacity."),
    Some("S1 has infinite-buffer offered load 1.25, but an exact open product-form steady state requires load below 1. Reduce arrivals/routing or add service capacity."),
    Some("S1 has infinite-buffer offered load 1.25, but the exact QBD steady state requires load below 1. Reduce arrivals/routing or add service capacity.")
);

case!(
    a_zero_arrival_rate_is_refused,
    "zero_arrival_rate",
    Some("Src1 does not contain a positive finite arrival rate."),
    Some("Src1 does not contain a positive finite arrival rate."),
    Some("Src1 does not contain a positive finite arrival rate.")
);

case!(
    a_station_with_no_servers_is_refused,
    "zero_servers",
    Some("S1 has 0 servers. Regenerative simulation requires at least one server at every station."),
    Some("S1 has 0 servers. Exact open product form requires at least one server at every station."),
    Some("S1 has 0 servers. The current scalar QBD level mapping is exact only for one exponential server (M/M/1).")
);

const FEEDBACK_MM1_REGENERATIVE: &str = r#"{
  "classes" : [
    {
      "external_arrival_rates" : {
        "s1" : 1
      },
      "id" : "c1",
      "routing" : {
        "s1" : {
          "s1" : 0.5
        }
      }
    }
  ],
  "initial_jobs" : {

  },
  "name" : "net",
  "nodes" : [
    {
      "capacity" : null,
      "id" : "s1",
      "servers" : 1,
      "service_rate" : 4
    }
  ],
  "process" : "open_markovian_queueing_network",
  "random" : {
    "base_seed" : 20260904,
    "stream" : 0
  },
  "rare_event" : {
    "method" : "none"
  },
  "schema_version" : 1,
  "stopping" : {
    "absolute_half_width" : 0.02,
    "check_every_cycles" : 50,
    "confidence" : 0.95,
    "maximum_cycle_time" : 10000000,
    "maximum_cycles" : 100000,
    "maximum_events" : 10000000,
    "maximum_events_per_cycle" : 2000000,
    "maximum_simulated_time" : 1000000000,
    "maximum_wall_seconds" : 120,
    "minimum_cycles" : 200,
    "minimum_effective_cycles" : 30,
    "minimum_positive_cycles" : 5,
    "monitored_metrics" : [
      "mean_number_in_system"
    ],
    "relative_half_width" : 0.05
  }
}
"#;

const FEEDBACK_MM1_PRODUCT_FORM: &str = r#"{
  "classes" : [
    {
      "external_arrival_rates" : {
        "s1" : 1
      },
      "id" : "c1",
      "routing" : [
        {
          "destinations" : [
            {
              "probability" : 0.5,
              "station" : "s1"
            }
          ],
          "exit_probability" : 0.5,
          "from_station" : "s1"
        }
      ]
    }
  ],
  "description" : "Exact open FCFS BCMP/Jackson model exported from Qnet; M/M/c local factors are normalized analytically without state-space truncation.",
  "model_type" : "open_bcmp",
  "name" : "net",
  "schema_version" : 1,
  "solver" : {
    "max_servers" : 100000
  },
  "stations" : [
    {
      "id" : "s1",
      "servers" : 1,
      "service_times" : {
        "c1" : 0.25
      },
      "type" : "fcfs"
    }
  ]
}
"#;

const FEEDBACK_MM1_QBD: &str = r#"{
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
  "name" : "net",
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

const MM2_PRODUCT_FORM: &str = r#"{
  "classes" : [
    {
      "external_arrival_rates" : {
        "s1" : 1
      },
      "id" : "c1",
      "routing" : [
        {
          "destinations" : [
            {
              "probability" : 0.5,
              "station" : "s1"
            }
          ],
          "exit_probability" : 0.5,
          "from_station" : "s1"
        }
      ]
    }
  ],
  "description" : "Exact open FCFS BCMP/Jackson model exported from Qnet; M/M/c local factors are normalized analytically without state-space truncation.",
  "model_type" : "open_bcmp",
  "name" : "net",
  "schema_version" : 1,
  "solver" : {
    "max_servers" : 100000
  },
  "stations" : [
    {
      "id" : "s1",
      "servers" : 2,
      "service_times" : {
        "c1" : 0.25
      },
      "type" : "fcfs"
    }
  ]
}
"#;

const FINITE_MM1_REGENERATIVE: &str = r#"{
  "classes" : [
    {
      "external_arrival_rates" : {
        "s1" : 1
      },
      "id" : "c1",
      "routing" : {
        "s1" : {

        }
      }
    }
  ],
  "initial_jobs" : {

  },
  "name" : "net",
  "nodes" : [
    {
      "capacity" : 5,
      "id" : "s1",
      "servers" : 1,
      "service_rate" : 2
    }
  ],
  "process" : "open_markovian_queueing_network",
  "random" : {
    "base_seed" : 20260904,
    "stream" : 0
  },
  "rare_event" : {
    "method" : "none"
  },
  "schema_version" : 1,
  "stopping" : {
    "absolute_half_width" : 0.02,
    "check_every_cycles" : 50,
    "confidence" : 0.95,
    "maximum_cycle_time" : 10000000,
    "maximum_cycles" : 100000,
    "maximum_events" : 10000000,
    "maximum_events_per_cycle" : 2000000,
    "maximum_simulated_time" : 1000000000,
    "maximum_wall_seconds" : 120,
    "minimum_cycles" : 200,
    "minimum_effective_cycles" : 30,
    "minimum_positive_cycles" : 5,
    "monitored_metrics" : [
      "mean_number_in_system"
    ],
    "relative_half_width" : 0.05
  }
}
"#;
