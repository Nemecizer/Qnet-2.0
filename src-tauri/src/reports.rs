//! Failure reports (new in 2.0, ROADMAP A4): what Qnet keeps when a run ends in failure, so the
//! student can be told what happened and the developer can be sent something useful.
//!
//! A run that fails other than by the user's Stop (a non-zero exit, a signal such as a segfault,
//! a solver that could not be started, output the result parser could not use, or a run thread
//! that ended on an internal error) gets a folder `reports/<timestamp>-<method>/` in the app's
//! data folder:
//!
//! - `report.json`: Qnet's version and build, the macOS version, the chip, the method and its
//!   parameters, every command line (paths inside the app bundle written relative to it, the
//!   temporary folder as `$TMPDIR`, the home folder as `~`), the exit status or signal name, the
//!   duration, the solver's resolved path and the runtime provenance the result record carries;
//! - `input.*`: the solver input file(s), byte for byte as the run wrote them;
//! - `network.bnet`: the document as it was run;
//! - `stderr.txt`: what the solvers wrote to standard error;
//! - `output-tail.txt`: the last 200 lines of the run's output.
//!
//! The newest [`KEEP`] reports are kept and older ones deleted. Nothing here uses the network:
//! a report leaves the Mac only if the user sends it.
//!
//! `runs.rs` gathers the evidence ([`Failure`]) and calls [`write`]; the page reads a report back
//! with [`report_get`] and chooses the explanation (`src/runs/reports/words.ts`).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use qnet_runner::supervisor::{ExitKind, StepRecord};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::errors::{ErrorKind, QnError};
use crate::runs::Runs;

/// How many reports are kept.
pub const KEEP: usize = 20;
/// How many lines of the run's output (and of its stderr, for the page) a report shows.
pub const TAIL_LINES: usize = 200;
/// An input file larger than this is left out of the report (its name is still listed).
pub const INPUT_LIMIT: u64 = 8 << 20;
/// The input files of one report together hold at most this much; what would go over is left out.
pub const INPUT_TOTAL_LIMIT: u64 = 32 << 20;
/// What `report_get` says while a report's folder is there but its `report.json` is not yet.
pub const STILL_WRITING: &str = "Qnet is still writing that failure report.";

/// Where a report's copy of one input file comes from.
#[derive(Clone, Debug, PartialEq)]
pub enum InputSource {
    /// A file to copy (a staged hard link, see [`InputStage`]).
    File(PathBuf),
    /// Nothing: the file could not be kept.
    Gone,
}

/// The run's input files, kept past the run's own clean-up without reading them: each is
/// hard-linked into a folder beside it when the run starts (the supervisor unlinks the run's own
/// names when it ends; the links keep the bytes). A report copies from the links; dropping the
/// stage removes them. A run that succeeds pays one `mkdir`, and a `link` and an `unlink` per
/// input file, and no bytes are read.
#[derive(Debug, Default)]
pub struct InputStage {
    dir: Option<PathBuf>,
    /// (original file name, the link), or `None` where no link could be made.
    files: Vec<(String, Option<PathBuf>)>,
}

impl InputStage {
    /// Links every regular file of `paths` (folders, and outputs not written yet, are skipped).
    pub fn link(paths: &[PathBuf]) -> InputStage {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let mut stage = InputStage::default();
        for p in paths {
            if !std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file()) {
                continue;
            }
            let (Some(name), Some(parent)) = (p.file_name(), p.parent()) else { continue };
            if stage.dir.is_none() {
                let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let dir = parent.join(format!("qnet_report_inputs_{}_{n}", std::process::id()));
                if std::fs::create_dir(&dir).is_ok() {
                    stage.dir = Some(dir);
                }
            }
            let link = stage.dir.as_ref().map(|d| d.join(format!("{}_{}", stage.files.len(), name.to_string_lossy()))).filter(|l| std::fs::hard_link(p, l).is_ok());
            stage.files.push((name.to_string_lossy().into_owned(), link));
        }
        stage
    }

    /// The staged files, for [`Failure::inputs`].
    pub fn inputs(&self) -> Vec<(String, InputSource)> {
        self.files.iter().map(|(name, link)| (name.clone(), link.clone().map_or(InputSource::Gone, InputSource::File))).collect()
    }
}

impl Drop for InputStage {
    fn drop(&mut self) {
        for (_, link) in &self.files {
            if let Some(link) = link {
                let _ = std::fs::remove_file(link);
            }
        }
        if let Some(dir) = &self.dir {
            // Only the links were put there, so the folder is empty now.
            let _ = std::fs::remove_dir(dir);
        }
    }
}

/// How a run failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureKind {
    /// A solver exited with a non-zero status.
    Exit,
    /// A signal ended a solver (a crash).
    Signal,
    /// A solver, or its input, could not be started or written.
    CouldNotStart,
    /// The solver exited 0, but its output held nothing Qnet could use.
    Unparsed,
    /// Qnet's own run thread ended on an internal error.
    Internal,
}

/// Everything `runs.rs` knows about a failed run.
#[derive(Clone, Debug, Default)]
pub struct Failure {
    /// The run label ("lp").
    pub method: String,
    /// The display label ("Linear Program").
    pub method_name: String,
    /// The tab's title.
    pub title: String,
    pub exit_code: i32,
    pub duration_seconds: f64,
    /// True when the run's own thread panicked.
    pub internal: bool,
    /// Why the record was filed as failed, when it was.
    pub reason: Option<String>,
    /// The result record's parameters, including "runtime" provenance.
    pub parameters: BTreeMap<String, String>,
    /// What a parameter sheet changed for this run.
    pub overrides: BTreeMap<String, String>,
    pub seed: Option<u64>,
    pub infinite_buffers: bool,
    /// (station name, ρ) in export order, where ρ is finite.
    pub utilisation: Vec<(String, f64)>,
    pub steps: Vec<StepRecord>,
    /// The run's Status lines, (severity, text), in order.
    pub status_lines: Vec<(String, String)>,
    /// (file name, where its bytes are) of every input file written while preparing.
    pub inputs: Vec<(String, InputSource)>,
    /// The document as run, as `.bnet` text.
    pub network: String,
    /// The run's full output.
    pub archive: Vec<u8>,
}

/// What this Mac and this build are, and the folders a report must not spell out.
#[derive(Clone, Debug, Default)]
pub struct Environment {
    pub qnet_version: String,
    pub build_tag: String,
    pub macos_version: String,
    pub chip: String,
    /// `<X>.app`, when Qnet runs from a bundle.
    pub bundle: Option<PathBuf>,
    pub temp_dir: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

impl Environment {
    /// This process's: `bundle_resources` is the resolver's `Contents/Resources`.
    pub fn detect(bundle_resources: Option<&Path>) -> Environment {
        Environment {
            qnet_version: env!("CARGO_PKG_VERSION").to_string(),
            build_tag: env!("QNET_BUILD_TAG").to_string(),
            macos_version: sysctl_string("kern.osproductversion").unwrap_or_default(),
            chip: sysctl_string("machdep.cpu.brand_string").unwrap_or_default(),
            bundle: bundle_resources.and_then(|r| r.parent()).and_then(|c| c.parent()).map(Path::to_path_buf),
            temp_dir: Some(std::env::temp_dir()),
            home: std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from),
        }
    }

