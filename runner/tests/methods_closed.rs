//! Exact Closed Product Form (`methods/closed.rs`, new in 2.1; ledger SCI-506): the bundled closed
//! example run through the same prepare → launch → archive → store path as every method, and held
//! to `qnet_core::closed` itself; and the refusals in both directions.
mod common;

use std::sync::Arc;

use qnet_core::closed;
use qnet_core::json::Json;
use qnet_runner::methods::{Method, RunContext, RunSettings};
use qnet_runner::resolver::{Resolver, ResolverConfig};

fn context(file: &str) -> (RunContext, std::path::PathBuf) {
    let path = common::root().join("examples").join(file);
    let network = qnet_core::bnet::read(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let resolver = Arc::new(Resolver::new(ResolverConfig::from_process()));
    (RunContext::new(network, file.rsplit('/').next().unwrap(), RunSettings::default(), resolver), path)
}

fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    v.as_object().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("no {key}"))
}

#[test]
fn the_closed_example_runs_in_process_and_files_the_exact_record() {
    let (ctx, path) = context("closed/ClosedCentralServer.d3.N8.bnet");
    let outcome = common::run(Method::ClosedProductForm, &ctx);
    assert!(outcome.launched && outcome.exit_code == Some(0), "{:?}", outcome.status);
    assert_eq!(outcome.status.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Running exact closed product form (Buzen's convolution algorithm)."]);
    assert_eq!(outcome.parameters["population"], "8");
    assert_eq!(outcome.parameters["reference station"], "S1");
    // S3 has two servers, so MVA is not the cross-check here.
    assert_eq!(outcome.parameters["algorithm"], "Buzen convolution");
    assert!(outcome.archive.starts_with("Exact closed product-form analysis (Gordon-Newell)\nModel: ClosedCentralServer.d3.N8.bnet\nPopulation: N=8  reference station: S1 (visit ratio 1)\n"), "{}", outcome.archive);
    assert!(outcome.archive.contains("Elapsed time: "));

    let model = closed::from_network(&ctx.network).unwrap();
    let exact = closed::convolution(&model).unwrap();
    let record = common::file_record(Method::ClosedProductForm, &ctx, &path, &outcome).expect("a record");
    assert_eq!(get(&record, "status").as_str(), Some("completed"));
    assert_eq!(get(get(&record, "method"), "identifier").as_str(), Some("queue.closed-product-form"));
    assert_eq!(get(get(&record, "method"), "fidelity").as_str(), Some("Exact queueing result"));
    let snapshot = get(get(&record, "provenance"), "networkSnapshot");
    assert_eq!(get(snapshot, "closedPopulation").as_i64(), Some(8), "the population is part of what was solved");
    let measurements = get(&record, "measurements").as_array().unwrap();
    assert_eq!(measurements.len(), 18, "six per station");
    let value = |station: &str, metric: &str| -> f64 {
        measurements.iter().find(|m| get(m, "stationName").as_str() == Some(station) && get(m, "metric").as_str() == Some(metric)).map(|m| get(m, "estimate").as_f64().unwrap()).unwrap_or_else(|| panic!("{station} {metric}"))
    };
    // Printed with 12 significant digits.
    for (i, name) in model.names.iter().enumerate() {
        let near = |a: f64, b: f64| (a - b).abs() <= 1e-10 * b.abs().max(1.0);
        assert!(near(value(name, "Throughput"), exact.station_throughput[i]));
        assert!(near(value(name, "Mean number in system"), exact.number[i]));
        assert!(near(value(name, "Mean queue length"), exact.queue[i]));
        assert!(near(value(name, "Server utilization"), exact.utilisation[i].unwrap()));
        assert!(near(value(name, "Mean sojourn time"), exact.residence[i]));
        assert!(near(value(name, "Mean waiting time"), exact.queue[i] / exact.station_throughput[i]));
    }
    let total: f64 = model.names.iter().map(|n| value(n, "Mean number in system")).sum();
    assert!((total - 8.0).abs() < 1e-9, "the eight customers are all at some station");
}

#[test]
fn a_single_server_cycle_reports_the_mva_cross_check() {
    let (mut ctx, _) = context("closed/ClosedCentralServer.d3.N8.bnet");
    for n in ctx.network.nodes.iter_mut() {
        n.servers = 1;
    }
    let outcome = common::run(Method::ClosedProductForm, &ctx);
    assert_eq!(outcome.parameters["algorithm"], "Buzen convolution, cross-checked by exact MVA");
    let line = outcome.archive.lines().find(|l| l.starts_with("Method:")).unwrap();
    let gap: f64 = line.rsplit(' ').next().unwrap().parse().unwrap();
    assert!(line.starts_with("Method: Buzen convolution; exact MVA agrees to ") && gap < 1e-12, "{line}");
}

#[test]
fn other_methods_refuse_a_closed_network_and_this_one_refuses_an_open_one() {
    let (ctx, _) = context("closed/ClosedCentralServer.d3.N8.bnet");
    for method in Method::INFINITE.iter().chain(Method::FINITE.iter()) {
        let outcome = common::run(*method, &ctx);
        assert!(!outcome.launched, "{method:?}");
        assert_eq!(outcome.status.len(), 1);
        assert!(outcome.status[0].text.contains("this is a closed network (no source and no sink)") && outcome.status[0].text.contains("Use Exact Closed Product Form"), "{}", outcome.status[0].text);
    }
    let (open, _) = context("OpenJackson.d2.feedback.p30.inf.bnet");
    let outcome = common::run(Method::ClosedProductForm, &open);
    assert_eq!(outcome.status[0].text, "Exact closed product form not started: The network has a source or a sink, so it is an open network, not a closed one.");
    assert!(!outcome.launched);

    // Closed, but no population: refused with core's sentence.
    let (mut bare, _) = context("closed/ClosedCentralServer.d3.N8.bnet");
    bare.network.population = None;
    let outcome = common::run(Method::ClosedProductForm, &bare);
    assert!(!outcome.launched && outcome.status[0].text.contains("no number of customers is set"), "{:?}", outcome.status);
    // Without a population it is not a closed network yet: the other methods answer as they always did.
    let qna = common::run(Method::Qna, &bare);
    assert!(!qna.launched && qna.status.iter().all(|l| !l.text.contains("closed network")), "{:?}", qna.status);
    assert_eq!(Method::from_label("closed_pf"), Some(Method::ClosedProductForm));
    assert!(!Method::ClosedProductForm.in_menu(true) && !Method::ClosedProductForm.in_menu(false), "0.90.34's two menus are as they were");
}
