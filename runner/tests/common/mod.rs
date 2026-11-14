//! Shared helpers for the method tests: run a method on an example the way
//! `golden/tools/GoldenRuns.swift` ran it in 0.90.34, and read what 0.90.34 wrote for the same
//! run in `golden/runs/<example>/<method>/`.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::json::{self, Json};
use qnet_runner::methods::{prepare, launch, Method, Prepared, RunContext, RunSettings, StatusLine};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use qnet_runner::supervisor::{CollectSink, RunEvent, RunOwner, RunRegistry, Severity};

/// A recorded file's text as this Mac would have written it. The corpus is published with its
/// recording Mac's home folder written as `/Users/nobody` (plain and JSON-escaped; see
/// scripts/make-golden-runs.sh); the comparison needs this Mac's own, and this Mac's Python.
pub fn golden_read(path: impl AsRef<std::path::Path>) -> std::io::Result<String> {
    let text = std::fs::read_to_string(path)?;
    let Some(home) = std::env::var("HOME").ok().filter(|h| !h.is_empty()) else { return Ok(text) };
    let text = text.replace("\\/Users\\/nobody", &home.replace('/', "\\/")).replace("/Users/nobody", &home);
    // The corpus was recorded with the recording Mac's own Python, `/opt/homebrew/bin/python3`.
    // Where Qnet's own Python is staged (scripts/stage-python.sh) the resolver runs that one
    // instead, so the recorded interpreter path is read as this Mac's.
    let own = format!("{home}/Library/Caches/qnet/python/stage/Resources/python/bin/python3");
    if !std::path::Path::new(&own).is_file() {
        return Ok(text);
    }
    Ok(text.replace("\\/opt\\/homebrew\\/bin\\/python3", &own.replace('/', "\\/")).replace("/opt/homebrew/bin/python3", &own))
}

/// The repository root (`qnet/`).
pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("runner/ has a parent").to_path_buf()
}

/// The staged solver tree, as `make-golden-runs.sh` passed it to 0.90.34 in `QNET_SOLVER_ROOT`.
pub fn staged_solver_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let root = PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources");
    root.join("bin").is_dir().then_some(root)
}

/// Whether the corpus of runs is complete (`PROVENANCE.json` is written last).
pub fn golden_runs_ready() -> bool {
    root().join("golden/runs/PROVENANCE.json").is_file()
}

/// The examples, as (folder name, file path), the folder name being the file name minus its last
/// ".bnet", as in `golden/`.
pub fn examples() -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = std::fs::read_dir(root().join("examples"))
        .expect("examples/")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "bnet"))
        .map(|p| {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            (name.strip_suffix(".bnet").unwrap().to_string(), p)
        })
        .collect();
    out.sort();
    out
}

/// A resolver that finds the staged solvers through `QNET_SOLVER_ROOT`, as 0.90.34 did.
pub fn staged_resolver() -> Option<Arc<Resolver>> {
    let solver_root = staged_solver_root()?;
    let mut cfg = ResolverConfig::from_process();
    cfg.bundle_resources = None;
    cfg.env.insert(OsString::from("QNET_SOLVER_ROOT"), solver_root.into_os_string());
    Some(Arc::new(Resolver::new(cfg)))
}

/// The context 0.90.34's dump ran with: the example opened as File › Open opens it (the tab is
/// titled with the file name), the golden settings, the staged solvers.
pub fn golden_context(example: &Path, resolver: Arc<Resolver>) -> RunContext {
    let text = std::fs::read_to_string(example).expect("example");
    let network = qnet_core::bnet::read(&text).expect("example reads");
    let title = example.file_name().unwrap().to_string_lossy().to_string();
    RunContext::new(network, title, RunSettings::golden(), resolver)
}

/// What one run produced in 2.0.
#[derive(Debug)]
pub struct Outcome {
    /// Every Status line, in order: refusals, `before`, `accepted`, then the job's own lines.
    pub status: Vec<StatusLine>,
    /// The record's parameters, seed and replication seeds (empty for a refusal).
    pub parameters: BTreeMap<String, String>,
    pub seed: Option<u64>,
    pub replication_seeds: Vec<u64>,
    /// Whether the run launched.
    pub launched: bool,
    /// The full-precision archive.
    pub archive: String,
    /// The exit status.
    pub exit_code: Option<i32>,
}

