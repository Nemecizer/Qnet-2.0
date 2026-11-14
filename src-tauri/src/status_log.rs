//! Save Status Log… (0.90.34 `StatusLogExport.save`, ledger LOG-022…024, FILE-046…048): the
//! interface asks where (the dialog plugin's save panel) and formats the entries
//! (`StatusEntry.formattedLine`, which needs the locale's time style); this writes the text
//! atomically and hands back the path as the Status line shows it, abbreviated with a tilde.

use std::path::Path;

use crate::errors::QnError;
use crate::util;

/// `path` with the home folder written as "~" (`NSString.abbreviatingWithTildeInPath`).
pub fn abbreviate_with_tilde(path: &str, home: Option<&str>) -> String {
    match home.map(|h| h.trim_end_matches('/')).filter(|h| !h.is_empty()) {
        Some(h) if path == h => "~".into(),
        Some(h) if path.starts_with(&format!("{h}/")) => format!("~{}", &path[h.len()..]),
        _ => path.to_string(),
    }
}

/// Writes `text` to `path` in one step and returns the path as the log reports it. A failure's
/// message is the reason alone; the interface puts it after "Could not save the status log: ".
#[tauri::command]
pub fn status_log_write(path: String, text: String) -> Result<String, QnError> {
    util::write_atomic(Path::new(&path), text.as_bytes()).map_err(|e| {
        // write_atomic says "Couldn't save <path>: <reason>"; the Status line names no path twice.
        let reason = e.split_once(": ").map(|(_, r)| r.to_string()).unwrap_or(e);
        QnError::failed(reason)
    })?;
    Ok(abbreviate_with_tilde(&path, std::env::var("HOME").ok().as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_home_folder_becomes_a_tilde() {
        assert_eq!(abbreviate_with_tilde("/Users/a/Desktop/x-status.txt", Some("/Users/a")), "~/Desktop/x-status.txt");
        assert_eq!(abbreviate_with_tilde("/Users/ab/x.txt", Some("/Users/a")), "/Users/ab/x.txt");
        assert_eq!(abbreviate_with_tilde("/tmp/x.txt", None), "/tmp/x.txt");
    }

    #[test]
    fn it_writes_the_text_and_reports_a_failure_by_its_reason() {
        let dir = std::env::temp_dir().join(format!("qnet-status-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("Untitled-status.txt");
        let shown = status_log_write(p.display().to_string(), "[1:02:03 PM] Ready.\n".into()).unwrap();
        assert!(shown.ends_with("Untitled-status.txt"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "[1:02:03 PM] Ready.\n");
        // A file where the folder should be.
        let bad = p.join("inside.txt");
        let e = status_log_write(bad.display().to_string(), "x".into()).unwrap_err();
        assert!(!e.message.contains("Couldn't save"), "{}", e.message);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
