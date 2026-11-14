//! The results store (`qnet_runner::store`, 0.90.34 `ResultsStore`): the file it writes, the order
//! it keeps, how runs are begun and finished, and what happens to a file it can't read.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use qnet_core::model::{Link, Network, Node, NodeKind};
use qnet_core::results::{archive, parse, Date, Disposition, Measurement, MethodMetadata, NumericalEvidence, Provenance, RunRecord, RunStatus};
use qnet_runner::store::{Finished, ResultsStore, RunOutcome};

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("qnet-store-tests-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn network() -> Network {
    let mut src = Node::new("A0000000-0000-4000-8000-000000000001", NodeKind::Source, "Src1", (100.0, 200.0));
    src.distribution = qnet_core::model::Distribution::Poisson;
    src.parameters = "lambda=1.0".into();
    let s2 = Node::new("A0000000-0000-4000-8000-000000000002", NodeKind::Station, "S2", (300.0, 200.0));
    let s1 = Node::new("A0000000-0000-4000-8000-000000000003", NodeKind::Station, "S1", (200.0, 200.0));
    let sink = Node::new("A0000000-0000-4000-8000-000000000004", NodeKind::Sink, "Sink", (400.0, 200.0));
    let link = |id: &str, from: &Node, to: &Node| Link { id: id.into(), from: from.id.clone(), to: to.id.clone(), probability: 1.0, class: 0, to_class: None };
    let links = vec![
        link("B0000000-0000-4000-8000-000000000001", &src, &s1),
        link("B0000000-0000-4000-8000-000000000002", &s1, &s2),
        link("B0000000-0000-4000-8000-000000000003", &s2, &sink),
    ];
    Network { nodes: vec![src, s2, s1, sink], links, infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None }
}

fn record(id: &str, tab: &str, method: &str, started: f64) -> RunRecord {
    let mut parameters = BTreeMap::new();
    parameters.insert("runtime".to_string(), "QNET_SOLVER_ROOT: /x/y".to_string());
    let provenance = Provenance::capture(tab, "tandem.bnet", &network(), Some("file:///tmp/tandem.bnet".into()), parameters, Some(42), vec![1, 2], "2.0.0");
    RunRecord::new(id, MethodMetadata::named(method).unwrap(), provenance, Date::from_unix(started))
}

const TAB: &str = "C0000000-0000-4000-8000-000000000001";
const OTHER_TAB: &str = "C0000000-0000-4000-8000-000000000002";
const RUN1: &str = "D0000000-0000-4000-8000-000000000001";
const RUN2: &str = "D0000000-0000-4000-8000-000000000002";
const RUN3: &str = "D0000000-0000-4000-8000-000000000003";

