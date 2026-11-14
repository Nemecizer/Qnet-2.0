//! The silent analysis behind the Status pane's flag bar and the canvas ρ badges (0.90.34
//! `QnetGUIApp.analyzeActiveTabIfNeeded`, `applyTractability`; `NetworkEditorModel
//! .refreshStationUtilisation`, `stationName(atExportIndex:)`, `classesServedAtStation`; ledger
//! ANA-015, ANA-024…027, LOG-031…039).
//!
//! The interface decides *when* it runs (150 ms after an edit that changes something the analysis
//! reads, on tab activation, at launch: src/panes/status/analysis.ts); everything it computes is
//! here, from core: the station model (`traffic::compute`), the warning list
//! (`report::network_warnings` then `report::validate_link_structure`), the flag-bar state
//! (`flags::assess`, which runs `tractability::assess`) and the Status lines a non-quiet run writes,
//! with their numbers through C's printf (`cfmt::f`).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Serialize, Serializer};
use serde_json::Value;

use qnet_core::cfmt::f;
use qnet_core::model::{Distribution, Network, NodeKind};
use qnet_core::{bnet, flags, naming, report};

use crate::errors::QnError;

/// A double that keeps NaN and the infinities in JSON (as "NaN", "Infinity", "-Infinity", which
/// JavaScript's `Number()` reads back), where serde_json would write null.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Num(pub f64);

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        if v.is_finite() {
            s.serialize_f64(v)
        } else if v.is_nan() {
            s.serialize_str("NaN")
        } else if v > 0.0 {
            s.serialize_str("Infinity")
        } else {
            s.serialize_str("-Infinity")
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

/// What one run of the silent analysis found (src/lib/types.ts `SilentAnalysis`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SilentAnalysis {
    /// "empty" (no nodes), "analysed", or "failed" (the station model can't be computed).
    pub outcome: &'static str,
    /// Why it failed: `SRBMExportError`'s sentence.
    pub error: Option<String>,
    /// Node id → ρ for the canvas badges: empty without a station and a source or when the model
    /// fails; stations with c ≤ 1e-12 or a non-finite ρ are left out (ANA-015).
    pub utilisation: BTreeMap<String, f64>,
    /// `networkWarnings` followed by `validateLinkStructure` (ANA-025).
    pub warnings: Vec<String>,
    pub is_analytically_tractable: bool,
    pub tractability_is_exact: bool,
    pub tractability_title: String,
    pub tractability_detail: String,
    pub tractability_means: Vec<Num>,
    pub tractability_means_label: String,
    pub tractability_explanation: String,
    pub has_feedback: bool,
    pub feedback_description: String,
    /// "notReentrant", "green", "yellow" or "red".
    pub feedback_quality: &'static str,
    pub feedback_criteria: Vec<Criterion>,
    /// The Analytical popover's row labels, one per mean: the station's name in export order, or
    /// "S<i>" when the names don't pin the order down (`stationName(atExportIndex:)`).
    pub station_names: Vec<String>,
    pub station_order_is_ambiguous: bool,
    /// Per-station throughput Γ (= α) beside the means, when the model has one value per mean and
    /// all are finite (`analyticalThroughputs`).
    pub throughputs: Option<Vec<f64>>,
    /// "S2  (Gamma)" for each station whose service law is not exponential (`nonExponentialStations`).
    pub non_exponential_stations: Vec<String>,
    /// What a non-quiet run writes to the Status log, in order (ANA-026, ANA-027): the asymptotic
    /// notes `applyTractability` writes, "Silent analysis ρ: …", then the warning summary. The
    /// interface infers each line's severity from its wording, as `addStatus(_:)` did.
    pub status: Vec<String>,
}

impl SilentAnalysis {
    fn blank(outcome: &'static str) -> SilentAnalysis {
        SilentAnalysis {
            outcome,
            error: None,
            utilisation: BTreeMap::new(),
            warnings: Vec::new(),
            is_analytically_tractable: false,
            tractability_is_exact: false,
            tractability_title: String::new(),
            tractability_detail: String::new(),
            tractability_means: Vec::new(),
            tractability_means_label: String::new(),
            tractability_explanation: String::new(),
            has_feedback: false,
            feedback_description: String::new(),
            feedback_quality: flags::FeedbackQuality::NotReentrant.case_name(),
            feedback_criteria: Vec::new(),
            station_names: Vec::new(),
            station_order_is_ambiguous: false,
            throughputs: None,
            non_exponential_stations: Vec::new(),
            status: Vec::new(),
        }
    }
}

