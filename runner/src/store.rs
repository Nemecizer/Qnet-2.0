//! The results store: every run's record, kept newest first in one file (0.90.34 `ResultsStore`
//! in `ResultsWorkspace.swift`, and the finishing step `finalizeStructuredResult` in
//! `QnetGUIApp.swift`).
//!
//! The file is `{"records": [...], "schemaVersion": 1}` written exactly as 0.90.34 wrote
//! `results-v1.json`: `JSONEncoder` with sorted keys, not pretty printed, ISO-8601 dates
//! (`qnet_core::results::archive`). It is read once, when the store is opened, and rewritten
//! atomically (a temporary file renamed over it, the folder created first) after every change. A
//! record is registered when a run starts, then completed, made partial, failed or deleted when it
//! ends; nothing is ever pruned. Staleness is the record's own check (`RunRecord::is_stale`, by
//! network fingerprint).
//!
//! Where 2.0 differs, deliberately:
//!
//! - The path is injected. 0.90.34 used `~/Library/Application Support/Qnet/results-v1.json`;
//!   2.0's app passes its own data folder (identifier `com.nemecj.qnet`), and bringing 0.90.34's
//!   file across is an import (ledger FILE-034, RES-001). The format is unchanged, so that file
//!   reads here as it is.
//! - A file that can't be read is never overwritten (FILE-039, RES-003, D5). 0.90.34 came up empty
//!   and its next write destroyed the old file. Here, as P0 did for the preferences
//!   (`src-tauri/src/util.rs` `load_json_or_quarantine`, whose rule this repeats because the runner
//!   doesn't depend on the app): a file that reads but doesn't decode is moved aside to
//!   `results-v1.json.corrupt-<unix ms>` and reported, and the store starts empty; a file that can't
//!   be read at all (permissions, an I/O error) is left where it is, reported, and the store then
//!   keeps its records in memory and refuses to write over it, saying so in `persistence_error`.
//! - A failed write is reported through `persistence_error` (0.90.34 set it and nothing read it).
//! - A finished run whose parsed numbers include a NaN or an infinity (`rho_1 = 1e999`) is failed
//!   with a sentence naming the value, and no measurements are kept (D5, the owner's decision of
//!   2026-11-11). `JSONEncoder` can't write such a number, so 0.90.34 kept the record and every
//!   later write of the file failed.
//! - Test Set and Spectral Convergence runs that exit 0 are recorded as completed (RES-047,
//!   METH-150, D5): their output has no station rows, so the parser alone would file them as failed.
//!
//! Left out, as the ledger records (RES-038 to RES-042): `appendMeasurements`,
//! `replaceMeasurements`, `cancelRun`, `addCompletedRecord`, `deleteAll(for:)`,
//! `networkDocument(for:)` and `flush()`, which nothing in 0.90.34 called.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use qnet_core::results::{archive, ids, parse, Date, Disposition, EncodeError, Measurement, NumericalEvidence, RunRecord};

/// A results file that couldn't be used when the store opened.
#[derive(Clone, Debug, PartialEq)]
pub struct SetAside {
    /// Where the file was.
    pub original: PathBuf,
    /// Where it is now: the `.corrupt-<ms>` copy, or None when it couldn't be read at all and was
    /// left in place (the store then doesn't write over it).
    pub backup: Option<PathBuf>,
    /// Why it couldn't be used.
    pub error: String,
}

/// How a supervised run ended, as the finishing step needs it (0.90.34 `TerminalRunSummary`).
#[derive(Clone, Debug, PartialEq)]
pub struct RunOutcome {
    /// The run's id, which is its record's id.
    pub id: String,
    /// The run's display label ("Monte Carlo", "Run Comparison"…), for the failure sentence.
    pub label: String,
    pub exit_code: i32,
    /// True when Stop was pressed for this run before it ended.
    pub user_stopped: bool,
    pub finished_at: Date,
}

impl RunOutcome {
    /// Bash's exit status for a run interrupted by SIGINT.
    pub const CANCELLED_EXIT_CODE: i32 = 130;

    pub fn succeeded(&self) -> bool {
        self.exit_code == 0
    }

    /// True when the run ended because the user stopped it: Stop was pressed, or it ended by
    /// SIGINT (130) or SIGTERM (143). A run that exited 0 is never cancelled, so a Stop in the same
    /// instant a solver finished keeps its result.
    pub fn cancelled(&self) -> bool {
        self.exit_code != 0 && (self.user_stopped || self.exit_code == Self::CANCELLED_EXIT_CODE || self.exit_code == 143)
    }
}

/// What `finish_run` did with the record.
#[derive(Clone, Debug, PartialEq)]
pub enum Finished {
    /// The run had no record (a diagnostic, or an unknown id).
    NoRecord,
    /// The run was cancelled and its record deleted.
    Deleted,
    /// The run exited non-zero and its record failed with the exit sentence.
    ExitedWithError(String),
    /// The run exited 0 and its output was parsed; the record took this outcome.
    Parsed(Disposition),
}

