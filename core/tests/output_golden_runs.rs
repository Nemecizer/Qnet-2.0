//! The run texts against every golden run that prints them (`golden/runs/<example>/<method>/`):
//! the thread-count banner and the elapsed-time line of every archive, and, for Linear Program and
//! adaptive low-rank BAR, the summary or queue-length rows rebuilt from the solver output the
//! archive holds right above them. (The comparison tables are checked in `output_table.rs`.)

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use qnet_core::export::srbm_orthant;
use qnet_core::output::{adaptive_bar, banner, lp};

/// (example, method, run folder) of every golden run with an archive.
fn runs() -> Vec<(String, String, PathBuf)> {
    let mut v = Vec::new();
    let Ok(examples) = std::fs::read_dir(common::root().join("golden/runs")) else { return v };
    for e in examples.flatten() {
        let Ok(methods) = std::fs::read_dir(e.path()) else { continue };
        for m in methods.flatten() {
            if m.path().join("archive.txt").exists() && m.path().join("script.sh").exists() {
                v.push((e.file_name().to_string_lossy().to_string(), m.file_name().to_string_lossy().to_string(), m.path()));
            }
        }
    }
    v.sort();
    v
}

fn read(p: PathBuf) -> String {
    String::from_utf8_lossy(&std::fs::read(p).unwrap()).to_string()
}

/// The integer printed by `printf '<format>' N` in a wrapper.
fn printf_arg(script: &str, format: &str) -> Option<usize> {
    let i = script.find(format)? + format.len();
    script[i..].trim_start_matches('\'').trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

#[test]
fn every_thread_banner_and_elapsed_line_reads_as_0_90_34_printed_it() {
    let mut checked = (0, 0);
    for (example, method, dir) in runs() {
        let archive = read(dir.join("archive.txt"));
        let script = read(dir.join("script.sh"));
        let first = archive.lines().next().unwrap_or("");
        let want = if let Some(n) = printf_arg(&script, "printf '[Threads] Using %d CPU cores (OpenMP)\\n'") {
            Some(banner::thread_count_banner(true, n))
        } else if script.contains("printf '[Threads] Single-threaded (analytical solver)\\n'") {
            Some(banner::thread_count_banner(false, 1))
        } else {
            printf_arg(&script, "printf '[Threads] %d CPU cores for parallel solvers").map(banner::thread_count_banner_mixed)
        };
        if let Some(want) = want {
            assert_eq!(first, want, "{example}/{method}");
            checked.0 += 1;
        }
        for line in archive.lines().filter(|l| l.starts_with("Elapsed time: ")) {
            let secs: f64 = line["Elapsed time: ".len()..line.len() - 1].parse().unwrap();
            assert_eq!(line, banner::elapsed_line(secs), "{example}/{method}");
            checked.1 += 1;
        }
    }
    eprintln!("checked {} thread banners and {} elapsed lines", checked.0, checked.1);
}

#[test]
fn every_golden_lp_summary_is_rebuilt_from_the_solver_output_above_it() {
    let examples: BTreeMap<String, PathBuf> = common::examples().into_iter().collect();
    let mut checked = 0;
    for (example, method, dir) in runs().into_iter().filter(|r| r.1 == "lp") {
        let archive = read(dir.join("archive.txt"));
        let Some(start) = archive.find(lp::HEADING) else { continue };
        let net = common::network(&examples[&example]);
        let data = srbm_orthant::compute(&net.nodes, &net.links).unwrap();
        let (grid_n, basis_m) = srbm_orthant::recommended_bnalp_grid(data.d);
        let head = format!("{}\n{}\n\n", lp::HEADING, lp::grid_note(true, data.d, grid_n, basis_m));
        assert!(archive[start..].starts_with(&head), "{example}/{method}: heading\n{archive}");
        let mu: Vec<f64> = data.mean_service_times.iter().map(|&t| if t > 0.0 { 1.0 / t } else { 1.0 }).collect();
        let servers = lp::servers_column(&net.nodes);
        let mut rest = &archive[start + head.len()..];
        while let Some(i) = rest.find("\nLinear Program (Saure-Glynn-Zeevi 2008 LP)\n") {
            let solver = &rest[..i + 1];
            let solver = solver.rfind("=====\n").map_or(solver, |j| &solver[j + 6..]);
            let end = ["\n===== ", "Elapsed time: "].iter().filter_map(|m| rest[i + 1..].find(m).map(|k| k + i + 1 + usize::from(m.starts_with('\n')))).min().unwrap();
            assert_eq!(lp::summary(solver, &mu, &servers), rest[i..end], "{example}/{method}");
            checked += 1;
            rest = &rest[end..];
        }
    }
    eprintln!("checked {checked} LP summaries");
}

#[test]
fn every_golden_adaptive_bar_run_ends_with_the_rows_rebuilt_from_its_output() {
    let examples: BTreeMap<String, PathBuf> = common::examples().into_iter().collect();
    let mut checked = 0;
    for (example, method, dir) in runs().into_iter().filter(|r| r.1 == "adaptive_bar") {
        let archive = read(dir.join("archive.txt"));
        let (Some(done), Some(elapsed)) = (archive.find("[done]"), archive.rfind("Elapsed time: ")) else { continue };
        let content = &archive[done + archive[done..].find('\n').unwrap() + 1..elapsed];
        let net = common::network(&examples[&example]);
        let multi = adaptive_bar::multi_server_stations(&net.nodes);
        if !multi.is_empty() {
            assert!(content.ends_with(&format!("{}\n", adaptive_bar::multi_server_note(&multi))), "{example}: note\n{content}");
        } else if let Ok(data) = srbm_orthant::compute(&net.nodes, &net.links) {
            let caps = adaptive_bar::capacities(&data);
            let solver = match content.rfind("\n\n  L_") {
                Some(i) => &content[..i + 1],
                None => content,
            };
            assert_eq!(adaptive_bar::queue_length_rows(solver, &caps), content, "{example}/{method}");
        }
        checked += 1;
    }
    eprintln!("checked {checked} adaptive BAR runs");
}

#[test]
fn every_golden_mlmc_run_prints_the_seeds_and_critical_value_the_port_derives() {
    // The golden settings fix the MLMC seed at its default, 12345 (Settings ▸ mlmc.seed).
    let mut checked = 0;
    for (example, method, dir) in runs().into_iter().filter(|r| r.1 == "mlmc") {
        let script = read(dir.join("script.sh"));
        let archive = read(dir.join("archive.txt"));
        let k: usize = script[script.find("\nK=").unwrap() + 3..].split('\n').next().unwrap().trim().parse().unwrap();
        let seeds = qnet_core::output::mlmc::replication_seeds(12345, k);
        let list = seeds.iter().map(u64::to_string).collect::<Vec<_>>().join(" ");
        assert!(script.contains(&format!("REPLICATION_SEEDS=({list})")), "{example}/{method}: seeds");
        let critical = qnet_core::cfmt::f("%.12g", qnet_core::output::mlmc::critical_95(k));
        assert!(script.contains(&format!("-v critical={critical} ")), "{example}/{method}: critical value");
        if archive.contains("SRBM MLMC (Blanchet-Chen-Glynn-Si)") {
            assert!(archive.contains(&format!("# Replication seeds: {list}\n")), "{example}/{method}: seeds line");
        }
        checked += 1;
    }
    eprintln!("checked {checked} MLMC runs");
}