/// The class indices whose links reach `station` or the buffer feeding it, sorted
/// (`classesServedAtStation`).
fn classes_served(net: &Network, station: &str) -> Vec<i64> {
    let upstream: BTreeSet<&str> = net
        .nodes
        .iter()
        .filter(|c| c.kind == NodeKind::Buffer && net.links.iter().any(|l| l.from == c.id && l.to == station))
        .map(|c| c.id.as_str())
        .collect();
    let classes: BTreeSet<i64> = net.links.iter().filter(|l| l.to == station || upstream.contains(l.to.as_str())).map(|l| l.class).collect();
    classes.into_iter().collect()
}

/// "S2  (Gamma, Lognormal)" lines for the stations whose service law is not exponential, in
/// document order (FlagBarView.swift `nonExponentialStations`).
fn non_exponential_stations(net: &Network) -> Vec<String> {
    net.nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Station)
        .filter_map(|node| {
            let classes = classes_served(net, &node.id);
            let mut families = BTreeSet::new();
            if classes.is_empty() {
                if node.distribution != Distribution::Exponential {
                    families.insert(node.distribution.display_name());
                }
            } else {
                for c in classes {
                    let d = node.service_by_class.get(&c).map(|s| s.distribution).unwrap_or(node.distribution);
                    if d != Distribution::Exponential {
                        families.insert(d.display_name());
                    }
                }
            }
            if families.is_empty() {
                return None;
            }
            Some(format!("{}  ({})", node.name, families.into_iter().collect::<Vec<_>>().join(", ")))
        })
        .collect()
}

