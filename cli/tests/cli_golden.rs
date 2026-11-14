//! The qnet-cli binary against 0.90.34's headless output for every example: each `export` format
//! (the golden file or its refusal sentence and exit 1), `export-all`, `dump-rho` and `resave`; and
//! `run` against 0.90.34's own Run-menu runs (`golden/runs/`) for a set of methods that covers a
//! Python and a C engine, an analytic table, seeded simulations, a failing run, a finite network, a
//! refusal and a method the network's Run menu doesn't offer.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A recorded file's text as this Mac would have written it. The corpus is published with its
/// recording Mac's home folder written as `/Users/nobody` (plain and JSON-escaped; see
/// scripts/make-golden-runs.sh); the comparison needs this Mac's own, and this Mac's Python.
fn golden_read(path: impl AsRef<std::path::Path>) -> std::io::Result<String> {
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

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn examples() -> Vec<(String, PathBuf)> {
    let mut v: Vec<(String, PathBuf)> = std::fs::read_dir(root().join("examples"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "bnet"))
        .map(|p| {
            let f = p.file_name().unwrap().to_string_lossy().to_string();
            (f.strip_suffix(".bnet").unwrap().to_string(), p)
        })
        .collect();
    v.sort();
    v
}

fn cli(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_qnet-cli")).args(args).output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8(out.stdout).unwrap(), String::from_utf8(out.stderr).unwrap())
}

fn without_generated(s: &str) -> String {
    s.lines().filter(|l| !l.starts_with("# Generated:")).collect::<Vec<_>>().join("\n")
}

/// The CLI format and the golden file it reproduces.
const FORMATS: &[(&str, &str)] = &[
    ("fbnasm", "fbnasm.in"), ("fbnafm", "fbnafm.in"), ("fbnasim", "fbnasim.txt"), ("bnasm", "bnasm.in"), ("bnamc", "bnamc.in"),
    ("bnalp", "bnalp.in"), ("adaptive-bar", "adaptive-bar.json"), ("bar-bounds", "bar-bounds.json"), ("qna", "qna.qna"),
    ("jackson-sim", "jackson.sim"), ("regenerative", "regenerative.json"), ("product-form", "product-form.json"), ("qbd", "qbd.json"),
    ("generic-ctmc", "generic-ctmc.json"), ("decomp-loss", "decomp-loss.json"), ("decomp-bas", "decomp-bas.json"),
    ("decomp-bas-extloss", "decomp-bas-external-loss.json"), ("truncated-ctmc", "truncated-ctmc.json"),
];

#[test]
fn every_export_format_matches_0_90_34_for_every_example() {
    let mut differ = Vec::new();
    for (name, path) in examples() {
        let g = root().join("golden").join(&name);
        for (format, file) in FORMATS {
            let (code, out, err) = cli(&["export", format, path.to_str().unwrap()]);
            match std::fs::read_to_string(g.join(file)) {
                Ok(want) => {
                    if code != 0 || without_generated(&out) != without_generated(&want) {
                        differ.push(format!("{name} {format}: exit {code} {err}"));
                    }
                }
                Err(_) => {
                    let want = std::fs::read_to_string(g.join(format!("{file}.error.txt"))).unwrap();
                    if code != 1 || err != want {
                        differ.push(format!("{name} {format}: refusal {err:?} vs {want:?}"));
                    }
                }
            }
        }
    }
    assert!(differ.is_empty(), "{} differ, first: {:?}", differ.len(), differ.iter().take(5).collect::<Vec<_>>());
}

#[test]
fn fbnalp_matches_when_given_the_corpus_output_prefix() {
    // The corpus's fbnalp.in carries the placeholder prefix OUTPUT_PREFIX; the CLI writes none, as
    // Export All's lp.in does, so compare it with export-all/lp.in instead.
    for (name, path) in examples() {
        let (code, out, _) = cli(&["export", "fbnalp", path.to_str().unwrap()]);
        let want = std::fs::read_to_string(root().join("golden").join(&name).join("export-all/lp.in")).unwrap();
        assert_eq!((code, out), (0, want), "{name}");
    }
}

#[test]
fn export_all_dump_rho_and_resave_match_0_90_34() {
    let tmp = std::env::temp_dir().join(format!("qnet-cli-test-{}", std::process::id()));
    for (name, path) in examples() {
        let p = path.to_str().unwrap();
        let g = root().join("golden").join(&name);
        let (_, out, _) = cli(&["dump-rho", p]);
        assert_eq!(out, std::fs::read_to_string(g.join("dump-rho.txt")).unwrap(), "{name} dump-rho");
        let (_, out, _) = cli(&["resave", p]);
        assert_eq!(out, std::fs::read_to_string(g.join("resave.bnet")).unwrap(), "{name} resave");
        let dir = tmp.join(&name);
        let (code, _, _) = cli(&["export-all", p, dir.to_str().unwrap()]);
        assert_eq!(code, 0);
        for f in ["sm.in", "fm.in", "lp.in", "sim.txt", "qna.qna", "cmp_sm.in", "cmp_sim.sim"] {
            let ours = std::fs::read_to_string(dir.join(f)).ok();
            let want = std::fs::read_to_string(g.join("export-all").join(f)).ok();
            assert_eq!(ours.as_deref().map(without_generated), want.as_deref().map(without_generated), "{name}/{f}");
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn usage_errors_exit_2_and_unknown_formats_say_so() {
    assert_eq!(cli(&[]).0, 2);
    let (code, _, err) = cli(&["export", "nope", "x.bnet"]);
    assert!(code == 1 || code == 2, "{code}");
    let _ = err;
    let ex = root().join("examples/MM1K.d1.c1.fin.bnet");
    let (code, _, err) = cli(&["export", "nope", ex.to_str().unwrap()]);
    assert_eq!(code, 2);
    assert!(err.starts_with("There's no export format called “nope”."), "{err}");
    assert!(Path::new(env!("CARGO_BIN_EXE_qnet-cli")).exists());
}

/// `gen-random` against the 0.90.34 binary itself, when scripts/make-golden.sh has built it in the
/// cache (its three files hold no ids, so they must be identical).
#[test]
fn gen_random_writes_what_0_90_34_wrote_when_its_binary_is_at_hand() {
    let legacy = PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Caches/qnet/legacy-0.90.34/src/.build/out/Products/Release/Qnet");
    if !legacy.exists() {
        eprintln!("skipped: no 0.90.34 build at {} (scripts/make-golden.sh makes one)", legacy.display());
        return;
    }
    let tmp = std::env::temp_dir().join(format!("qnet-gen-random-{}", std::process::id()));
    let home = tmp.join("home");
    std::fs::create_dir_all(&home).unwrap();
    for args in [["4", "3", "0.9", "ff", "1"], ["3", "1", "0.8", "jfb", "7"], ["5", "2", "0.95", "gp", "42"], ["6", "4", "0.75", "reent", "20260904"], ["2", "2", "0.7", "reent", "18446744073709551615"]] {
        let (old, new) = (tmp.join("old"), tmp.join("new"));
        let status = Command::new(&legacy).arg("--gen-random").args(args).arg(&old).env("CFFIXED_USER_HOME", &home).output().unwrap().status;
        assert!(status.success());
        let mut ours: Vec<&str> = vec!["gen-random"];
        ours.extend(args);
        let new_s = new.to_str().unwrap().to_string();
        ours.push(&new_s);
        assert_eq!(cli(&ours).0, 0);
        for f in ["case.qna", "case.smin", "case.sim"] {
            assert_eq!(std::fs::read_to_string(new.join(f)).ok(), std::fs::read_to_string(old.join(f)).ok(), "{args:?} {f}");
        }
        let _ = std::fs::remove_dir_all(&old);
        let _ = std::fs::remove_dir_all(&new);
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

// ── qnet-cli run ─────────────────────────────────────────────────────────────────────────────────

/// The settings `golden/runs/` was made with (`RunSettings::golden()`), as `--set` arguments.
const GOLDEN_SETTINGS: &[&str] = &[
    "sim.seedFixed=true", "sim.replications=8", "sim.warmup=10000", "sim.time=200000", "sim.parallel=2",
    "mlmc.seedFixed=true", "runCompare.remember=true", "output.decimals=3",
];

/// The staged solver tree the corpus ran (`QNET_SOLVER_ROOT`), when it is there.
fn staged_solver_root() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var("HOME").ok()?).join("Library/Caches/qnet/solvers/stage/Resources");
    root.join("bin").is_dir().then_some(root)
}

/// What one `qnet-cli run` printed, and the pid and temp folder its file names carry.
struct RunOutput {
    code: i32,
    stdout: String,
    stderr: String,
    pid: u32,
    temp: PathBuf,
}

fn cli_run(method: &str, example: &str, extra: &[&str], tag: &str) -> RunOutput {
    let temp = std::env::temp_dir().join(format!("qnet-cli-run-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_qnet-cli"));
    cmd.arg("run").arg(method).arg(root().join("examples").join(format!("{example}.bnet")));
    for s in GOLDEN_SETTINGS {
        cmd.arg("--set").arg(s);
    }
    cmd.args(extra);
    // The trailing slash is how macOS spells TMPDIR, and so how the corpus's paths read.
    cmd.env("TMPDIR", format!("{}/", temp.display()));
    if let Some(stage) = staged_solver_root() {
        cmd.env("QNET_SOLVER_ROOT", stage);
    }
    // The corpus's Mac ran its OpenMP solvers with 18 threads; MLMC's estimates depend on it.
    cmd.env("OMP_NUM_THREADS", "18");
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let child = cmd.spawn().unwrap();
    let pid = child.id();
    let out = child.wait_with_output().unwrap();
    RunOutput { code: out.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned(), pid, temp }
}

/// The golden wrapper's temp folder and pid, from its `BNET_run_pid_<pid>_<uuid>.txt` path.
fn golden_temp_and_pid(dir: &Path) -> (String, String) {
    let script = golden_read(dir.join("script.sh")).unwrap_or_default();
    let Some(at) = script.find("/BNET_run_pid_") else { return (String::new(), String::new()) };
    let start = script[..at].rfind('"').map_or(0, |i| i + 1);
    let pid: String = script[at + "/BNET_run_pid_".len()..].chars().take_while(char::is_ascii_digit).collect();
    (script[start..at].to_string(), pid)
}

/// A run's text made comparable, as the runner's golden tests make it: the wrapper's first
/// `ESC[A ESC[2K` (it cleared the typed command line, which D1 doesn't type) dropped, each line's
/// last carriage-return frame kept, spinner and progress times and "Elapsed time" masked, and the
/// temp folder and pid replaced.
fn normalize(text: &str, temp: &str, pid: &str) -> String {
    let text = text.strip_prefix("\x1b[A\x1b[2K").unwrap_or(text);
    text.split('\n')
        .map(|line| {
            let mut line = match line.rfind('\r') {
                Some(at) => line[at + 1..].trim_start_matches("\x1b[K").to_string(),
                None => line.to_string(),
            };
            if line.starts_with("Elapsed time: ") && line.ends_with('s') {
                line = "Elapsed time: <T>s".into();
            }
            if line.contains("[done]") || line.contains("(100%)") || line.contains("]  ") {
                if let Some(body) = line.strip_suffix('s') {
                    let stem = body.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
                    if stem.len() < body.len() && body[stem.len()..].contains('.') {
                        line = format!("{}<T>s", stem.trim_end_matches(' '));
                    }
                }
            }
            // The thread banner prints the machine's core count (the corpus's Mac had 18).
            for (head, tail) in [("[Threads] Using ", " CPU cores (OpenMP)"), ("[Threads] ", " CPU cores for parallel solvers (Sim/Spectral/FE); analytical solvers (QNA/SBD/LP) are single-threaded")] {
                if let Some(n) = line.strip_prefix(head).and_then(|r| r.strip_suffix(tail)) {
                    if n.bytes().all(|b| b.is_ascii_digit()) {
                        line = format!("{head}<N>{tail}");
                    }
                }
            }
            if !temp.is_empty() {
                line = line.replace(temp, "<TMP>");
            }
            if !pid.is_empty() {
                line = line.replace(&format!("_{pid}"), "_<PID>");
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The Status lines 0.90.34 wrote, in the order 2.0 writes them: the failure line ("… failed (exit
/// N) after …", duration masked) last, after the lines drained from the solver's stderr inbox.
fn golden_status(dir: &Path) -> Vec<String> {
    let summary = golden_read(dir.join("summary.txt")).unwrap_or_default().trim().to_string();
    let mut lines = Vec::new();
    let mut failure = None;
    for line in golden_read(dir.join("status.txt")).unwrap_or_default().lines() {
        if !summary.is_empty() && line == format!("error\t{summary}") {
            failure = Some(mask_failure_duration(line));
        } else {
            lines.push(line.to_string());
        }
    }
    if let Ok(inbox) = golden_read(dir.join("status-inbox.txt")) {
        for record in inbox.split("<<<END>>>") {
            for (text, severity) in qnet_runner::supervisor::stderr::drain_record(record) {
                let word = format!("{severity:?}").to_lowercase();
                lines.push(format!("{word}\t{text}"));
            }
        }
    }
    lines.extend(failure);
    lines
}

fn mask_failure_duration(line: &str) -> String {
    match (line.find(" failed (exit "), line.rfind(" after ")) {
        (Some(f), Some(a)) if a > f => format!("{} after <T>", &line[..a]),
        _ => line.to_string(),
    }
}

/// The Status lines `qnet-cli run` printed: its stderr without its own `qnet-cli:` notes.
fn cli_status(stderr: &str) -> Vec<String> {
    stderr.lines().filter(|l| !l.starts_with("qnet-cli: ")).map(mask_failure_duration).collect()
}

/// A results record with what differs between any two runs, or any two machines, removed: ids,
/// dates, elapsed seconds, raw output, the tab id, the application version, and the folders in the
/// source file's URL and the solver root.
fn comparable(record: &qnet_core::json::Json, stage: &str) -> String {
    use qnet_core::json::Json;
    let mut r = record.clone();
    let Json::Object(top) = &mut r else { panic!("a record is an object") };
    for k in ["id", "startedAt", "completedAt", "elapsedSeconds", "rawOutput"] {
        top.remove(k);
    }
    if let Some(Json::Array(ms)) = top.get_mut("measurements") {
        for m in ms {
            if let Json::Object(m) = m {
                m.remove("id");
            }
        }
    }
    if let Some(Json::Object(p)) = top.get_mut("provenance") {
        p.remove("tabID");
        p.remove("applicationVersion");
        if let Some(Json::String(url)) = p.get_mut("sourceFileURL") {
            *url = url.rsplit('/').next().unwrap_or_default().to_string();
        }
    }
    let text = qnet_core::json::to_pretty(&r);
    // The corpus's solver root, then this machine's.
    text.replace("/Users/nobody/Library/Caches/qnet/solvers/stage/Resources", "<STAGE>").replace(stage, "<STAGE>")
}

/// Runs `method` on `example` through `qnet-cli run` and compares it with `golden/runs/`.
fn check_run(example: &str, method: &str) -> Result<(), String> {
    let dir = root().join("golden/runs").join(example).join(method);
    let store = std::env::temp_dir().join(format!("qnet-cli-run-store-{example}-{method}-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&store);
    let out = cli_run(method, example, &["--store", store.to_str().unwrap()], &format!("{example}-{method}"));
    let result = (|| {
        let launched = dir.join("script.sh").is_file();
        let want_code: i32 = if launched { std::fs::read_to_string(dir.join("exit.txt")).unwrap().trim().parse().unwrap() } else { 1 };
        if out.code != want_code {
            return Err(format!("exit {}, expected {want_code}; stderr:\n{}", out.code, out.stderr));
        }
        let (want, got) = (golden_status(&dir), cli_status(&out.stderr));
        if want != got {
            return Err(format!("Status lines differ:\n  expected {want:?}\n  got      {got:?}"));
        }
        if !launched {
            return Ok(());
        }
        let (gtemp, gpid) = golden_temp_and_pid(&dir);
        let temp = format!("{}", out.temp.display());
        let theirs = normalize(&golden_read(dir.join("display.txt")).unwrap(), &gtemp, &gpid);
        let mine = normalize(&out.stdout, &temp, &out.pid.to_string());
        if mine.trim().is_empty() {
            return Err("the run printed nothing".into());
        }
        if theirs != mine {
            let line = theirs.lines().zip(mine.lines()).position(|(a, b)| a != b).unwrap_or(0);
            return Err(format!("display differs at line {}: {:?} vs {:?}", line + 1, theirs.lines().nth(line), mine.lines().nth(line)));
        }
        let stage = staged_solver_root().unwrap().display().to_string();
        let filed = qnet_core::json::parse(&std::fs::read_to_string(&store).map_err(|e| format!("no store: {e}"))?).unwrap();
        let filed = filed.as_object().and_then(|o| o.get("records")).and_then(|r| r.as_array()).and_then(|r| r.first()).cloned().ok_or("the store holds no record")?;
        let golden = qnet_core::json::parse(&golden_read(dir.join("record.json")).unwrap()).unwrap();
        if comparable(&golden, &stage) != comparable(&filed, &stage) {
            let (a, b) = (comparable(&golden, &stage), comparable(&filed, &stage));
            let line = a.lines().zip(b.lines()).position(|(x, y)| x != y).unwrap_or(0);
            return Err(format!("filed record differs at line {}: {:?} vs {:?}", line + 1, a.lines().nth(line), b.lines().nth(line)));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&out.temp);
    let _ = std::fs::remove_file(&store);
    result
}

/// Whether `qnet-cli run` can be compared with the corpus here, else a printed note.
fn run_corpus_ready() -> bool {
    if staged_solver_root().is_none() {
        eprintln!("skipped: the staged solvers are absent (scripts/stage-solvers.sh)");
        return false;
    }
    if !root().join("golden/runs/PROVENANCE.json").is_file() {
        eprintln!("skipped: golden/runs/PROVENANCE.json is missing");
        return false;
    }
    true
}

#[test]
fn run_prints_what_0_90_34s_shell_showed_and_files_the_record_0_90_34_filed() {
    if !run_corpus_ready() {
        return;
    }
    let cases = [
        ("10stationtandem.inf", "product_form"),   // a Python solver
        ("3dtandem.inf", "regenerative_mc"),       // the C engine, a fixed seed
        ("10stationtandem.inf", "regenerative_mc"), // a run that fails (exit 2)
        ("MM1K.d1.c1.fin", "generic_ctmc"),       // finite buffers
        ("10stationtandem.inf", "qbd"),            // a refusal: exit 1 and 0.90.34's sentences
        ("10stationtandem.inf", "qna"),            // an analytic table with the Jackson column
        ("2dtandem", "sim"),                       // a seeded simulation with a progress bar
    ];
    let failures: Vec<String> = cases.iter().filter_map(|(e, m)| check_run(e, m).err().map(|why| format!("{e} {m}: {why}"))).collect();
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn run_full_prints_the_full_precision_archive() {
    if !run_corpus_ready() {
        return;
    }
    let dir = root().join("golden/runs/10stationtandem.inf/product_form");
    let out = cli_run("product_form", "10stationtandem.inf", &["--full"], "full");
    let (gtemp, gpid) = golden_temp_and_pid(&dir);
    let theirs = normalize(&golden_read(dir.join("archive.txt")).unwrap(), &gtemp, &gpid);
    let mine = normalize(&out.stdout, &out.temp.display().to_string(), &out.pid.to_string());
    let _ = std::fs::remove_dir_all(&out.temp);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(mine, theirs);
}

#[test]
fn run_refuses_a_method_the_networks_run_menu_does_not_offer_and_usage_errors_exit_2() {
    let out = cli_run("sm", "10stationtandem.inf", &[], "not-in-menu");
    let _ = std::fs::remove_dir_all(&out.temp);
    assert_eq!(out.code, 1);
    assert_eq!(out.stderr, "qnet-cli: Spectral isn't in the Run menu for a network with infinite buffers.\n");
    let (code, _, err) = cli(&["run", "nope", "x.bnet"]);
    assert_eq!(code, 2);
    assert!(err.starts_with("There's no method called “nope”."), "{err}");
    let (code, _, err) = cli(&["run", "qna", "x.bnet", "--set", "sim.replications"]);
    assert_eq!((code, err.as_str()), (2, "--set takes key=value, not “sim.replications”.\n"));
}

/// Review finding FIX-202: `analyze`, `primitives` and `dump-rho` read a network with batch
/// arrivals or priorities as a plain one (the batch example printed ρ = 0.24 for a load of 0.6).
#[test]
fn the_reports_do_not_read_a_batch_or_priority_network_as_plain() {
    let batch = root().join("examples/extended/BatchArrivals.mx-m-1.geometric.bnet");
    let priority = root().join("examples/extended/PriorityHelpDesk.mg1.2class.bnet");
    for command in ["analyze", "primitives", "dump-rho"] {
        let (code, out, err) = cli(&[command, batch.to_str().unwrap()]);
        assert_eq!((code, err.as_str()), (0, ""), "{command}");
        assert!(out.contains("S1: α=0.600000  μ_eff=1.000000  c=1.000000  ρ=0.600000"), "{command}: {out}");
        assert!(out.contains("This network uses batch arrivals at Src1."), "{command}: {out}");
        assert!(!out.contains("0.2400") && !out.contains("Jackson") && !out.contains("RELIABILITY"), "{command}: {out}");

        let (code, out, _) = cli(&[command, priority.to_str().unwrap()]);
        assert_eq!(code, 0, "{command}");
        assert!(out.contains("This network uses priority service at ") && out.contains("ρ=0.700000"), "{command}: {out}");
        assert!(!out.contains("skew") && !out.contains("RELIABILITY") && !out.contains("Covariance"), "{command}: {out}");
    }
    // No solver input is written for such a network: every exporter would write a plain one.
    let (code, out, err) = cli(&["export", "qna", batch.to_str().unwrap()]);
    assert_eq!((code, out.as_str()), (1, ""));
    assert!(err.contains("This network uses batch arrivals at Src1. A solver input file does not model that"), "{err}");
    let folder = std::env::temp_dir().join(format!("qnet-cli-export-refusal-{}", std::process::id()));
    let (code, _, err) = cli(&["export-all", priority.to_str().unwrap(), folder.to_str().unwrap()]);
    assert!(code == 1 && err.contains("priority service") && !folder.exists(), "{err}");
    // `describe` claims no diffusion model and warns at the customer rate (ρ = 0.6, not 0.24).
    let (_, described, _) = cli(&["describe", batch.to_str().unwrap()]);
    assert!(described.contains("\"srbm\" : null") && !described.contains("low utilization"), "{described}");
}
