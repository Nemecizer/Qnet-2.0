//! Whole jobs through the registry, with real processes: single flight across tabs, lifecycle
//! messages to the owning tab, the stderr policy, progress files, temporary files removed after
//! success, failure, Stop, a Stop before the first spawn, and a panic, and the acceptance check of
//! PLAN P3 (a Stop during a long job leaves no process and no temp file; INV-053, INV-058), ported
//! from 0.90.34's `validation/gui_runtime_contracts.sh` cancellation gate with the staged
//! `jackson_sim` when it is present.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use qnet_runner::supervisor::*;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-supervisor-job-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn sh(script: &str) -> ProcessSpec {
    ProcessSpec::new("/bin/sh").arg("-c").arg(script)
}

fn group_gone(pgid: u32) -> bool {
    // SAFETY: kill with signal 0 only checks for existence.
    let rc = unsafe { libc::kill(-(pgid as libc::pid_t), 0) };
    rc == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

type Events = Arc<Mutex<Vec<RunEvent>>>;

fn collector() -> (Reporter, Events) {
    let seen: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    (Arc::new(move |e: &RunEvent| sink.lock().unwrap().push(e.clone())), seen)
}

fn statuses(events: &Events) -> Vec<(String, Severity)> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            RunEvent::Status { text, severity } => Some((text.clone(), *severity)),
            _ => None,
        })
        .collect()
}

fn owner(title: &str) -> RunOwner {
    RunOwner { id: format!("tab-{title}"), title: title.into() }
}

/// Writes a temp input the way a method does, and returns its path.
fn write_input(job: &mut Job, dir: &Path, name: &str) -> PathBuf {
    let path = job.register_temp(dir.join(name));
    fs::write(&path, b"input").unwrap();
    path
}

