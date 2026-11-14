//! 0.90.34's headless parser harness (`validation/result_output_parser/main.swift`, its
//! `stubs.swift` and `result_output_parser_check.sh`), one Rust test per Swift check function, with
//! the same inputs and the same expectations. The Swift harness ran a run record whose snapshot held
//! a buffer "Waiting Room" and the station "Checkout" (id AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE), with
//! that station as the only export-order station.
//!
//! Beyond the Swift checks, each test also pins the exact sentences and values, which the Swift
//! checks only tested by fragment.

use std::collections::BTreeMap;

use super::icu::localized_ci_contains;
use super::model::*;
use super::parser::{parse_with_ids, Disposition, ParsedOutput};
use crate::model::{Node, NodeKind};

const STATION_ID: &str = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

fn run(method: &str) -> RunRecord {
    let station = Node::new(STATION_ID, NodeKind::Station, "Checkout", (0.0, 0.0));
    let ignored = Node::new("11111111-2222-3333-4444-555555555555", NodeKind::Buffer, "Waiting Room", (0.0, 0.0));
    let snapshot = NetworkSnapshot { nodes: vec![ignored, station], links: vec![], infinite_buffers: true, population: None };
    let provenance = Provenance {
        tab_id: "00000000-0000-0000-0000-000000000000".into(),
        network_title: "check".into(),
        source_file_url: None,
        network_fingerprint: snapshot.fingerprint(),
        network_snapshot: snapshot,
        buffer_regime: "Infinite capacity".into(),
        parameters: BTreeMap::new(),
        seed: None,
        replication_seeds: vec![],
        application_version: "test".into(),
        solver_version: None,
        export_station_ids: Some(vec![STATION_ID.into()]),
    };
    RunRecord::new("99999999-9999-4999-8999-999999999999", MethodMetadata::named(method).unwrap(), provenance, Date::from_unix(0.0))
}

fn parse(raw: Option<&str>, method: &str) -> ParsedOutput {
    let mut n = 0;
    parse_with_ids(raw, &run(method), &mut || {
        n += 1;
        format!("00000000-0000-4000-8000-{n:012}")
    })
}

fn measurement<'a>(metric: &str, parsed: &'a ParsedOutput) -> Option<&'a Measurement> {
    parsed.measurements.iter().find(|m| m.metric == metric)
}

fn close(actual: Option<f64>, expected: f64, tolerance: f64, message: &str) {
    let a = actual.unwrap_or_else(|| panic!("{message}: expected {expected}, got nil"));
    assert!((a - expected).abs() <= tolerance, "{message}: expected {expected}, got {a}");
}

fn require_partial(d: &Disposition, fragment: &str, message: &str) {
    match d {
        Disposition::Partial(reason) if localized_ci_contains(reason, fragment) => {}
        _ => panic!("{message}: {d:?}"),
    }
}

fn require_failed(d: &Disposition, fragment: &str, message: &str) {
    match d {
        Disposition::Failed(reason) if localized_ci_contains(reason, fragment) => {}
        _ => panic!("{message}: {d:?}"),
    }
}

#[test]
fn empty_and_malformed_output_are_hard_failures() {
    for raw in [None, Some("")] {
        let parsed = parse(raw, ids::OPEN_PRODUCT_FORM);
        assert!(parsed.measurements.is_empty(), "empty output produced measurements");
        assert!(parsed.evidence.is_none(), "empty output produced evidence");
        require_failed(&parsed.disposition, "produced no output", "empty output was not a hard failure");
        assert_eq!(parsed.warnings, ["The solver completed without capturable standard output."]);
        assert_eq!(
            parsed.disposition,
            Disposition::Failed("The solver exited successfully but produced no output. No performance measures can be trusted from this run.".into())
        );
    }
    let malformed = parse(Some("solver says everything is probably fine\n"), ids::OPEN_PRODUCT_FORM);
    assert!(malformed.measurements.is_empty(), "malformed output produced measurements");
    require_failed(&malformed.disposition, "no recognized station performance measures", "malformed output was not a hard failure");
    assert!(malformed.warnings.iter().any(|w| w.contains("No recognized station measurements")), "malformed output did not retain an inspection warning");
    assert_eq!(malformed.warnings, ["No recognized station measurements were found; inspect the retained raw output."]);
}

