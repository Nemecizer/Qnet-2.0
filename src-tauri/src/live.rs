//! Live results while drawing (new in 2.1, ROADMAP Phase D): `live_results`, the closed-form
//! steady state of the document as it is, computed in-process by `qnet_core::jackson` — no solver
//! process, no file. The interface asks after every structural edit (src/live/), so the command is
//! async: the arithmetic runs off the main thread and a slow answer never holds the window.
//!
//! The answer says how much it knows (`tier`): "exact" for a Jackson network (every quantity),
//! "utilisation" where no closed form applies or there is no steady state (ρ only, with the
//! reason), "none" when the traffic equations cannot be solved for the network as drawn.

use serde::Serialize;
use serde_json::Value;

use qnet_core::model::Network;
use qnet_core::{bnet, closed, jackson};

use crate::errors::QnError;

/// One station (src/lib/types.ts `LiveStation`). The queue quantities are null unless the tier is
/// exact. Units: customers, time units, customers per time unit.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveStation {
    pub station_id: String,
    pub station_name: String,
    pub servers: i64,
    pub throughput: f64,
    pub service_rate: f64,
    pub utilisation: Option<f64>,
    pub mean_in_system: Option<f64>,
    pub mean_waiting: Option<f64>,
    pub mean_sojourn: Option<f64>,
    pub mean_wait: Option<f64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveNetwork {
    pub throughput: f64,
    pub mean_number: f64,
    pub mean_delay: f64,
}

/// src/lib/types.ts `LiveResults`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveResults {
    /// "exact", "utilisation" or "none".
    pub tier: &'static str,
    pub per_station: Vec<LiveStation>,
    pub network: Option<LiveNetwork>,
    /// Why the tier is not exact: "unstable", "finiteBuffers", "noTraffic", "sharedStation",
    /// "notExponential", "notCertified", "noModel", or "extended" (priorities, batch arrivals or
    /// a rate profile outside the single-station cases with an exact formula).
    pub reason_if_partial: Option<&'static str>,
    /// The station names the reason is about, or the traffic equations' own sentence for "noModel".
    pub reason_detail: String,
    /// ρ is the long-run utilisation (true) or only the offered load (finite buffers, unstable).
    pub utilisation_exact: bool,
    /// The station(s) with the highest ρ: several when they tie (core `jackson::TIE_TOLERANCE`).
    pub bottlenecks: Vec<String>,
    /// Present for a closed network (new in 2.1, core `closed.rs`): then `network.throughput` is
    /// the rate of passes through the reference station, `network.mean_number` the population and
    /// `network.mean_delay` the mean cycle time N/X.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<LiveClosed>,    /// Present when the exact tier is not Jackson's closed form but a single-station formula
    /// of a feature new in 2.1: "priority" (core `priority.rs`) or "batch" (core `batch.rs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<&'static str>,
}

/// src/live/model.ts `LiveResults.closed`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveClosed {
    pub population: i64,
    /// The station whose visit ratio is 1: the first in export order.
    pub reference_station: String,
}

/// The live results of a network drawn as a closed one (no source, no sink): the exact
/// Gordon–Newell means by `closed::means` (MVA, or convolution with several servers), or nothing
/// with the reason ("closed", and core's sentence).
fn closed_results(net: &Network) -> LiveResults {
    let solved = closed::from_network(net).and_then(|m| closed::means(&m).map(|s| (m, s)));
    let (m, s) = match solved {
        Ok(x) => x,
        Err(e) => {
            return LiveResults {
                tier: "none",
                per_station: Vec::new(),
                network: None,
                reason_if_partial: Some(if e == closed::ClosedError::PopulationMissing { "closedNoPopulation" } else { "closed" }),
                reason_detail: e.message(),
                utilisation_exact: false,
                bottlenecks: Vec::new(),
                closed: None,
                formula: None,
            }
        }
    };
    let per_station = (0..m.ids.len())
        .map(|i| LiveStation {
            station_id: m.ids[i].clone(),
            station_name: m.names[i].clone(),
            servers: m.servers[i],
            throughput: s.station_throughput[i],
            service_rate: m.mu[i],
            utilisation: finite(s.utilisation[i]),
            mean_in_system: finite(Some(s.number[i])),
            mean_waiting: finite(Some(s.queue[i])),
            mean_sojourn: finite(Some(s.residence[i])),
            mean_wait: finite(Some(s.queue[i] / s.station_throughput[i])),
        })
        .collect();
    LiveResults {
        tier: "exact",
        per_station,
        network: Some(LiveNetwork { throughput: s.throughput, mean_number: m.population as f64, mean_delay: s.cycle_time(m.population) }),
        reason_if_partial: None,
        reason_detail: String::new(),
        utilisation_exact: true,
        bottlenecks: s.bottleneck().into_iter().map(|i| m.ids[i].clone()).collect(),
        closed: Some(LiveClosed { population: m.population as i64, reference_station: m.names[0].clone() }),
        formula: None,
    }
}

