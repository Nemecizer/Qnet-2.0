//! Settings ▸ General ▸ Export… and Import…: 0.90.34's configuration file (AppSettings.swift
//! `exportedSettings`, `exportedSettingsJSON`, `importSettings(json:)`, `importSettings(_:)`;
//! SettingsView.swift `GeneralPane.exportSettings`, `importSettings`; ledger FILE-049…053,
//! SET-042…048).
//!
//! An export is one JSON object: every key of the schema (the 108 of 0.90.34's `defaultsByKey`)
//! with its stored value or its default, plus `qnet.settingsFormat` (1), `qnet.exportedAt` (ISO
//! 8601, UTC) and `qnet.appVersion`, written the way `JSONSerialization` with `.prettyPrinted` and
//! `.sortedKeys` writes it (two-space indent, `"key" : value`, `\/` for a slash, a whole Double as
//! `12`), so the two apps' files look alike. An import reads either app's file: it refuses a file
//! that isn't an object or whose format is newer than 1, skips the metadata keys, checks every
//! other key in sorted order (`settings_schema::rejection`), leaves refused keys alone, counts a
//! value equal to the current one as "already matched", and stores the rest (an Int key as a
//! whole number). API keys are never in either direction.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Number, Value};
use tauri::{AppHandle, Emitter, State};

use crate::errors::QnError;
use crate::kv::Stores;
use crate::settings_schema::{self, Kind};
use crate::util;

/// The format version this build writes and reads (0.90.34 `exportFormatVersion`).
pub const FORMAT_VERSION: i64 = 1;
pub const FORMAT_KEY: &str = "qnet.settingsFormat";
pub const DATE_KEY: &str = "qnet.exportedAt";
pub const VERSION_KEY: &str = "qnet.appVersion";
pub const METADATA_KEYS: [&str; 3] = [FORMAT_KEY, DATE_KEY, VERSION_KEY];

/// Refused values the report names inline before it says "Show Details…" instead (0.90.34
/// `GeneralPane.inlineRefusalLimit`).
pub const INLINE_REFUSAL_LIMIT: usize = 4;

/// The export of `settings` (every key, defaults filled in), stamped with `app_version` and
/// `exported_at`.
pub fn export_text(settings: &Map<String, Value>, app_version: &str, exported_at: &str) -> String {
    let full = settings_schema::with_defaults(settings);
    let mut out: Vec<(String, Value)> = full.into_iter().collect();
    out.push((FORMAT_KEY.into(), Value::from(FORMAT_VERSION)));
    out.push((DATE_KEY.into(), Value::from(exported_at)));
    out.push((VERSION_KEY.into(), Value::from(app_version)));
    // `.sortedKeys`: NSString `compare:`, which for these ASCII keys is byte order.
    out.sort_by(|a, b| a.0.cmp(&b.0));
    let mut s = String::from("{\n");
    for (i, (k, v)) in out.iter().enumerate() {
        s.push_str("  ");
        s.push_str(&json_string(k));
        s.push_str(" : ");
        s.push_str(&json_scalar(v));
        if i + 1 < out.len() {
            s.push(',');
        }
        s.push('\n');
    }
    s.push('}');
    s
}

