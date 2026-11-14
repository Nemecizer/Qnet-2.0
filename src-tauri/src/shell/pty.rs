//! The Shell pane's process: a program in a pseudo-terminal (shell.md §3.1, ledger SH-001…006).
//!
//! `openpty` makes the pair; the child is started with `std::process::Command` and a `pre_exec`
//! that calls `setsid` and `TIOCSCTTY`, so the slave becomes its controlling terminal (what
//! SwiftTerm's `LocalProcess` did with `forkpty`). Rust's `Command` resets SIGPIPE and the signal
//! mask in the child, so the shell starts with ordinary signal handling. One thread reads the
//! master and hands every chunk to the sink as it arrives; when the slave side closes (the shell
//! exited) it waits for the child and reports the exit status.
//!
//! `portable-pty` would do the same; this is the 150 lines of it Qnet needs, on `libc`, which the
//! app already links through Tauri.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// What the reader reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Bytes the program wrote, exactly as they came off the master.
    Output(Vec<u8>),
    /// The program ended: its exit code, or 128 + the signal that ended it.
    Exited(Option<i32>),
}

pub type Sink = Box<dyn Fn(Event) + Send + Sync>;

/// How to start the program.
#[derive(Debug, Clone)]
pub struct Spawn {
    pub program: PathBuf,
    /// argv[0]: "-zsh" for a login shell.
    pub arg0: String,
    pub args: Vec<String>,
    /// Set on top of the inherited environment.
    pub env: Vec<(String, String)>,
    /// Removed from the inherited environment.
    pub env_remove: Vec<String>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

pub struct Session {
    pid: i32,
    master: Mutex<File>,
    sink: Arc<Mutex<Sink>>,
    alive: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 }
}

fn cloexec(fd: i32) {
    // SAFETY: fcntl on a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags >= 0 {
            libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
        }
    }
}

impl Session {
    /// Starts `spec` in a new pseudo-terminal; output and the exit go to `sink`.
    pub fn spawn(spec: &Spawn, sink: Sink) -> io::Result<Session> {
        let mut master: i32 = -1;
        let mut slave: i32 = -1;
        let mut ws = winsize(spec.cols, spec.rows);
        // SAFETY: openpty fills the two descriptors; the name buffer and termios are optional.
        let rc = unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both descriptors were just opened and are owned here.
        let master = unsafe { OwnedFd::from_raw_fd(master) };
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        // The master must not leak into the child (or into any later child of the app).
        cloexec(master.as_raw_fd());
        cloexec(slave.as_raw_fd());

        let mut cmd = Command::new(&spec.program);
        cmd.arg0(OsString::from(&spec.arg0)).args(&spec.args).current_dir(&spec.cwd);
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave.try_clone()?));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn()?;
        // The parent keeps no slave descriptor: the reader sees EOF/EIO once the shell is gone.
        drop(cmd);
        drop(slave);
        let pid = child.id() as i32;

        let reader_fd = master.try_clone()?;
        let master = File::from(master);
        let sink: Arc<Mutex<Sink>> = Arc::new(Mutex::new(sink));
        let alive = Arc::new(AtomicBool::new(true));
        let (sink2, alive2) = (sink.clone(), alive.clone());
        let reader = std::thread::Builder::new().name("qnet-shell-pty".into()).spawn(move || {
            let mut f = File::from(reader_fd);
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match f.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let s = sink2.lock().unwrap_or_else(|p| p.into_inner());
                        s(Event::Output(buf[..n].to_vec()));
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    // EIO: the slave side closed (the shell and everything it started are gone).
                    Err(_) => break,
                }
            }
            let code = child.wait().ok().map(|s| s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0)));
            alive2.store(false, Ordering::SeqCst);
            let s = sink2.lock().unwrap_or_else(|p| p.into_inner());
            s(Event::Exited(code));
        })?;
        Ok(Session { pid, master: Mutex::new(master), sink, alive, reader: Some(reader) })
    }

    pub fn pid(&self) -> i32 {
        self.pid
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Where output goes from now on (a reloaded page brings a new channel).
    pub fn set_sink(&self, sink: Sink) {
        *self.sink.lock().unwrap_or_else(|p| p.into_inner()) = sink;
    }

    /// Keystrokes and pastes, as the terminal view encoded them.
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut m = self.master.lock().unwrap_or_else(|p| p.into_inner());
        m.write_all(bytes)?;
        m.flush()
    }

    /// TIOCSWINSZ: the kernel sends the foreground job SIGWINCH.
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let ws = winsize(cols, rows);
        let m = self.master.lock().unwrap_or_else(|p| p.into_inner());
        // SAFETY: TIOCSWINSZ with a valid winsize on our master descriptor.
        if unsafe { libc::ioctl(m.as_raw_fd(), libc::TIOCSWINSZ, &ws) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// The rows and columns the kernel holds for the terminal now (the tests read it back).
    #[cfg(test)]
    pub fn size(&self) -> io::Result<(u16, u16)> {
        let mut ws = winsize(1, 1);
        let m = self.master.lock().unwrap_or_else(|p| p.into_inner());
        // SAFETY: TIOCGWINSZ into a winsize we own.
        if unsafe { libc::ioctl(m.as_raw_fd(), libc::TIOCGWINSZ, &mut ws) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok((ws.ws_col, ws.ws_row))
    }

    /// Ends the session (Restart Shell): SIGHUP to the shell's session, as closing a terminal
    /// window does, then SIGKILL a second later if anything is still there.
    pub fn terminate(mut self) {
        let pid = self.pid;
        // SAFETY: signalling the process group the child leads (setsid made it the leader).
        unsafe {
            libc::kill(-pid, libc::SIGHUP);
            libc::kill(pid, libc::SIGHUP);
        }
        let alive = self.alive.clone();
        let reader = self.reader.take();
        std::thread::spawn(move || {
            for _ in 0..20 {
                if !alive.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if alive.load(Ordering::SeqCst) {
                // SAFETY: as above.
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                    libc::kill(pid, libc::SIGKILL);
                }
            }
            if let Some(r) = reader {
                let _ = r.join();
            }
        });
    }
}

/// The user's login shell from the password database, or /bin/zsh (`userShell()`, SH-001).
pub fn user_shell() -> PathBuf {
    // SAFETY: getpwuid_r with a buffer we own; the result points into it.
    unsafe {
        let size = libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX);
        let size = if size <= 0 { 4096 } else { size as usize };
        let mut buf = vec![0 as libc::c_char; size];
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        if libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr(), size, &mut result) != 0 || result.is_null() || pwd.pw_shell.is_null() {
            return PathBuf::from("/bin/zsh");
        }
        let s = std::ffi::CStr::from_ptr(pwd.pw_shell).to_string_lossy().into_owned();
        if s.is_empty() {
            PathBuf::from("/bin/zsh")
        } else {
            PathBuf::from(s)
        }
    }
}
