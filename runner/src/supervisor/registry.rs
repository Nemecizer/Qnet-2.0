//! One run at a time across all tabs, owned by the tab that launched it.
//!
//! Ports the run-ownership half of 0.90.34's `TerminalModel` (`beginRun`'s refusal, `activeRun`,
//! `activeRunOwnerID`/`Title`, `activeRunReporter`, `cancelActiveRun`'s "<Label> cancelled.";
//! ledger RUN-018, RUN-019, INV-011, LOG-007, RUN-046's log line). A second launch is refused with
//! 0.90.34's sentence, sent to the tab that asked; while a run is active every lifecycle message
//! (its Status lines, solver diagnostics, the Stop line, progress, the finish) goes to the callback
//! captured from the launching tab, whatever tab is active by then.
//!
//! In 0.90.34 single flight existed because every run shared the user's shell; 2.0 keeps it as the
//! user-visible rule (RUN-018) though runs no longer share anything. The per-run UUID that scoped
//! 0.90.34's done, pid and status files now only names the run and its Results record.

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::cancel::CancelToken;
use super::labels::display_label;
use super::summary::{RunProgress, RunSummary};

/// A Status-log severity, as 0.90.34's `StatusSeverity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Severity {
    /// Plain information.
    Info,
    /// Something that worked.
    Success,
    /// Something the user should notice.
    Warning,
    /// Something that failed.
    Error,
}

/// A run's identity: a random (version 4) UUID in lower case, as 0.90.34 wrote `id.uuidString.lowercased()`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RunId(String);

impl RunId {
    /// A fresh random id.
    pub fn new() -> Self {
        let mut bytes = [0u8; 16];
        // SAFETY: the buffer is writable for its 16 bytes.
        unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        RunId(format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]))
    }

    /// An id from its text form (for records read back from disk).
    pub fn from_string(text: impl Into<String>) -> Self {
        RunId(text.into())
    }

    /// The id's text form.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for RunId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for RunId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The tab that launched a run.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RunOwner {
    /// The tab's stable id.
    pub id: String,
    /// The tab's title when the run was launched.
    pub title: String,
}

/// Something that happened to a run, for the owning tab.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    /// A line for the owning tab's Status log.
    Status {
        /// The line.
        text: String,
        /// Its severity.
        severity: Severity,
    },
    /// The live state for the status bar, every 500 ms while the run is active.
    Progress(RunProgress),
    /// The run has ended and released the single-flight slot.
    Finished(RunSummary),
}

/// The callback a run reports to, captured from the launching tab.
pub type Reporter = Arc<dyn Fn(&RunEvent) + Send + Sync>;

/// A refused launch. Its message has already been reported, as a warning, to the tab that asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    /// "<Label> was not started because <run> is already running for “<tab>”. Stop or wait for
    /// that run first."
    pub message: String,
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Refused {}

/// A snapshot of the active run, for the status bar and the Run menu.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveRun {
    /// The run's id.
    pub id: RunId,
    /// The internal run label ("inf_cmp").
    pub label: String,
    /// The display label ("Run Comparison").
    pub display_label: String,
    /// The tab that launched it.
    pub owner: RunOwner,
    /// Time since it was accepted.
    pub elapsed: Duration,
    /// The latest fraction done, when a solver reports one.
    pub fraction: Option<f64>,
    /// True once Stop has been requested.
    pub stop_requested: bool,
}

impl ActiveRun {
    /// The status bar's readout ("47% · 0:07" or "Running <run> for <tab>… 0:07").
    pub fn status_text(&self) -> String {
        RunProgress { fraction: self.fraction, elapsed: self.elapsed }.status_text(&self.display_label, &self.owner.title)
    }
}

struct Slot {
    id: RunId,
    label: String,
    display: String,
    owner: RunOwner,
    started: Instant,
    cancel: CancelToken,
    reporter: Reporter,
    fraction: Option<f64>,
}

