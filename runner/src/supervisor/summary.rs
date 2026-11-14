//! The words a finished or running run is described with: the outcome sentence ("Spectral finished
//! in 3.2 s"), the duration and clock formats, the status bar's live readout ("47% · 0:07" or
//! "Running Spectral for “Tandem”… 0:07"), the "Elapsed time: 0.028s" footer, and what the Results
//! store does with the run's record.
//!
//! Ports 0.90.34's `TerminalRunSummary` (TerminalModel.swift: `text`, `cancelled`, `duration`,
//! `clock`; ledger RUN-050), the run segment of `ContentView.swift` (RUN-027, RUN-051), the
//! wrapper's `perl … printf("Elapsed time: %.3fs\n\n")` (RUN-031) and the dispositions of
//! `QnetGUIApp.finalizeStructuredResult` (RUN-055, INV-056). Numbers go through `cfmt::f`, as
//! 0.90.34 formatted them with `String(format:)`. Nothing here differs from 0.90.34.

use std::time::{Duration, SystemTime};

use qnet_core::cfmt;

use super::registry::{RunId, RunOwner};

/// The exit status of a run that was interrupted: bash's 128 + SIGINT. A run cancelled before its
/// first process started also ends with it, as 0.90.34's wrapper trap reported `${_rc:-130}`.
pub const CANCELLED_EXIT_CODE: i32 = 130;

/// The outcome of one finished run, as 0.90.34's `TerminalRunSummary` held it.
#[derive(Debug, Clone, PartialEq)]
pub struct RunSummary {
    /// The run's identity, shared with its Results record.
    pub id: RunId,
    /// The display label ("Spectral", "Run Comparison"), not the internal run label.
    pub label: String,
    /// The tab that launched the run.
    pub owner: RunOwner,
    /// The run's exit status: the last step's code, 128 + signal for a step a signal ended, 130
    /// for a run stopped before it started, or −1 for a run that could not start.
    pub exit_code: i32,
    /// Time from acceptance of the run to its end.
    pub elapsed: Duration,
    /// Wall-clock time the run ended.
    pub finished_at: SystemTime,
    /// True when Stop was pressed for this run before it ended. It is the primary signal of a
    /// cancellation, because the exit status of a stopped run depends on which signal of the
    /// ladder won (130, 143, 137).
    pub user_stopped: bool,
}

impl RunSummary {
    /// True when the run exited 0.
    pub fn succeeded(&self) -> bool {
        self.exit_code == 0
    }

    /// True when the run ended because the user stopped it: Stop was pressed, or the run ended with
    /// 130 or 143 (an interrupt from outside the app). A run that exited 0 is never cancelled, so a
    /// Stop pressed in the instant a solver finished keeps the completed result.
    pub fn cancelled(&self) -> bool {
        if self.exit_code == 0 {
            return false;
        }
        self.user_stopped || self.exit_code == CANCELLED_EXIT_CODE || self.exit_code == 143
    }

    /// The outcome sentence: "<label> finished in <t>", "<label> cancelled after <t>" or
    /// "<label> failed (exit N) after <t>".
    pub fn text(&self) -> String {
        let time = format_duration(self.elapsed.as_secs_f64());
        if self.succeeded() {
            format!("{} finished in {}", self.label, time)
        } else if self.cancelled() {
            format!("{} cancelled after {}", self.label, time)
        } else {
            format!("{} failed (exit {}) after {}", self.label, self.exit_code, time)
        }
    }

    /// The status bar's last-run segment: "<outcome sentence> · <tab title>".
    pub fn status_bar_text(&self) -> String {
        format!("{} · {}", self.text(), self.owner.title)
    }

    /// What happens to the run's Results record once it has ended (RUN-055, INV-056).
    pub fn record_disposition(&self) -> RecordDisposition {
        if self.cancelled() {
            RecordDisposition::Delete
        } else if !self.succeeded() {
            RecordDisposition::Fail(format!(
                "{} exited with status {}. See the originating tab's Status pane and retained output.",
                self.label, self.exit_code
            ))
        } else {
            RecordDisposition::Parse
        }
    }
}

/// What the Results store does with a finished run's record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordDisposition {
    /// The user stopped the run: a stopped run is not a result, so its record is deleted.
    Delete,
    /// The run exited non-zero: the record is marked failed with this message and the raw output.
    Fail(String),
    /// The run exited 0: the archive is parsed into a Completed, Partial or Failed record.
    Parse,
}

/// The summary's duration: tenths under 10 s ("3.2 s"), whole seconds under a minute ("42 s"),
/// `m:ss` beyond ("1:12").
pub fn format_duration(seconds: f64) -> String {
    if seconds < 10.0 {
        cfmt::f("%.1f s", seconds)
    } else if seconds < 60.0 {
        cfmt::f("%.0f s", seconds)
    } else {
        format_clock(seconds)
    }
}

/// The live clock, `m:ss` ("0:07", "12:41"), from the seconds rounded half away from zero.
pub fn format_clock(seconds: f64) -> String {
    let total = seconds.round() as i64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// The footer 0.90.34's wrapper printed after a run's output: "Elapsed time: 0.028s" and a blank
/// line.
pub fn elapsed_footer(seconds: f64) -> String {
    cfmt::f("Elapsed time: %.3fs\n\n", seconds)
}

/// A live run's state for the status bar, reported every 500 ms.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RunProgress {
    /// Fraction done (0…1) when a solver reports a total through its `-P` file, else `None`.
    pub fraction: Option<f64>,
    /// Time since the run was accepted.
    pub elapsed: Duration,
}