#[test]
fn the_file_is_compact_sorted_json_with_iso_dates_written_after_every_change() {
    let dir = scratch("format");
    let path = dir.join("Qnet").join("results-v1.json");
    let mut store = ResultsStore::open(&path);
    assert!(store.records().is_empty() && store.set_aside().is_none(), "a missing file is an empty store");
    store.begin_run(record(RUN1, TAB, "queue.des", 1_794_369_939.0));
    let text = fs::read_to_string(&path).expect("the folder is created and the file written at once");
    assert_eq!(text, archive::encode(store.records()).unwrap());
    assert!(text.starts_with(r#"{"records":[{"id":"D0000000-0000-4000-8000-000000000001","measurements":[],"method":{"displayName":"Monte Carlo","fidelity":"Queue simulation","identifier":"queue.des","implementation":"BNAsim\/fBNAsim","layer":"Queueing process","shortName":"Monte Carlo"},"provenance":{"applicationVersion":"2.0.0","bufferRegime":"Infinite capacity","exportStationIDs":["A0000000-0000-4000-8000-000000000003","A0000000-0000-4000-8000-000000000002"],"networkFingerprint":"#), "{text}");
    assert!(text.contains(r#""startedAt":"2026-11-11T04:05:39Z","status":"running","warnings":[]}"#), "{text}");
    assert!(text.ends_with(r#"],"schemaVersion":1}"#));
    assert!(text.contains(r#""replicationSeeds":[1,2],"seed":42,"sourceFileURL":"file:\/\/\/tmp\/tandem.bnet","tabID":"C0000000-0000-4000-8000-000000000001"}"#), "{text}");
    assert!(!text.contains("completedAt") && !text.contains("failureMessage") && !text.contains("null"), "nil optionals are left out");

    store.complete_run(RUN1, None, Some(NumericalEvidence::default()), vec!["w".into()], Some("raw".into()), Date::from_unix(1_794_369_940.5));
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains(r#""completedAt":"2026-11-11T04:05:40Z","elapsedSeconds":1.5,"#), "{text}");
    assert!(!text.contains("runEvidence"), "empty evidence is stored as nil");
    let names: Vec<String> = fs::read_dir(path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
    assert_eq!(names, ["results-v1.json"], "no temporary file is left behind");
}

#[test]
fn records_are_kept_newest_first_found_by_id_and_tab_and_deleted() {
    let dir = scratch("order");
    let path = dir.join("results-v1.json");
    let mut store = ResultsStore::open(&path);
    store.begin_run(record(RUN1, TAB, "queue.des", 10.0));
    store.begin_run(record(RUN2, OTHER_TAB, "srbm.spectral", 20.0));
    store.begin_run(record(RUN3, TAB, "queue-approx.qna", 30.0));
    let ids: Vec<&str> = store.records().iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, [RUN3, RUN2, RUN1]);
    let tab: Vec<&str> = store.records_for_tab(TAB).iter().map(|r| r.id.as_str()).collect();
    assert_eq!(tab, [RUN3, RUN1]);
    assert_eq!(store.records_for_tab(&TAB.to_lowercase()).len(), 2, "UUIDs compare by value, not spelling");
    assert_eq!(store.record(RUN2).unwrap().method.short_name, "Spectral");
    store.delete(RUN2);
    assert!(store.record(RUN2).is_none());
    assert_eq!(ResultsStore::open(&path).records().len(), 2, "the deletion was written");
}

#[test]
fn the_file_is_read_once_when_the_store_opens() {
    let dir = scratch("load-once");
    let path = dir.join("results-v1.json");
    let mut store = ResultsStore::open(&path);
    store.begin_run(record(RUN1, TAB, "queue.des", 10.0));
    let reopened = ResultsStore::open(&path);
    assert_eq!(reopened.records(), store.records(), "everything written reads back the same");
    fs::write(&path, r#"{"records":[],"schemaVersion":1}"#).unwrap();
    assert_eq!(reopened.records().len(), 1, "a change on disk is not seen by an open store");
}

#[test]
fn finishing_a_run_files_it_as_0_90_34_did() {
    let dir = scratch("finish");
    let path = dir.join("results-v1.json");
    let mut store = ResultsStore::open(&path);
    let at = Date::from_unix(100.0);
    let outcome = |id: &str, code: i32, stopped: bool| RunOutcome { id: id.into(), label: "Monte Carlo".into(), exit_code: code, user_stopped: stopped, finished_at: at };

    // Cancelled: the record goes.
    store.begin_run(record(RUN1, TAB, "queue.des", 50.0));
    assert_eq!(store.finish_run(&outcome(RUN1, 143, false), Some("partial output")), Finished::Deleted);
    assert!(store.record(RUN1).is_none());
    store.begin_run(record(RUN1, TAB, "queue.des", 50.0));
    assert_eq!(store.finish_run(&outcome(RUN1, 137, true), None), Finished::Deleted, "Stop pressed, whatever signal won");

    // Stop pressed in the same instant the solver finished: the result stands.
    store.begin_run(record(RUN1, TAB, "queue.des", 50.0));
    assert_eq!(store.finish_run(&outcome(RUN1, 0, true), Some("rho_1 = 0.5\n")), Finished::Parsed(Disposition::Completed));
    let r = store.record(RUN1).unwrap();
    assert_eq!((r.status, r.measurements.len(), r.elapsed_seconds), (RunStatus::Completed, 1, Some(50.0)));
    assert_eq!(r.measurements[0].station_name, "S1", "row 1 is the first station in export order");

    // A non-zero exit.
    store.begin_run(record(RUN2, TAB, "queue.des", 50.0));
    let message = "Monte Carlo exited with status 2. See the originating tab's Status pane and retained output.";
    assert_eq!(store.finish_run(&outcome(RUN2, 2, false), Some("boom")), Finished::ExitedWithError(message.into()));
    let r = store.record(RUN2).unwrap();
    assert_eq!((r.status, r.failure_message.as_deref(), r.raw_output.as_deref()), (RunStatus::Failed, Some(message), Some("boom")));

    // A parsed failure drops the parser's warnings (failRun keeps the record's).
    store.begin_run(record(RUN3, TAB, "queue.des", 50.0));
    let finished = store.finish_run(&outcome(RUN3, 0, false), Some("nothing useful"));
    assert_eq!(finished, Finished::Parsed(Disposition::Failed("The solver produced no recognized station performance measures.".into())));
    assert!(store.record(RUN3).unwrap().warnings.is_empty());

    // An unknown run has no record.
    assert_eq!(store.finish_run(&outcome("D0000000-0000-4000-8000-0000000000FF", 0, false), Some("x")), Finished::NoRecord);
}

#[test]
fn test_sets_and_convergence_studies_that_exit_cleanly_are_completed_not_failed() {
    let dir = scratch("testset");
    let mut store = ResultsStore::open(dir.join("results-v1.json"));
    let at = Date::from_unix(100.0);
    for (id, method) in [(RUN1, "benchmark.test-set"), (RUN2, "benchmark.spectral-convergence")] {
        store.begin_run(record(id, TAB, method, 50.0));
        let outcome = RunOutcome { id: id.into(), label: "Test Set".into(), exit_code: 0, user_stopped: false, finished_at: at };
        assert_eq!(store.finish_run(&outcome, Some("case  error\n1  0.01\n")), Finished::Parsed(Disposition::Completed));
        let r = store.record(id).unwrap();
        assert_eq!((r.status, r.failure_message.as_deref()), (RunStatus::Completed, None));
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        // 0.90.34 filed the same output as failed.
        assert!(matches!(parse(Some("case  error\n1  0.01\n"), r).disposition, Disposition::Failed(_)));
    }
}

#[test]
fn record_changes_follow_the_swift_store() {
    let dir = scratch("changes");
    let mut store = ResultsStore::open(dir.join("results-v1.json"));
    store.begin_run(record(RUN1, TAB, "queue.des", 100.0));
    let m = Measurement::new("E0000000-0000-4000-8000-000000000001".into(), None, "S1".into(), None, "Utilization".into(), 0.5, "ratio".into(), None, None, None);
    store.partial_run(RUN1, "half done", Some(vec![m.clone()]), None, vec!["careful".into()], None, Date::from_unix(90.0));
    let r = store.record(RUN1).unwrap();
    assert_eq!((r.status, r.elapsed_seconds, r.failure_message.as_deref()), (RunStatus::Partial, Some(0.0), Some("half done")), "elapsed is never negative");
    store.fail_run(RUN1, "then failed", Some("raw".into()), Date::from_unix(110.0));
    let r = store.record(RUN1).unwrap();
    assert_eq!((r.status, r.measurements.len(), r.warnings.len(), r.elapsed_seconds), (RunStatus::Failed, 1, 1, Some(10.0)), "failRun leaves measurements and warnings");
    store.complete_run(RUN1, None, None, vec![], None, Date::from_unix(120.0));
    assert_eq!(store.record(RUN1).unwrap().measurements, vec![m], "nil measurements keep the old ones");
    assert_eq!(store.record(RUN1).unwrap().failure_message.as_deref(), Some("then failed"), "completeRun leaves the message, as 0.90.34 did");
}

#[test]
fn a_record_is_stale_once_its_network_changes() {
    let r = record(RUN1, TAB, "queue.des", 0.0);
    let mut net = network();
    let same = qnet_core::results::NetworkSnapshot::of(&net).fingerprint();
    assert!(!r.is_stale(&same));
    net.nodes[1].position.0 += 1.0;
    assert!(r.is_stale(&qnet_core::results::NetworkSnapshot::of(&net).fingerprint()), "moving a node changes the fingerprint");
}

#[test]
fn a_file_that_does_not_decode_is_set_aside_and_never_overwritten() {
    for (name, content) in [
        ("truncated", r#"{"records":[{"id":"#.to_string()),
        ("unknown-status", r#"{"records":[{"status":"exploded"}],"schemaVersion":1}"#.to_string()),
        ("no-schema", r#"{"records":[]}"#.to_string()),
    ] {
        let dir = scratch(&format!("corrupt-{name}"));
        let path = dir.join("results-v1.json");
        fs::write(&path, &content).unwrap();
        let mut store = ResultsStore::open(&path);
        assert!(store.records().is_empty());
        let aside = store.set_aside().cloned().expect("reported");
        let backup = aside.backup.expect("moved aside");
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with("results-v1.json.corrupt-"), "{backup:?}");
        assert_eq!(fs::read_to_string(&backup).unwrap(), content, "the original bytes are kept");
        store.begin_run(record(RUN1, TAB, "queue.des", 0.0));
        assert!(store.persistence_error().is_none());
        assert_eq!(fs::read_to_string(&backup).unwrap(), content, "the next run doesn't touch it");
        assert_eq!(ResultsStore::open(&path).records().len(), 1);
    }
}

#[test]
fn a_file_that_cannot_be_read_is_left_in_place_and_not_written_over() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("unreadable");
    let path = dir.join("results-v1.json");
    let content = r#"{"records":[],"schemaVersion":1}"#;
    fs::write(&path, content).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(&path).is_ok() {
        eprintln!("note: running with privileges that read a mode-000 file; skipped");
        return;
    }
    let mut store = ResultsStore::open(&path);
    let aside = store.set_aside().cloned().unwrap();
    assert_eq!(aside.backup, None, "left where it is");
    store.begin_run(record(RUN1, TAB, "queue.des", 0.0));
    assert_eq!(store.records().len(), 1, "the run is still kept in memory");
    assert!(store.persistence_error().unwrap().contains("not being saved"), "{:?}", store.persistence_error());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), content, "the file was not written over");
}

#[test]
fn a_run_with_a_non_finite_number_is_failed_with_no_measurements_and_the_file_stays_writable() {
    let dir = scratch("non-finite");
    let path = dir.join("results-v1.json");
    let mut store = ResultsStore::open(&path);
    store.begin_run(record(RUN1, TAB, "queue.des", 0.0));
    // `rho_1 = 1e999` parses to infinity, as Swift's Double("1e999") did; JSONEncoder can't write it.
    let outcome = RunOutcome { id: RUN1.into(), label: "Monte Carlo".into(), exit_code: 0, user_stopped: false, finished_at: Date::from_unix(1.0) };
    let message = "Monte Carlo produced a value that isn't a finite number (Utilization at S1 = inf), so no measurements were stored. See the originating tab's Status pane and retained output.";
    assert_eq!(store.finish_run(&outcome, Some("rho_1 = 1e999\nrho_2 = 0.5\n")), Finished::Parsed(Disposition::Failed(message.into())));
    let r = store.record(RUN1).unwrap();
    assert_eq!((r.status, r.measurements.len(), r.failure_message.as_deref()), (RunStatus::Failed, 0, Some(message)));
    assert_eq!(r.raw_output.as_deref(), Some("rho_1 = 1e999\nrho_2 = 0.5\n"), "the transcript is kept");
    assert_eq!(store.persistence_error(), None);
    // The file was written and reads back with the failed record, and later runs still file.
    let reopened = ResultsStore::open(&path);
    assert_eq!(reopened.record(RUN1).map(|r| r.status), Some(RunStatus::Failed));
    store.begin_run(record(RUN2, TAB, "queue.des", 0.0));
    let next = RunOutcome { id: RUN2.into(), ..outcome };
    assert_eq!(store.finish_run(&next, Some("rho_1 = 0.5\n")), Finished::Parsed(Disposition::Completed));
    assert_eq!(store.persistence_error(), None);
}

/// Every `results-v1.json` that 0.90.34 itself wrote while `scripts/make-golden-runs.sh` ran it
/// (one per example, in its throwaway home under ~/Library/Caches/qnet/legacy-0.90.34-runs) reads,
/// writes back byte for byte, has the fingerprints it recorded, and each finished record's raw
/// output parses to what 0.90.34 filed. Skipped when that cache is absent.
#[test]
fn archives_written_by_0_90_34_read_and_write_back_byte_for_byte() {
    let Some(home) = std::env::var_os("HOME") else { return };
    let cache = Path::new(&home).join("Library/Caches/qnet/legacy-0.90.34-runs");
    let mut files: Vec<PathBuf> = fs::read_dir(&cache)
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path().join("Library/Application Support/Qnet/results-v1.json")).filter(|p| p.exists()).collect())
        .unwrap_or_default();
    files.sort();
    if files.is_empty() {
        eprintln!("note: no 0.90.34 results files under {}; skipped", cache.display());
        return;
    }
    let (mut records, mut reparsed) = (0, 0);
    let mut problems = vec![];
    for f in &files {
        let text = fs::read_to_string(f).unwrap();
        let decoded = match archive::decode(&text) {
            Ok(r) => r,
            Err(e) => {
                problems.push(format!("{}: {e}", f.display()));
                continue;
            }
        };
        let ours = archive::encode(&decoded).unwrap();
        if ours != text {
            let at = ours.bytes().zip(text.bytes()).position(|(a, b)| a != b).unwrap_or(ours.len().min(text.len()));
            let near = |t: &str| t.get(at.saturating_sub(80)..(at + 80).min(t.len())).unwrap_or("").to_string();
            problems.push(format!("{}: doesn't write back byte for byte at {at}: {:?} vs {:?}", f.display(), near(&ours), near(&text)));
        }
        for r in &decoded {
            records += 1;
            if r.provenance.network_snapshot.fingerprint() != r.provenance.network_fingerprint {
                problems.push(format!("{} {}: fingerprint differs", f.display(), r.id));
            }
            let exited = r.failure_message.as_deref().is_some_and(|m| m.contains(" exited with status "));
            if r.status == RunStatus::Running || exited {
                continue;
            }
            let mut fresh = r.clone();
            fresh.measurements.clear();
            let parsed = parse(r.raw_output.as_deref(), &fresh);
            let (status, message) = match &parsed.disposition {
                Disposition::Completed => (RunStatus::Completed, None),
                Disposition::Partial(m) => (RunStatus::Partial, Some(m.clone())),
                Disposition::Failed(m) => (RunStatus::Failed, Some(m.clone())),
            };
            let mut ours = parsed.measurements.clone();
            for (m, g) in ours.iter_mut().zip(&r.measurements) {
                m.id = g.id.clone();
            }
            let failed = status == RunStatus::Failed;
            let evidence = if failed { None } else { parsed.evidence.clone() };
            let warnings = if failed { vec![] } else { parsed.warnings.clone() };
            let measurements = if failed { vec![] } else { ours };
            if status != r.status || message != r.failure_message || measurements != r.measurements || evidence != r.run_evidence || warnings != r.warnings {
                problems.push(format!("{} {} ({}): re-parsing gives {status:?} {message:?}, {} measurements; 0.90.34 filed {:?} {:?}, {}", f.display(), r.id, r.method.identifier, measurements.len(), r.status, r.failure_message, r.measurements.len()));
            }
            reparsed += 1;
        }
    }
    eprintln!("0.90.34 archives: {} files, {records} records, {reparsed} re-parsed", files.len());
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
