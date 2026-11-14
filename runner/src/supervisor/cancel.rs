//! The Stop request: a token shared between the thread that runs a job and whatever thread the
//! user's Stop arrives on, live from the moment the run is accepted.
//!
//! Replaces 0.90.34's `cancelRequestedAt`, `noteCancelRequested`, `signalActiveRun` and the pid
//! file `cancelActiveRun` waited for (TerminalModel.swift; ledger RUN-047, INV-057). In 0.90.34 Stop
//! could arrive before the wrapper had written its pid, so it retried for a second and then said
//! "Nothing to interrupt yet". Here the supervisor spawns every process itself while holding the
//! token's lock (D1), so there is no such gap: a Stop that arrives first means the process is never
//! spawned, and a Stop that arrives later finds the process group already recorded and sends it
//! SIGINT at once, the way ⌃C would. The rest of the ladder (SIGTERM, SIGKILL) is run by the thread
//! supervising the process (`process.rs`).
//!
//! A process group is signalled only while the supervisor knows it still has members, and never
//! when it is the app's own group (INV-057); the group id is forgotten under the same lock once the
//! group is gone, so a recycled id is never signalled.

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// A Stop request shared across threads. Cloning gives another handle to the same request.
#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<(Mutex<CancelState>, Condvar)>,
}

#[derive(Default)]
struct CancelState {
    requested_at: Option<Instant>,
    /// The process group of the step running now, and when each SIGINT reached it.
    group: Option<(libc::pid_t, Vec<Instant>)>,
}

impl std::fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CancelToken").field("requested_at", &self.requested_at()).finish()
    }
}

impl CancelToken {
    /// A token with no Stop requested.
    pub fn new() -> Self {
        Self::default()
    }

    /// Requests Stop. The first request fixes the time the SIGTERM and SIGKILL deadlines count
    /// from; every request sends SIGINT to the running step's process group, if there is one, as
    /// pressing ⌃C again would. Returns true for the first request.
    pub fn cancel(&self) -> bool {
        let (lock, cvar) = &*self.inner;
        let mut state = lock_state(lock);
        let first = state.requested_at.is_none();
        if first {
            state.requested_at = Some(Instant::now());
        }
        if let Some((pgid, sent)) = state.group.as_mut() {
            if signal_group(*pgid, libc::SIGINT) {
                sent.push(Instant::now());
            }
        }
        cvar.notify_all();
        first
    }

    /// True once Stop has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.requested_at().is_some()
    }

    /// When Stop was first requested.
    pub fn requested_at(&self) -> Option<Instant> {
        lock_state(&self.inner.0).requested_at
    }

    /// Sleeps for up to `timeout`, returning early (with true) once Stop is requested. For method
    /// code that waits between steps.
    pub fn wait_timeout(&self, timeout: Duration) -> bool {
        let (lock, cvar) = &*self.inner;
        let deadline = Instant::now() + timeout;
        let mut state = lock_state(lock);
        while state.requested_at.is_none() {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            state = match cvar.wait_timeout(state, deadline - now) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        true
    }

    /// Runs `spawn` unless Stop has already been requested, holding the lock so that a Stop cannot
    /// slip in between the check and the spawn. `spawn` returns the new process group id, which is
    /// recorded so that Stop reaches it. Returns `None` when Stop came first and nothing was spawned.
    pub(crate) fn spawn_unless_cancelled<T>(
        &self,
        spawn: impl FnOnce() -> std::io::Result<(T, libc::pid_t)>,
    ) -> Option<std::io::Result<T>> {
        let mut state = lock_state(&self.inner.0);
        if state.requested_at.is_some() {
            return None;
        }
        Some(spawn().map(|(value, pgid)| {
            state.group = Some((pgid, Vec::new()));
            value
        }))
    }

    /// Sends `signal` to the recorded group while it is still recorded. Returns true when sent.
    pub(crate) fn signal_recorded_group(&self, signal: libc::c_int) -> bool {
        let state = lock_state(&self.inner.0);
        match state.group {
            Some((pgid, _)) => signal_group(pgid, signal),
            None => false,
        }
    }

    /// Forgets the recorded group (it has no members left, or the supervisor has given up on it)
    /// and returns when each SIGINT reached it.
    pub(crate) fn forget_group(&self) -> Vec<Instant> {
        lock_state(&self.inner.0).group.take().map(|(_, sent)| sent).unwrap_or_default()
    }
}

fn lock_state(lock: &Mutex<CancelState>) -> MutexGuard<'_, CancelState> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Sends `signal` to process group `pgid`, refusing group ids that would reach something other than
/// the run: 0 and 1 (the caller's own group and init's), negative ids, and the app's own group.
/// Returns true when the signal was delivered.
pub fn signal_group(pgid: libc::pid_t, signal: libc::c_int) -> bool {
    // SAFETY: getpgrp and kill have no memory-safety preconditions.
    unsafe {
        if pgid <= 1 || pgid == libc::getpgrp() {
            return false;
        }
        libc::kill(-pgid, signal) == 0
    }
}

/// True while process group `pgid` has any member, including one this process may not signal.
pub fn group_alive(pgid: libc::pid_t) -> bool {
    if pgid <= 1 {
        return false;
    }
    // SAFETY: kill with signal 0 only checks for existence.
    unsafe {
        if libc::kill(-pgid, 0) == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_cancel_fixes_the_request_time_and_later_ones_do_not_move_it() {
        let token = CancelToken::new();
        assert!(!token.is_cancelled());
        assert!(token.cancel());
        let first = token.requested_at().unwrap();
        std::thread::sleep(Duration::from_millis(5));
        assert!(!token.cancel());
        assert_eq!(token.requested_at(), Some(first));
        assert!(token.clone().is_cancelled());
    }

    #[test]
    fn a_cancelled_token_refuses_to_spawn() {
        let token = CancelToken::new();
        token.cancel();
        let mut called = false;
        let result = token.spawn_unless_cancelled(|| {
            called = true;
            Ok(((), 12345))
        });
        assert!(result.is_none());
        assert!(!called);
    }

    #[test]
    fn waiting_returns_early_when_stop_arrives_from_another_thread() {
        let token = CancelToken::new();
        let other = token.clone();
        let started = Instant::now();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            other.cancel();
        });
        assert!(token.wait_timeout(Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(2));
        t.join().unwrap();
        assert!(!CancelToken::new().wait_timeout(Duration::from_millis(10)));
    }

    #[test]
    fn the_apps_own_group_and_init_are_never_signalled() {
        // SAFETY: getpgrp has no preconditions.
        let own = unsafe { libc::getpgrp() };
        assert!(!signal_group(own, 0));
        assert!(!signal_group(1, 0));
        assert!(!signal_group(0, 0));
        assert!(!signal_group(-5, 0));
    }
}
