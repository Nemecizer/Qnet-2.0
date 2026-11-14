//! The comparison table against the awk programs 0.90.34 generated, run by BWK `/usr/bin/awk`
//! (the awk 0.90.34 used).
//!
//! Two oracles. `fixtures/output/comparison_awk.txt` holds programs written by 0.90.34's own
//! `buildComparisonAwk` (compiled out of its Swift source by `make-awk-oracles.sh`) for one to five
//! method columns, with and without an exact or asymptotic analytical column, the average column,
//! class rows and both variable names; each is run on synthetic solver outputs aimed at the awk's
//! corners (missing rows, failure sentinels, empty files, nan and inf, scientific values,
//! two-digit station indices) at every decimals setting 0…9. And the golden runs: every
//! `golden/runs/<example>/<method>/script.sh` that prints a table carries its awk program, which is
//! run on the solver outputs that run produced (kept under `fixtures/output/solver-outputs/`) and
//! must give the table in `archive.txt`; the Rust table, its banner and the analytical hand-over
//! file, computed from the example network, must give the same bytes. Without `/usr/bin/awk` the
//! differential tests print a note and pass.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use qnet_core::output::banner;
use qnet_core::output::table::{analytical_file, comparison_table, MethodColumn, TableSpec, VarName};

const AWK: &str = "/usr/bin/awk";

fn have_awk() -> bool {
    let ok = Path::new(AWK).exists();
    if !ok {
        eprintln!("NOTE: {AWK} is not available; the awk differential tests are skipped");
    }
    ok
}

