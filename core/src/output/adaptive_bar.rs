//! Adaptive low-rank BAR's queue-length rows: the solver reports workload means E[Z_i], and the
//! run appends `L_i = μ_i·E[Z_i]` rows for single-server networks, or a sentence saying why it
//! does not for a network with a multi-server station (METH-088).
//!
//! In 0.90.34 `runAdaptiveLowRankBAR` (QnetGUIApp.swift) piped the solver through a one-line awk
//! program (`{print}` plus the rows at the end) or followed it with `printf '%s\n' <note>`. Under
//! D1 the runner calls [`queue_length_rows`] or [`multi_server_note`] on the captured output
//! instead (RUN-066, Changed); the bytes are the awk's, checked against that awk program in
//! `tests/output_adaptive_bar.rs`. As in BWK awk, the product μ_i·E[Z_i] never prints as −0 while
//! the workload, copied straight from the solver's field, keeps its sign.

use super::awk::{number as awk_number, records};
use crate::cfmt;
use crate::export::srbm_orthant::OrthantData;
use crate::model::{Node, NodeKind};

/// Each station's total capacity c_i = 1/τ_i (1 where τ_i is not positive), in export order, as the
/// run handed them to awk (`%.17g`, which round-trips).
pub fn capacities(data: &OrthantData) -> Vec<f64> {
    data.mean_service_times.iter().map(|&tau| if tau > 0.0 { 1.0 / tau } else { 1.0 }).collect()
}

/// The names of the stations with more than one server, in document order; when there are any,
/// the run prints [`multi_server_note`] instead of the rows.
pub fn multi_server_stations(nodes: &[Node]) -> Vec<String> {
    nodes.iter().filter(|n| n.kind == NodeKind::Station && n.servers > 1).map(|n| n.name.clone()).collect()
}

/// The sentence printed after the solver's output when queue lengths are not derived, without its
/// newline.
pub fn multi_server_note(names: &[String]) -> String {
    let verb = if names.len() == 1 { "has" } else { "have" };
    format!(
        "  Queue lengths not derived: {} {verb} more than one server, and the workload-to-queue identity used for single-server stations is only asymptotic in heavy traffic when c > 1. The workload means above are the solver's own output.",
        names.join(", ")
    )
}

/// The solver's output passed through line by line, then, when it reported any `E[Z_i] = …` row for
/// a station 1…n, a blank line and one `  L_i = …    (workload E[Z_i] = …, mu_i = …)` row per
/// station up to the highest reported; indices are zero-padded to the digits of n.
pub fn queue_length_rows(solver_output: &str, capacities: &[f64]) -> String {
    let n = capacities.len();
    let w = n.to_string().len();
    let m: Vec<f64> = capacities.iter().map(|c| awk_number(&cfmt::f("%.17g", *c))).collect();
    let mut out = String::new();
    let mut q = std::collections::HashMap::<usize, f64>::new();
    let mut z = std::collections::HashMap::<usize, f64>::new();
    let mut d = 0usize;
    for line in records(solver_output) {
        out.push_str(line);
        out.push('\n');
        // /^E\[Z_[0-9]+\] =/
        let Some(rest) = line.strip_prefix("E[Z_") else { continue };
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || !rest[digits..].starts_with("] =") {
            continue;
        }
        let fields: Vec<&str> = line.split([' ', '\t']).filter(|s| !s.is_empty()).collect();
        let s: String = fields[0].chars().filter(char::is_ascii_digit).collect();
        let i = awk_number(&s);
        if i >= 1.0 && i <= n as f64 {
            let i = i as usize;
            let v = awk_number(fields.get(2).copied().unwrap_or(""));
            let product = v * m[i - 1];
            q.insert(i, if product == 0.0 { 0.0 } else { product });
            z.insert(i, v);
            d = d.max(i);
        }
    }
    if d > 0 {
        out.push('\n');
        for i in 1..=d {
            let (qi, zi) = (q.get(&i).copied().unwrap_or(0.0), z.get(&i).copied().unwrap_or(0.0));
            let ui = if q.contains_key(&i) { m[i - 1] } else { 0.0 };
            out.push_str(&format!(
                "  L_{i:0w$} = {}    (workload E[Z_{i:0w$}] = {}, mu_i = {})\n",
                cfmt::f("%.6f", qi),
                cfmt::f("%.6f", zi),
                cfmt::f("%.6f", ui)
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_follow_the_solver_output() {
        let out = queue_length_rows("x\nE[Z_2] = 1.5\n", &[2.0, 4.0]);
        assert_eq!(
            out,
            "x\nE[Z_2] = 1.5\n\n  L_1 = 0.000000    (workload E[Z_1] = 0.000000, mu_i = 0.000000)\n  L_2 = 6.000000    (workload E[Z_2] = 1.500000, mu_i = 4.000000)\n"
        );
    }

    #[test]
    fn the_note_agrees_in_number() {
        assert!(multi_server_note(&["S1".into()]).contains("S1 has more"));
        assert!(multi_server_note(&["S1".into(), "S2".into()]).contains("S1, S2 have more"));
    }
}