#[test]
fn bar_output_without_bounds_fails_but_keeps_its_relaxation_evidence() {
    let raw = "BAR moment relaxation\nCertified: no\nRelaxation: 12 moments, 4 equalities, 2 PSD blocks\nNo compatible SDP backend is installed.";
    let parsed = parse(Some(raw), ids::BAR_MOMENT_BOUNDS);
    assert!(parsed.measurements.is_empty(), "BAR backend-none output produced a bound");
    require_failed(&parsed.disposition, "produced no performance bounds", "BAR backend-none output was not a hard failure");
    let evidence = parsed.evidence.as_ref().unwrap();
    assert_eq!(evidence.discretization.as_deref(), Some("12 moments, 4 equalities, 2 PSD blocks"), "BAR relaxation evidence was lost");
    assert_eq!(evidence.convergence_note.as_deref(), Some("Uncertified BAR relaxation result"), "BAR certification evidence was lost");
    assert_eq!(
        parsed.warnings,
        [
            "No numerical bounds were produced. The conic relaxation was built, but a general model needs an installed SDP backend; inspect the retained relaxation summary.",
            "General floating-point SDP values are feasibility-checked but are not certified numerical bounds.",
        ]
    );
}

#[test]
fn adaptive_bar_that_did_not_converge_is_partial() {
    let raw = "Adaptive low-rank BAR analysis\nRank: 8  converged: no\nE[Z_1] = 3.25    Var[Z_1] = 1.5\nHeld-out relative BAR RMS = 0.002";
    let parsed = parse(Some(raw), ids::ADAPTIVE_LOW_RANK_BAR);
    require_partial(&parsed.disposition, "maximum mixture rank", "adaptive nonconvergence was not partial");
    assert_eq!(parsed.measurements.len(), 2, "adaptive output did not retain both moments");
    close(measurement("Mean workload", &parsed).map(|m| m.estimate), 3.25, 1e-12, "adaptive mean was parsed incorrectly");
    close(parsed.evidence.as_ref().and_then(|e| e.residual), 0.002, 1e-12, "adaptive validation residual was lost");
    assert_eq!(parsed.evidence.as_ref().unwrap().discretization.as_deref(), Some("mixture rank 8"), "adaptive rank evidence was lost");
    assert_eq!(measurement("Workload variance", &parsed).unwrap().unit, "work²");
    assert_eq!(measurement("Mean workload", &parsed).unwrap().station_name, "Checkout");
}

const REGENERATIVE_METRIC: &str =
    "QNET_NODE_METRIC_V1 node_id=s1 metric=mean_number class_id=- estimate=2.5 standard_error=0.1 ci_confidence=0.95 ci_low=2.3 ci_high=2.7 ci_half_width=0.2 effective_cycles=40";

#[test]
fn regenerative_output_is_partial_when_precision_is_missed_and_failed_with_no_cycle() {
    let partial_raw = format!("Complete empty-to-empty cycles: 40\nPrecision target met: no\n{REGENERATIVE_METRIC}");
    let partial = parse(Some(&partial_raw), ids::REGENERATIVE_MONTE_CARLO);
    require_partial(&partial.disposition, "precision target was not met", "regenerative safeguard stop was not partial");
    assert_eq!(partial.measurements.len(), 1, "regenerative estimate was discarded");
    let m = &partial.measurements[0];
    close(m.uncertainty.as_ref().and_then(|u| u.standard_error), 0.1, 1e-12, "regenerative standard error was lost");
    let evidence = partial.evidence.as_ref().unwrap();
    assert_eq!(evidence.discretization.as_deref(), Some("40 complete regenerative cycles"), "regenerative cycle evidence was lost");
    assert!(evidence.convergence_note.as_deref().unwrap().contains("no"), "regenerative precision evidence was lost");
    assert_eq!(evidence.convergence_note.as_deref(), Some("Sequential fixed-width target met: no"));
    assert_eq!(m.note.as_deref(), Some("Effective complete cycles: 40"));
    assert_eq!((m.station_id.as_deref(), m.customer_class), (Some(STATION_ID), None));
    assert_eq!(
        m.uncertainty,
        Some(Uncertainty { standard_error: Some(0.1), lower_bound: Some(2.3), upper_bound: Some(2.7), confidence_level: Some(0.95), sample_size: None })
    );

    let zero_raw = format!("Complete empty-to-empty cycles: 0\nPrecision target met: no\n{REGENERATIVE_METRIC}");
    let zero = parse(Some(&zero_raw), ids::REGENERATIVE_MONTE_CARLO);
    require_failed(&zero.disposition, "No complete empty-to-empty regenerative cycle", "zero-cycle regenerative output was not a hard failure");
}