/// The silent analysis of `net` (`analyzeActiveTabIfNeeded` without its side effects).
pub fn analyse(net: &Network) -> SilentAnalysis {
    if net.nodes.is_empty() {
        return SilentAnalysis::blank("empty");
    }
    let infinite = net.infinite_buffers;
    // A closed network (new in 2.1) has no arrivals for the traffic equations to start from: say
    // so, rather than "no source node". Its exact solution is core's `closed.rs` (live results, Solve).
    // A network drawn closed but with no population yet is told that, as the live results tell it.
    if let Some((_, sentence)) = qnet_core::closed::open_only(net, "The open-network analysis (arrival rates from the traffic equations)") {
        let mut a = SilentAnalysis::blank("failed");
        let message = if qnet_core::closed::is_closed(net) { "This is a closed network, so the open-network analysis (arrival rates from the traffic equations) does not apply. Live results and Solve give its exact closed product form.".to_string() } else { sentence };
        let message = message.as_str();
        a.error = Some(message.into());
        a.non_exponential_stations = non_exponential_stations(net);
        a.status = vec![format!("Silent analysis skipped: {message}")];
        return a;
    }
    // New in 2.1: with batch arrivals or a rate profile the load is at the sources' long-run
    // customer rates (`extended::traffic`, which is `traffic::compute` for any other network).
    let data = match qnet_core::extended::traffic(net, infinite, false, false) {
        Ok(d) => d,
        Err(e) => {
            let mut a = SilentAnalysis::blank("failed");
            a.error = Some(e.message());
            a.non_exponential_stations = non_exponential_stations(net);
            a.status = vec![format!("Silent analysis failed: {}", e.message())];
            return a;
        }
    };

    let mut warnings = report::network_warnings(&data, infinite);
    warnings.extend(report::validate_link_structure(&net.nodes, &net.links, infinite));
    let mut fl = flags::assess(&data, &net.nodes, infinite);
    // The closed forms the flag bar announces are for first-come-first-served stations and plain
    // sources: with priorities, batch arrivals or a rate profile none of them is this network's
    // (core's one rule, `extended::refusal`), so none is announced.
    if let Some(sentence) = qnet_core::extended::refusal(net, "The closed-form check") {
        fl.is_analytically_tractable = false;
        fl.tractability_is_exact = false;
        fl.tractability_title = String::new();
        fl.tractability_detail = String::new();
        fl.tractability_means = Vec::new();
        fl.tractability_means_label = String::new();
        fl.tractability_explanation = String::new();
        fl.status = vec![format!("Closed-form check skipped: {sentence}")];
    }

    // Utilisation badges (refreshStationUtilisation): stations in the exporters' order.
    let mut utilisation = BTreeMap::new();
    let has_station = net.nodes.iter().any(|n| n.kind == NodeKind::Station);
    let has_source = net.nodes.iter().any(|n| n.kind == NodeKind::Source);
    let stations = naming::in_export_order(net.nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| n.name.as_str());
    if has_station && has_source {
        for (k, station) in stations.iter().enumerate().take(data.d) {
            if data.capacity[k] <= 1e-12 {
                continue;
            }
            let rho = data.alpha[k] / data.capacity[k];
            if rho.is_finite() {
                utilisation.insert(station.id.clone(), rho);
            }
        }
    }

    let ambiguous = naming::order_is_ambiguous(net.nodes.iter().filter(|n| n.kind == NodeKind::Station).map(|n| n.name.as_str()));
    let station_names = (0..fl.tractability_means.len())
        .map(|i| if i < stations.len() && !ambiguous { stations[i].name.clone() } else { format!("S{}", i + 1) })
        .collect();
    let throughputs = (data.d == fl.tractability_means.len() && data.alpha.iter().all(|a| a.is_finite())).then(|| data.alpha.clone());

    // The Status lines, in 0.90.34's order: applyTractability's notes, then ρ, then the warnings.
    let mut status = fl.status.clone();
    let mut rho_line = String::from("Silent analysis ρ:");
    for i in 0..data.d {
        rho_line += &format!("  S{}={}", i + 1, f("%.4f", data.rho(i)));
    }
    status.push(rho_line);
    if warnings.is_empty() {
        status.push("No warnings — banner hidden.".into());
    } else {
        status.push(format!("Banner triggered by {} warning(s):", warnings.len()));
        status.extend(warnings.iter().map(|w| format!("  • {w}")));
    }

    SilentAnalysis {
        outcome: "analysed",
        error: None,
        utilisation,
        warnings,
        is_analytically_tractable: fl.is_analytically_tractable,
        tractability_is_exact: fl.tractability_is_exact,
        tractability_title: fl.tractability_title,
        tractability_detail: fl.tractability_detail,
        tractability_means: fl.tractability_means.iter().map(|m| Num(*m)).collect(),
        tractability_means_label: fl.tractability_means_label,
        tractability_explanation: fl.tractability_explanation,
        has_feedback: fl.has_feedback,
        feedback_description: fl.feedback_description,
        feedback_quality: fl.feedback_quality.case_name(),
        feedback_criteria: fl.feedback_criteria.into_iter().map(|c| Criterion { label: c.label, ok: c.ok, detail: c.detail }).collect(),
        station_names,
        station_order_is_ambiguous: ambiguous,
        throughputs,
        non_exponential_stations: non_exponential_stations(net),
        status,
    }
}

