//! `qnet-cli run`: one Run-menu method on one network, without a window (PLAN.md §7 P3; ledger
//! CLI-019). 0.90.34 had no headless way to run a solver; this is new in 2.0.
//!
//! It does what the app's Run menu does, through the same code: `qnet_runner::methods::prepare`
//! (the solver lookup, the pre-checks and their Status sentences, the exporter, the input file,
//! the seeds and the record's parameters), then `launch` through a single-flight registry and the
//! supervisor, which starts the solvers itself (D1). What it prints:
//!
//! - stdout: what the Shell pane shows of the run, the solvers' output through the
//!   display-precision filter at `output.decimals` (`qnet_core::output::precision`); with `--full`,
//!   the full-precision archive the result parser reads, unfiltered.
//! - stderr: every Status line, one per line as `<severity>\t<text>` (the form of the corpus's
//!   `status.txt`), so those lines are exactly what the tab's Status log would hold. The CLI's own
//!   notes (the outcome sentence the status bar would show, what filing the result did) are
//!   `qnet-cli: <text>` lines.
//!
//! Settings start at 0.90.34's defaults (`RunSettings::default()`) and change with
//! `--set key=value`, using the stored keys (`sim.replications`, `sm.degree`, `output.decimals`);
//! the parameter sheets the app shows for some methods take their values from the same settings.
//! `--store results.json` files the run in a results store at that path as the Results workspace
//! does: the record is registered before the run starts and finished from its archive.
//!
//! Solvers are found as the app finds them (`ResolverConfig::from_process`: the app bundle,
//! `QNET_SOLVER_ROOT`, a nearby Qnet.app, then the staged development tree). Ctrl-C stops the run
//! with the Stop ladder (SIGINT, SIGTERM at 1.5 s, SIGKILL at 3 s, to the solver's process group).
//! The exit status is the run's (0 when it succeeded, the solver's status otherwise, 130 when it was
//! stopped); a run the method refuses exits 1, and a usage error exits 2.

use std::io::Write;
use std::path::Path;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use qnet_core::output::precision::PrecisionFilter;
use qnet_core::results::model::{file_url, Provenance, RunRecord};
use qnet_core::results::{Date, Disposition, MethodMetadata};
use qnet_runner::methods::{launch, prepare, Method, Prepared, RunContext, RunSettings};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use qnet_runner::store::{Finished, ResultsStore, RunOutcome};
use qnet_runner::supervisor::{display_label, OutputSink, RunEvent, RunOwner, RunRegistry, Severity};

/// The usage line for `run`, shown by `qnet-cli`'s usage text.
pub const USAGE: &str = "  qnet-cli run <method> <file.bnet> [--full] [--json] [--set key=value]… [--store results.json]
                                             one Run-menu method on the network (Status lines on stderr); with --json the
                                             result as one JSON document instead of the solver's text; methods:
      inf_cmp inf_sim product_form qbd truncated_ctmc regenerative_mc inf_sm qna rqna sbd mlmc lp
      adaptive_bar bar_bounds mc              infinite buffers
      cmp sim regenerative_mc generic_ctmc fb_decomp sm fm flp   finite buffers
      closed_pf                               a closed network (no source, no sink, a population)
      priority_exact                          one station with priority service fed by Poisson sources: exact means
      batch_exact                             one single-server station with batch Poisson arrivals: exact means
      sim_inproc                              a closed network, or an open one with infinite buffers: replicated
                                              simulation with confidence intervals, computed in process
                                              (--set siminproc.replications=20 siminproc.completions=200000
                                              siminproc.confidence=0.95 siminproc.precision=0 siminproc.warmup=0)";

/// The tab id the CLI's runs are recorded under: one fixed UUID, so a store's history shows them as
/// one tab's runs (the store reads tab ids as UUIDs, as 0.90.34's decoder did).
const TAB_ID: &str = "00000000-0000-4000-8000-0000000000C1";

/// Set by the SIGINT handler; the watcher thread turns it into a Stop.
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_interrupt(_signal: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}

/// What the command line asked for.
#[derive(Debug, PartialEq)]
struct Request {
    method: Method,
    file: String,
    full: bool,
    settings: RunSettings,
    store: Option<String>,
    /// `--json` (new in 2.1): print the run's record as one JSON document (api.rs) instead of the solver's text.
    json: bool,
}