#[test]
fn mlmc_that_hit_its_sample_cap_is_partial_and_one_that_met_precision_completes() {
    let capped = parse(Some("L_1 = 2.5000 ± 0.4000 (95%)\nQNET_MLMC_STATUS_V1 adaptive=yes precision_met=no cap_hits=1\n"), ids::SRBM_MLMC);
    require_partial(&capped.disposition, "sample cap", "adaptive MLMC cap exhaustion was not partial");
    assert_eq!(capped.measurements.len(), 1, "capped MLMC estimate was discarded");
    close(capped.measurements[0].uncertainty.as_ref().and_then(|u| u.upper_bound), 2.9, 1e-12, "MLMC 95% half-width was not retained");
    assert!(capped.evidence.as_ref().unwrap().convergence_note.as_deref().unwrap().contains("cap hits: 1"), "MLMC cap evidence was lost");

    let met = parse(Some("L_1 = 2.5000 ± 0.4000 (95%)\nQNET_MLMC_STATUS_V1 adaptive=yes precision_met=yes cap_hits=0\n"), ids::SRBM_MLMC);
    assert_eq!(met.disposition, Disposition::Completed, "precision-qualified MLMC output did not complete");
    assert_eq!(met.evidence.unwrap().convergence_note.as_deref(), Some("Adaptive MLMC precision target met: yes (cap hits: 0)"));
}

#[test]
fn a_truncated_ctmc_that_did_not_converge_is_partial() {
    let raw = "Selected total cap: 40\nNode 1 Checkout: E[N]=8.5 utilization=0.9 departure=1.0\nsuccessive refinement relative change = 0.05\nHeuristic converged: no";
    let parsed = parse(Some(raw), ids::TRUNCATED_CTMC);
    require_partial(&parsed.disposition, "did not converge", "truncated-cap nonconvergence was not partial");
    assert_eq!(parsed.measurements.len(), 3, "truncated CTMC metrics were lost");
    let evidence = parsed.evidence.as_ref().unwrap();
    assert_eq!(evidence.discretization.as_deref(), Some("total-population cap 40"), "truncation cap evidence was lost");
    close(evidence.refinement_delta, 0.05, 1e-12, "truncation refinement evidence was lost");
    assert_eq!(evidence.convergence_note.as_deref(), Some("Truncation criteria met: no (heuristic)"));
}

#[test]
fn an_sbd_fallback_is_partial_and_keeps_the_export_order_station() {
    let parsed = parse(Some("rho_1 = 0.9\nGamma_1 = 1.0\nsojourn_1 = 10.0\nQNET_SBD_STATUS_V1 fallback_used=yes"), ids::SBD);
    require_partial(&parsed.disposition, "fallback approximation", "SBD fallback was not partial");
    assert_eq!(parsed.measurements.len(), 3, "SBD fallback metrics were discarded");
    assert!(parsed.measurements.iter().all(|m| m.station_id.as_deref() == Some(STATION_ID)), "export-order station identity was not preserved");
    let metrics: Vec<(&str, &str)> = parsed.measurements.iter().map(|m| (m.metric.as_str(), m.unit.as_str())).collect();
    assert_eq!(metrics, [("Utilization", "ratio"), ("Throughput", "customers / time"), ("Mean sojourn time", "time")]);
}

