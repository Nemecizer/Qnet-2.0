//! The Shell's progress lines for a running solver: the spinner and the progress bar that
//! 0.90.34's bash wrapper drew around a step (`withSpinner` and `withProgress` in
//! `2_QNET/Sources/Qnet/QnetGUIApp.swift`), now drawn by the app from the supervisor's step ticks.
//!
//! The text is the same, frame for frame: a first frame when the step starts, a redraw every
//! 200 ms behind `\r\x1b[K`, and a last frame with the elapsed time and a newline. 0.90.34's frames
//! went through `tee` into the run's archive as well as onto the screen, and so do these (the
//! result parser collapses carriage returns, so frames never reach a measurement).
//!
//! How a step's own output is placed also follows the wrapper. Under a spinner, 0.90.34 captured
//! the command's merged output to a file and printed it after the `[done]` frame; under a progress
//! bar the command wrote straight to the screen, so a failure's stderr text appears before the
//! final frame. In both cases a solver's standard output normally went to its own file
//! (`runWithStderrOnFailure`), which the method then formats.

use std::io;
use std::path::Path;
use std::time::Duration;

use qnet_core::cfmt;

use crate::supervisor::{stderr_report, Job, ProcessOutcome, Step};

/// How often the wrapper's pollers redrew (`sleep 0.2`).
pub const TICK: Duration = Duration::from_millis(200);

/// The spinner's characters, in the order the wrapper cycled through them after its first frame
/// (`_spin` is incremented before each draw, so the first redraw shows `/`).
const SPIN: [char; 4] = ['|', '/', '-', '\\'];

/// `"%6.1f"` of a duration in seconds.
fn secs(elapsed: Duration) -> String {
    cfmt::f("%6.1f", elapsed.as_secs_f64())
}

/// The spinner's first frame: `printf '<prefix>[ ]%52s%6.1fs' '' 0.0`.
pub fn spinner_first_frame(prefix: &str) -> String {
    format!("{prefix}[ ]{:52}{}s", "", secs(Duration::ZERO))
}

/// A spinner redraw; `tick` counts redraws from 1.
pub fn spinner_frame(prefix: &str, tick: u64, elapsed: Duration) -> String {
    let ch = SPIN[(tick % 4) as usize];
    format!("\r\x1b[K{prefix}[{ch}]{:52}{}s", "", secs(elapsed))
}

/// The spinner's last frame: `printf '\r\033[K<prefix>[done]%49s%6.1fs\n' '' "$_el"`.
pub fn spinner_last_frame(prefix: &str, elapsed: Duration) -> String {
    format!("\r\x1b[K{prefix}[done]{:49}{}s\n", "", secs(elapsed))
}

/// The progress bar's width in cells (`barWidth: 15`).
pub const BAR_WIDTH: usize = 15;

const BLOCK: &str = "\x1b[7m \x1b[27m ";

/// The progress bar's first frame: `<prefix>[<30 spaces>]  starting ...`.
pub fn progress_first_frame(prefix: &str) -> String {
    format!("{prefix}[{}]  starting ...", "  ".repeat(BAR_WIDTH))
}

/// `printf "%${tw}d/%d" done total`, where the width is the header line's length.
fn ratio(done: u64, total: u64, width: usize) -> String {
    format!("{done:>width$}/{total}")
}

/// A progress redraw while counting (`done < total`): the filled cells, `%-11s` ratio and
/// `(%3d%%)` followed by nine spaces.
pub fn progress_counting_frame(prefix: &str, done: u64, total: u64, header_width: usize) -> String {
    let total = total.max(1);
    let filled = (done * BAR_WIDTH as u64 / total) as usize;
    let mut bar = BLOCK.repeat(filled);
    bar.push_str(&"  ".repeat(BAR_WIDTH - filled.min(BAR_WIDTH)));
    let pct = done * 100 / total;
    format!(
        "\r\x1b[K{prefix}[{bar}]  {:<11}  ({pct:>3}%){:9}",
        ratio(done, total, header_width),
        ""
    )
}

