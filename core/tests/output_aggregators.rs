//! The MLMC replication check and aggregator, the LP summary, the adaptive-BAR queue-length rows,
//! the test-set table and the spectral-convergence table, each against the awk program 0.90.34
//! generated for it (`fixtures/output/*`, written by `make-awk-oracles.sh` from the Swift source),
//! run by BWK `/usr/bin/awk` on synthetic solver outputs aimed at the programs' corners. Where the
//! golden corpus holds a run of the method, the solver's own output is cut out of its archive,
//! put through the Rust port, and must give the archive's text back. Without `/usr/bin/awk` the
//! differential tests print a note and pass.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use qnet_core::cfmt;
use qnet_core::output::aggregate::{spectral_convergence_table, test_set_table, SweepFile};
use qnet_core::output::{adaptive_bar, lp, mlmc};

const AWK: &str = "/usr/bin/awk";

fn have_awk() -> bool {
    let ok = Path::new(AWK).exists();
    if !ok {
        eprintln!("NOTE: {AWK} is not available; the awk differential tests are skipped");
    }
    ok
}

fn fixture(name: &str) -> String {
    std::fs::read_to_string(common::root().join("core/tests/fixtures/output").join(name)).unwrap()
}

/// A fresh folder for one test's files (removed again by [`Cleanup`] when the test ends).
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-output-agg-{}", std::process::id())).join(name);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn assert_same(what: &str, ours: &str, oracle: &str) {
    if ours != oracle {
        let (a, b): (Vec<_>, Vec<_>) = (ours.lines().collect(), oracle.lines().collect());
        let i = a.iter().zip(&b).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
        panic!("{what} differs at line {}:\n  ours:   {:?}\n  oracle: {:?}\n--- ours:\n{ours}\n--- oracle:\n{oracle}", i + 1, a.get(i), b.get(i));
    }
}

/// Removes the test's scratch folders when dropped.
struct Cleanup(&'static str);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let base = std::env::temp_dir().join(format!("qnet-output-agg-{}", std::process::id()));
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with(self.0) {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    }
}

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
    fn value(&mut self) -> String {
        let x = self.below(10_000_000) as f64 / 10f64.powi(self.below(9) as i32);
        match self.below(16) {
            0 => "0".into(),
            1 => "-0.000000".into(),
            2 => "nan".into(),
            3 => format!("-{x:.6}"),
            4 => format!("{x:e}"),
            _ => format!("{x:.6}"),
        }
    }
}

/// The program text of the adaptive-BAR command: from `'BEGIN` to the last single quote.
fn program_of(cmd: &str) -> &str {
    &cmd[cmd.find("'BEGIN").unwrap() + 1..cmd.rfind('\'').unwrap()]
}

// ── MLMC ──

fn mlmc_replication(r: &mut Rng, d: u64, k: usize) -> String {
    let mut s = String::new();
    if r.chance(90) {
        s.push_str(&format!("# Dimension: {d}\n"));
    }
    s.push_str(&format!("# gamma=0.5000  epsilon=0.0100  T=12.0000  L=6  N={}  seed={}\n", r.below(100_000), k));
    s.push_str("# backend=accelerate  threads=4  elapsed=0.123s\n");
    s.push_str(&format!("# Total Gaussian RVs generated: {}\n", r.below(1u64 << 40)));
    match r.below(3) {
        0 => s.push_str("# antithetic=off adaptive=off\n"),
        1 => s.push_str("# antithetic=on adaptive=on stop=SE target achieved\n"),
        _ => s.push_str("# antithetic=off adaptive=on stop=hit --max-samples cap\n"),
    }
    s.push_str("#\n# Component   E[Y_i(inf)]     SE          95% CI half-width\n");
    for j in 1..=d {
        if r.chance(4) {
            continue;
        }
        s.push_str(&format!("  {j:4}        {}     {}     {}\n", r.value(), r.value(), r.value()));
    }
    if r.chance(20) {
        s.push_str("  1 x y\n  7  1.5 2.5\n\t3  1 1 1\n");
    }
    s.push_str("#\n# Total complexity (Gaussian RVs): 5\n");
    s
}

