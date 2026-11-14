//! The lines a run prints around its table: the thread-count banner first, the network-load
//! (regime) lines and the tractability line above the table, and the elapsed time last.
//!
//! In 0.90.34 each was a `printf` the run wrapper ran (QnetGUIApp.swift `threadCountBanner`,
//! `threadCountBannerMixed`, `regimeHeader`, `tractabilityHeader`, and the
//! `perl -MTime::HiRes … "Elapsed time: %.3fs"` at the end of every command). Under D1 these are
//! plain text functions; the wording and number formats are 0.90.34's (C printf through
//! `cfmt::f`), and `tests/output_table.rs` checks them against every golden archive.
//!
//! One deliberate difference (ANA-082, Changed under D5): the finite-buffer "Buffer regime" line
//! pairs each station's ρ with its capacity K = buffer + servers. 0.90.34 gathered K in document
//! order but ρ in name-suffix order, so for a network drawn out of order the line could name the
//! right station with another station's K (or miss the worst one). Here both are in name-suffix
//! (export) order. The CPU count is a parameter, since the caller knows the machine.

use crate::cfmt;
use crate::model::{Link, Node, NodeKind};
use crate::naming;
use crate::tractability;
use crate::traffic::{self, SrbmData};

/// "[Threads] Using N CPU cores (OpenMP)" for a parallel solver, or "[Threads] Single-threaded
/// (analytical solver)" (`threadCountBanner`), without its newline.
pub fn thread_count_banner(parallel: bool, cpus: usize) -> String {
    if parallel {
        format!("[Threads] Using {cpus} CPU cores (OpenMP)")
    } else {
        "[Threads] Single-threaded (analytical solver)".into()
    }
}

/// The comparison runs' banner (`threadCountBannerMixed`), without its newline.
pub fn thread_count_banner_mixed(cpus: usize) -> String {
    format!("[Threads] {cpus} CPU cores for parallel solvers (Sim/Spectral/FE); analytical solvers (QNA/SBD/LP) are single-threaded")
}

/// "Elapsed time: X.XXXs" for a run of `seconds`, without the two newlines the wrapper printed
/// after it.
pub fn elapsed_line(seconds: f64) -> String {
    format!("Elapsed time: {}s", cfmt::f("%.3f", seconds))
}

/// Each station's capacity K = waiting room of the buffer feeding it + its servers, in the
/// stations' name-suffix (export) order, so entry i belongs to the same station as ρ_i. The
/// buffer is the first buffer node (in document order) with a link into the station; none gives 0.
pub fn station_capacities(nodes: &[Node], links: &[Link]) -> Vec<i64> {
    let stations = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);
    stations
        .iter()
        .map(|station| {
            let b = nodes
                .iter()
                .find(|cand| cand.kind == NodeKind::Buffer && links.iter().any(|l| l.from == cand.id && l.to == station.id))
                .map_or(0, |n| n.buffer_size);
            b + station.servers
        })
        .collect()
}

/// The regime lines (`regimeHeader`) for a network, in 2.0's station order; empty when the station
/// model cannot be built.
pub fn regime_lines(nodes: &[Node], links: &[Link], infinite: bool) -> Vec<String> {
    match traffic::compute(nodes, links, infinite, false, false) {
        Ok(data) => regime_lines_for(&data, infinite, &station_capacities(nodes, links)),
        Err(_) => Vec::new(),
    }
}