/// A progress redraw once every unit is done: the full bar, `(100%)` and a spinner character
/// (`%7s`); `spin` counts these redraws from 1.
pub fn progress_full_frame(prefix: &str, total: u64, header_width: usize, spin: u64) -> String {
    let ch = SPIN[(spin % 4) as usize];
    format!(
        "\r\x1b[K{prefix}[{}]  {:<11}  (100%)  {ch:>7}",
        BLOCK.repeat(BAR_WIDTH),
        ratio(total, total, header_width)
    )
}

/// The progress bar's last frame. `header` is the progress file's first line when it is all
/// digits, else the wrapper's fallback `1`; it is printed `printf "%${#h}d/%d" h h`.
pub fn progress_last_frame(prefix: &str, header: Option<&str>, elapsed: Duration) -> String {
    let header = header.unwrap_or("1");
    let total = header.parse::<u64>().unwrap_or(u64::MAX);
    format!(
        "\r\x1b[K{prefix}[{}]  {:<11}  (100%)  {}s\n",
        BLOCK.repeat(BAR_WIDTH),
        ratio(total, total, header.len()),
        secs(elapsed)
    )
}

/// Runs `step` under a spinner, as `withSpinner(prefix:command:)` did: the spinner is drawn while
/// the step runs, then the `[done]` frame, then the step's captured standard output, then the
/// stderr policy's text (when the step has a stderr label). Returns the step's outcome.
pub fn run_with_spinner(job: &mut Job, prefix: &str, step: &Step) -> io::Result<ProcessOutcome> {
    job.emit_str(&spinner_first_frame(prefix));
    let mut quiet = step.clone().quiet();
    let label = quiet.stderr_label.take();
    let mut tick = 0u64;
    let result = job.run_step_with(&quiet, TICK, &mut |out, t| {
        tick += 1;
        out.emit_str(&spinner_frame(prefix, tick, t.elapsed));
    });
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(e) => {
            job.emit_str(&spinner_last_frame(prefix, Duration::ZERO));
            return Err(e);
        }
    };
    job.emit_str(&spinner_last_frame(prefix, outcome.elapsed));
    if step.show_stdout {
        job.emit(&outcome.stdout);
    }
    if let Some(label) = label {
        if !outcome.interrupted() {
            emit_stderr_policy(job, &label, &outcome);
        }
    }
    Ok(outcome)
}

/// What the wrapper's poller read from a progress file: `head -n 1` must be all digits (else it
/// waits), the total is that number but at least 1, and units done are the bytes after the header
/// line, clamped to 0…total. `width` is the header's length, used to right-align the count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BarCount {
    pub total: u64,
    pub done: u64,
    pub width: usize,
}

/// Reads a progress file the way `withProgress`'s bash poller did.
pub fn read_bar_count(path: &Path) -> Option<BarCount> {
    let header = read_header(path)?;
    let size = std::fs::metadata(path).ok()?.len();
    let total = header.parse::<u64>().unwrap_or(u64::MAX).max(1);
    let done = size.saturating_sub(header.len() as u64 + 1).min(total);
    Some(BarCount { total, done, width: header.len() })
}

/// The file's first line when it is a non-empty run of ASCII digits.
fn read_header(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let line = bytes.split(|&b| b == b'\n').next()?;
    if line.is_empty() || !line.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(String::from_utf8_lossy(line).into_owned())
}