/// Prepares and runs `method` to its end on this thread's registry.
pub fn run(method: Method, ctx: &RunContext) -> Outcome {
    let status: Arc<Mutex<Vec<StatusLine>>> = Arc::new(Mutex::new(Vec::new()));
    match prepare(method, ctx) {
        Prepared::Refused(lines) => Outcome {
            status: lines,
            parameters: BTreeMap::new(),
            seed: None,
            replication_seeds: Vec::new(),
            launched: false,
            archive: String::new(),
            exit_code: None,
        },
        Prepared::Launch(run) => {
            let parameters = run.parameters.clone();
            let seed = run.seed;
            let replication_seeds = run.replication_seeds.clone();
            let registry = RunRegistry::new();
            let sink_status = status.clone();
            let reporter = Arc::new(move |event: &RunEvent| {
                if let RunEvent::Status { text, severity } = event {
                    sink_status.lock().unwrap().push(StatusLine::new(text.clone(), *severity));
                }
            });
            let owner = RunOwner { id: "golden-tab".into(), title: ctx.title.clone() };
            let handle = launch(run, &registry, owner, reporter, Box::new(CollectSink::default()))
                .expect("a fresh registry accepts the run");
            let report = handle.join().expect("the job thread");
            let lines = status.lock().unwrap().clone();
            Outcome {
                status: lines,
                parameters,
                seed,
                replication_seeds,
                launched: true,
                archive: report.archive_text(),
                exit_code: Some(report.summary.exit_code),
            }
        }
    }
}

/// What 0.90.34 wrote for one run, from `golden/runs/<example>/<method>/`.
#[derive(Debug)]
pub struct Golden {
    pub dir: PathBuf,
    /// `status.txt` as (severity word, text) pairs.
    pub status: Vec<(String, String)>,
    pub launched: bool,
    pub archive: String,
    pub exit_code: Option<i32>,
    pub record: Option<Json>,
    /// The wrapper's temp folder and pid, read from `script.sh`, for normalising paths.
    pub temp_dir: Option<String>,
    pub pid: Option<String>,
}

/// Reads `golden/runs/<example>/<label>/`, or `None` when the folder is absent.
pub fn golden(example: &str, label: &str) -> Option<Golden> {
    let dir = root().join("golden/runs").join(example).join(label);
    if !dir.is_dir() {
        return None;
    }
    let read = |f: &str| golden_read(dir.join(f)).ok();
    let status = read("status.txt")
        .unwrap_or_default()
        .lines()
        .map(|l| match l.split_once('\t') {
            Some((s, t)) => (s.to_string(), t.to_string()),
            None => (String::new(), l.to_string()),
        })
        .collect();
    let script = read("script.sh");
    let (temp_dir, pid) = script.as_deref().map(script_temp_and_pid).unwrap_or((None, None));
    Some(Golden {
        launched: dir.join("script.sh").is_file(),
        archive: read("archive.txt").unwrap_or_default(),
        exit_code: read("exit.txt").and_then(|s| s.trim().parse().ok()),
        record: read("record.json").and_then(|s| json::parse(&s).ok()).filter(|j| j.as_object().is_some()),
        status,
        temp_dir,
        pid,
        dir,
    })
}

/// The temp folder and pid in the wrapper's `BNET_run_pid_<pid>_<uuid>.txt` path.
fn script_temp_and_pid(script: &str) -> (Option<String>, Option<String>) {
    let Some(at) = script.find("/BNET_run_pid_") else { return (None, None) };
    let start = script[..at].rfind('"').map(|i| i + 1).unwrap_or(0);
    let temp = script[start..at].to_string();
    let rest = &script[at + "/BNET_run_pid_".len()..];
    let pid: String = rest.chars().take_while(char::is_ascii_digit).collect();
    (Some(temp), Some(pid))
}

impl Golden {
    /// The record's `provenance.parameters`.
    pub fn parameters(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        if let Some(p) = self.provenance().and_then(|p| p.get("parameters")).and_then(Json::as_object) {
            for (k, v) in p {
                out.insert(k.clone(), v.as_str().unwrap_or_default().to_string());
            }
        }
        out
    }

