//! The Welcome view's example gallery (new in 2.1, ledger UX-106): every bundled example, read
//! once, so the interface can draw a thumbnail and say what each network is.
//!
//! The folder is the one File ▸ Open Example… starts in (`files::locate`); each `.bnet` in it is
//! read as `document_read` reads it (0.90.34's reader, handed back in its written form). A file
//! that isn't a network is left out rather than failing the list.

use std::path::{Path, PathBuf};

use crate::documents::{self, OpenedDocument};
use crate::files::{self, ExamplesWorld};

/// The `.bnet` files directly inside `folder`, by file name (byte order, so the list is stable).
pub fn bnet_files(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else { return vec![] };
    let mut out: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("bnet")))
        .collect();
    out.sort_by_key(|p| documents::file_name(p));
    out
}

/// The closed-network examples (new in 2.1) live one folder down, so the 50 examples 0.90.34
/// shipped, which the golden tests enumerate, stay a set of their own.
pub const CLOSED_FOLDER: &str = "closed";
/// The examples of the model features new in 2.1 (priorities, batch arrivals, a rate profile),
/// in a folder of their own for the same reason.
pub const EXTENDED_FOLDER: &str = "extended";

/// A bundled example: the document, and whether it is an open or a closed network by core's one
/// rule (`closed::drawn_as`: "open", "closed", "closedNoPopulation"), so that the gallery
/// describes a closed network as one and not by the shape of its routing alone.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    #[serde(flatten)]
    pub document: OpenedDocument,
    pub drawn: &'static str,
}

pub fn list(folder: &Path) -> Vec<Example> {
    let mut files = bnet_files(folder);
    files.extend(bnet_files(&folder.join(EXTENDED_FOLDER)));
    files.extend(bnet_files(&folder.join(CLOSED_FOLDER)));
    files
        .iter()
        .filter_map(|p| documents::read(p).ok())
        .filter_map(|document| {
            let net = qnet_core::bnet::read(&document.text).ok()?;
            Some(Example { drawn: qnet_core::closed::drawn_as(&net).reason().unwrap_or("open"), document })
        })
        .collect()
}

/// Every bundled example as an opened document; empty when the examples folder isn't found.
#[tauri::command]
pub fn examples_list() -> Vec<Example> {
    match files::locate(&ExamplesWorld::from_process()).path {
        Some(folder) => list(Path::new(&folder)),
        None => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_repository_examples_all_list_in_name_order() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples");
        let got = list(&folder);
        let closed = bnet_files(&folder.join(CLOSED_FOLDER)).len();
        assert!(closed >= 1, "the closed examples follow the others");
        // The examples of the features new in 2.1 (open networks) come between the two.
        let extended = bnet_files(&folder.join(EXTENDED_FOLDER)).len();
        assert_eq!(extended, 3, "one example for each of priorities, batch arrivals and rate profiles");
        assert_eq!(got.len(), bnet_files(&folder).len() + extended + closed);
        assert!(got.len() >= 40, "{} examples", got.len());
        assert!(got.last().unwrap().document.text.contains("\"closedPopulation\""));
        // The closed examples say so, the 0.90.34 examples are all open; in the interface's shape.
        assert!(got[got.len() - closed..].iter().all(|e| e.drawn == "closed") && got[..got.len() - closed].iter().all(|e| e.drawn == "open"));
        let json = serde_json::to_value(got.last().unwrap()).unwrap();
        assert_eq!((json["drawn"].as_str(), json["name"].as_str()), (Some("closed"), Some("ClosedCentralServer.d3.N8.bnet")));
        assert!(json["path"].is_string() && json["text"].is_string());
        let got: Vec<&OpenedDocument> = got[..got.len() - closed - extended].iter().map(|e| &e.document).collect();
        let names: Vec<&str> = got.iter().map(|d| d.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        assert!(got.iter().all(|d| d.name.ends_with(".bnet") && d.text.contains("\"nodes\"")));
    }

    #[test]
    fn a_file_that_is_not_a_network_is_left_out_and_a_missing_folder_is_empty() {
        let dir = std::env::temp_dir().join(format!("qnet-welcome-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bad.bnet"), "not json").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        assert!(list(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(list(&dir.join("gone")).is_empty());
    }
}
