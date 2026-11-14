//! The SRBM MLMC replication texts: the check each replication's output must pass, the lines the
//! loop prints when one does not, and the aggregator that turns K replications into the
//! per-station queue-length table.
//!
//! In 0.90.34 these were part of the bash command `runExactSim` built (QnetGUIApp.swift): a loop
//! running the solver K times into `BNET_mlmc_out_<pid>.<k>`, a small awk check per replication,
//! and an awk aggregator run over all K files at the end (METH-069…METH-072). Under D1 the runner
//! starts the replications itself and calls these functions on their captured output (SH-085,
//! Changed); the text is 0.90.34's byte for byte, which `tests/output_mlmc.rs` checks by running
//! the original awk programs, extracted from the Swift source, with BWK `/usr/bin/awk`.
//!
//! Two awk details are reproduced because they reach the page: BWK awk stores a computed −0 as 0,
//! so no printed value is "-0.0000"; and the critical value was handed to awk as `%.12g` text, so
//! it is rounded through that spelling here too. `mlmc95Critical` and `mlmcReplicationSeeds`,
//! which choose the critical value and the seeds the text prints, are here as well.

use super::awk::{fields, number as awk_number, records as lines, stored as z};
use crate::cfmt;

/// The two-sided 95% Student-t critical value for K independent replications
/// (`mlmc95Critical`): 1.96 below two, the table up to 30, a third-order expansion beyond.
pub fn critical_95(replications: usize) -> f64 {
    const SMALL: [f64; 29] = [
        12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120,
        2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045,
    ];
    if replications < 2 {
        return 1.96;
    }
    if replications <= 30 {
        return SMALL[replications - 2];
    }
    let degrees = (replications - 1) as f64;
    let z = 1.959963984540054;
    let z2 = z * z;
    let z3 = z2 * z;
    let z5 = z3 * z2;
    let z7 = z5 * z2;
    z + (z3 + z) / (4.0 * degrees)
        + (5.0 * z5 + 16.0 * z3 + 3.0 * z) / (96.0 * degrees * degrees)
        + (3.0 * z7 + 19.0 * z5 + 17.0 * z3 - 15.0 * z) / (384.0 * degrees * degrees * degrees)
}