    /// The record's `provenance.seed`, read exactly (seeds go up to 2^64; a Double rounds them past
    /// 2^53).
    pub fn seed(&self) -> Option<u64> {
        self.provenance().and_then(|p| p.get("seed")).and_then(exact_u64)
    }

    /// The record's `provenance.replicationSeeds`, read exactly.
    pub fn replication_seeds(&self) -> Vec<u64> {
        self.provenance()
            .and_then(|p| p.get("replicationSeeds"))
            .and_then(Json::as_array)
            .map(|a| a.iter().filter_map(exact_u64).collect())
            .unwrap_or_default()
    }

    fn provenance(&self) -> Option<&BTreeMap<String, Json>> {
        self.record.as_ref()?.as_object()?.get("provenance")?.as_object()
    }
}

/// A JSON number as an unsigned integer, from its text (exact), or through a Double for a number
/// written with a fraction or an exponent.
fn exact_u64(v: &Json) -> Option<u64> {
    match v {
        Json::Number(text) => text.parse::<u64>().ok().or_else(|| text.parse::<f64>().ok().map(|x| x as u64)),
        _ => None,
    }
}

/// The severity word 0.90.34's `StatusSeverity` printed in `status.txt`.
pub fn severity_word(s: Severity) -> &'static str {
    match s {
        Severity::Info => "info",
        Severity::Success => "success",
        Severity::Warning => "warning",
        Severity::Error => "error",
    }
}

/// An archive or display text with what varies from run to run made comparable: every line keeps
/// only its last carriage-return frame (what a terminal leaves on screen), the `%6.1fs` times at
/// the end of spinner and progress frames and the `Elapsed time: X.XXXs` lines are masked, a
/// solver's own wall-clock lines are masked ([`mask_printed_time`]), and the temp folder and pid in
/// file names are replaced by `<TMP>` and `<PID>`.
pub fn normalize(text: &str, temp_dir: Option<&str>, pid: Option<&str>) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let mut line = match line.rfind('\r') {
            Some(at) => line[at + 1..].trim_start_matches("\x1b[K").to_string(),
            None => line.to_string(),
        };
        if let Some(rest) = line.strip_prefix("Elapsed time: ") {
            if rest.ends_with('s') {
                line = "Elapsed time: <T>s".to_string();
            }
        }
        if let Some(stem) = frame_time_stem(&line) {
            line = format!("{stem}<T>s");
        }
        if let Some(masked) = mask_printed_time(&line) {
            line = masked;
        }
        if let Some(t) = temp_dir {
            line = line.replace(t, "<TMP>");
        }
        if let Some(p) = pid {
            line = line.replace(&format!("_{p}"), "_<PID>");
        }
        out.push_str(&line);
    }
    out
}

/// For a spinner or progress frame ending in `"%6.1fs"`, the text before the time.
fn frame_time_stem(line: &str) -> Option<&str> {
    if !(line.contains("[done]") || line.contains("(100%)") || line.contains("]  ")) {
        return None;
    }
    let body = line.strip_suffix('s')?;
    let digits = body.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    if digits.len() == body.len() || !body[digits.len()..].contains('.') {
        return None;
    }
    Some(digits.trim_end_matches(' '))
}

/// A solver's own wall-clock time, masked as `<T>`, on the two line shapes that print one:
///
/// - a line that starts with a bracketed tag and ends in `<digits>.<digits> s` or
///   `<digits>.<digits>s`: the LP solvers' stage timings outside their compact mode
///   (`[Grid]  400 points, 0.002 s`, `[Solve] Optimal u* = 0.0000000000e+00, 0.047 s`) and the LP
///   summary's `[Total] 2.843s`; only its last number is touched;
/// - `rbm_mlmc`'s header, `# backend=<name>  threads=<n>  elapsed=<seconds>s`.
pub fn mask_printed_time(line: &str) -> Option<String> {
    if let Some(at) = line.find("  elapsed=") {
        let (head, time) = (&line[..at], &line[at + "  elapsed=".len()..]);
        if head.starts_with("# backend=") && head.contains("  threads=") && time.strip_suffix('s').is_some_and(is_decimal) {
            return Some(format!("{head}  elapsed=<T>s"));
        }
        return None;
    }
    if !line.starts_with('[') || !line.contains("] ") {
        return None;
    }
    let (body, unit) = match line.strip_suffix(" s") {
        Some(body) => (body, " s"),
        None => (line.strip_suffix('s')?, "s"),
    };
    let start = body.char_indices().rev().take_while(|(_, c)| c.is_ascii_digit() || *c == '.').last()?.0;
    if !is_decimal(&body[start..]) || !body[..start].ends_with(' ') {
        return None;
    }
    Some(format!("{}<T>{unit}", &body[..start]))
}

