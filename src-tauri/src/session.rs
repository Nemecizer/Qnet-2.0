//! The session file (ledger WS-127…140, FILE-054): a snapshot of every open tab, saved by the
//! interface 400 ms after each change and read once at launch, so the next launch reopens what the
//! user was looking at. 0.90.34 kept it as a sorted-key JSON string under the UserDefaults key
//! `tabs.persistedState`; 2.0 keeps the same object, under the same key, in `session.json` in the
//! data folder: `{"tabs.persistedState": {"activeTabID": …, "entries": [ … ]}}`. The interface owns
//! the shape (src/workspace/tabs/session.ts); this file only stores it, atomically, and sets aside a
//! file it can't read (util.rs), which the launch notice then names.
//!
//! Also here, because the window title is the tabs area's: `window_document_state`, the main
//! window's represented file and edited dot (ledger WS-004), which Tauri has no API for.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use crate::errors::QnError;
use crate::util;

/// 0.90.34's UserDefaults key, kept as the file's one key.
pub const KEY: &str = "tabs.persistedState";

pub struct Session {
    path: PathBuf,
    value: Mutex<Option<Value>>,
}

impl Session {
    /// Reads the file once; a missing file is no session, and one that can't be read is set aside.
    pub fn load(path: PathBuf) -> Session {
        let value = match util::load_json_or_quarantine::<Map<String, Value>>(&path) {
            Ok(Some(mut m)) => m.remove(KEY).filter(|v| !v.is_null()),
            Ok(None) => None,
            Err(q) => {
                eprintln!("{} couldn't be read ({}); kept it at {} and started with no session", path.display(), q.error, q.backup.display());
                None
            }
        };
        Session { path, value: Mutex::new(value) }
    }

    pub fn get(&self) -> Option<Value> {
        self.value.lock().unwrap().clone()
    }

    /// Replaces the snapshot. Compact, keys sorted (serde_json's map is ordered), as 0.90.34 wrote it.
    pub fn save(&self, snapshot: Value) -> Result<(), String> {
        let mut value = self.value.lock().unwrap();
        let mut file = Map::new();
        file.insert(KEY.into(), snapshot.clone());
        let bytes = serde_json::to_vec(&Value::Object(file)).map_err(|e| e.to_string())?;
        util::write_atomic(&self.path, &bytes)?;
        *value = Some(snapshot);
        Ok(())
    }

    /// Forgets the snapshot (Don't Restore, Never, nothing to restore).
    pub fn clear(&self) -> Result<(), String> {
        let mut value = self.value.lock().unwrap();
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Couldn't remove {}: {e}", self.path.display())),
        }
        *value = None;
        Ok(())
    }
}

/// The saved snapshot, or null when there is none.
#[tauri::command]
pub fn session_get(session: State<'_, Session>) -> Option<Value> {
    session.get()
}

#[tauri::command]
pub fn session_save(session: State<'_, Session>, snapshot: Value) -> Result<(), QnError> {
    session.save(snapshot).map_err(QnError::failed)
}

#[tauri::command]
pub fn session_clear(session: State<'_, Session>) -> Result<(), QnError> {
    session.clear().map_err(QnError::failed)
}

/// The main window's represented file (`representedFilename`, "" for none) and its edited dot
/// (`isDocumentEdited`), following the active tab (ledger WS-004, 0.90.34 `WindowDocumentState`).
#[tauri::command]
pub fn window_document_state(app: AppHandle, path: Option<String>, edited: bool) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let Some(w) = app.get_webview_window("main") else { return };
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns) = w.ns_window() {
                // SAFETY: `ns` is the main window's live NSWindow, used on the main thread.
                unsafe { set_document_state(ns, path.as_deref().unwrap_or(""), edited) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, path, edited);
}

#[cfg(target_os = "macos")]
unsafe fn set_document_state(ns: *mut std::ffi::c_void, path: &str, edited: bool) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    let win = ns as *mut AnyObject;
    if win.is_null() {
        return;
    }
    if let (Some(cls), Ok(c)) = (AnyClass::get(c"NSString"), std::ffi::CString::new(path)) {
        let s: *mut AnyObject = msg_send![cls, stringWithUTF8String: c.as_ptr()];
        if !s.is_null() {
            let _: () = msg_send![win, setRepresentedFilename: s];
        }
    }
    let _: () = msg_send![win, setDocumentEdited: Bool::new(edited)];
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qnet-session-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_saved_session_is_read_back_at_the_next_launch_under_its_old_key() {
        let d = dir("roundtrip");
        let p = d.join("session.json");
        let s = Session::load(p.clone());
        assert_eq!(s.get(), None);
        let snap = json!({"entries": [{"title": "tandem.bnet", "id": "A"}], "activeTabID": "A"});
        s.save(snap.clone()).unwrap();
        assert_eq!(s.get(), Some(snap.clone()));
        // Compact, with sorted keys (0.90.34 `writeSnapshot`: `.sortedKeys`, not pretty-printed).
        assert_eq!(fs::read_to_string(&p).unwrap(), r#"{"tabs.persistedState":{"activeTabID":"A","entries":[{"id":"A","title":"tandem.bnet"}]}}"#);
        assert_eq!(Session::load(p.clone()).get(), Some(snap));
    }

    #[test]
    fn clearing_removes_the_file_and_a_second_clear_is_fine() {
        let d = dir("clear");
        let p = d.join("session.json");
        let s = Session::load(p.clone());
        s.save(json!({"entries": []})).unwrap();
        s.clear().unwrap();
        assert!(!p.exists());
        assert_eq!(s.get(), None);
        s.clear().unwrap();
        assert_eq!(Session::load(p).get(), None);
    }

    #[test]
    fn an_unreadable_session_is_set_aside_and_qnet_starts_without_one() {
        let d = dir("corrupt");
        let p = d.join("session.json");
        fs::write(&p, br#"{"tabs.persistedState": {"entries": ["#).unwrap();
        let s = Session::load(p.clone());
        assert_eq!(s.get(), None);
        assert!(!p.exists(), "the broken file moved out of the way");
        let w = util::warnings().into_iter().find(|w| w.path == p.display().to_string()).expect("reported for the launch notice");
        assert!(w.backup.contains("session.json.corrupt-"), "{}", w.backup);
    }
}
