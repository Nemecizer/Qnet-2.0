//! File › Export › All Solver Inputs against 0.90.34's `--export-cmp` for every example
//! (golden/<example>/export-all, and export-all-loss and export-all-bas for finite buffers).
//! `sim.txt`'s `# Generated:` line is the time of writing and is left out of the comparison.

mod common;

use qnet_core::export::all::{export_all, status_lines, BlockingConvention};

fn without_generated(s: &str) -> String {
    s.lines().filter(|l| !l.starts_with("# Generated:")).map(|l| format!("{l}\n")).collect()
}

fn check(folder: &str, convention: BlockingConvention, finite_only: bool) -> usize {
    let mut differ = Vec::new();
    let mut seen = 0;
    for (name, path) in common::examples() {
        let net = common::network(&path);
        if finite_only && net.infinite_buffers {
            continue;
        }
        seen += 1;
        for o in export_all(&net, convention, "TIME") {
            let want = common::golden(&name, &format!("{folder}/{}", o.file));
            match (&o.result, want) {
                (Ok(text), Some(w)) => {
                    if without_generated(text) != without_generated(&w) {
                        differ.push((format!("{name}/{folder}/{}", o.file), text.clone(), w));
                    }
                }
                (Err(_), None) => {}
                (Ok(_), None) => differ.push((format!("{name}/{folder}/{}", o.file), "written".into(), "0.90.34 refused it".into())),
                (Err(e), Some(_)) => differ.push((format!("{name}/{folder}/{}", o.file), e.clone(), "0.90.34 wrote it".into())),
            }
        }
    }
    common::assert_all_match(folder, differ);
    seen
}

#[test]
fn export_all_matches_0_90_34_for_every_example() {
    assert_eq!(check("export-all", BlockingConvention::Manufacturing, false), 50);
}

#[test]
fn the_loss_and_bas_corrections_match_0_90_34_for_every_finite_example() {
    assert_eq!(check("export-all-loss", BlockingConvention::LossCorrection, true), 15);
    assert_eq!(check("export-all-bas", BlockingConvention::BasCorrection, true), 15);
}

#[test]
fn the_status_names_what_was_written_and_lists_what_was_not() {
    let net = common::network(&common::root().join("examples/2dtandem.bnet"));
    let out = export_all(&net, BlockingConvention::LossCorrection, "TIME");
    let (ok, warn) = status_lines(&out, "/tmp/x", &net, BlockingConvention::LossCorrection);
    assert!(ok.starts_with("Exported ") && ok.ends_with(" Blocking convention: Loss-network correction."), "{ok}");
    let refused = out.iter().filter(|o| o.result.is_err()).count();
    assert_eq!(warn.is_some(), refused > 0);
}
