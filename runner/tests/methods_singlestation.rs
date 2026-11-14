//! Exact Priority Queue and Exact Batch-Arrival Queue (`methods/singlestation.rs`, new in 2.1;
//! ledger SCI-1006, SCI-1013): the bundled examples run through the same prepare → launch →
//! archive → store path as every method and held to `qnet_core::priority` and `batch`
//! themselves; Replicated Simulation as the second opinion on the same networks; and the
//! refusals: every method that reads a network the classical way refuses a network with a new
//! feature in core's one sentence, and each exact method says why a network is not its own.
mod common;

use std::sync::Arc;

use qnet_core::json::Json;
use qnet_core::{batch, priority};
use qnet_runner::methods::{Method, RunContext, RunSettings};
use qnet_runner::resolver::{Resolver, ResolverConfig};

const PRIORITY: &str = "extended/PriorityHelpDesk.mg1.2class.bnet";
const BATCH: &str = "extended/BatchArrivals.mx-m-1.geometric.bnet";
const RUSH: &str = "extended/RushHour.mt-m-2.daily.bnet";

fn context(file: &str) -> (RunContext, std::path::PathBuf) {
    let path = common::root().join("examples").join(file);
    let network = qnet_core::bnet::read(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let resolver = Arc::new(Resolver::new(ResolverConfig::from_process()));
    (RunContext::new(network, file.rsplit('/').next().unwrap(), RunSettings::default(), resolver), path)
}

fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    v.as_object().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("no {key}"))
}

/// (metric, estimate, lower bound, upper bound) of a filed record's measurements.
fn measurements(record: &Json) -> Vec<(String, f64, Option<f64>, Option<f64>)> {
    get(record, "measurements")
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let u = m.as_object().unwrap().get("uncertainty");
            let bound = |k: &str| u.and_then(|u| u.as_object()).and_then(|o| o.get(k)).and_then(Json::as_f64);
            (get(m, "metric").as_str().unwrap().to_string(), get(m, "estimate").as_f64().unwrap(), bound("lowerBound"), bound("upperBound"))
        })
        .collect()
}