/// Runs the silent analysis on a tab's document (the `.bnet` JSON object the interface holds).
#[tauri::command]
pub fn analysis_run(document: Value) -> Result<SilentAnalysis, QnError> {
    let text = serde_json::to_string(&document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't analyse this network: it isn't complete.").with_detail(e.to_string()))?;
    Ok(analyse(&net))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn example(name: &str) -> Network {
        bnet::read(&std::fs::read_to_string(root().join("examples").join(format!("{name}.bnet"))).unwrap()).unwrap()
    }

    fn golden(name: &str, file: &str) -> String {
        std::fs::read_to_string(root().join("golden").join(name).join(file)).unwrap()
    }

    /// ρ per station from golden/<example>/dump-rho.txt ("S1: α=… ρ=0.700000").
    fn golden_rho(name: &str) -> Vec<f64> {
        golden(name, "dump-rho.txt")
            .lines()
            .filter(|l| l.starts_with('S') && l.contains("ρ="))
            .map(|l| l.rsplit("ρ=").next().unwrap().trim().parse::<f64>().unwrap_or(f64::NAN))
            .collect()
    }

    /// The "!! Warning:" lines that end golden/<example>/primitives.txt, without the escape codes.
    fn golden_warnings(name: &str) -> Vec<String> {
        golden(name, "primitives.txt").lines().filter_map(|l| l.split_once("!! Warning:\u{1b}[0m ").map(|(_, w)| w.to_string())).collect()
    }

    fn flag(name: &str, key: &str) -> String {
        golden(name, "flags.txt").lines().find_map(|l| l.strip_prefix(&format!("{key}=")).map(str::to_string)).unwrap()
    }

    const EXAMPLES: [&str; 6] = [
        "OpenJackson.d2.feedback.p50.inf",
        "KumarSeidman90.d2.c4.reentrant.inf",
        "ShenChenDaiDai02.d2.c1.1.fin",
        "2dtandem",
        "GuangChenDaiGlynn25.sec3.1.2d.inf",
        "DaiHarrison91.d2.c1.fin",
    ];

    #[test]
    fn the_silent_analysis_matches_0_90_34_for_several_examples() {
        for name in EXAMPLES {
            let net = example(name);
            let a = analyse(&net);
            assert_eq!(a.outcome, "analysed", "{name}");
            // The ρ line, %.4f of what --dump-rho printed to six places.
            let rho = golden_rho(name);
            let line = a.status.iter().find(|l| l.starts_with("Silent analysis ρ:")).unwrap();
            let ours: Vec<f64> = line.split("  S").skip(1).map(|p| p.split_once('=').unwrap().1.parse().unwrap()).collect();
            assert_eq!(ours.len(), rho.len(), "{name}: {line}");
            for (o, g) in ours.iter().zip(&rho) {
                assert!((o - g).abs() <= 5.1e-5, "{name}: {line} against {rho:?}");
            }
            // The warnings: Primitives' list, as the canvas banner had it.
            assert_eq!(a.warnings, golden_warnings(name), "{name}");
            // The flags.
            assert_eq!(a.is_analytically_tractable.to_string(), flag(name, "isAnalyticallyTractable"), "{name}");
            assert_eq!(a.tractability_is_exact.to_string(), flag(name, "tractabilityIsExact"), "{name}");
            assert_eq!(a.tractability_detail, flag(name, "tractabilityDetail"), "{name}");
            assert_eq!(a.has_feedback.to_string(), flag(name, "hasFeedback"), "{name}");
            assert_eq!(a.feedback_quality, flag(name, "feedbackQuality"), "{name}");
            assert_eq!(a.station_names.len(), a.tractability_means.len(), "{name}");
            // The badges: one ρ per station of finite load, keyed by node id in export order.
            let stations = naming::in_export_order(net.nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| n.name.as_str());
            for (k, s) in stations.iter().enumerate() {
                match a.utilisation.get(&s.id) {
                    Some(r) => assert!((r - rho[k]).abs() < 1e-6, "{name}: {} ρ {r} against {}", s.name, rho[k]),
                    None => assert!(!rho[k].is_finite(), "{name}: {} has no badge", s.name),
                }
            }
        }
    }

    /// Every shipped example: the warnings and ρ line against Primitives and --dump-rho, or a
    /// failure where 0.90.34 had no station model (no flags.txt).
    #[test]
    fn every_example_analyses_as_0_90_34_did() {
        let mut names: Vec<String> = std::fs::read_dir(root().join("examples"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter_map(|f| f.strip_suffix(".bnet").map(str::to_string))
            .collect();
        names.sort();
        assert_eq!(names.len(), 50);
        for name in names {
            let a = analyse(&example(&name));
            if !root().join("golden").join(&name).join("flags.txt").exists() {
                assert_eq!(a.outcome, "failed", "{name}");
                continue;
            }
            assert_eq!(a.outcome, "analysed", "{name}");
            assert_eq!(a.warnings, golden_warnings(&name), "{name}");
            assert_eq!(a.feedback_quality, flag(&name, "feedbackQuality"), "{name}");
            let line = a.status.iter().find(|l| l.starts_with("Silent analysis ρ:")).unwrap();
            assert_eq!(line.matches("  S").count(), golden_rho(&name).len(), "{name}");
        }
    }

    #[test]
    fn the_status_lines_follow_0_90_34s_wording_and_order() {
        let a = analyse(&example("OpenJackson.d2.feedback.p50.inf"));
        assert_eq!(a.status, vec!["Silent analysis ρ:  S1=0.7000  S2=0.7000".to_string(), "No warnings — banner hidden.".into()]);
        assert_eq!(a.tractability_means, vec![Num(2.333333333333333), Num(2.333333333333333)]);
        assert_eq!(a.throughputs, Some(vec![2.0, 1.0]));
        assert_eq!(a.station_names, vec!["S1", "S2"]);

        let b = analyse(&example("2dtandem"));
        assert_eq!(b.status[0], "Silent analysis ρ:  S1=1.0000  S2=1.0000");
        assert_eq!(b.status[1], "Banner triggered by 2 warning(s):");
        assert!(b.status[2].starts_with("  • station 1 is overloaded (ρ = 1.0000 ≥ 1)."), "{:?}", b.status);
        assert_eq!(b.status.len(), 4);

        // An asymptotic match on a finite-buffer network is withheld, and says so first.
        let g = analyse(&example("ShenChenDaiDai02.d2.c1.1.fin"));
        assert!(!g.is_analytically_tractable);
        let flags_status = golden("ShenChenDaiDai02.d2.c1.1.fin", "flags.txt");
        let want: Vec<&str> = flags_status.split("status:\n").nth(1).unwrap().lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(g.status[..want.len()].iter().map(String::as_str).collect::<Vec<_>>(), want);
        assert!(g.status[want.len()].starts_with("Silent analysis ρ:"));
    }

    /// New in 2.1 (ledger SCI-1041): with batch arrivals the badge's ρ counts customers, and no
    /// closed form of first-come-first-served networks is announced for a network with a new feature.
    #[test]
    fn a_network_with_a_new_feature_shows_its_load_and_announces_no_closed_form() {
        let a = analyse(&example("extended/BatchArrivals.mx-m-1.geometric"));
        assert_eq!(a.outcome, "analysed");
        assert!((a.utilisation.values().next().copied().unwrap() - 0.6).abs() < 1e-12, "{:?}", a.utilisation);
        assert!(!a.is_analytically_tractable && a.tractability_title.is_empty() && a.tractability_means.is_empty());
        assert!(a.status[0].starts_with("Closed-form check skipped: This network uses batch arrivals at Src1."), "{:?}", a.status);
        // The same source without its batches is the M/M/1 queue the flag bar knows.
        let mut plain = example("extended/BatchArrivals.mx-m-1.geometric");
        plain.nodes.iter_mut().for_each(|n| n.batch = None);
        let p = analyse(&plain);
        assert!(p.is_analytically_tractable && (p.utilisation.values().next().copied().unwrap() - 0.24).abs() < 1e-12);
    }

    #[test]
    fn an_empty_canvas_and_a_network_without_a_model_say_so() {
        let mut net = example("2dtandem");
        net.nodes.clear();
        net.links.clear();
        assert_eq!(analyse(&net).outcome, "empty");
        assert!(analyse(&net).status.is_empty());

        let mut no_sink = example("2dtandem");
        no_sink.nodes.retain(|n| n.kind != NodeKind::Sink);
        let a = analyse(&no_sink);
        assert_eq!(a.outcome, "failed");
        assert_eq!(a.error.as_deref(), Some("The network has no sink node."));
        assert_eq!(a.status, vec!["Silent analysis failed: The network has no sink node."]);
        assert!(a.utilisation.is_empty() && a.warnings.is_empty() && !a.has_feedback);
    }

    #[test]
    fn non_exponential_stations_name_their_families() {
        let mut net = example("2dtandem");
        let s = net.nodes.iter_mut().find(|n| n.kind == NodeKind::Station).unwrap();
        s.distribution = Distribution::Gamma;
        let name = s.name.clone();
        let lines = non_exponential_stations(&net);
        assert!(lines.contains(&format!("{name}  (Gamma)")), "{lines:?}");
    }

    #[test]
    fn the_command_reads_the_interfaces_json_and_keeps_nan_in_json() {
        let text = std::fs::read_to_string(root().join("examples/OpenJackson.d2.feedback.p50.inf.bnet")).unwrap();
        let doc: Value = serde_json::from_str(&text).unwrap();
        let a = analysis_run(doc).unwrap();
        assert_eq!(a.outcome, "analysed");
        let json = serde_json::to_value(&a).unwrap();
        assert_eq!(json["feedbackQuality"], "green");
        assert!(json["tractabilityMeans"][0].is_f64());
        assert_eq!(serde_json::to_value(Num(f64::NAN)).unwrap(), "NaN");
        assert_eq!(serde_json::to_value(Num(f64::NEG_INFINITY)).unwrap(), "-Infinity");
        assert!(analysis_run(serde_json::json!({"nodes": 3})).is_err());
    }
}