/// A finite number, or null: JSON has no NaN.
fn finite(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite())
}

pub fn results(net: &Network) -> LiveResults {
    // Drawn as a closed network (core's one rule, `closed::drawn_as`).
    if closed::drawn_as(net) != closed::Drawn::Open {
        return closed_results(net);
    }
    let r = jackson::live(net);
    // An exact answer for a network with priorities or batch arrivals is its single-station
    // formula's (core `extended::live`), not Jackson's: the interface says which.
    let formula = if r.tier != jackson::Tier::Exact {
        None
    } else if qnet_core::extended::uses(net, qnet_core::extended::Feature::Priorities) {
        Some("priority")
    } else if qnet_core::extended::uses(net, qnet_core::extended::Feature::BatchArrivals) {
        Some("batch")
    } else {
        None
    };
    LiveResults {
        tier: r.tier.raw(),
        per_station: r
            .stations
            .into_iter()
            .map(|s| LiveStation {
                station_id: s.id,
                station_name: s.name,
                servers: s.servers,
                throughput: if s.throughput.is_finite() { s.throughput } else { 0.0 },
                service_rate: if s.service_rate.is_finite() { s.service_rate } else { 0.0 },
                utilisation: finite(s.utilisation),
                mean_in_system: finite(s.mean_in_system),
                mean_waiting: finite(s.mean_waiting),
                mean_sojourn: finite(s.mean_sojourn),
                mean_wait: finite(s.mean_wait),
            })
            .collect(),
        network: r.network.map(|n| LiveNetwork { throughput: n.throughput, mean_number: n.mean_number, mean_delay: n.mean_delay }),
        reason_if_partial: r.reason.map(|x| x.raw()),
        reason_detail: r.detail,
        utilisation_exact: r.utilisation_exact,
        bottlenecks: r.bottlenecks,
        closed: None,
        formula,
    }
}

