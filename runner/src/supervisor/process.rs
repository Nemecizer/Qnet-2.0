//! Running one program as a supervised child: an argument vector (no shell), explicit environment
//! additions, a working directory, standard input from `/dev/null`, its own process group, standard
//! output streamed to a callback as it arrives (or redirected to a file), standard error kept
//! separately, and the Stop ladder.
//!
//! This replaces the part of 0.90.34's generated bash wrapper that ran a solver and the part of
//! `TerminalModel` that watched it (`tickRun`, `captureActiveRunGroup`, `activeRunGroupIsAlive`,
//! `cancelSurvivorsOutstanding`, `signalActiveRun`, `cancelEscalateAfter` = 1.5 s,
//! `cancelDeadline` = 3 s, `cancelAbandonAfter` = 10 s; ledger RUN-048, RUN-049, INV-009, INV-057,
//! SH-087). The ladder is 0.90.34's: SIGINT to the process group when Stop is requested (sent by
//! [`CancelToken::cancel`]), SIGTERM once 1.5 s later, SIGKILL once at 3 s if the group still has
//! members, and the step is over only when the group has no members left, or after 10 s, when the
//! group is stuck in the kernel and nothing more can be sent.
//!
//! Where 2.0 differs, deliberately (D1): the child is started in a process group of its own
//! (`setpgid(0, 0)` in the child), so the group is known from the first instant and is never the
//! app's or the user's shell's; there is no wrapper pid to wait for. And when a child exits normally
//! but leaves members of its group behind (a background job it forked), they are killed after a
//! 1 s grace, so a finished step never leaves a process running; 0.90.34's `tee` would instead have
//! waited for them, and its wrapper left any that did not hold the pipe running. No staged solver
//! does either.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use super::cancel::{group_alive, signal_group, CancelToken};
use super::summary::CANCELLED_EXIT_CODE;

/// Seconds after the Stop request before SIGTERM is sent too (0.90.34's `cancelEscalateAfter`).
pub const ESCALATE_AFTER: Duration = Duration::from_millis(1500);
/// Seconds after the Stop request before SIGKILL is sent to a group that still has members
/// (0.90.34's `cancelDeadline`).
pub const KILL_AFTER: Duration = Duration::from_secs(3);
/// Seconds after the Stop request after which a group that outlived SIGKILL is given up on
/// (0.90.34's `cancelAbandonAfter`).
pub const ABANDON_AFTER: Duration = Duration::from_secs(10);
/// How long members of a group may outlive a child that exited by itself before they are killed.
pub const ORPHAN_GRACE: Duration = Duration::from_secs(1);
/// How often the supervising loop wakes when nothing arrives: the ladder's resolution.
const POLL: Duration = Duration::from_millis(20);
/// How long to wait for the end of a pipe once the whole group is gone (only a process that left
/// the group with `setsid` can still hold it).
const EOF_GRACE: Duration = Duration::from_millis(500);

/// Where a step's standard output goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdoutTarget {
    /// Streamed to the hooks as it arrives and kept in [`ProcessOutcome::stdout`].
    Capture,
    /// Written to this file (created or truncated), as a `> file` redirect did.
    File(PathBuf),
    /// Discarded.
    Null,
}

/// Where a step's standard error goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StderrTarget {
    /// Kept whole in [`ProcessOutcome::stderr`], for the stderr policy.
    Capture,
    /// Interleaved with standard output in arrival order, as `2>&1` did. With
    /// [`StdoutTarget::File`] it goes to the same file; with [`StdoutTarget::Null`] it is discarded.
    MergeWithStdout,
    /// Discarded.
    Null,
}

/// What to run: one program with its arguments, never through a shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSpec {
    /// The executable's path.
    pub program: PathBuf,
    /// Arguments after the program name.
    pub args: Vec<OsString>,
    /// Environment variables added to (or replacing in) the app's own environment.
    pub env: Vec<(OsString, OsString)>,
    /// The working directory, or the app's when `None`.
    pub cwd: Option<PathBuf>,
    /// Where standard output goes.
    pub stdout: StdoutTarget,
    /// Where standard error goes.
    pub stderr: StderrTarget,
}

