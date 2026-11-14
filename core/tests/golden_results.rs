//! The results model and parser against what 0.90.34 filed for real runs (golden/runs/<example>/
//! <method>/, written by scripts/make-golden-runs.sh, which ran 0.90.34's own Run-menu pipeline).
//! For every `record.json` there:
//!
//! (a) it decodes with `RunRecord` and encodes back byte for byte (`JSONEncoder` with
//!     `[.prettyPrinted, .sortedKeys]` and `.iso8601` dates, as the dump wrote it);
//! (b) the fingerprint of its network snapshot is the `networkFingerprint` 0.90.34 recorded;
//! (c) the record is put back as it was before the run finished (running, no measurements) and
//!     finished again from `archive.txt` and `exit.txt` as `finalizeStructuredResult` did: a non-zero
//!     exit fails it with the exit sentence, an exit of 0 is parsed. Status, failure message,
//!     measurements (ids aside), evidence, warnings and raw output must equal what 0.90.34 filed.
//!
//! The corpus is regenerated from time to time; while `golden/runs/PROVENANCE.json` is absent the
//! test checks whatever records exist (and says so), and once it is present every record must pass.

use std::path::{Path, PathBuf};

use qnet_core::results::{parse, Disposition, RunRecord, RunStatus};

fn runs_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../golden/runs")
}

fn record_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            record_files(&p, out);
        } else if p.file_name().is_some_and(|n| n == "record.json") {
            out.push(p);
        }
    }
}

/// The record as `finalizeStructuredResult` found it: just registered, still running.
fn as_registered(r: &RunRecord) -> RunRecord {
    let mut r = r.clone();
    r.status = RunStatus::Running;
    r.completed_at = None;
    r.elapsed_seconds = None;
    r.measurements.clear();
    r.run_evidence = None;
    r.warnings.clear();
    r.failure_message = None;
    r.raw_output = None;
    r
}

/// One record's three checks; the problems found, as sentences.
fn check(path: &Path) -> Result<bool, Vec<String>> {
    let text = std::fs::read_to_string(path).map_err(|e| vec![format!("unreadable: {e}")])?;
    if text == "null\n" {
        // A cancelled (timed-out) run: 0.90.34 deleted its record.
        return Ok(false);
    }
    let mut problems = vec![];
    let golden = RunRecord::parse(&text).map_err(|e| vec![format!("(a) doesn't decode: {e}")])?;

    // (a) Byte-identical re-encoding.
    match golden.to_pretty().map(|t| t + "\n") {
        Ok(ours) if ours == text => {}
        Ok(ours) => {
            let line = ours.lines().zip(text.lines()).position(|(a, b)| a != b).unwrap_or(0);
            problems.push(format!("(a) re-encoding differs at line {}: {:?} vs {:?}", line + 1, ours.lines().nth(line), text.lines().nth(line)));
        }
        Err(e) => problems.push(format!("(a) doesn't encode: {e}")),
    }

    // (b) The fingerprint.
    let fingerprint = golden.provenance.network_snapshot.fingerprint();
    if fingerprint != golden.provenance.network_fingerprint {
        problems.push(format!("(b) fingerprint {fingerprint}, 0.90.34 recorded {}", golden.provenance.network_fingerprint));
    }

    // (c) Finishing the run again from its archive.
    let dir = path.parent().unwrap();
    let archive = std::fs::read_to_string(dir.join("archive.txt")).ok();
    let exit: Option<i32> = std::fs::read_to_string(dir.join("exit.txt")).ok().and_then(|t| t.trim().parse().ok());
    let completed_at = golden.completed_at.expect("a finished record has a completion time");
    let mut ours = as_registered(&golden);
    // 0.90.34 read the archive with String(contentsOfFile:), nil when unreadable; the dump wrote ""
    // for nil, and a record keeps no rawOutput then.
    let raw: Option<String> = archive.filter(|a| !a.is_empty() || golden.raw_output.is_some());
    match exit {
        Some(code) if code != 0 => {
            let ending = format!(" exited with status {code}. See the originating tab's Status pane and retained output.");
            match &golden.failure_message {
                Some(m) if m.ends_with(&ending) => ours.fail(m, raw.clone(), completed_at),
                other => problems.push(format!("(c) exit {code}, but the failure message is {other:?}")),
            }
        }
        _ => {
            let parsed = parse(raw.as_deref(), &ours);
            match &parsed.disposition {
                Disposition::Completed => ours.complete(Some(parsed.measurements), parsed.evidence, parsed.warnings, raw.clone(), completed_at),
                Disposition::Partial(m) => ours.partial(m, Some(parsed.measurements), parsed.evidence, parsed.warnings, raw.clone(), completed_at),
                Disposition::Failed(m) => ours.fail(m, raw.clone(), completed_at),
            }
        }
    }
    // Measurement ids are random in 0.90.34: compare everything else.
    if ours.measurements.len() == golden.measurements.len() {
        for (m, g) in ours.measurements.iter_mut().zip(&golden.measurements) {
            m.id = g.id.clone();
        }
    }
    if ours.status != golden.status {
        problems.push(format!("(c) status {:?}, 0.90.34 {:?}", ours.status, golden.status));
    }
    if ours.failure_message != golden.failure_message {
        problems.push(format!("(c) failure message {:?}, 0.90.34 {:?}", ours.failure_message, golden.failure_message));
    }
    if ours.measurements != golden.measurements {
        let n = ours.measurements.len().max(golden.measurements.len());
        let first = (0..n).find(|&i| ours.measurements.get(i) != golden.measurements.get(i)).unwrap_or(0);
        problems.push(format!(
            "(c) measurements differ ({} vs 0.90.34's {}); first at {first}: {:?} vs {:?}",
            ours.measurements.len(),
            golden.measurements.len(),
            ours.measurements.get(first),
            golden.measurements.get(first)
        ));
    }
    if ours.run_evidence != golden.run_evidence {
        problems.push(format!("(c) evidence {:?}, 0.90.34 {:?}", ours.run_evidence, golden.run_evidence));
    }
    if ours.warnings != golden.warnings {
        problems.push(format!("(c) warnings {:?}, 0.90.34 {:?}", ours.warnings, golden.warnings));
    }
    if ours.raw_output != golden.raw_output {
        problems.push("(c) the raw output isn't the archive".to_string());
    }
    if problems.is_empty() {
        Ok(true)
    } else {
        Err(problems)
    }
}

#[test]
fn every_record_0_90_34_filed_decodes_re_encodes_fingerprints_and_re_parses_identically() {
    let root = runs_root();
    let complete = root.join("PROVENANCE.json").exists();
    let mut files = vec![];
    record_files(&root, &mut files);
    if files.is_empty() {
        assert!(!complete, "golden/runs/PROVENANCE.json exists but no record.json was found");
        eprintln!("note: golden/runs has no records yet (being generated?); nothing to compare");
        return;
    }
    let mut failures = vec![];
    let mut checked = 0;
    let mut skipped_null = 0;
    for f in &files {
        match check(f) {
            Ok(true) => checked += 1,
            Ok(false) => skipped_null += 1,
            Err(problems) => failures.push(format!("{}:\n    {}", f.strip_prefix(&root).unwrap_or(f).display(), problems.join("\n    "))),
        }
    }
    eprintln!(
        "golden results: {checked} records match, {skipped_null} cancelled runs without a record, {} differ{}",
        failures.len(),
        if complete { "" } else { " (corpus still being generated)" }
    );
    assert!(failures.is_empty(), "{} of {} records differ from 0.90.34:\n{}", failures.len(), files.len(), failures.join("\n"));
}