    /// `text` without this Mac's folders: a path inside the bundle becomes relative to it
    /// ("Contents/Resources/bin/…"), the temporary folder `$TMPDIR`, the home folder `~`.
    pub fn scrub(&self, text: &str) -> String {
        // One scrubber for reports and for `qnet-cli run --json` (qnet_runner::scrub).
        qnet_runner::scrub::Folders { bundle: self.bundle.clone(), temp_dir: self.temp_dir.clone(), home: self.home.clone() }.scrub(text, qnet_runner::scrub::Bundle::Relative)
    }

    /// `value` with every string in it scrubbed, the keys of its objects too.
    pub fn scrub_json(&self, value: serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        match value {
            Value::String(s) => Value::String(self.scrub(&s)),
            Value::Array(a) => Value::Array(a.into_iter().map(|v| self.scrub_json(v)).collect()),
            Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (self.scrub(&k), self.scrub_json(v))).collect()),
            other => other,
        }
    }
}

/// Whether a setting or sheet entry may be written to a report. The assistant's settings
/// (`ai.*`: its system prompt, base URLs, models) are no part of a run, and nothing that reads
/// like a credential is ever written, whatever sent it.
pub fn reportable(key: &str, value: &str) -> bool {
    let k = key.to_ascii_lowercase();
    let v = value.trim_start().to_ascii_lowercase();
    const SECRET_NAMES: [&str; 9] = ["key", "token", "secret", "password", "passwd", "credential", "keychain", "authorization", "bearer"];
    !(k.starts_with("ai.") || k == "ai" || SECRET_NAMES.iter().any(|w| k.contains(w)) || v.starts_with("sk-") || v.starts_with("bearer ") || v.contains("api_key=") || v.contains("apikey="))
}

/// A string sysctl ("kern.osproductversion" → "15.5").
fn sysctl_string(name: &str) -> Option<String> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut len: libc::size_t = 0;
    // SAFETY: a null buffer asks only for the length.
    if unsafe { libc::sysctlbyname(name.as_ptr(), std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0) } != 0 || len == 0 {
        return None;
    }
    let mut buf = vec![0u8; len];
    // SAFETY: `buf` holds `len` bytes, and `len` is updated to what was written.
    if unsafe { libc::sysctlbyname(name.as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buf.truncate(len);
    while buf.last() == Some(&0) {
        buf.pop();
    }
    Some(String::from_utf8_lossy(&buf).trim().to_string()).filter(|s| !s.is_empty())
}

/// macOS's name for a signal number.
pub fn signal_name(signal: i32) -> String {
    const NAMES: [&str; 15] = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGEMT", "SIGFPE", "SIGKILL", "SIGBUS", "SIGSEGV", "SIGSYS", "SIGPIPE", "SIGALRM", "SIGTERM"];
    match usize::try_from(signal).ok().and_then(|n| n.checked_sub(1)).and_then(|i| NAMES.get(i)) {
        Some(n) => (*n).to_string(),
        None => format!("signal {signal}"),
    }
}

/// One command of the run, as the report shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCommand {
    /// The command line, scrubbed.
    pub command: String,
    /// The working directory, scrubbed, when the step set one.
    pub cwd: Option<String>,
    /// "exit 1", "SIGSEGV", "could not start: …", "stopped".
    pub ended: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub duration_seconds: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StationLoad {
    pub station: String,
    pub utilisation: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusLine {
    pub severity: String,
    pub text: String,
}

/// `report.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The folder's name: "<timestamp>-<method>".
    pub id: String,
    /// When the report was written, ISO 8601, UTC.
    pub created_at: String,
    pub qnet_version: String,
    pub build_tag: String,
    pub macos_version: String,
    pub chip: String,
    /// The run label ("lp").
    pub method: String,
    /// The display label ("Linear Program").
    pub method_name: String,
    /// The tab's title.
    pub network_title: String,
    pub infinite_buffers: bool,
    pub kind: FailureKind,
    pub exit_code: i32,
    /// The signal that ended a solver ("SIGSEGV"), for `kind` "signal".
    pub signal: Option<String>,
    pub duration_seconds: f64,
    /// Why the result was filed as failed, when it was.
    pub reason: Option<String>,
    /// The method's parameters as the result record keeps them.
    pub settings: BTreeMap<String, String>,
    /// What the parameter sheet changed for this run.
    pub sheet: BTreeMap<String, String>,
    pub seed: Option<u64>,
    /// The failing solver's resolved path, scrubbed.
    pub solver_path: Option<String>,
    /// The record's "runtime" provenance (which library or Python runtime ran), scrubbed.
    pub runtime: Option<String>,
    pub commands: Vec<ReportCommand>,
    /// ρ per station, in export order.
    pub utilisation: Vec<StationLoad>,
    /// The run's Status lines, scrubbed.
    pub status_lines: Vec<StatusLine>,
    /// The input files kept beside this file ("input.in", "input-2.in").
    pub input_files: Vec<String>,
    /// Input files that were left out (too large, or gone), by their original names.
    pub inputs_omitted: Vec<String>,
    /// Why input files were left out, when some were.
    #[serde(default)]
    pub inputs_note: Option<String>,
}

/// A report as the page reads it: `report.json`, the tails, and where the folder is.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedReport {
    #[serde(flatten)]
    pub report: Report,
    /// The last lines of the run's output, scrubbed.
    pub output_tail: String,
    /// The last lines of the solvers' stderr, scrubbed.
    pub stderr_tail: String,
    /// The folder, with `~` for the home folder.
    pub folder: String,
}

/// The failure's kind and, for a crash, its signal.
pub fn classify(f: &Failure) -> (FailureKind, Option<i32>) {
    if f.internal {
        return (FailureKind::Internal, None);
    }
    let crashed = f.steps.iter().rev().find_map(|s| match s.exit {
        Some(ExitKind::Signaled(n)) if !s.interrupted => Some(n),
        _ => None,
    });
    if f.exit_code == 0 {
        return (FailureKind::Unparsed, None);
    }
    if let Some(n) = crashed {
        return (FailureKind::Signal, Some(n));
    }
    if f.exit_code == -1 {
        let could_not_start = f.steps.iter().any(|s| s.spawn_error.is_some()) || f.status_lines.iter().any(|(_, t)| t.contains("could not start"));
        return (if could_not_start { FailureKind::CouldNotStart } else { FailureKind::Internal }, None);
    }
    // A shell's status for a signal, when no step record says so itself.
    if f.steps.is_empty() && (129..=128 + 31).contains(&f.exit_code) {
        return (FailureKind::Signal, Some(f.exit_code - 128));
    }
    (FailureKind::Exit, None)
}