impl RunProgress {
    /// The status bar's readout: "47% · 0:07" when the fraction is known, else
    /// "Running <run> for <tab>… 0:07" beside an indeterminate spinner.
    pub fn status_text(&self, run: &str, owner_title: &str) -> String {
        let clock = format_clock(self.elapsed.as_secs_f64());
        match self.fraction {
            Some(fraction) => format!("{}% · {}", percent(fraction), clock),
            None => format!("Running {run} for {owner_title}… {clock}"),
        }
    }
}

/// A fraction as the whole percentage the status bar shows, rounded half away from zero.
pub fn percent(fraction: f64) -> i64 {
    (fraction * 100.0).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(code: i32, secs: f64, stopped: bool) -> RunSummary {
        RunSummary {
            id: RunId::from_string("00000000-0000-4000-8000-000000000000"),
            label: "Spectral".into(),
            owner: RunOwner { id: "tab-1".into(), title: "Tandem".into() },
            exit_code: code,
            elapsed: Duration::from_secs_f64(secs),
            finished_at: SystemTime::UNIX_EPOCH,
            user_stopped: stopped,
        }
    }

    #[test]
    fn durations_use_tenths_under_ten_seconds_whole_seconds_under_a_minute_and_a_clock_beyond() {
        assert_eq!(format_duration(0.0), "0.0 s");
        assert_eq!(format_duration(3.24), "3.2 s");
        assert_eq!(format_duration(9.94), "9.9 s");
        // The branch is chosen before rounding, as in 0.90.34.
        assert_eq!(format_duration(9.96), "10.0 s");
        assert_eq!(format_duration(10.0), "10 s");
        assert_eq!(format_duration(42.4), "42 s");
        assert_eq!(format_duration(59.7), "60 s");
        assert_eq!(format_duration(60.0), "1:00");
        assert_eq!(format_duration(72.0), "1:12");
        assert_eq!(format_duration(761.0), "12:41");
    }

    #[test]
    fn the_clock_rounds_half_away_from_zero_and_pads_seconds() {
        assert_eq!(format_clock(0.0), "0:00");
        assert_eq!(format_clock(7.4), "0:07");
        assert_eq!(format_clock(7.5), "0:08");
        assert_eq!(format_clock(59.5), "1:00");
        assert_eq!(format_clock(3600.0), "60:00");
    }

    #[test]
    fn outcome_sentences_match_terminal_run_summary_text() {
        assert_eq!(summary(0, 3.2, false).text(), "Spectral finished in 3.2 s");
        assert_eq!(summary(130, 42.0, false).text(), "Spectral cancelled after 42 s");
        assert_eq!(summary(143, 1.0, false).text(), "Spectral cancelled after 1.0 s");
        assert_eq!(summary(137, 4.0, true).text(), "Spectral cancelled after 4.0 s");
        assert_eq!(summary(129, 4.0, true).text(), "Spectral cancelled after 4.0 s");
        assert_eq!(summary(2, 72.0, false).text(), "Spectral failed (exit 2) after 1:12");
        assert_eq!(summary(-1, 0.0, false).text(), "Spectral failed (exit -1) after 0.0 s");
        assert_eq!(summary(137, 4.0, false).text(), "Spectral failed (exit 137) after 4.0 s");
    }

    #[test]
    fn a_zero_exit_is_never_cancelled_even_when_stop_was_pressed() {
        let s = summary(0, 1.0, true);
        assert!(s.succeeded());
        assert!(!s.cancelled());
        assert_eq!(s.text(), "Spectral finished in 1.0 s");
        assert_eq!(s.record_disposition(), RecordDisposition::Parse);
    }

    #[test]
    fn a_cancelled_run_deletes_its_record_and_a_failed_one_is_marked_failed() {
        assert_eq!(summary(130, 1.0, true).record_disposition(), RecordDisposition::Delete);
        assert_eq!(summary(143, 1.0, false).record_disposition(), RecordDisposition::Delete);
        assert_eq!(
            summary(3, 1.0, false).record_disposition(),
            RecordDisposition::Fail(
                "Spectral exited with status 3. See the originating tab's Status pane and retained output.".into()
            )
        );
    }

    #[test]
    fn the_status_bar_names_the_outcome_and_the_owning_tab() {
        assert_eq!(summary(0, 3.2, false).status_bar_text(), "Spectral finished in 3.2 s · Tandem");
    }

    #[test]
    fn the_live_readout_is_a_percentage_with_a_clock_or_the_indeterminate_sentence() {
        let p = RunProgress { fraction: Some(0.474), elapsed: Duration::from_secs(7) };
        assert_eq!(p.status_text("Monte Carlo", "Tandem"), "47% · 0:07");
        let p = RunProgress { fraction: Some(0.005), elapsed: Duration::from_millis(500) };
        assert_eq!(p.status_text("Monte Carlo", "Tandem"), "1% · 0:01");
        let p = RunProgress { fraction: Some(1.0), elapsed: Duration::from_secs(61) };
        assert_eq!(p.status_text("Monte Carlo", "Tandem"), "100% · 1:01");
        let p = RunProgress { fraction: None, elapsed: Duration::from_secs(7) };
        assert_eq!(p.status_text("QNA", "Tandem"), "Running QNA for Tandem… 0:07");
    }

    #[test]
    fn the_elapsed_footer_has_three_decimals_and_a_blank_line() {
        assert_eq!(elapsed_footer(0.028), "Elapsed time: 0.028s\n\n");
        assert_eq!(elapsed_footer(12.3456), "Elapsed time: 12.346s\n\n");
    }
}
