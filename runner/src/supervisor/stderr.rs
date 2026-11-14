//! What a solver's standard error turns into once the solver has exited: the failure text the Shell
//! shows, the lines the owning tab's Status log receives, and the severity of each of those lines.
//!
//! Ports `QnetGUIApp.runWithStderrOnFailure` (ledger RUN-023, RUN-024, INV-055, SH-081), the drain
//! of the per-run status inbox in `TerminalModel.drainActiveStatusInbox` (RUN-026) and
//! `StatusEntry.solverLineSeverity` (LOG-005). In 0.90.34 a bash fragment captured stderr to a
//! file; on a non-zero exit it printed "\n⚠ <Label> failed (exit N):\n" and the stderr to the Shell
//! and appended the same to an inbox file, and on a clean exit it kept only the lines BWK awk
//! matched with `tolower($0) ~ /warn|unstable|bramson|vande[ -]?vate|kumar[ -]?seidman|diverg|caution/`
//! and appended "⚠ <Label> warnings:\n<lines>\n". The poller then split the inbox on `<<<END>>>`,
//! trimmed each record and sent every non-empty line to the Status log with the severity its
//! wording implies. This module builds the same record and applies the same drain to it, so the
//! lines and severities are 0.90.34's, but as pure functions over the captured bytes (D1: no
//! inbox file, RUN-025 and LOG-006 Changed).
//!
//! One deliberate difference: 0.90.34 decoded the inbox strictly as UTF-8 and, when stderr held an
//! invalid byte, never consumed the record, so those lines were lost. Here invalid bytes become
//! U+FFFD and the lines arrive (D5, nothing fails silently, INV-054).

use super::registry::Severity;

/// The solver's stderr as 0.90.34's wrapper reported it once the solver had exited.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StderrReport {
    /// Bytes added to the run's output stream (the Shell and the archive). Non-empty only on a
    /// non-zero exit: "\n⚠ <Label> failed (exit N):\n" followed by the stderr bytes unchanged.
    pub display: Vec<u8>,
    /// Lines for the owning tab's Status log, in order, each with its severity.
    pub status: Vec<(String, Severity)>,
}

/// Applies 0.90.34's stderr policy to one finished solver step.
///
/// `exit_code` is the shell's view of the exit (128 + signal for a signal), `label` the step's
/// label ("Spectral Method", "QNA"). On a non-zero exit the Shell shows the failure heading and all
/// of stderr, and the Status log gets the heading and every non-empty stderr line. On a zero exit
/// nothing is shown, and the Status log gets "⚠ <Label> warnings:" and the warning-like lines, or
/// nothing when there are none.
pub fn stderr_report(label: &str, exit_code: i32, stderr: &[u8]) -> StderrReport {
    if exit_code != 0 {
        let heading = format!("⚠ {label} failed (exit {exit_code}):");
        let mut display = Vec::with_capacity(stderr.len() + heading.len() + 2);
        display.push(b'\n');
        display.extend_from_slice(heading.as_bytes());
        display.push(b'\n');
        display.extend_from_slice(stderr);
        // `{ printf '⚠ … (exit %d):\n'; cat err; printf '<<<END>>>\n'; }`
        let mut record = Vec::new();
        record.extend_from_slice(heading.as_bytes());
        record.push(b'\n');
        record.extend_from_slice(stderr);
        return StderrReport { display, status: drain_record(&String::from_utf8_lossy(&record)) };
    }
    if stderr.is_empty() {
        return StderrReport::default();
    }
    let warnings = warning_lines(stderr);
    // `_warns=$(awk …)` drops every trailing newline; `[ -n "$_warns" ]` then decides.
    let mut end = warnings.len();
    while end > 0 && warnings[end - 1] == b'\n' {
        end -= 1;
    }
    if end == 0 {
        return StderrReport::default();
    }
    let mut record = format!("⚠ {label} warnings:\n").into_bytes();
    record.extend_from_slice(&warnings[..end]);
    record.push(b'\n');
    StderrReport { display: Vec::new(), status: drain_record(&String::from_utf8_lossy(&record)) }
}

