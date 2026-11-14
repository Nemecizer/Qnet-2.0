//! Reading and writing `.bnet` documents for the interface, which owns the open copy (PLAN.md §3).
//!
//! The interface holds a document as the `.bnet` JSON object itself (src/lib/bnet.ts). Reading
//! goes through `qnet_core::bnet::read` (0.90.34's decoder rules) and hands back the file as
//! 0.90.34 would write it, so a document always arrives in one normal form; writing parses what
//! the interface sends with the same reader and writes it with `qnet_core::bnet::write`, so a
//! saved file is byte for byte what 0.90.34's `TabDocumentWriter` wrote (core/tests/golden_bnet.rs).

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::errors::{ErrorKind, QnError};
use crate::util;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    /// The absolute path read.
    pub path: String,
    /// The file name with its extension, which becomes the tab's title (ledger WS-032).
    pub name: String,
    /// The document in 0.90.34's written form; `JSON.parse` gives the interface's copy.
    pub text: String,
}

/// The file name a tab shows for `path`.
pub fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

pub fn read(path: &Path) -> Result<OpenedDocument, QnError> {
    let bytes = std::fs::read(path).map_err(|e| {
        let kind = if e.kind() == std::io::ErrorKind::NotFound { ErrorKind::NotFound } else { ErrorKind::Failed };
        QnError::new(kind, format!("Qnet couldn't read “{}”.", file_name(path))).with_detail(e.to_string())
    })?;
    let text = String::from_utf8(bytes)
        .map_err(|_| QnError::invalid(format!("“{}” isn't a Qnet network: it isn't text.", file_name(path))))?;
    let net = qnet_core::bnet::read(&text)
        .map_err(|e| QnError::invalid(format!("“{}” isn't a Qnet network.", file_name(path))).with_detail(e.to_string()))?;
    // The document's scenarios (new in 2.1, ledger WF-101) ride beside the network; none, and the text is as before.
    let scenarios = qnet_core::bnet::read_scenarios(&text)
        .map_err(|e| QnError::invalid(format!("“{}” isn't a Qnet network.", file_name(path))).with_detail(e.to_string()))?;
    Ok(OpenedDocument { path: path.display().to_string(), name: file_name(path), text: qnet_core::bnet::write_with_scenarios(&net, scenarios.as_ref()) })
}

/// The bytes 0.90.34 would write for `document`, or why it isn't a network.
pub fn encode(document: &Value) -> Result<String, QnError> {
    let text = serde_json::to_string(document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = qnet_core::bnet::read(&text)
        .map_err(|e| QnError::invalid("Qnet couldn't save this network: it isn't complete.").with_detail(e.to_string()))?;
    let scenarios = qnet_core::bnet::read_scenarios(&text)
        .map_err(|e| QnError::invalid("Qnet couldn't save this network: its scenarios aren't complete.").with_detail(e.to_string()))?;
    Ok(qnet_core::bnet::write_with_scenarios(&net, scenarios.as_ref()))
}

pub fn write(path: &Path, document: &Value) -> Result<OpenedDocument, QnError> {
    let text = encode(document)?;
    util::write_atomic(path, text.as_bytes())
        .map_err(|e| QnError::failed(format!("Qnet couldn't save “{}”.", file_name(path))).with_detail(e))?;
    Ok(OpenedDocument { path: path.display().to_string(), name: file_name(path), text })
}

#[tauri::command]
pub fn document_read(path: String) -> Result<OpenedDocument, QnError> {
    read(Path::new(&path))
}

/// Saves `document` to `path` atomically and returns it as written.
#[tauri::command]
pub fn document_write(path: String, document: Value) -> Result<OpenedDocument, QnError> {
    write(Path::new(&path), &document)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn examples() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples")
    }

    /// What the interface does with a read document: JSON.parse, then JSON.stringify on save.
    fn through_the_interface(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn every_example_reads_and_saves_back_byte_for_byte_through_the_interface_form() {
        let mut n = 0;
        for e in std::fs::read_dir(examples()).unwrap() {
            let path = e.unwrap().path();
            if path.extension().and_then(|x| x.to_str()) != Some("bnet") {
                continue;
            }
            // golden/<example>/resave.bnet is the example as 0.90.34's own writer saved it.
            let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
            let resaved = std::fs::read_to_string(examples().join("../golden").join(&stem).join("resave.bnet")).unwrap();
            let opened = read(&path).unwrap();
            assert_eq!(opened.name, file_name(&path));
            let saved = encode(&through_the_interface(&opened.text)).unwrap();
            assert_eq!(saved, opened.text, "{}", path.display());
            assert_eq!(saved, resaved, "{}", path.display());
            n += 1;
        }
        assert_eq!(n, 50);
    }

    /// New in 2.1 (ledger WF-101): scenarios survive open and save; without them nothing changes.
    #[test]
    fn scenarios_are_carried_through_open_and_save_and_only_when_there_are_some() {
        let dir = std::env::temp_dir().join(format!("qnet-docs-scenarios-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = read(&examples().join("5stationtandem.inf.bnet")).unwrap().text;
        let mut doc = through_the_interface(&plain);
        let node = doc["nodes"][0]["id"].as_str().unwrap().to_string();
        doc["scenarios"] = serde_json::json!({
            "active": "A", "baseline": [{"node": node, "field": "numberOfServers", "value": 1}],
            "items": [{"id": "A", "name": "Peak hour", "overrides": [{"node": node, "field": "numberOfServers", "value": 2}]}]
        });
        let p = dir.join("with.bnet");
        let saved = write(&p, &doc).unwrap().text;
        assert!(saved.contains("\"scenarios\" : {") && saved.contains("\"name\" : \"Peak hour\""), "{saved}");
        let opened = read(&p).unwrap().text;
        assert_eq!(opened, saved, "what is opened is what was saved");
        assert_eq!(encode(&through_the_interface(&opened)).unwrap(), saved, "and saves back byte for byte");
        // The last scenario deleted (the interface drops the key): the file is the plain one again.
        doc.as_object_mut().unwrap().remove("scenarios");
        assert_eq!(encode(&doc).unwrap(), plain);
        // A malformed block is refused, not dropped.
        doc["scenarios"] = serde_json::json!({"items": [{"id": "A", "overrides": []}]});
        assert!(encode(&doc).unwrap_err().detail.unwrap().contains("scenarios.items[0].name"));
    }

    #[test]
    fn a_file_that_isnt_a_network_is_refused_with_its_name() {
        let dir = std::env::temp_dir().join(format!("qnet-docs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.bnet");
        std::fs::write(&p, "{\"nodes\": []}").unwrap();
        let e = read(&p).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
        assert_eq!(e.message, "“broken.bnet” isn't a Qnet network.");
        assert!(e.detail.unwrap().contains("links"));
        assert_eq!(read(&dir.join("missing.bnet")).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn a_save_writes_atomically_and_returns_what_it_wrote() {
        let dir = std::env::temp_dir().join(format!("qnet-docs-save-{}", std::process::id()));
        let p = dir.join("t.bnet");
        let doc = serde_json::json!({"nodes": [], "links": [], "infiniteBuffers": true, "canvasScale": 1});
        let w = write(&p, &doc).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), w.text);
        assert_eq!(w.name, "t.bnet");
        assert!(encode(&serde_json::json!({"nodes": []})).is_err());
    }
}
