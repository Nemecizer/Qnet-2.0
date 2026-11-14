//! A job: everything one accepted run does, from its first step to its summary. A job runs one or
//! more steps (a comparison runs several solvers one after another) under one Stop token and one
//! clock, feeds everything the run shows to an output sink while keeping the full-precision
//! archive, removes its temporary files however it ends, and reports progress every 500 ms.
//!
//! This replaces 0.90.34's generated wrapper and its bookkeeping (`QnetGUIApp.runScript`,
//! `silentScript`, `withProgress`'s progress-file handling, `commandWithCleanup`'s traps,
//! `TerminalModel.beginRun`'s poller and `finishRun`; ledger RUN-020, RUN-021, RUN-022, RUN-027,
//! RUN-031, RUN-038, RUN-052, RUN-055, INV-052, INV-053, INV-054, LOG-008). The method code (other
//! modules) writes the steps as ordinary Rust in a closure that receives the [`Job`] and returns the
//! run's exit status, as the wrapper's command returned `$?`.
//!
//! Where 0.90.34 used files and traps, 2.0 uses values and guards (D1): the archive is kept in
//! memory instead of a `tee` file; temporary files are registered with a guard that removes them on
//! drop, which also covers Stop and panics (0.90.34 left most native runs' inputs behind, RUN-021
//! Changed); the status inbox is replaced by reporting each step's stderr lines as the step ends.
//! When Stop interrupts a step, the run's exit status is that step's (130 for SIGINT, 143, 137, or
//! 130 for a step Stop prevented), as the wrapper died with the interrupted step, even if the
//! method code carries on and returns something else; later steps are never spawned.

use std::any::Any;
use std::fs;
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use super::cancel::CancelToken;
use super::process::{run_process, ExitKind, ProcessHooks, ProcessOutcome, ProcessSpec};
use super::progress::{progress_fraction, progress_file_path, read_progress, ProgressCount};
use super::registry::{Reporter, RunEvent, RunId, RunOwner, RunRegistry, RunTicket, Severity};
use super::stderr::stderr_report;
use super::summary::{elapsed_footer, RunProgress, RunSummary};

/// How often the job polls its progress files and reports the live state, as 0.90.34's poller did.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

/// Receives the text a run shows, in the order it is produced: the merged stream that 0.90.34's
/// `tee` saw, before any display filter. The display-precision filter (`qnet_core::output`) and the
/// Shell pane sit behind an implementation of this trait.
pub trait OutputSink: Send {
    /// A chunk of the run's output.
    fn write(&mut self, bytes: &[u8]);
    /// The run has ended; nothing more will be written. Release any held tail.
    fn finish(&mut self) {}
}

/// A sink that discards everything (the archive is still kept).
pub struct NullSink;
impl OutputSink for NullSink {
    fn write(&mut self, _bytes: &[u8]) {}
}

/// A sink that appends to a shared buffer; keep a clone of [`CollectSink::buffer`] to read it.
#[derive(Clone, Default)]
pub struct CollectSink {
    /// The bytes written so far.
    pub buffer: Arc<Mutex<Vec<u8>>>,
    /// Set once `finish` has been called.
    pub finished: Arc<Mutex<bool>>,
}
impl OutputSink for CollectSink {
    fn write(&mut self, bytes: &[u8]) {
        self.buffer.lock().unwrap_or_else(|p| p.into_inner()).extend_from_slice(bytes);
    }
    fn finish(&mut self) {
        *self.finished.lock().unwrap_or_else(|p| p.into_inner()) = true;
    }
}

impl<F: FnMut(&[u8]) + Send> OutputSink for F {
    fn write(&mut self, bytes: &[u8]) {
        self(bytes)
    }
}

/// The run's output: the archive it keeps and the sink it feeds.
pub struct JobOutput {
    archive: Vec<u8>,
    sink: Box<dyn OutputSink>,
}

impl JobOutput {
    /// Appends bytes to the archive and passes them to the sink.
    pub fn emit(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.archive.extend_from_slice(bytes);
        self.sink.write(bytes);
    }
    /// Appends text to the archive and passes it to the sink.
    pub fn emit_str(&mut self, text: &str) {
        self.emit(text.as_bytes());
    }
    /// Everything emitted so far, every digit as the solvers printed it.
    pub fn archive(&self) -> &[u8] {
        &self.archive
    }
}

