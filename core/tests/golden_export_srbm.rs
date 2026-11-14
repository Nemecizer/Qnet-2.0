//! The SRBM solver inputs against 0.90.34 for every example: the box files (fBNAsm, fBNAfm, fBNAlp;
//! `export::srbm_box`) and the orthant files (BNAsm, BNAmc, BNAlp and the two BAR documents;
//! `export::srbm_orthant`), each compared byte for byte with golden/<example>/, or its refusal with
//! the `.error.txt` sentence. Also File › Export › All Solver Inputs (`--export-cmp`), plain and with
//! Run Comparison's loss and BAS corrections, where an absent file means 0.90.34 refused it.
//!
//! The last test pins the reflection layouts: interleaved for fBNAsm and fBNAlp, grouped for fBNAfm.

mod common;

use qnet_core::export::srbm_box::{self, FiniteLpParams};
use qnet_core::export::srbm_orthant::{self, BnaLpParams};
use qnet_core::model::{Distribution, Link, Node, NodeKind};

/// Compares an exporter's text, or its refusal, with golden/<name>/<file> or <file>.error.txt.
fn check(differ: &mut Vec<(String, String, String)>, name: &str, file: &str, ours: Result<String, String>) {
    let (ours, want) = match ours {
        Ok(text) => (text, common::golden(name, file).unwrap_or_else(|| format!("<no {file}; 0.90.34 refused>"))),
        Err(sentence) => (
            format!("{sentence}\n"),
            common::golden(name, &format!("{file}.error.txt")).unwrap_or_else(|| format!("<0.90.34 wrote {file}>")),
        ),
    };
    if ours != want {
        differ.push((format!("{name}/{file}"), ours, want));
    }
}

/// For export-all folders: a file is written only when its exporter succeeded.
fn check_written(differ: &mut Vec<(String, String, String)>, name: &str, file: &str, ours: Result<String, String>) {
    let want = common::golden(name, file);
    match (ours, want) {
        (Ok(a), Some(b)) if a == b => {}
        (Err(_), None) => {}
        (ours, want) => differ.push((
            format!("{name}/{file}"),
            ours.unwrap_or_else(|e| format!("<refused: {e}>")),
            want.unwrap_or_else(|| "<absent>".into()),
        )),
    }
}

#[test]
fn the_box_files_match_0_90_34_for_every_example() {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let (n, l, inf) = (&net.nodes, &net.links, net.infinite_buffers);
        let msg = |e: qnet_core::traffic::SrbmError| e.message();
        check(&mut differ, &name, "fbnasm.in", srbm_box::export_for_spectral(n, l, inf, 8, false, false).map_err(msg));
        check(&mut differ, &name, "fbnafm.in", srbm_box::export_for_finite_element(n, l, inf, 10, false, false).map_err(msg));
        let lp = FiniteLpParams { output_prefix: Some("OUTPUT_PREFIX".into()), ..FiniteLpParams::default() };
        check(&mut differ, &name, "fbnalp.in", srbm_box::export_for_finite_lp(n, l, &lp, false, false).map_err(msg));
    }
    common::assert_all_match("box SRBM inputs", differ);
}

#[test]
fn the_orthant_files_match_0_90_34_for_every_example() {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let (n, l) = (&net.nodes, &net.links);
        let msg = |e: srbm_orthant::OrthantError| e.message();
        check(&mut differ, &name, "bnasm.in", srbm_orthant::export_for_spectral(n, l, 8).map_err(msg));
        let data = srbm_orthant::compute(n, l).map_err(msg);
        check(&mut differ, &name, "bnamc.in", data.clone().map(|d| srbm_orthant::format_bnamc_input(&d)));
        check(&mut differ, &name, "bnalp.in", data.map(|d| srbm_orthant::format_bnalp_input(&d, &BnaLpParams::default())));
        check(&mut differ, &name, "adaptive-bar.json", srbm_orthant::export_for_adaptive_bar(n, l, &name, 12).map_err(msg));
        check(&mut differ, &name, "bar-bounds.json", srbm_orthant::export_for_bar_bounds(n, l, &name, 2).map_err(msg));
    }
    common::assert_all_match("orthant SRBM inputs", differ);
}

