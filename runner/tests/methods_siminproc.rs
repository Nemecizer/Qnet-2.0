//! Replicated Simulation (`methods/siminproc.rs`, new in 2.1; ledger SIM-105, SIM-106): the
//! bundled closed example and an open Jackson example run through the same prepare → launch →
//! archive → store path as every method, their records held to the exact solutions of
//! `qnet_core::closed` and `qnet_core::jackson`; reproducibility by seed; and the refusals.
mod common;

use std::sync::Arc;

use qnet_core::closed;
use qnet_core::jackson;
use qnet_core::json::Json;
use qnet_runner::methods::{Method, RunContext, RunSettings};
use qnet_runner::resolver::{Resolver, ResolverConfig};

fn context(file: &str, sets: &[(&str, &str)]) -> (RunContext, std::path::PathBuf) {
    let path = common::root().join("examples").join(file);
    let network = qnet_core::bnet::read(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let resolver = Arc::new(Resolver::new(ResolverConfig::from_process()));
    let mut settings = RunSettings::default();
    settings.set("sim.seedFixed", "true").unwrap();
    for (k, v) in sets {
        settings.set(k, v).unwrap();
    }
    (RunContext::new(network, file.rsplit('/').next().unwrap(), settings, resolver), path)
}

fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    v.as_object().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("no {key}"))
}

/// (estimate, low, high) of a station's metric in a filed record.
fn reading(record: &Json, station: &str, metric: &str) -> (f64, f64, f64) {
    let m = get(record, "measurements").as_array().unwrap().iter().find(|m| get(m, "stationName").as_str() == Some(station) && get(m, "metric").as_str() == Some(metric)).unwrap_or_else(|| panic!("{station} {metric}"));
    let u = get(m, "uncertainty");
    (get(m, "estimate").as_f64().unwrap(), get(u, "lowerBound").as_f64().unwrap(), get(u, "upperBound").as_f64().unwrap())
}

/// A quick run for the tests: 10 replications of 20,000 completions (a tenth of the default
/// length), 99 % intervals. With a fixed seed the run is the same every time; at 99 % a correct
/// method's interval misses a given exact value once in a hundred seeds.
const QUICK: [(&str, &str); 3] = [("siminproc.replications", "10"), ("siminproc.completions", "20000"), ("siminproc.confidence", "0.99")];