/// Reads `run`'s arguments (everything after `run`).
fn parse_args(args: &[String]) -> Result<Request, (u8, String)> {
    let usage = || (2, format!("Usage:\n{USAGE}"));
    let mut positional = Vec::new();
    let mut full = false;
    let mut json = false;
    let mut store = None;
    let mut sets = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--full" => full = true,
            "--json" => json = true,
            "--set" => sets.push(it.next().ok_or_else(usage)?.clone()),
            "--store" => store = Some(it.next().ok_or_else(usage)?.clone()),
            a if a.starts_with("--") => return Err(usage()),
            a => positional.push(a.to_string()),
        }
    }
    let [label, file] = positional.as_slice() else { return Err(usage()) };
    let method = Method::from_label(label).ok_or_else(|| (2, format!("There's no method called “{label}”.\n\nUsage:\n{USAGE}")))?;
    let mut settings = RunSettings::default();
    for set in &sets {
        let (key, value) = set.split_once('=').ok_or_else(|| (2, format!("--set takes key=value, not “{set}”.")))?;
        settings.set(key, value).map_err(|e| (2, e))?;
    }
    Ok(Request { method, file: file.clone(), full, settings, store, json })
}

/// Runs `qnet-cli run …` and returns the process's exit status.
pub fn main(args: &[String]) -> ExitCode {
    let request = match parse_args(args) {
        Ok(r) => r,
        Err((code, message)) => {
            eprintln!("{message}");
            return ExitCode::from(code);
        }
    };
    match run(request) {
        Ok(code) => ExitCode::from(code),
        Err((code, message)) => {
            eprintln!("{message}");
            ExitCode::from(code)
        }
    }
}

fn severity_word(s: Severity) -> &'static str {
    match s {
        Severity::Info => "info",
        Severity::Success => "success",
        Severity::Warning => "warning",
        Severity::Error => "error",
    }
}

/// The Status lines of this run, kept for `--json`.
static STATUS_LINES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn status_line(severity: Severity, text: &str) {
    STATUS_LINES.lock().unwrap_or_else(|p| p.into_inner()).push((severity_word(severity).to_string(), text.to_string()));
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{}\t{}", severity_word(severity), text);
}

/// One of the CLI's own notes, which are not Status lines.
fn note(text: &str) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "qnet-cli: {text}");
}

