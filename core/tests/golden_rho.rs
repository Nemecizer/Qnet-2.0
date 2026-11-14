//! `qnet dump-rho` against 0.90.34's `--dump-rho` for every example (golden/<example>/dump-rho.txt):
//! the station model, routing cycles, the SRBM verdict and both tractability assessments.

mod common;

#[test]
fn dump_rho_matches_0_90_34_for_every_example() {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let ours = qnet_core::dump::dump_rho(&common::network(&path));
        let want = common::golden(&name, "dump-rho.txt").unwrap();
        if ours != want {
            differ.push((name, ours, want));
        }
    }
    common::assert_all_match("dump-rho", differ);
}