fn fixtures() -> PathBuf {
    common::root().join("core/tests/fixtures/output")
}

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-output-table-{}", std::process::id())).join("synthetic");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs an awk program on files.
fn awk(program: &str, files: &[PathBuf]) -> String {
    let out = Command::new(AWK).arg(program).args(files).output().unwrap();
    assert!(out.status.success(), "awk failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

/// The program text of an `awk '<program>' "file" …` command, and its quoted file arguments.
fn split_awk_command(cmd: &str) -> (String, Vec<String>) {
    let start = cmd.find("awk '").expect("an awk command") + 5;
    // The program ends at the last `' "` (labels never hold a quote).
    let end = cmd.rfind("}' ").expect("the end of the program") + 1;
    let program = cmd[start..end].to_string();
    let mut files = Vec::new();
    let mut rest = &cmd[end + 1..];
    while let Some(i) = rest.find('"') {
        let j = rest[i + 1..].find('"').unwrap() + i + 1;
        files.push(rest[i + 1..j].to_string());
        rest = &rest[j + 1..];
        if !rest.starts_with(' ') || rest.trim_start().starts_with("&&") || rest.trim().is_empty() {
            break;
        }
    }
    (program, files)
}

/// The fmt7 constants of a program generated at 3 decimals, rewritten as `buildComparisonAwk`
/// writes them for `d` (its only three decimals-dependent interpolations).
fn with_decimals(program: &str, d: i64) -> String {
    let smallest = if d == 0 { "0".to_string() } else { format!("1e-{d}") };
    let sci = (d - 1).max(1);
    program
        .replace("absv(x)<1e-3||", &format!("absv(x)<{smallest}||"))
        .replace("sprintf(\"%.2e\",x)", &format!("sprintf(\"%.{sci}e\",x)"))
        .replace("sprintf(\"%.3f\",x)", &format!("sprintf(\"%.{d}f\",x)"))
}

/// One case of comparison_awk.txt.
struct Case {
    params: BTreeMap<String, String>,
    program: String,
}

fn cases() -> Vec<Case> {
    let text = std::fs::read_to_string(fixtures().join("comparison_awk.txt")).unwrap();
    let mut v = Vec::new();
    let mut lines = text.lines();
    while let Some(h) = lines.next() {
        let h = h.strip_prefix("### ").expect("a case header");
        let mut params = BTreeMap::new();
        for kv in h.split(' ') {
            if let Some((k, val)) = kv.split_once('=') {
                params.insert(k.to_string(), val.to_string());
            }
        }
        // anlabel may hold spaces; take it from the header text itself.
        let a = h.find("anlabel=").unwrap() + 8;
        let b = h.find(" avg=").unwrap();
        params.insert("anlabel".into(), h[a..b].to_string());
        let a = h.find("labels=").unwrap() + 7;
        let b = h.find(" var=").unwrap();
        params.insert("labels".into(), h[a..b].to_string());
        let (program, _) = split_awk_command(lines.next().unwrap());
        v.push(Case { params, program });
    }
    v
}

/// A deterministic pseudo-random generator.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

fn random_value(r: &mut Rng) -> String {
    let mag = 10f64.powi(r.below(16) as i32 - 9);
    let x = (r.below(1_000_000) as f64 / 1_000_000.0) * mag * if r.chance(15) { -1.0 } else { 1.0 };
    match r.below(20) {
        0 => "0".into(),
        1 => "-0.000000".into(),
        2 => "nan".into(),
        3 => ["inf", "-inf", "-nan"][r.below(3) as usize].into(),
        4 => format!("{x:e}"),
        5 => format!("{:.3e}", x),
        6 => format!("{}", r.below(50)),
        7 => format!("{:.17}", x),
        _ => format!("{:.6}", x),
    }
}

/// A solver output in the compact `-G`/`-c` shape, with the irregularities awk must survive.
fn random_output(r: &mut Rng, d: u64, var: &str) -> String {
    match r.below(25) {
        0 => return "QNET_METHOD_FAILURE_V1 method=sm exit=1\n".into(),
        1 => return String::new(),
        2 => return "QNET_METHOD_FAILURE_V1 method=lp skipped=yes reason=no%20solver\n".into(),
        _ => {}
    }
    let mut s = String::from("Monte Carlo Simulation\n==================\n\n");
    let sep = if r.chance(50) { "\t" } else { " " };
    let kinds = ["rho_{}", "Gamma_{}", "sojourn_{}", "X(class {})", &format!("E[{var}_{{}}]")];
    for kind in kinds {
        for k in 1..=d {
            if r.chance(8) {
                continue;
            }
            let key = kind.replace("{}", &k.to_string());
            match r.below(30) {
                0 => s.push_str(&format!("{key} =\n")),
                1 => s.push_str(&format!("{key}\n")),
                _ => {
                    s.push_str(&format!("{key} = {}", random_value(r)));
                    if r.chance(40) {
                        s.push_str(&format!("{sep}({})", random_value(r)));
                    } else if r.chance(5) {
                        s.push_str(" [x]");
                    }
                    s.push('\n');
                }
            }
        }
        s.push('\n');
    }
    if r.chance(20) {
        s.push_str("W_total(class 1) = 0.244506\t(0.016951)\nE[Y_1] = 3\nE[X_1] = 9\nE[Q_1] = 8\nrho_x = 5\n");
    }
    if r.chance(10) {
        s.pop();
    }
    s
}

/// An analytical hand-over in writeAnalyticalFile's shape (sometimes only the E[·] lines).
fn random_analytical(r: &mut Rng, d: u64, var: &str) -> String {
    let mut s = String::new();
    if r.chance(80) {
        for kind in ["rho", "Gamma", "sojourn"] {
            for k in 1..=d {
                s.push_str(&format!("{kind}_{k} = {:.17e}\n", r.below(1000) as f64 / 997.0));
            }
        }
    }
    for k in 1..=d {
        if r.chance(95) {
            s.push_str(&format!("E[{var}_{k}] = {}\n", random_value(r)));
        }
    }
    s
}

fn spec_for(case: &Case, outputs: &[String], analytical: Option<String>, decimals: i64) -> TableSpec {
    let p = &case.params;
    let labels: Vec<&str> = p["labels"].split('|').collect();
    TableSpec {
        columns: labels.iter().zip(outputs).map(|(l, o)| MethodColumn { label: l.to_string(), output: o.clone() }).collect(),
        var_name: if p["var"] == "X" { VarName::X } else { VarName::Q },
        show_gamma: p["gamma"] == "1",
        show_sojourn: p["sojourn"] == "1",
        show_xclass: p["xclass"] == "1",
        analytical,
        analytical_label: if p["an"] == "0" || p["anlabel"].is_empty() { None } else { Some(p["anlabel"].clone()) },
        analytical_is_exact: p["an"] == "1",
        show_average: p["avg"] == "1",
        decimals,
    }
}

fn assert_same(what: &str, ours: &str, oracle: &str) {
    if ours != oracle {
        let (a, b): (Vec<_>, Vec<_>) = (ours.lines().collect(), oracle.lines().collect());
        let i = a.iter().zip(&b).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
        panic!(
            "{what} differs at line {}:\n  ours:   {:?}\n  oracle: {:?}\n--- ours:\n{ours}\n--- oracle:\n{oracle}",
            i + 1,
            a.get(i),
            b.get(i)
        );
    }
}

#[test]
fn the_decimals_substitution_reproduces_the_swift_generator() {
    let all = cases();
    let base = all
        .iter()
        .find(|c| c.params["decimals"] == "3" && c.params["n"] == "4" && c.params["an"] == "1" && c.params["avg"] == "1" && c.params["xclass"] == "0")
        .unwrap();
    let mut checked = 0;
    for c in all.iter().filter(|c| c.params["decimals"] != "3") {
        let d: i64 = c.params["decimals"].parse().unwrap();
        assert_eq!(with_decimals(&base.program, d), c.program, "decimals {d}");
        checked += 1;
    }
    assert_eq!(checked, 9);
}

#[test]
fn synthetic_outputs_match_the_generated_awk_at_every_setting() {
    if !have_awk() {
        return;
    }
    let dir = scratch();
    let mut r = Rng(0xA5A5_1234_DEAD_BEEF);
    let mut runs = 0;
    for (ci, case) in cases().iter().enumerate().filter(|(_, c)| c.params["decimals"] == "3") {
        let n: usize = case.params["n"].parse().unwrap();
        let var = case.params["var"].clone();
        for trial in 0..4 {
            let d = [1, 2, 3, 5, 9, 10, 12][r.below(7) as usize];
            let outputs: Vec<String> = (0..n).map(|_| random_output(&mut r, d, &var)).collect();
            let analytical = (case.params["an"] != "0").then(|| random_analytical(&mut r, d, &var));
            let mut files = Vec::new();
            for (i, o) in outputs.iter().enumerate() {
                let p = dir.join(format!("c{ci}-t{trial}-F{}", i + 1));
                std::fs::write(&p, o).unwrap();
                files.push(p);
            }
            if let Some(a) = &analytical {
                let p = dir.join(format!("c{ci}-t{trial}-AN"));
                std::fs::write(&p, a).unwrap();
                files.push(p);
            }
            for decimals in 0..=9 {
                let oracle = awk(&with_decimals(&case.program, decimals), &files);
                let ours = comparison_table(&spec_for(case, &outputs, analytical.clone(), decimals));
                assert_same(&format!("case {ci} ({:?}) trial {trial} at {decimals}", case.params), &ours, &oracle);
                runs += 1;
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    eprintln!("{runs} awk runs compared");
}

// ── golden runs ──

/// The golden runs whose wrapper prints a comparison-style table, with the awk command.
fn table_runs() -> Vec<(String, String, PathBuf, String)> {
    let mut v = Vec::new();
    let runs = common::root().join("golden/runs");
    let Ok(examples) = std::fs::read_dir(&runs) else { return v };
    for e in examples.flatten() {
        let Ok(methods) = std::fs::read_dir(e.path()) else { continue };
        for m in methods.flatten() {
            let Ok(script) = std::fs::read_to_string(m.path().join("script.sh")) else { continue };
            if let Some(i) = script.find("awk 'FNR==1{f++}") {
                let end = script[i..].find("' \"").map(|j| i + j).unwrap();
                // the command runs to the end of its file list
                let tail = &script[end..];
                let stop = tail.find(" && ").or_else(|| tail.find('\n')).unwrap_or(tail.len());
                v.push((
                    e.file_name().to_string_lossy().to_string(),
                    m.file_name().to_string_lossy().to_string(),
                    m.path(),
                    script[i..end + stop].to_string(),
                ));
            }
        }
    }
    v.sort();
    v
}

/// The captured output of one file a golden run's table read: `<example>/<method>/<n>.txt`, where n
/// is the file's place on the awk command line (the analytical file is `analytical.txt`).
fn captured(example: &str, method: &str, file: &str, place: usize) -> PathBuf {
    let dir = fixtures().join("solver-outputs").join(example).join(method);
    if file.contains("BNET_analytical_") {
        dir.join("analytical.txt")
    } else {
        dir.join(format!("{place}.txt"))
    }
}

/// The labels and switches a golden awk program was generated with, read back from its text.
struct Generated {
    labels: Vec<String>,
    var: VarName,
    an_label: Option<String>,
    an_exact: bool,
    avg: bool,
    gamma: bool,
    sojourn: bool,
    xclass: bool,
}

fn read_generated(program: &str, n: usize, has_an: bool) -> Generated {
    let label = |col: usize| -> Option<String> {
        let key = format!("C[R,{col}]=\"");
        let header = &program[program.find("R++;G[R]=0;C[R,1]=\"\";").unwrap()..];
        let i = header.find(&key)? + key.len();
        Some(header[i..i + header[i..].find('"').unwrap()].to_string())
    };
    let labels: Vec<String> = (2..=n + 1).map(|c| label(c).unwrap()).collect();
    let avg = program.contains("\"Average of Algorithms\"");
    let an_col = if avg { n + 3 } else { n + 2 };
    Generated {
        labels,
        var: if program.contains("E\\[X_") { VarName::X } else { VarName::Q },
        an_label: if has_an { label(an_col) } else { None },
        an_exact: program.contains("fmtv(rh[1,k],an_rh[k]"),
        avg,
        gamma: program.contains("sprintf(\"Gamma_%0*d\""),
        sojourn: program.contains("sprintf(\"sojourn_%0*d\""),
        xclass: program.contains("sprintf(\"X(class %0*d)\""),
    }
}

#[test]
fn every_golden_table_is_reproduced_from_its_solver_outputs() {
    let runs = table_runs();
    if runs.is_empty() {
        eprintln!("NOTE: golden/runs holds no table runs yet");
        return;
    }
    let examples: BTreeMap<String, PathBuf> = common::examples().into_iter().collect();
    let mut checked = 0;
    let mut missing = Vec::new();
    for (example, method, dir, cmd) in &runs {
        let (program, files) = split_awk_command(cmd);
        let Ok(archive) = std::fs::read_to_string(dir.join("archive.txt")) else { continue };
        if !archive.contains("Elapsed time: ") {
            continue; // the run stopped before its table
        }
        let script = std::fs::read_to_string(dir.join("script.sh")).unwrap();
        let decimals: i64 = {
            let i = script.find("exec perl \"").unwrap() + 11;
            let i = i + script[i..].find("\" ").unwrap() + 2;
            script[i..i + script[i..].find(';').unwrap()].trim().parse().unwrap()
        };
        let paths: Vec<PathBuf> = files.iter().enumerate().map(|(i, f)| captured(example, method, f, i + 1)).collect();
        if paths.iter().any(|p| !p.exists()) {
            missing.push(format!("{example}/{method}"));
            continue;
        }
        let has_an = files.iter().any(|f| f.contains("BNET_analytical_"));
        let n = files.len() - usize::from(has_an);
        let outputs: Vec<String> = paths[..n].iter().map(|p| std::fs::read_to_string(p).unwrap()).collect();

        // The network's own analysis: the analytical hand-over, the banner.
        let net = common::network(&examples[example]);
        let data = qnet_core::traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).ok();
        let flags = data.as_ref().map(|d| qnet_core::flags::assess(d, &net.nodes, net.infinite_buffers));
        let tractable = flags.as_ref().is_some_and(|f| f.is_analytically_tractable);
        let g = read_generated(&program, n, has_an);
        // The run's own variable name: Multi-class SRBM asks for E[X_k] even on an infinite network.
        let var = g.var;
        if method != "mc" {
            assert_eq!(var, VarName::for_buffers(net.infinite_buffers), "{example}/{method}: variable name");
        }
        let analytical = flags.as_ref().and_then(|f| analytical_file(f.is_analytically_tractable, &f.tractability_means, data.as_ref(), var));
        assert_eq!(analytical.is_some(), has_an, "{example}/{method}: analytical column present");
        if let Some(a) = &analytical {
            let captured = std::fs::read_to_string(&paths[n]).unwrap();
            assert_same(&format!("{example}/{method}: analytical file"), a, &captured);
            let f = flags.as_ref().unwrap();
            assert_eq!(g.an_exact, f.tractability_is_exact, "{example}/{method}: exactness");
            let want_label = f.tractability_means_label.trim_matches([' ', '\t']);
            assert_eq!(g.an_label.as_deref(), Some(if want_label.is_empty() { "Exact Result" } else { want_label }));
        }

        // The oracle itself must reproduce the archive from the captured outputs.
        let oracle = awk(&program, &paths);
        let spec = TableSpec {
            columns: g.labels.iter().zip(&outputs).map(|(l, o)| MethodColumn { label: l.clone(), output: o.clone() }).collect(),
            var_name: var,
            show_gamma: g.gamma,
            show_sojourn: g.sojourn,
            show_xclass: g.xclass,
            analytical,
            analytical_label: flags.as_ref().map(|f| f.tractability_means_label.clone()),
            analytical_is_exact: flags.as_ref().is_some_and(|f| f.tractability_is_exact),
            show_average: g.avg,
            decimals,
        };
        let table = comparison_table(&spec);
        assert_same(&format!("{example}/{method}: table vs awk"), &table, &oracle);

        let regime = banner::regime_lines(&net.nodes, &net.links, net.infinite_buffers);
        let detail = flags.as_ref().map(|f| f.tractability_detail.clone()).unwrap_or_default();
        let head = banner::table_banner(&regime, banner::tractability_line(tractable, &detail).as_deref());
        if !followed_by_elapsed(&archive, &format!("{head}{table}")) {
            // ANA-082 (Changed): 0.90.34 paired ρ_i with K in document order. Put that back and
            // the archive must then match.
            let old_k = document_order_capacities(&net);
            let old = data.as_ref().map(|d| banner::regime_lines_for(d, net.infinite_buffers, &old_k)).unwrap_or_default();
            let old_head = banner::table_banner(&old, banner::tractability_line(tractable, &detail).as_deref());
            assert!(
                followed_by_elapsed(&archive, &format!("{old_head}{table}")),
                "{example}/{method}: banner + table not found in archive.txt\n--- ours:\n{head}{table}\n--- archive:\n{archive}"
            );
            eprintln!("{example}/{method}: Buffer regime line differs from 0.90.34 by ANA-082 (document-order K)");
        }
        checked += 1;
    }
    eprintln!("checked {checked} golden tables; {} without captured outputs: {:?}", missing.len(), missing);
    assert!(missing.is_empty(), "golden table runs without captured solver outputs: {missing:?}");
}

/// True when `block` appears in the archive right before the run's "Elapsed time:" line, allowing
/// the status sentinels a run specification prints after the table (`QNET_COMPARISON_STATUS_V1`,
/// `QNET_SBD_STATUS_V1`; not the table's text) in between.
fn followed_by_elapsed(archive: &str, block: &str) -> bool {
    archive.match_indices(block).any(|(i, _)| {
        let mut rest = &archive[i + block.len()..];
        while rest.starts_with("QNET_") {
            rest = &rest[rest.find('\n').map_or(rest.len(), |j| j + 1)..];
        }
        rest.starts_with("Elapsed time: ")
    })
}

/// 0.90.34's K_i: the stations in document order (`nodes.filter { $0.kind == .station }`).
fn document_order_capacities(net: &qnet_core::model::Network) -> Vec<i64> {
    use qnet_core::model::NodeKind;
    net.nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Station)
        .map(|s| {
            net.nodes
                .iter()
                .find(|c| c.kind == NodeKind::Buffer && net.links.iter().any(|l| l.from == c.id && l.to == s.id))
                .map_or(0, |b| b.buffer_size)
                + s.servers
        })
        .collect()
}

#[test]
fn the_analytical_hand_over_writes_every_value_at_17_significant_digits() {
    let examples = common::examples();
    let (_, path) = examples.iter().find(|(n, _)| n == "OpenJackson.d2.feedback.p50.inf").unwrap();
    let net = common::network(path);
    let data = qnet_core::traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
    let f = qnet_core::flags::assess(&data, &net.nodes, true);
    let text = analytical_file(f.is_analytically_tractable, &f.tractability_means, Some(&data), VarName::Q).unwrap();
    assert!(text.starts_with("rho_1 = 0.69999999999999996\n") || text.starts_with("rho_1 = "), "{text}");
    assert!(text.ends_with(&format!("E[Q_2] = {}\n", qnet_core::cfmt::f("%.17g", f.tractability_means[1]))));
    assert_eq!(text.lines().count(), 8);
    assert_eq!(analytical_file(false, &f.tractability_means, Some(&data), VarName::Q), None);
    // A dimension mismatch writes only the E[·] lines.
    assert_eq!(analytical_file(true, &[1.5], Some(&data), VarName::X).unwrap(), "E[X_1] = 1.5\n");
}