/// `<digits>.<digits>`.
fn is_decimal(s: &str) -> bool {
    s.split_once('.').is_some_and(|(w, f)| !w.is_empty() && !f.is_empty() && w.bytes().chain(f.bytes()).all(|b| b.is_ascii_digit()))
}

// ── Filing a run as the Results store does, and comparing records ───────────────────────────

/// Files `outcome` the way 0.90.34 did for this run (`registerStructuredResult` at launch,
/// `finalizeStructuredResult` at the end) through 2.0's `ResultsStore`, and returns the record as
/// JSON, or `None` for a run that never launched or has no record (diagnostic labels).
pub fn file_record(method: Method, ctx: &RunContext, example: &Path, outcome: &Outcome) -> Option<Json> {
    use qnet_core::results::model::{file_url, Provenance, RunRecord};
    use qnet_core::results::{Date, MethodMetadata};
    use qnet_runner::store::{ResultsStore, RunOutcome};
    if !outcome.launched {
        return None;
    }
    let meta = MethodMetadata::for_run_label(method.label())?;
    let dir = std::env::temp_dir().join(format!("qnet-golden-store-{}-{}", std::process::id(), ctx.uuid()));
    std::fs::create_dir_all(&dir).ok()?;
    let mut store = ResultsStore::open(dir.join("results-v1.json"));
    let provenance = Provenance::capture(
        "golden-tab",
        &ctx.title,
        &ctx.network,
        Some(file_url(&example.to_string_lossy())),
        outcome.parameters.clone(),
        outcome.seed,
        outcome.replication_seeds.clone(),
        "2.0.0",
    );
    let id = store.begin_run(RunRecord::new(&ctx.uuid().to_uppercase(), meta, provenance, Date::now()));
    let run = RunOutcome {
        id: id.clone(),
        label: qnet_runner::supervisor::labels::display_label(method.label()),
        exit_code: outcome.exit_code.unwrap_or(-1),
        user_stopped: false,
        finished_at: Date::now(),
    };
    store.finish_run(&run, Some(&outcome.archive));
    let json = store.record(&id).and_then(|r| r.to_json().ok());
    let _ = std::fs::remove_dir_all(&dir);
    json
}

/// A record with what differs between any two runs removed: ids (the record's and every
/// measurement's), dates, elapsed seconds, the tab id, the application version and the raw output
/// (compare archives with [`normalize`] instead).
pub fn comparable_record(record: &Json) -> Json {
    fn strip(v: &Json, path: &[&str]) -> Json {
        match v {
            Json::Object(map) => {
                let mut out = BTreeMap::new();
                for (k, x) in map {
                    let drop = match path {
                        [] => matches!(k.as_str(), "id" | "startedAt" | "completedAt" | "elapsedSeconds" | "rawOutput"),
                        ["provenance"] => matches!(k.as_str(), "tabID" | "applicationVersion"),
                        ["measurements"] => k == "id",
                        _ => false,
                    };
                    if drop {
                        continue;
                    }
                    let mut p: Vec<&str> = path.to_vec();
                    if path.is_empty() {
                        p.push(match k.as_str() {
                            "provenance" => "provenance",
                            "measurements" => "measurements",
                            _ => "other",
                        });
                    } else {
                        p.push("other");
                    }
                    out.insert(k.clone(), strip(x, &p));
                }
                Json::Object(out)
            }
            // Array elements keep their parent's path, so each measurement loses its id.
            Json::Array(a) => Json::Array(a.iter().map(|x| strip(x, path)).collect()),
            other => other.clone(),
        }
    }
    strip(record, &[])
}