#[test]
fn export_all_writes_the_same_srbm_files_as_0_90_34_with_and_without_corrections() {
    let mut differ = Vec::new();
    let mut corrected = 0;
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let (n, l, inf) = (&net.nodes, &net.links, net.infinite_buffers);
        for (folder, loss, bas) in [("export-all", false, false), ("export-all-loss", true, false), ("export-all-bas", false, true)] {
            if folder != "export-all" && !common::root().join("golden").join(&name).join(folder).is_dir() {
                continue;
            }
            if folder != "export-all" {
                corrected += 1;
            }
            let (loss, bas) = (loss && !inf, bas && !inf);
            let msg = |e: qnet_core::traffic::SrbmError| e.message();
            let at = |f: &str| format!("{folder}/{f}");
            check_written(&mut differ, &name, &at("sm.in"), srbm_box::export_for_spectral(n, l, inf, 8, loss, bas).map_err(msg));
            check_written(&mut differ, &name, &at("fm.in"), srbm_box::export_for_finite_element(n, l, inf, srbm_box::EXPORT_ALL_MESH_SIZE, loss, bas).map_err(msg));
            check_written(&mut differ, &name, &at("lp.in"), srbm_box::export_for_finite_lp(n, l, &FiniteLpParams::default(), loss, bas).map_err(msg));
            if folder == "export-all" {
                check_written(&mut differ, &name, &at("cmp_sm.in"), srbm_orthant::export_for_spectral(n, l, 8).map_err(|e| e.message()));
            }
        }
    }
    assert_eq!(corrected, 30, "the loss and BAS folders of the 15 finite-buffer examples");
    common::assert_all_match("export-all SRBM inputs", differ);
}

/// S1 → S2 → sink with finite buffers: the tandem's lower and upper faces reflect differently, so
/// a swapped layout changes the rows.
fn finite_tandem() -> (Vec<Node>, Vec<Link>) {
    let mut src = Node::new("src", NodeKind::Source, "Src1", (0.0, 0.0));
    src.distribution = Distribution::Poisson;
    src.parameters = "lambda=0.5".into();
    let mut nodes = vec![src];
    for i in 1..=2 {
        let mut b = Node::new(format!("b{i}"), NodeKind::Buffer, format!("B{i}"), (0.0, 0.0));
        b.buffer_size = 3;
        let mut s = Node::new(format!("s{i}"), NodeKind::Station, format!("S{i}"), (0.0, 0.0));
        s.parameters = "rate=1".into();
        nodes.push(b);
        nodes.push(s);
    }
    nodes.push(Node::new("out", NodeKind::Sink, "Sink1", (0.0, 0.0)));
    let l = |id: &str, from: &str, to: &str| Link { id: id.into(), from: from.into(), to: to.into(), probability: 1.0, class: 0, to_class: None };
    let links = vec![l("1", "src", "b1"), l("2", "b1", "s1"), l("3", "s1", "b2"), l("4", "b2", "s2"), l("5", "s2", "out")];
    (nodes, links)
}

#[test]
fn fbnasm_and_fbnalp_read_r_interleaved_and_fbnafm_reads_it_grouped() {
    let (n, l) = finite_tandem();
    // Interleaved [lower₀, upper₀, lower₁, upper₁]: S1's upper face pushes into S2's buffer.
    let interleaved = ["   1.00000   -1.00000    0.00000    1.00000", "   0.00000    0.00000    1.00000   -1.00000"];
    // Grouped [lower₀, lower₁, upper₀, upper₁].
    let grouped = ["   1.00000    0.00000   -1.00000    1.00000", "   0.00000    1.00000    0.00000   -1.00000"];
    assert_ne!(interleaved, grouped);

    // d, blank, θ, blank, two Γ rows, blank, then the two R rows.
    let sm = srbm_box::export_for_spectral(&n, &l, false, 8, false, false).unwrap();
    assert_eq!(sm.lines().skip(7).take(2).collect::<Vec<_>>(), interleaved, "fBNAsm");
    let plain = srbm_box::export(&n, &l, false, false, false).unwrap();
    assert_eq!(plain.lines().skip(7).take(2).collect::<Vec<_>>(), interleaved, "SRBM Solver Input");
    let fm = srbm_box::export_for_finite_element(&n, &l, false, 10, false, false).unwrap();
    assert_eq!(fm.lines().skip(7).take(2).collect::<Vec<_>>(), grouped, "fBNAfm");

    let lp = srbm_box::export_for_finite_lp(&n, &l, &FiniteLpParams::default(), false, false).unwrap();
    let after: Vec<&str> = lp.lines().skip_while(|x| *x != "reflection_form interleaved").collect();
    assert_eq!(after[1], "reflection");
    let lp_rows: Vec<String> = after[2..4].iter().map(|x| x.to_string()).collect();
    let want: Vec<String> = interleaved.iter().map(|r| format!("  {}", r.split_whitespace().map(|v| format!("{v:>10}")).collect::<Vec<_>>().join("  "))).collect();
    assert_eq!(lp_rows, want, "fBNAlp");
}
