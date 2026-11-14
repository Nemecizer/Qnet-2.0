//! The Linear Program run's text (METH-077): its two opening lines and the per-stage summary
//! table it prints after the solver's own output.
//!
//! In 0.90.34 `runLinearProgram` (QnetGUIApp.swift) printed the opening lines with `printf` and,
//! after each stage's solver run, `printf '\n'` and the awk program `lpSummaryAwk` built, reading
//! the stage's tee'd output with the station rates (`$MU`, `%.17g`) and server counts (`$SERVERS`).
//! Under D1 these are text functions the runner calls (RUN-066, Changed); `tests/output_lp.rs`
//! runs the original awk program (extracted from the Swift source) as the oracle. LP keeps its own
//! table rather than the shared comparison table, as in 0.90.34.

use super::awk::{fields, left, number, records, stored};
use crate::cfmt;
use crate::model::{Node, NodeKind};

/// The run's first line.
pub const HEADING: &str = "Running Linear Program (BNAlp, Saure-Glynn-Zeevi 2008)";

/// The grid note printed under the heading (followed by a blank line): the automatic grid for
/// dimension d, or the sizes the user set.
pub fn grid_note(auto: bool, d: usize, grid_n: i64, basis_m: i64) -> String {
    if auto {
        format!("auto-scaled for d={d}: grid_n={grid_n}, basis_m={basis_m}")
    } else {
        format!("user-set: grid_n={grid_n}, basis_m={basis_m}")
    }
}

/// The label printed as "===== <label> =====" above each stage of a multi-level run.
pub fn stage_label(refined: bool, grid_n: i64) -> String {
    if refined {
        format!("REFINED RUN (grid_n = {grid_n})")
    } else {
        format!("COARSE PREVIEW (grid_n = {grid_n})")
    }
}

/// The Servers column's values (`$SERVERS`): each station's server count, ordered by 0.90.34's
/// `stationIndex`, which drops trailing letters and underscores and reads what is left as a whole
/// integer. For the usual names ("S1") that reading fails and every key is 0, so the stable sort
/// leaves the stations in document order, not in the S1…Sn order of the rows beside them. Kept as
/// it was: no ledger row changes it.
pub fn servers_column(nodes: &[Node]) -> Vec<i64> {
    fn station_index(name: &str) -> i64 {
        let s = name.trim_end_matches(|c: char| c.is_alphabetic() || c == '_');
        let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return 0;
        }
        s.parse().unwrap_or(0)
    }
    let mut stations: Vec<&Node> = nodes.iter().filter(|n| n.kind == NodeKind::Station).collect();
    stations.sort_by_key(|n| station_index(&n.name));
    stations.iter().map(|n| n.servers).collect()
}

/// The summary printed after one stage: a blank line, then the table `lpSummaryAwk` built from
/// the stage's output, with each station's effective service rate μ_i = 1/τ_i and its servers
/// (station order; a station past the end of `servers` counts one server).
pub fn summary(stage_output: &str, mu_eff: &[f64], servers: &[i64]) -> String {
    let mu = |i: usize| mu_eff.get(i - 1).map_or(0.0, |m| number(&cfmt::f("%.17g", *m)));
    let (mut solver_line, mut solver_name, mut total_s, mut grid_n, mut basis_m, mut build_line) =
        (String::new(), String::new(), String::new(), String::new(), String::new(), String::new());
    let mut workloads = std::collections::HashMap::<u64, f64>::new();
    let mut d = 0u64;
    for rec in records(stage_output) {
        let f = fields(rec);
        let last = f.last().copied().unwrap_or("");
        if rec.starts_with("[Solve] Optimal") {
            solver_line = rec.to_string();
        } else if rec.starts_with("[Solve] Using solver:") {
            solver_name = last.to_string();
        } else if rec.starts_with("[Total]") {
            total_s = format!("{}s", f.get(1).copied().unwrap_or(""));
        } else if rec.starts_with("  grid_n") {
            grid_n = last.to_string();
        } else if rec.starts_with("  basis_m") {
            basis_m = last.to_string();
        } else if rec.starts_with("[Build LP]") {
            build_line = rec.to_string();
        } else if let Some(rest) = rec.strip_prefix("E[X_") {
            // /^E\[X_[0-9]+\] = /
            let n = rest.bytes().take_while(u8::is_ascii_digit).count();
            if n > 0 && rest[n..].starts_with("] = ") {
                let first = f[0];
                let start = first.find(|c: char| c.is_ascii_digit()).unwrap();
                let len = first[start..].bytes().take_while(u8::is_ascii_digit).count();
                let idx = number(&first[start..start + len]) as u64;
                workloads.insert(idx, stored(number(last)));
                d = d.max(idx);
            }
        }
    }
    let mut out = String::from("\n");
    out.push_str("Linear Program (Saure-Glynn-Zeevi 2008 LP)\n");
    out.push_str("==========================================\n\n");
    out.push_str(&format!("Solver: {solver_name}  |  grid_n = {grid_n}  |  basis_m = {basis_m}\n"));
    if !build_line.is_empty() {
        out.push_str(&format!("{build_line}\n"));
    }
    if !solver_line.is_empty() {
        out.push_str(&format!("{solver_line}\n"));
    }
    if !total_s.is_empty() {
        out.push_str(&format!("[Total] {total_s}\n"));
    }
    out.push_str(&format!(
        "\n{} {} {} {} {}\n",
        left("Node", 6),
        left("Servers", 8),
        left("E[Y] (workload)", 16),
        left("L = mu·E[Y]", 16),
        left("mu_i", 10)
    ));
    let mut sum_l = 0.0;
    for i in 1..=d {
        let mu_i = stored(mu(i as usize));
        let sv = servers.get(i as usize - 1).copied().unwrap_or(1);
        let w = workloads.get(&i).copied().unwrap_or(0.0);
        let l = stored(w * mu_i);
        out.push_str(&format!(
            "{} {} {} {} {}\n",
            left(&i.to_string(), 6),
            left(&sv.to_string(), 8),
            left(&cfmt::f("%.4f", w), 16),
            left(&cfmt::f("%.4f", l), 16),
            left(&cfmt::f("%.4f", mu_i), 10)
        ));
        sum_l = stored(sum_l + l);
    }
    out.push_str("\nNetwork Totals:\n");
    if d > 0 {
        out.push_str(&format!("  Total E[N]:             {}\n", cfmt::f("%.4f", sum_l)));
        out.push_str(&format!("  Average queue length:   {}\n", cfmt::f("%.4f", stored(sum_l / d as f64))));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_scales_workload_by_the_service_rate() {
        let s = summary("[Solve] Using solver: highs\nE[X_1] = 0.5\n", &[2.0], &[1]);
        assert!(s.contains("Solver: highs  |  grid_n =   |  basis_m = \n"), "{s}");
        assert!(s.contains("1      1        0.5000           1.0000           2.0000    \n"), "{s}");
        assert!(s.ends_with("  Total E[N]:             1.0000\n  Average queue length:   1.0000\n"));
    }
}
