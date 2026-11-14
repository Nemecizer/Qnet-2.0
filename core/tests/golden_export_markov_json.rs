//! The three Markovian JSON documents against 0.90.34 for every example: the regenerative Monte
//! Carlo input, the exact open product-form input and the QBD input (golden/<example>/
//! regenerative.json, product-form.json and qbd.json, or their .error.txt), each made as
//! golden/tools/GoldenDump.swift made it: the example's file name as the document name and every
//! other parameter at its default.

mod common;

use qnet_core::export::{product_form, qbd, regenerative};

/// Compares one exporter's output or refusal with 0.90.34's for every example.
fn compare(file: &str, export: impl Fn(&qnet_core::model::Network, &str) -> Result<String, String>) {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let (ours, want) = match export(&net, &name) {
            Ok(text) => (text, common::golden(&name, file)),
            Err(message) => (message + "\n", common::golden(&name, &format!("{file}.error.txt"))),
        };
        let want = want.unwrap_or_else(|| panic!("{name}: 0.90.34 wrote the other outcome for {file}"));
        if ours != want {
            differ.push((name, ours, want));
        }
    }
    common::assert_all_match(file, differ);
}

#[test]
fn the_regenerative_input_matches_0_90_34_for_every_example() {
    compare("regenerative.json", |net, name| regenerative::export(net, name, &regenerative::Options::default()).map_err(|e| e.message()));
}

#[test]
fn the_product_form_input_matches_0_90_34_for_every_example() {
    compare("product-form.json", |net, name| {
        product_form::export(net, name, product_form::DEFAULT_MAXIMUM_SERVERS).map_err(|e| e.message())
    });
}

#[test]
fn the_qbd_input_matches_0_90_34_for_every_example() {
    compare("qbd.json", |net, name| qbd::export(net, name, &qbd::QbdOptions::default()).map_err(|e| e.message()));
}
