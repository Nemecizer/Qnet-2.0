//! Scenarios through `qnet-cli` (ledger WF-503): every JSON document says which scenarios the file
//! has and whose values its numbers are; `--scenario` chooses; `resave` and `build` keep the
//! scenarios or refuse, and never drop them silently.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use qnet_core::json::{self, Json};
use qnet_core::{bnet, scenarios};

const WARNING: &str = "This file was saved showing the scenario “Peak hour”; these numbers are that scenario's.";

fn fixture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../core/tests/fixtures/scenarios").join(name).to_string_lossy().into_owned()
}

fn cli_with(args: &[&str], stdin: Option<&str>) -> (i32, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_qnet-cli")).args(args).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    if let Some(text) = stdin {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8(out.stdout).unwrap(), String::from_utf8(out.stderr).unwrap())
}

fn cli(args: &[&str]) -> (i32, String, String) {
    cli_with(args, None)
}

fn document(args: &[&str]) -> Json {
    let (code, out, err) = cli(args);
    assert_eq!(code, 0, "{args:?}: {err}");
    json::parse(&out).unwrap_or_else(|e| panic!("{args:?} did not print JSON ({e}): {out}"))
}

fn key<'a>(v: &'a Json, k: &str) -> Option<&'a Json> {
    v.as_object().and_then(|m| m.get(k))
}

fn texts(v: Option<&Json>) -> Vec<String> {
    v.and_then(Json::as_array).unwrap_or(&[]).iter().filter_map(|x| x.as_str().map(str::to_string)).collect()
}

