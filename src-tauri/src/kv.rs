//! Two key-value files that replace 0.90.34's `UserDefaults` domain (ledger WS-052, 6.15, 6.16):
//!
//! - `settings.json` (config folder): the AppSettings keys under 0.90.34's own names
//!   (`palette.paneVisible`, `tabs.restoreBehavior`, `mlmc.epsilon`…), the set that Settings shows,
//!   resets, exports and imports. What each key holds and allows is `settings_schema.rs`.
//! - `state.json` (data folder): what 0.90.34 kept in `UserDefaults` outside AppSettings (split
//!   sizes, Open Recent, one-time migration flags…), also under its old key names. Not exported.
//!
//! Both are flat JSON objects written atomically; a file that can't be read is set aside and
//! reported (util.rs), and Qnet starts from defaults. A patch is `{key: value}`, where `null`
//! removes the key (back to its default). Every change is broadcast as `kv://changed` with
//! `{store, patch}`, so every window sees it.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::errors::QnError;
use crate::{settings_schema, util};

pub struct KvStore {
    path: PathBuf,
    values: Mutex<Map<String, Value>>,
}

impl KvStore {
    /// Loads `path`; a missing file is empty, and one that can't be read is set aside.
    pub fn load(path: PathBuf) -> KvStore {
        let values: Map<String, Value> = util::load_json_or_default(&path);
        KvStore { path, values: Mutex::new(values) }
    }

    /// Every stored value (defaults are not filled in here).
    pub fn snapshot(&self) -> Map<String, Value> {
        self.values.lock().unwrap().clone()
    }

    /// Applies `patch` (`null` removes) under one lock and saves; on a failed save nothing changes.
    pub fn patch(&self, patch: &Map<String, Value>) -> Result<Map<String, Value>, String> {
        let mut values = self.values.lock().unwrap();
        let mut next = values.clone();
        for (k, v) in patch {
            if v.is_null() {
                next.remove(k);
            } else {
                next.insert(k.clone(), v.clone());
            }
        }
        util::save_json(&self.path, &next)?;
        *values = next.clone();
        Ok(next)
    }
}

pub struct Stores {
    pub settings: KvStore,
    pub state: KvStore,
}

#[derive(Clone, Serialize)]
struct Changed<'a> {
    store: &'a str,
    patch: &'a Map<String, Value>,
}

fn object(patch: Value) -> Result<Map<String, Value>, QnError> {
    match patch {
        Value::Object(m) => Ok(m),
        _ => Err(QnError::invalid("Settings change as {key: value}.")),
    }
}

/// Every setting: the stored value, or the key's default when none is stored.
#[tauri::command]
pub fn settings_get(stores: State<'_, Stores>) -> Map<String, Value> {
    settings_schema::with_defaults(&stores.settings.snapshot())
}

/// Changes the given settings. Each value is checked against its key's type and range first;
/// one bad value refuses the whole patch with a sentence naming the key.
#[tauri::command]
pub fn settings_patch(app: AppHandle, stores: State<'_, Stores>, patch: Value) -> Result<Map<String, Value>, QnError> {
    let patch = object(patch)?;
    for (k, v) in &patch {
        if !v.is_null() {
            settings_schema::validate(k, v).map_err(QnError::invalid)?;
        }
    }
    stores.settings.patch(&patch).map_err(QnError::failed)?;
    let _ = app.emit("kv://changed", Changed { store: "settings", patch: &patch });
    Ok(settings_schema::with_defaults(&stores.settings.snapshot()))
}

/// Internal state as stored (no defaults: each reader knows its own).
#[tauri::command]
pub fn state_get(stores: State<'_, Stores>) -> Map<String, Value> {
    stores.state.snapshot()
}

#[tauri::command]
pub fn state_patch(app: AppHandle, stores: State<'_, Stores>, patch: Value) -> Result<Map<String, Value>, QnError> {
    let patch = object(patch)?;
    let next = stores.state.patch(&patch).map_err(QnError::failed)?;
    let _ = app.emit("kv://changed", Changed { store: "state", patch: &patch });
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qnet-kv-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("store.json")
    }

    #[test]
    fn a_patch_sets_and_removes_keys_and_survives_a_reload() {
        let path = temp("patch");
        let s = KvStore::load(path.clone());
        assert!(s.snapshot().is_empty());
        let m = |v: Value| v.as_object().unwrap().clone();
        s.patch(&m(json!({"status.paneVisible": false, "SplitPane.TopHSplit.palette": 176.0}))).unwrap();
        s.patch(&m(json!({"SplitPane.TopHSplit.palette": null}))).unwrap();
        let again = KvStore::load(path);
        assert_eq!(Value::Object(again.snapshot()), json!({"status.paneVisible": false}));
    }

    #[test]
    fn a_broken_file_is_set_aside_and_the_store_starts_empty() {
        let path = temp("broken");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{\"a\": ").unwrap();
        let s = KvStore::load(path.clone());
        assert!(s.snapshot().is_empty());
        assert!(util::warning_for(&path).is_some());
        util::clear_warning(&path);
    }
}
