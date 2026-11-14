//! `build::to_spec` then `build::from_spec` gives every example back as `bnet::write` saves it
//! (new in 2.1: what `qnet-cli describe` prints, `qnet-cli build` reads).

use qnet_core::{bnet, build};
use std::path::{Path, PathBuf};

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            files(&p, out);
        } else if p.extension().is_some_and(|x| x == "bnet") {
            out.push(p);
        }
    }
}

#[test]
fn every_example_is_described_and_built_again_as_the_same_file() {
    let mut all = Vec::new();
    files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples"), &mut all);
    assert!(all.len() >= 50, "{} examples", all.len());
    for path in all {
        let net = bnet::read(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let spec = build::to_spec(&net);
        // Through its text, as the command line passes it.
        let text = qnet_core::json::to_pretty(&spec);
        let again = build::from_spec(&qnet_core::json::parse(&text).unwrap(), None).unwrap();
        assert_eq!(bnet::write(&again), bnet::write(&net), "{}", path.display());
        // With the file as the base, too: nothing the description lacks is lost.
        assert_eq!(build::from_spec(&spec, Some(&net)).unwrap(), bnet::read(&bnet::write(&net)).unwrap(), "{}", path.display());
    }
}