#[test]
fn a_comparison_is_partial_with_a_success_and_failed_when_every_method_failed() {
    let partial = parse(Some("E[X_1]      —       2.5       2.7\nQNET_COMPARISON_STATUS_V1 partial=yes successful=qna failed=spectral"), ids::COMPARISON);
    require_partial(&partial.disposition, "one or more methods failed", "mixed comparison was not partial");
    assert_eq!(partial.measurements.len(), 1, "successful comparison value was lost");
    close(Some(partial.measurements[0].estimate), 2.5, 1e-12, "comparison did not retain its first available value");
    assert_eq!(
        partial.warnings,
        [
            "The structured table records the first value in each comparison row; the retained raw output contains every method column.",
            "One or more comparison methods failed or were skipped; successful columns remain available.",
        ]
    );

    let all_failed = parse(Some("QNET_COMPARISON_STATUS_V1 partial=yes successful=0 failed=all\n"), ids::COMPARISON);
    require_failed(&all_failed.disposition, "Every method in the comparison failed", "all-failed comparison was not a hard failure");
}

/// Both spellings of a simulator's half-width become the same 95 % interval, never a standard
/// error, and a row without one gets no interval.
#[test]
fn simulation_half_widths_become_intervals_in_both_spellings() {
    let legacy = parse(Some("rho_1 = 0.900000\t(0.012000)\nE[X_1] = 9.000000\t(0.400000)\nGamma_1 = 1.000000"), ids::MONTE_CARLO);
    let rho = measurement("Utilization", &legacy).and_then(|m| m.uncertainty.clone());
    close(rho.as_ref().and_then(|u| u.lower_bound), 0.888, 1e-9, "parenthesised half-width did not become an interval");
    close(rho.as_ref().and_then(|u| u.upper_bound), 0.912, 1e-9, "parenthesised half-width did not become an interval");
    close(rho.as_ref().and_then(|u| u.confidence_level), 0.95, 1e-12, "parenthesised half-width lost its confidence level");
    assert!(rho.as_ref().unwrap().standard_error.is_none(), "a half-width was recorded as a standard error");
    close(measurement("Mean reported occupancy", &legacy).and_then(|m| m.uncertainty.as_ref()?.lower_bound), 8.6, 1e-9, "E[X] parenthesised half-width was lost");
    assert!(measurement("Throughput", &legacy).unwrap().uncertainty.is_none(), "a row with no reported half-width acquired an interval");

    // The comparison-table spelling, with the %-delta the normalisation strips first.
    let plus_minus = parse(Some("rho_1      0.900 ± 0.012 (+0.1%)  0.899\nE[X_1]     9.000 ± 0.400 (+0.0%)  9.000"), ids::MONTE_CARLO);
    close(measurement("Utilization", &plus_minus).map(|m| m.estimate), 0.9, 1e-12, "± row lost its estimate");
    close(measurement("Utilization", &plus_minus).and_then(|m| m.uncertainty.as_ref()?.upper_bound), 0.912, 1e-9, "± half-width did not become an interval");
    close(measurement("Mean reported occupancy", &plus_minus).and_then(|m| m.uncertainty.as_ref()?.lower_bound), 8.6, 1e-9, "E[X] ± half-width was lost");
}

#[test]
fn a_product_form_station_row_completes_with_four_measures() {
    let parsed = parse(Some("Exact open BCMP product-form analysis\nStation s1 (fcfs): E[N]=9 throughput=1 utilization=0.9 margin=0.1"), ids::OPEN_PRODUCT_FORM);
    assert_eq!(parsed.disposition, Disposition::Completed, "valid product-form output did not complete");
    assert_eq!(parsed.measurements.len(), 4, "product-form station row was incomplete");
    close(measurement("Mean number in system", &parsed).map(|m| m.estimate), 9.0, 1e-12, "product-form mean was parsed incorrectly");
    assert_eq!(measurement("Mean number in system", &parsed).unwrap().station_name, "Checkout", "product-form station mapping was lost");
    assert!(parsed.warnings.is_empty(), "valid product-form output produced warnings");
}

