//! One file with scenarios, read as each of its variants (ledger WF-503). The interface's rules
//! (`src/scenarios/model.ts`) and core's (`qnet_core::scenarios`) are held to the same expected
//! files: `src/scenarios/fixture.test.ts` reads this folder too, so the two cannot drift apart.
//!
//! `feedback.bnet` is the bundled OpenJackson.d2.feedback.p30.inf with two scenarios, saved
//! showing "Peak hour". `shown-<variant>.bnet` is that file saved showing each variant.

use qnet_core::{bnet, scenarios};

const FILE: &str = include_str!("fixtures/scenarios/feedback.bnet");
const GOLDEN: &str = include_str!("../../golden/OpenJackson.d2.feedback.p30.inf/resave.bnet");
const SHOWN: [(&str, &str); 3] = [
    ("baseline", include_str!("fixtures/scenarios/shown-baseline.bnet")),
    ("Peak hour", include_str!("fixtures/scenarios/shown-peak-hour.bnet")),
    ("Add a server at S2", include_str!("fixtures/scenarios/shown-add-a-server-at-s2.bnet")),
];

#[test]
fn every_variant_is_the_network_the_expected_file_holds() {
    let net = bnet::read(FILE).unwrap();
    let block = bnet::read_scenarios(FILE).unwrap().unwrap();
    assert_eq!(scenarios::names(&block), ["Peak hour", "Add a server at S2"]);
    assert_eq!(scenarios::active_name(&block).as_deref(), Some("Peak hour"));
    for (name, expected) in SHOWN {
        let wanted = bnet::read(expected).unwrap();
        assert_eq!(scenarios::network_for(&net, &block, name).unwrap(), wanted, "{name}");
        let (shown, saved) = scenarios::switch(&net, &block, name).unwrap();
        assert_eq!(bnet::write_with_scenarios(&shown, Some(&saved)), expected, "{name}: saved showing it");
        // From any variant to any other: the same file.
        for (other, text) in SHOWN {
            let (n, b) = scenarios::switch(&shown, &saved, other).unwrap();
            let again = bnet::write_with_scenarios(&n, Some(&b));
            if name != "Add a server at S2" || other == name {
                assert_eq!(again, text, "{name} → {other}");
            } else {
                // Showing it drops its override of a node the file does not have; the network is the same.
                assert_eq!(n, bnet::read(text).unwrap(), "{name} → {other}");
            }
        }
    }
}

#[test]
fn the_baseline_is_the_example_the_scenarios_were_made_on_byte_for_byte() {
    let net = bnet::read(FILE).unwrap();
    let block = bnet::read_scenarios(FILE).unwrap().unwrap();
    assert_eq!(bnet::write(&scenarios::network_for(&net, &block, "baseline").unwrap()), GOLDEN);
    assert_eq!(bnet::write(&scenarios::network_for(&net, &block, "BASELINE").unwrap()), GOLDEN);
}

#[test]
fn a_scenario_is_found_by_name_or_id_and_a_wrong_name_lists_the_right_ones() {
    let net = bnet::read(FILE).unwrap();
    let block = bnet::read_scenarios(FILE).unwrap().unwrap();
    let by_name = scenarios::network_for(&net, &block, "Add a server at S2").unwrap();
    assert_eq!(scenarios::network_for(&net, &block, "b2222222-2222-4222-8222-222222222222").unwrap(), by_name);
    assert_eq!(scenarios::network_for(&net, &block, "peak HOUR").unwrap(), net);
    let s2 = by_name.nodes.iter().find(|n| n.name == "S2").unwrap();
    assert_eq!((s2.servers, s2.service_by_class.len()), (3, 1));
    assert_eq!(by_name.nodes.iter().find(|n| n.name == "B1").unwrap().buffer_size, 10);
    assert_eq!(
        scenarios::network_for(&net, &block, "Night").unwrap_err(),
        "There is no scenario called “Night” in this file. Its scenarios are “Peak hour”, “Add a server at S2”; “baseline” is the network's own values."
    );
}

#[test]
fn a_changed_value_is_the_shown_scenarios_and_a_changed_network_keeps_none() {
    let net = bnet::read(FILE).unwrap();
    let block = bnet::read_scenarios(FILE).unwrap().unwrap();
    // Nothing changed: the block as it was.
    assert_eq!(scenarios::reconcile(&net, &net, &block), Some(block.clone()));
    // S1 gets two servers while "Peak hour" is shown: its override, with the baseline's 1 kept.
    let mut next = net.clone();
    next.nodes.iter_mut().find(|n| n.name == "S1").unwrap().servers = 2;
    let after = scenarios::reconcile(&net, &next, &block).unwrap();
    assert_eq!(scenarios::network_for(&next, &after, "baseline").unwrap(), bnet::read(GOLDEN).unwrap(), "the baseline is untouched");
    let other = scenarios::network_for(&next, &after, "Add a server at S2").unwrap();
    assert_eq!(other, scenarios::network_for(&net, &block, "Add a server at S2").unwrap(), "so is the other scenario");
    assert_eq!(scenarios::network_for(&next, &after, "Peak hour").unwrap(), next);
    // Back at the baseline's value: the override ends, and the block is as it was.
    let (back, _) = (net.clone(), ());
    assert_eq!(scenarios::reconcile(&next, &back, &after), Some(block.clone()));
    // S2 back to the baseline's one server: that override of "Peak hour" ends.
    let mut one = net.clone();
    one.nodes.iter_mut().find(|n| n.name == "S2").unwrap().servers = 1;
    let ended = bnet::write_with_scenarios(&one, scenarios::reconcile(&net, &one, &block).as_ref());
    assert_eq!(ended.matches("\"field\" : \"numberOfServers\"").count(), 2, "only the other scenario's two remain: {ended}");
    // With the baseline shown a change is the baseline's own: nothing to record.
    let (base, shown_base) = scenarios::switch(&net, &block, "baseline").unwrap();
    let mut edited = base.clone();
    edited.nodes.iter_mut().find(|n| n.name == "S1").unwrap().servers = 4;
    assert_eq!(scenarios::reconcile(&base, &edited, &shown_base), Some(shown_base.clone()));
    // A node removed, or the buffer regime changed: the network itself changed.
    let mut fewer = net.clone();
    fewer.nodes.pop();
    assert_eq!(scenarios::reconcile(&net, &fewer, &block), None);
    let mut finite = net.clone();
    finite.infinite_buffers = false;
    assert_eq!(scenarios::reconcile(&net, &finite, &block), None);
}
