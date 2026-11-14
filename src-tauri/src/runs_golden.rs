//! P6's acceptance for running (PLAN.md §7 P6): every Run-menu method, started through the same
//! code the Run menu's command uses (`runs::start`, with the settings handed over as the page holds
//! them), files the Results record Qnet 0.90.34 filed for it, and writes 0.90.34's Status lines.
//!
//! For each method, the first example (in name order) whose golden run launched and took 0.90.34
//! at most `FAST_SECONDS` is run with the staged solvers, the corpus's settings
//! (`RunSettings::golden()`, given as the stored keys a settings.json holds) and the corpus Mac's
//! CPU and OpenMP thread counts, as P3's own golden tests run them (runner/tests/common). The record
//! is compared after removing what differs between any two runs: ids, dates, elapsed time, the tab
//! id, the application version, the raw output and the source file's location.
//!
//! Skipped with a note when the staged solvers (scripts/stage-solvers.sh) or golden/runs/ are
//! missing. The Bramson94 LP run that HiGHS fails on the corpus's Mac (P3) is never chosen: the LP
//! uses a faster example first.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qnet_core::json::{self, Json};
use qnet_runner::methods::{Method, RunSettings};
use qnet_runner::resolver::{Resolver, ResolverConfig};
use serde_json::Value;

use super::{start_with, RunMessage, Runs, StartRequest};

const FAST_SECONDS: f64 = 20.0;

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
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn staged_resolver() -> Option<Arc<Resolver>> {
    let home = std::env::var_os("HOME")?;
    let solvers = PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources");
    if !solvers.join("bin").is_dir() {
        return None;
    }
    let mut cfg = ResolverConfig::from_process();
    cfg.bundle_resources = None;
    cfg.env.insert(OsString::from("QNET_SOLVER_ROOT"), solvers.into_os_string());
    Some(Arc::new(Resolver::new(cfg)))
}

/// How long 0.90.34's run took, from its summary ("… in 0.3 s", "… in 1:05").
fn golden_seconds(dir: &Path) -> f64 {
    let summary = golden_read(dir.join("summary.txt")).unwrap_or_default();
    let last = summary.trim().rsplit(' ').collect::<Vec<_>>();
    match last.as_slice() {
        ["s", secs, ..] => secs.parse().unwrap_or(f64::MAX),
        [clock, ..] if clock.contains(':') => clock.split(':').fold(0.0, |a, p| a * 60.0 + p.parse::<f64>().unwrap_or(0.0)),
        _ => f64::MAX,
    }
}