#[test]
fn mlmc_check_and_aggregator_match_the_awk() {
    let _cleanup = Cleanup("mlmc");
    if !have_awk() {
        return;
    }
    let check = fixture("mlmc_check.awk");
    let agg = fixture("mlmc_aggregate.awk");
    let dir = scratch("mlmc");
    let mut r = Rng(77);
    for trial in 0..120 {
        let d = 1 + r.below(12);
        let k = 1 + r.below(6) as usize;
        let base = dir.join(format!("t{trial}"));
        let mut outputs = Vec::new();
        for i in 1..=k {
            let text = mlmc_replication(&mut r, d, i);
            std::fs::write(format!("{}.{i}", base.display()), &text).unwrap();
            let expected = d as usize - usize::from(r.chance(10));
            let ok = Command::new(AWK).arg("-v").arg(format!("expected={expected}")).arg(&check).arg(format!("{}.{i}", base.display())).status().unwrap().success();
            assert_eq!(mlmc::replication_output_is_complete(&text, expected), ok, "check, trial {trial} replication {i}:\n{text}");
            outputs.push(text);
        }
        let mu: Vec<f64> = (0..d).map(|_| r.below(1000) as f64 / 7.0 + if r.chance(5) { 1e-12 } else { 0.0 }).collect();
        let seeds = mlmc::replication_seeds(trial as i64, k);
        let critical = mlmc::critical_95(k + if r.chance(30) { 40 } else { 0 });
        let mu_text = mu.iter().map(|m| cfmt::f("%.17g", *m)).collect::<Vec<_>>().join(" ");
        let seeds_text = seeds.iter().map(u64::to_string).collect::<Vec<_>>().join(" ");
        let out = Command::new(AWK)
            .args(["-v", &format!("mu={mu_text}"), "-v", &format!("K={k}"), "-v", &format!("critical={}", cfmt::f("%.12g", critical))])
            .args(["-v", &format!("base={}", base.display()), "-v", &format!("seeds={seeds_text}")])
            .arg(&agg)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let refs: Vec<Option<&str>> = outputs.iter().map(|s| Some(s.as_str())).collect();
        assert_same(&format!("aggregate, trial {trial}"), &mlmc::aggregate(&refs, &mu, &seeds, critical), &String::from_utf8(out.stdout).unwrap());
    }
}

// ── LP ──

#[test]
fn the_lp_summary_matches_the_awk() {
    let _cleanup = Cleanup("lp");
    if !have_awk() {
        return;
    }
    let cmd = fixture("lp_summary.txt");
    let dir = scratch("lp");
    let mut r = Rng(5);
    for trial in 0..60 {
        let d = 1 + r.below(11);
        let mut s = String::from("[Parse] 0.000 s\n");
        if r.chance(80) {
            s.push_str("  grid_n        = 12\n  basis_m       = 6\n");
        }
        if r.chance(80) {
            s.push_str("[Build LP] 1234 rows, 567 columns (0.012 s)\n[Solve] Using solver: highs\n");
        }
        if r.chance(80) {
            s.push_str("[Solve] Optimal u* = 1.2345678901e-03 (0.040 s)\n");
        }
        for k in 1..=d {
            if r.chance(90) {
                s.push_str(&format!("E[X_{k}] = {}\n", r.value()));
            }
        }
        if r.chance(80) {
            s.push_str(&format!("[Total] {:.3} s\n", r.below(9999) as f64 / 1000.0));
        }
        let out_file = dir.join(format!("s{trial}.out"));
        std::fs::write(&out_file, &s).unwrap();
        let mu: Vec<f64> = (0..d + r.below(2)).map(|_| r.below(5000) as f64 / 13.0).collect();
        let servers: Vec<i64> = (0..d - r.below(2).min(d)).map(|_| 1 + r.below(3) as i64).collect();
        let mu_text = mu.iter().map(|m| cfmt::f("%.17g", *m)).collect::<Vec<_>>().join(" ");
        let sv_text = servers.iter().map(i64::to_string).collect::<Vec<_>>().join(" ");
        let out = Command::new("/bin/bash")
            .arg("-c")
            .arg(cmd.replace("\"OUT\"", &format!("\"{}\"", out_file.display())))
            .env("MU", &mu_text)
            .env("SERVERS", &sv_text)
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap();
        assert_same(&format!("lp summary, trial {trial}"), &lp::summary(&s, &mu, &servers), &String::from_utf8(out.stdout).unwrap());
    }
}

// ── adaptive BAR ──