#[test]
fn the_closed_example_is_simulated_in_process_and_agrees_with_the_exact_solution() {
    let (ctx, path) = context("closed/ClosedCentralServer.d3.N8.bnet", &QUICK);
    let outcome = common::run(Method::InProcessSimulation, &ctx);
    assert!(outcome.launched && outcome.exit_code == Some(0), "{:?}", outcome.status);
    assert_eq!(outcome.status.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Running replicated simulation (10 independent replications, seed 12345)."]);
    assert_eq!(outcome.seed, Some(12345));
    assert_eq!(outcome.replication_seeds.len(), 10);
    assert_eq!(outcome.parameters["estimator"], "independent replications, Student t interval");
    assert_eq!(outcome.parameters["warm-up"], "MSER on 200 batch means");
    assert_eq!(outcome.parameters["model"], "closed queueing network, simulated");
    assert!(outcome.archive.starts_with("Replicated simulation (independent replications, in process)\nModel: ClosedCentralServer.d3.N8.bnet\nNetwork: closed, N=8, 3 stations\nReplications: 10  completions per replication: 20000  model time per replication: "), "{}", outcome.archive);
    assert!(outcome.archive.contains("Intervals: 99 % Student t across replications (9 degrees of freedom, t=3.2498)"), "{}", outcome.archive);
    assert!(outcome.archive.contains("Warm-up: MSER on 200 batch means deleted ") && outcome.archive.contains("Elapsed time: "));

    let record = common::file_record(Method::InProcessSimulation, &ctx, &path, &outcome).expect("a record");
    assert_eq!(get(&record, "status").as_str(), Some("completed"));
    assert_eq!(get(get(&record, "method"), "identifier").as_str(), Some("queue.des-replications"));
    assert_eq!(get(get(&record, "method"), "displayName").as_str(), Some("Replicated Simulation"));
    assert_eq!(get(get(&record, "method"), "fidelity").as_str(), Some("Queue simulation"), "the simulation tier");
    assert_eq!(get(&record, "measurements").as_array().unwrap().len(), 18, "six per station, as the exact method reports");

    // Every one of the exact solution's 18 numbers lies in the simulation's interval, and each
    // interval is tight enough to mean something (within ±8 % of the value: 99 %, a tenth of the default run).
    let model = closed::from_network(&ctx.network).unwrap();
    let exact = closed::convolution(&model).unwrap();
    for (i, name) in model.names.iter().enumerate() {
        let checks = [
            ("Throughput", exact.station_throughput[i]),
            ("Mean number in system", exact.number[i]),
            ("Mean queue length", exact.queue[i]),
            ("Server utilization", exact.utilisation[i].unwrap()),
            ("Mean sojourn time", exact.residence[i]),
            ("Mean waiting time", exact.queue[i] / exact.station_throughput[i]),
        ];
        for (metric, value) in checks {
            let (estimate, low, high) = reading(&record, name, metric);
            assert!(low <= value && value <= high, "{name} {metric}: exact {value} outside [{low}, {high}]");
            assert!(low < estimate && estimate < high && (high - low) / 2.0 < 0.08 * value, "{name} {metric}: {estimate} [{low}, {high}]");
        }
    }
    let total: f64 = model.names.iter().map(|n| reading(&record, n, "Mean number in system").0).sum();
    assert!((total - 8.0).abs() < 1e-9, "the eight customers are all at some station in every replication");

    // The same seed gives the same text (but for the elapsed time); another seed another.
    let numbers = |archive: &str| archive.lines().filter(|l| l.starts_with("QNET_SIM_")).map(String::from).collect::<Vec<_>>();
    assert_eq!(numbers(&common::run(Method::InProcessSimulation, &ctx).archive), numbers(&outcome.archive));
    let (other, _) = context("closed/ClosedCentralServer.d3.N8.bnet", &[QUICK[0], QUICK[1], QUICK[2], ("sim.seed", "777")]);
    assert_ne!(numbers(&common::run(Method::InProcessSimulation, &other).archive), numbers(&outcome.archive));
}

#[test]
fn an_open_jackson_network_is_simulated_and_agrees_with_the_product_form() {
    let (ctx, path) = context("OpenJackson.d2.feedback.p30.inf.bnet", &QUICK);
    let outcome = common::run(Method::InProcessSimulation, &ctx);
    assert!(outcome.launched && outcome.exit_code == Some(0), "{:?}", outcome.status);
    assert!(outcome.archive.contains("Network: open, infinite buffers, 2 stations"));
    let record = common::file_record(Method::InProcessSimulation, &ctx, &path, &outcome).expect("a record");
    let model = jackson::from_network(&ctx.network).unwrap();
    let exact = jackson::solve(&model).unwrap();
    for (i, name) in model.names.iter().enumerate() {
        for (metric, value) in [("Throughput", exact.alpha[i]), ("Mean number in system", exact.number[i]), ("Mean queue length", exact.queue[i]), ("Server utilization", exact.rho[i]), ("Mean sojourn time", exact.number[i] / exact.alpha[i])] {
            let (_, low, high) = reading(&record, name, metric);
            assert!(low <= value && value <= high, "{name} {metric}: exact {value} outside [{low}, {high}]");
        }
    }
}

#[test]
fn a_precision_target_adds_replications_and_a_cap_that_cuts_it_short_files_a_partial_run() {
    let short = [("siminproc.replications", "10"), ("siminproc.completions", "5000"), ("siminproc.precision", "0.02")];
    let (ctx, path) = context("closed/ClosedCentralServer.d3.N8.bnet", &short);
    let outcome = common::run(Method::InProcessSimulation, &ctx);
    assert_eq!(outcome.exit_code, Some(0));
    let line = outcome.archive.lines().find(|l| l.starts_with("Precision:")).unwrap();
    assert!(line.starts_with("Precision: target relative half-width 0.02 on every mean number; reached 0.0") && line.ends_with("(precision target met)"), "{line}");
    let status = outcome.archive.lines().find(|l| l.starts_with("QNET_SIM_STATUS_V1")).unwrap();
    let replications: usize = status.split_whitespace().nth(1).unwrap().trim_start_matches("replications=").parse().unwrap();
    assert!(replications > 10 && status.ends_with("target_met=yes warmup_inconclusive=no"), "{status}");
    let record = common::file_record(Method::InProcessSimulation, &ctx, &path, &outcome).unwrap();
    assert_eq!(get(&record, "status").as_str(), Some("completed"));
    for name in ["S1", "S2", "S3"] {
        let (estimate, low, high) = reading(&record, name, "Mean number in system");
        assert!((high - low) / 2.0 <= 0.02 * estimate, "{name}");
    }

    let (capped, path) = context("closed/ClosedCentralServer.d3.N8.bnet", &[short[0], short[1], ("siminproc.precision", "0.001"), ("siminproc.maximumReplications", "12")]);
    let outcome = common::run(Method::InProcessSimulation, &capped);
    assert_eq!(outcome.exit_code, Some(0));
    assert!(outcome.status.iter().any(|l| l.text == "Replicated Simulation stopped before the precision target was met (the cap on replications)."), "{:?}", outcome.status);
    let record = common::file_record(Method::InProcessSimulation, &capped, &path, &outcome).unwrap();
    assert_eq!(get(&record, "status").as_str(), Some("partial"));
}

#[test]
fn what_it_would_not_model_faithfully_is_refused_with_a_sentence() {
    // Finite buffers: the blocking rule is a per-run choice the network does not hold.
    let (finite, _) = context("Tandem2.MM1.K5.fin.bnet", &[]);
    let outcome = common::run(Method::InProcessSimulation, &finite);
    assert!(!outcome.launched);
    assert_eq!(outcome.status.iter().map(|l| l.text.clone()).collect::<Vec<_>>(), [format!("Replicated Simulation not started: {}", qnet_core::simstat::FINITE_SENTENCE)]);

    // A closed network without a population is not closed yet.
    let (mut bare, _) = context("closed/ClosedCentralServer.d3.N8.bnet", &[]);
    bare.network.population = None;
    let outcome = common::run(Method::InProcessSimulation, &bare);
    assert!(!outcome.launched && outcome.status[0].text.starts_with("Replicated Simulation not started: ") && outcome.status[0].text.contains("no number of customers is set"), "{:?}", outcome.status);

    // Options that make no interval.
    let (one, _) = context("closed/ClosedCentralServer.d3.N8.bnet", &[("siminproc.replications", "1")]);
    let outcome = common::run(Method::InProcessSimulation, &one);
    assert_eq!(outcome.exit_code, Some(2));
    assert!(outcome.archive.starts_with("error: At least 2 replications are needed"), "{}", outcome.archive);

    assert_eq!(Method::from_label("sim_inproc"), Some(Method::InProcessSimulation));
    assert!(!Method::InProcessSimulation.in_menu(true) && !Method::InProcessSimulation.in_menu(false), "0.90.34's two menus are as they were");
    // Every other method still refuses a closed network, and now names the second opinion too.
    let (closed_ctx, _) = context("closed/ClosedCentralServer.d3.N8.bnet", &[]);
    let qna = common::run(Method::Qna, &closed_ctx);
    assert!(qna.status[0].text.ends_with("Use Exact Closed Product Form, which is exact for it, or Replicated Simulation for a second opinion."), "{}", qna.status[0].text);
}