/// The store: the records, newest first, and the file they live in.
#[derive(Debug)]
pub struct ResultsStore {
    path: PathBuf,
    records: Vec<RunRecord>,
    set_aside: Option<SetAside>,
    /// The file couldn't be read and was left in place, so it must not be written over.
    writes_blocked: bool,
    persistence_error: Option<String>,
}

impl ResultsStore {
    /// Opens the store at `path`, reading the file once. A missing file is an empty store; an
    /// unusable one is set aside as the module comment describes.
    pub fn open(path: impl Into<PathBuf>) -> ResultsStore {
        let path = path.into();
        let mut store = ResultsStore { path, records: vec![], set_aside: None, writes_blocked: false, persistence_error: None };
        let bytes = match fs::read(&store.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return store,
            Err(e) => {
                store.set_aside = Some(SetAside { original: store.path.clone(), backup: None, error: e.to_string() });
                store.writes_blocked = true;
                store.persistence_error = Some(blocked_sentence(&store.path, &e.to_string()));
                return store;
            }
        };
        let decoded = String::from_utf8(bytes).map_err(|_| "The file isn't UTF-8 text.".to_string()).and_then(|text| archive::decode(&text).map_err(|e| e.to_string()));
        match decoded {
            Ok(records) => store.records = records,
            Err(error) => {
                let name = store.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let backup = store.path.with_file_name(format!("{name}.corrupt-{}", now_ms()));
                match fs::rename(&store.path, &backup) {
                    Ok(()) => store.set_aside = Some(SetAside { original: store.path.clone(), backup: Some(backup), error }),
                    Err(_) => {
                        store.persistence_error = Some(blocked_sentence(&store.path, &error));
                        store.set_aside = Some(SetAside { original: store.path.clone(), backup: None, error });
                        store.writes_blocked = true;
                    }
                }
            }
        }
        store
    }

    /// The file the store reads and writes.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Every record, newest first.
    pub fn records(&self) -> &[RunRecord] {
        &self.records
    }

    /// The records whose run was started from tab `tab_id` (`records(for:)`), newest first.
    pub fn records_for_tab(&self, tab_id: &str) -> Vec<&RunRecord> {
        self.records.iter().filter(|r| r.provenance.tab_id.eq_ignore_ascii_case(tab_id)).collect()
    }

    /// The record with this id.
    pub fn record(&self, id: &str) -> Option<&RunRecord> {
        self.records.iter().find(|r| r.id.eq_ignore_ascii_case(id))
    }

    /// The file that couldn't be used when the store opened, if any.
    pub fn set_aside(&self) -> Option<&SetAside> {
        self.set_aside.as_ref()
    }

    /// Why the last write didn't happen, or None when it did.
    pub fn persistence_error(&self) -> Option<&str> {
        self.persistence_error.as_deref()
    }

    /// Registers a run before it starts (`beginRun`): the record goes first, the file is written,
    /// and its id is returned. (0.90.34 then posted `qnetResultRunDidBegin`; the caller emits the
    /// equivalent event.)
    pub fn begin_run(&mut self, record: RunRecord) -> String {
        let id = record.id.clone();
        self.records.insert(0, record);
        self.persist();
        id
    }

    /// `completeRun`: see `RunRecord::complete`. Unknown ids are ignored.
    pub fn complete_run(&mut self, id: &str, measurements: Option<Vec<Measurement>>, evidence: Option<NumericalEvidence>, warnings: Vec<String>, raw_output: Option<String>, completed_at: Date) {
        self.mutate(id, |r| r.complete(measurements, evidence, warnings, raw_output, completed_at));
    }

    /// `partialRun`: see `RunRecord::partial`.
    #[allow(clippy::too_many_arguments)]
    pub fn partial_run(
        &mut self,
        id: &str,
        message: &str,
        measurements: Option<Vec<Measurement>>,
        evidence: Option<NumericalEvidence>,
        warnings: Vec<String>,
        raw_output: Option<String>,
        completed_at: Date,
    ) {
        self.mutate(id, |r| r.partial(message, measurements, evidence, warnings, raw_output, completed_at));
    }

    /// `failRun`: see `RunRecord::fail`.
    pub fn fail_run(&mut self, id: &str, message: &str, raw_output: Option<String>, completed_at: Date) {
        self.mutate(id, |r| r.fail(message, raw_output, completed_at));
    }

    /// Removes a record (and writes the file even when there was none, as 0.90.34 did).
    pub fn delete(&mut self, id: &str) {
        self.records.retain(|r| !r.id.eq_ignore_ascii_case(id));
        self.persist();
    }

