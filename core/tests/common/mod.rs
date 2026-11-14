//! What the golden tests share: the 50 shipped examples and 0.90.34's output for each.
#![allow(dead_code)]

use std::path::PathBuf;

pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// (name, path) of every example, sorted; the name is the file name without its last `.bnet`.
pub fn examples() -> Vec<(String, PathBuf)> {
    let mut v: Vec<(String, PathBuf)> = std::fs::read_dir(root().join("examples"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "bnet"))
        .map(|p| {
            let file = p.file_name().unwrap().to_string_lossy().to_string();
            // Only the last ".bnet": two examples are named "….bnet.bnet", as make-golden.sh's ${base%.bnet} keeps.
            (file.strip_suffix(".bnet").unwrap_or(&file).to_string(), p)
        })
        .collect();
    v.sort();
    v
}

pub fn network(path: &std::path::Path) -> qnet_core::model::Network {
    qnet_core::bnet::read(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// golden/<example>/<file>, or None when 0.90.34 wrote none.
pub fn golden(name: &str, file: &str) -> Option<String> {
    std::fs::read_to_string(root().join("golden").join(name).join(file)).ok()
}

/// Asserts no example differs, printing the first few differences line by line.
pub fn assert_all_match(what: &str, differ: Vec<(String, String, String)>) {
    for (name, ours, want) in differ.iter().take(3) {
        eprintln!("== {name}: first differing lines");
        for (a, b) in ours.lines().zip(want.lines()).filter(|(a, b)| a != b).take(4) {
            eprintln!("-- ours:    {a}\n-- 0.90.34: {b}");
        }
        if ours.lines().count() != want.lines().count() {
            eprintln!("-- line counts: ours {}, 0.90.34 {}", ours.lines().count(), want.lines().count());
        }
    }
    assert!(differ.is_empty(), "{what}: {} examples differ: {:?}", differ.len(), differ.iter().map(|d| &d.0).collect::<Vec<_>>());
}