// ── The machine that recorded the corpus ────────────────────────────────────────────────────────
//
// `golden/runs/` was recorded on the owner's first Mac, which had 18 CPU cores. A test on another
// Mac takes what is specific to that machine from the golden run itself (the CPU count its banner
// printed) or from the corpus (its OpenMP thread count). Every comparison is exact: the solvers
// rebuilt on a second Mac reproduced the corpus for the same input, the one exception being an LP
// that HiGHS solves there and failed on the first (PLAN.md §7 P3).

/// The CPU count the golden wrapper printed in its thread banner (`printf '[Threads] Using %d CPU
/// cores (OpenMP)\n' 18`, or the comparison's mixed banner), or `None` when it printed none.
pub fn golden_cpu_count(g: &Golden) -> Option<usize> {
    let script = golden_read(g.dir.join("script.sh")).ok()?;
    let at = script.find("printf '[Threads]")?;
    let rest = &script[at + "printf '".len()..];
    let close = rest.find("' ")?;
    let digits: String = rest[close + 2..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// The corpus Mac's core count: every golden wrapper's thread banner says 18, and the OpenMP
/// solvers there ran 18 threads.
pub const CORPUS_THREADS: usize = 18;

/// Makes the solvers this test binary starts run as many OpenMP threads as they ran on the
/// corpus's Mac, by setting `OMP_NUM_THREADS` for the whole process once, before its first golden
/// run. `rbm_mlmc` deals sample i to lane i mod threads and seeds lane t with seed + t, so its
/// estimates depend on the thread count; the run specifications pass none, as 0.90.34 passed none.
/// The other solvers give the same numbers at any thread count (measured on this Mac).
pub fn corpus_threads() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| std::env::set_var("OMP_NUM_THREADS", CORPUS_THREADS.to_string()));
}

/// The context 0.90.34 ran this golden run in: [`golden_context`], with the CPU count its thread
/// banner printed (the corpus's Mac had 18 cores; this one may not), and the corpus's OpenMP
/// thread count for the solvers ([`corpus_threads`]).
pub fn golden_run_context(example: &Path, resolver: Arc<Resolver>, g: &Golden) -> RunContext {
    corpus_threads();
    let mut ctx = golden_context(example, resolver);
    if let Some(cpus) = golden_cpu_count(g) {
        ctx.cpu_count = cpus;
    }
    ctx
}

// ── Golden acceptance, shared by every method family ───────────────────────────────────────────
//
// For every example with a folder for the method in `golden/runs/`, the run is prepared and
// launched with the staged solvers as `golden/tools/GoldenRuns.swift` ran it, and compared with
// what 0.90.34 wrote: the Status lines (`status.txt`, with the solver's stderr inbox from
// `status-inbox.txt` drained as 0.90.34's poller drained it), whether it launched, the record's
// parameters, seed and replication seeds, the exit status, the full-precision archive line for line
// after `normalize`, and the record 2.0's store files from that archive (`file_record`) against
// `record.json`, both through `comparable_record`.
//
// Comparison rules, each narrow and each for a reason the corpus can't avoid:
//
// 1. The failure line "<Label> failed (exit N) after <duration>" is compared with its duration
//    masked, and expected last: the golden harness ran the wrapper synchronously inside
//    `sendCommand`, so 0.90.34 logged it before the action's "Running …" line, which in the app
//    (and in 2.0) comes first.
// 2. Lines drained from the stderr inbox go after the action's own lines and before the failure
//    line, which is where 0.90.34's 500 ms poller put them in a real run.
// 3. The corpus's settings are `RunSettings::golden()` (which records the one stored value of the
//    owner's that leaked in, `output.decimals` = 3), its CPU count is the golden script's, and the
//    solvers run the corpus Mac's 18 OpenMP threads (`corpus_threads`).
// 4. A run that took 0.90.34 more than 60 s (its archive's "Elapsed time" or its summary's
//    duration) is skipped with a note unless `QNET_GOLDEN_SLOW=1`.
// 5. While the corpus is still being written (no `PROVENANCE.json`), the golden tests skip with a
//    note; `QNET_GOLDEN_PARTIAL=1` compares the folders that are complete so far.
// 6. When a solver died of a signal, bash, which ran it, printed a job report into the archive
//    ("<wrapper>.sh: line 8: 74149 Segmentation fault: 11  <command> > <out> 2> <err>"). 2.0 starts
//    the solver itself (D1) and has no shell to print it; the failure heading that follows it is
//    kept. That report is removed from the golden archive before comparing.