/// Temporary files and folders that must not outlive a run. Each registered path is removed when
/// the guard is dropped, whether the run finished, failed, was stopped or panicked. Paths that do
/// not exist are skipped silently.
#[derive(Debug, Default)]
pub struct TempFiles {
    paths: Vec<PathBuf>,
}

impl TempFiles {
    /// An empty guard.
    pub fn new() -> Self {
        Self::default()
    }
    /// Registers a path for removal and returns it.
    pub fn add(&mut self, path: impl Into<PathBuf>) -> PathBuf {
        let path = path.into();
        if !self.paths.contains(&path) {
            self.paths.push(path.clone());
        }
        path
    }
    /// The registered paths, in registration order.
    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }
    /// Removes every registered path now.
    pub fn remove_all(&mut self) {
        for path in self.paths.drain(..) {
            remove_path(&path);
        }
    }
    /// Moves another guard's paths into this one.
    pub fn absorb(&mut self, mut other: TempFiles) {
        for path in other.paths.drain(..) {
            self.add(path);
        }
    }
}

impl Drop for TempFiles {
    fn drop(&mut self) {
        self.remove_all();
    }
}

fn remove_path(path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

/// One process of a job.
#[derive(Debug, Clone)]
pub struct Step {
    /// What to run.
    pub process: ProcessSpec,
    /// When set, the stderr policy of 0.90.34's `runWithStderrOnFailure` is applied under this
    /// label ("Spectral Method", "QNA"): on a non-zero exit "⚠ <label> failed (exit N):" and the
    /// stderr are shown and logged, on a clean exit only warning-like lines are logged. The process's
    /// stderr should be [`StderrTarget::Capture`](super::process::StderrTarget::Capture).
    pub stderr_label: Option<String>,
    /// A `-P` progress file the solver writes. It is created empty before the step, as
    /// `: > file` did, polled for the status bar while the step runs, and removed when the step ends.
    pub progress_file: Option<PathBuf>,
    /// Whether captured standard output is part of the run's output (shown and archived). True by
    /// default; false keeps it only in the step's outcome.
    pub show_stdout: bool,
}

impl Step {
    /// A step running `process`, showing its standard output, with no stderr policy.
    pub fn new(process: ProcessSpec) -> Self {
        Self { process, stderr_label: None, progress_file: None, show_stdout: true }
    }
    /// Applies the stderr policy under `label`.
    pub fn stderr_policy(mut self, label: impl Into<String>) -> Self {
        self.stderr_label = Some(label.into());
        self
    }
    /// Sets the step's progress file.
    pub fn progress(mut self, path: impl Into<PathBuf>) -> Self {
        self.progress_file = Some(path.into());
        self
    }
    /// Keeps standard output out of the run's output.
    pub fn quiet(mut self) -> Self {
        self.show_stdout = false;
        self
    }
}

/// What a step's tick hook is told.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StepTick {
    /// Time since the step's process started.
    pub elapsed: Duration,
    /// The step's progress file, when it has a usable header.
    pub progress: Option<ProgressCount>,
}

/// What one step of a job ran and how it ended, kept for the app's failure reports (2.0, ROADMAP
/// A4): the argument vector as it was started, the exit or signal, and the captured stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepRecord {
    /// The executable's path, as resolved.
    pub program: PathBuf,
    /// Arguments after the program name.
    pub args: Vec<std::ffi::OsString>,
    /// The working directory, when the step set one.
    pub cwd: Option<PathBuf>,
    /// How the process ended; `None` when it could not be spawned.
    pub exit: Option<ExitKind>,
    /// Why it could not be spawned.
    pub spawn_error: Option<String>,
    /// True when Stop ended (or prevented) the step.
    pub interrupted: bool,
    /// Time from spawn to the end of supervision.
    pub elapsed: Duration,
    /// Everything it wrote to a captured standard error.
    pub stderr: Vec<u8>,
}

/// How many step records a job keeps: the newest (a test set runs thousands of steps).
pub const STEP_RECORDS_KEPT: usize = 64;

/// The result of a finished job.
#[derive(Debug, Clone)]
pub struct JobReport {
    /// The outcome, as reported to the owning tab.
    pub summary: RunSummary,
    /// The full-precision archive: everything the run emitted, the bytes the result parser reads.
    pub archive: Vec<u8>,
    /// The newest [`STEP_RECORDS_KEPT`] steps, oldest first.
    pub steps: Vec<StepRecord>,
}