/// The single-flight registry: at most one run is active at a time.
#[derive(Default)]
pub struct RunRegistry {
    slot: Mutex<Option<Slot>>,
}

impl RunRegistry {
    /// An empty registry, shared by every tab of the app.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> MutexGuard<'_, Option<Slot>> {
        self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Claims the slot for a run with internal label `label`, owned by `owner`, reporting to
    /// `reporter`. When another run holds the slot the launch is refused: the refusal sentence is
    /// sent to `reporter` as a warning and returned.
    pub fn begin(self: &Arc<Self>, label: &str, owner: RunOwner, reporter: Reporter) -> Result<RunTicket, Refused> {
        let display = display_label(label);
        let mut slot = self.lock();
        if let Some(active) = slot.as_ref() {
            let message = format!(
                "{display} was not started because {} is already running for \u{201C}{}\u{201D}. Stop or wait for that run first.",
                active.display, active.owner.title
            );
            drop(slot);
            reporter(&RunEvent::Status { text: message.clone(), severity: Severity::Warning });
            return Err(Refused { message });
        }
        let id = RunId::new();
        let cancel = CancelToken::new();
        let started = Instant::now();
        *slot = Some(Slot {
            id: id.clone(),
            label: label.to_string(),
            display: display.clone(),
            owner: owner.clone(),
            started,
            cancel: cancel.clone(),
            reporter: reporter.clone(),
            fraction: None,
        });
        Ok(RunTicket { registry: Arc::clone(self), id, label: label.to_string(), display, owner, started, cancel, reporter, released: false })
    }

    /// The active run, if any.
    pub fn active(&self) -> Option<ActiveRun> {
        self.lock().as_ref().map(|s| ActiveRun {
            id: s.id.clone(),
            label: s.label.clone(),
            display_label: s.display.clone(),
            owner: s.owner.clone(),
            elapsed: s.started.elapsed(),
            fraction: s.fraction,
            stop_requested: s.cancel.is_cancelled(),
        })
    }

    /// Stop (Run ▸ Stop, ⌘., the status bar's button): interrupts the active run at once and logs
    /// "<Label> cancelled." to the tab that owns it. Returns the run's display label, or `None` when
    /// nothing is running.
    pub fn stop(&self) -> Option<String> {
        let (display, cancel, reporter) = {
            let slot = self.lock();
            let s = slot.as_ref()?;
            (s.display.clone(), s.cancel.clone(), s.reporter.clone())
        };
        // A second Stop (a double ⌘., the status bar's button pressed twice) says nothing new.
        let first = !cancel.is_cancelled();
        cancel.cancel();
        if first {
            reporter(&RunEvent::Status { text: format!("{display} cancelled."), severity: Severity::Warning });
        }
        Some(display)
    }

    pub(crate) fn set_fraction(&self, id: &RunId, fraction: Option<f64>) {
        if let Some(s) = self.lock().as_mut() {
            if &s.id == id {
                s.fraction = fraction;
            }
        }
    }

    fn release(&self, id: &RunId) {
        let mut slot = self.lock();
        if slot.as_ref().is_some_and(|s| &s.id == id) {
            *slot = None;
        }
    }
}

/// The claim on the single-flight slot for one accepted run. Dropping it releases the slot, so a
/// run that ends any way at all (a panic included) never blocks the next one.
pub struct RunTicket {
    registry: Arc<RunRegistry>,
    id: RunId,
    label: String,
    display: String,
    owner: RunOwner,
    started: Instant,
    cancel: CancelToken,
    reporter: Reporter,
    released: bool,
}

