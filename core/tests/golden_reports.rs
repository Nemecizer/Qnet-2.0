//! Network › Analyze Network and Network › Show Network Primitives against 0.90.34 for every
//! example (golden/<example>/analysis.txt and primitives.txt, or their .error.txt).

mod common;

use qnet_core::{report, traffic};

/// Everything is 0.90.34's except the M/D/1 sentence's restored ending (ANA-154).
#[test]
fn analyze_network_matches_0_90_34_for_every_example_but_the_restored_sentence() {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let (ours, want) = match traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false) {
            // ANA-154 is a Changed row: the M/D/1 sentence now ends "~10%.", where 0.90.34 lost the "%.".
            Ok(d) => (report::analysis(&d, &net.nodes, &net.links, net.infinite_buffers).replace(report::MD1_TAIL, report::MD1_TAIL_0_90_34), common::golden(&name, "analysis.txt")),
            Err(e) => (format!("Analyze network aborted: {}\n", e.message()), common::golden(&name, "analysis.txt.error.txt")),
        };
        let want = want.unwrap_or_else(|| panic!("{name}: 0.90.34 wrote the other outcome"));
        if ours != want {
            differ.push((name, ours, want));
        }
    }
    common::assert_all_match("analysis", differ);
}

#[test]
fn the_md1_sentence_ends_with_its_percent_sign() {
    let net = common::network(&common::root().join("examples/2dtandem.bnet"));
    let d = traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).unwrap();
    let text = report::analysis(&d, &net.nodes, &net.links, net.infinite_buffers);
    assert!(text.contains("Otherwise SRBM is usually within ~10%.\n"), "{text}");
}

/// The μ_i legend is a Changed row (ANA-180): it now names the harmonic mean the code computes.
/// Everything else is 0.90.34's, so the comparison puts the old line back first.
#[test]
fn network_primitives_match_0_90_34_for_every_example_but_the_corrected_legend() {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let (ours, want) = match traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false) {
            Ok(d) => {
                let w = report::primitives_warnings(&d, &net.nodes, &net.links, net.infinite_buffers);
                let text = report::primitives(&d, &w, net.infinite_buffers);
                assert!(text.contains(report::MU_LEGEND), "{name}: the corrected legend is there");
                (text.replace(report::MU_LEGEND, report::MU_LEGEND_0_90_34), common::golden(&name, "primitives.txt"))
            }
            Err(e) => (format!("Network primitives aborted: {}\n", e.message()), common::golden(&name, "primitives.txt.error.txt")),
        };
        let want = want.unwrap_or_else(|| panic!("{name}: 0.90.34 wrote the other outcome"));
        if ours != want {
            differ.push((name, ours, want));
        }
    }
    common::assert_all_match("primitives", differ);
}