/// Runs `step` under a progress bar fed by its progress file, as `withProgress` did. Give the
/// step a file from [`Job::progress_file`] through [`Step::progress`]; the file is emptied before
/// the step (`: > file`), polled every 200 ms, read once more for the last frame, and removed.
/// Without one, the bar stays at "starting ..." and ends at `1/1`.
pub fn run_with_progress(job: &mut Job, prefix: &str, step: &Step) -> io::Result<ProcessOutcome> {
    let mut silent = step.clone().quiet();
    let label = silent.stderr_label.take();
    let file = silent.progress_file.take();
    if let Some(path) = &file {
        std::fs::File::create(path)?;
    }
    job.emit_str(&progress_first_frame(prefix));
    let mut last: Option<u64> = None;
    let mut spin = 0u64;
    let result = job.run_step_with(&silent, TICK, &mut |out, _| {
        let Some(c) = file.as_deref().and_then(read_bar_count) else { return };
        if c.done >= c.total {
            spin += 1;
            out.emit_str(&progress_full_frame(prefix, c.total, c.width, spin));
        } else if last != Some(c.done) {
            last = Some(c.done);
            out.emit_str(&progress_counting_frame(prefix, c.done, c.total, c.width));
        }
    });
    let header = file.as_deref().and_then(read_header);
    if let Some(path) = &file {
        let _ = std::fs::remove_file(path);
    }
    let outcome = result?;
    if step.show_stdout {
        job.emit(&outcome.stdout);
    }
    if let Some(label) = &label {
        if !outcome.interrupted() {
            emit_stderr_policy(job, label, &outcome);
        }
    }
    job.emit_str(&progress_last_frame(prefix, header.as_deref(), outcome.elapsed));
    Ok(outcome)
}

/// Applies the stderr policy of `runWithStderrOnFailure` after a step: shows and logs a failure,
/// logs warning-like lines of a clean exit.
pub fn emit_stderr_policy(job: &mut Job, label: &str, outcome: &ProcessOutcome) {
    let report = stderr_report(label, outcome.shell_code(), &outcome.stderr);
    job.emit(&report.display);
    for (text, severity) in report.status {
        job.status(text, severity);
    }
}

/// `"Elapsed time: %.3fs\n\n"`, the line every run's output ends with.
pub fn elapsed_line(elapsed: Duration) -> String {
    format!("Elapsed time: {}s\n\n", cfmt::f("%.3f", elapsed.as_secs_f64()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spinner_frames_match_the_wrappers_printf_formats() {
        assert_eq!(
            spinner_first_frame("Running QNA ...  "),
            format!("Running QNA ...  [ ]{}   0.0s", " ".repeat(52))
        );
        assert_eq!(
            spinner_frame("P ", 1, Duration::from_millis(1234)),
            format!("\r\x1b[KP [/]{}   1.2s", " ".repeat(52))
        );
        assert_eq!(
            spinner_last_frame("Running QNA ...  ", Duration::from_millis(40)),
            format!("\r\x1b[KRunning QNA ...  [done]{}   0.0s\n", " ".repeat(49))
        );
    }

    #[test]
    fn the_progress_frames_match_the_wrappers_printf_formats() {
        assert_eq!(progress_first_frame("Sim "), format!("Sim [{}]  starting ...", " ".repeat(30)));
        let f = progress_counting_frame("Sim ", 4, 8, 1);
        assert_eq!(f, format!("\r\x1b[KSim [{}{}]  4/8          ( 50%){}", BLOCK.repeat(7), "  ".repeat(8), " ".repeat(9)));
        let f = progress_last_frame("Sim ", Some("8"), Duration::from_millis(2500));
        assert_eq!(f, format!("\r\x1b[KSim [{}]  8/8          (100%)     2.5s\n", BLOCK.repeat(15)));
        let f = progress_last_frame("Sim ", None, Duration::ZERO);
        assert!(f.contains("]  1/1          (100%)"));
        let f = progress_counting_frame("S ", 5, 100, 3);
        assert!(f.contains("]    5/100      (  5%)"), "{f:?}");
    }

    #[test]
    fn the_elapsed_line_has_three_decimals_and_a_blank_line() {
        assert_eq!(elapsed_line(Duration::from_millis(28)), "Elapsed time: 0.028s\n\n");
    }
}
