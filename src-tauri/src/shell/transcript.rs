//! The Shell transcript kept across launches (shell.md §10, ledger SH-025…034, SET-187, INV-024).
//!
//! 0.90.34 kept the raw bytes in UserDefaults under `shell.savedRawBytes`; 2.0 keeps the same
//! bytes in a file of their own in the app's data folder (`shell.savedRawBytes`), written
//! atomically. At most the last 1,048,576 bytes are kept. A save of nothing leaves the file alone,
//! so launching and quitting at once doesn't wipe the history (SH-028).

use std::fs;
use std::path::{Path, PathBuf};

use crate::util::write_atomic;

/// `maxCapturedBytes`: 1 MiB.
pub const MAX_BYTES: usize = 1_048_576;

/// The transcript file in the data folder.
pub fn path_in(data_dir: &Path) -> PathBuf {
    data_dir.join("shell.savedRawBytes")
}

/// The last `MAX_BYTES` of `bytes`.
pub fn tail(bytes: &[u8]) -> &[u8] {
    if bytes.len() > MAX_BYTES {
        &bytes[bytes.len() - MAX_BYTES..]
    } else {
        bytes
    }
}

/// Saves the transcript; an empty one is not written (the previous session's stays).
pub fn save(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    if bytes.is_empty() {
        return Ok(false);
    }
    write_atomic(path, tail(bytes))?;
    Ok(true)
}

/// The saved transcript, or None when there is none (or it is empty).
pub fn load(path: &Path) -> Option<Vec<u8>> {
    let b = fs::read(path).ok()?;
    if b.is_empty() {
        None
    } else {
        Some(tail(&b).to_vec())
    }
}

/// Restart Shell…: the transcript is not replayed on the next launch (SH-034).
pub fn clear(path: &Path) {
    let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("qnet-shell-transcript-{}-{}-{n}", std::process::id(), crate::util::now_ms()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trips_raw_bytes_with_their_escapes() {
        let d = dir();
        let p = path_in(&d);
        let bytes = b"\x1b[31mred\x1b[0m \xe2\x80\x94 \xff\x00 raw\r\n".to_vec();
        assert_eq!(save(&p, &bytes), Ok(true));
        assert_eq!(load(&p), Some(bytes));
        assert_eq!(p.file_name().unwrap(), "shell.savedRawBytes");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn keeps_the_last_mebibyte() {
        let d = dir();
        let p = path_in(&d);
        let mut bytes = vec![b'a'; 10];
        bytes.extend(std::iter::repeat_n(b'b', MAX_BYTES));
        save(&p, &bytes).unwrap();
        let back = load(&p).unwrap();
        assert_eq!(back.len(), MAX_BYTES);
        assert!(back.iter().all(|&b| b == b'b'));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn an_empty_save_leaves_the_last_session_alone_and_clear_removes_it() {
        let d = dir();
        let p = path_in(&d);
        save(&p, b"previous session").unwrap();
        assert_eq!(save(&p, b""), Ok(false));
        assert_eq!(load(&p).as_deref(), Some(&b"previous session"[..]));
        clear(&p);
        assert_eq!(load(&p), None);
        let _ = fs::remove_dir_all(d);
    }
}
