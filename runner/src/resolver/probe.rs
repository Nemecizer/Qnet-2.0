//! The two short launches the resolver makes before trusting a file (0.90.34
//! `SolverRuntimeResolver.swift` `launchProbe`, `loaderFailureMessage`, `launchPythonProbe` and
//! `compactProbeMessage`).
//!
//! A native solver is started with `--qnet-loadability-probe` and given 0.8 s: anything the
//! dynamic loader says on stderr ("Library not loaded", "dyld[", a bad signature) rejects it, and
//! any other ending, including still running at the deadline, proves the loader got as far as
//! `main`. A Python interpreter is asked to import the modules a solver needs and print its own
//! version, within 2 s. Both stop an overrunning child the way 0.90.34's `Process.terminate()`
//! did: SIGTERM, 0.2 s, SIGKILL, 0.2 s.
//!
//! Where 2.0 differs: 0.90.34 read the native probe's stderr pipe to its end after the child
//! exited, which would block for as long as a grandchild kept the pipe open; here the pipe is
//! drained on a thread and read at most 0.5 s after the child has gone. A launch error's text is
//! the operating system's sentence (`strerror`), not Foundation's `localizedDescription`.

use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// What a probe concluded: whether the file can be used, and the sentence that says why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProbeResult {
    pub loadable: bool,
    pub detail: String,
}

impl ProbeResult {
    fn no(detail: impl Into<String>) -> Self {
        ProbeResult { loadable: false, detail: detail.into() }
    }
}

/// The grace period after SIGTERM, and again after SIGKILL (0.90.34's two `0.2` waits).
const GRACE: Duration = Duration::from_millis(200);

/// How long the native probe waits for its stderr pipe to close once the child has gone.
const STDERR_DRAIN: Duration = Duration::from_millis(500);

/// The text of the Python preflight's `-c` argument, exactly as 0.90.34 sent it.
pub(crate) const PYTHON_PROBE_CODE: &str = "import importlib, sys; \
[importlib.import_module(name) for name in sys.argv[1:]]; \
print(f'{sys.executable} (Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro})')";

/// The stderr phrases (compared in lower case) that mean the dynamic loader refused the file.
pub(crate) const LOADER_FAILURE_MARKERS: [&str; 9] = [
    "library not loaded",
    "dyld:",
    "dyld[",
    "symbol not found",
    "dependent dylib",
    "code signature invalid",
    "mapped file has no cdhash",
    "bad cpu type in executable",
    "exec format error",
];

/// Starts `path` with `--qnet-loadability-probe` (stdin and stdout null, stderr captured, the
/// working directory its own folder, `QNET_RUNTIME_PROBE=1` added to `env`) and judges it.
pub(crate) fn launch_native_probe(path: &Path, env: &[(OsString, OsString)], timeout: Duration) -> ProbeResult {
    let mut command = Command::new(path);
    command
        .arg("--qnet-loadability-probe")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .current_dir(path.parent().unwrap_or(Path::new("/")))
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .env("QNET_RUNTIME_PROBE", "1");
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return ProbeResult::no(format!("could not launch: {}", os_sentence(&error))),
    };

    // Drain stderr on a thread so a chatty child cannot block on a full pipe.
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    if let Some(mut pipe) = child.stderr.take() {
        let buffer = Arc::clone(&buffer);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buffer.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]),
                }
            }
            let _ = done_tx.send(());
        });
    } else {
        drop(done_tx);
    }

    let finished = wait_until(&mut child, timeout);
    let timed_out = finished.is_none();
    let status = match finished {
        Some(status) => Some(status),
        None => stop(&mut child).1,
    };
    let _ = done_rx.recv_timeout(STDERR_DRAIN);
    let bytes = buffer.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let message = String::from_utf8_lossy(&bytes).trim().to_string();
    if let Some(failure) = loader_failure_message(&message) {
        return ProbeResult::no(failure);
    }
    if timed_out {
        // Reaching user code for the whole probe interval proves dyld completed.
        return ProbeResult {
            loadable: true,
            detail: "dynamic loader probe passed (process reached user code)".to_string(),
        };
    }
    // A usage error is expected: the solvers share no help flag, and exiting from main still
    // shows that the loader worked.
    ProbeResult {
        loadable: true,
        detail: format!("dynamic loader probe passed (probe exit status {})", status.map_or(0, termination_status)),
    }
}

