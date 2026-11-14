//! The Results workspace's exports and its one network read (PLAN.md §7 P6, ledger §8.9, §11.6):
//! 0.90.34's `ResultsExport` (`ResultsWorkspace.swift`) — the 31-column CSV, the pretty JSON array
//! and their atomic writes — and the current network's fingerprint, against which the workspace
//! marks a record stale (`ResultNetworkSnapshot.fingerprint`, `isStale`).
//!
//! The records come from the results store by id (`runs::Runs`), so every number is the Double the
//! record holds and is spelled as Swift's `String(Double)` spells it (`cfmt::swift_description`),
//! dates as `ISO8601DateFormatter` writes them; the page only says which records, in which order.

use qnet_core::cfmt::swift_description;
use qnet_core::json::{self, Json};
use qnet_core::results::{Measurement, NetworkSnapshot, RunRecord};
use serde_json::Value;
use tauri::State;

use crate::errors::QnError;
use crate::runs::Runs;
use crate::util;

/// `ResultsExport.csv`'s header: 31 columns, in 0.90.34's order (ledger RES-083, INV-081).
pub const CSV_HEADER: [&str; 31] = [
    "run_id",
    "network",
    "network_fingerprint",
    "stale",
    "status",
    "method_id",
    "method",
    "model_layer",
    "fidelity",
    "started_at",
    "completed_at",
    "elapsed_seconds",
    "station_id",
    "station",
    "class",
    "metric",
    "estimate",
    "unit",
    "standard_error",
    "half_width",
    "ci_lower",
    "ci_upper",
    "confidence_level",
    "sample_size",
    "residual",
    "discretization",
    "refinement_delta",
    "note",
    "seed",
    "parameters",
    "warnings",
];

/// `ResultsExport.number`: Swift's `String(Double)`, or empty.
fn number(v: Option<f64>) -> String {
    v.map(swift_description).unwrap_or_default()
}