#[test]
fn the_adaptive_bar_rows_match_the_awk() {
    let _cleanup = Cleanup("abar");
    if !have_awk() {
        return;
    }
    let program = program_of(fixture("adaptive_bar.txt").trim()).to_string();
    let mut r = Rng(11);
    for trial in 0..80 {
        let n = 1 + r.below(12) as usize;
        let caps: Vec<f64> = (0..n).map(|_| r.below(100_000) as f64 / 37.0).collect();
        let mut s = String::from("Adaptive low-rank BAR\n=====\n");
        for i in 1..=n + 1 {
            if r.chance(85) {
                s.push_str(&format!("E[Z_{i}] = {}{}\n", r.value(), if r.chance(20) { "  (held-out)" } else { "" }));
            }
        }
        if r.chance(20) {
            s.push_str("E[Z_x] = 5\nE[Z_0] = 1\n");
        }
        if r.chance(30) {
            s.push_str("no newline at the end");
        }
        let dir = scratch("abar");
        let f = dir.join(format!("{trial}.txt"));
        std::fs::write(&f, &s).unwrap();
        let mu_text = caps.iter().map(|m| cfmt::f("%.17g", *m)).collect::<Vec<_>>().join(" ");
        let out = Command::new(AWK)
            .args(["-v", &format!("w={}", n.to_string().len()), "-v", &format!("mu={mu_text}")])
            .arg(&program)
            .arg(&f)
            .output()
            .unwrap();
        assert_same(&format!("adaptive BAR, trial {trial}"), &adaptive_bar::queue_length_rows(&s, &caps), &String::from_utf8(out.stdout).unwrap());
    }
}

// ── test sets and spectral convergence ──

fn sweep_value_lines(r: &mut Rng, var: &str, d: u64) -> String {
    if r.chance(6) {
        return String::new();
    }
    if r.chance(4) {
        return "QNET_METHOD_FAILURE_V1 method=x exit=1\n".into();
    }
    let mut s = String::from("Header\n=====\n");
    for k in 1..=d {
        if r.chance(92) {
            let v = if r.chance(5) { "0".to_string() } else { format!("{:.6}", 0.05 + r.below(100_000) as f64 / 1000.0) };
            s.push_str(&format!("E[{var}_{k}] = {v}\t(0.01)\n"));
        }
    }
    if r.chance(10) {
        s.push_str(&format!("E[{var}_x] = 4\nE[{var}_2]= 4\n"));
    }
    s
}

/// Runs a generated sweep aggregator command on the files in `dir` (glob order of the C locale).
fn run_sweep(cmd: &str, dir: &Path) -> String {
    let out = Command::new("/bin/bash")
        .arg("-c")
        .arg(cmd.replace("\"W\"/out_*.txt", &format!("\"{}\"/out_*.txt", dir.display())))
        .env("LC_ALL", "C")
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap()
}

fn files_in(dir: &Path) -> Vec<SweepFile> {
    let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    names.sort();
    names
        .into_iter()
        .map(|n| SweepFile { text: std::fs::read_to_string(dir.join(&n)).unwrap(), name: format!("{}/{n}", dir.display()) })
        .collect()
}

#[test]
fn the_test_set_table_matches_the_awk() {
    let _cleanup = Cleanup("ts-");
    if !have_awk() {
        return;
    }
    let text = fixture("testset_awk.txt");
    let inf_start = text.find("### infinite\n").unwrap() + 13;
    let fin_start = text.find("### finite\n").unwrap();
    let variants = [
        ("Q", vec!["Spectral", "QNA", "RQNA", "SBD", "Sim"], &text[inf_start..fin_start]),
        ("X", vec!["Spectral", "FE", "LP", "Sim"], &text[fin_start + 11..]),
    ];
    let mut r = Rng(99);
    for trial in 0..40 {
        for (var, algos, cmd) in &variants {
            let dir = scratch(&format!("ts-{var}-{trial}"));
            let cases = 1 + r.below(14);
            for c in 0..cases {
                let d = 1 + r.below(6);
                for a in algos {
                    if r.chance(90) {
                        std::fs::write(dir.join(format!("out_{c}_{a}.txt")), sweep_value_lines(&mut r, var, d)).unwrap();
                    }
                }
            }
            let ours = test_set_table(&files_in(&dir), var, algos, "Sim");
            assert_same(&format!("test set {var}, trial {trial}"), &ours, &run_sweep(cmd, &dir));
        }
    }
}