/// The K top-level seeds derived from a base seed (`mlmcReplicationSeeds`): SplitMix64 steps with
/// the two high bits cleared, plus one.
pub fn replication_seeds(base_seed: i64, count: usize) -> Vec<u64> {
    let mut state = base_seed as u64;
    (0..count)
        .map(|_| {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut v = state;
            v = (v ^ (v >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            v = (v ^ (v >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            v ^= v >> 31;
            (v & 0x3FFF_FFFF_FFFF_FFFF) + 1
        })
        .collect()
}

/// `^  *[0-9]+ +<rest>` where `rest` is a run of `class` characters followed by a space.
fn station_row(line: &str, class: impl Fn(u8) -> bool) -> bool {
    let b = line.as_bytes();
    let mut i = b.iter().take_while(|&&c| c == b' ').count();
    if i == 0 {
        return false;
    }
    let digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    i += digits;
    let spaces = b[i..].iter().take_while(|&&c| c == b' ').count();
    if spaces == 0 {
        return false;
    }
    i += spaces;
    // `[…]+ ` with backtracking: some run of class characters, then a space.
    let run = b[i..].iter().take_while(|&&c| class(c)).count();
    (1..=run).any(|n| b.get(i + n) == Some(&b' '))
}

/// `^[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?$`
fn is_plain_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let int = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
    i += int;
    if int > 0 {
        if b.get(i) == Some(&b'.') {
            i += 1;
            i += b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        }
    } else {
        if b.get(i) != Some(&b'.') {
            return false;
        }
        let frac = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if frac == 0 {
            return false;
        }
        i += 1 + frac;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        if matches!(b.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let e = b[j..].iter().take_while(|c| c.is_ascii_digit()).count();
        if e == 0 {
            return false;
        }
        i = j + e;
    }
    i == b.len()
}

/// The per-replication check: every station 1…expected has exactly one row whose mean, standard
/// error and half-width are plain numbers, and no row names another station.
pub fn replication_output_is_complete(output: &str, expected: usize) -> bool {
    let mut bad = false;
    let mut seen = std::collections::HashMap::<u64, u64>::new();
    for line in lines(output) {
        if !station_row(line, |c| c != b' ') {
            continue;
        }
        let f = fields(line);
        let get = |i: usize| f.get(i - 1).copied().unwrap_or("");
        let idx = awk_number(get(1));
        if !is_plain_number(get(2)) || !is_plain_number(get(3)) || !is_plain_number(get(4)) || idx < 1.0 || idx > expected as f64 {
            bad = true;
            continue;
        }
        let c = seen.entry(idx as u64).or_insert(0);
        if *c > 0 {
            bad = true;
        }
        *c += 1;
    }
    for i in 1..=expected as u64 {
        if seen.get(&i).copied().unwrap_or(0) == 0 {
            bad = true;
        }
    }
    !bad
}

/// "SRBM MLMC replication k failed with status RC." (followed by the replication's stderr).
pub fn replication_failed_line(k: usize, status: i32) -> String {
    format!("SRBM MLMC replication {k} failed with status {status}.")
}

/// The line printed (with exit status 65) when a replication's station rows are incomplete.
pub fn replication_malformed_line(k: usize, expected: usize) -> String {
    format!("SRBM MLMC replication {k} returned incomplete or malformed station output (expected {expected} rows).")
}

/// The heading over a successful replication's non-empty stderr.
pub fn replication_diagnostics_line(k: usize) -> String {
    format!("SRBM MLMC replication {k} diagnostics:")
}

/// The aggregator's report over the K replications' outputs (in replication order; None for a
/// file that could not be read), with each station's effective service rate μ_i = 1/τ_i, the K
/// seeds, and the critical value ([`critical_95`]).
pub fn aggregate(outputs: &[Option<&str>], mu_eff: &[f64], seeds: &[u64], critical: f64) -> String {
    let k_count = outputs.len();
    let kf = k_count as f64;
    let critical = awk_number(&cfmt::f("%.12g", critical));
    let seeds_text = seeds.iter().map(u64::to_string).collect::<Vec<_>>().join(" ");
    let mu = |i: usize| mu_eff.get(i - 1).map_or(0.0, |&m| awk_number(&cfmt::f("%.17g", m)));
    let mut out = String::from("SRBM MLMC (Blanchet-Chen-Glynn-Si)\n==============================================\n");

    let mut actual_n: Vec<String> = vec![String::new(); k_count + 1];
    let mut stop: Vec<&str> = vec![""; k_count + 1];
    let (mut adaptive_runs, mut adaptive_unmet) = (0u64, 0u64);
    let mut total_gauss = 0.0f64;
    let mut sum_w = std::collections::HashMap::<u64, f64>::new();
    let mut sum_w2 = std::collections::HashMap::<u64, f64>::new();
    let mut run_w = std::collections::HashMap::<(usize, u64), f64>::new();
    let mut run_se = std::collections::HashMap::<(usize, u64), f64>::new();
    let mut d = 0u64;
    for (ki, text) in outputs.iter().enumerate() {
        let k = ki + 1;
        let Some(text) = text else { continue };
        for line in lines(text) {
            if line.starts_with("# Dimension:") && k == 1 {
                out.push_str(line);
                out.push('\n');
                continue;
            }
            if line.starts_with("# gamma=") {
                if k == 1 {
                    out.push_str(line);
                    out.push('\n');
                }
                for f in fields(line) {
                    if let Some(n) = f.strip_prefix("N=") {
                        actual_n[k] = n.to_string();
                    }
                }
                continue;
            }
            if line.starts_with("# backend=") && k == 1 {
                out.push_str(line);
                out.push('\n');
                continue;
            }
            if line.starts_with("# antithetic") {
                if k == 1 {
                    out.push_str(line);
                    out.push('\n');
                }
                if line.contains("adaptive=on") {
                    adaptive_runs += 1;
                    if line.contains("stop=SE target achieved") {
                        stop[k] = "precision-met";
                    } else {
                        stop[k] = "cap-reached";
                        adaptive_unmet += 1;
                    }
                } else {
                    stop[k] = "fixed-count";
                }
                continue;
            }
            if line.starts_with("# Total Gaussian") {
                let last = line.rfind(' ').map_or(line, |i| &line[i + 1..]);
                total_gauss += awk_number(last);
                continue;
            }
            if station_row(line, |c| c.is_ascii_digit() || matches!(c, b'-' | b'.' | b'e' | b'E' | b'+')) {
                let f = fields(line);
                let get = |i: usize| awk_number(f.get(i - 1).copied().unwrap_or(""));
                let idx = get(1) as u64;
                let w = get(2);
                *sum_w.entry(idx).or_insert(0.0) += w;
                *sum_w2.entry(idx).or_insert(0.0) += w * w;
                run_w.insert((k, idx), w);
                run_se.insert((k, idx), get(3));
                if idx > d {
                    d = idx;
                }
            }
        }
    }
    out.push_str(&format!("# Replications: {k_count} (independent top-level streams)\n"));
    out.push_str(&format!("# Replication seeds: {seeds_text}\n"));
    for k in 1..=k_count {
        let seed = seeds.get(k - 1).map(u64::to_string).unwrap_or_default();
        out.push_str(&format!("# Replication {k}: seed={seed} N={} stop={}\n", actual_n[k], stop[k]));
    }
    out.push_str("#\n");
    out.push_str("\nPer-Station Mean Queue Length (L_i = mu_i * E[Y_i]):\n");
    let iw = d.to_string().len();
    let mut sumq = 0.0;
    for i in 1..=d {
        let m = sum_w.get(&i).copied().unwrap_or(0.0) / kf;
        let mut var = if k_count >= 2 { (sum_w2.get(&i).copied().unwrap_or(0.0) - kf * m * m) / (kf - 1.0) } else { 0.0 };
        if var < 0.0 {
            var = 0.0;
        }
        let se = if k_count >= 2 { (var / kf).sqrt() } else { run_se.get(&(1, i)).copied().unwrap_or(0.0) };
        let mu_i = mu(i as usize);
        let l = m * mu_i;
        out.push_str(&format!(
            "  L_{i:0iw$} = {}  ± {} (95%)    (workload E[Y_{i:0iw$}] = {} ± {}, mu_i = {})\n",
            cfmt::f("%10.4f", z(l)),
            cfmt::f("%7.4f", z(critical * se * mu_i)),
            cfmt::f("%7.4f", z(m)),
            cfmt::f("%6.4f", z(critical * se)),
            cfmt::f("%.4f", z(mu_i)),
        ));
        sumq += l;
    }
    let avgq = if d > 0 { sumq / d as f64 } else { 0.0 };
    if k_count >= 2 && d > 0 {
        let (mut sum_avg, mut sum_avg2) = (0.0, 0.0);
        for k in 1..=k_count {
            let mut avg_run = 0.0;
            for i in 1..=d {
                avg_run += mu(i as usize) * run_w.get(&(k, i)).copied().unwrap_or(0.0);
            }
            avg_run /= d as f64;
            sum_avg += avg_run;
            sum_avg2 += avg_run * avg_run;
        }
        let mut avg_var = (sum_avg2 - kf * (sum_avg / kf) * (sum_avg / kf)) / (kf - 1.0);
        if avg_var < 0.0 {
            avg_var = 0.0;
        }
        let avg_se = (avg_var / kf).sqrt();
        out.push_str(&format!(
            "\nAverage queue length: {}  ± {} (95% across independent replications)\n",
            cfmt::f("%.4f", z(avgq)),
            cfmt::f("%.4f", z(critical * avg_se))
        ));
    } else {
        out.push_str(&format!(
            "\nAverage queue length: {} (no joint CI: one run does not identify cross-station covariance)\n",
            cfmt::f("%.4f", z(avgq))
        ));
    }
    // `%lld` of an awk number: BWK awk converts it to an integer by truncation.
    out.push_str(&format!("Total Gaussian RVs (summed over replications): {}\n", total_gauss as i64));
    if adaptive_runs > 0 {
        out.push_str(&format!(
            "QNET_MLMC_STATUS_V1 adaptive=yes precision_met={} cap_hits={adaptive_unmet}\n",
            if adaptive_unmet > 0 { "no" } else { "yes" }
        ));
    } else {
        out.push_str("QNET_MLMC_STATUS_V1 adaptive=no precision_met=na cap_hits=0\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_critical_value_follows_the_table_and_the_expansion() {
        assert_eq!(critical_95(1), 1.96);
        assert_eq!(critical_95(2), 12.706);
        assert_eq!(critical_95(30), 2.045);
        assert!((critical_95(31) - 2.042).abs() < 1e-3);
    }

    #[test]
    fn seeds_are_splitmix_steps_with_the_high_bits_clear() {
        let s = replication_seeds(42, 3);
        assert_eq!(s.len(), 3);
        assert!(s.iter().all(|&v| v >= 1 && v <= 0x4000_0000_0000_0000));
        assert_ne!(s[0], s[1]);
    }

    #[test]
    fn a_replication_missing_a_station_is_incomplete() {
        let ok = "# x\n  1  0.5  0.01  0.02\n  2  1.5  0.01  0.02\n";
        assert!(replication_output_is_complete(ok, 2));
        assert!(!replication_output_is_complete(ok, 3));
        assert!(!replication_output_is_complete("  1  nan  0.01  0.02\n  2  1  1  1\n", 2));
    }
}