/// Golden runs that took 0.90.34 longer than this are skipped unless `QNET_GOLDEN_SLOW=1` (rule 4).
pub const SLOW_SECONDS: f64 = 60.0;

/// How many golden runs may be in flight at once across all tests of one test binary: 6, or
/// `QNET_GOLDEN_JOBS` (lower it when several test binaries run at once; the parallel solvers start
/// a thread per core each).
fn max_concurrent_runs() -> usize {
    std::env::var("QNET_GOLDEN_JOBS").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(6)
}

static SLOTS: Mutex<usize> = Mutex::new(0);
static SLOT_FREED: std::sync::Condvar = std::sync::Condvar::new();

/// Runs `f` once one of the binary's run slots is free.
pub fn with_slot<T>(f: impl FnOnce() -> T) -> T {
    {
        let mut used = SLOTS.lock().unwrap_or_else(|p| p.into_inner());
        while *used >= max_concurrent_runs() {
            used = SLOT_FREED.wait(used).unwrap_or_else(|p| p.into_inner());
        }
        *used += 1;
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            *SLOTS.lock().unwrap_or_else(|p| p.into_inner()) -= 1;
            SLOT_FREED.notify_one();
        }
    }
    let _release = Release;
    f()
}

/// Whether the environment variable `name` is set to "1".
pub fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

/// The staged resolver when the golden comparison can run, else `None` after a printed note.
pub fn golden_resolver(label: &str) -> Option<Arc<Resolver>> {
    let Some(resolver) = staged_resolver() else {
        println!("{label}: skipped, the staged solvers are absent (scripts/stage-solvers.sh)");
        return None;
    };
    if !golden_runs_ready() && !env_flag("QNET_GOLDEN_PARTIAL") {
        println!("{label}: skipped, golden/runs/PROVENANCE.json is missing (QNET_GOLDEN_PARTIAL=1 compares what exists)");
        return None;
    }
    Some(resolver)
}

/// Whether a golden folder is finished: its Status lines are written and, if it launched, its exit
/// status too.
pub fn complete(g: &Golden) -> bool {
    g.dir.join("status.txt").is_file() && (!g.launched || g.dir.join("exit.txt").is_file())
}

/// How long 0.90.34's run took: the longest "Elapsed time" in its archive, or the duration in
/// `summary.txt` ("finished in 9:52", "failed (exit 139) after 13:15", "… in 0.3 s"), whichever is
/// longer (a run that died has no "Elapsed time").
pub fn golden_seconds(g: &Golden) -> f64 {
    let elapsed = g
        .archive
        .lines()
        .filter_map(|l| l.strip_prefix("Elapsed time: ")?.strip_suffix('s')?.parse::<f64>().ok())
        .fold(0.0, f64::max);
    let summary = golden_read(g.dir.join("summary.txt")).unwrap_or_default();
    let tail = summary.trim().rsplit([' ']).take(2).collect::<Vec<_>>();
    let duration = match tail.as_slice() {
        ["s", secs] => secs.parse::<f64>().unwrap_or(0.0),
        [clock, ..] if clock.contains(':') => clock.split(':').fold(0.0, |acc, part| acc * 60.0 + part.parse::<f64>().unwrap_or(0.0)),
        _ => 0.0,
    };
    elapsed.max(duration)
}

/// Rule 6: the line bash printed when a solver died of a signal ("<wrapper>.sh: line 8: 74149
/// Segmentation fault: 11  <command>"), from the wrapper's path to the end of its line.
pub fn without_shell_job_report(archive: &str) -> String {
    let mut out = archive.to_string();
    while let Some(at) = out.find("/BNET_run_") {
        let start = out[..at].rfind(['\n', ' ']).map_or(0, |i| i + 1);
        let rest = &out[at..];
        let Some(colon) = rest.find(".sh: line ") else { break };
        if !rest[..colon].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-' || b"/BNET_run_".contains(&b)) {
            break;
        }
        let end = rest.find('\n').map_or(out.len(), |i| at + i + 1);
        out.replace_range(start..end, "");
    }
    out
}