/// The loader's own words when stderr carries one of the markers: its first eight lines on one
/// line, or a fixed sentence if those are empty. None when the loader said nothing.
pub(crate) fn loader_failure_message(stderr: &str) -> Option<String> {
    let lower = stderr.to_lowercase();
    if !LOADER_FAILURE_MARKERS.iter().any(|m| lower.contains(m)) {
        return None;
    }
    let compact = first_lines(stderr, 8);
    Some(if compact.is_empty() { "the dynamic loader rejected the executable".to_string() } else { compact })
}

/// Runs `<interpreter> -B -c <PYTHON_PROBE_CODE> <modules…>` in `cwd` with
/// `PYTHONDONTWRITEBYTECODE=1`, its output going to `qnet-python-probe-<uuid>.out` and `.err` in
/// the temporary folder (removed afterwards), and judges it.
pub(crate) fn launch_python_probe(
    interpreter: &Path,
    modules: &[String],
    cwd: &Path,
    env: &[(OsString, OsString)],
    timeout: Duration,
) -> ProbeResult {
    let token = uuid_string();
    let tmp = std::env::temp_dir();
    let out_path = tmp.join(format!("qnet-python-probe-{token}.out"));
    let err_path = tmp.join(format!("qnet-python-probe-{token}.err"));
    let _cleanup = RemoveOnDrop(vec![out_path.clone(), err_path.clone()]);
    let (out_file, err_file) = match (File::create(&out_path), File::create(&err_path)) {
        (Ok(o), Ok(e)) => (o, e),
        _ => return ProbeResult::no("could not create temporary files for the Python preflight"),
    };

    let mut command = Command::new(interpreter);
    command
        .arg("-B")
        .arg("-c")
        .arg(PYTHON_PROBE_CODE)
        .args(modules)
        .stdin(Stdio::null())
        .stdout(out_file)
        .stderr(err_file)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .env("PYTHONDONTWRITEBYTECODE", "1");
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ProbeResult::no(format!("could not launch {}: {}", interpreter.display(), os_sentence(&error)))
        }
    };

    let finished = wait_until(&mut child, timeout);
    let read = |p: &Path| std::fs::read(p).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default();
    let status = match finished {
        Some(status) => status,
        None => {
            let (terminated, _) = stop(&mut child);
            return ProbeResult::no(format!(
                "Python preflight timed out after {} seconds{}",
                qnet_core::cfmt::f("%.2f", timeout.as_secs_f64()),
                if terminated { "" } else { "; process did not terminate promptly after SIGKILL" }
            ));
        }
    };
    let stdout = read(&out_path).trim().to_string();
    let stderr = read(&err_path).trim().to_string();

    let code = termination_status(status);
    if code != 0 {
        let raw = if stderr.is_empty() { &stdout } else { &stderr };
        let compact = compact_probe_message(raw);
        let suffix = if compact.is_empty() { String::new() } else { format!(": {compact}") };
        return ProbeResult::no(format!("Python preflight exited with status {code}{suffix}"));
    }
    ProbeResult {
        loadable: true,
        detail: if stdout.is_empty() {
            format!("Python preflight passed with {}", interpreter.display())
        } else {
            format!("Python preflight passed with {}", compact_probe_message(&stdout))
        },
    }
}

/// A child's message shortened for one diagnostic line: its first eight non-empty lines joined
/// by spaces, then at most 800 characters (0.90.34 `compactProbeMessage`; it counted grapheme
/// clusters, this counts Unicode scalars, which differs only for combined characters).
pub(crate) fn compact_probe_message(message: &str) -> String {
    first_lines(message, 8).chars().take(800).collect()
}

/// Swift's `split(whereSeparator: \Character.isNewline).prefix(n).joined(separator: " ")`.
fn first_lines(text: &str, n: usize) -> String {
    text.split(is_newline).filter(|l| !l.is_empty()).take(n).collect::<Vec<_>>().join(" ")
}