impl ProcessSpec {
    /// A spec that runs `program` with no arguments, capturing both streams.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            stdout: StdoutTarget::Capture,
            stderr: StderrTarget::Capture,
        }
    }

    /// Adds one argument.
    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Adds several arguments.
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Adds an environment variable.
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Sets the working directory.
    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    /// Sends standard output to a file instead of the hooks.
    pub fn stdout_to(mut self, path: impl Into<PathBuf>) -> Self {
        self.stdout = StdoutTarget::File(path.into());
        self
    }

    /// Sets where standard error goes.
    pub fn stderr(mut self, target: StderrTarget) -> Self {
        self.stderr = target;
        self
    }
}

/// How a process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitKind {
    /// It exited with this status.
    Exited(i32),
    /// A signal ended it.
    Signaled(i32),
    /// Stop was requested before it could be spawned, so it never ran.
    NotStarted,
    /// Its group outlived SIGKILL and was given up on; the process may still exist.
    Abandoned,
}

/// A signal of the Stop ladder and when it was sent, measured from the Stop request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalSent {
    /// SIGINT, SIGTERM or SIGKILL.
    pub signal: i32,
    /// Time from the Stop request to the signal.
    pub after: Duration,
}

/// What a supervised process did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutcome {
    /// How it ended.
    pub exit: ExitKind,
    /// Its pid, which is also its process group id; `None` when it never started.
    pub pid: Option<u32>,
    /// Time from spawn to the end of supervision.
    pub elapsed: Duration,
    /// Everything it wrote to a captured standard output (with standard error when merged).
    pub stdout: Vec<u8>,
    /// Everything it wrote to a captured standard error.
    pub stderr: Vec<u8>,
    /// True when Stop was requested before supervision ended (or before it began).
    pub stop_requested: bool,
    /// The ladder's signals, in order.
    pub signals: Vec<SignalSent>,
}

impl ProcessOutcome {
    /// The exit status a shell would have reported: the exit status, 128 + the signal, 130 for a
    /// step that Stop prevented or a group given up on.
    pub fn shell_code(&self) -> i32 {
        match self.exit {
            ExitKind::Exited(code) => code,
            ExitKind::Signaled(signal) => 128 + signal,
            ExitKind::NotStarted | ExitKind::Abandoned => CANCELLED_EXIT_CODE,
        }
    }

    /// True when the step was ended (or prevented) by a Stop: Stop was requested and the step did
    /// not exit 0.
    pub fn interrupted(&self) -> bool {
        self.stop_requested && self.shell_code() != 0
    }
}

/// Callbacks a supervised process makes on the supervising thread.
pub trait ProcessHooks {
    /// A chunk of standard output, in arrival order, as soon as it has been read.
    fn stdout(&mut self, _chunk: &[u8]) {}
    /// Called about every `tick_every` while the process runs.
    fn tick(&mut self) {}
}

/// Hooks that do nothing.
pub struct NoHooks;
impl ProcessHooks for NoHooks {}

impl<F: FnMut(&[u8])> ProcessHooks for F {
    fn stdout(&mut self, chunk: &[u8]) {
        self(chunk)
    }
}

enum Msg {
    Out(Vec<u8>),
    OutEof,
    Err(Vec<u8>),
}

/// Runs `spec` to its end under `cancel`, calling `hooks` on this thread. Returns an error only when
/// the process could not be spawned (or its output file could not be created); a Stop requested
/// before the spawn returns [`ExitKind::NotStarted`] without spawning.
pub fn run_process(
    spec: &ProcessSpec,
    cancel: &CancelToken,
    tick_every: Duration,
    hooks: &mut dyn ProcessHooks,
) -> io::Result<ProcessOutcome> {
    let (tx, rx) = mpsc::channel::<Msg>();
    let spawned = cancel.spawn_unless_cancelled(|| {
        let (child, readers) = spawn(spec, &tx)?;
        let pgid = child.id() as libc::pid_t;
        Ok(((child, readers), pgid))
    });
    drop(tx);
    let (child, readers) = match spawned {
        None => {
            return Ok(ProcessOutcome {
                exit: ExitKind::NotStarted,
                pid: None,
                elapsed: Duration::ZERO,
                stdout: Vec::new(),
                stderr: Vec::new(),
                stop_requested: true,
                signals: Vec::new(),
            })
        }
        Some(result) => result?,
    };
    let pid = child.id();
    let mut live = LiveGroup { pgid: pid as libc::pid_t, child: Some(child), cancel: cancel.clone() };
    let outcome = supervise(&mut live, readers, rx, cancel, tick_every, hooks);
    live.disarm();
    Ok(outcome)
}

struct Readers {
    stdout: bool,
    stderr: bool,
}