fn run(request: Request) -> Result<u8, (u8, String)> {
    let Request { method, file, full, settings, store, json } = request;
    // --json reads the record a results store files; without --store, one in a temporary file.
    let scratch = (json && store.is_none()).then(|| std::env::temp_dir().join(format!("qnet-cli-{}-{}.json", std::process::id(), qnet_core::results::codec::random_uuid())));
    let store = store.or_else(|| scratch.as_ref().map(|p| p.to_string_lossy().into_owned()));
    let said = || STATUS_LINES.lock().unwrap_or_else(|p| p.into_inner()).clone();
    // The variant `--scenario` names, else the one the file was saved showing (load.rs).
    let network = crate::load::load(&file)?.net;
    let scenario = crate::load::note();
    if !json {
        if let Some(w) = scenario.as_ref().and_then(|n| n.warning()) {
            note(&w);
        }
    }
    let title = Path::new(&file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| file.clone());
    let infinite = network.infinite_buffers;
    let decimals = settings.output_decimals;
    let resolver = Arc::new(Resolver::new(ResolverConfig::from_process()));
    let ctx = RunContext::new(network, title.clone(), settings, resolver);

    let run = match prepare(method, &ctx) {
        Prepared::Refused(lines) => {
            let buffers = if infinite { "infinite" } else { "finite" };
            let not_offered = format!("{} isn't in the Run menu for a network with {buffers} buffers.", display_label(method.label()));
            if lines.is_empty() {
                note(&not_offered);
            }
            for line in &lines {
                status_line(line.severity, &line.text);
            }
            if json {
                let why = said().iter().map(|(_, text)| text.clone()).collect::<Vec<_>>().join(" ");
                let why = if why.is_empty() { not_offered } else { why };
                print!("{}", crate::api::print(&crate::api::run_refused_json(&file, &ctx.network, method.label(), "refused", 1, Some(why), &said())));
            }
            return Ok(1);
        }
        Prepared::Launch(run) => run,
    };

    // The record goes into the store before the run starts, as registerStructuredResult did.
    let mut filing = match (&store, MethodMetadata::for_run_label(method.label())) {
        (Some(path), Some(meta)) => {
            let mut results = ResultsStore::open(path);
            if let Some(aside) = results.set_aside() {
                let moved = match &aside.backup {
                    Some(backup) => format!("it was moved to {}", backup.display()),
                    None => "it was left where it is, and nothing will be written over it".to_string(),
                };
                note(&format!("{path} couldn't be used ({}); {moved}.", aside.error.trim_end_matches('.')));
            }
            let source = std::fs::canonicalize(&file).ok().map(|p| file_url(&p.to_string_lossy()));
            let provenance = Provenance::capture(
                TAB_ID,
                &title,
                &ctx.network,
                source,
                run.parameters.clone(),
                run.seed,
                run.replication_seeds.clone(),
                env!("CARGO_PKG_VERSION"),
            );
            let id = results.begin_run(RunRecord::new(&ctx.uuid().to_uppercase(), meta, provenance, Date::now()));
            Some((results, id))
        }
        _ => None,
    };

    let registry = RunRegistry::new();
    let finished_ok: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let reporter = {
        let finished_ok = finished_ok.clone();
        Arc::new(move |event: &RunEvent| match event {
            RunEvent::Status { text, severity } => status_line(*severity, text),
            RunEvent::Finished(summary) if summary.succeeded() => {
                *finished_ok.lock().unwrap_or_else(|p| p.into_inner()) = Some(summary.text());
            }
            _ => {}
        })
    };
    let sink: Box<dyn OutputSink> = if json {
        Box::new(QuietSink)
    } else if full {
        Box::new(RawSink)
    } else {
        Box::new(DisplaySink::new(decimals))
    };
    let owner = RunOwner { id: TAB_ID.into(), title };

    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGINT, on_interrupt as extern "C" fn(libc::c_int) as libc::sighandler_t);
        // SIGTERM too (what `kill` and most supervisors send): without it the tool would die and
        // leave its solver, which runs in a process group of its own, running.
        libc::signal(libc::SIGTERM, on_interrupt as extern "C" fn(libc::c_int) as libc::sighandler_t);
    }
    let network = ctx.network.clone();
    let handle = launch(run, &registry, owner, reporter, sink).map_err(|refused| (1, refused.message))?;
    let done = Arc::new(AtomicBool::new(false));
    let stopped = Arc::new(AtomicBool::new(false));
    let watcher = {
        let (registry, done, stopped) = (registry.clone(), done.clone(), stopped.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if INTERRUPTED.swap(false, Ordering::SeqCst) && !stopped.swap(true, Ordering::SeqCst) {
                    registry.stop();
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })
    };
    let report = handle.join().map_err(|_| (1, "The run's thread ended unexpectedly.".to_string()))?;
    done.store(true, Ordering::SeqCst);
    let _ = watcher.join();
    let _ = std::io::stdout().flush();

    if let Some(text) = finished_ok.lock().unwrap_or_else(|p| p.into_inner()).take() {
        note(&text);
    }
    if let (Some((results, id)), Some(path)) = (filing.as_mut(), store.as_deref()) {
        let outcome = RunOutcome {
            id: id.clone(),
            label: display_label(method.label()),
            exit_code: report.summary.exit_code,
            user_stopped: report.summary.user_stopped,
            finished_at: Date::now(),
        };
        let quiet = scratch.is_some();
        match results.finish_run(&outcome, Some(&report.archive_text())) {
            _ if quiet => {}
            Finished::NoRecord => {}
            Finished::Deleted => note("The run was stopped, so its result was not filed."),
            Finished::ExitedWithError(message) => note(&format!("Filed the result in {path}: failed ({message}).")),
            Finished::Parsed(Disposition::Completed) => note(&format!("Filed the result in {path}: completed.")),
            Finished::Parsed(Disposition::Partial(why)) => note(&format!("Filed the result in {path}: partial ({why}).")),
            Finished::Parsed(Disposition::Failed(why)) => note(&format!("Filed the result in {path}: failed ({why}).")),
        }
        if let Some(problem) = results.persistence_error() {
            note(problem);
        }
    }
    let code = report.summary.exit_code;
    if json {
        let record = filing.as_ref().and_then(|(results, id)| results.record(id));
        let doc = match record {
            Some(record) => crate::api::run_json(&file, &network, method.label(), record, code, &said()),
            None => {
                let (status, why) = if report.summary.user_stopped { ("cancelled", Some("The run was stopped.".to_string())) } else if code == 0 { ("completed", None) } else { ("failed", Some(said().iter().filter(|(severity, _)| severity == "error").map(|(_, text)| text.clone()).collect::<Vec<_>>().join(" "))) };
                crate::api::run_refused_json(&file, &network, method.label(), status, code, why, &said())
            }
        };
        print!("{}", crate::api::print(&doc));
    }
    if let Some(path) = &scratch {
        let _ = std::fs::remove_file(path);
    }
    Ok(if (0..=255).contains(&code) { code as u8 } else { 1 })
}

