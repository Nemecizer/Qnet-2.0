//! Reading the progress files the simulators write when given `-P <file>`: a decimal total and a
//! newline, then one `.` per completed unit. The status bar shows the fraction done; a step's own
//! tick hook can draw the Shell's bar from the count.
//!
//! Ports `TerminalModel.progressFraction(in:)` and `registerProgressFile` and
//! `QnetGUIApp.progressFilePath(label:)` from 0.90.34 (ledger RUN-027, FILE-026, INV-023). The
//! header is read exactly as 0.90.34 read it: the first 24 bytes decoded as UTF-8, the text up to
//! the first newline parsed as a Swift `Int`, a total of at least 1, and the units done taken as the
//! file's size less the header, capped at 1 for the fraction. The first registered file with a
//! usable header wins, so a comparison that runs several simulators one after another shows each in
//! turn as long as each step's file is removed when its step ends (the job does that).

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The header and units done of one progress file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressCount {
    /// The total the solver announced (at least 1).
    pub total: i64,
    /// Bytes after the header, which is units done; it can exceed `total`.
    pub done: i64,
}

impl ProgressCount {
    /// The fraction done, capped at 1.
    pub fn fraction(&self) -> f64 {
        let f = self.done as f64 / self.total as f64;
        if f < 1.0 {
            f
        } else {
            1.0
        }
    }
}

/// Reads one progress file, or `None` when it does not exist or has no usable header yet.
pub fn read_progress(path: &Path) -> Option<ProgressCount> {
    let mut file = File::open(path).ok()?;
    let mut head = [0u8; 24];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return None,
        }
    }
    if filled == 0 {
        return None;
    }
    let text = std::str::from_utf8(&head[..filled]).ok()?;
    let header = &text[..swift_first_newline(text)?];
    let total = parse_swift_int(header)?;
    if total <= 0 {
        return None;
    }
    let size = file.metadata().ok()?.len() as i64;
    let done = (size - (header.len() as i64 + 1)).max(0);
    Some(ProgressCount { total, done })
}

/// The fraction done according to the first file in `paths` that exists and has a usable header,
/// or `None` (the status bar then shows its indeterminate form).
pub fn progress_fraction<P: AsRef<Path>>(paths: &[P]) -> Option<f64> {
    paths.iter().find_map(|p| read_progress(p.as_ref())).map(|c| c.fraction())
}

/// A fresh progress-file path in `dir`, named as 0.90.34 named them:
/// `BNET_progress_<label>_<pid>_<microseconds since 1970>.bin`.
pub fn progress_file_path(dir: &Path, label: &str) -> PathBuf {
    let micros = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros()).unwrap_or(0);
    dir.join(format!("BNET_progress_{label}_{}_{micros}.bin", std::process::id()))
}

/// The byte offset of the first "\n" that Swift's `firstIndex(of: "\n")` finds: a "\r\n" pair is
/// one character there and does not match.
fn swift_first_newline(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    (0..bytes.len()).find(|&i| bytes[i] == b'\n' && !(i > 0 && bytes[i - 1] == b'\r'))
}

/// Swift's `Int(String)`: an optional sign, then one or more ASCII digits, nothing else, in range.
fn parse_swift_int(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qnet-progress-unit-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn the_fraction_is_dots_over_the_announced_total() {
        let p = scratch("a.bin", b"8\n...");
        assert_eq!(read_progress(&p), Some(ProgressCount { total: 8, done: 3 }));
        assert_eq!(progress_fraction(&[&p]), Some(0.375));
        fs::remove_file(p).unwrap();
    }

    #[test]
    fn more_dots_than_the_total_is_capped_at_one() {
        let p = scratch("b.bin", b"2\n.....");
        assert_eq!(progress_fraction(&[&p]), Some(1.0));
        fs::remove_file(p).unwrap();
    }

    #[test]
    fn a_header_without_its_newline_or_with_a_bad_total_is_not_yet_usable() {
        for (name, bytes) in [
            ("c1", &b""[..]),
            ("c2", b"200"),
            ("c3", b"0\n..."),
            ("c4", b"-5\n"),
            ("c5", b" 5\n"),
            ("c6", b"5x\n"),
            ("c7", b"5\r\n.."),
            ("c8", b"\n"),
            ("c9", b"0000000000000000000000001\n"),
        ] {
            let p = scratch(name, bytes);
            assert_eq!(read_progress(&p), None, "{name}");
            fs::remove_file(p).unwrap();
        }
    }

    #[test]
    fn a_signed_or_zero_padded_total_parses_as_swift_int_does() {
        let p = scratch("d.bin", b"+04\n..");
        assert_eq!(read_progress(&p), Some(ProgressCount { total: 4, done: 2 }));
        fs::remove_file(p).unwrap();
    }

    #[test]
    fn the_first_usable_file_wins_and_missing_files_are_skipped() {
        let missing = std::env::temp_dir().join("qnet-progress-unit-missing.bin");
        let empty = scratch("e1.bin", b"");
        let second = scratch("e2.bin", b"4\n.");
        let third = scratch("e3.bin", b"4\n...");
        assert_eq!(progress_fraction(&[&missing, &empty, &second, &third]), Some(0.25));
        assert_eq!(progress_fraction::<PathBuf>(&[]), None);
        for p in [empty, second, third] {
            fs::remove_file(p).unwrap();
        }
    }

    #[test]
    fn progress_files_are_named_as_0_90_34_named_them() {
        let p = progress_file_path(Path::new("/tmp"), "inf_cmp_sim");
        let name = p.file_name().unwrap().to_str().unwrap();
        let prefix = format!("BNET_progress_inf_cmp_sim_{}_", std::process::id());
        assert!(name.starts_with(&prefix) && name.ends_with(".bin"), "{name}");
        assert!(name[prefix.len()..name.len() - 4].bytes().all(|b| b.is_ascii_digit()));
    }
}