/// One word of a command line, quoted when a shell would need it.
fn shell_word(arg: &OsString) -> String {
    let s = arg.to_string_lossy();
    let plain = !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:,+@%$~".contains(c));
    if plain {
        s.into_owned()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

fn command_of(step: &StepRecord, env: &Environment) -> ReportCommand {
    let mut words = vec![shell_word(&step.program.clone().into_os_string())];
    words.extend(step.args.iter().map(shell_word));
    let (ended, exit_code, signal) = match (&step.spawn_error, step.exit) {
        (Some(e), _) => (format!("could not start: {}", env.scrub(e)), None, None),
        (None, Some(ExitKind::Exited(c))) => (format!("exit {c}"), Some(c), None),
        (None, Some(ExitKind::Signaled(n))) => (if step.interrupted { format!("stopped ({})", signal_name(n)) } else { signal_name(n) }, None, Some(signal_name(n))),
        (None, Some(ExitKind::NotStarted)) => ("not started".to_string(), None, None),
        (None, Some(ExitKind::Abandoned)) => ("given up on after Stop".to_string(), None, None),
        (None, None) => ("unknown".to_string(), None, None),
    };
    ReportCommand {
        command: env.scrub(&words.join(" ")),
        cwd: step.cwd.as_ref().map(|c| env.scrub(&c.to_string_lossy())),
        ended,
        exit_code,
        signal,
        duration_seconds: step.elapsed.as_secs_f64(),
    }
}

/// The step that failed: the last one that crashed, could not start or exited non-zero, else the last.
fn failing_step(steps: &[StepRecord]) -> Option<&StepRecord> {
    steps
        .iter()
        .rev()
        .find(|s| !s.interrupted && (s.spawn_error.is_some() || matches!(s.exit, Some(ExitKind::Signaled(_))) || matches!(s.exit, Some(ExitKind::Exited(c)) if c != 0)))
        .or(steps.last())
}

/// What a terminal would be left showing of `bytes`: each line after its last carriage return,
/// without colour and cursor escapes.
fn shown_lines(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    text.split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let line = line.rsplit('\r').next().unwrap_or(line);
            let mut out = String::with_capacity(line.len());
            let mut chars = line.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\x1b' && chars.peek() == Some(&'[') {
                    chars.next();
                    for d in chars.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                } else if c != '\x1b' {
                    out.push(c);
                }
            }
            out
        })
        .collect()
}

/// Where the last `lines` lines of `bytes` begin (0 when there are no more than that).
fn last_lines_start(bytes: &[u8], lines: usize) -> usize {
    let mut seen = 0;
    for (i, b) in bytes.iter().enumerate().rev() {
        if *b == b'\n' {
            seen += 1;
            if seen > lines {
                return i + 1;
            }
        }
    }
    0
}

/// The last `n` lines of `bytes` as shown, ending in a newline when there are any. Only the end
/// of `bytes` is read: a window of lines found from the back, widened while blank lines at the
/// end leave it short.
pub fn tail(bytes: &[u8], n: usize) -> String {
    let mut window = n + 8;
    loop {
        let start = last_lines_start(bytes, window);
        let mut lines = shown_lines(&bytes[start..]);
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.pop();
        }
        if start > 0 && lines.len() < n {
            window = window.saturating_mul(4);
            continue;
        }
        let from = lines.len().saturating_sub(n);
        let mut out = lines[from..].join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        return out;
    }
}

