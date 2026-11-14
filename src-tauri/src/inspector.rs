//! The station inspector's live load readout (0.90.34 `NetworkEditorModel.stabilityReadout`, which
//! ran `SRBMExporter.computeData` on a draft copy of the nodes; ledger INS-031…036, INV-022).
//!
//! The interface sends the network as the inspector's draft sees it: the stored nodes with the
//! station being edited replaced by whatever currently parses in its fields, the live links and the
//! draft buffer mode (src/panes/inspector/stability.ts). The traffic equations are core's
//! (`editor::stability_readout`); this only reads the JSON and shapes the answer.

use serde::Serialize;
use serde_json::{json, Value};

use qnet_core::{bnet, editor};

use crate::errors::QnError;

/// λ, c·μ and the per-class λ of one station (src/lib/types.ts `StabilityReadout`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Readout {
    pub arrival_rate: f64,
    pub capacity: f64,
    pub servers: i64,
    /// `[class index, λ]` for each class with a finite λ > 0 at the station.
    pub arrival_rate_per_class: Vec<(usize, f64)>,
}

/// The readout for `station_id`, or None (no source, the traffic equations fail, not a station).
pub fn readout(station_id: &str, nodes: &Value, links: &Value, infinite_buffers: bool) -> Result<Option<Readout>, QnError> {
    let doc = json!({ "nodes": nodes, "links": links, "infiniteBuffers": infinite_buffers, "canvasScale": 1.0, "canvasPanOffset": [0.0, 0.0] });
    let text = serde_json::to_string(&doc).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the inspector's draft network.").with_detail(e.to_string()))?;
    // New in 2.1: a source with batch arrivals or a rate profile counts at its long-run customer
    // rate (`extended::traffic_view`; the network itself when no source has either).
    let view = qnet_core::extended::traffic_view(&net);
    Ok(editor::stability_readout(station_id, &view.nodes, &view.links, infinite_buffers).map(|r| Readout {
        arrival_rate: r.arrival_rate,
        capacity: r.capacity,
        servers: r.servers,
        arrival_rate_per_class: r.arrival_rate_per_class,
    }))
}

/// `stabilityReadout(for:draftNodes:links:infiniteBuffers:)`.
/// Async, so Tauri runs it off the main thread: the traffic equations of a large network take a
/// while, and the pane asks again after every settled edit.
#[tauri::command]
pub async fn inspector_stability(station_id: String, nodes: Value, links: Value, infinite_buffers: bool) -> Result<Option<Readout>, QnError> {
    readout(&station_id, &nodes, &links, infinite_buffers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn example(name: &str) -> Value {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(format!("{name}.bnet"));
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    fn station_id(doc: &Value, name: &str) -> String {
        doc["nodes"].as_array().unwrap().iter().find(|n| n["name"] == name).unwrap()["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_tandem_station_reads_its_load_from_the_traffic_equations() {
        let doc = example("2dtandem");
        let id = station_id(&doc, "S1");
        let r = readout(&id, &doc["nodes"], &doc["links"], doc["infiniteBuffers"].as_bool().unwrap_or(false)).unwrap().unwrap();
        assert!(r.arrival_rate > 0.0 && r.capacity > 0.0, "{r:?}");
        assert_eq!(r.arrival_rate_per_class.len(), 1);
        assert_eq!(r.arrival_rate_per_class[0].0, 0);
    }

    #[test]
    fn the_draft_servers_change_the_capacity() {
        let mut doc = example("2dtandem");
        let id = station_id(&doc, "S1");
        let one = readout(&id, &doc["nodes"], &doc["links"], true).unwrap().unwrap();
        for n in doc["nodes"].as_array_mut().unwrap() {
            if n["id"] == id.as_str() {
                n["numberOfServers"] = json!(one.servers * 2);
            }
        }
        let two = readout(&id, &doc["nodes"], &doc["links"], true).unwrap().unwrap();
        assert!((two.capacity - 2.0 * one.capacity).abs() < 1e-9 * one.capacity, "{one:?} {two:?}");
        assert_eq!(two.arrival_rate, one.arrival_rate);
    }

    #[test]
    fn a_network_without_a_source_has_no_readout() {
        let mut doc = example("2dtandem");
        let id = station_id(&doc, "S1");
        let sources: Vec<Value> = doc["nodes"].as_array().unwrap().iter().filter(|n| n["kind"] == "source").map(|n| n["id"].clone()).collect();
        doc["nodes"].as_array_mut().unwrap().retain(|n| n["kind"] != "source");
        doc["links"].as_array_mut().unwrap().retain(|l| !sources.contains(&l["fromNodeID"]));
        assert_eq!(readout(&id, &doc["nodes"], &doc["links"], true).unwrap(), None);
    }
}