/// The regime lines for a computed station model and the stations' capacities (used only for a
/// finite network; a station past the end of `capacities` counts as K = 0, as 0.90.34's array did).
pub fn regime_lines_for(data: &SrbmData, infinite: bool, capacities: &[i64]) -> Vec<String> {
    let d = data.d;
    let mut rhos = vec![0.0; d];
    let mut rho_max = 0.0;
    let mut arg_max = 0;
    for i in 0..d {
        rhos[i] = if data.capacity[i] > 1e-12 { data.alpha[i] / data.capacity[i] } else { 0.0 };
        if rhos[i] > rho_max {
            rho_max = rhos[i];
            arg_max = i;
        }
    }
    let note = if rho_max >= 0.95 {
        "heavy-traffic regime — analytical methods are most accurate here"
    } else if rho_max >= 0.85 {
        "near heavy-traffic — small O(1) deviation expected"
    } else {
        "moderate load — SRBM/FEM are heavy-traffic limits; expect deviation from simulation"
    };
    let mut lines = vec![format!("Network load: rho_max = {} at S{}  ({note})", cfmt::f("%.4f", rho_max), arg_max + 1)];
    if tractability::has_routing_cycles(&data.aggregated_p) {
        lines.push("Routing graph contains feedback (cycle or self-loop) — QNA may degrade under heavy load; use queue-process simulation with confidence intervals as the reference".into());
    }
    if !infinite {
        let ks: Vec<i64> = (0..d).map(|i| capacities.get(i).copied().unwrap_or(0)).collect();
        let mut worst_small: Option<(usize, f64)> = None;
        let mut worst_large: Option<(usize, f64)> = None;
        for i in 0..d {
            if !(rhos[i] >= 0.5) || ks[i] <= 0 {
                continue;
            }
            let ratio = ks[i] as f64 * (1.0 - rhos[i]);
            if ratio < 1.0 {
                if worst_small.is_none_or(|w| ratio < w.1) {
                    worst_small = Some((i, ratio));
                }
            } else if ratio > 10.0 && worst_large.is_none_or(|w| ratio > w.1) {
                worst_large = Some((i, ratio));
            }
        }
        if let Some((i, ratio)) = worst_small {
            lines.push(format!(
                "Buffer regime: K*(1-rho) = {} at S{} (K={}, rho={}) — small for the heavy-traffic limit (target ~1-5); SRBM may overstate E[X] / understate loss by 10-20%",
                cfmt::f("%.2f", ratio),
                i + 1,
                ks[i],
                cfmt::f("%.3f", rhos[i])
            ));
        } else if let Some((i, ratio)) = worst_large {
            lines.push(format!(
                "Buffer regime: K*(1-rho) = {} at S{} (K={}, rho={}) — buffer is effectively infinite at this rho; finite-buffer correction is negligible",
                cfmt::f("%.1f", ratio),
                i + 1,
                ks[i],
                cfmt::f("%.3f", rhos[i])
            ));
        }
    }
    lines
}

/// The tractability line (`tractabilityHeader`) when the network is analytically tractable:
/// "──  <detail>  ──", the detail defaulting to "Analytical product form".
pub fn tractability_line(tractable: bool, detail: &str) -> Option<String> {
    if !tractable {
        return None;
    }
    let detail = if detail.is_empty() { "Analytical product form" } else { detail };
    Some(format!("──  {detail}  ──"))
}

/// The banner block printed between a run's progress and its table: the regime lines, then the
/// tractability line, each ending in a newline (`[regime, hdr].joined(" && ")`).
pub fn table_banner(regime: &[String], tractability: Option<&str>) -> String {
    let mut s = String::new();
    for l in regime.iter().map(String::as_str).chain(tractability) {
        s.push_str(l);
        s.push('\n');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_thread_banners_and_elapsed_line_read_as_before() {
        assert_eq!(thread_count_banner(true, 18), "[Threads] Using 18 CPU cores (OpenMP)");
        assert_eq!(thread_count_banner(false, 18), "[Threads] Single-threaded (analytical solver)");
        assert!(thread_count_banner_mixed(8).starts_with("[Threads] 8 CPU cores for parallel solvers"));
        assert_eq!(elapsed_line(0.0456), "Elapsed time: 0.046s");
    }

    #[test]
    fn the_tractability_line_defaults_its_detail() {
        assert_eq!(tractability_line(true, ""), Some("──  Analytical product form  ──".into()));
        assert_eq!(tractability_line(false, "x"), None);
    }
}