fn scratch(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("qnet-cli-scenarios-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name).to_string_lossy().into_owned()
}

#[test]
fn every_document_names_the_scenarios_and_warns_when_the_numbers_are_a_scenarios() {
    let file = fixture("feedback.bnet");
    for command in ["describe", "methods", "live", "sensitivity", "transient"] {
        let args: Vec<&str> = if command == "methods" { vec![command, &file, "--assume-installed"] } else { vec![command, &file] };
        let doc = document(&args);
        let s = key(&doc, "scenario").unwrap_or_else(|| panic!("{command}: no scenario key"));
        assert_eq!(key(s, "active").and_then(Json::as_str), Some("Peak hour"), "{command}");
        assert_eq!(key(s, "shown").and_then(Json::as_str), Some("Peak hour"), "{command}");
        assert_eq!(texts(key(s, "names")), ["Peak hour", "Add a server at S2"], "{command}");
        assert_eq!(texts(key(&doc, "warnings")).first().map(String::as_str), Some(WARNING), "{command}");

        // Chosen: no warning about it, and the numbers are the chosen variant's.
        let mut chosen = args.clone();
        chosen.extend(["--scenario", "baseline"]);
        let doc = document(&chosen);
        let s = key(&doc, "scenario").unwrap();
        assert_eq!(key(s, "active").and_then(Json::as_str), Some("Peak hour"), "{command}");
        assert_eq!(key(s, "shown"), Some(&Json::Null), "{command}");
        assert!(!texts(key(&doc, "warnings")).iter().any(|w| w == WARNING), "{command}");
    }
    // A file without scenarios has no such key, and its documents are as they were.
    let plain = fixture("../../../../golden/OpenJackson.d2.feedback.p30.inf/resave.bnet");
    let doc = document(&["live", &plain]);
    assert_eq!(key(&doc, "scenario"), None);
    assert_eq!(key(&doc, "warnings"), None);
    assert_eq!(document(&["live", &plain, "--scenario", "baseline"]), doc);
    let (code, _, err) = cli(&["live", &plain, "--scenario", "Peak hour"]);
    assert_eq!(code, 1);
    assert!(err.contains("has no scenarios"), "{err}");
}

#[test]
fn scenario_chooses_the_network_every_command_reads() {
    let file = fixture("feedback.bnet");
    let plain = fixture("../../../../golden/OpenJackson.d2.feedback.p30.inf/resave.bnet");
    // The baseline is the example the scenarios were made on: the same fingerprint, the same numbers.
    let base = document(&["live", &file, "--scenario", "baseline"]);
    let golden = document(&["live", &plain]);
    assert_eq!(key(&base, "fingerprint"), key(&golden, "fingerprint"));
    assert_eq!(key(&base, "stations"), key(&golden, "stations"));
    let shown = document(&["live", &file]);
    assert_eq!(document(&["live", &file, "--scenario=Peak hour"]).as_object().unwrap().get("fingerprint"), key(&shown, "fingerprint"));
    assert_ne!(key(&shown, "fingerprint"), key(&base, "fingerprint"));
    // The text commands too, with the note on stderr only when nothing was chosen.
    let (_, rho, err) = cli(&["dump-rho", &file]);
    assert_eq!(err.trim(), format!("qnet-cli: {WARNING}"));
    let (_, rho_base, err) = cli(&["dump-rho", &file, "--scenario", "baseline"]);
    assert_eq!(err, "");
    assert_eq!(rho_base, cli(&["dump-rho", &plain]).1);
    assert_ne!(rho, rho_base);
    let (code, _, err) = cli(&["describe", &file, "--scenario", "Night"]);
    assert_eq!(code, 1);
    assert!(err.starts_with("There is no scenario called “Night” in this file."), "{err}");
    assert_eq!(cli(&["describe", &file, "--scenario"]).0, 2);
}

#[test]
fn resave_keeps_the_scenarios_and_can_save_showing_another() {
    let file = fixture("feedback.bnet");
    let text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(cli(&["resave", &file]).1, text, "scenarios and all, byte for byte");
    for (which, expected) in [("baseline", "shown-baseline.bnet"), ("Add a server at S2", "shown-add-a-server-at-s2.bnet"), ("Peak hour", "shown-peak-hour.bnet")] {
        assert_eq!(cli(&["resave", &file, "--scenario", which]).1, std::fs::read_to_string(fixture(expected)).unwrap(), "{which}");
    }
    let out = scratch("resaved.bnet");
    assert_eq!(cli(&["resave", &file, &out]).0, 0);
    assert_eq!(std::fs::read_to_string(&out).unwrap(), text);
}

#[test]
fn build_keeps_the_scenarios_of_the_file_it_is_based_on_or_refuses() {
    let file = fixture("feedback.bnet");
    let text = std::fs::read_to_string(&file).unwrap();
    let spec_of = |args: &[&str]| -> std::collections::BTreeMap<String, Json> {
        let mut spec = key(&document(args), "spec").unwrap().as_object().unwrap().clone();
        spec.insert("basedOn".into(), Json::str(file.clone()));
        spec
    };
    let build = |spec: &std::collections::BTreeMap<String, Json>, out: &str| cli_with(&["build", "-", out], Some(&json::to_pretty(&Json::Object(spec.clone()))));

    // Unchanged: the file again.
    let spec = spec_of(&["describe", &file]);
    let out = scratch("same.bnet");
    let (code, _, err) = build(&spec, &out);
    assert_eq!(code, 0, "{err}");
    assert_eq!(std::fs::read_to_string(&out).unwrap(), text);

    // Read as the baseline and saved: the file showing the baseline.
    let mut spec = spec_of(&["describe", &file, "--scenario", "baseline"]);
    spec.insert("basedOnScenario".into(), Json::str("baseline"));
    let out = scratch("baseline.bnet");
    assert_eq!(build(&spec, &out).0, 0);
    assert_eq!(std::fs::read_to_string(&out).unwrap(), std::fs::read_to_string(fixture("shown-baseline.bnet")).unwrap());

    // A value changed while "Peak hour" is shown is that scenario's; the baseline is as it was.
    let mut spec = spec_of(&["describe", &file]);
    if let Some(Json::Array(nodes)) = spec.get_mut("nodes") {
        for n in nodes.iter_mut() {
            if let Json::Object(m) = n {
                if m.get("name").and_then(Json::as_str) == Some("S1") {
                    m.insert("servers".into(), Json::int(2));
                }
            }
        }
    }
    let out = scratch("changed.bnet");
    assert_eq!(build(&spec, &out).0, 0);
    let saved = std::fs::read_to_string(&out).unwrap();
    let (net, block) = (bnet::read(&saved).unwrap(), bnet::read_scenarios(&saved).unwrap().unwrap());
    assert_eq!(net.nodes.iter().find(|n| n.name == "S1").unwrap().servers, 2);
    assert_eq!(scenarios::active_name(&block).as_deref(), Some("Peak hour"));
    let original = (bnet::read(&text).unwrap(), bnet::read_scenarios(&text).unwrap().unwrap());
    for which in ["baseline", "Add a server at S2"] {
        assert_eq!(scenarios::network_for(&net, &block, which).unwrap(), scenarios::network_for(&original.0, &original.1, which).unwrap(), "{which}");
    }

    // A node taken away: refused, in words, and nothing is written; "drop" writes the network alone.
    let mut spec = spec_of(&["describe", &file]);
    if let Some(Json::Array(nodes)) = spec.get_mut("nodes") {
        nodes.push(json::parse(r#"{"kind": "sink", "name": "Out2"}"#).unwrap());
    }
    let out = scratch("refused.bnet");
    let (code, _, err) = build(&spec, &out);
    assert_eq!(code, 1);
    assert!(err.contains("holds scenarios") && err.contains("\"scenarios\": \"drop\""), "{err}");
    assert!(!std::path::Path::new(&out).exists());
    spec.insert("scenarios".into(), Json::str("drop"));
    assert_eq!(build(&spec, &out).0, 0);
    let dropped = std::fs::read_to_string(&out).unwrap();
    assert_eq!(bnet::read_scenarios(&dropped).unwrap(), None);
    assert_eq!(bnet::read(&dropped).unwrap().nodes.len(), 7);
}