    /// Files a finished run (0.90.34 `finalizeStructuredResult`): a cancelled run's record is
    /// deleted; a non-zero exit fails it with "<label> exited with status <n>. See the originating
    /// tab's Status pane and retained output."; an exit of 0 is parsed and the record completed,
    /// made partial or failed with the parser's sentence. The transcript `raw` (the full-precision
    /// archive, never the display stream) is kept as the record's raw output in every case.
    ///
    /// The Status-log line for a non-zero, non-cancelled exit belongs to the caller, which owns the
    /// tabs and the summary's wording.
    pub fn finish_run(&mut self, outcome: &RunOutcome, raw: Option<&str>) -> Finished {
        let Some(record) = self.record(&outcome.id) else { return Finished::NoRecord };
        if outcome.cancelled() {
            self.delete(&outcome.id);
            return Finished::Deleted;
        }
        let raw_output = raw.map(str::to_string);
        if !outcome.succeeded() {
            let message = format!("{} exited with status {}. See the originating tab's Status pane and retained output.", outcome.label, outcome.exit_code);
            self.fail_run(&outcome.id, &message, raw_output, outcome.finished_at);
            return Finished::ExitedWithError(message);
        }
        let parsed = parse(raw, record);
        // D5 (RES-047): a test set's or spectral convergence study's tables have no station rows;
        // a clean exit is a completed run, not "no recognized station performance measures".
        let aggregate_only = matches!(record.method.identifier.as_str(), ids::TEST_SET | ids::SPECTRAL_CONVERGENCE);
        let disposition = match parsed.disposition {
            Disposition::Failed(_) if aggregate_only && parsed.measurements.is_empty() && raw.is_some_and(|r| !r.is_empty()) => Disposition::Completed,
            d => d,
        };
        let warnings = if aggregate_only {
            parsed.warnings.into_iter().filter(|w| w != "No recognized station measurements were found; inspect the retained raw output.").collect()
        } else {
            parsed.warnings
        };
        // D5 (the owner's decision, 2026-11-11): a record holding a NaN or an infinity can't be
        // written as JSON. 0.90.34 kept it, and every later write of the file then failed. Here the
        // run is failed instead, naming the value, with no measurements, so the file stays
        // writable.
        if !matches!(disposition, Disposition::Failed(_)) {
            let mut trial = record.clone();
            trial.complete(Some(parsed.measurements.clone()), parsed.evidence.clone(), Vec::new(), None, outcome.finished_at);
            if let Err(e) = trial.to_json() {
                let message = non_finite_sentence(&outcome.label, &trial, &e);
                self.fail_run(&outcome.id, &message, raw_output, outcome.finished_at);
                return Finished::Parsed(Disposition::Failed(message));
            }
        }
        match &disposition {
            Disposition::Completed => self.complete_run(&outcome.id, Some(parsed.measurements), parsed.evidence, warnings, raw_output, outcome.finished_at),
            Disposition::Partial(m) => self.partial_run(&outcome.id, m, Some(parsed.measurements), parsed.evidence, warnings, raw_output, outcome.finished_at),
            Disposition::Failed(m) => self.fail_run(&outcome.id, m, raw_output, outcome.finished_at),
        }
        Finished::Parsed(disposition)
    }

    fn mutate(&mut self, id: &str, body: impl FnOnce(&mut RunRecord)) {
        let Some(r) = self.records.iter_mut().find(|r| r.id.eq_ignore_ascii_case(id)) else { return };
        body(r);
        self.persist();
    }

    /// Writes every record (`persist`), or records why it couldn't.
    fn persist(&mut self) {
        if self.writes_blocked {
            let why = self.set_aside.as_ref().map(|s| s.error.clone()).unwrap_or_default();
            self.persistence_error = Some(blocked_sentence(&self.path, &why));
            return;
        }
        let text = match archive::encode(&self.records) {
            Ok(t) => t,
            Err(e) => {
                self.persistence_error = Some(e.to_string());
                return;
            }
        };
        self.persistence_error = write_atomic(&self.path, text.as_bytes()).err();
    }
}

/// The failure sentence for a run whose parsed numbers include a NaN or an infinity: "<label>
/// produced a value that isn't a finite number (Utilization at S1 = inf), so no measurements were
/// stored. See the originating tab's Status pane and retained output." A measurement is named by
/// its metric, class and station; any other field by its path in the record.
fn non_finite_sentence(label: &str, record: &RunRecord, e: &EncodeError) -> String {
    let value = if e.value.is_nan() {
        "nan"
    } else if e.value > 0.0 {
        "inf"
    } else {
        "-inf"
    };
    let measurement = e
        .path
        .strip_prefix("measurements[")
        .and_then(|rest| rest.split_once(']'))
        .and_then(|(i, _)| i.parse::<usize>().ok())
        .and_then(|i| record.measurements.get(i));
    let what = match measurement {
        Some(m) if m.customer_class.is_some() => format!("{} ({}) at {}", m.metric, m.class_label(), m.station_name),
        Some(m) => format!("{} at {}", m.metric, m.station_name),
        None => e.path.clone(),
    };
    format!("{label} produced a value that isn't a finite number ({what} = {value}), so no measurements were stored. See the originating tab's Status pane and retained output.")
}

fn blocked_sentence(path: &Path, error: &str) -> String {
    format!("{} couldn't be read ({error}), so it was left as it is and results are not being saved.", path.display())
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Writes `bytes` to `path` through a temporary file in the same folder, renamed over it, creating
/// the folder first (0.90.34: `createDirectory(withIntermediateDirectories:)` then
/// `write(options: .atomic)`).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "results".into());
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = dir.join(format!(".{name}.tmp-{}-{nanos:08x}", std::process::id()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok::<(), std::io::Error>(())
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't save {}: {e}", path.display())
    })
}