impl RunTicket {
    /// The run's id.
    pub fn id(&self) -> &RunId {
        &self.id
    }
    /// The internal run label.
    pub fn label(&self) -> &str {
        &self.label
    }
    /// The display label.
    pub fn display_label(&self) -> &str {
        &self.display
    }
    /// The owning tab.
    pub fn owner(&self) -> &RunOwner {
        &self.owner
    }
    /// When the run was accepted.
    pub fn started(&self) -> Instant {
        self.started
    }
    /// The run's Stop token.
    pub fn cancel_token(&self) -> &CancelToken {
        &self.cancel
    }
    /// The owning tab's callback.
    pub fn reporter(&self) -> &Reporter {
        &self.reporter
    }
    /// Sends one event to the owning tab.
    pub fn report(&self, event: &RunEvent) {
        (self.reporter)(event)
    }
    pub(crate) fn registry(&self) -> &Arc<RunRegistry> {
        &self.registry
    }
    /// Releases the slot now (also done on drop).
    pub fn release(mut self) {
        self.release_now();
    }
    fn release_now(&mut self) {
        if !self.released {
            self.released = true;
            self.registry.release(&self.id);
        }
    }
}

impl Drop for RunTicket {
    fn drop(&mut self) {
        self.release_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collector() -> (Reporter, Arc<Mutex<Vec<RunEvent>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        (Arc::new(move |e: &RunEvent| sink.lock().unwrap().push(e.clone())), seen)
    }

    fn owner(title: &str) -> RunOwner {
        RunOwner { id: format!("id-{title}"), title: title.into() }
    }

    #[test]
    fn a_second_launch_is_refused_with_the_owners_tab_named() {
        let registry = RunRegistry::new();
        let (first, first_seen) = collector();
        let ticket = registry.begin("inf_sm", owner("Tandem"), first).unwrap();
        let (second, second_seen) = collector();
        let refused = registry.begin("qna", owner("Other"), second).err().unwrap();
        let expected = "QNA was not started because Spectral is already running for \u{201C}Tandem\u{201D}. Stop or wait for that run first.";
        assert_eq!(refused.message, expected);
        assert_eq!(
            second_seen.lock().unwrap().as_slice(),
            &[RunEvent::Status { text: expected.into(), severity: Severity::Warning }]
        );
        assert!(first_seen.lock().unwrap().is_empty());
        drop(ticket);
        assert!(registry.begin("qna", owner("Other"), collector().0).is_ok());
    }

    #[test]
    fn stop_logs_to_the_owning_tab_and_cancels_the_token() {
        let registry = RunRegistry::new();
        assert_eq!(registry.stop(), None);
        let (rep, seen) = collector();
        let ticket = registry.begin("cmp", owner("Tandem"), rep).unwrap();
        assert_eq!(registry.stop().as_deref(), Some("Run Comparison"));
        assert!(ticket.cancel_token().is_cancelled());
        assert!(registry.active().unwrap().stop_requested);
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[RunEvent::Status { text: "Run Comparison cancelled.".into(), severity: Severity::Warning }]
        );
    }

    #[test]
    fn the_active_run_is_visible_until_its_ticket_is_released() {
        let registry = RunRegistry::new();
        assert!(registry.active().is_none());
        let ticket = registry.begin("sim", owner("Tandem"), collector().0).unwrap();
        let active = registry.active().unwrap();
        assert_eq!(active.display_label, "Monte Carlo");
        assert_eq!(active.label, "sim");
        assert_eq!(&active.id, ticket.id());
        assert!(active.status_text().starts_with("Running Monte Carlo for Tandem… 0:0"));
        registry.set_fraction(ticket.id(), Some(0.5));
        assert!(registry.active().unwrap().status_text().starts_with("50% · 0:0"));
        ticket.release();
        assert!(registry.active().is_none());
    }

    #[test]
    fn run_ids_are_lower_case_version_4_uuids_and_differ() {
        let a = RunId::new();
        let b = RunId::new();
        assert_ne!(a, b);
        let s = a.as_str();
        assert_eq!(s.len(), 36);
        assert_eq!(&s[14..15], "4");
        assert!("89ab".contains(&s[19..20]));
        assert!(s.chars().all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }
}
