//! `qnet-cli --version` says the app's version (ledger CLI-001, INV-041: the one in
//! src-tauri/tauri.conf.json, which `node scripts/verify-version.mjs` holds every other place to),
//! and the tool has no `dump-help`: Help is typeset by the interface (CLI-008, HELP-019).

use std::path::PathBuf;
use std::process::Command;

fn cli(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_qnet-cli")).args(args).output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8(out.stdout).unwrap(), String::from_utf8(out.stderr).unwrap())
}

/// The top-level `"version": "…"` of tauri.conf.json.
fn app_version() -> String {
    let conf = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src-tauri/tauri.conf.json")).unwrap();
    let at = conf.find("\"version\"").expect("tauri.conf.json has a version");
    let rest = &conf[at + "\"version\"".len()..];
    let open = rest.find('"').unwrap();
    let close = rest[open + 1..].find('"').unwrap();
    rest[open + 1..open + 1 + close].to_string()
}

#[test]
fn version_is_the_apps() {
    let version = app_version();
    assert_eq!(version.split('.').count(), 3, "{version}");
    assert_eq!(version, env!("CARGO_PKG_VERSION"), "cli/Cargo.toml and tauri.conf.json give one version");
    assert_eq!(cli(&["--version"]), (0, format!("Qnet {version}\n"), String::new()));
}

#[test]
fn there_is_no_dump_help() {
    for args in [&["dump-help", "sbd"][..], &["--dump-help", "sbd"], &["dump-help"]] {
        let (code, out, err) = cli(args);
        assert_eq!((code, out.as_str()), (2, ""), "{args:?}");
        assert!(err.starts_with("Usage:\n  qnet-cli dump-rho"), "{args:?}: {err}");
        assert!(!err.contains("dump-help"), "{args:?}");
    }
}
