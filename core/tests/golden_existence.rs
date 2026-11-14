//! The SRBM existence verdict against 0.90.34 for every example: the "SRBM existence: " and
//! "SRBM recurrence: " lines of golden/<example>/dump-rho.txt, which 0.90.34's `--dump-rho` printed
//! from `srbmExistence(of:)` on the example's station model.

mod common;

/// The two lines as 0.90.34 printed them; none when the station model failed or had no verdict.
fn verdict_lines(net: &qnet_core::model::Network) -> String {
    let Ok(data) = qnet_core::traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false) else {
        return String::new();
    };
    let Some(v) = qnet_core::existence::srbm_existence(&data, net.infinite_buffers) else { return String::new() };
    let mut lines = format!("SRBM existence: {} — {}\n", v.existence.outcome.raw(), v.existence.statement);
    if let Some(r) = &v.recurrence {
        lines += &format!("SRBM recurrence: {} — {}\n", r.outcome.raw(), r.statement);
    }
    lines
}

#[test]
fn the_srbm_existence_verdict_matches_0_90_34_for_every_example() {
    let examples = common::examples();
    assert_eq!(examples.len(), 50);
    let mut differ = Vec::new();
    for (name, path) in examples {
        let ours = verdict_lines(&common::network(&path));
        let want: String = common::golden(&name, "dump-rho.txt")
            .unwrap()
            .lines()
            .filter(|l| l.starts_with("SRBM existence: ") || l.starts_with("SRBM recurrence: "))
            .map(|l| format!("{l}\n"))
            .collect();
        if ours != want {
            differ.push((name, ours, want));
        }
    }
    common::assert_all_match("SRBM existence", differ);
}