/// Shows nothing of the run's text: `--json`, whose one document is printed at the end.
struct QuietSink;

impl OutputSink for QuietSink {
    fn write(&mut self, _bytes: &[u8]) {}
}

/// `qnet-cli solve <file.bnet> […]`: `run` with the method Solve would choose for the network
/// (new in 2.1; methods.rs). The choice is noted on stderr.
pub fn solve(args: &[String]) -> ExitCode {
    // The file is the one argument that is neither an option nor an option's value.
    let mut file = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--set" | "--store" => {
                it.next();
            }
            a if a.starts_with("--") => {}
            a => file = file.or(Some(a.to_string())),
        }
    }
    let Some(file) = file else {
        eprintln!("Usage:\n  qnet-cli solve <file.bnet> [--full] [--json] [--set key=value]… [--store results.json]");
        return ExitCode::from(2);
    };
    match crate::api::solve_label(&file) {
        Ok(label) => {
            note(&format!("Solve chooses {}.", display_label(label)));
            let mut all = vec![label.to_string()];
            all.extend(args.iter().cloned());
            main(&all)
        }
        Err((code, message)) => {
            eprintln!("{message}");
            ExitCode::from(code)
        }
    }
}

/// Writes the run's bytes to stdout as they come: `--full`.
struct RawSink;

impl OutputSink for RawSink {
    fn write(&mut self, bytes: &[u8]) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(bytes);
        let _ = out.flush();
    }
}

/// Writes what the Shell pane shows: the run's bytes through the display-precision filter, with
/// a held tail released after the filter's 50 ms of quiet by a poller thread, as 0.90.34's perl
/// stage released it.
struct DisplaySink {
    filter: Arc<Mutex<PrecisionFilter>>,
    done: Arc<AtomicBool>,
    poller: Option<JoinHandle<()>>,
}

impl DisplaySink {
    fn new(decimals: i64) -> Self {
        let filter = Arc::new(Mutex::new(PrecisionFilter::new(decimals, true)));
        let done = Arc::new(AtomicBool::new(false));
        let poller = {
            let (filter, done) = (filter.clone(), done.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(10));
                    let mut f = filter.lock().unwrap_or_else(|p| p.into_inner());
                    let shown = f.poll(Instant::now());
                    write_stdout(&shown);
                }
            })
        };
        DisplaySink { filter, done, poller: Some(poller) }
    }
}

fn write_stdout(bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(bytes);
    let _ = out.flush();
}

impl OutputSink for DisplaySink {
    fn write(&mut self, bytes: &[u8]) {
        let mut f = self.filter.lock().unwrap_or_else(|p| p.into_inner());
        let shown = f.feed(bytes, Instant::now());
        write_stdout(&shown);
    }

    fn finish(&mut self) {
        self.done.store(true, Ordering::SeqCst);
        if let Some(poller) = self.poller.take() {
            let _ = poller.join();
        }
        let mut f = self.filter.lock().unwrap_or_else(|p| p.into_inner());
        let shown = f.finish();
        write_stdout(&shown);
    }
}

impl Drop for DisplaySink {
    fn drop(&mut self) {
        self.done.store(true, Ordering::SeqCst);
        if let Some(poller) = self.poller.take() {
            let _ = poller.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_method_file_and_options_are_read_in_any_order() {
        let r = parse_args(&args(&["--full", "qna", "--set", "output.decimals=3", "net.bnet", "--store", "r.json"])).unwrap();
        assert_eq!(r.method, Method::Qna);
        assert_eq!(r.file, "net.bnet");
        assert!(r.full);
        assert_eq!(r.store.as_deref(), Some("r.json"));
        assert_eq!(r.settings.output_decimals, 3);
    }

    #[test]
    fn an_unknown_method_or_setting_is_a_usage_error() {
        let (code, message) = parse_args(&args(&["nope", "net.bnet"])).unwrap_err();
        assert_eq!(code, 2);
        assert!(message.starts_with("There's no method called “nope”."), "{message}");
        let (code, message) = parse_args(&args(&["qna", "net.bnet", "--set", "no.such=1"])).unwrap_err();
        assert_eq!(code, 2);
        assert_eq!(message, "There's no run setting called “no.such”.");
        assert_eq!(parse_args(&args(&["qna", "net.bnet", "--set", "sim.replications"])).unwrap_err().0, 2);
        assert_eq!(parse_args(&args(&["qna"])).unwrap_err().0, 2);
        assert_eq!(parse_args(&args(&["qna", "net.bnet", "--bogus"])).unwrap_err().0, 2);
    }
}