/// A string as `JSONSerialization` writes it: `\"`, `\\`, `\/`, the short escapes, `\uXXXX` for
/// other control characters, and everything else as UTF-8.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '/' => out.push_str("\\/"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A number as `JSONSerialization` writes an `NSNumber`: integers as integers, a Double in its
/// shortest form, a whole Double without a fraction (`12`, not `12.0`).
fn json_number(n: &Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

fn json_scalar(v: &Value) -> String {
    match v {
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => json_number(n),
        Value::String(s) => json_string(s),
        Value::Null => "null".into(),
        // Settings are scalars; anything else is written as serde_json would.
        other => other.to_string(),
    }
}

/// `ISO8601DateFormatter().string(from:)`: `2026-11-11T09:41:05Z`.
pub fn iso8601_utc(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let secs = unix_seconds.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub key: String,
    pub reason: String,
    /// "SRBM MLMC ▸ Path length T": the pane and row, or the key when no row edits it.
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub applied: Vec<String>,
    pub unchanged: Vec<String>,
    pub rejected: Vec<Refusal>,
}

/// What an import decided: the report, and the values to store.
pub struct ImportPlan {
    pub report: ImportReport,
    pub patch: Map<String, Value>,
}

fn same_stored(a: &Value, b: &Value) -> bool {
    // `storageSignature`: numbers (and the NSNumber of a Bool) compare by their double value.
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// 0.90.34's `importSettings(json:)` against `current` (every setting, defaults filled in).
/// `Err` is the sentence 0.90.34 showed after "Could not import: ".
pub fn plan_import(bytes: &[u8], current: &Map<String, Value>) -> Result<ImportPlan, String> {
    let parsed: Value = serde_json::from_slice(bytes)
        .map_err(|_| "The data couldn’t be read because it isn’t in the correct format.".to_string())?;
    let Value::Object(dict) = parsed else {
        return Err("The file is not a Qnet settings export (expected a JSON object of setting keys).".into());
    };
    if let Some(format) = dict.get(FORMAT_KEY).filter(|v| v.is_number()).and_then(Value::as_f64) {
        let format = format.trunc() as i64;
        if format > FORMAT_VERSION {
            let writer = dict.get(VERSION_KEY).and_then(Value::as_str).map(|v| format!(" by Qnet {v}")).unwrap_or_default();
            return Err(format!(
                "The file uses settings format {format} (written{writer}); this build reads format {FORMAT_VERSION} or older. Update Qnet to import it."
            ));
        }
    }
    let mut keys: Vec<&String> = dict.keys().collect();
    keys.sort();
    let mut report = ImportReport::default();
    let mut patch = Map::new();
    for key in keys {
        if METADATA_KEYS.contains(&key.as_str()) {
            continue;
        }
        let value = &dict[key];
        if let Some(reason) = settings_schema::rejection(key, value) {
            report.rejected.push(Refusal { key: key.clone(), reason: reason.description(), name: key.clone() });
            continue;
        }
        let kind = settings_schema::find(key).map(|k| k.kind);
        let stored = match (kind, value.as_f64()) {
            (Some(Kind::Int), Some(n)) => Value::from(n as i64),
            _ => value.clone(),
        };
        if current.get(key.as_str()).is_some_and(|c| same_stored(c, &stored)) {
            report.unchanged.push(key.clone());
            continue;
        }
        patch.insert(key.clone(), stored);
        report.applied.push(key.clone());
    }
    Ok(ImportPlan { report, patch })
}

/// How the report reads (SettingsView.swift `GeneralPane.importSettings`), and its status icon:
/// "success", "info" (some refused, some applied) or "failure" (nothing applied and some refused).
pub fn report_text(file_name: &str, report: &ImportReport) -> (String, &'static str) {
    let applied = report.applied.len();
    let mut text = format!("Imported {file_name}: {applied} {} changed", if applied == 1 { "setting" } else { "settings" });
    if !report.unchanged.is_empty() {
        text.push_str(&format!(", {} already matched", report.unchanged.len()));
    }
    let refused = &report.rejected;
    if refused.is_empty() {
        text.push('.');
        return (text, "success");
    }
    if refused.len() <= INLINE_REFUSAL_LIMIT {
        let listed: Vec<String> = refused.iter().map(|r| format!("{} ({})", r.name, r.reason)).collect();
        text.push_str(&format!("; {} refused and left unchanged: {}.", refused.len(), listed.join("; ")));
    } else {
        text.push_str(&format!("; {} refused and left unchanged.", refused.len()));
    }
    (text, if applied > 0 { "info" } else { "failure" })
}

/// The version an export is tagged with (0.90.34 wrote `AppVersion.fullVersion`).
pub fn app_version(app: &AppHandle) -> String {
    format!("{} ({})", app.package_info().version, env!("QNET_BUILD_TAG"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub message: String,
    pub count: usize,
}

/// Writes every setting to `path` (Settings ▸ General ▸ Export…). The message is the report
/// line; a failure is "Could not export: …".
#[tauri::command]
pub fn settings_export(app: AppHandle, stores: State<'_, Stores>, path: String) -> Result<ExportOutcome, QnError> {
    let version = app_version(&app);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let text = export_text(&stores.settings.snapshot(), &version, &iso8601_utc(now));
    let path = Path::new(&path);
    util::write_atomic(path, text.as_bytes()).map_err(|e| QnError::failed(format!("Could not export: {e}")))?;
    let count = settings_schema::KEYS.len();
    Ok(ExportOutcome { message: format!("Exported {count} settings to {} (tagged Qnet {version}).", file_name(path)), count })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    #[serde(flatten)]
    pub report: ImportReport,
    pub message: String,
    /// "success", "info" or "failure".
    pub status: &'static str,
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// Reads a settings export (Settings ▸ General ▸ Import…). `names` maps a stored key to the pane
/// and row the window shows it under ("SRBM MLMC ▸ Path length T"), for the report. A file that
/// can't be read or is refused whole is "Could not import: …" and changes nothing.
#[tauri::command]
pub fn settings_import(
    app: AppHandle,
    stores: State<'_, Stores>,
    path: String,
    names: Option<HashMap<String, String>>,
) -> Result<ImportOutcome, QnError> {
    let path = Path::new(&path);
    let bytes = std::fs::read(path).map_err(|e| {
        let why = if e.kind() == std::io::ErrorKind::NotFound {
            format!("The file “{}” couldn’t be opened because there is no such file.", file_name(path))
        } else {
            format!("The file “{}” couldn’t be opened.", file_name(path))
        };
        QnError::failed(format!("Could not import: {why}")).with_detail(e.to_string())
    })?;
    let current = settings_schema::with_defaults(&stores.settings.snapshot());
    let mut plan = plan_import(&bytes, &current).map_err(|why| QnError::invalid(format!("Could not import: {why}")))?;
    if let Some(names) = &names {
        for r in &mut plan.report.rejected {
            if let Some(n) = names.get(&r.key) {
                r.name = n.clone();
            }
        }
    }
    if !plan.patch.is_empty() {
        stores.settings.patch(&plan.patch).map_err(|e| QnError::failed(format!("Could not import: {e}")))?;
        let _ = app.emit("kv://changed", serde_json::json!({ "store": "settings", "patch": plan.patch }));
    }
    let (message, status) = report_text(&file_name(path), &plan.report);
    Ok(ImportOutcome { report: plan.report, message, status })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults() -> Map<String, Value> {
        settings_schema::with_defaults(&Map::new())
    }

    fn fixture_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    #[test]
    fn an_export_is_0_90_34s_pretty_printed_sorted_object() {
        let mut stored = Map::new();
        stored.insert("shell.fontSize".into(), json!(14.0));
        stored.insert("mlmc.epsilon".into(), json!(0.005));
        let text = export_text(&stored, "2.0.0 (test)", "2026-11-11T09:41:05Z");
        let v: Value = serde_json::from_str(&text).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), settings_schema::KEYS.len() + 3);
        assert_eq!(obj[FORMAT_KEY], json!(1));
        assert_eq!(obj[DATE_KEY], json!("2026-11-11T09:41:05Z"));
        assert_eq!(obj[VERSION_KEY], json!("2.0.0 (test)"));
        assert!(text.starts_with("{\n  \"ai.baseURL.anthropic\" : \"https:\\/\\/api.anthropic.com\",\n"), "{}", &text[..120]);
        assert!(text.contains("\n  \"shell.fontSize\" : 14,\n"));
        assert!(text.contains("\n  \"status.fontSize\" : 12,\n"));
        assert!(text.contains("\n  \"mlmc.epsilon\" : 0.005,\n"));
        assert!(text.contains("\n  \"ai.temperature\" : 0.7,\n"));
        assert!(text.contains("\n  \"sim.seedFixed\" : false,\n"));
        assert!(text.ends_with("\"welcome.showAtLaunch\" : true\n}"));
        let keys: Vec<&str> = text.lines().filter_map(|l| l.trim().strip_prefix('"')).map(|l| &l[..l.find('"').unwrap()]).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
        // Exporting what an import of it stores changes nothing.
        let plan = plan_import(text.as_bytes(), &settings_schema::with_defaults(&stored)).unwrap();
        assert!(plan.patch.is_empty());
        assert_eq!(plan.report.unchanged.len(), settings_schema::KEYS.len());
        assert!(plan.report.rejected.is_empty());
    }

    #[test]
    fn dates_are_iso_8601_in_utc() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(1_778_492_465), "2026-05-11T09:41:05Z");
        assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn a_file_that_is_not_an_object_or_is_too_new_is_refused_whole() {
        let d = defaults();
        assert_eq!(plan_import(b"[1, 2]", &d).err().unwrap(), "The file is not a Qnet settings export (expected a JSON object of setting keys).");
        assert_eq!(plan_import(b"{ nope", &d).err().unwrap(), "The data couldn’t be read because it isn’t in the correct format.");
        assert_eq!(
            plan_import(br#"{"qnet.settingsFormat": 2, "qnet.appVersion": "0.95.0", "sim.seed": 7}"#, &d).err().unwrap(),
            "The file uses settings format 2 (written by Qnet 0.95.0); this build reads format 1 or older. Update Qnet to import it."
        );
        assert_eq!(
            plan_import(br#"{"qnet.settingsFormat": 3}"#, &d).err().unwrap(),
            "The file uses settings format 3 (written); this build reads format 1 or older. Update Qnet to import it."
        );
        assert!(plan_import(br#"{"qnet.settingsFormat": 1}"#, &d).is_ok());
    }

    #[test]
    fn each_key_is_checked_in_sorted_order_and_refusals_are_reported() {
        let d = defaults();
        let file = br#"{
            "sim.seed": 7, "sim.replications": 0, "zzz.unknown": 1, "sm.legendre": "yes",
            "fem.meshSize": 10, "mlmc.L": 4.0, "ai.provider": "gemini", "qnet.exportedAt": "x"
        }"#;
        let plan = plan_import(file, &d).unwrap();
        assert_eq!(plan.report.applied, vec!["mlmc.L", "sim.seed"]);
        assert_eq!(plan.report.unchanged, vec!["fem.meshSize"]);
        let refused: Vec<(&str, &str)> = plan.report.rejected.iter().map(|r| (r.key.as_str(), r.reason.as_str())).collect();
        assert_eq!(
            refused,
            vec![
                ("ai.provider", "not one of anthropic, openai, ollama, lmstudio"),
                ("sim.replications", "outside 1…10,000"),
                ("sm.legendre", "expected true or false"),
                ("zzz.unknown", "not a Qnet setting"),
            ]
        );
        // An Int key is stored as a whole number.
        assert_eq!(plan.patch["mlmc.L"], json!(4));
        assert!(plan.patch["mlmc.L"].is_i64());
        let (text, status) = report_text("tuned.json", &plan.report);
        assert_eq!(
            text,
            "Imported tuned.json: 2 settings changed, 1 already matched; 4 refused and left unchanged: ai.provider (not one of anthropic, openai, ollama, lmstudio); sim.replications (outside 1…10,000); sm.legendre (expected true or false); zzz.unknown (not a Qnet setting)."
        );
        assert_eq!(status, "info");
    }

    #[test]
    fn the_report_reads_as_0_90_34s() {
        let mut r = ImportReport { applied: vec!["a".into()], ..Default::default() };
        assert_eq!(report_text("x.json", &r), ("Imported x.json: 1 setting changed.".into(), "success"));
        r.applied.clear();
        r.unchanged = vec!["b".into(); 3];
        assert_eq!(report_text("x.json", &r).0, "Imported x.json: 0 settings changed, 3 already matched.");
        r.rejected = (0..5).map(|i| Refusal { key: format!("k{i}"), reason: "not a Qnet setting".into(), name: format!("k{i}") }).collect();
        assert_eq!(report_text("x.json", &r), ("Imported x.json: 0 settings changed, 3 already matched; 5 refused and left unchanged.".into(), "failure"));
    }

    /// Every value of `file` that is a setting, as stored after an import into a fresh install,
    /// must equal the file's own value (numbers by value: `0.9` is `0.9`, `10` is `10.0`).
    fn assert_imports_intact(path: &Path) {
        let bytes = std::fs::read(path).unwrap();
        let file: Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
        let mut stored = defaults();
        let plan = plan_import(&bytes, &stored).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(plan.report.rejected.is_empty(), "{}: refused {:#?}", path.display(), plan.report.rejected);
        for (k, v) in plan.patch {
            stored.insert(k, v);
        }
        let mut checked = 0;
        for (k, v) in &file {
            if METADATA_KEYS.contains(&k.as_str()) {
                continue;
            }
            let got = &stored[k];
            assert!(same_stored(got, v), "{}: {k} imported as {got}, file has {v}", path.display());
            checked += 1;
        }
        // And exporting it again writes the same values.
        let again: Map<String, Value> = serde_json::from_str(&export_text(&stored, "2.0.0 (test)", "2026-11-11T00:00:00Z")).unwrap();
        for (k, v) in &file {
            if !METADATA_KEYS.contains(&k.as_str()) {
                assert!(same_stored(&again[k], v), "{}: {k} exported again as {}, file has {v}", path.display(), again[k]);
            }
        }
        assert!(checked > 0, "{}: no settings in the file", path.display());
    }

    /// PLAN.md P4's acceptance (ledger INV-082): a settings file written by 0.90.34's
    /// `exportedSettingsJSON()` imports with every value intact. The fixture is constructed (see
    /// tests/fixtures/README.md), with a non-default value for every one of the 108 keys.
    #[test]
    fn a_0_90_34_export_imports_with_every_value_intact() {
        let path = fixture_dir().join("settings-0.90.34-constructed.json");
        let bytes = std::fs::read(&path).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        let file: Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(file.len(), 111, "108 settings and 3 metadata keys");
        assert_eq!(file[FORMAT_KEY], json!(1));
        // Every key differs from its default, so an import that dropped one would show.
        let d = defaults();
        // (The keys 2.1 added after 0.90.34's 108 are not in a 0.90.34 file.)
        for k in settings_schema::KEYS.iter().take(108) {
            assert!(!same_stored(&file[k.name], &d[k.name]), "{} holds its default in the fixture", k.name);
        }
        // It is the shape JSONSerialization writes; our own export of the same values is byte
        // for byte the same file.
        let plan = plan_import(&bytes, &d).unwrap();
        assert_eq!(plan.report.applied.len(), 108);
        let mut stored = Map::new();
        for (k, v) in plan.patch {
            stored.insert(k, v);
        }
        let version = file[VERSION_KEY].as_str().unwrap();
        let date = file[DATE_KEY].as_str().unwrap();
        // Our export also writes the keys added since; without their lines it is the same file.
        let added: Vec<String> = settings_schema::KEYS.iter().skip(108).map(|k| format!("  \"{}\" :", k.name)).collect();
        let exported = export_text(&stored, version, date);
        let mut lines: Vec<String> = exported.lines().filter(|l| !added.iter().any(|a| l.starts_with(a.as_str()))).map(str::to_string).collect();
        let last = lines.len() - 2;
        lines[last] = lines[last].trim_end_matches(',').to_string();
        assert_eq!(lines.join("\n"), text.trim_end_matches('\n'));
        assert_imports_intact(&path);
    }

    /// The same check on every real 0.90.34 export the owner has put in `6_QNET20/handoff/`.
    #[test]
    fn every_settings_export_in_the_handoff_folder_imports_intact() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../handoff");
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_none_or(|x| x != "json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(&p) else { continue };
            let Ok(Value::Object(obj)) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if obj.contains_key(FORMAT_KEY) {
                assert_imports_intact(&p);
            }
        }
    }

    #[test]
    fn a_17_digit_double_from_an_older_foundation_imports_as_the_same_number() {
        let plan = plan_import(br#"{"ai.temperature": 0.69999999999999996, "mlmc.epsilon": 0.0050000000000000001}"#, &defaults()).unwrap();
        assert_eq!(plan.report.unchanged, vec!["ai.temperature"]);
        assert_eq!(plan.patch["mlmc.epsilon"].as_f64(), Some(0.005));
    }
}