/// The live results of a tab's document (the `.bnet` JSON object the interface holds).
#[tauri::command(async)]
pub fn live_results(document: Value) -> Result<LiveResults, QnError> {
    let text = serde_json::to_string(&document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't compute live results: the network isn't complete.").with_detail(e.to_string()))?;
    Ok(results(&net))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn example(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(format!("{name}.bnet"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_jackson_example_answers_exactly_in_the_shape_the_interface_reads() {
        // golden/runs/OpenJackson.d2.feedback.p30.inf/product_form: L = 2.33333333 at both
        // stations, ρ = 0.7, throughputs 1.42857143 and 1.
        let r = live_results(example("OpenJackson.d2.feedback.p30.inf")).unwrap();
        assert_eq!((r.tier, r.reason_if_partial, r.utilisation_exact), ("exact", None, true));
        let json = serde_json::to_value(&r).unwrap();
        let s1 = &json["perStation"][0];
        assert_eq!(s1["stationName"], "S1");
        assert!((s1["meanInSystem"].as_f64().unwrap() - 7.0 / 3.0).abs() < 1e-9);
        assert!((s1["utilisation"].as_f64().unwrap() - 0.7).abs() < 1e-9);
        assert!((s1["throughput"].as_f64().unwrap() - 1.0 / 0.7).abs() < 1e-9);
        // Lq = L − ρ, W = L/α, Wq = Lq/α for one server.
        assert!((s1["meanWaiting"].as_f64().unwrap() - (7.0 / 3.0 - 0.7)).abs() < 1e-9);
        assert!((s1["meanSojourn"].as_f64().unwrap() - (7.0 / 3.0) * 0.7).abs() < 1e-9);
        assert!((json["network"]["meanNumber"].as_f64().unwrap() - 14.0 / 3.0).abs() < 1e-9);
        assert!((json["network"]["throughput"].as_f64().unwrap() - 1.0).abs() < 1e-12);
        assert!((json["network"]["meanDelay"].as_f64().unwrap() - 14.0 / 3.0).abs() < 1e-9);
        // ρ₁ = ρ₂ = 0.7: both stations, neither crowned.
        assert_eq!(json["bottlenecks"], serde_json::json!([s1["stationId"], json["perStation"][1]["stationId"]]));
    }

    #[test]
    fn a_finite_buffer_example_gives_utilisation_and_the_reason() {
        let r = live_results(example("MM1K.d1.c1.fin")).unwrap();
        assert_eq!((r.tier, r.reason_if_partial, r.utilisation_exact), ("utilisation", Some("finiteBuffers"), false));
        assert!(r.per_station[0].utilisation.is_some());
        assert_eq!(r.per_station[0].mean_in_system, None);
        assert_eq!(r.network, None);
    }

    #[test]
    fn an_empty_canvas_has_no_model_and_a_broken_document_is_refused() {
        let empty = serde_json::json!({ "nodes": [], "links": [], "infiniteBuffers": true, "canvasScale": 1.0, "canvasPanOffset": [0.0, 0.0] });
        let r = live_results(empty).unwrap();
        assert_eq!((r.tier, r.reason_if_partial), ("none", Some("noModel")));
        assert_eq!(r.reason_detail, "The network has no stations.");
        assert!(live_results(serde_json::json!({ "nodes": 3 })).is_err());
    }

    /// The interface's copy of the rule (src/closed/shape.ts) and core's (`closed::drawn_as`,
    /// `closed::open_only`) on the same cases: src/closed/shape.fixtures.json, which
    /// src/closed/shape.test.ts reads too.
    #[test]
    fn the_interface_and_core_agree_on_what_is_closed() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(root.join("src/closed/shape.fixtures.json")).unwrap()).unwrap();
        assert!(cases.len() >= 10);
        for c in &cases {
            let mut doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("examples").join(format!("{}.bnet", c["example"].as_str().unwrap()))).unwrap()).unwrap();
            let drop: Vec<&str> = c["dropKinds"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
            doc["nodes"].as_array_mut().unwrap().retain(|n| !drop.contains(&n["kind"].as_str().unwrap()));
            if c["dropLinks"] == true {
                doc["links"] = serde_json::json!([]);
            }
            if c["population"].is_null() {
                doc.as_object_mut().unwrap().remove("closedPopulation");
            } else if c["population"].is_number() {
                doc["closedPopulation"] = c["population"].clone();
            }
            let net = qnet_core::bnet::read(&doc.to_string()).unwrap();
            let name = c["name"].as_str().unwrap();
            assert_eq!(closed::drawn_as(&net).reason().unwrap_or("open"), c["drawn"].as_str().unwrap(), "{name}");
            assert_eq!(closed::open_only(&net, "Capacity planning").map(|(_, s)| s).as_deref(), c["sentence"].as_str(), "{name}");
        }
    }

    /// The interface's copy of the rule about the model features new in 2.1
    /// (src/extended/shape.ts) and core's (`extended::features`, `extended::classical_only`) on
    /// the same cases: src/extended/shape.fixtures.json, which src/extended/shape.test.ts reads too.
    #[test]
    fn the_interface_and_core_agree_on_the_new_features() {
        use qnet_core::extended;
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(root.join("src/extended/shape.fixtures.json")).unwrap()).unwrap();
        assert!(cases.len() >= 10);
        for c in &cases {
            let mut doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("examples").join(format!("{}.bnet", c["example"].as_str().unwrap()))).unwrap()).unwrap();
            for (name, keys) in c["set"].as_object().unwrap() {
                let node = doc["nodes"].as_array_mut().unwrap().iter_mut().find(|n| n["name"] == name.as_str()).unwrap_or_else(|| panic!("no node {name}"));
                for (k, v) in keys.as_object().unwrap() {
                    node[k] = v.clone();
                }
            }
            let net = qnet_core::bnet::read(&doc.to_string()).unwrap();
            let name = c["name"].as_str().unwrap();
            let features: Vec<&str> = extended::features(&net).into_iter().map(|(f, _)| f.raw()).collect();
            assert_eq!(serde_json::json!(features), c["features"], "{name}");
            let said = extended::classical_only(&net, "Capacity planning");
            assert_eq!(said.as_ref().map(|(r, _)| *r), c["reason"].as_str(), "{name}");
            assert_eq!(said.map(|(_, s)| s).as_deref(), c["sentence"].as_str(), "{name}");
        }
    }

    /// The bundled examples of the new features: live results are exact where a single-station
    /// formula covers the network, and utilisation with the reason where none does.
    #[test]
    fn the_new_feature_examples_answer_as_far_as_an_exact_formula_goes() {
        // Preemptive-resume, λ = (0.3, 0.2), exponential mean 1 and Erlang-2 mean 2: by hand
        // T₁ = 1/0.7 + 0.3/0.7 … = 10/7, T₂ = 2/0.7 + (0.3 + 0.6)/(0.7·0.3) = 50/7, L = 13/7.
        let r = live_results(example("extended/PriorityHelpDesk.mg1.2class")).unwrap();
        assert_eq!((r.tier, r.reason_if_partial), ("exact", None));
        assert!((r.per_station[0].mean_in_system.unwrap() - 13.0 / 7.0).abs() < 1e-12);
        assert!((r.per_station[0].utilisation.unwrap() - 0.7).abs() < 1e-12);
        // Geometric batches of mean 2.5 at rate 0.24, μ = 1: ρ = 0.6 (in customers), L = ρ/((1 − α)(1 − ρ)) = 3.75.
        let r = live_results(example("extended/BatchArrivals.mx-m-1.geometric")).unwrap();
        assert_eq!(r.tier, "exact");
        assert!((r.per_station[0].utilisation.unwrap() - 0.6).abs() < 1e-12 && (r.per_station[0].mean_in_system.unwrap() - 3.75).abs() < 1e-12);
        // A rate profile: the long-run average load (multiplier 0.8667 on ρ = 0.625), and no means.
        let r = live_results(example("extended/RushHour.mt-m-2.daily")).unwrap();
        assert_eq!((r.tier, r.reason_if_partial), ("utilisation", Some("extended")));
        assert!(r.reason_detail.starts_with("The arrival rate changes in time"));
        assert!((r.per_station[0].utilisation.unwrap() - 0.625 * 20.8 / 24.0).abs() < 1e-12);
        assert_eq!(r.per_station[0].mean_in_system, None);
    }

    /// The bundled closed example (ledger SCI-504): a central-server network, 8 customers.
    /// The live numbers are core's `closed::convolution`, held here to the identities any closed
    /// network obeys: Σ L_i = N, X_i = v_i X (v = 1, 0.6, 0.3), ρ_i = X_i/(c_i μ_i).
    #[test]
    fn a_closed_example_answers_exactly_and_says_it_is_closed() {
        let doc = example("closed/ClosedCentralServer.d3.N8");
        let r = live_results(doc.clone()).unwrap();
        assert_eq!((r.tier, r.reason_if_partial, r.utilisation_exact), ("exact", None, true));
        assert_eq!(r.closed, Some(LiveClosed { population: 8, reference_station: "S1".into() }));
        let net = r.network.clone().unwrap();
        let total: f64 = r.per_station.iter().map(|s| s.mean_in_system.unwrap()).sum();
        assert!((total - 8.0).abs() < 1e-9 && net.mean_number == 8.0);
        assert!((net.mean_delay - 8.0 / net.throughput).abs() < 1e-12);
        let x: Vec<f64> = r.per_station.iter().map(|s| s.throughput).collect();
        assert!((x[0] - net.throughput).abs() < 1e-12 && (x[1] - 0.6 * x[0]).abs() < 1e-12 && (x[2] - 0.3 * x[0]).abs() < 1e-12);
        for s in &r.per_station {
            let rho = s.utilisation.unwrap();
            assert!((rho - s.throughput / (s.servers as f64 * s.service_rate)).abs() < 1e-12 && rho < 1.0);
            assert!((s.mean_sojourn.unwrap() * s.throughput - s.mean_in_system.unwrap()).abs() < 1e-12, "Little's law");
        }
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["closed"]["referenceStation"], "S1");
        // An open network's answer has no `closed` key at all.
        assert!(serde_json::to_value(live_results(example("OpenJackson.d2.feedback.p30.inf")).unwrap()).unwrap().get("closed").is_none());

        // Without a population: nothing, and the reason the interface turns into an offer.
        let mut bare = doc.clone();
        bare.as_object_mut().unwrap().remove("closedPopulation");
        let r = live_results(bare).unwrap();
        assert_eq!((r.tier, r.reason_if_partial), ("none", Some("closedNoPopulation")));
        // Not a product form (an Erlang server): nothing, with core's sentence.
        let mut odd = doc;
        odd["nodes"].as_array_mut().unwrap().iter_mut().find(|n| n["name"] == "S2").unwrap()["distribution"] = "erlang".into();
        let r = live_results(odd).unwrap();
        assert_eq!((r.tier, r.reason_if_partial), ("none", Some("closed")));
        assert!(r.reason_detail.contains("exponential"), "{}", r.reason_detail);
    }
}
