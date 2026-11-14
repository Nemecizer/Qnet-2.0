//! Every shipped example opens, and saves back exactly as Qnet 0.90.34 saved it
//! (golden/<example>/resave.bnet, written by 0.90.34's own TabDocumentWriter).

mod common;

use common::{examples, root};

#[test]
fn all_fifty_examples_open() {
    let ex = examples();
    assert_eq!(ex.len(), 50);
    for (name, path) in ex {
        qnet_core::bnet::read(&std::fs::read_to_string(&path).unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

#[test]
fn every_example_saves_back_byte_for_byte_as_0_90_34_saved_it() {
    let mut differ = Vec::new();
    for (name, path) in examples() {
        let net = qnet_core::bnet::read(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let want = std::fs::read_to_string(root().join("golden").join(&name).join("resave.bnet")).unwrap();
        if qnet_core::bnet::write(&net) != want {
            differ.push(name);
        }
    }
    assert!(differ.is_empty(), "differs from 0.90.34's save: {differ:?}");
}

#[test]
fn a_file_0_90_34_wrote_reads_and_writes_back_unchanged() {
    for (name, _) in examples() {
        let saved = std::fs::read_to_string(root().join("golden").join(&name).join("resave.bnet")).unwrap();
        let net = qnet_core::bnet::read(&saved).unwrap();
        assert_eq!(qnet_core::bnet::write(&net), saved, "{name}");
    }
}
