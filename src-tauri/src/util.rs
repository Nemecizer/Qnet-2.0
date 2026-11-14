//! Saving and loading Qnet's own files without ever leaving half of one behind (from NetMon).
//!
//! `write_atomic` writes a temporary file next to the target, flushes it to disk and renames it
//! over the original, so a crash or power cut leaves either the old file or the new one.
//! `load_json_or_quarantine` moves a file it can't parse out of the way (keeping it for the user)
//! instead of silently replacing it with defaults, and remembers the problem for
//! `persistence_warnings`, so the interface can say which file was set aside and where it went.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;

/// A file that couldn't be read and was set aside.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quarantined {
    /// Where the unreadable original now is.
    pub backup: PathBuf,
    pub error: String,
}

/// One line for the "some settings couldn't be read" notice.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceWarning {
    /// The file's name, e.g. "prefs.json".
    pub file: String,
    pub path: String,
    pub backup: String,
    pub error: String,
    pub ts_ms: u64,
}

static WARNINGS: Mutex<Vec<PersistenceWarning>> = Mutex::new(Vec::new());

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Replaces `path` with `bytes` in one step: temporary file in the same folder, fsync, rename, fsync the folder.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let mut nonce = [0u8; 4];
    let _ = getrandom::fill(&mut nonce);
    let tmp = dir.join(format!(".{name}.tmp-{}-{:08x}", std::process::id(), u32::from_le_bytes(nonce)));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        // The rename itself is only durable once the folder is flushed too.
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok::<(), std::io::Error>(())
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't save {}: {e}", path.display())
    })
}

/// Serialises `value` as pretty JSON and saves it atomically.
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(path, &json)
}

/// Reads JSON from `path`. A missing file is `Ok(None)`. A file that can't be parsed is moved to
/// `<name>.corrupt-<unix ms>` and reported (also through `warnings()`), so the caller can start
/// from defaults without destroying what was there.
pub fn load_json_or_quarantine<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, Quarantined> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            // Unreadable (permissions…): leave it where it is, but don't pretend it's fine.
            let q = Quarantined { backup: path.to_path_buf(), error: e.to_string() };
            remember(path, &q);
            return Err(q);
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let backup = path.with_file_name(format!("{name}.corrupt-{}", now_ms()));
            let backup = match fs::rename(path, &backup) {
                Ok(()) => backup,
                Err(_) => path.to_path_buf(),
            };
            let q = Quarantined { backup, error: e.to_string() };
            remember(path, &q);
            Err(q)
        }
    }
}

/// Like `load_json_or_quarantine`, falling back to the type's default (and logging why).
pub fn load_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    match load_json_or_quarantine(path) {
        Ok(v) => v.unwrap_or_default(),
        Err(q) => {
            eprintln!("{} couldn't be read ({}); kept it at {} and started fresh", path.display(), q.error, q.backup.display());
            T::default()
        }
    }
}

fn remember(path: &Path, q: &Quarantined) {
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let full = path.display().to_string();
    let mut w = WARNINGS.lock().unwrap();
    w.retain(|x| x.path != full);
    w.push(PersistenceWarning { file, path: full, backup: q.backup.display().to_string(), error: q.error.clone(), ts_ms: now_ms() });
}

/// The warning for one file this session, if it was set aside. (Tests only until P4's notice
/// can dismiss one.)
#[cfg(test)]
pub fn warning_for(path: &Path) -> Option<PersistenceWarning> {
    let full = path.display().to_string();
    WARNINGS.lock().unwrap().iter().find(|w| w.path == full).cloned()
}

/// Every file set aside since launch, for the notice.
pub fn warnings() -> Vec<PersistenceWarning> {
    WARNINGS.lock().unwrap().clone()
}

/// Forgets the warning for one file (after the user dealt with it).
#[cfg(test)]
pub fn clear_warning(path: &Path) {
    let full = path.display().to_string();
    WARNINGS.lock().unwrap().retain(|w| w.path != full);
}

/// Tauri command: files that couldn't be read this session.
#[tauri::command]
pub fn persistence_warnings() -> Vec<PersistenceWarning> {
    warnings()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Thing {
        name: String,
        n: u32,
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qnet-util-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn atomic_writes_replace_the_file_and_leave_no_temporaries() {
        let d = dir("atomic");
        let p = d.join("sub").join("prefs.json");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        let names: Vec<String> = fs::read_dir(p.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        assert_eq!(names, vec!["prefs.json".to_string()], "temporary files are gone");
    }

    #[test]
    fn json_round_trips_and_missing_is_none() {
        let d = dir("json");
        let p = d.join("thing.json");
        assert_eq!(load_json_or_quarantine::<Thing>(&p), Ok(None));
        save_json(&p, &Thing { name: "S1".into(), n: 4 }).unwrap();
        assert_eq!(load_json_or_quarantine::<Thing>(&p), Ok(Some(Thing { name: "S1".into(), n: 4 })));
    }

    #[test]
    fn a_half_written_file_is_quarantined_and_reported() {
        let d = dir("corrupt");
        let p = d.join("thing-corrupt.json");
        fs::write(&p, br#"{"name": "S1", "n": 4"#).unwrap();
        let q = load_json_or_quarantine::<Thing>(&p).unwrap_err();
        assert!(!p.exists(), "the broken file moved out of the way");
        assert!(q.backup.file_name().unwrap().to_string_lossy().starts_with("thing-corrupt.json.corrupt-"));
        assert_eq!(fs::read_to_string(&q.backup).unwrap(), r#"{"name": "S1", "n": 4"#, "the original is kept");
        assert!(q.error.contains("EOF"), "{}", q.error);
        assert!(warnings().iter().any(|w| w.file == "thing-corrupt.json" && w.backup == q.backup.display().to_string()));
        assert!(warning_for(&p).is_some());

        // Starting fresh afterwards works, and the backup stays.
        let fresh: Thing = load_json_or_default(&p);
        assert_eq!(fresh, Thing::default());
        assert!(q.backup.exists());
        clear_warning(&p);
        assert!(warning_for(&p).is_none());
    }
}
