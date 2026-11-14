//! The finite and truncated Markov documents against 0.90.34 for every example: the exact sparse
//! CTMC (generic-ctmc.json), the decomposition under each blocking (decomp-loss.json,
//! decomp-bas.json, decomp-bas-external-loss.json) and the truncated CTMC (truncated-ctmc.json),
//! or each one's refusal (`<file>.error.txt`, the sentence and a newline), made with the defaults
//! the app and golden/tools/GoldenDump.swift used.

mod common;

use qnet_core::export::finite_markov::{
    decomposition, generic_ctmc, truncated_infinite_ctmc, Blocking, DecompositionOptions, FiniteMarkovExportError,
    GenericCtmcOptions, TruncatedCtmcOptions,
};
use qnet_core::model::Network;

type Export = fn(&Network, &str) -> Result<String, FiniteMarkovExportError>;

fn compare(file: &str, export: Export) {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let (ours, want) = match export(&net, &name) {
            Ok(text) => (text, common::golden(&name, file)),
            Err(e) => (format!("{}\n", e.message()), common::golden(&name, &format!("{file}.error.txt"))),
        };
        let want = want.unwrap_or_else(|| panic!("{name}: 0.90.34 wrote the other outcome for {file}"));
        if ours != want {
            differ.push((name, ours, want));
        }
    }
    common::assert_all_match(file, differ);
}

#[test]
fn the_exact_sparse_ctmc_input_matches_0_90_34_for_every_example() {
    compare("generic-ctmc.json", |n, name| generic_ctmc(n, name, &GenericCtmcOptions::default()));
}

#[test]
fn the_loss_decomposition_input_matches_0_90_34_for_every_example() {
    compare("decomp-loss.json", |n, name| decomposition(n, name, Blocking::Loss, &DecompositionOptions::default()));
}

#[test]
fn the_bas_decomposition_input_matches_0_90_34_for_every_example() {
    compare("decomp-bas.json", |n, name| decomposition(n, name, Blocking::Bas, &DecompositionOptions::default()));
}

#[test]
fn the_bas_external_loss_decomposition_input_matches_0_90_34_for_every_example() {
    compare("decomp-bas-external-loss.json", |n, name| {
        decomposition(n, name, Blocking::BasExternalLoss, &DecompositionOptions::default())
    });
}

#[test]
fn the_truncated_ctmc_input_matches_0_90_34_for_every_example() {
    compare("truncated-ctmc.json", |n, name| truncated_infinite_ctmc(n, name, &TruncatedCtmcOptions::default()));
}
