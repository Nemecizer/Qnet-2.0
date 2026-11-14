//! The Shell pane (PLAN.md §7 P6, docs/specs/shell.md, PARITY §12): the user's own login shell in
//! a pseudo-terminal, drawn by xterm.js in the page (src/panes/shell/).
//!
//! One shell per app (INV-008): `shell_start` starts it the first time the pane is shown
//! (SH-011) and, called again while it lives (a reloaded page), hands its output to the new
//! channel rather than starting another. Only `shell_stop` (Restart Shell) ends it. Output goes to
//! the page as base64 bytes on the `Channel`, chunk by chunk as the reader gets it; keystrokes
//! come back with `shell_input`; the pane's size with `shell_resize` (TIOCSWINSZ).
//!
//! Nothing is ever typed into this shell by the app (decision D1): runs are started by the
//! supervisor (runs.rs) and their output is written into the terminal view by the page.
//!
//! The transcript (the bytes the view was fed, kept by the page because run output never passes
//! through the PTY) is saved and loaded here, in `shell.savedRawBytes` in the data folder.

mod pty;
mod transcript;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::errors::{ErrorKind, QnError};

pub use pty::{Event, Session, Spawn};

/// What the shell sends the page.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShellMessage {
    /// Bytes from the PTY, base64.
    Output { data: String },
    /// The shell exited (the header's dot turns red and offers Restart, SH-009/010).
    #[serde(rename_all = "camelCase")]
    Exited { code: Option<i32>, generation: u64 },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStarted {
    pub pid: i32,
    /// The program, e.g. /bin/zsh.
    pub shell: String,
    /// The starting directory (the header shows it until the first OSC 7).
    pub cwd: String,
    /// Bumped by every new shell; an Exited from an older one is ignored.
    pub generation: u64,
    /// True when an existing shell was handed to this channel instead of a new one started.
    pub reattached: bool,
}

/// The app's one shell and its transcript file.
pub struct Shell {
    session: Mutex<Option<Session>>,
    generation: AtomicU64,
    transcript: PathBuf,
}