fn spawn(spec: &ProcessSpec, tx: &Sender<Msg>) -> io::Result<(Child, Readers)> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args).stdin(Stdio::null()).process_group(0);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    if let Some(dir) = &spec.cwd {
        cmd.current_dir(dir);
    }
    let mut merged_reader = None;
    match (&spec.stdout, &spec.stderr) {
        (StdoutTarget::Capture, StderrTarget::MergeWithStdout) => {
            let (reader, writer) = io::pipe()?;
            cmd.stdout(writer.try_clone()?).stderr(writer);
            merged_reader = Some(reader);
        }
        (StdoutTarget::File(path), StderrTarget::MergeWithStdout) => {
            let file = File::create(path)?;
            cmd.stdout(file.try_clone()?).stderr(file);
        }
        (stdout, stderr) => {
            cmd.stdout(match stdout {
                StdoutTarget::Capture => Stdio::piped(),
                StdoutTarget::File(path) => Stdio::from(File::create(path)?),
                StdoutTarget::Null => Stdio::null(),
            });
            cmd.stderr(match stderr {
                StderrTarget::Capture => Stdio::piped(),
                StderrTarget::MergeWithStdout | StderrTarget::Null => Stdio::null(),
            });
        }
    }
    let mut child = cmd.spawn()?;
    // The command holds the parent's copies of the write ends; drop it so the pipes can reach EOF.
    drop(cmd);
    let mut readers = Readers { stdout: false, stderr: false };
    let out: Option<Box<dyn Read + Send>> = match merged_reader {
        Some(r) => Some(Box::new(r)),
        None => child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>),
    };
    if let Some(mut out) = out {
        readers.stdout = true;
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                match out.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(Msg::Out(buf[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = tx.send(Msg::OutEof);
        });
    }
    if let Some(mut err) = child.stderr.take() {
        readers.stderr = true;
        let tx = tx.clone();
        thread::spawn(move || {
            let mut all = Vec::new();
            let _ = err.read_to_end(&mut all);
            let _ = tx.send(Msg::Err(all));
        });
    }
    Ok((child, readers))
}

