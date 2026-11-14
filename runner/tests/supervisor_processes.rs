//! The process runner and the Stop ladder, with real processes: `/bin/sleep`, and `sh -c` scripts
//! that fork background children and ignore SIGINT or SIGTERM the way 0.90.34's wrapper made a
//! solver ignore them. Each Stop test checks that the step's process group has no member left
//! (`kill(-pgid, 0)` fails with ESRCH) when the runner returns, and when each signal was sent
//! (ledger RUN-048, RUN-049, INV-009, INV-057, INV-058).

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use qnet_runner::supervisor::*;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-supervisor-proc-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn sh(script: &str) -> ProcessSpec {
    ProcessSpec::new("/bin/sh").arg("-c").arg(script)
}

/// True when process group `pgid` has no member at all.
fn group_gone(pgid: u32) -> bool {
    // SAFETY: kill with signal 0 only checks for existence.
    let rc = unsafe { libc::kill(-(pgid as libc::pid_t), 0) };
    rc == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// Runs `spec` on a thread, requests Stop after `stop_after`, and returns the outcome and the time
/// from the Stop request to the runner's return.
fn run_and_stop(spec: ProcessSpec, stop_after: Duration) -> (ProcessOutcome, Duration) {
    let token = CancelToken::new();
    let runner_token = token.clone();
    let handle = thread::spawn(move || run_process(&spec, &runner_token, Duration::from_secs(60), &mut NoHooks).unwrap());
    thread::sleep(stop_after);
    token.cancel();
    let requested = token.requested_at().unwrap();
    let outcome = handle.join().unwrap();
    (outcome, requested.elapsed())
}

fn signals(outcome: &ProcessOutcome) -> Vec<i32> {
    outcome.signals.iter().map(|s| s.signal).collect()
}

#[test]
fn standard_output_is_streamed_in_order_as_it_arrives() {
    let mut seen: Vec<(Vec<u8>, Instant)> = Vec::new();
    let mut hooks = |chunk: &[u8]| seen.push((chunk.to_vec(), Instant::now()));
    let started = Instant::now();
    let outcome = run_process(
        &sh("printf first; sleep 0.4; printf second; sleep 0.1; printf third"),
        &CancelToken::new(),
        Duration::from_secs(60),
        &mut hooks,
    )
    .unwrap();
    let ended = Instant::now();
    assert_eq!(outcome.exit, ExitKind::Exited(0));
    let joined: Vec<u8> = seen.iter().flat_map(|(c, _)| c.clone()).collect();
    assert_eq!(joined, b"firstsecondthird");
    assert_eq!(outcome.stdout, b"firstsecondthird");
    // "first" reached the hook well before the process ended, not at the end.
    assert_eq!(seen[0].0, b"first");
    assert!(seen[0].1.duration_since(started) < Duration::from_millis(300));
    assert!(ended.duration_since(seen[0].1) >= Duration::from_millis(300));
}

#[test]
fn standard_error_is_kept_apart_and_the_exit_status_is_reported() {
    let outcome = run_process(
        &sh("echo out; echo err >&2; echo more; exit 3"),
        &CancelToken::new(),
        Duration::from_secs(60),
        &mut NoHooks,
    )
    .unwrap();
    assert_eq!(outcome.exit, ExitKind::Exited(3));
    assert_eq!(outcome.shell_code(), 3);
    assert_eq!(outcome.stdout, b"out\nmore\n");
    assert_eq!(outcome.stderr, b"err\n");
    assert!(!outcome.stop_requested);
    assert!(group_gone(outcome.pid.unwrap()));
}

#[test]
fn merged_standard_error_interleaves_in_arrival_order() {
    let spec = sh("echo 1; sleep 0.05; echo 2 >&2; sleep 0.05; echo 3").stderr(StderrTarget::MergeWithStdout);
    let outcome = run_process(&spec, &CancelToken::new(), Duration::from_secs(60), &mut NoHooks).unwrap();
    assert_eq!(outcome.stdout, b"1\n2\n3\n");
    assert!(outcome.stderr.is_empty());
}

#[test]
fn standard_output_can_go_to_a_file_instead() {
    let dir = scratch("file");
    let out = dir.join("out.txt");
    let spec = sh("echo to-file; echo e >&2").stdout_to(&out);
    let outcome = run_process(&spec, &CancelToken::new(), Duration::from_secs(60), &mut NoHooks).unwrap();
    assert_eq!(fs::read(&out).unwrap(), b"to-file\n");
    assert!(outcome.stdout.is_empty());
    assert_eq!(outcome.stderr, b"e\n");
    let merged = sh("echo a; echo b >&2").stdout_to(&out).stderr(StderrTarget::MergeWithStdout);
    run_process(&merged, &CancelToken::new(), Duration::from_secs(60), &mut NoHooks).unwrap();
    assert_eq!(fs::read(&out).unwrap(), b"a\nb\n");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn arguments_go_through_without_a_shell_with_the_environment_and_folder_given() {
    let dir = scratch("env");
    let spec = ProcessSpec::new("/bin/sh")
        .args(["-c", "printf '%s|%s|%s' \"$1\" \"$QNET_SUPERVISOR_TEST\" \"$(pwd -P)\"", "sh", "a b; $HOME"])
        .env("QNET_SUPERVISOR_TEST", "yes")
        .cwd(&dir);
    let outcome = run_process(&spec, &CancelToken::new(), Duration::from_secs(60), &mut NoHooks).unwrap();
    let expected = format!("a b; $HOME|yes|{}", fs::canonicalize(&dir).unwrap().display());
    assert_eq!(String::from_utf8(outcome.stdout).unwrap(), expected);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn standard_input_is_empty() {
    let outcome = run_process(&ProcessSpec::new("/bin/cat"), &CancelToken::new(), Duration::from_secs(60), &mut NoHooks).unwrap();
    assert_eq!(outcome.exit, ExitKind::Exited(0));
    assert!(outcome.stdout.is_empty());
}

#[test]
fn every_process_leads_a_group_of_its_own_never_the_apps() {
    let outcome = run_process(&sh("ps -o pgid= -p $$"), &CancelToken::new(), Duration::from_secs(60), &mut NoHooks).unwrap();
    let pgid: u32 = String::from_utf8(outcome.stdout).unwrap().trim().parse().unwrap();
    assert_eq!(Some(pgid), outcome.pid);
    // SAFETY: getpgrp has no preconditions.
    assert_ne!(pgid as libc::pid_t, unsafe { libc::getpgrp() });
}

#[test]
fn a_program_that_cannot_be_spawned_is_an_error() {
    let err = run_process(
        &ProcessSpec::new("/nonexistent/qnet/solver"),
        &CancelToken::new(),
        Duration::from_secs(60),
        &mut NoHooks,
    )
    .unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn a_stop_before_the_spawn_means_the_process_never_runs() {
    let dir = scratch("never");
    let marker = dir.join("ran");
    let token = CancelToken::new();
    token.cancel();
    let spec = ProcessSpec::new("/usr/bin/touch").arg(&marker);
    let outcome = run_process(&spec, &token, Duration::from_secs(60), &mut NoHooks).unwrap();
    assert_eq!(outcome.exit, ExitKind::NotStarted);
    assert_eq!(outcome.pid, None);
    assert_eq!(outcome.shell_code(), 130);
    assert!(outcome.interrupted());
    thread::sleep(Duration::from_millis(100));
    assert!(!marker.exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn sigint_alone_ends_a_process_that_does_not_ignore_it() {
    let (outcome, after_stop) = run_and_stop(ProcessSpec::new("/bin/sleep").arg("30"), Duration::from_millis(200));
    assert_eq!(outcome.exit, ExitKind::Signaled(libc::SIGINT));
    assert_eq!(outcome.shell_code(), 130);
    assert_eq!(signals(&outcome), vec![libc::SIGINT]);
    assert!(outcome.signals[0].after < Duration::from_millis(50));
    assert!(after_stop < Duration::from_secs(1), "{after_stop:?}");
    assert!(group_gone(outcome.pid.unwrap()));
}

#[test]
fn background_children_that_ignore_sigint_get_sigterm_at_one_and_a_half_seconds() {
    // A non-interactive shell starts background jobs with SIGINT ignored: the 0.90.34 solver that
    // survived the wrapper's death and kept every core busy.
    let (outcome, after_stop) = run_and_stop(sh("sleep 30 & sleep 30 & wait"), Duration::from_millis(300));
    assert_eq!(signals(&outcome), vec![libc::SIGINT, libc::SIGTERM]);
    let term = outcome.signals[1].after;
    assert!(term >= ESCALATE_AFTER && term < ESCALATE_AFTER + Duration::from_millis(200), "{term:?}");
    assert!(after_stop >= ESCALATE_AFTER && after_stop < Duration::from_millis(2500), "{after_stop:?}");
    assert!(group_gone(outcome.pid.unwrap()));
    assert!(outcome.interrupted());
}

#[test]
fn a_group_that_ignores_sigint_and_sigterm_gets_sigkill_at_three_seconds() {
    let (outcome, after_stop) =
        run_and_stop(sh("trap '' INT TERM; sleep 30 & sleep 30 & wait"), Duration::from_millis(300));
    assert_eq!(signals(&outcome), vec![libc::SIGINT, libc::SIGTERM, libc::SIGKILL]);
    let kill = outcome.signals[2].after;
    assert!(kill >= KILL_AFTER && kill < KILL_AFTER + Duration::from_millis(200), "{kill:?}");
    assert!(after_stop >= KILL_AFTER && after_stop < Duration::from_millis(3600), "{after_stop:?}");
    assert_eq!(outcome.exit, ExitKind::Signaled(libc::SIGKILL));
    assert!(group_gone(outcome.pid.unwrap()));
}

#[test]
fn a_finished_child_is_not_done_while_its_group_survives_a_stop() {
    // The leader exits at once on SIGINT; the grandchildren ignore SIGINT and SIGTERM. The step is
    // over only when SIGKILL has emptied the group (RUN-049).
    let (outcome, after_stop) = run_and_stop(
        sh("(trap '' INT TERM; sleep 30) & (trap '' INT TERM; sleep 30) & wait"),
        Duration::from_millis(300),
    );
    assert_eq!(signals(&outcome), vec![libc::SIGINT, libc::SIGTERM, libc::SIGKILL]);
    assert!(after_stop >= KILL_AFTER, "{after_stop:?}");
    assert!(group_gone(outcome.pid.unwrap()));
}

#[test]
fn a_second_stop_sends_sigint_again_without_moving_the_deadlines() {
    let token = CancelToken::new();
    let runner = token.clone();
    let spec = sh("trap '' INT; sleep 30 & wait");
    let handle = thread::spawn(move || run_process(&spec, &runner, Duration::from_secs(60), &mut NoHooks).unwrap());
    thread::sleep(Duration::from_millis(200));
    assert!(token.cancel());
    thread::sleep(Duration::from_millis(300));
    assert!(!token.cancel());
    let outcome = handle.join().unwrap();
    assert_eq!(signals(&outcome), vec![libc::SIGINT, libc::SIGINT, libc::SIGTERM]);
    assert!(outcome.signals[2].after >= ESCALATE_AFTER);
    assert!(group_gone(outcome.pid.unwrap()));
}

#[test]
fn members_left_behind_by_a_child_that_exited_by_itself_are_ended() {
    let started = Instant::now();
    let outcome = run_process(
        &sh("sleep 30 >/dev/null 2>&1 & sleep 30 & echo done"),
        &CancelToken::new(),
        Duration::from_secs(60),
        &mut NoHooks,
    )
    .unwrap();
    assert_eq!(outcome.exit, ExitKind::Exited(0));
    assert_eq!(outcome.stdout, b"done\n");
    assert!(started.elapsed() >= ORPHAN_GRACE && started.elapsed() < Duration::from_secs(3));
    assert!(group_gone(outcome.pid.unwrap()));
}

#[test]
fn the_tick_hook_runs_while_the_process_does() {
    struct Ticks(Arc<Mutex<u32>>);
    impl ProcessHooks for Ticks {
        fn tick(&mut self) {
            *self.0.lock().unwrap() += 1;
        }
    }
    let count = Arc::new(Mutex::new(0));
    let started = std::time::Instant::now();
    run_process(
        &ProcessSpec::new("/bin/sleep").arg("0.5"),
        &CancelToken::new(),
        Duration::from_millis(100),
        &mut Ticks(Arc::clone(&count)),
    )
    .unwrap();
    // One tick per 100 ms the process was alive: at least 3 for a 0.5 s sleep, and no more than
    // the measured run allows (a loaded machine stretches the sleep, so the bound is measured).
    let n = *count.lock().unwrap();
    let most = started.elapsed().as_millis() as u32 / 100 + 1;
    assert!(n >= 3 && n <= most, "{n} ticks in {:?}", started.elapsed());
}

#[test]
fn a_panicking_hook_still_kills_and_reaps_the_group() {
    struct Boom;
    impl ProcessHooks for Boom {
        fn tick(&mut self) {
            panic!("hook failed");
        }
    }
    let token = CancelToken::new();
    let pid = Arc::new(Mutex::new(None));
    let seen = Arc::clone(&pid);
    struct Recorder(Arc<Mutex<Option<u32>>>);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_process(
            &sh("echo $$; exec sleep 30"),
            &token,
            Duration::from_millis(200),
            &mut BoomAfterPid { pid: Recorder(seen), inner: Boom },
        )
    }));
    assert!(result.is_err());
    let pgid = pid.lock().unwrap().expect("the child reported its pid");
    assert!(group_gone(pgid));

    struct BoomAfterPid {
        pid: Recorder,
        inner: Boom,
    }
    impl ProcessHooks for BoomAfterPid {
        fn stdout(&mut self, chunk: &[u8]) {
            let text = String::from_utf8_lossy(chunk);
            *self.pid.0.lock().unwrap() = text.trim().parse().ok();
        }
        fn tick(&mut self) {
            if self.pid.0.lock().unwrap().is_some() {
                self.inner.tick();
            }
        }
    }
}