impl JobReport {
    /// The archive as text (invalid UTF-8 replaced by U+FFFD).
    pub fn archive_text(&self) -> String {
        String::from_utf8_lossy(&self.archive).into_owned()
    }
}

/// One accepted run in progress. Created by [`run_job`] or [`spawn_job`] and handed to the method's
/// closure.
pub struct Job {
    ticket: RunTicket,
    output: JobOutput,
    temps: TempFiles,
    progress_files: Arc<Mutex<Vec<PathBuf>>>,
    temp_dir: PathBuf,
    interrupted: Option<i32>,
    forced_exit: Option<i32>,
    steps: Vec<StepRecord>,
    ticker: Option<Ticker>,
}

impl Job {
    fn start(ticket: RunTicket, sink: Box<dyn OutputSink>) -> Self {
        let progress_files = Arc::new(Mutex::new(Vec::new()));
        let ticker = Ticker::start(
            Arc::clone(ticket.registry()),
            ticket.id().clone(),
            ticket.reporter().clone(),
            ticket.started(),
            Arc::clone(&progress_files),
        );
        Self {
            ticket,
            output: JobOutput { archive: Vec::new(), sink },
            temps: TempFiles::new(),
            progress_files,
            temp_dir: std::env::temp_dir(),
            interrupted: None,
            forced_exit: None,
            steps: Vec::new(),
            ticker: Some(ticker),
        }
    }