/// Masks the duration of a failure line ("… failed (exit N) after 0.3 s").
pub fn mask_duration(text: &str) -> String {
    match (text.find(" failed (exit "), text.rfind(" after ")) {
        (Some(f), Some(a)) if a > f => format!("{} after <T>", &text[..a]),
        _ => text.to_string(),
    }
}

/// The Status lines 2.0 should write, from `status.txt`, `status-inbox.txt` and `summary.txt`
/// (rules 1 and 2).
pub fn expected_status(g: &Golden) -> Vec<(String, String)> {
    use qnet_runner::supervisor::stderr::drain_record;
    let summary = golden_read(g.dir.join("summary.txt")).unwrap_or_default().trim().to_string();
    let mut lines = Vec::new();
    let mut failure = None;
    for (sev, text) in &g.status {
        if !summary.is_empty() && sev == "error" && *text == summary {
            failure = Some((sev.clone(), mask_duration(text)));
        } else {
            lines.push((sev.clone(), text.clone()));
        }
    }
    if let Ok(inbox) = golden_read(g.dir.join("status-inbox.txt")) {
        for record in inbox.split("<<<END>>>") {
            for (text, sev) in drain_record(record) {
                lines.push((severity_word(sev).to_string(), text));
            }
        }
    }
    lines.extend(failure);
    lines
}

/// 2.0's Status lines as (severity word, text), failure durations masked.
pub fn actual_status(lines: &[StatusLine]) -> Vec<(String, String)> {
    lines.iter().map(|l| (severity_word(l.severity).to_string(), mask_duration(&l.text))).collect()
}

/// The first line where two texts differ ("line N: expected …, got …"), for a readable failure.
pub fn first_difference(expected: &str, actual: &str) -> Option<String> {
    let e: Vec<&str> = expected.split('\n').collect();
    let a: Vec<&str> = actual.split('\n').collect();
    (0..e.len().max(a.len()))
        .find(|&i| e.get(i) != a.get(i))
        .map(|i| format!("line {}: expected {:?}, got {:?}", i + 1, e.get(i), a.get(i)))
}

/// The record as JSON text with what varies by run removed (`comparable_record`), and without its
/// provenance when `with_provenance` is false.
pub fn comparable_text(record: &Json, with_provenance: bool) -> String {
    let mut c = comparable_record(record);
    if !with_provenance {
        if let Json::Object(map) = &mut c {
            map.remove("provenance");
        }
    }
    json::to_pretty(&c)
}

/// A fresh empty folder in the system temp folder, private to this process.
pub fn fresh_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-golden-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Compares one example's run with its golden folder, in a temporary folder of its own (0.90.34
/// named some inputs `BNET_<method>_<pid>.<ext>`, relying on one run at a time per process, and
/// these runs are concurrent).
pub fn check(method: Method, example: &Path, g: &Golden, resolver: Arc<Resolver>) -> Result<(), String> {
    let mut ctx = golden_run_context(example, resolver, g);
    let tag = example.file_name().unwrap().to_string_lossy().replace('.', "_");
    ctx.temp_dir = fresh_dir(&format!("{}-{tag}", method.label()));
    let result = check_in(method, &ctx, example, g);
    let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    result
}

/// [`check`] in a prepared context.
pub fn check_in(method: Method, ctx: &RunContext, example: &Path, g: &Golden) -> Result<(), String> {
    let out = run(method, ctx);
    let expected = expected_status(g);
    let actual = actual_status(&out.status);
    if expected != actual {
        return Err(format!("Status lines differ:\n  expected {expected:?}\n  got      {actual:?}"));
    }
    if out.launched != g.launched {
        return Err(format!("launched {} but 0.90.34 launched {}", out.launched, g.launched));
    }
    if !g.launched {
        return Ok(());
    }
    if out.parameters != g.parameters() {
        return Err(format!("parameters differ:\n  expected {:?}\n  got      {:?}", g.parameters(), out.parameters));
    }
    if out.seed != g.seed() || out.replication_seeds != g.replication_seeds() {
        return Err(format!("seeds differ: expected {:?} {:?}, got {:?} {:?}", g.seed(), g.replication_seeds(), out.seed, out.replication_seeds));
    }
    if out.exit_code != g.exit_code {
        return Err(format!("exit status {:?}, expected {:?}", out.exit_code, g.exit_code));
    }
    let temp = ctx.temp_dir.to_string_lossy().trim_end_matches('/').to_string();
    let pid = ctx.pid.to_string();
    let mine = normalize(&out.archive, Some(&temp), Some(&pid));
    let theirs = normalize(&without_shell_job_report(&g.archive), g.temp_dir.as_deref(), g.pid.as_deref());
    if let Some(d) = first_difference(&theirs, &mine) {
        return Err(format!("archive differs at {d}"));
    }
    let filed = file_record(method, ctx, example, &out).ok_or("the run filed no record")?;
    let golden_record = g.record.as_ref().ok_or("record.json is missing")?;
    if let Some(d) = first_difference(&comparable_text(golden_record, true), &comparable_text(&filed, true)) {
        return Err(format!("filed record differs at {d}"));
    }
    Ok(())
}

