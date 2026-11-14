//! The network text exporters against Qnet 0.90.34, for all 50 examples: the `.qna` file
//! (BNAqna, BNArqna, BNAsbd), the jackson_sim `.sim` file and the fBNAsim input, each compared
//! with the golden file or its refusal sentence, and again with File › Export › All Solver Inputs
//! (`export-all/`, where a missing file means the exporter refused). The fBNAsim `# Generated:`
//! line holds the time 0.90.34 ran and is the one line not compared.
//!
//! Also the headless harness `2_QNET/validation/rqna_exporter/` (driven by
//! `validation/rqna_integration_check.sh`): the three-class tandem exports the complete RQNA
//! input contract.

mod common;

use qnet_core::export::{fbnasim, jackson_sim, qna};

/// The text with its `# Generated:` line taken out.
fn undated(s: &str) -> String {
    s.split('\n').filter(|l| !l.starts_with("# Generated: ")).collect::<Vec<_>>().join("\n")
}

/// Compares one exporter on every example with `<file>` or `<file>.error.txt`.
fn compare(file: &str, export: impl Fn(&qnet_core::model::Network) -> Result<String, String>, normalise: fn(&str) -> String) {
    let mut differ = Vec::new();
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let (ours, want) = match (export(&net), common::golden(&name, file), common::golden(&name, &format!("{file}.error.txt"))) {
            (Ok(s), Some(w), _) => (normalise(&s), normalise(&w)),
            (Err(e), _, Some(w)) => (format!("{e}\n"), w),
            (Ok(s), None, Some(w)) => (s, format!("refused: {w}")),
            (Err(e), Some(w), _) => (format!("refused: {e}"), w),
            (_, None, None) => panic!("{name}: no golden {file}"),
        };
        if ours != want {
            differ.push((name, ours, want));
        }
    }
    common::assert_all_match(file, differ);
}

/// Compares one exporter with `export-all/<file>`, present exactly when 0.90.34's export succeeded.
fn compare_export_all(file: &str, export: impl Fn(&qnet_core::model::Network) -> Result<String, String>, normalise: fn(&str) -> String) {
    let mut differ = Vec::new();
    let mut written = 0;
    for (name, path) in common::examples() {
        let net = common::network(&path);
        let ours = export(&net).ok().map(|s| normalise(&s));
        let want = common::golden(&name, &format!("export-all/{file}")).map(|s| normalise(&s));
        written += want.is_some() as usize;
        if ours != want {
            differ.push((name, ours.unwrap_or_else(|| "(refused)".into()), want.unwrap_or_else(|| "(not written)".into())));
        }
    }
    assert!(written > 0, "no export-all/{file} in the corpus");
    common::assert_all_match(&format!("export-all/{file}"), differ);
}

fn same(s: &str) -> String {
    s.to_string()
}

fn qna_text(n: &qnet_core::model::Network) -> Result<String, String> {
    qna::export(&n.nodes, &n.links).map_err(|e| e.message())
}

fn sim_text(n: &qnet_core::model::Network) -> Result<String, String> {
    jackson_sim::export(&n.nodes, &n.links).map_err(|e| e.message())
}

fn fbnasim_text(n: &qnet_core::model::Network) -> Result<String, String> {
    fbnasim::export(&n.nodes, &n.links, "11/10/26, 14:11:04").map_err(|e| e.message())
}

#[test]
fn every_qna_file_or_refusal_matches_0_90_34() {
    compare("qna.qna", qna_text, same);
}

#[test]
fn every_jackson_sim_file_or_refusal_matches_0_90_34() {
    compare("jackson.sim", sim_text, same);
}

#[test]
fn every_fbnasim_file_or_refusal_matches_0_90_34_apart_from_its_date() {
    compare("fbnasim.txt", fbnasim_text, undated);
}

#[test]
fn export_all_writes_the_same_qna_files() {
    compare_export_all("qna.qna", qna_text, same);
}

#[test]
fn export_all_writes_the_same_cmp_sim_files() {
    compare_export_all("cmp_sim.sim", sim_text, same);
}

#[test]
fn export_all_writes_the_same_sim_txt_files_apart_from_their_date() {
    compare_export_all("sim.txt", fbnasim_text, undated);
}

#[test]
fn the_generated_line_carries_the_callers_time_verbatim() {
    let (_, path) = common::examples().into_iter().find(|(n, _)| n == "3d3ctandem.inf").unwrap();
    let net = common::network(&path);
    let text = fbnasim::export(&net.nodes, &net.links, "11/10/26, 2:11:04\u{202f}PM").unwrap();
    assert_eq!(text.lines().nth(1), Some("# Generated: 11/10/26, 2:11:04\u{202f}PM"));
}

/// `validation/rqna_exporter/main.swift`, run by `rqna_integration_check.sh` on
/// `3d3ctandem.inf.bnet`: an infinite-buffer document whose export holds every section of the
/// three-class RQNA input.
#[test]
fn the_three_class_tandem_exports_the_complete_rqna_input_contract() {
    let net = common::network(&common::root().join("examples/3d3ctandem.inf.bnet"));
    assert!(net.infinite_buffers, "fixture is not an infinite-buffer network");
    let content = qna::export(&net.nodes, &net.links).unwrap_or_else(|e| panic!("{}", e.message()));
    for section in [
        "customer_classes 3",
        "# Per-class throughput alpha[k][i] (K rows x d cols)",
        "# Per-class service rate mu[k][i] (K rows x d cols)",
        "# Per-class service SCV cs[k][i] (K rows x d cols)",
        "# Per-class external arrival rate at station lambda_ext[k][i] (K rows x d cols)",
        "# Per-(class, station) routing P_ex[k*d+i][k'*d+j] ((K*d) x (K*d))",
        "# Per-class external SCV ca0_pc[k][i] (K rows x d cols)",
    ] {
        assert!(content.contains(section), "export omitted section: {section}");
    }
}

/// The rest of `rqna_integration_check.sh`: the staged `bna_rqna` reads that export and its
/// compact report (`-c`) has the RQNA banner and one `rho_`, `Gamma_`, `sojourn_` and `E[Q_` row
/// per station. Needs `scripts/stage-solvers.sh` to have run; says so and passes otherwise.
#[test]
fn the_staged_rqna_solver_reads_the_three_class_export_and_reports_every_station() {
    let home = std::env::var("HOME").unwrap_or_default();
    let solver = std::path::PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNArqna/bna_rqna");
    if !solver.is_file() {
        eprintln!("bna_rqna is not staged at {}; run scripts/stage-solvers.sh to check the solver side", solver.display());
        return;
    }
    let net = common::network(&common::root().join("examples/3d3ctandem.inf.bnet"));
    let input = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("golden-export-text-3d3ctandem.qna");
    std::fs::write(&input, qna::export(&net.nodes, &net.links).unwrap()).unwrap();
    let out = std::process::Command::new(&solver).arg(&input).arg("-c").output().expect("bna_rqna runs");
    assert!(out.status.success(), "compact analysis did not run: {}", String::from_utf8_lossy(&out.stderr));
    let report = String::from_utf8_lossy(&out.stdout);
    assert!(report.lines().any(|l| l == "RQNA (BNArqna)"), "compact output omitted the RQNA banner: {report}");
    for metric in ["rho_", "Gamma_", "sojourn_", "E[Q_"] {
        assert_eq!(report.lines().filter(|l| l.contains(metric)).count(), 3, "{metric} rows in {report}");
    }
}