    /// The run's id (also its Results record's id).
    pub fn id(&self) -> &RunId {
        self.ticket.id()
    }
    /// The internal run label ("inf_cmp").
    pub fn label(&self) -> &str {
        self.ticket.label()
    }
    /// The display label ("Run Comparison").
    pub fn display_label(&self) -> &str {
        self.ticket.display_label()
    }
    /// The tab that launched the run.
    pub fn owner(&self) -> &RunOwner {
        self.ticket.owner()
    }
    /// The run's Stop token, for waits between steps.
    pub fn cancel_token(&self) -> &CancelToken {
        self.ticket.cancel_token()
    }
    /// True once Stop has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.ticket.cancel_token().is_cancelled()
    }
    /// Time since the run was accepted.
    pub fn elapsed(&self) -> Duration {
        self.ticket.started().elapsed()
    }

    /// The run's output.
    pub fn output(&mut self) -> &mut JobOutput {
        &mut self.output
    }
    /// Emits bytes to the run's output (shown and archived).
    pub fn emit(&mut self, bytes: &[u8]) {
        self.output.emit(bytes);
    }
    /// Emits text to the run's output.
    pub fn emit_str(&mut self, text: &str) {
        self.output.emit_str(text);
    }
    /// Emits "Elapsed time: X.XXXs" and a blank line, timed from the run's acceptance.
    pub fn emit_elapsed_footer(&mut self) {
        let line = elapsed_footer(self.elapsed().as_secs_f64());
        self.output.emit_str(&line);
    }
    /// The archive so far.
    pub fn archive(&self) -> &[u8] {
        self.output.archive()
    }

    /// Sends a line to the owning tab's Status log.
    pub fn status(&self, text: impl Into<String>, severity: Severity) {
        self.ticket.report(&RunEvent::Status { text: text.into(), severity });
    }

    /// Records that the run could not start (an input could not be written, a solver could not be
    /// spawned): logs `message` as an error to the owning tab and makes the run's exit status −1,
    /// as 0.90.34's `failRunToLaunch` did ("<Label> could not start: <error>").
    pub fn could_not_start(&mut self, message: impl Into<String>) {
        self.status(message, Severity::Error);
        self.forced_exit.get_or_insert(-1);
    }

    /// The folder temporary files go in (the system temporary folder unless set).
    pub fn temp_dir(&self) -> &Path {
        &self.temp_dir
    }
    /// Changes the folder temporary files go in.
    pub fn set_temp_dir(&mut self, dir: impl Into<PathBuf>) {
        self.temp_dir = dir.into();
    }
    /// A path in the temporary folder, registered for removal when the run ends.
    pub fn temp_path(&mut self, file_name: &str) -> PathBuf {
        let path = self.temp_dir.join(file_name);
        self.temps.add(path)
    }
    /// Registers any path for removal when the run ends.
    pub fn register_temp(&mut self, path: impl Into<PathBuf>) -> PathBuf {
        self.temps.add(path)
    }
    /// Takes over a guard filled before the run was accepted (inputs exported before launch).
    pub fn adopt_temps(&mut self, temps: TempFiles) {
        self.temps.absorb(temps);
    }
    /// A fresh progress file `BNET_progress_<label>_<pid>_<µs>.bin`, registered for polling and for
    /// removal. Pass it to the solver with `-P` and to [`Step::progress`].
    pub fn progress_file(&mut self, label: &str) -> PathBuf {
        let path = progress_file_path(&self.temp_dir, label);
        self.register_progress(&path);
        path
    }
    fn register_progress(&mut self, path: &Path) {
        self.temps.add(path);
        let mut files = self.progress_files.lock().unwrap_or_else(|p| p.into_inner());
        if !files.iter().any(|p| p == path) {
            files.push(path.to_path_buf());
        }
    }

    /// Runs one step to its end. See [`Job::run_step_with`].
    pub fn run_step(&mut self, step: &Step) -> io::Result<ProcessOutcome> {
        self.run_step_with(step, Duration::from_secs(3600), &mut |_, _| {})
    }

    /// Runs one step to its end, calling `tick` about every `tick_every` with the step's elapsed
    /// time and progress (for drawing the Shell's progress line through the output).
    ///
    /// A step started after Stop is not spawned and ends as interrupted. Captured standard output
    /// is emitted as it arrives (unless the step is quiet). When the step ends, its progress file is
    /// removed and, if it has a stderr label and was not interrupted by Stop, the stderr policy's
    /// text is emitted and its lines are logged to the owning tab. Returns an error only when the
    /// process could not be spawned; the caller decides whether that ends the run (see
    /// [`Job::could_not_start`]).
    pub fn run_step_with(
        &mut self,
        step: &Step,
        tick_every: Duration,
        tick: &mut dyn FnMut(&mut JobOutput, &StepTick),
    ) -> io::Result<ProcessOutcome> {
        if let Some(path) = &step.progress_file {
            self.register_progress(path);
            if !self.is_cancelled() {
                fs::File::create(path)?;
            }
        }
        let cancel = self.ticket.cancel_token().clone();
        let mut hooks = StepHooks {
            output: &mut self.output,
            show_stdout: step.show_stdout,
            started: Instant::now(),
            progress_file: step.progress_file.as_deref(),
            tick,
        };
        let result = run_process(&step.process, &cancel, tick_every, &mut hooks);
        if let Some(path) = &step.progress_file {
            remove_path(path);
        }
        let record = |exit, spawn_error, interrupted, elapsed, stderr| StepRecord {
            program: step.process.program.clone(),
            args: step.process.args.clone(),
            cwd: step.process.cwd.clone(),
            exit,
            spawn_error,
            interrupted,
            elapsed,
            stderr,
        };
        if self.steps.len() >= STEP_RECORDS_KEPT {
            self.steps.remove(0);
        }
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(e) => {
                self.steps.push(record(None, Some(e.to_string()), false, Duration::ZERO, Vec::new()));
                return Err(e);
            }
        };
        self.steps.push(record(Some(outcome.exit), None, outcome.interrupted(), outcome.elapsed, outcome.stderr.clone()));
        let code = outcome.shell_code();
        if outcome.interrupted() {
            self.interrupted.get_or_insert(code);
        } else if let Some(label) = &step.stderr_label {
            let report = stderr_report(label, code, &outcome.stderr);
            self.output.emit(&report.display);
            for (text, severity) in report.status {
                self.status(text, severity);
            }
        }
        Ok(outcome)
    }

    fn finish(mut self, body_code: i32) -> JobReport {
        if let Some(ticker) = self.ticker.take() {
            ticker.stop();
        }
        self.temps.remove_all();
        let exit_code = self.interrupted.or(self.forced_exit).unwrap_or(body_code);
        let summary = RunSummary {
            id: self.ticket.id().clone(),
            label: self.ticket.display_label().to_string(),
            owner: self.ticket.owner().clone(),
            exit_code,
            elapsed: self.ticket.started().elapsed(),
            finished_at: SystemTime::now(),
            user_stopped: self.is_cancelled(),
        };
        self.output.sink.finish();
        if !summary.succeeded() && !summary.cancelled() {
            self.status(summary.text(), Severity::Error);
        }
        let archive = std::mem::take(&mut self.output.archive);
        let steps = std::mem::take(&mut self.steps);
        // Release the slot before announcing the finish, so the owner may launch again from it.
        let reporter = self.ticket.reporter().clone();
        drop(self);
        reporter(&RunEvent::Finished(summary.clone()));
        JobReport { summary, archive, steps }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if let Some(ticker) = self.ticker.take() {
            ticker.stop();
        }
    }
}