/// Swift's `Character.isNewline` for single scalars (CR LF is one Character, and splitting on
/// both while dropping empty pieces gives the same lines).
pub(crate) fn is_newline(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

/// Foundation's `terminationStatus`: the exit code, or the signal number for a killed child.
fn termination_status(status: ExitStatus) -> i32 {
    status.code().or_else(|| status.signal()).unwrap_or(0)
}

/// Polls the child until it ends or `timeout` passes.
fn wait_until(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(2)));
    }
}

/// SIGTERM, 0.2 s, SIGKILL, 0.2 s. Returns whether the child has ended and its status. A child
/// that outlives all of that is reaped on a background thread so it never stays a zombie.
fn stop(child: &mut Child) -> (bool, Option<ExitStatus>) {
    // SAFETY: kill(2) on our own child's pid, which has not been reaped yet.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    if let Some(status) = wait_until(child, GRACE) {
        return (true, Some(status));
    }
    let _ = child.kill();
    if let Some(status) = wait_until(child, GRACE) {
        return (true, Some(status));
    }
    let pid = child.id() as libc::pid_t;
    std::thread::spawn(move || {
        let mut status = 0;
        // SAFETY: waitpid on our own child's pid, which nothing else will reap.
        unsafe {
            libc::waitpid(pid, &mut status, 0);
        }
    });
    (false, None)
}

/// The operating system's sentence for a launch error, without Rust's " (os error N)".
fn os_sentence(error: &std::io::Error) -> String {
    let text = error.to_string();
    match text.find(" (os error ") {
        Some(i) => text[..i].to_string(),
        None => text,
    }
}

/// An upper-case version-4 UUID, as Foundation's `UUID().uuidString` writes one.
pub(crate) fn uuid_string() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut b = [0u8; 16];
    let random = File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_ok();
    if !random {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos() as u64);
        let mix = nanos ^ ((std::process::id() as u64) << 32) ^ COUNTER.fetch_add(1, Ordering::Relaxed);
        b[..8].copy_from_slice(&mix.to_le_bytes());
        b[8..].copy_from_slice(&nanos.rotate_left(17).to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: Vec<String> = b.iter().map(|x| format!("{x:02X}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        h[0..4].concat(),
        h[4..6].concat(),
        h[6..8].concat(),
        h[8..10].concat(),
        h[10..16].concat()
    )
}

/// Removes the listed files when dropped, on every return path.
struct RemoveOnDrop(Vec<PathBuf>);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loader_message_is_recognised_in_any_case_and_compacted_to_one_line() {
        let text = "dyld[123]: Library not loaded: /opt/x.dylib\n  Referenced from: a\r\n  Reason: b";
        assert_eq!(
            loader_failure_message(text).as_deref(),
            Some("dyld[123]: Library not loaded: /opt/x.dylib   Referenced from: a   Reason: b")
        );
        assert_eq!(loader_failure_message("usage: bnet <file>"), None);
        assert!(loader_failure_message("EXEC FORMAT ERROR").is_some());
    }

    #[test]
    fn a_compact_message_keeps_eight_lines_and_800_characters() {
        let many: String = (1..=10).map(|i| format!("line{i}\n\n")).collect();
        assert_eq!(compact_probe_message(&many), "line1 line2 line3 line4 line5 line6 line7 line8");
        let long = "x".repeat(1000);
        assert_eq!(compact_probe_message(&long).len(), 800);
    }

    #[test]
    fn a_uuid_has_foundations_shape() {
        let u = uuid_string();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!(u.chars().all(|c| c == '-' || c.is_ascii_digit() || c.is_ascii_uppercase()));
        assert_ne!(u, uuid_string());
    }

    #[test]
    fn the_python_probe_code_is_0_90_34s() {
        assert_eq!(
            PYTHON_PROBE_CODE,
            "import importlib, sys; [importlib.import_module(name) for name in sys.argv[1:]]; print(f'{sys.executable} (Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro})')"
        );
    }
}