/// "20261112-143005" (UTC) for a Unix time.
pub fn timestamp(unix_seconds: u64) -> String {
    let (y, mo, d, h, mi, s) = civil(unix_seconds);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

fn iso8601(unix_seconds: u64) -> String {
    let (y, mo, d, h, mi, s) = civil(unix_seconds);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// The UTC calendar date and time of a Unix time (Howard Hinnant's days-to-civil).
fn civil(unix_seconds: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (unix_seconds / 86_400) as i64;
    let rem = (unix_seconds % 86_400) as u32;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// A report id: one folder name of letters, digits, `-` and `_`.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 120 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A name [`reserve`] makes, exactly: "<8 digits>-<6 digits>-<label of 1 to 40 letters, digits
/// and `_`>", then "-<n>" for a second report of the same second.
fn written_id(name: &str) -> bool {
    let b = name.as_bytes();
    let digits = |s: &[u8]| !s.is_empty() && s.iter().all(u8::is_ascii_digit);
    if b.len() < 17 || !digits(&b[..8]) || b[8] != b'-' || !digits(&b[9..15]) || b[15] != b'-' {
        return false;
    }
    let rest = &name[16..];
    let (label, counter) = match rest.split_once('-') {
        Some((l, c)) => (l, Some(c)),
        None => (rest, None),
    };
    (1..=40).contains(&label.len()) && label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') && counter.is_none_or(|c| digits(c.as_bytes()))
}

fn safe_label(label: &str) -> String {
    let s: String = label.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).take(40).collect();
    if s.is_empty() {
        "run".to_string()
    } else {
        s
    }
}

/// "input.in", then "input-2.in"…: the kept name of the `index`th input (from 0), with the
/// original file's extension.
fn input_name(index: usize, original: &str) -> String {
    let ext = Path::new(original).extension().and_then(|e| e.to_str()).filter(|e| !e.is_empty() && e.len() <= 12 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("txt");
    if index == 0 {
        format!("input.{ext}")
    } else {
        format!("input-{}.{ext}", index + 1)
    }
}

/// A report whose folder is made and whose id is known, not written yet.
#[derive(Debug)]
pub struct Pending {
    reports_dir: PathBuf,
    id: String,
    unix_seconds: u64,
}

/// Makes a report's folder under `reports_dir` and so settles its id. Until [`Pending::write`]
/// ends, [`load`] says the report is still being written.
pub fn reserve(reports_dir: &Path, method: &str, unix_seconds: u64) -> Result<Pending, String> {
    std::fs::create_dir_all(reports_dir).map_err(|e| e.to_string())?;
    let base = format!("{}-{}", timestamp(unix_seconds), safe_label(method));
    let mut id = base.clone();
    let mut n = 1;
    // `create_dir` fails on a name that is taken, whatever holds it.
    loop {
        match std::fs::create_dir(reports_dir.join(&id)) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 10_000 => {
                n += 1;
                id = format!("{base}-{n}");
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(Pending { reports_dir: reports_dir.to_path_buf(), id, unix_seconds })
}

impl Pending {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Writes the report and prunes old ones. A report that cannot be written leaves no folder.
    pub fn write(self, f: &Failure, env: &Environment) -> Result<Report, String> {
        let dir = self.reports_dir.join(&self.id);
        let written = write_into(&dir, self.id.clone(), f, env, self.unix_seconds);
        match &written {
            Ok(_) => prune(&self.reports_dir, KEEP, Some(&self.id)),
            Err(_) => {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
        written
    }
}

/// Writes the report's folder under `reports_dir` and prunes old reports. Returns the report.
#[cfg(test)]
pub fn write(reports_dir: &Path, f: &Failure, env: &Environment, unix_seconds: u64) -> Result<Report, String> {
    reserve(reports_dir, &f.method, unix_seconds)?.write(f, env)
}

fn write_into(dir: &Path, id: String, f: &Failure, env: &Environment, unix_seconds: u64) -> Result<Report, String> {
    let (kind, signal) = classify(f);
    let mut input_files = Vec::new();
    let mut inputs_omitted = Vec::new();
    let (mut total, mut over) = (0u64, false);
    for (original, source) in &f.inputs {
        let size = match source {
            InputSource::File(p) => std::fs::symlink_metadata(p).ok().filter(|m| m.is_file()).map(|m| m.len()),
            InputSource::Gone => None,
        };
        let fits = size.is_some_and(|n| n <= INPUT_LIMIT && total + n <= INPUT_TOTAL_LIMIT);
        over |= size.is_some() && !fits;
        let name = input_name(input_files.len(), original);
        let kept = fits
            && match source {
                InputSource::File(p) => std::fs::copy(p, dir.join(&name)).is_ok(),
                InputSource::Gone => false,
            };
        if kept {
            total += size.unwrap_or(0);
            input_files.push(name);
        } else {
            let _ = std::fs::remove_file(dir.join(&name));
            inputs_omitted.push(original.clone());
        }
    }
    let inputs_note = (!inputs_omitted.is_empty()).then(|| {
        if over {
            format!("Some input files were left out: a report keeps files of up to {} MiB each and {} MiB together.", INPUT_LIMIT >> 20, INPUT_TOTAL_LIMIT >> 20)
        } else {
            "Some input files were left out: they could not be copied.".to_string()
        }
    });
    std::fs::write(dir.join("network.bnet"), &f.network).map_err(|e| e.to_string())?;

    let with_stderr: Vec<&StepRecord> = f.steps.iter().filter(|s| !s.stderr.is_empty()).collect();
    let mut stderr = String::new();
    for s in &with_stderr {
        if with_stderr.len() > 1 {
            let name = s.program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            stderr.push_str(&format!("── {name} ──\n"));
        }
        let text = env.scrub(&String::from_utf8_lossy(&s.stderr));
        stderr.push_str(&text);
        if !text.ends_with('\n') {
            stderr.push('\n');
        }
    }
    std::fs::write(dir.join("stderr.txt"), &stderr).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("output-tail.txt"), env.scrub(&tail(&f.archive, TAIL_LINES))).map_err(|e| e.to_string())?;

    let report = Report {
        id,
        created_at: iso8601(unix_seconds),
        qnet_version: env.qnet_version.clone(),
        build_tag: env.build_tag.clone(),
        macos_version: env.macos_version.clone(),
        chip: env.chip.clone(),
        method: f.method.clone(),
        method_name: f.method_name.clone(),
        network_title: f.title.clone(),
        infinite_buffers: f.infinite_buffers,
        kind,
        exit_code: f.exit_code,
        signal: signal.map(signal_name),
        duration_seconds: f.duration_seconds,
        reason: f.reason.as_deref().map(|r| env.scrub(r)),
        settings: f.parameters.iter().filter(|(k, v)| k.as_str() != "runtime" && reportable(k, v)).map(|(k, v)| (k.clone(), v.clone())).collect(),
        sheet: f.overrides.iter().filter(|(k, v)| reportable(k, v)).map(|(k, v)| (k.clone(), v.clone())).collect(),
        seed: f.seed,
        solver_path: failing_step(&f.steps).map(|s| env.scrub(&s.program.to_string_lossy())),
        runtime: f.parameters.get("runtime").map(|r| env.scrub(r)),
        commands: f.steps.iter().map(|s| command_of(s, env)).collect(),
        utilisation: f.utilisation.iter().map(|(station, rho)| StationLoad { station: station.clone(), utilisation: *rho }).collect(),
        status_lines: f.status_lines.iter().map(|(severity, text)| StatusLine { severity: severity.clone(), text: env.scrub(text) }).collect(),
        input_files,
        inputs_omitted,
        inputs_note,
    };
    // Every string of `report.json` is scrubbed here, whichever field it is in.
    let value = env.scrub_json(serde_json::to_value(&report).map_err(|e| e.to_string())?);
    let report: Report = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    // Under another name first: `report.json` is there only once it is whole.
    let unfinished = dir.join("report.json.part");
    std::fs::write(&unfinished, json + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&unfinished, dir.join("report.json")).map_err(|e| e.to_string())?;
    Ok(report)
}

/// The report folders in `reports_dir`, newest first (their names start with the timestamp):
/// real folders (never a symbolic link) whose name is exactly one this code makes.
pub fn list(reports_dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(reports_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| written_id(n) && std::fs::symlink_metadata(reports_dir.join(n)).is_ok_and(|m| m.is_dir()))
        .collect();
    ids.sort_by(|a, b| b.cmp(a));
    ids
}

/// Deletes every report but the newest `keep`, and never `spare` (the report just written, which
/// sorts as old when the clock was set back). Only report folders are touched.
pub fn prune(reports_dir: &Path, keep: usize, spare: Option<&str>) {
    for old in list(reports_dir).into_iter().skip(keep) {
        let dir = reports_dir.join(&old);
        // Looked at again just before deleting: a link is never followed.
        if spare != Some(old.as_str()) && std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Reads a report back.
pub fn load(reports_dir: &Path, id: &str, home: Option<&Path>) -> Result<LoadedReport, QnError> {
    if !valid_id(id) {
        return Err(QnError::invalid("That is not a failure report's name."));
    }
    let dir = reports_dir.join(id);
    let text = std::fs::read_to_string(dir.join("report.json")).map_err(|_| {
        if dir.is_dir() {
            // Reserved, and its files are on their way (`Pending::write`); the panel asks again.
            QnError::new(ErrorKind::Unavailable, STILL_WRITING)
        } else {
            QnError::new(ErrorKind::NotFound, "That failure report is no longer there. Qnet keeps the newest 20.")
        }
    })?;
    let report: Report = serde_json::from_str(&text).map_err(|e| QnError::failed("Qnet couldn't read that failure report.").with_detail(e.to_string()))?;
    let read = |name: &str| std::fs::read(dir.join(name)).map(|b| tail(&b, TAIL_LINES)).unwrap_or_default();
    Ok(LoadedReport { report, output_tail: read("output-tail.txt"), stderr_tail: read("stderr.txt"), folder: tilde(&dir, home) })
}

/// `path` with `~` for the home folder.
pub fn tilde(path: &Path, home: Option<&Path>) -> String {
    match home.and_then(|h| path.strip_prefix(h).ok()) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// What Reveal in Finder selects: a report's folder, or the reports folder itself (made if it
/// isn't there yet), and whether Finder should select it (`open -R`) or open it.
pub fn reveal_target(reports_dir: &Path, id: Option<&str>) -> Result<(PathBuf, bool), QnError> {
    match id {
        Some(id) => {
            if !valid_id(id) {
                return Err(QnError::invalid("That is not a failure report's name."));
            }
            let dir = reports_dir.join(id);
            if !dir.is_dir() {
                return Err(QnError::new(ErrorKind::NotFound, "That failure report is no longer there. Qnet keeps the newest 20."));
            }
            Ok((dir, true))
        }
        None => {
            std::fs::create_dir_all(reports_dir).map_err(|e| QnError::failed("Qnet couldn't make its failure reports folder.").with_detail(e.to_string()))?;
            Ok((reports_dir.to_path_buf(), false))
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────

fn reports_dir(runs: &Runs) -> Result<PathBuf, QnError> {
    runs.reports_dir.clone().ok_or_else(|| QnError::new(ErrorKind::Unavailable, "Failure reports are not kept in this session."))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// A failure report, for the Show Report… panel.
#[tauri::command]
pub fn report_get(runs: State<'_, Runs>, id: String) -> Result<LoadedReport, QnError> {
    load(&reports_dir(&runs)?, &id, home().as_deref())
}

/// Reveal in Finder: a report's folder (selected), or with no id the reports folder (opened):
/// Help ▸ Show Failure Reports…. Resolves to the folder, with `~` for the home folder.
#[tauri::command]
pub fn reports_reveal(runs: State<'_, Runs>, id: Option<String>) -> Result<String, QnError> {
    let (path, select) = reveal_target(&reports_dir(&runs)?, id.as_deref())?;
    let mut open = std::process::Command::new("/usr/bin/open");
    if select {
        open.arg("-R");
    }
    open.arg(&path).spawn().map_err(|e| QnError::failed("Qnet couldn't ask Finder to show the folder.").with_detail(e.to_string()))?;
    Ok(tilde(&path, home().as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qnet-reports-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn env() -> Environment {
        Environment {
            qnet_version: "2.0.0".into(),
            build_tag: "test".into(),
            macos_version: "15.5".into(),
            chip: "Apple M3 Ultra".into(),
            bundle: Some(PathBuf::from("/Users/student/Applications/Qnet.app")),
            temp_dir: Some(PathBuf::from("/var/folders/ab/T")),
            home: Some(PathBuf::from("/Users/student")),
        }
    }

    fn step(exit: ExitKind, stderr: &str) -> StepRecord {
        StepRecord {
            program: PathBuf::from("/Users/student/Applications/Qnet.app/Contents/Resources/bin/BNAlp/srbm_lp"),
            args: vec!["--input".into(), "/var/folders/ab/T/BNET_lp_77_s0.in".into(), "--note".into(), "two words".into()],
            cwd: Some(PathBuf::from("/private/var/folders/ab/T/BNET_lp_csv_77")),
            exit: Some(exit),
            spawn_error: None,
            interrupted: false,
            elapsed: Duration::from_millis(1500),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    /// A file holding `bytes`, as a report's input. Every call writes a file of its own: tests
    /// run in parallel, and a file shared by name was truncated by one test's `failure()` while
    /// another test's report was copying it (an empty `input-2.in`, seen under load).
    fn input(name: &str, bytes: &[u8]) -> (String, InputSource) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("qnet-reports-fixture-{}", std::process::id())).join(n.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), bytes).unwrap();
        (name.to_string(), InputSource::File(dir.join(name)))
    }

    fn failure() -> Failure {
        Failure {
            method: "lp".into(),
            method_name: "Linear Program".into(),
            title: "2dtandem.bnet".into(),
            exit_code: 1,
            duration_seconds: 12.25,
            parameters: [("grid size", "12"), ("runtime", "bundled: /Users/student/Applications/Qnet.app/Contents/Resources/bin/BNAlp/srbm_lp")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            overrides: [("lp.gridN".to_string(), "12".to_string())].into_iter().collect(),
            infinite_buffers: true,
            utilisation: vec![("S1".into(), 0.7), ("S2".into(), 1.05)],
            steps: vec![step(ExitKind::Exited(1), "srbm_lp: out of memory\nsee /Users/student/notes\n")],
            status_lines: vec![("info".into(), "Running Linear Program (BNAlp)...".into()), ("error".into(), "Linear Program failed (exit 1) after 12 s".into())],
            inputs: vec![input("BNET_lp_77_s0.in", b"d 2\n"), input("BNET_lp_77_s1.in", b"d 2\nn 12\n"), ("huge.in".into(), InputSource::Gone)],
            network: "{\"nodes\":[],\"links\":[]}".into(),
            archive: (1..=300).map(|i| format!("line {i}\n")).collect::<String>().into_bytes(),
            ..Failure::default()
        }
    }

    #[test]
    fn a_report_holds_what_was_run_and_how_it_ended() {
        let dir = temp("contents");
        let r = write(&dir, &failure(), &env(), 1_794_493_805).unwrap();
        assert_eq!(r.id, "20261112-143005-lp");
        let folder = dir.join(&r.id);
        let names = {
            let mut n: Vec<String> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            n.sort();
            n
        };
        assert_eq!(names, ["input-2.in", "input.in", "network.bnet", "output-tail.txt", "report.json", "stderr.txt"]);
        // The inputs and the network are byte for byte.
        assert_eq!(std::fs::read(folder.join("input.in")).unwrap(), b"d 2\n");
        assert_eq!(std::fs::read(folder.join("input-2.in")).unwrap(), b"d 2\nn 12\n");
        assert_eq!(std::fs::read_to_string(folder.join("network.bnet")).unwrap(), "{\"nodes\":[],\"links\":[]}");
        // The last 200 lines of the output.
        let out = std::fs::read_to_string(folder.join("output-tail.txt")).unwrap();
        assert_eq!(out.lines().count(), 200);
        assert!(out.starts_with("line 101\n") && out.ends_with("line 300\n"));

        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(folder.join("report.json")).unwrap()).unwrap();
        assert_eq!(json["qnetVersion"], "2.0.0");
        assert_eq!(json["macosVersion"], "15.5");
        assert_eq!(json["chip"], "Apple M3 Ultra");
        assert_eq!(json["method"], "lp");
        assert_eq!(json["methodName"], "Linear Program");
        assert_eq!(json["kind"], "exit");
        assert_eq!(json["exitCode"], 1);
        assert_eq!(json["signal"], serde_json::Value::Null);
        assert_eq!(json["durationSeconds"], 12.25);
        assert_eq!(json["settings"]["grid size"], "12");
        assert_eq!(json["sheet"]["lp.gridN"], "12");
        assert_eq!(json["createdAt"], "2026-11-12T14:30:05Z");
        // Paths: relative to the bundle, $TMPDIR, and never the home folder.
        assert_eq!(json["commands"][0]["command"], "Contents/Resources/bin/BNAlp/srbm_lp --input $TMPDIR/BNET_lp_77_s0.in --note 'two words'");
        assert_eq!(json["commands"][0]["cwd"], "$TMPDIR/BNET_lp_csv_77");
        assert_eq!(json["commands"][0]["ended"], "exit 1");
        assert_eq!(json["solverPath"], "Contents/Resources/bin/BNAlp/srbm_lp");
        assert_eq!(json["runtime"], "bundled: Contents/Resources/bin/BNAlp/srbm_lp");
        assert_eq!(json["inputFiles"], serde_json::json!(["input.in", "input-2.in"]));
        assert_eq!(json["inputsOmitted"], serde_json::json!(["huge.in"]));
        assert_eq!(json["inputsNote"], "Some input files were left out: they could not be copied.");
        assert_eq!(json["utilisation"][1]["station"], "S2");
        for file in ["report.json", "stderr.txt", "output-tail.txt"] {
            let text = std::fs::read_to_string(folder.join(file)).unwrap();
            assert!(!text.contains("/Users/student"), "{file} names the home folder: {text}");
        }
        assert_eq!(std::fs::read_to_string(folder.join("stderr.txt")).unwrap(), "srbm_lp: out of memory\nsee ~/notes\n");

        // Read back for the panel.
        let loaded = load(&dir, &r.id, Some(Path::new("/nowhere"))).unwrap();
        assert_eq!(loaded.report, r);
        assert_eq!(loaded.stderr_tail, "srbm_lp: out of memory\nsee ~/notes\n");
        assert!(loaded.output_tail.ends_with("line 300\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fixture itself under parallel tests: while other threads build failures (as every
    /// test here does), a report's copied inputs are whole. With one fixture file per name this
    /// failed within a few hundred rounds: `std::fs::write` truncates before it writes.
    #[test]
    fn fixtures_built_in_parallel_do_not_disturb_a_report_being_written() {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let others: Vec<_> = (0..4)
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        let _ = failure();
                    }
                })
            })
            .collect();
        let dir = temp("parallel-fixtures");
        for i in 0..300u64 {
            let r = write(&dir, &failure(), &env(), 1_794_493_805 + i).unwrap();
            let folder = dir.join(&r.id);
            assert_eq!(std::fs::read(folder.join("input.in")).unwrap(), b"d 2\n", "round {i}");
            assert_eq!(std::fs::read(folder.join("input-2.in")).unwrap(), b"d 2\nn 12\n", "round {i}");
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        others.into_iter().for_each(|t| t.join().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_crash_is_named_by_its_signal_and_other_ends_by_their_kind() {
        let mut f = failure();
        f.exit_code = 139;
        f.steps = vec![step(ExitKind::Exited(0), ""), step(ExitKind::Signaled(11), "")];
        assert_eq!(classify(&f), (FailureKind::Signal, Some(11)));
        let dir = temp("signal");
        let r = write(&dir, &f, &env(), 0).unwrap();
        assert_eq!((r.kind, r.signal.as_deref()), (FailureKind::Signal, Some("SIGSEGV")));
        assert_eq!(r.commands[1].ended, "SIGSEGV");
        let _ = std::fs::remove_dir_all(&dir);

        // A signal Stop sent is not a crash.
        let mut stopped = step(ExitKind::Signaled(2), "");
        stopped.interrupted = true;
        f.steps = vec![stopped];
        f.exit_code = 1;
        assert_eq!(classify(&f).0, FailureKind::Exit);
        // No step record: the shell's 128 + signal.
        f.steps.clear();
        f.exit_code = 134;
        assert_eq!(classify(&f), (FailureKind::Signal, Some(6)));
        assert_eq!(signal_name(6), "SIGABRT");
        assert_eq!(signal_name(99), "signal 99");

        // Could not start: the supervisor's exit −1 with its sentence, or a spawn error.
        f.exit_code = -1;
        f.status_lines = vec![("error".into(), "Linear Program could not start: No such file or directory (os error 2)".into())];
        assert_eq!(classify(&f).0, FailureKind::CouldNotStart);
        f.status_lines.clear();
        assert_eq!(classify(&f).0, FailureKind::Internal);
        let mut unspawned = step(ExitKind::Exited(0), "");
        unspawned.exit = None;
        unspawned.spawn_error = Some("Permission denied (os error 13)".into());
        f.steps = vec![unspawned];
        assert_eq!(classify(&f).0, FailureKind::CouldNotStart);
        assert_eq!(command_of(&f.steps[0], &env()).ended, "could not start: Permission denied (os error 13)");

        // Exit 0 with a result filed as failed: the output could not be used.
        f.exit_code = 0;
        f.steps.clear();
        assert_eq!(classify(&f).0, FailureKind::Unparsed);
        f.internal = true;
        assert_eq!(classify(&f).0, FailureKind::Internal);
    }

    #[test]
    fn the_newest_twenty_reports_are_kept() {
        let dir = temp("retention");
        std::fs::write(dir.join("notes.txt"), "the user's own file").unwrap();
        std::fs::create_dir(dir.join("kept by the user")).unwrap();
        let mut ids = Vec::new();
        for i in 0..23u64 {
            ids.push(write(&dir, &failure(), &env(), 1_794_493_805 + i * 60).unwrap().id);
        }
        let left = list(&dir);
        assert_eq!(left.len(), KEEP);
        // Newest first; the three oldest are gone.
        assert_eq!(left[0], ids[22]);
        assert_eq!(left[19], ids[3]);
        for gone in &ids[..3] {
            assert!(!dir.join(gone).exists());
        }
        // Nothing that isn't a report is touched.
        assert!(dir.join("notes.txt").exists() && dir.join("kept by the user").exists());
        // Two failures in the same second get folders of their own.
        let a = write(&dir, &failure(), &env(), 2_000_000_000).unwrap().id;
        let b = write(&dir, &failure(), &env(), 2_000_000_000).unwrap().id;
        assert_eq!(b, format!("{a}-2"));
        assert_eq!(list(&dir).len(), KEEP);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tails_show_what_a_terminal_would_and_ids_are_one_folder_name() {
        assert_eq!(tail(b"a\n\x1b[7m \x1b[27m [|]  0.2s\r\x1b[K[done]  0.4s\nlast\n\n", 2), "[done]  0.4s\nlast\n");
        assert_eq!(tail(b"", 200), "");
        let dir = temp("ids");
        assert_eq!(load(&dir, "../etc", None).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(load(&dir, "20260101-000000-qna", None).unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(reveal_target(&dir, Some("a/b")).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(reveal_target(&dir, Some("20260101-000000-qna")).unwrap_err().kind, ErrorKind::NotFound);
        let sub = dir.join("reports");
        assert_eq!(reveal_target(&sub, None).unwrap(), (sub.clone(), false));
        assert!(sub.is_dir());
        assert_eq!(tilde(Path::new("/Users/student/Library/x"), Some(Path::new("/Users/student"))), "~/Library/x");
        assert_eq!(timestamp(0), "19700101-000000");
        assert_eq!(input_name(0, "BNET_qna_1.qna"), "input.qna");
        assert_eq!(input_name(2, "noext"), "input-3.txt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End to end through `runs::start`: a solver that crashes (a stand-in script that sends
    /// itself SIGSEGV) leaves a report, announced before `finished`, with the run's real input.
    #[test]
    fn a_run_whose_solver_crashes_leaves_a_report_and_says_so_before_it_finishes() {
        use crate::runs::{start, RunMessage, StartRequest};
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{Arc, Mutex};

        let _turn = crate::runs::TEST_TURN.lock().unwrap_or_else(|p| p.into_inner());
        let dir = temp("e2e");
        let solver = dir.join("root/bin/BNAqna/bna_qna");
        std::fs::create_dir_all(solver.parent().unwrap()).unwrap();
        std::fs::write(&solver, "#!/bin/sh\n[ -n \"$QNET_RUNTIME_PROBE\" ] && exit 0\necho 'bna_qna: singular traffic-rate matrix' >&2\nkill -SEGV $$\n").unwrap();
        std::fs::set_permissions(&solver, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut cfg = qnet_runner::resolver::ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.development_roots = Vec::new();
        cfg.env.insert("QNET_SOLVER_ROOT".into(), dir.join("root").into_os_string());
        let mut runs = Runs::with_resolver(dir.join("results-v1.json"), Arc::new(qnet_runner::resolver::Resolver::new(cfg)));
        runs.reports_dir = Some(dir.join("reports"));

        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/10stationtandem.inf.bnet");
        let document: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(example).unwrap()).unwrap();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let sink = messages.clone();
        let request = StartRequest {
            tab_id: "0A0A0A0A-0000-4000-8000-000000000001".into(),
            title: "10stationtandem.inf.bnet".into(),
            document: document.clone(),
            method: "qna".into(),
            settings: BTreeMap::new(),
            overrides: BTreeMap::new(),
            source_path: None,
        };
        // Whether the report's files were there when `finished` was sent.
        let written_at_finish = Arc::new(Mutex::new(None));
        let (seen, reports) = (written_at_finish.clone(), dir.join("reports"));
        let emit = move |m: RunMessage| {
            let mut all = sink.lock().unwrap();
            if matches!(m, RunMessage::Finished { .. }) {
                let id = all.iter().find_map(|m| match m {
                    RunMessage::Report { id, .. } => Some(id.clone()),
                    _ => None,
                });
                *seen.lock().unwrap() = id.map(|id| (reports.join(&id).is_dir(), reports.join(&id).join("report.json").exists(), load(&reports, &id, None).map(|_| ()).map_err(|e| (e.kind, e.message))));
            }
            all.push(m);
        };
        let (outcome, finisher) = start(&runs, request, Arc::new(emit), Arc::new(|_| {})).unwrap();
        assert!(outcome.started);
        finisher.unwrap().join().unwrap();

        let messages = messages.lock().unwrap().clone();
        let at = messages.iter().position(|m| matches!(m, RunMessage::Report { .. })).expect("a report message");
        let end = messages.iter().position(|m| matches!(m, RunMessage::Finished { .. })).expect("a finished message");
        assert!(at < end, "the report is announced before the run's end");
        let RunMessage::Report { id, status_text } = &messages[at] else { unreachable!() };
        let RunMessage::Finished { summary, exit_code, succeeded, user_stopped, .. } = &messages[end] else { unreachable!() };
        assert_eq!((*exit_code, *succeeded, *user_stopped), (139, false, false));
        // The line that gains "Show Report…" is the failure line the tab was sent, unchanged.
        assert_eq!(status_text.as_deref(), Some(summary.as_str()));
        assert!(summary.starts_with("QNA failed (exit 139) after "), "{summary}");
        assert!(messages[..at].iter().any(|m| matches!(m, RunMessage::Status { text, severity } if text == summary && *severity == "error")));

        // `finished` did not wait for the report: its folder was reserved, its files were not
        // written yet, and the panel would have been told so.
        assert_eq!(*written_at_finish.lock().unwrap(), Some((true, false, Err((ErrorKind::Unavailable, STILL_WRITING.to_string())))));
        // The links that kept the input are gone with the run.
        let staged = std::fs::read_dir(std::env::temp_dir()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(&format!("qnet_report_inputs_{}_", std::process::id()))).count();
        assert_eq!(staged, 0);

        let loaded = load(&dir.join("reports"), id, None).unwrap();
        let r = &loaded.report;
        assert!(id.ends_with("-qna"));
        assert_eq!((r.kind, r.signal.as_deref(), r.exit_code), (FailureKind::Signal, Some("SIGSEGV"), 139));
        assert_eq!((r.method.as_str(), r.method_name.as_str(), r.infinite_buffers), ("qna", "QNA", true));
        assert_eq!(r.qnet_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(r.commands.len(), 1);
        assert!(r.commands[0].command.starts_with("$TMPDIR/") && r.commands[0].command.contains("/root/bin/BNAqna/bna_qna "), "{}", r.commands[0].command);
        assert_eq!(r.commands[0].ended, "SIGSEGV");
        assert_eq!(r.solver_path.as_deref().map(|p| p.ends_with("/root/bin/BNAqna/bna_qna")), Some(true));
        assert_eq!(r.utilisation.len(), 10);
        assert!(r.status_lines.iter().any(|l| l.text == "bna_qna: singular traffic-rate matrix"));
        assert_eq!(loaded.stderr_tail, "bna_qna: singular traffic-rate matrix\n");
        // The solver's input, kept although the run removed its own copy, and the document as run.
        let folder = dir.join("reports").join(id);
        assert_eq!(r.input_files, ["input.qna"]);
        let input = std::fs::read_to_string(folder.join("input.qna")).unwrap();
        assert!(input.len() > 100, "{input}");
        let kept: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(folder.join("network.bnet")).unwrap()).unwrap();
        assert_eq!(kept, document);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pruning_touches_only_folders_this_code_names_and_never_the_report_just_written() {
        use std::os::unix::fs::symlink;
        let dir = temp("prune");
        // The user's own: names that only resemble a report's, and a link named exactly like one.
        let own = ["2024_backup", "20240101-120000", "20240101-1200-lp", "20240101-120000-lp-old", "20240101-120000-lp-2-3", "2024-01-01-lp", "20240101-120000-"];
        for name in own {
            std::fs::create_dir(dir.join(name)).unwrap();
            std::fs::write(dir.join(name).join("mine.txt"), "mine").unwrap();
        }
        let elsewhere = temp("prune-elsewhere");
        std::fs::write(elsewhere.join("mine.txt"), "mine").unwrap();
        symlink(&elsewhere, dir.join("19990101-000000-lp")).unwrap();
        for name in ["20240101-120000-lp", "20240101-120000-inf_cmp-2", "19700101-000000-a"] {
            assert!(written_id(name), "{name}");
        }
        for name in own {
            assert!(!written_id(name), "{name}");
        }

        for i in 0..(KEEP as u64 + 3) {
            write(&dir, &failure(), &env(), 1_794_493_805 + i * 60).unwrap();
        }
        assert_eq!(list(&dir).len(), KEEP);
        for name in own {
            assert!(dir.join(name).join("mine.txt").exists(), "{name} was deleted");
        }
        assert!(std::fs::symlink_metadata(dir.join("19990101-000000-lp")).unwrap().file_type().is_symlink());
        assert!(elsewhere.join("mine.txt").exists());

        // The clock set back: the new report sorts as the oldest of 21, and is the one kept.
        let late = write(&dir, &failure(), &env(), 1_000_000_000).unwrap();
        assert!(dir.join(&late.id).join("report.json").exists(), "the report just written was pruned");
        assert_eq!(load(&dir, &late.id, None).unwrap().report, late);
        // The next report takes the surplus away again.
        write(&dir, &failure(), &env(), 1_794_493_805 + 3_600).unwrap();
        assert_eq!(list(&dir).len(), KEEP);
        assert!(!dir.join(&late.id).exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn inputs_are_linked_not_read_and_a_report_copies_at_most_the_cap() {
        use std::os::unix::fs::MetadataExt;
        let dir = temp("stage");
        let work = dir.join("work");
        std::fs::create_dir_all(work.join("csv")).unwrap();
        // Six sparse inputs of 7 MiB (42 MiB together), one over the per-file limit, a folder
        // and an output that is not written yet.
        let mut paths = Vec::new();
        for i in 0..6 {
            let p = work.join(format!("BNET_{i}.in"));
            let f = std::fs::File::create(&p).unwrap();
            f.set_len(7 << 20).unwrap();
            paths.push(p);
        }
        let big = work.join("BNET_big.in");
        std::fs::File::create(&big).unwrap().set_len(INPUT_LIMIT + 1).unwrap();
        paths.extend([big, work.join("csv"), work.join("results.txt")]);

        let stage = InputStage::link(&paths);
        let inputs = stage.inputs();
        assert_eq!(inputs.len(), 7);
        let staged = work.join(format!("qnet_report_inputs_{}_", std::process::id()));
        let stage_dir = std::fs::read_dir(&work).unwrap().flatten().map(|e| e.path()).find(|p| p.to_string_lossy().starts_with(&*staged.to_string_lossy())).expect("a stage folder beside the inputs");
        // A link, not a copy: the same file under a second name.
        let InputSource::File(link) = &inputs[0].1 else { panic!("{:?}", inputs[0]) };
        assert_eq!(std::fs::metadata(link).unwrap().ino(), std::fs::metadata(&paths[0]).unwrap().ino());
        assert_eq!(std::fs::metadata(link).unwrap().nlink(), 2);
        // The run's own clean-up, then the report.
        for p in &paths[..7] {
            std::fs::remove_file(p).unwrap();
        }
        let mut f = failure();
        f.inputs = inputs;
        let r = write(&dir.join("reports"), &f, &env(), 0).unwrap();
        assert_eq!(r.input_files, ["input.in", "input-2.in", "input-3.in", "input-4.in"]);
        assert_eq!(r.inputs_omitted, ["BNET_4.in", "BNET_5.in", "BNET_big.in"]);
        assert_eq!(r.inputs_note.as_deref(), Some("Some input files were left out: a report keeps files of up to 8 MiB each and 32 MiB together."));
        let folder = dir.join("reports").join(&r.id);
        let kept: u64 = std::fs::read_dir(&folder).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("input")).map(|e| e.metadata().unwrap().len()).sum();
        assert_eq!(kept, 28 << 20);
        // Dropping the stage (every run's end, failed or not) leaves nothing behind.
        drop(stage);
        assert!(!stage_dir.exists());
        assert_eq!(std::fs::read_dir(&work).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect::<Vec<_>>(), ["csv"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reserved_report_is_still_being_written_until_it_is_whole_and_gone_if_it_fails() {
        let dir = temp("pending");
        let pending = reserve(&dir, "inf sm", 1_794_493_805).unwrap();
        assert_eq!(pending.id(), "20261112-143005-inf_sm");
        let e = load(&dir, pending.id(), None).unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (ErrorKind::Unavailable, STILL_WRITING));
        // A second report of the same second, while the first is still pending.
        let second = reserve(&dir, "inf sm", 1_794_493_805).unwrap();
        assert_eq!(second.id(), "20261112-143005-inf_sm-2");
        let id = pending.id().to_string();
        pending.write(&failure(), &env()).unwrap();
        assert_eq!(load(&dir, &id, None).unwrap().report.id, id);
        assert!(!dir.join(&id).join("report.json.part").exists());
        // A report that cannot be written leaves no folder: the panel says it is not there.
        let id = second.id().to_string();
        std::fs::create_dir(dir.join(&id).join("network.bnet")).unwrap();
        assert!(second.write(&failure(), &env()).is_err());
        assert!(!dir.join(&id).exists());
        assert_eq!(load(&dir, &id, None).unwrap_err().kind, ErrorKind::NotFound);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_tail_is_taken_from_the_end_of_the_bytes() {
        // Only the end is looked at: 200 lines of a million begin 8 lines from the window's start.
        let mut big: Vec<u8> = (1..=1_000_000).flat_map(|i| format!("line {i}\n").into_bytes()).collect();
        let start = last_lines_start(&big, TAIL_LINES + 8);
        assert!(big.len() - start < 4096, "{}", big.len() - start);
        assert!(big[start..].starts_with(b"line 999793\n"));
        let t = tail(&big, TAIL_LINES);
        assert_eq!(t.lines().count(), TAIL_LINES);
        assert!(t.starts_with("line 999801\n") && t.ends_with("line 1000000\n"));
        // Blank lines at the end (more than the window's slack) are not counted.
        big.extend(std::iter::repeat_n(&b" \r\n\x1b[K\n"[..], 500).flatten());
        assert_eq!(tail(&big, TAIL_LINES), t);
        // Fewer lines than asked for, no final newline, nothing at all, and a split inside UTF-8.
        assert_eq!(tail(b"a\nb", 5), "a\nb\n");
        assert_eq!(tail(b"\n\n\n", 5), "");
        assert_eq!(last_lines_start(b"a\nb\nc\n", 2), 2);
        assert_eq!(tail("é\nü\nø\n".as_bytes(), 2), "ü\nø\n");
    }

    #[test]
    fn every_string_of_report_json_is_scrubbed_and_only_whole_folders_are() {
        let e = Environment { home: Some(PathBuf::from("/Users/ann")), bundle: None, temp_dir: Some(PathBuf::from("/var/folders/ab/T")), ..env() };
        // Another folder that begins with the home folder's name is not the home folder.
        assert_eq!(e.scrub("/Users/anna/x"), "/Users/anna/x");
        assert_eq!(e.scrub("/Users/ann-old/x /Users/ann_2/x /Users/ann.bak/x /Users/ann2"), "/Users/ann-old/x /Users/ann_2/x /Users/ann.bak/x /Users/ann2");
        assert_eq!(e.scrub("/Users/ann/x"), "~/x");
        assert_eq!(e.scrub("/Users/ann"), "~");
        assert_eq!(e.scrub("cd /Users/ann && ls '/Users/ann' \"/Users/ann\": saved to /Users/ann."), "cd ~ && ls '~' \"~\": saved to ~.");
        assert_eq!(e.scrub("/Users/anna/a:/Users/ann/b:/Users/ann"), "/Users/anna/a:~/b:~");
        assert_eq!(e.scrub("/var/folders/ab/T/x /private/var/folders/ab/T /var/folders/ab/Tmp/x"), "$TMPDIR/x $TMPDIR /var/folders/ab/Tmp/x");

        // Whatever field a path is in: a sheet's answer, a parameter, the title, a station, a
        // Status line's severity, a key.
        let mut f = failure();
        let home = "/Users/student";
        f.title = format!("{home}/Networks/2dtandem.bnet");
        f.method_name = format!("LP at {home}");
        f.overrides = [("lp.output".to_string(), format!("{home}/Documents/out.csv")), (format!("{home}/as a name"), "1".to_string())].into_iter().collect();
        f.parameters.insert("output file".into(), format!("{home}/Documents/out.csv"));
        f.utilisation = vec![(format!("{home}/S1"), 0.5)];
        f.status_lines = vec![(format!("{home}/sev"), format!("wrote {home}/x"))];
        f.reason = Some(format!("could not read {home}/y"));
        let dir = temp("scrub");
        let r = write(&dir, &f, &env(), 0).unwrap();
        let text = std::fs::read_to_string(dir.join(&r.id).join("report.json")).unwrap();
        assert!(!text.contains("/Users/student") && !text.contains("student"), "{text}");
        assert_eq!(r.sheet["lp.output"], "~/Documents/out.csv");
        assert_eq!(r.sheet["~/as a name"], "1");
        assert_eq!(r.settings["output file"], "~/Documents/out.csv");
        assert_eq!(r.network_title, "~/Networks/2dtandem.bnet");
        // What `write` returns is what the file holds.
        assert_eq!(load(&dir, &r.id, None).unwrap().report, r);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_assistants_settings_and_anything_like_a_key_never_reach_a_report() {
        let secret = [
            ("ai.systemPrompt", "You are an assistant embedded in BNET."),
            ("ai.baseURL.anthropic", "https://api.anthropic.com"),
            ("ai.baseURL.openai", "https://api.openai.com/v1"),
            ("ai.model.anthropic", "claude"),
            ("AI.provider", "anthropic"),
            ("apiKey", "abc123"),
            ("openai_api_key", "abc123"),
            ("auth.token", "abc123"),
            ("Authorization", "abc123"),
            ("keychain.item", "abc123"),
            ("password", "hunter2"),
            ("clientSecret", "abc123"),
            ("note", "sk-ant-REDACTED-LOOKALIKE"),
            ("header", "Bearer abc123"),
            ("url", "https://example.invalid/v1?api_key=abc123"),
        ];
        let mut f = failure();
        for (k, v) in secret {
            assert!(!reportable(k, v), "{k}");
            f.overrides.insert(k.to_string(), v.to_string());
            f.parameters.insert(k.to_string(), v.to_string());
        }
        f.overrides.insert("sim.replications".into(), "8".into());
        let dir = temp("secrets");
        let r = write(&dir, &f, &env(), 0).unwrap();
        assert_eq!(r.sheet.keys().collect::<Vec<_>>(), ["lp.gridN", "sim.replications"]);
        assert_eq!(r.settings.keys().collect::<Vec<_>>(), ["grid size"]);
        let text = std::fs::read_to_string(dir.join(&r.id).join("report.json")).unwrap();
        for word in ["ai.", "anthropic", "openai", "abc123", "hunter2", "sk-ant", "Bearer", "embedded in BNET"] {
            assert!(!text.contains(word), "report.json holds {word}: {text}");
        }
        // Every run setting the runner reads may be written.
        for key in ["sim.replications", "sim.seed", "lp.gridN", "mlmc.epsilon", "output.decimals", "engine.qbd", "runCompare.remember", "grid size", "runtime"] {
            assert!(reportable(key, "1"), "{key}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn this_mac_is_described() {
        let e = Environment::detect(Some(Path::new("/Applications/Qnet.app/Contents/Resources")));
        assert_eq!(e.bundle.as_deref(), Some(Path::new("/Applications/Qnet.app")));
        assert!(!e.macos_version.is_empty() && !e.chip.is_empty(), "{e:?}");
        assert_eq!(e.scrub("/Applications/Qnet.app/Contents/MacOS/qnet"), "Contents/MacOS/qnet");
    }
}