/// The lines of `stderr` that 0.90.34's awk filter kept, each followed by a newline, in order.
///
/// awk splits records on `\n` only (a final line without one is still a record), lower-cases ASCII
/// letters for the match and prints the line unchanged.
pub fn warning_lines(stderr: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut lines: Vec<&[u8]> = stderr.split(|&b| b == b'\n').collect();
    if stderr.ends_with(b"\n") {
        lines.pop();
    }
    for line in lines {
        if is_warning_line(line) {
            out.extend_from_slice(line);
            out.push(b'\n');
        }
    }
    out
}

/// True when a stderr line matches, ignoring ASCII case,
/// `warn|unstable|bramson|vande[ -]?vate|kumar[ -]?seidman|diverg|caution`.
pub fn is_warning_line(line: &[u8]) -> bool {
    let lower: Vec<u8> = line.iter().map(|b| b.to_ascii_lowercase()).collect();
    let has = |needle: &[u8]| lower.windows(needle.len()).any(|w| w == needle);
    if ["warn", "unstable", "bramson", "diverg", "caution"].iter().any(|n| has(n.as_bytes())) {
        return true;
    }
    joined(&lower, b"vande", b"vate") || joined(&lower, b"kumar", b"seidman")
}

/// True when `a`, then optionally one space or hyphen, then `b` occurs in `text`.
fn joined(text: &[u8], a: &[u8], b: &[u8]) -> bool {
    (0..text.len()).any(|i| {
        if !text[i..].starts_with(a) {
            return false;
        }
        let rest = &text[i + a.len()..];
        rest.starts_with(b) || (matches!(rest.first(), Some(b' ') | Some(b'-')) && rest[1..].starts_with(b))
    })
}

/// The Status-log lines one inbox record produced in 0.90.34: the record trimmed of white space and
/// newlines at both ends, split at each newline, empty lines dropped, each line with
/// [`solver_line_severity`]. Swift's split treats "\r\n" as one character that is not "\n", so a
/// CRLF does not split a line; that is kept.
pub fn drain_record(record: &str) -> Vec<(String, Severity)> {
    let trimmed = record.trim_matches(|c: char| c.is_whitespace());
    split_swift_lines(trimmed)
        .into_iter()
        .filter(|line| !line.is_empty())
        .map(|line| (line.to_string(), solver_line_severity(line)))
        .collect()
}

/// Splits at every "\n" that is not the second half of a "\r\n" pair, as Swift's
/// `split(separator: "\n")` does on a `String`.
fn split_swift_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' && !(i > 0 && bytes[i - 1] == b'\r') {
            lines.push(&text[start..i]);
            start = i + 1;
        }
    }
    lines.push(&text[start..]);
    lines
}