#[test]
fn a_successful_run_streams_its_output_keeps_the_archive_and_removes_its_temp_files() {
    let dir = scratch("success");
    let registry = RunRegistry::new();
    let (reporter, events) = collector();
    let sink = CollectSink::default();
    let shown = Arc::clone(&sink.buffer);
    let finished = Arc::clone(&sink.finished);
    let ticket = registry.begin("qna", owner("Tandem"), reporter).unwrap();
    let mut input = PathBuf::new();
    let report = run_job(ticket, Box::new(sink), |job| {
        job.status("Running QNA...", Severity::Info);
        input = write_input(job, &dir, "BNET_qna_1.qna");
        job.emit_str("[Threads] Single-threaded (analytical solver)\n");
        let step = Step::new(sh(&format!("cat '{}'; echo; echo 'rho_1 0.700000001' ", input.display()))).stderr_policy("QNA");
        let outcome = job.run_step(&step).unwrap();
        job.emit_elapsed_footer();
        outcome.shell_code()
    });
    assert_eq!(report.summary.exit_code, 0);
    assert!(report.summary.text().starts_with("QNA finished in 0."));
    assert_eq!(report.summary.label, "QNA");
    assert_eq!(report.summary.owner, owner("Tandem"));
    let text = report.archive_text();
    assert!(text.starts_with("[Threads] Single-threaded (analytical solver)\ninput\nrho_1 0.700000001\nElapsed time: 0."), "{text}");
    assert!(text.ends_with("s\n\n"));
    assert_eq!(shown.lock().unwrap().as_slice(), report.archive.as_slice());
    assert!(*finished.lock().unwrap());
    assert!(!input.exists());
    assert!(registry.active().is_none());
    let all = events.lock().unwrap().clone();
    assert_eq!(all.first(), Some(&RunEvent::Status { text: "Running QNA...".into(), severity: Severity::Info }));
    assert_eq!(all.last(), Some(&RunEvent::Finished(report.summary.clone())));
    assert_eq!(statuses(&events).len(), 1, "no failure line for a run that succeeded");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_step_shows_its_stderr_logs_it_and_logs_the_outcome_as_an_error() {
    let dir = scratch("failure");
    let registry = RunRegistry::new();
    let (reporter, events) = collector();
    let ticket = registry.begin("sbd", owner("Tandem"), reporter).unwrap();
    let mut input = PathBuf::new();
    let report = run_job(ticket, Box::new(NullSink), |job| {
        input = write_input(job, &dir, "BNET_sbd_1.qna");
        let step = Step::new(sh("echo partial; echo 'ERROR: singular matrix' >&2; exit 4")).stderr_policy("SBD");
        job.run_step(&step).unwrap().shell_code()
    });
    assert_eq!(report.summary.exit_code, 4);
    assert!(report.summary.text().starts_with("SBD failed (exit 4) after 0."));
    assert_eq!(report.archive_text(), "partial\n\n⚠ SBD failed (exit 4):\nERROR: singular matrix\n");
    let lines = statuses(&events);
    assert_eq!(lines[0], ("⚠ SBD failed (exit 4):".into(), Severity::Info));
    assert_eq!(lines[1], ("ERROR: singular matrix".into(), Severity::Error));
    assert_eq!(lines[2], (report.summary.text(), Severity::Error));
    assert_eq!(lines.len(), 3);
    assert!(!input.exists());
    assert!(matches!(report.summary.record_disposition(), RecordDisposition::Fail(_)));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_clean_exit_logs_only_the_warning_like_stderr_lines() {
    let registry = RunRegistry::new();
    let (reporter, events) = collector();
    let ticket = registry.begin("qna", owner("Tandem"), reporter).unwrap();
    let report = run_job(ticket, Box::new(NullSink), |job| {
        let step = Step::new(sh("echo 'iteration 3' >&2; echo 'WARNING: Kumar-Seidman network may be unstable' >&2; echo ok"))
            .stderr_policy("QNA");
        job.run_step(&step).unwrap().shell_code()
    });
    assert_eq!(report.archive_text(), "ok\n");
    assert_eq!(
        statuses(&events),
        vec![
            ("⚠ QNA warnings:".into(), Severity::Info),
            ("WARNING: Kumar-Seidman network may be unstable".into(), Severity::Warning),
        ]
    );
}

#[test]
fn a_second_run_from_another_tab_is_refused_while_the_first_runs() {
    let registry = RunRegistry::new();
    let (first_reporter, first_events) = collector();
    let ticket = registry.begin("inf_cmp", owner("Feedback"), first_reporter).unwrap();
    let handle = spawn_job(ticket, Box::new(NullSink), |job| {
        job.run_step(&Step::new(ProcessSpec::new("/bin/sleep").arg("0.6"))).unwrap().shell_code()
    });
    thread::sleep(Duration::from_millis(100));
    let (second_reporter, second_events) = collector();
    let refused = registry.begin("sim", owner("Tandem"), second_reporter).err().unwrap();
    let expected =
        "Monte Carlo was not started because Run Comparison is already running for “Feedback”. Stop or wait for that run first.";
    assert_eq!(refused.message, expected);
    assert_eq!(statuses(&second_events), vec![(expected.to_string(), Severity::Warning)]);
    let active = registry.active().unwrap();
    assert_eq!(active.owner, owner("Feedback"));
    assert_eq!(active.display_label, "Run Comparison");
    let report = handle.join().unwrap();
    assert!(report.summary.succeeded());
    assert!(statuses(&first_events).is_empty());
    assert!(registry.begin("sim", owner("Tandem"), collector().0).is_ok());
}

#[test]
fn stop_during_a_long_job_leaves_no_process_and_no_temp_file_and_skips_later_steps() {
    let dir = scratch("stop");
    let registry = RunRegistry::new();
    let (reporter, events) = collector();
    let ticket = registry.begin("cmp", owner("Tandem"), reporter).unwrap();
    let pid = Arc::new(Mutex::new(None));
    let seen_pid = Arc::clone(&pid);
    let marker = dir.join("second-step-ran");
    let marker_in_job = marker.clone();
    let dir_in_job = dir.clone();
    let handle = spawn_job(ticket, Box::new(NullSink), move |job| {
        write_input(job, &dir_in_job, "BNET_cmp_sm_1.in");
        // A solver that ignores SIGINT and SIGTERM, with a grandchild that does too.
        let first = Step::new(sh("trap '' INT TERM; sleep 30 & sleep 30; wait")).stderr_policy("Spectral Method");
        let outcome = job.run_step(&first).unwrap();
        *seen_pid.lock().unwrap() = outcome.pid;
        // A comparison carries on after a failed method; after Stop the next one never starts.
        let second = Step::new(ProcessSpec::new("/usr/bin/touch").arg(&marker_in_job)).stderr_policy("QNA");
        let next = job.run_step(&second).unwrap();
        assert_eq!(next.exit, ExitKind::NotStarted);
        70
    });
    thread::sleep(Duration::from_millis(400));
    assert_eq!(registry.stop().as_deref(), Some("Run Comparison"));
    let stopped = Instant::now();
    let report = handle.join().unwrap();
    let took = stopped.elapsed();
    assert!(took < Duration::from_millis(3600), "the run took {took:?} to end after Stop");
    let pgid = pid.lock().unwrap().unwrap();
    assert!(group_gone(pgid), "a process of the stopped run survived");
    assert!(!marker.exists());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "a temp file survived Stop");
    assert_eq!(report.summary.exit_code, 128 + libc::SIGKILL);
    assert!(report.summary.user_stopped);
    assert!(report.summary.cancelled());
    assert!(report.summary.text().starts_with("Run Comparison cancelled after 3."), "{}", report.summary.text());
    assert_eq!(report.summary.record_disposition(), RecordDisposition::Delete);
    // A Stop is not a failure: the only Status line is the Stop's own.
    assert_eq!(statuses(&events), vec![("Run Comparison cancelled.".to_string(), Severity::Warning)]);
    assert!(registry.active().is_none());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn stop_before_the_first_step_means_nothing_is_spawned_and_the_run_is_cancelled() {
    let dir = scratch("early-stop");
    let registry = RunRegistry::new();
    let (reporter, _events) = collector();
    let ticket = registry.begin("sim", owner("Tandem"), reporter).unwrap();
    registry.stop();
    let marker = dir.join("ran");
    let mut input = PathBuf::new();
    let report = run_job(ticket, Box::new(NullSink), |job| {
        input = write_input(job, &dir, "BNET_sim_1.sim");
        let progress = job.progress_file("sim");
        let step = Step::new(ProcessSpec::new("/usr/bin/touch").arg(&marker)).progress(&progress);
        let outcome = job.run_step(&step).unwrap();
        assert!(!progress.exists());
        outcome.shell_code()
    });
    assert_eq!(report.summary.exit_code, 130);
    assert!(report.summary.cancelled());
    assert!(!marker.exists());
    assert!(!input.exists());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_run_stopped_as_its_last_step_succeeds_is_reported_finished() {
    let registry = RunRegistry::new();
    let ticket = registry.begin("qna", owner("Tandem"), collector().0).unwrap();
    let report = run_job(ticket, Box::new(NullSink), |job| {
        let outcome = job.run_step(&Step::new(sh("echo done"))).unwrap();
        job.cancel_token().cancel();
        outcome.shell_code()
    });
    assert!(report.summary.user_stopped);
    assert!(report.summary.succeeded());
    assert!(!report.summary.cancelled());
    assert!(report.summary.text().starts_with("QNA finished in"));
}

#[test]
fn a_panic_in_the_method_still_removes_temp_files_kills_the_step_and_frees_the_slot() {
    let dir = scratch("panic");
    let registry = RunRegistry::new();
    let (reporter, events) = collector();
    let ticket = registry.begin("mlmc", owner("Tandem"), reporter).unwrap();
    let pid = Arc::new(Mutex::new(None::<u32>));
    let seen = Arc::clone(&pid);
    let mut input = PathBuf::new();
    let started = Instant::now();
    let report = run_job(ticket, Box::new(NullSink), |job| {
        input = write_input(job, &dir, "qnet_mlmc_1.json");
        let step = Step::new(sh("echo $$; exec sleep 30"));
        let tick = |_: &mut JobOutput, t: &StepTick| {
            if t.elapsed > Duration::from_millis(300) {
                panic!("aggregator bug");
            }
        };
        let mut record = |out: &mut JobOutput, t: &StepTick| {
            if let Ok(text) = std::str::from_utf8(out.archive()) {
                *seen.lock().unwrap() = text.trim().parse().ok();
            }
            tick(out, t)
        };
        job.run_step_with(&step, Duration::from_millis(50), &mut record).unwrap().shell_code()
    });
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(report.summary.exit_code, -1);
    assert!(report.summary.text().starts_with("SRBM MLMC failed (exit -1) after"));
    let lines = statuses(&events);
    assert_eq!(lines[0], ("SRBM MLMC stopped on an internal error: aggregator bug".into(), Severity::Error));
    assert_eq!(lines[1], (report.summary.text(), Severity::Error));
    assert!(group_gone(pid.lock().unwrap().expect("pid seen")));
    assert!(!input.exists());
    assert!(registry.active().is_none());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_solver_that_cannot_start_ends_the_run_with_exit_minus_one_and_says_so() {
    let registry = RunRegistry::new();
    let (reporter, events) = collector();
    let ticket = registry.begin("fm", owner("Tandem"), reporter).unwrap();
    let report = run_job(ticket, Box::new(NullSink), |job| {
        match job.run_step(&Step::new(ProcessSpec::new("/nonexistent/qnet/bna_fm"))) {
            Ok(o) => o.shell_code(),
            Err(e) => {
                let message = format!("{} could not start: {e}", job.display_label());
                job.could_not_start(message);
                0
            }
        }
    });
    assert_eq!(report.summary.exit_code, -1);
    let lines = statuses(&events);
    assert!(lines[0].0.starts_with("Finite Element could not start: "));
    assert_eq!(lines[0].1, Severity::Error);
    assert_eq!(lines[1], (report.summary.text(), Severity::Error));
}

#[test]
fn progress_is_polled_every_half_second_from_the_first_usable_file_and_drawn_by_step_ticks() {
    let dir = scratch("progress");
    let registry = RunRegistry::new();
    let (reporter, events) = collector();
    let ticket = registry.begin("sim", owner("Tandem"), reporter).unwrap();
    let mut counts = Vec::new();
    let mut progress_path = PathBuf::new();
    let report = run_job(ticket, Box::new(NullSink), |job| {
        job.set_temp_dir(&dir);
        progress_path = job.progress_file("sim");
        let spec = ProcessSpec::new("/bin/sh")
            .arg("-c")
            .arg("printf '4\\n' >> \"$1\"; sleep 0.3; printf '..' >> \"$1\"; sleep 1.0; printf '..' >> \"$1\"; sleep 0.2")
            .arg("sh")
            .arg(&progress_path);
        let step = Step::new(spec).progress(&progress_path);
        let mut draw = |out: &mut JobOutput, t: &StepTick| {
            if let Some(c) = t.progress {
                counts.push((c.done, c.total));
                out.emit_str(&format!("\r{}/{}", c.done, c.total));
            }
        };
        let code = job.run_step_with(&step, Duration::from_millis(100), &mut draw).unwrap().shell_code();
        job.emit_str("\n");
        code
    });
    assert!(report.summary.succeeded());
    assert!(!progress_path.exists());
    assert!(counts.contains(&(2, 4)), "{counts:?}");
    assert!(counts.windows(2).all(|w| w[0].0 <= w[1].0));
    assert!(report.archive_text().contains("\r2/4"));
    let fractions: Vec<Option<f64>> = events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            RunEvent::Progress(p) => Some(p.fraction),
            _ => None,
        })
        .collect();
    assert!(fractions.len() >= 2, "{fractions:?}");
    assert!(fractions.contains(&Some(0.5)), "{fractions:?}");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    fs::remove_dir_all(dir).unwrap();
}

/// 0.90.34's cancellation gate (`validation/gui_runtime_contracts.sh`): a real long `jackson_sim`
/// run, stopped the way the app stops it, must be gone inside the deadline. jackson_sim keeps
/// running after SIGINT, so this exercises the SIGTERM rung with a real solver.
#[test]
fn a_stopped_jackson_sim_is_gone_inside_the_deadline() {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let sim = home.join("Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsim/jackson_sim");
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("../solvers/infinite/BNAsim/example_m2.sim");
    if !sim.is_file() || !input.is_file() {
        eprintln!("note: staged jackson_sim not found; skipping the run-cancellation gate");
        return;
    }
    let dir = scratch("jackson");
    let registry = RunRegistry::new();
    let (reporter, events) = collector();
    let ticket = registry.begin("inf_sim", owner("Feedback"), reporter).unwrap();
    let pid = Arc::new(Mutex::new(None));
    let seen = Arc::clone(&pid);
    let job_dir = dir.clone();
    let handle = spawn_job(ticket, Box::new(NullSink), move |job| {
        job.set_temp_dir(&job_dir);
        let net = job.temp_path("BNET_inf_sim_1.sim");
        // Read and write, not fs::copy: Dropbox's file provider can refuse the clone-copy macOS
        // uses for a same-volume copy (EPERM), and the input lives in the repository.
        fs::write(&net, fs::read(&input).unwrap()).unwrap();
        let progress = job.progress_file("inf_sim");
        let out = job.temp_path("BNET_inf_sim_out_1.txt");
        let spec = ProcessSpec::new(&sim)
            .arg(&net)
            .args(["-c", "-n", "4", "-w", "1000", "-r", "1000000000", "-s", "1", "-P"])
            .arg(&progress)
            .stdout_to(&out);
        let step = Step::new(spec).stderr_policy("Simulation").progress(&progress);
        let outcome = job.run_step(&step).unwrap();
        *seen.lock().unwrap() = outcome.pid;
        outcome.shell_code()
    });
    thread::sleep(Duration::from_millis(1200));
    let active = registry.active().unwrap();
    assert_eq!(active.fraction, Some(0.0), "the solver announced its total");
    assert_eq!(active.status_text(), "0% · 0:01");
    registry.stop();
    let stopped = Instant::now();
    let report = handle.join().unwrap();
    assert!(stopped.elapsed() < KILL_AFTER + Duration::from_millis(500), "{:?}", stopped.elapsed());
    assert!(group_gone(pid.lock().unwrap().unwrap()), "jackson_sim survived Stop");
    assert!(report.summary.cancelled());
    assert!(statuses(&events).iter().all(|(t, _)| !t.contains("failed")));
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "a temp file survived Stop");
    fs::remove_dir_all(dir).unwrap();
}