/// Runs `method` on every example the corpus has a folder for, in parallel, and asserts that each
/// matches exactly.
/// Golden runs known to differ between the Mac that recorded the corpus and others, each with the
/// exact difference that is accepted. Anything else about the same run still fails.
///
/// `lp` on Bramson94.d3.c5.reentrant.inf: on the corpus's Mac (18 cores) HiGHS gave up on this LP
/// ("run_status=-1, model_status=0", exit 1 after 12 s), so 0.90.34 recorded "Linear Program failed
/// (exit 1)". On an M3 Ultra the same `srbm_lp`, fed the corpus's own input file, solves it
/// ("Optimal u* = 5.4714923232e-04"), with HiGHS 1.15 and 1.16 and at any OpenMP thread count. The
/// accepted difference is exactly that: the corpus has the failure line and this Mac's run does
/// not. `6_QNET20/handoff/check-bramson94-lp.sh` re-runs it on the corpus's Mac. Made an expected
/// difference at the owner's instruction, 2026-11-12; until then the test failed on it.
const KNOWN_DIFFERENCES: &[(&str, &str, &[&str])] = &[(
    "lp",
    "Bramson94.d3.c5.reentrant.inf",
    &[
        r#"expected [("info", "Running Linear Program (BNAlp)..."), ("error", "Linear Program failed (exit 1) after <T>")]"#,
        r#"got      [("info", "Running Linear Program (BNAlp)...")]"#,
    ],
)];

fn known_difference(label: &str, name: &str, error: &str) -> bool {
    KNOWN_DIFFERENCES.iter().any(|(l, n, marks)| *l == label && *n == name && marks.iter().all(|m| error.contains(m)))
}

pub fn golden_method(method: Method) {
    let label = method.label();
    let Some(resolver) = golden_resolver(label) else { return };
    corpus_threads();
    let mut cases = Vec::new();
    for (name, path) in examples() {
        let Some(g) = golden(&name, label) else { continue };
        if !complete(&g) {
            println!("{label}: {name} skipped, its golden folder is still being written");
            continue;
        }
        if golden_seconds(&g) > SLOW_SECONDS && !env_flag("QNET_GOLDEN_SLOW") {
            println!("{label}: {name} skipped, 0.90.34 took {:.0} s (QNET_GOLDEN_SLOW=1 runs it)", golden_seconds(&g));
            continue;
        }
        cases.push((name, path, g));
    }
    let total = cases.len();
    let failures: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    std::thread::scope(|s| {
        for (name, path, g) in &cases {
            let resolver = resolver.clone();
            let failures = failures.clone();
            std::thread::Builder::new()
                .name(format!("{label}-{name}"))
                .spawn_scoped(s, move || {
                    let result = with_slot(|| check(method, path, g, resolver));
                    if let Err(e) = result {
                        if known_difference(label, name, &e) {
                            println!("{label}: {name} differs from the corpus in the one known way (see KNOWN_DIFFERENCES)");
                        } else {
                            failures.lock().unwrap().push(format!("{name}: {e}"));
                        }
                    }
                })
                .expect("a thread");
        }
    });
    let failures = failures.lock().unwrap();
    println!("{label}: {} of {total} examples match 0.90.34", total - failures.len());
    assert!(failures.is_empty(), "{label}: {} of {total} differ:\n{}", failures.len(), failures.join("\n\n"));
}