/// New in 2.1 (ledger SCI-506): the rows of Exact Closed Product Form (runner `methods/closed.rs`).
#[test]
fn a_closed_station_row_completes_with_six_measures_and_nothing_else_is_read() {
    let raw = "Exact closed product-form analysis (Gordon-Newell)\nModel: t\nPopulation: N=8  reference station: S1 (visit ratio 1)\nMethod: Buzen convolution; exact MVA agrees to 1.2e-16\nNormalising constant: ln G(N)=-3.25\nNetwork: throughput at S1 (visits per time unit)=5.5  cycle time between visits to S1 (N/X)=1.4545\nClosed station s1 (Checkout): visits=1  X=5.5  E[N]=1.25  E[Q]=0.7  util=0.55  W=0.127272727273  T=0.227272727273\nMarginal distributions P(n customers at the station), n = 0..8\n  Checkout | 0.450000 0.250000 0.100000";
    let parsed = parse(Some(raw), ids::CLOSED_PRODUCT_FORM);
    assert_eq!(parsed.disposition, Disposition::Completed);
    let got: Vec<(&str, f64, &str)> = parsed.measurements.iter().map(|m| (m.metric.as_str(), m.estimate, m.unit.as_str())).collect();
    assert_eq!(
        got,
        [
            ("Throughput", 5.5, "customers / time"),
            ("Mean number in system", 1.25, "customers"),
            ("Mean queue length", 0.7, "customers"),
            ("Server utilization", 0.55, "ratio"),
            ("Mean waiting time", 0.127272727273, "time"),
            ("Mean sojourn time", 0.227272727273, "time"),
        ]
    );
    assert!(parsed.measurements.iter().all(|m| m.station_name == "Checkout" && m.uncertainty.is_none()));
    assert!(parsed.warnings.is_empty());
    let meta = MethodMetadata::for_run_label("closed_pf").unwrap();
    assert_eq!((meta.identifier.as_str(), meta.fidelity.raw(), meta.layer.raw()), ("queue.closed-product-form", "Exact queueing result", "Queueing process"));
    assert_eq!(MethodMetadata::catalogue().len(), 22, "0.90.34's catalogue is as it was");
}

/// New in 2.1 (ledger SCI-1006, SCI-1013): the station row of Exact Priority Queue and Exact
/// Batch-Arrival Queue (runner `methods/singlestation.rs`) is read like the closed one; the
/// per-class rows and the rest are for the reader.
#[test]
fn an_exact_station_row_of_the_priority_and_batch_methods_completes_with_six_measures() {
    let raw = "Exact priority queue (single station, Poisson arrivals)\nModel: t\nStation: Checkout  servers: 1  discipline: priority, non-preemptive\nFormula: M/G/1 non-preemptive priority (Cobham 1954)\nExact station s1 (Checkout): visits=1  X=0.5  E[N]=2.21904761905  E[Q]=1.51904761905  util=0.7  W=3.0380952381  T=4.4380952381\n\nPer class, in priority order\n  Class    Arrival rate\n  Class 1  0.3\nQNET_CLASS_V1 node_id=s1 class=1 arrival_rate=0.3 wait=1.57142857143 sojourn=2.57142857143 mean_number=0.771428571429 mean_queue=0.471428571429\n";
    for (method, label, name) in [(ids::PRIORITY_EXACT, "priority_exact", "Exact Priority Queue"), (ids::BATCH_EXACT, "batch_exact", "Exact Batch-Arrival Queue")] {
        let parsed = parse(Some(raw), method);
        assert_eq!(parsed.disposition, Disposition::Completed);
        let got: Vec<(&str, f64)> = parsed.measurements.iter().map(|m| (m.metric.as_str(), m.estimate)).collect();
        assert_eq!(got, [("Throughput", 0.5), ("Mean number in system", 2.21904761905), ("Mean queue length", 1.51904761905), ("Server utilization", 0.7), ("Mean waiting time", 3.0380952381), ("Mean sojourn time", 4.4380952381)]);
        assert!(parsed.measurements.iter().all(|m| m.station_name == "Checkout" && m.uncertainty.is_none()) && parsed.warnings.is_empty());
        let meta = MethodMetadata::for_run_label(label).unwrap();
        assert_eq!((meta.identifier.as_str(), meta.display_name.as_str(), meta.fidelity.raw()), (method, name, "Exact queueing result"));
    }
    assert_eq!(MethodMetadata::catalogue().len(), 22, "0.90.34's catalogue is as it was");
}