#[test]
fn the_spectral_convergence_table_matches_the_awk() {
    let _cleanup = Cleanup("spc-");
    if !have_awk() {
        return;
    }
    let cmd = fixture("spectral_awk.txt");
    let rhos = [0.5, 0.7, 0.85, 0.95, 0.99];
    let mut r = Rng(1234);
    for trial in 0..15 {
        let dir = scratch(&format!("spc-{trial}"));
        let cases = 1 + r.below(130);
        for c in 0..cases {
            let d = 1 + r.below(5);
            for ri in 0..6 {
                for a in ["Spectral", "QNA", "Sim"] {
                    if r.chance(85) {
                        std::fs::write(dir.join(format!("out_{c}_r{ri}_{a}.txt")), sweep_value_lines(&mut r, "Q", d)).unwrap();
                    }
                }
            }
        }
        let ours = spectral_convergence_table(&files_in(&dir), &rhos);
        assert_same(&format!("spectral convergence, trial {trial}"), &ours, &run_sweep(&cmd, &dir));
    }
}

#[test]
fn awk_visits_array_keys_in_the_order_the_port_assumes() {
    let _cleanup = Cleanup("order");
    if !have_awk() {
        return;
    }
    // The convergence table sums case errors in `for (c in cases)` order; check that order on a
    // table big enough to have grown (more than 100 keys).
    let keys: Vec<String> = (0..260).map(|i| ((i * 37) % 263).to_string()).collect();
    let prog = format!("BEGIN{{n=split(\"{}\",k,\" \");for(i=1;i<=n;i++)a[k[i]];for(x in a)printf \"%s \", x}}", keys.join(" "));
    let out = Command::new(AWK).arg(prog).output().unwrap();
    let awk_order: Vec<String> = String::from_utf8(out.stdout).unwrap().split_whitespace().map(str::to_string).collect();
    assert_eq!(qnet_core::output::awk::for_in_order(&keys), awk_order);
}

// ── the golden test-set and convergence runs ──

/// The generated aggregator command in a golden sweep wrapper, from its `awk -v` line to the line
/// ending in `/out_*.txt`, with the work folder written as W.
fn golden_sweep_command(name: &str) -> Option<String> {
    let script = std::fs::read_to_string(common::root().join("golden/runs/_testsets").join(name).join("script.sh")).ok()?;
    let start = script.find("\nawk -v ")? + 1;
    let end = start + script[start..].find("/out_*.txt\n")? + "/out_*.txt\n".len();
    let cmd = &script[start..end];
    // The work folder is the quoted path before /out_*.txt.
    let q = cmd[..cmd.len() - "/out_*.txt\n".len() - 1].rfind('"').unwrap();
    Some(format!("{}\"W\"/out_*.txt\n", &cmd[..q]))
}

#[test]
fn the_golden_sweeps_ran_the_programs_the_oracles_hold_and_print_the_same_frame() {
    let text = fixture("testset_awk.txt");
    let fin = text.find("### finite\n").unwrap();
    for (name, oracle, var, algos) in [
        ("testset-infinite", &text[13..fin], "Q", vec!["Spectral", "QNA", "RQNA", "SBD", "Sim"]),
        ("testset-finite", &text[fin + 11..], "X", vec!["Spectral", "FE", "LP", "Sim"]),
    ] {
        let Some(cmd) = golden_sweep_command(name) else { continue };
        assert_eq!(cmd, oracle, "{name}: the program the golden run used");
        // With no outputs every row is dashes; the header and the footnote are the same text.
        let archive = std::fs::read_to_string(common::root().join("golden/runs/_testsets").join(name).join("archive.txt")).unwrap();
        let empty = test_set_table(&[], var, &algos, "Sim");
        let lines: Vec<&str> = empty.lines().collect();
        assert!(archive.contains(&lines[..3].join("\n")), "{name}: header");
        assert!(archive.contains(&lines[lines.len() - 10..].join("\n")), "{name}: footnote");
    }
    if let Some(cmd) = golden_sweep_command("spc") {
        let oracle = fixture("spectral_awk.txt");
        // The ρ list is the sweep's own; the program after it is fixed.
        assert_eq!(&cmd[cmd.find("\" '").unwrap()..], &oracle[oracle.find("\" '").unwrap()..], "spc: the program the golden run used");
        let archive = std::fs::read_to_string(common::root().join("golden/runs/_testsets/spc/archive.txt")).unwrap();
        let empty = spectral_convergence_table(&[], &[0.5]);
        let lines: Vec<&str> = empty.lines().collect();
        assert!(archive.contains(&lines[..3].join("\n")), "spc: header");
        assert!(archive.contains(&lines[lines.len() - 6..].join("\n")), "spc: footnote");
    }
}