/// The supervising loop: streams output, reaps the child, runs the ladder after Stop and waits for
/// the group to empty.
fn supervise(
    live: &mut LiveGroup,
    readers: Readers,
    rx: Receiver<Msg>,
    cancel: &CancelToken,
    tick_every: Duration,
    hooks: &mut dyn ProcessHooks,
) -> ProcessOutcome {
    let started = Instant::now();
    let pgid = live.pgid;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_open = readers.stdout;
    let mut stderr_open = readers.stderr;
    let mut status = None;
    let mut child_exit_at: Option<Instant> = None;
    let mut group_gone_at: Option<Instant> = None;
    let mut term_sent: Option<Instant> = None;
    let mut kill_sent: Option<Instant> = None;
    let mut orphans_killed = false;
    let mut abandoned = false;
    let mut next_tick = started + tick_every;
    let mut sigints: Option<Vec<Instant>> = None;

    loop {
        let wait = POLL.min(next_tick.saturating_duration_since(Instant::now()));
        match rx.recv_timeout(wait) {
            Ok(Msg::Out(chunk)) => {
                hooks.stdout(&chunk);
                stdout.extend_from_slice(&chunk);
            }
            Ok(Msg::OutEof) => stdout_open = false,
            Ok(Msg::Err(bytes)) => {
                stderr = bytes;
                stderr_open = false;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                stdout_open = false;
                stderr_open = false;
            }
        }
        let now = Instant::now();
        if status.is_none() {
            if let Some(child) = live.child.as_mut() {
                if let Ok(Some(s)) = child.try_wait() {
                    status = Some(s);
                    child_exit_at = Some(now);
                    live.child = None;
                }
            }
        }
        let alive = group_alive(pgid);
        if !alive && status.is_some() && group_gone_at.is_none() {
            group_gone_at = Some(now);
            // Forget the group under the token's lock at once, so a late Stop cannot signal an id
            // the system may hand to someone else.
            sigints = Some(cancel.forget_group());
        }

        if let Some(requested) = cancel.requested_at() {
            let waited = now.saturating_duration_since(requested);
            if alive && term_sent.is_none() && waited >= ESCALATE_AFTER && cancel.signal_recorded_group(libc::SIGTERM) {
                term_sent = Some(now);
            }
            if alive && kill_sent.is_none() && waited >= KILL_AFTER && cancel.signal_recorded_group(libc::SIGKILL) {
                kill_sent = Some(now);
            }
            if alive && waited >= ABANDON_AFTER {
                abandoned = true;
                break;
            }
        } else if alive && !orphans_killed {
            if let Some(exited) = child_exit_at {
                if now.saturating_duration_since(exited) >= ORPHAN_GRACE {
                    orphans_killed = true;
                    signal_group(pgid, libc::SIGKILL);
                }
            }
        }

        if status.is_some() && !alive {
            if !stdout_open && !stderr_open {
                break;
            }
            if group_gone_at.is_some_and(|t| now.saturating_duration_since(t) >= EOF_GRACE) {
                break;
            }
        }
        if now >= next_tick {
            hooks.tick();
            next_tick = now + tick_every;
        }
    }

    let sigints = sigints.unwrap_or_else(|| cancel.forget_group());
    let requested = cancel.requested_at();
    let mut signals: Vec<SignalSent> = Vec::new();
    if let Some(requested) = requested {
        let mut push = |signal: i32, at: Instant| {
            signals.push(SignalSent { signal, after: at.saturating_duration_since(requested) })
        };
        for at in sigints {
            push(libc::SIGINT, at);
        }
        if let Some(at) = term_sent {
            push(libc::SIGTERM, at);
        }
        if let Some(at) = kill_sent {
            push(libc::SIGKILL, at);
        }
    }
    signals.sort_by_key(|s| s.after);
    let exit = if abandoned && status.is_none() {
        ExitKind::Abandoned
    } else {
        match status {
            Some(s) => match (s.code(), s.signal()) {
                (Some(code), _) => ExitKind::Exited(code),
                (None, Some(sig)) => ExitKind::Signaled(sig),
                (None, None) => ExitKind::Exited(-1),
            },
            None => ExitKind::Abandoned,
        }
    };
    if abandoned {
        // Never leave a zombie behind: reap the child on a thread of its own if it ever exits.
        if let Some(mut child) = live.child.take() {
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    ProcessOutcome {
        exit,
        pid: Some(pgid as u32),
        elapsed: started.elapsed(),
        stdout,
        stderr,
        stop_requested: requested.is_some(),
        signals,
    }
}

/// The running child and its group, killed and reaped if supervision unwinds (a hook panicked)
/// before the group was seen to be empty.
struct LiveGroup {
    pgid: libc::pid_t,
    child: Option<Child>,
    cancel: CancelToken,
}

impl LiveGroup {
    fn disarm(&mut self) {
        self.pgid = 0;
        self.child = None;
    }
}

impl Drop for LiveGroup {
    fn drop(&mut self) {
        if self.pgid > 1 {
            signal_group(self.pgid, libc::SIGKILL);
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            self.cancel.forget_group();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_codes_follow_bash() {
        let mut o = ProcessOutcome {
            exit: ExitKind::Exited(3),
            pid: None,
            elapsed: Duration::ZERO,
            stdout: vec![],
            stderr: vec![],
            stop_requested: false,
            signals: vec![],
        };
        assert_eq!(o.shell_code(), 3);
        o.exit = ExitKind::Signaled(libc::SIGINT);
        assert_eq!(o.shell_code(), 130);
        o.exit = ExitKind::Signaled(libc::SIGTERM);
        assert_eq!(o.shell_code(), 143);
        o.exit = ExitKind::Signaled(libc::SIGKILL);
        assert_eq!(o.shell_code(), 137);
        o.exit = ExitKind::NotStarted;
        assert_eq!(o.shell_code(), 130);
        assert!(!o.interrupted());
        o.stop_requested = true;
        assert!(o.interrupted());
        o.exit = ExitKind::Exited(0);
        assert!(!o.interrupted(), "a step that finished in the instant of Stop is not interrupted");
    }

    #[test]
    fn the_spec_builder_collects_arguments_environment_and_redirects() {
        let spec = ProcessSpec::new("/bin/echo")
            .arg("a")
            .args(["b", "c"])
            .env("K", "V")
            .cwd("/tmp")
            .stdout_to("/tmp/out.txt")
            .stderr(StderrTarget::MergeWithStdout);
        assert_eq!(spec.args, vec![OsString::from("a"), "b".into(), "c".into()]);
        assert_eq!(spec.env, vec![(OsString::from("K"), OsString::from("V"))]);
        assert_eq!(spec.cwd, Some(PathBuf::from("/tmp")));
        assert_eq!(spec.stdout, StdoutTarget::File("/tmp/out.txt".into()));
        assert_eq!(spec.stderr, StderrTarget::MergeWithStdout);
    }
}