struct StepHooks<'a> {
    output: &'a mut JobOutput,
    show_stdout: bool,
    started: Instant,
    progress_file: Option<&'a Path>,
    tick: &'a mut dyn FnMut(&mut JobOutput, &StepTick),
}

impl ProcessHooks for StepHooks<'_> {
    fn stdout(&mut self, chunk: &[u8]) {
        if self.show_stdout {
            self.output.emit(chunk);
        }
    }
    fn tick(&mut self) {
        let tick = StepTick { elapsed: self.started.elapsed(), progress: self.progress_file.and_then(read_progress) };
        (self.tick)(self.output, &tick);
    }
}

/// Runs a job on this thread: `body` runs the method's steps and returns the run's exit status.
/// Temporary files are removed and the single-flight slot released however `body` ends; a panic
/// in `body` ends the run with exit status −1. The owning tab receives the failure line (for a
/// non-zero exit that was not a Stop) and then [`RunEvent::Finished`].
pub fn run_job(ticket: RunTicket, sink: Box<dyn OutputSink>, body: impl FnOnce(&mut Job) -> i32) -> JobReport {
    let mut job = Job::start(ticket, sink);
    let code = match panic::catch_unwind(AssertUnwindSafe(|| body(&mut job))) {
        Ok(code) => code,
        Err(payload) => {
            job.status(format!("{} stopped on an internal error: {}", job.display_label(), panic_text(&payload)), Severity::Error);
            -1
        }
    };
    job.finish(code)
}

/// Runs a job on a thread of its own and returns at once; join the handle for the report.
pub fn spawn_job(
    ticket: RunTicket,
    sink: Box<dyn OutputSink>,
    body: impl FnOnce(&mut Job) -> i32 + Send + 'static,
) -> JoinHandle<JobReport> {
    thread::spawn(move || run_job(ticket, sink, body))
}

fn panic_text(payload: &Box<dyn Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown".to_string()
    }
}

/// The 500 ms poller: reads the job's progress files and reports the live state.
struct Ticker {
    stop: Arc<(Mutex<bool>, Condvar)>,
    handle: Option<JoinHandle<()>>,
}

impl Ticker {
    fn start(
        registry: Arc<RunRegistry>,
        id: RunId,
        reporter: Reporter,
        started: Instant,
        files: Arc<Mutex<Vec<PathBuf>>>,
    ) -> Self {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let flag = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            let (lock, cvar) = &*flag;
            let mut stopped = lock.lock().unwrap_or_else(|p| p.into_inner());
            loop {
                let deadline = Instant::now() + PROGRESS_INTERVAL;
                while !*stopped {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    stopped = match cvar.wait_timeout(stopped, deadline - now) {
                        Ok((g, _)) => g,
                        Err(p) => p.into_inner().0,
                    };
                }
                if *stopped {
                    return;
                }
                let paths = files.lock().unwrap_or_else(|p| p.into_inner()).clone();
                let fraction = progress_fraction(&paths);
                registry.set_fraction(&id, fraction);
                reporter(&RunEvent::Progress(RunProgress { fraction, elapsed: started.elapsed() }));
            }
        });
        Self { stop, handle: Some(handle) }
    }

    fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        let (lock, cvar) = &*self.stop;
        *lock.lock().unwrap_or_else(|p| p.into_inner()) = true;
        cvar.notify_all();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.halt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_temp_guard_removes_files_and_folders_on_drop() {
        let dir = std::env::temp_dir().join(format!("qnet-temps-unit-{}", std::process::id()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/x"), b"x").unwrap();
        let file = std::env::temp_dir().join(format!("qnet-temps-unit-{}.txt", std::process::id()));
        fs::write(&file, b"y").unwrap();
        {
            let mut guard = TempFiles::new();
            guard.add(&dir);
            guard.add(&file);
            guard.add(&file);
            guard.add("/nonexistent/qnet/never");
            assert_eq!(guard.paths().len(), 3);
        }
        assert!(!dir.exists());
        assert!(!file.exists());
    }
}
