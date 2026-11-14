//! The flag bar's state against 0.90.34's `applyTractability` for every example
//! (golden/<example>/flags.txt).

mod common;

use qnet_core::{cfmt::f, flags, traffic};

#[test]
fn the_flag_bar_state_matches_0_90_34_for_every_example() {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let Ok(d) = traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false) else {
            assert!(common::golden(&name, "flags.txt").is_none(), "{name}: 0.90.34 had a station model");
            continue;
        };
        let fl = flags::assess(&d, &net.nodes, net.infinite_buffers);
        let mut s = String::new();
        s += &format!("isAnalyticallyTractable={}\n", fl.is_analytically_tractable);
        s += &format!("tractabilityIsExact={}\n", fl.tractability_is_exact);
        s += &format!("tractabilityTitle={}\n", fl.tractability_title);
        s += &format!("tractabilityDetail={}\n", fl.tractability_detail);
        s += &format!("tractabilityMeansLabel={}\n", fl.tractability_means_label);
        s += &format!("tractabilityMeans={}\n", fl.tractability_means.iter().map(|m| f("%.17g", *m)).collect::<Vec<_>>().join(" "));
        s += &format!("hasFeedback={}\n", fl.has_feedback);
        s += &format!("feedbackQuality={}\n", fl.feedback_quality.case_name());
        for c in &fl.feedback_criteria {
            s += &format!("criterion={} | ok={} | {}\n", c.label, c.ok, c.detail);
        }
        s += &format!("feedbackDescription:\n{}\n", fl.feedback_description);
        s += &format!("tractabilityExplanation:\n{}\n", fl.tractability_explanation);
        s += "status:\n";
        for line in &fl.status {
            s += &format!("{line}\n");
        }
        let want = common::golden(&name, "flags.txt").unwrap_or_else(|| panic!("{name}: no golden flags.txt"));
        if s != want {
            differ.push((name, s, want));
        }
    }
    common::assert_all_match("flags", differ);
}
