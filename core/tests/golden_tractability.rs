//! The routing-cycle and tractability lines of `--dump-rho` against 0.90.34's for every example
//! (golden/<example>/dump-rho.txt): "hasRoutingCycles = …", the two `AnalyticalTractability.assess`
//! lines and the means line between them, printed as 0.90.34's `QnetGUIApp.swift` prints them.

mod common;

use qnet_core::tractability::{self, Assessment};

/// Whether a golden line is one of the four kinds this test reproduces.
fn is_tractability_line(line: &str) -> bool {
    line.starts_with("hasRoutingCycles = ") || line.starts_with("AnalyticalTractability.assess(") || line.starts_with("  means(")
}

fn assess_line(label: &str, a: &Assessment) -> String {
    format!("AnalyticalTractability.assess({label} → kind={}, isTractable={}, detail='{}'", a.kind.case_name(), a.is_tractable(), a.detail)
}

fn our_lines(net: &qnet_core::model::Network) -> Vec<String> {
    let Ok(d) = qnet_core::traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false) else {
        return Vec::new();
    };
    let mut out = vec![format!("hasRoutingCycles = {}", tractability::has_routing_cycles(&d.aggregated_p))];
    let with = tractability::assess(&d, &net.nodes, net.infinite_buffers, true);
    out.push(assess_line("allowGCDG=true) ", &with));
    if !with.means.is_empty() {
        let m: Vec<String> = with.means.iter().enumerate().map(|(i, x)| format!("S{}={}", i + 1, qnet_core::cfmt::f("%.4f", *x))).collect();
        out.push(format!("  means({}): {}", with.means_label, m.join(" ")));
    }
    let without = tractability::assess(&d, &net.nodes, net.infinite_buffers, false);
    out.push(assess_line("allowGCDG=false)", &without));
    out
}

#[test]
fn the_tractability_lines_of_dump_rho_match_0_90_34_for_every_example() {
    let examples = common::examples();
    assert_eq!(examples.len(), 50);
    let mut differ = Vec::new();
    let mut assessed = 0;
    for (_, path) in examples {
        // The golden folder is the file name without its last ".bnet" only: "X.bnet.bnet" is
        // golden/X.bnet, not golden/X (common::examples trims every ".bnet").
        let file = path.file_name().unwrap().to_string_lossy();
        let name = file.strip_suffix(".bnet").unwrap().to_string();
        let ours = our_lines(&common::network(&path));
        let want: Vec<String> = common::golden(&name, "dump-rho.txt").unwrap().lines().filter(|l| is_tractability_line(l)).map(String::from).collect();
        if !want.is_empty() {
            assessed += 1;
        }
        if ours != want {
            let text = |v: &[String]| v.iter().map(|l| format!("{l}\n")).collect::<String>();
            differ.push((name, text(&ours), text(&want)));
        }
    }
    eprintln!("{assessed} examples have tractability lines");
    assert!(assessed > 0);
    common::assert_all_match("tractability lines", differ);
}