impl Shell {
    pub fn new(data_dir: &Path) -> Shell {
        Shell { session: Mutex::new(None), generation: AtomicU64::new(0), transcript: transcript::path_in(data_dir) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// The environment 0.90.34 gave its shell (TerminalConsoleView.swift `buildTerminal`, SH-003…005),
/// plus a UTF-8 locale when the app was started without one (Finder gives a GUI app none).
pub fn login_environment(inherited: &dyn Fn(&str) -> Option<String>) -> (Vec<(String, String)>, Vec<String>) {
    let mut env: Vec<(String, String)> = [
        ("TERM", "xterm-256color"),
        ("CLICOLOR", "1"),
        ("CLICOLOR_FORCE", "1"),
        ("LSCOLORS", "ExfxcxdxDxegedabagacad"),
        // Load-bearing: /etc/zshrc_Apple_Terminal installs the precmd hook that sends OSC 7 (the
        // header's directory) only when TERM_PROGRAM is Apple_Terminal.
        ("TERM_PROGRAM", "Apple_Terminal"),
        // Qnet keeps its own transcript; macOS's shell sessions also need TERM_SESSION_ID.
        ("SHELL_SESSIONS_DISABLE", "1"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    if inherited("LANG").is_none() && inherited("LC_ALL").is_none() && inherited("LC_CTYPE").is_none() {
        env.push(("LANG".into(), "en_US.UTF-8".into()));
    }
    (env, vec!["TERM_SESSION_ID".into()])
}

/// The login shell: argv[0] is "-" and the program's file name ("-zsh"), so the login rc files
/// run (SH-002); it starts in the app's own working directory (SH-006).
pub fn login_spec(program: PathBuf, cwd: PathBuf, cols: u16, rows: u16) -> Spawn {
    let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "zsh".into());
    let (env, env_remove) = login_environment(&|k| std::env::var(k).ok());
    Spawn { arg0: format!("-{name}"), program, args: vec![], env, env_remove, cwd, cols, rows }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn sink_for(channel: Channel<ShellMessage>, generation: u64) -> pty::Sink {
    Box::new(move |e| {
        let _ = channel.send(match e {
            Event::Output(b) => ShellMessage::Output { data: b64(&b) },
            Event::Exited(code) => ShellMessage::Exited { code, generation },
        });
    })
}

fn failed(what: &str, e: impl std::fmt::Display) -> QnError {
    QnError::new(ErrorKind::Failed, format!("{what}: {e}"))
}

/// Starts the shell, or hands the running one to `channel`.
#[tauri::command]
pub fn shell_start(shell: State<'_, Shell>, cols: u16, rows: u16, channel: Channel<ShellMessage>) -> Result<ShellStarted, QnError> {
    let mut slot = shell.lock();
    if let Some(s) = slot.as_ref().filter(|s| s.is_alive()) {
        let generation = shell.generation.load(Ordering::SeqCst);
        s.set_sink(sink_for(channel, generation));
        let _ = s.resize(cols, rows);
        let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
        return Ok(ShellStarted { pid: s.pid(), shell: pty::user_shell().display().to_string(), cwd, generation, reattached: true });
    }
    if let Some(old) = slot.take() {
        old.terminate();
    }
    let program = pty::user_shell();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let generation = shell.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let spec = login_spec(program.clone(), cwd.clone(), cols, rows);
    let session = Session::spawn(&spec, sink_for(channel, generation)).map_err(|e| failed("Couldn't start the shell", e))?;
    let started = ShellStarted { pid: session.pid(), shell: program.display().to_string(), cwd: cwd.display().to_string(), generation, reattached: false };
    *slot = Some(session);
    Ok(started)
}

/// Keystrokes from the terminal view. `binary`: each character is one byte (xterm's onBinary).
/// Async: a write to the pty can wait while the shell isn't reading (a big paste during `sleep`),
/// and must not hold up the main thread meanwhile.
#[tauri::command]
pub async fn shell_input(shell: State<'_, Shell>, data: String, binary: Option<bool>) -> Result<(), QnError> {
    let bytes: Vec<u8> = if binary.unwrap_or(false) { data.chars().map(|c| c as u32 as u8).collect() } else { data.into_bytes() };
    match shell.lock().as_ref() {
        Some(s) => s.write(&bytes).map_err(|e| failed("Couldn't send to the shell", e)),
        None => Ok(()),
    }
}

/// The terminal's size changed (the pane, the font, the width meter).
#[tauri::command]
pub async fn shell_resize(shell: State<'_, Shell>, cols: u16, rows: u16) -> Result<(), QnError> {
    if let Some(s) = shell.lock().as_ref() {
        let _ = s.resize(cols, rows);
    }
    Ok(())
}

/// Restart Shell: ends the running shell (the page then starts a new one).
#[tauri::command]
pub fn shell_stop(shell: State<'_, Shell>) {
    if let Some(s) = shell.lock().take() {
        s.terminate();
    }
}

/// The saved transcript (base64), or null.
#[tauri::command]
pub fn shell_transcript_load(shell: State<'_, Shell>) -> Option<String> {
    transcript::load(&shell.transcript).map(|b| b64(&b))
}

/// Saves the transcript (base64; the last 1 MiB is kept). Resolves to whether anything was written.
#[tauri::command]
pub fn shell_transcript_save(shell: State<'_, Shell>, data: String) -> Result<bool, QnError> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| QnError::new(ErrorKind::Invalid, format!("The transcript isn't base64: {e}")))?;
    transcript::save(&shell.transcript, &bytes).map_err(|e| QnError::new(ErrorKind::Failed, e))
}

/// Restart Shell…: forget the saved transcript.
#[tauri::command]
pub fn shell_transcript_clear(shell: State<'_, Shell>) {
    transcript::clear(&shell.transcript);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn spawn(program: &str, arg0: &str, args: &[&str], cols: u16, rows: u16) -> (Session, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let (env, env_remove) = login_environment(&|_| None);
        let spec = Spawn {
            program: program.into(),
            arg0: arg0.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env,
            env_remove,
            cwd: std::env::temp_dir(),
            cols,
            rows,
        };
        let s = Session::spawn(&spec, Box::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        }))
        .expect("spawn");
        (s, rx)
    }

    /// Everything until the program exits (or 10 s).
    fn collect(rx: &mpsc::Receiver<Event>) -> (String, Option<Option<i32>>) {
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Output(b)) => out.extend(b),
                Ok(Event::Exited(c)) => return (String::from_utf8_lossy(&out).into_owned(), Some(c)),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        (String::from_utf8_lossy(&out).into_owned(), None)
    }

    #[test]
    fn a_program_in_the_pty_is_read_back_with_its_exit_status() {
        let (_s, rx) = spawn("/bin/sh", "sh", &["-c", "printf 'hello\\033[31m red\\n'; exit 3"], 80, 24);
        let (out, exit) = collect(&rx);
        // The terminal's onlcr turns \n into \r\n, as the user's shell output always arrives.
        assert_eq!(out, "hello\x1b[31m red\r\n");
        assert_eq!(exit, Some(Some(3)));
    }

    #[test]
    fn the_pty_is_the_controlling_terminal_with_the_login_environment() {
        let script = "test -t 0 && echo tty; echo \"$0|$TERM|$TERM_PROGRAM|$SHELL_SESSIONS_DISABLE|${TERM_SESSION_ID-unset}|$CLICOLOR|$CLICOLOR_FORCE|$LSCOLORS|$LANG\"; ps -o tty= -p $$ | grep -q ttys && echo ctty";
        let (_s, rx) = spawn("/bin/sh", "-sh", &["-c", script], 80, 24);
        let (out, exit) = collect(&rx);
        assert_eq!(exit, Some(Some(0)), "{out}");
        assert!(out.contains("tty\r\n"), "{out}");
        assert!(out.contains("-sh|xterm-256color|Apple_Terminal|1|unset|1|1|ExfxcxdxDxegedabagacad|en_US.UTF-8\r\n"), "{out}");
        assert!(out.contains("ctty"), "{out}");
    }

    #[test]
    fn resize_sets_the_window_size_the_program_sees() {
        let (s, rx) = spawn("/bin/sh", "sh", &["-c", "stty size; read x; stty size"], 80, 24);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = Vec::new();
        while !String::from_utf8_lossy(&out).contains("24 80") && Instant::now() < deadline {
            if let Ok(Event::Output(b)) = rx.recv_timeout(Duration::from_millis(100)) {
                out.extend(b);
            }
        }
        s.resize(240, 33).unwrap();
        assert_eq!(s.size().unwrap(), (240, 33));
        s.write(b"\n").unwrap();
        let (rest, exit) = collect(&rx);
        assert_eq!(exit, Some(Some(0)));
        assert!(rest.contains("33 240"), "{rest}");
    }

    #[test]
    fn input_reaches_the_program_and_is_echoed() {
        let (s, rx) = spawn("/bin/cat", "cat", &[], 80, 24);
        s.write(b"abc\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = Vec::new();
        while Instant::now() < deadline {
            if let Ok(Event::Output(b)) = rx.recv_timeout(Duration::from_millis(100)) {
                out.extend(b);
            }
            if String::from_utf8_lossy(&out).matches("abc").count() >= 2 {
                break;
            }
        }
        // The terminal's echo, then cat's copy.
        assert_eq!(String::from_utf8_lossy(&out), "abc\r\nabc\r\n");
        assert!(s.is_alive());
        s.terminate();
        let (_, exit) = collect(&rx);
        assert!(exit.is_some(), "the reader reports the exit after Restart's SIGHUP");
    }

    #[test]
    fn the_login_shell_is_started_with_a_dash() {
        let spec = login_spec("/bin/zsh".into(), "/".into(), 120, 30);
        assert_eq!(spec.arg0, "-zsh");
        assert!(spec.args.is_empty());
        assert_eq!(spec.cwd, PathBuf::from("/"));
        assert!(spec.env.contains(&("TERM_PROGRAM".into(), "Apple_Terminal".into())));
        assert_eq!(spec.env_remove, vec!["TERM_SESSION_ID".to_string()]);
        // A locale the app already has is kept, not overridden.
        let (env, _) = login_environment(&|k| (k == "LANG").then(|| "de_DE.UTF-8".to_string()));
        assert!(!env.iter().any(|(k, _)| k == "LANG"));
        assert!(pty::user_shell().is_absolute());
    }
}