/// New in 2.1 (ledger SIM-106): the rows of Replicated Simulation (runner `methods/siminproc.rs`).
#[test]
fn a_replicated_simulation_row_carries_its_student_interval_and_the_status_row_its_end() {
    let raw = "Replicated simulation (independent replications, in process)\nModel: t\nQNET_SIM_STATUS_V1 replications=20 target_met=na warmup_inconclusive=no\nQNET_SIM_METRIC_V1 node_id=s1 metric=throughput estimate=5.5 standard_error=0.01 ci_confidence=0.95 ci_low=5.479 ci_high=5.521 replications=20\nQNET_SIM_METRIC_V1 node_id=s1 metric=mean_number estimate=1.25 standard_error=0.02 ci_confidence=0.95 ci_low=1.208 ci_high=1.292 replications=20\nQNET_SIM_METRIC_V1 node_id=s1 metric=mean_queue estimate=0.7 standard_error=0.02 ci_confidence=0.95 ci_low=0.66 ci_high=0.74 replications=20\nQNET_SIM_METRIC_V1 node_id=s1 metric=utilization estimate=0.55 standard_error=0.001 ci_confidence=0.95 ci_low=0.548 ci_high=0.552 replications=20\nQNET_SIM_METRIC_V1 node_id=s1 metric=mean_waiting_time estimate=0.127 standard_error=0.003 ci_confidence=0.95 ci_low=0.121 ci_high=0.133 replications=20\nQNET_SIM_METRIC_V1 node_id=s1 metric=mean_sojourn_time estimate=0.227 standard_error=0.003 ci_confidence=0.95 ci_low=0.221 ci_high=0.233 replications=20\nQNET_SIM_METRIC_V1 node_id=s1 metric=unknown estimate=1 standard_error=0 ci_confidence=0.95 ci_low=1 ci_high=1 replications=20\n\nEstimate ± half-width of the 95 % interval\n  Checkout  5.5 ± 0.021";
    let parsed = parse(Some(raw), ids::REPLICATED_SIMULATION);
    assert_eq!(parsed.disposition, Disposition::Completed);
    let got: Vec<(&str, f64, &str)> = parsed.measurements.iter().map(|m| (m.metric.as_str(), m.estimate, m.unit.as_str())).collect();
    assert_eq!(
        got,
        [
            ("Throughput", 5.5, "customers / time"),
            ("Mean number in system", 1.25, "customers"),
            ("Mean queue length", 0.7, "customers"),
            ("Server utilization", 0.55, "ratio"),
            ("Mean waiting time", 0.127, "time"),
            ("Mean sojourn time", 0.227, "time"),
        ],
        "the same quantities, by the same names, as Exact Closed Product Form"
    );
    let l = measurement("Mean number in system", &parsed).unwrap();
    assert_eq!(l.station_name, "Checkout");
    let u = l.uncertainty.as_ref().unwrap();
    assert_eq!((u.standard_error, u.lower_bound, u.upper_bound, u.confidence_level, u.sample_size), (Some(0.02), Some(1.208), Some(1.292), Some(0.95), Some(20)));
    assert!(parsed.warnings.is_empty());
    assert_eq!(parsed.evidence.as_ref().unwrap().discretization.as_deref(), Some("20 independent replications"));
    assert_eq!(parsed.evidence.as_ref().unwrap().convergence_note, None);

    // A precision target that a cap cut short is a partial run; a warm-up the rule could not place is a warning.
    let short = raw.replace("target_met=na warmup_inconclusive=no", "target_met=no warmup_inconclusive=yes");
    let parsed = parse(Some(&short), ids::REPLICATED_SIMULATION);
    assert!(matches!(parsed.disposition, Disposition::Partial(_)));
    assert_eq!(parsed.warnings.len(), 2);
    assert_eq!(parsed.evidence.as_ref().unwrap().convergence_note.as_deref(), Some("Sequential relative-precision target met: no"));
    // The rows belong to this method alone.
    assert!(parse(Some(raw), ids::MONTE_CARLO).measurements.is_empty());

    let meta = MethodMetadata::for_run_label("sim_inproc").unwrap();
    assert_eq!((meta.identifier.as_str(), meta.fidelity.raw(), meta.layer.raw(), meta.display_name.as_str()), ("queue.des-replications", "Queue simulation", "Queueing process", "Replicated Simulation"));
    assert_eq!(MethodMetadata::named("queue.des-replications"), Some(meta));
    assert_eq!(MethodMetadata::catalogue().len(), 22, "0.90.34's catalogue is as it was");
}