#[test]
fn the_priority_example_runs_in_process_and_files_the_exact_record() {
    let (ctx, path) = context(PRIORITY);
    let outcome = common::run(Method::PriorityExact, &ctx);
    assert!(outcome.launched && outcome.exit_code == Some(0), "{:?}", outcome.status);
    assert_eq!(outcome.status.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Running exact priority queue (closed-form mean values)."]);
    assert_eq!(outcome.parameters["discipline"], "Priority, preemptive-resume");
    assert_eq!(outcome.parameters["priority order"], "Class 1 > Class 2");
    assert!(outcome.archive.starts_with("Exact priority queue (single station, Poisson arrivals)\nModel: PriorityHelpDesk.mg1.2class.bnet\nStation: S1  servers: 1  discipline: priority, preemptive-resume\n"), "{}", outcome.archive);

    let exact = priority::solve(&priority::from_network(&ctx.network).unwrap()).unwrap();
    // By hand: T₁ = 10/7, T₂ = 50/7, L = 13/7 (see src-tauri/src/live.rs).
    assert!((exact.number - 13.0 / 7.0).abs() < 1e-12);
    let record = common::file_record(Method::PriorityExact, &ctx, &path, &outcome).expect("a record");
    assert_eq!(get(&record, "status").as_str(), Some("completed"));
    assert_eq!(get(get(&record, "method"), "identifier").as_str(), Some("queue.priority-exact"));
    assert_eq!(get(get(&record, "method"), "fidelity").as_str(), Some("Exact queueing result"));
    let snapshot = get(get(&record, "provenance"), "networkSnapshot");
    let station = get(snapshot, "nodes").as_array().unwrap().iter().find(|n| get(n, "name").as_str() == Some("S1")).unwrap();
    assert_eq!(get(station, "serviceDiscipline").as_str(), Some("priorityPreemptiveResume"), "the discipline is part of what was solved");
    let got = measurements(&record);
    assert_eq!(got.len(), 6);
    let value = |metric: &str| got.iter().find(|m| m.0 == metric).map(|m| m.1).unwrap_or_else(|| panic!("{metric}"));
    let near = |a: f64, b: f64| (a - b).abs() <= 1e-10 * b.abs().max(1.0);
    assert!(near(value("Mean number in system"), exact.number) && near(value("Mean queue length"), exact.queue) && near(value("Mean sojourn time"), exact.sojourn) && near(value("Mean waiting time"), exact.wait) && near(value("Server utilization"), 0.7) && near(value("Throughput"), 0.5));
    assert!(got.iter().all(|m| m.2.is_none()), "an exact value has no interval");

    // The second opinion: the simulation's 95 % intervals on the same station. Seed fixed, so
    // this is one recorded run; the coverage over many seeds is core's (simstat/tests_extended.rs).
    let (mut sim, _) = context(PRIORITY);
    for (k, v) in [("sim.seedFixed", "true"), ("sim.seed", "2026")] {
        sim.settings.set(k, v).unwrap();
    }
    let outcome = common::run(Method::InProcessSimulation, &sim);
    assert!(outcome.launched && outcome.exit_code == Some(0), "{:?}", outcome.status);
    assert!(outcome.archive.contains("\nPer class: estimate ± half-width of the 95 % interval\n") && outcome.archive.contains("  S1       Class 2  "), "{}", outcome.archive);
    let record = common::file_record(Method::InProcessSimulation, &sim, &path, &outcome).expect("a record");
    let estimates = measurements(&record);
    let number = estimates.iter().find(|m| m.0 == "Mean number in system").unwrap();
    assert!((number.1 - exact.number).abs() < 0.03 * exact.number, "simulated {} against exact {}", number.1, exact.number);
    assert!(number.2.unwrap() < number.1 && number.1 < number.3.unwrap());
}

#[test]
fn the_batch_example_runs_in_process_and_files_the_exact_record() {
    let (ctx, path) = context(BATCH);
    let outcome = common::run(Method::BatchExact, &ctx);
    assert!(outcome.launched && outcome.exit_code == Some(0), "{:?}", outcome.status);
    assert_eq!(outcome.parameters["batch size"], "geometric, mean 2.5");
    let exact = batch::solve(&batch::from_network(&ctx.network).unwrap()).unwrap();
    // Geometric batches of mean 2.5 (α = 0.6) at 0.24 per time unit, μ = 1: ρ = 0.6, L = ρ/((1 − α)(1 − ρ)) = 3.75.
    assert!((exact.number - 3.75).abs() < 1e-12 && (exact.utilisation - 0.6).abs() < 1e-12);
    let record = common::file_record(Method::BatchExact, &ctx, &path, &outcome).expect("a record");
    assert_eq!(get(get(&record, "method"), "identifier").as_str(), Some("queue.batch-arrival-exact"));
    let got = measurements(&record);
    let value = |metric: &str| got.iter().find(|m| m.0 == metric).map(|m| m.1).unwrap();
    assert!((value("Mean number in system") - 3.75).abs() < 1e-10 && (value("Throughput") - 0.6).abs() < 1e-10 && (value("Mean waiting time") - 5.25).abs() < 1e-10);
}

#[test]
fn every_classical_method_refuses_a_network_with_a_new_feature_and_each_exact_method_says_what_is_not_its_own() {
    for (file, what) in [(PRIORITY, "priority service at S1"), (BATCH, "batch arrivals at Src1"), (RUSH, "a time-varying arrival rate at Src1")] {
        let (ctx, _) = context(file);
        for method in Method::INFINITE.iter().chain(Method::FINITE.iter()) {
            let outcome = common::run(*method, &ctx);
            assert!(!outcome.launched, "{method:?} on {file}");
            assert_eq!(outcome.status.len(), 1, "{method:?} on {file}: {:?}", outcome.status);
            let text = &outcome.status[0].text;
            assert!(text.contains(&format!(" not started: This network uses {what}. ")) && text.contains(" does not model that, and would answer for a different network."), "{text}");
        }
    }
    let said = |method: Method, file: &str| {
        let (ctx, _) = context(file);
        let outcome = common::run(method, &ctx);
        assert!(!outcome.launched, "{method:?} on {file}");
        outcome.status[0].text.clone()
    };
    assert_eq!(said(Method::PriorityExact, BATCH), "Exact Priority Queue not started: No station of this network has priority service, so there is nothing for the priority formulas to compute.");
    assert_eq!(said(Method::BatchExact, "OpenJackson.d2.feedback.p30.inf.bnet"), "Exact Batch-Arrival Queue not started: No source of this network has batch arrivals, so there is nothing for the batch formula to compute.");
    assert!(said(Method::InProcessSimulation, RUSH).starts_with("Replicated Simulation not started: This network has a time-varying arrival rate, so it has no single steady state"));

    // A priority station inside a larger network: no exact claim, in a sentence that says what is covered.
    let (mut tandem, _) = context("3d2ctandem.inf.bnet");
    let s1 = tandem.network.nodes.iter_mut().find(|n| n.name == "S1").unwrap();
    s1.discipline = qnet_core::model::Discipline::NonPreemptive;
    s1.priority_order = vec![0, 1];
    let outcome = common::run(Method::PriorityExact, &tandem);
    assert!(!outcome.launched);
    assert_eq!(outcome.status[0].text, "Exact Priority Queue not started: The network has 3 stations. The exact priority formulas cover a single station fed directly by Poisson sources, with infinite buffers and no feedback; for any other network with priorities use Replicated Simulation.");
    // …and the simulator takes it.
    assert!(qnet_core::simstat::plan(&tandem.network).is_ok());
    // A closed network with a priority discipline is refused by its own method too.
    let (mut closed, _) = context("closed/ClosedCentralServer.d3.N8.bnet");
    closed.network.nodes.iter_mut().find(|n| n.name == "S1").unwrap().discipline = qnet_core::model::Discipline::NonPreemptive;
    let outcome = common::run(Method::ClosedProductForm, &closed);
    assert!(!outcome.launched && outcome.status[0].text.contains("S1 has priority service, which Qnet models in open networks only"), "{:?}", outcome.status);

    for (label, method) in [("priority_exact", Method::PriorityExact), ("batch_exact", Method::BatchExact)] {
        assert_eq!(Method::from_label(label), Some(method));
        assert!(!method.in_menu(true) && !method.in_menu(false), "0.90.34's two menus are as they were");
    }
}