/// `ResultsExport.escape`: a field with a comma, a quote, LF or CR is quoted, quotes doubled.
pub fn escape(field: &str) -> String {
    if field.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// `ResultsExport.csv(records:currentFingerprint:)`: the header, then one row per measurement (one
/// blank-measurement row for a run with none), LF line ends and a final LF. `stale` is empty when
/// there is no current fingerprint.
pub fn csv(records: &[&RunRecord], current_fingerprint: Option<&str>) -> String {
    let mut rows = vec![CSV_HEADER.iter().map(|h| escape(h)).collect::<Vec<_>>().join(",")];
    // `ResultMeasurement(stationName: "", metric: "", estimate: .nan)`.
    let placeholder = Measurement::new(String::new(), None, String::new(), None, String::new(), f64::NAN, String::new(), None, None, None);
    for run in records {
        let stale = match current_fingerprint {
            Some(f) => if run.is_stale(f) { "true" } else { "false" },
            None => "",
        };
        // `parameters.keys.sorted()`: the map is already in key order.
        let parameters = run.provenance.parameters.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
        let measurements: Vec<&Measurement> = if run.measurements.is_empty() { vec![&placeholder] } else { run.measurements.iter().collect() };
        let run_evidence = run.run_evidence.as_ref();
        for m in measurements {
            let u = m.uncertainty.as_ref();
            let e = m.numerical_evidence.as_ref();
            let fields: [String; 31] = [
                run.id.clone(),
                run.provenance.network_title.clone(),
                run.provenance.network_fingerprint.clone(),
                stale.to_string(),
                run.status.raw().to_string(),
                run.method.identifier.clone(),
                run.method.display_name.clone(),
                run.method.layer.raw().to_string(),
                run.method.fidelity.raw().to_string(),
                run.started_at.iso8601(),
                run.completed_at.map(|d| d.iso8601()).unwrap_or_default(),
                number(run.elapsed_seconds),
                m.station_id.clone().unwrap_or_default(),
                m.station_name.clone(),
                m.customer_class.map(|c| (c + 1).to_string()).unwrap_or_default(),
                m.metric.clone(),
                if m.estimate.is_nan() { String::new() } else { swift_description(m.estimate) },
                m.unit.clone(),
                number(u.and_then(|u| u.standard_error)),
                // A simulator reports a half-width, not a standard error; this column carries it.
                number(u.and_then(|u| u.half_width())),
                number(u.and_then(|u| u.lower_bound)),
                number(u.and_then(|u| u.upper_bound)),
                number(u.and_then(|u| u.confidence_level)),
                u.and_then(|u| u.sample_size).map(|n| n.to_string()).unwrap_or_default(),
                number(e.and_then(|e| e.residual).or(run_evidence.and_then(|r| r.residual))),
                e.and_then(|e| e.discretization.clone()).or(run_evidence.and_then(|r| r.discretization.clone())).unwrap_or_default(),
                number(e.and_then(|e| e.refinement_delta).or(run_evidence.and_then(|r| r.refinement_delta))),
                m.note
                    .clone()
                    .or(e.and_then(|e| e.convergence_note.clone()))
                    .or(run_evidence.and_then(|r| r.convergence_note.clone()))
                    .unwrap_or_default(),
                run.provenance.seed.map(|s| s.to_string()).unwrap_or_default(),
                parameters.clone(),
                run.warnings.join("; "),
            ];
            rows.push(fields.iter().map(|f| escape(f)).collect::<Vec<_>>().join(","));
        }
    }
    rows.join("\n") + "\n"
}

/// The JSON export: a bare array of the records (not the archive wrapper), as `JSONEncoder` with
/// `[.prettyPrinted, .sortedKeys]` and `.iso8601` dates writes it. Fails on a non-finite number,
/// as the encoder threw.
pub fn json_array(records: &[&RunRecord]) -> Result<String, QnError> {
    let items = records
        .iter()
        .map(|r| r.to_json().map_err(|e| QnError::failed(e.to_string())))
        .collect::<Result<Vec<Json>, QnError>>()?;
    Ok(json::to_pretty(&Json::Array(items)))
}

/// The export text for `format` ("csv" or "json").
pub fn export_text(records: &[&RunRecord], format: &str, current_fingerprint: Option<&str>) -> Result<String, QnError> {
    match format {
        "csv" => Ok(csv(records, current_fingerprint)),
        "json" => json_array(records),
        other => Err(QnError::invalid(format!("There's no results export called “{other}”."))),
    }
}

/// The network's fingerprint as a run of it would record it: the tab's document read as a run
/// reads it (`runs::start`), then `NetworkSnapshot::fingerprint`.
pub fn fingerprint_of(document: &Value) -> Result<String, QnError> {
    let text = serde_json::to_string(document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = qnet_core::bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the tab's network.").with_detail(e.to_string()))?;
    Ok(NetworkSnapshot::of(&net).fingerprint())
}

/// The store's records with these ids, in this order; an id it doesn't hold is skipped.
fn picked(runs: &Runs, ids: &[String]) -> Vec<RunRecord> {
    let store = runs.store.lock().unwrap_or_else(|p| p.into_inner());
    ids.iter().filter_map(|id| store.record(&id.to_ascii_uppercase()).cloned()).collect()
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────

/// The current network's fingerprint (the Results workspace's staleness test).
#[tauri::command]
pub fn results_fingerprint(document: Value) -> Result<String, QnError> {
    fingerprint_of(&document)
}

/// The CSV or JSON text of these records (Copy Selected Run as CSV).
#[tauri::command]
pub fn results_export_text(runs: State<'_, Runs>, ids: Vec<String>, format: String, current_fingerprint: Option<String>) -> Result<String, QnError> {
    let records = picked(&runs, &ids);
    let refs: Vec<&RunRecord> = records.iter().collect();
    export_text(&refs, &format, current_fingerprint.as_deref())
}

/// Save … as CSV/JSON…: writes the export atomically at `path`; resolves to the file's name.
#[tauri::command]
pub fn results_export_save(runs: State<'_, Runs>, path: String, ids: Vec<String>, format: String, current_fingerprint: Option<String>) -> Result<String, QnError> {
    let records = picked(&runs, &ids);
    if records.is_empty() {
        return Err(QnError::invalid("There are no results to save."));
    }
    let refs: Vec<&RunRecord> = records.iter().collect();
    let text = export_text(&refs, &format, current_fingerprint.as_deref())?;
    let p = std::path::Path::new(&path);
    util::write_atomic(p, text.as_bytes()).map_err(QnError::failed)?;
    Ok(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn golden(example: &str, method: &str) -> RunRecord {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../golden/runs/{example}/{method}/record.json"));
        RunRecord::parse(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).expect("a golden record")
    }

    fn golden_text(example: &str, method: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../golden/runs/{example}/{method}/record.json"))).unwrap()
    }

    /// ResultsWorkspace.swift `ResultsExport.csv`, lines 722–730 (dc066f0): the header, column for column.
    #[test]
    fn the_header_is_0_90_34s_31_columns() {
        let text = csv(&[], None);
        assert_eq!(
            text,
            "run_id,network,network_fingerprint,stale,status,method_id,method,model_layer,fidelity,started_at,completed_at,elapsed_seconds,station_id,station,class,metric,estimate,unit,standard_error,half_width,ci_lower,ci_upper,confidence_level,sample_size,residual,discretization,refinement_delta,note,seed,parameters,warnings\n"
        );
        assert_eq!(CSV_HEADER.len(), 31);
    }

    /// A Monte Carlo run 0.90.34 filed for 2dtandem: one row per measurement, the interval's
    /// half-width computed as Swift does, Swift's number spelling, the parameters sorted.
    #[test]
    fn a_simulation_rows_read_as_0_90_34_wrote_them() {
        let r = golden("2dtandem", "sim");
        let text = csv(&[&r], Some(&r.provenance.network_fingerprint));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1 + r.measurements.len());
        assert!(text.ends_with('\n') && !text.ends_with("\n\n"));
        let fp = &r.provenance.network_fingerprint;
        assert_eq!(
            lines[1],
            format!(
                "814BC936-2FD7-493E-8DD2-621EC38287C4,2dtandem.bnet,{fp},false,completed,queue.des,Monte Carlo,Queueing process,Queue simulation,{},2026-11-11T04:39:52Z,0.34351396560668945,D10598BD-AAD6-464A-98D5-57ABE91D94ED,S1,,Utilization,0.984,ratio,,{},0.983,0.985,0.95,,,,,,12345,blocking=BAS+ext-loss; fixed seed=true; parallelism=2; replications=8; simulation time=200000; warm-up=10000,",
                r.started_at.iso8601(),
                swift_description((0.985 - 0.983) / 2.0),
            )
        );
        // The sojourn row: an upper bound Swift wrote as 14.591999999999999.
        assert!(lines[5].contains(",Mean sojourn time,14.415,time,,"), "{}", lines[5]);
        assert!(lines[5].contains(",14.238,14.591999999999999,0.95,"), "{}", lines[5]);
        // Every row has 31 fields (none of these needs quoting).
        for l in &lines {
            assert_eq!(l.split(',').count(), 31, "{l}");
        }
        // Against another network, stale is true.
        assert!(csv(&[&r], Some("0")).lines().nth(1).unwrap().contains(&format!(",{fp},true,completed,")));
        // With no current network, empty.
        assert!(csv(&[&r], None).lines().nth(1).unwrap().contains(&format!(",{fp},,completed,")));
    }

    #[test]
    fn a_failed_run_with_no_measurements_has_one_blank_measurement_row() {
        let r = golden("10stationtandem.inf", "bar_bounds");
        assert_eq!(r.status.raw(), "failed");
        assert!(r.measurements.is_empty());
        let text = csv(&[&r], Some(&r.provenance.network_fingerprint));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let row = lines[1];
        assert!(row.starts_with(&format!("{},10stationtandem.inf.bnet,", r.id)), "{row}");
        assert!(row.contains(",failed,srbm.bar-moment-bounds,BAR Moment Bounds,SRBM diffusion,SRBM bound relaxation,"), "{row}");
        // station_id … sample_size are empty: the placeholder measurement.
        assert!(row.contains(&format!(",{},,,,,,,,,,,,,", number(r.elapsed_seconds))), "{row}");
    }

    #[test]
    fn evidence_falls_back_to_the_runs_and_classes_are_one_based() {
        let mut r = golden("2dtandem", "sim");
        r.measurements.truncate(1);
        r.measurements[0].customer_class = Some(0);
        r.measurements[0].uncertainty = None;
        r.measurements[0].note = None;
        r.run_evidence = Some(qnet_core::results::NumericalEvidence { residual: Some(1e-7), discretization: Some("degree 6".into()), refinement_delta: Some(0.5), convergence_note: Some("converged, \"tight\"".into()) });
        r.warnings = vec!["one".into(), "two, three".into()];
        r.provenance.seed = None;
        let text = csv(&[&r], Some(&r.provenance.network_fingerprint));
        let row = text.lines().nth(1).unwrap();
        assert!(row.contains(",S1,1,Utilization,0.984,ratio,,,,,,,1e-07,degree 6,0.5,\"converged, \"\"tight\"\"\",,"), "{row}");
        assert!(row.ends_with(",\"one; two, three\""), "{row}");
        // The measurement's own evidence wins.
        r.measurements[0].numerical_evidence = Some(qnet_core::results::NumericalEvidence { residual: Some(2.0), discretization: None, refinement_delta: None, convergence_note: Some("own".into()) });
        let row = csv(&[&r], None).lines().nth(1).unwrap().to_string();
        assert!(row.contains(",2.0,degree 6,0.5,own,"), "{row}");
        r.measurements[0].note = Some("note".into());
        let row = csv(&[&r], None).lines().nth(1).unwrap().to_string();
        assert!(row.contains(",0.5,note,"), "{row}");
    }

    #[test]
    fn fields_with_commas_quotes_or_line_breaks_are_quoted() {
        assert_eq!(escape("plain"), "plain");
        assert_eq!(escape("a,b"), "\"a,b\"");
        assert_eq!(escape("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(escape("a\nb"), "\"a\nb\"");
        assert_eq!(escape("a\rb"), "\"a\rb\"");
    }

    #[test]
    fn records_go_out_in_the_order_given() {
        let a = golden("2dtandem", "sim");
        let b = golden("2dtandem", "cmp");
        let text = csv(&[&b, &a], None);
        let ids: Vec<&str> = text.lines().skip(1).map(|l| l.split(',').next().unwrap()).collect();
        assert_eq!(ids.first(), Some(&b.id.as_str()));
        assert_eq!(ids.last(), Some(&a.id.as_str()));
    }

    /// The JSON export is the records as 0.90.34's pretty encoder wrote each one, in an array.
    #[test]
    fn the_json_export_is_a_pretty_array_of_0_90_34s_records() {
        let r = golden("2dtandem", "sim");
        let text = json_array(&[&r]).unwrap();
        let one = golden_text("2dtandem", "sim");
        // Nested one level deeper; the blank line of an empty container stays blank, as Swift writes it.
        let indented: Vec<String> = one.trim_end().lines().map(|l| if l.is_empty() { String::new() } else { format!("  {l}") }).collect();
        assert_eq!(text, format!("[\n{}\n]", indented.join("\n")));
        let failed = golden("10stationtandem.inf", "bar_bounds");
        let two = json_array(&[&r, &failed]).unwrap();
        assert!(two.starts_with("[\n  {\n    \"completedAt\" : "));
        assert!(two.contains("\n  },\n  {\n"));
        assert!(export_text(&[&r], "xml", None).is_err());
    }

    /// The fingerprint of the example a golden run used is the one 0.90.34 recorded: the
    /// workspace sees that run as current until the network changes.
    #[test]
    fn the_current_networks_fingerprint_matches_the_records_until_it_changes() {
        let r = golden("2dtandem", "sim");
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/2dtandem.bnet")).unwrap()).unwrap();
        assert_eq!(fingerprint_of(&doc).unwrap(), r.provenance.network_fingerprint);
        let mut moved = doc.clone();
        moved["nodes"][0]["position"][0] = Value::from(10.0);
        assert_ne!(fingerprint_of(&moved).unwrap(), r.provenance.network_fingerprint);
        assert!(fingerprint_of(&Value::from(3)).is_err());
    }

    /// SET-210: the results file is results-v1.json in the app's data folder.
    #[test]
    fn the_store_lives_in_the_data_folder() {
        assert_eq!(crate::runs::store_path(Path::new("/data")), PathBuf::from("/data/results-v1.json"));
    }

    #[test]
    fn saving_writes_the_file_and_names_it() {
        let dir = std::env::temp_dir().join(format!("qnet-results-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("results-v1.json");
        let runs = Runs::new(&store);
        let r = golden("2dtandem", "sim");
        runs.store.lock().unwrap().begin_run(r.clone());
        let records = picked(&runs, &[r.id.to_lowercase(), "00000000-0000-0000-0000-000000000000".into()]);
        assert_eq!(records.len(), 1);
        let path = dir.join("qnet-result.csv");
        let refs: Vec<&RunRecord> = records.iter().collect();
        util::write_atomic(&path, export_text(&refs, "csv", None).unwrap().as_bytes()).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().starts_with("run_id,network,"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