/// Review finding FIX-205: a replicated simulation that stopped on the wall-time cap is not
/// reproducible from its seed alone, and its record says so.
#[test]
fn a_replicated_simulation_stopped_on_the_time_cap_is_recorded_as_not_reproducible_by_seed() {
    let row = "QNET_SIM_METRIC_V1 node_id=s1 metric=mean_number estimate=1.25 standard_error=0.02 ci_confidence=0.95 ci_low=1.208 ci_high=1.292 replications=15\n";
    let head = "Replicated simulation (independent replications, in process)\nModel: t\n";
    let capped = format!("{head}Reproducibility: not by the seed alone. The run stopped on the cap on wall time, after 15 replications; how many replications fit in the time depends on the machine's speed.\nQNET_SIM_STATUS_V1 replications=15 target_met=no warmup_inconclusive=no\n{row}");
    let parsed = parse(Some(&capped), ids::REPLICATED_SIMULATION);
    assert!(parsed.warnings.iter().any(|w| w.starts_with("This result is not reproducible from its seed alone: the run stopped on the cap on wall time")), "{:?}", parsed.warnings);
    let other = format!("{head}QNET_SIM_STATUS_V1 replications=15 target_met=no warmup_inconclusive=no\n{row}");
    assert!(parse(Some(&other), ids::REPLICATED_SIMULATION).warnings.iter().all(|w| !w.contains("reproducible")));
}

#[test]
fn qbd_metrics_and_evidence_are_read_from_their_sentinels() {
    let raw = "QNET_QBD_METRIC_V1 metric=mean_level estimate=1
QNET_QBD_METRIC_V1 metric=probability_empty estimate=0.5
QNET_QBD_METRIC_V1 metric=tail_probability level=5 estimate=0.03125
QNET_QBD_EVIDENCE_V1 key=stability_classification value=positive_recurrent
QNET_QBD_EVIDENCE_V1 key=iterations value=12
QNET_QBD_EVIDENCE_V1 key=rate_equation_residual_inf value=1e-14
QNET_QBD_EVIDENCE_V1 key=boundary_balance_residual_scaled value=-2e-13
QNET_QBD_EVIDENCE_V1 key=normalization_residual value=3e-15";
    let parsed = parse(Some(raw), ids::QBD);
    assert_eq!(parsed.disposition, Disposition::Completed, "valid QBD output did not complete");
    assert_eq!(parsed.measurements.len(), 3, "QBD metrics were not fully parsed");
    close(measurement("Mean number in system", &parsed).map(|m| m.estimate), 1.0, 1e-12, "QBD mean level was parsed incorrectly");
    close(measurement("Tail probability P(N ≥ 5)", &parsed).map(|m| m.estimate), 0.03125, 1e-12, "QBD tail probability was parsed incorrectly");
    let evidence = parsed.evidence.as_ref().unwrap();
    close(evidence.residual, 2e-13, 1e-12, "QBD worst residual was not retained");
    assert_eq!(evidence.residual, Some(2e-13));
    assert_eq!(evidence.discretization.as_deref(), Some("matrix-geometric rate solve, 12 iterations"), "QBD iteration evidence was lost");
    assert_eq!(evidence.convergence_note.as_deref(), Some("QBD stability classification: positive recurrent"), "QBD stability evidence was lost");
}