/// The CPU count the golden wrapper printed in its thread banner, if any.
fn golden_cpu_count(dir: &Path) -> Option<usize> {
    let script = golden_read(dir.join("script.sh")).ok()?;
    let at = script.find("printf '[Threads]")?;
    let rest = &script[at + "printf '".len()..];
    let close = rest.find("' ")?;
    rest[close + 2..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
}

fn first_fast_example(method: Method) -> Option<(String, PathBuf)> {
    let mut examples: Vec<String> = std::fs::read_dir(root().join("golden/runs")).ok()?.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    examples.sort();
    let usable = |ex: &String, completed: bool| {
        let dir = root().join("golden/runs").join(ex).join(method.label());
        let ok = dir.join("exit.txt").is_file() && dir.join("record.json").is_file() && golden_seconds(&dir) <= FAST_SECONDS && !ex.starts_with("Bramson94.d3");
        let status_ok = !completed || golden_read(dir.join("record.json")).is_ok_and(|r| r.contains("\"status\" : \"completed\""));
        (ok && status_ok).then(|| (ex.clone(), dir))
    };
    // A run 0.90.34 completed says more than one it failed; failed ones only when there is no other.
    examples.iter().find_map(|ex| usable(ex, true)).or_else(|| examples.iter().find_map(|ex| usable(ex, false)))
}

/// A record with what differs between any two runs removed (P3's `comparable_record`, plus the
/// source file's location, which is the corpus copy's path there and the repository's here).
fn comparable(record: &Json) -> Json {
    let Json::Object(map) = record else { return record.clone() };
    let mut out = BTreeMap::new();
    for (k, v) in map {
        match k.as_str() {
            "id" | "startedAt" | "completedAt" | "elapsedSeconds" | "rawOutput" => {}
            "provenance" => {
                let mut p = v.as_object().cloned().unwrap_or_default();
                for drop in ["tabID", "applicationVersion", "sourceFileURL"] {
                    p.remove(drop);
                }
                out.insert(k.clone(), Json::Object(p));
            }
            "measurements" => {
                let ms = v.as_array().unwrap_or(&[]).iter().map(|m| {
                    let mut m = m.as_object().cloned().unwrap_or_default();
                    m.remove("id");
                    Json::Object(m)
                });
                out.insert(k.clone(), Json::Array(ms.collect()));
            }
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Json::Object(out)
}

#[test]
fn every_run_menu_method_started_from_the_interface_files_0_90_34s_record() {
    let Some(resolver) = staged_resolver() else {
        println!("skipped: the staged solvers are absent (scripts/stage-solvers.sh)");
        return;
    };
    if !root().join("golden/runs/PROVENANCE.json").is_file() {
        println!("skipped: golden/runs/ is missing");
        return;
    }
    // The corpus Mac's 18 OpenMP threads (rbm_mlmc's estimates depend on them), as P3's tests set.
    std::env::set_var("OMP_NUM_THREADS", "18");
    let golden = RunSettings::golden();
    let settings: BTreeMap<String, Value> = RunSettings::KEYS.iter().map(|k| (k.to_string(), Value::String(golden.get(k).unwrap()))).collect();
    let store_dir = std::env::temp_dir().join(format!("qnet-runs-golden-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&store_dir);
    std::fs::create_dir_all(&store_dir).unwrap();
    let runs = Runs::with_resolver(store_dir.join("results-v1.json"), resolver);

    let mut checked = Vec::new();
    let mut problems = Vec::new();
    let all: Vec<Method> = Method::INFINITE.iter().chain(Method::FINITE.iter()).copied().collect();
    for method in all {
        if checked.iter().any(|(m, _): &(Method, String)| *m == method) {
            continue;
        }
        let Some((example, dir)) = first_fast_example(method) else {
            println!("{}: no golden run within {FAST_SECONDS} s; not checked here (P3's tests cover it)", method.label());
            continue;
        };
        let file = root().join("examples").join(format!("{example}.bnet"));
        let document: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let messages = Arc::new(Mutex::new(Vec::<RunMessage>::new()));
        let emit = {
            let messages = messages.clone();
            Arc::new(move |m: RunMessage| messages.lock().unwrap().push(m))
        };
        let req = StartRequest {
            tab_id: "C0000000-0000-4000-8000-000000000006".into(),
            title: format!("{example}.bnet"),
            document,
            method: method.label().into(),
            settings: settings.clone(),
            overrides: BTreeMap::new(),
            source_path: Some(file.to_string_lossy().into_owned()),
        };
        let cpus = golden_cpu_count(&dir);
        let (outcome, finisher) = start_with(&runs, req, emit, Arc::new(|_: &str| {}), |ctx| {
            if let Some(n) = cpus {
                ctx.cpu_count = n;
            }
        })
        .unwrap();
        if !outcome.started {
            problems.push(format!("{} on {example}: did not start ({:?})", method.label(), messages.lock().unwrap()));
            continue;
        }
        finisher.unwrap().join().unwrap();
        let msgs = messages.lock().unwrap().clone();
        let Some(RunMessage::Finished { record_id: Some(id), .. }) = msgs.iter().rev().find(|m| matches!(m, RunMessage::Finished { .. })).cloned() else {
            problems.push(format!("{} on {example}: no record filed", method.label()));
            continue;
        };
        let ours = runs.store.lock().unwrap().record(&id).and_then(|r| r.to_json().ok()).unwrap();
        let theirs = json::parse(&golden_read(dir.join("record.json")).unwrap()).unwrap();
        let (a, b) = (json::to_pretty(&comparable(&ours)), json::to_pretty(&comparable(&theirs)));
        if a != b {
            let line = a.lines().zip(b.lines()).position(|(x, y)| x != y).unwrap_or(0);
            problems.push(format!(
                "{} on {example}: record differs at line {line}:\n  2.0:    {}\n  0.90.34: {}",
                method.label(),
                a.lines().nth(line).unwrap_or(""),
                b.lines().nth(line).unwrap_or("")
            ));
        }
        // 0.90.34's own Status lines come first and in its order (the solver's stderr inbox and a
        // failure's summary line, placed as P3's rules 1–2 say, are P3's tests' to compare).
        let expected: Vec<(String, String)> = golden_read(dir.join("status.txt"))
            .unwrap()
            .lines()
            .filter_map(|l| l.split_once('\t').map(|(s, t)| (s.to_string(), t.to_string())))
            .filter(|(s, _)| s != "error")
            .collect();
        let got: Vec<(String, String)> = msgs
            .iter()
            .filter_map(|m| match m {
                RunMessage::Status { text, severity } => Some((severity.to_string(), text.clone())),
                _ => None,
            })
            .collect();
        if got.len() < expected.len() || got[..expected.len()] != expected[..] {
            problems.push(format!("{} on {example}: Status lines {got:?}, 0.90.34 {expected:?}", method.label()));
        }
        let status = theirs.as_object().and_then(|o| o.get("status")).and_then(|s| s.as_str()).unwrap_or("?").to_string();
        let measured = ours.as_object().and_then(|o| o.get("measurements")).and_then(|m| m.as_array()).map_or(0, |m| m.len());
        checked.push((method, format!("{example}: {status}, {measured} measurements")));
    }
    let _ = std::fs::remove_dir_all(&store_dir);
    println!("checked: {checked:?}");
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    assert!(checked.len() >= 18, "only {} methods had a fast golden run", checked.len());
}