/// The severity a solver line gets in the Status log, from its leading token only: "WARNING" or
/// "warning:" (any case) gives a warning; "ERROR", "error:" or "fatal" (any case) an error;
/// anything else, including 0.90.34's own "⚠ … failed" headings, is info.
pub fn solver_line_severity(line: &str) -> Severity {
    // Swift's `.whitespaces` is spaces and tabs, not newlines.
    let t = line.trim_matches(|c: char| c.is_whitespace() && !matches!(c, '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}'));
    let lower = t.to_lowercase();
    if t.starts_with("WARNING") || lower.starts_with("warning:") {
        Severity::Warning
    } else if t.starts_with("ERROR") || lower.starts_with("error:") || lower.starts_with("fatal") {
        Severity::Error
    } else {
        Severity::Info
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(report: &StderrReport) -> Vec<(&str, Severity)> {
        report.status.iter().map(|(t, s)| (t.as_str(), *s)).collect()
    }

    #[test]
    fn a_failed_solver_shows_the_heading_and_all_of_stderr_and_logs_each_line() {
        let r = stderr_report("QNA", 2, b"bna_qna: cannot open input\nERROR: bad file\n");
        assert_eq!(r.display, "\n⚠ QNA failed (exit 2):\nbna_qna: cannot open input\nERROR: bad file\n".as_bytes());
        assert_eq!(
            lines(&r),
            vec![
                ("⚠ QNA failed (exit 2):", Severity::Info),
                ("bna_qna: cannot open input", Severity::Info),
                ("ERROR: bad file", Severity::Error),
            ]
        );
    }

    #[test]
    fn a_failure_with_no_stderr_still_says_so() {
        let r = stderr_report("Spectral Method", 139, b"");
        assert_eq!(r.display, "\n⚠ Spectral Method failed (exit 139):\n".as_bytes());
        assert_eq!(lines(&r), vec![("⚠ Spectral Method failed (exit 139):", Severity::Info)]);
    }

    #[test]
    fn a_failure_drops_blank_lines_and_trims_only_the_ends_of_the_record() {
        let r = stderr_report("SBD", 1, b"\n  first\n\n\t\nlast  \n\n");
        assert_eq!(
            lines(&r),
            vec![("⚠ SBD failed (exit 1):", Severity::Info), ("  first", Severity::Info), ("\t", Severity::Info), ("last", Severity::Info)]
        );
    }

    #[test]
    fn a_clean_exit_keeps_only_the_warning_like_lines() {
        // The same input was run through macOS awk 20200816 with 0.90.34's program.
        let stderr = b"Warning: x\nprogress 50%\nUNSTABLE net\nVande Vate\nvandevate\nvande--vate\nvande-vate\nKumar-Seidman\nkumarseidman\nkumar  seidman\nDIVERGED\nCaution!\n\n  warn lead\r\n\xc3\x89 WARN \xc3\xa9\nBramson\nforewarned\nlast warn no newline";
        let kept = warning_lines(stderr);
        assert_eq!(
            kept,
            b"Warning: x\nUNSTABLE net\nVande Vate\nvandevate\nvande-vate\nKumar-Seidman\nkumarseidman\nDIVERGED\nCaution!\n  warn lead\r\n\xc3\x89 WARN \xc3\xa9\nBramson\nforewarned\nlast warn no newline\n".to_vec()
        );
        let r = stderr_report("QNA", 0, stderr);
        assert!(r.display.is_empty());
        let got = lines(&r);
        assert_eq!(got[0], ("⚠ QNA warnings:", Severity::Info));
        assert_eq!(got[1], ("Warning: x", Severity::Warning));
        assert_eq!(got[2], ("UNSTABLE net", Severity::Info));
        // Swift does not split "\r\n", so "  warn lead\r" and the next line arrive as one entry.
        assert!(got.iter().any(|(t, _)| *t == "  warn lead\r\nÉ WARN é"));
        assert_eq!(got.last().unwrap(), &("last warn no newline", Severity::Info));
        assert_eq!(got.len(), 14);
    }

    #[test]
    fn a_clean_exit_with_only_chatter_logs_nothing() {
        assert_eq!(stderr_report("QNA", 0, b"iteration 1\niteration 2\n"), StderrReport::default());
        assert_eq!(stderr_report("QNA", 0, b""), StderrReport::default());
    }

    #[test]
    fn the_dai_vande_vate_warning_reaches_the_status_log_after_a_clean_exit() {
        let r = stderr_report("QNA", 0, b"WARNING: Dai-Vande Vate global stability condition may fail\n");
        assert_eq!(
            lines(&r),
            vec![
                ("⚠ QNA warnings:", Severity::Info),
                ("WARNING: Dai-Vande Vate global stability condition may fail", Severity::Warning),
            ]
        );
    }

    #[test]
    fn invalid_utf8_in_stderr_still_reaches_the_log() {
        let r = stderr_report("QNA", 1, b"bad \xff byte\n");
        assert_eq!(r.status[1].0, "bad \u{FFFD} byte");
    }

    #[test]
    fn solver_line_severity_reads_only_the_leading_token() {
        assert_eq!(solver_line_severity("WARNING something"), Severity::Warning);
        assert_eq!(solver_line_severity("  Warning: x"), Severity::Warning);
        assert_eq!(solver_line_severity("warning x"), Severity::Info);
        assert_eq!(solver_line_severity("Warnings: x"), Severity::Info);
        assert_eq!(solver_line_severity("ERRORS"), Severity::Error);
        assert_eq!(solver_line_severity("\tError: x"), Severity::Error);
        assert_eq!(solver_line_severity("Fatal: x"), Severity::Error);
        assert_eq!(solver_line_severity("fatality"), Severity::Error);
        assert_eq!(solver_line_severity("an error: x"), Severity::Info);
        assert_eq!(solver_line_severity("⚠ QNA warnings:"), Severity::Info);
        assert_eq!(solver_line_severity("\nWARNING"), Severity::Info);
    }
}
