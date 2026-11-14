//! The two sweep reports: the test set's accuracy table (METH-143, TEST-015, TEST-016) and the
//! spectral-convergence table (METH-149, TEST-027).
//!
//! In 0.90.34 `testSetAggregatorAwk` and `spectralConvergenceAggregatorAwk` (QnetGUIApp.swift)
//! generated POSIX awk programs that ran over every `out_<case>_<algo>.txt` (or
//! `out_<case>_r<ρ>_<algo>.txt`) a sweep left in its work folder. Under D1 the runner hands these
//! functions the files' names and contents instead (RUN-066, Changed); the text is the awk's,
//! checked against the Swift-generated programs in `tests/output_aggregate.rs`.
//!
//! The files are taken in the order given, which should be the byte order of their names (what
//! the shell's `out_*.txt` glob gave under the C locale). The test-set table does not depend on
//! that order. The convergence table sums each ρ's case errors in the order awk visited its
//! `cases` array, which [`awk::for_in_order`] reproduces.

use std::collections::HashMap;

use crate::cfmt;
use super::awk::{self, fields, left, number, records, rel, right, stored};

/// One output file of a sweep: its file name (`out_3_QNA.txt`; any folder part is ignored) and
/// the text the solver wrote.
#[derive(Debug, Clone)]
pub struct SweepFile {
    pub name: String,
    pub text: String,
}

/// `sub(/.*\/out_/, "", nm); sub(/\.txt$/, "", nm); split(nm, parts, "_")`.
fn name_parts(name: &str) -> Vec<String> {
    let mut nm = match name.rfind("/out_") {
        Some(i) => &name[i + 5..],
        None => name,
    };
    if let Some(s) = nm.strip_suffix(".txt") {
        nm = s;
    }
    nm.split('_').map(str::to_string).collect()
}

/// awk's subscript text for a number: an integer prints as an integer.
fn key(x: f64) -> String {
    if x == x.trunc() && x.abs() < 1e16 {
        format!("{}", x as i64)
    } else {
        cfmt::f("%.6g", x)
    }
}

/// `E[<var>_<digits>]` → the digits' value.
fn station_of(f1: &str, var: &str) -> Option<f64> {
    let rest = f1.strip_prefix("E[")?.strip_prefix(var)?.strip_prefix('_')?;
    let digits = rest.strip_suffix(']')?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| number(digits))
}

/// Ascending insertion sort with awk's comparison; returns (mean, P50, P90, max) of `v`.
fn summary(v: &[f64]) -> (f64, f64, f64, f64) {
    let mut s = v.to_vec();
    for i in 1..s.len() {
        let x = s[i];
        let mut j = i;
        while j >= 1 && rel(s[j - 1], x) > 0 {
            s[j] = s[j - 1];
            j -= 1;
        }
        s[j] = x;
    }
    let cn = s.len();
    let mut mean = 0.0;
    for x in &s {
        mean = stored(mean + x);
    }
    mean = stored(mean / cn as f64);
    let idx = |p: f64| (((cn - 1) as f64 * p + 1.5) as usize).min(cn);
    (mean, s[idx(0.50) - 1], s[idx(0.90) - 1], s[cn - 1])
}

/// The test set's accuracy table: per-case mean abs % error of E[<var>_k] against the reference
/// algorithm, summarised per algorithm (in `algo_order`, the reference skipped), then the
/// ensemble row, the reference row and the footnote.
pub fn test_set_table(files: &[SweepFile], var: &str, algo_order: &[&str], reference: &str) -> String {
    let mut eq: HashMap<(String, String, u64), f64> = HashMap::new();
    let mut nstn: HashMap<String, f64> = HashMap::new();
    let mut seen_case: Vec<String> = Vec::new();
    let (mut cur_case, mut cur_algo) = (String::new(), String::new());
    for f in files {
        for (fnr, rec) in records(&f.text).into_iter().enumerate() {
            if fnr == 0 {
                let parts = name_parts(&f.name);
                cur_case = key(number(parts.first().map_or("", String::as_str)));
                cur_algo = parts.get(1).cloned().unwrap_or_default();
                if !seen_case.contains(&cur_case) {
                    seen_case.push(cur_case.clone());
                }
            }
            let fl = fields(rec);
            if fl.len() >= 2 && fl[1] == "=" {
                if let Some(k) = station_of(fl[0], var) {
                    eq.insert((cur_case.clone(), cur_algo.clone(), k as u64), stored(number(fl.get(2).copied().unwrap_or(""))));
                    let n = nstn.entry(cur_case.clone()).or_insert(0.0);
                    if rel(k, *n) > 0 {
                        *n = k;
                    }
                }
            }
        }
    }
    let have = |t: &str, a: &str, k: u64| eq.contains_key(&(t.to_string(), a.to_string(), k));
    let val = |t: &str, a: &str, k: u64| eq.get(&(t.to_string(), a.to_string(), k)).copied().unwrap_or(0.0);
    let n_algos = algo_order.len();
    let avg_idx = n_algos + 1;
    let mut case_err: Vec<Vec<f64>> = vec![Vec::new(); n_algos + 2];
    let mut worst: Vec<f64> = vec![0.0; n_algos + 2];
    let pct_of = |av: f64, rv: f64| {
        let mut d = stored(av - rv);
        if rel(d, 0.0) < 0 {
            d = stored(-d);
        }
        stored(d / (if rel(rv, 0.0) > 0 { rv } else { stored(-rv) }) * 100.0)
    };
    let nonzero = |rv: f64| rel(rv, 1e-9) > 0 || rel(rv, -1e-9) < 0;
    for t in awk::for_in_order(&seen_case) {
        if !have(&t, reference, 1) {
            continue;
        }
        let n = nstn.get(&t).copied().unwrap_or(0.0);
        if rel(n, 1.0) < 0 {
            continue;
        }
        let n = n as u64;
        for (a, algo) in algo_order.iter().enumerate() {
            let a = a + 1;
            if *algo == reference {
                continue;
            }
            let (mut sum, mut cnt) = (0.0, 0u64);
            for k in 1..=n {
                if have(&t, reference, k) && have(&t, algo, k) {
                    let (rv, av) = (val(&t, reference, k), val(&t, algo, k));
                    if nonzero(rv) {
                        let pct = pct_of(av, rv);
                        sum = stored(sum + pct);
                        cnt += 1;
                        if rel(pct, worst[a]) > 0 {
                            worst[a] = pct;
                        }
                    }
                }
            }
            if cnt > 0 {
                case_err[a].push(stored(sum / cnt as f64));
            }
        }
        let (mut sum_avg, mut cnt_avg) = (0.0, 0u64);
        for k in 1..=n {
            if !have(&t, reference, k) {
                continue;
            }
            let rv = val(&t, reference, k);
            if !nonzero(rv) {
                continue;
            }
            let (mut ssum, mut scnt) = (0.0, 0u64);
            for algo in algo_order {
                if *algo == reference {
                    continue;
                }
                if have(&t, algo, k) {
                    ssum = stored(ssum + val(&t, algo, k));
                    scnt += 1;
                }
            }
            if scnt > 0 {
                let pct = pct_of(stored(ssum / scnt as f64), rv);
                sum_avg = stored(sum_avg + pct);
                cnt_avg += 1;
                if rel(pct, worst[avg_idx]) > 0 {
                    worst[avg_idx] = pct;
                }
            }
        }
        if cnt_avg > 0 {
            case_err[avg_idx].push(stored(sum_avg / cnt_avg as f64));
        }
    }
    let dash = |label: &str, n: usize| {
        format!(
            "{}  {}  {}  {}  {}  {}  {n:>5}\n",
            left(label, 22),
            right("—", 10),
            right("—", 8),
            right("—", 8),
            right("—", 8),
            right("—", 12)
        )
    };
    let row = |label: &str, errs: &[f64], ws: f64| {
        let (mean, p50, p90, mx) = summary(errs);
        format!(
            "{}  {}%  {}%  {}%  {}%  {}%  {:>5}\n",
            left(label, 22),
            cfmt::f("%9.2f", mean),
            cfmt::f("%7.2f", p50),
            cfmt::f("%7.2f", p90),
            cfmt::f("%7.2f", mx),
            cfmt::f("%11.2f", ws),
            errs.len()
        )
    };
    let mut out = String::from("\n");
    out.push_str(&format!(
        "{}  {}  {}  {}  {}  {}  {}\n",
        left("Algorithm", 22),
        right("Mean %err", 10),
        right("P50", 8),
        right("P90", 8),
        right("Max", 8),
        right("Worst station", 12),
        right("N", 5)
    ));
    out.push_str(&"─".repeat(90));
    out.push('\n');
    for (a, algo) in algo_order.iter().enumerate() {
        if *algo == reference {
            continue;
        }
        if case_err[a + 1].is_empty() {
            out.push_str(&dash(algo, 0));
        } else {
            out.push_str(&row(algo, &case_err[a + 1], worst[a + 1]));
        }
    }
    if case_err[avg_idx].is_empty() {
        out.push_str(&dash("Average of Algorithms", 0));
    } else {
        out.push_str(&row("Average of Algorithms", &case_err[avg_idx], worst[avg_idx]));
    }
    let ref_n = seen_case.iter().filter(|t| have(t, reference, 1)).count();
    out.push_str(&dash(&format!("{reference} (ref)"), ref_n));
    out.push('\n');
    out.push_str("All numeric columns are percent errors.  Per case, err = mean over\n");
    out.push_str(&format!("stations of |algo_k - ref_k| / |ref_k| * 100%, with ref = {reference}.\n"));
    out.push_str("Mean = average across cases; P50 / P90 = 50th / 90th percentile;\n");
    out.push_str("Max = single worst case; N = cases that contributed to the row.\n");
    out.push_str("Worst station = the single largest |algo_k - ref_k|/|ref_k|*100 seen at\n");
    out.push_str("any station in any case (highlights where this algorithm struggles).\n");
    out.push_str("Average of Algorithms: per case and per station, the unweighted mean\n");
    out.push_str("of every non-reference algorithm cell, then the same error summary.\n");
    out.push_str(&"═".repeat(90));
    out.push('\n');
    out
}

/// The spectral-convergence table: for each ρ of the sweep, the mean (and Spectral's largest)
/// per-case abs % error of E[Q_k] against Sim for Spectral, QNA and their per-station average.
pub fn spectral_convergence_table(files: &[SweepFile], rho_values: &[f64]) -> String {
    let rho_list: Vec<f64> = rho_values.iter().map(|r| number(&cfmt::f("%.6f", *r))).collect();
    let n_rho = rho_list.len();
    let mut val: HashMap<(String, u64, String, u64), f64> = HashMap::new();
    let mut nstn: HashMap<(String, u64), f64> = HashMap::new();
    let mut cases: Vec<String> = Vec::new();
    let (mut cur_case, mut cur_rho, mut cur_algo) = (String::new(), 0u64, String::new());
    for f in files {
        for (fnr, rec) in records(&f.text).into_iter().enumerate() {
            if fnr == 0 {
                let parts = name_parts(&f.name);
                cur_case = key(number(parts.first().map_or("", String::as_str)));
                let rtok = parts.get(1).map_or("", String::as_str);
                cur_rho = number(rtok.strip_prefix('r').unwrap_or(rtok)) as u64;
                cur_algo = parts.get(2).cloned().unwrap_or_default();
            }
            let fl = fields(rec);
            if fl.len() >= 2 && fl[1] == "=" {
                if let Some(k) = station_of(fl[0], "Q") {
                    val.insert((cur_case.clone(), cur_rho, cur_algo.clone(), k as u64), stored(number(fl.get(2).copied().unwrap_or(""))));
                    let n = nstn.entry((cur_case.clone(), cur_rho)).or_insert(0.0);
                    if rel(k, *n) > 0 {
                        *n = k;
                    }
                    cases.push(cur_case.clone());
                }
            }
        }
    }
    let have = |c: &str, ri: u64, a: &str, k: u64| val.contains_key(&(c.to_string(), ri, a.to_string(), k));
    let get = |c: &str, ri: u64, a: &str, k: u64| val.get(&(c.to_string(), ri, a.to_string(), k)).copied().unwrap_or(0.0);
    let nonzero = |rv: f64| rel(rv, 1e-9) > 0 || rel(rv, -1e-9) < 0;
    let pct_of = |av: f64, rv: f64| {
        let mut d = stored(av - rv);
        if rel(d, 0.0) < 0 {
            d = stored(-d);
        }
        stored(d / (if rel(rv, 0.0) > 0 { rv } else { stored(-rv) }) * 100.0)
    };
    let mut err_sum: HashMap<(u64, &str), f64> = HashMap::new();
    let mut err_n: HashMap<(u64, &str), f64> = HashMap::new();
    let mut err_max: HashMap<(u64, &str), f64> = HashMap::new();
    for c in awk::for_in_order(&cases) {
        for ri in 0..n_rho as u64 {
            let n = nstn.get(&(c.clone(), ri)).copied().unwrap_or(0.0);
            if rel(n, 1.0) < 0 || !have(&c, ri, "Sim", 1) {
                continue;
            }
            let n = n as u64;
            for algo in ["Spectral", "QNA"] {
                let (mut sum, mut cnt) = (0.0, 0u64);
                for k in 1..=n {
                    if have(&c, ri, "Sim", k) && have(&c, ri, algo, k) {
                        let rv = get(&c, ri, "Sim", k);
                        if nonzero(rv) {
                            sum = stored(sum + pct_of(get(&c, ri, algo, k), rv));
                            cnt += 1;
                        }
                    }
                }
                if cnt > 0 {
                    let ce = stored(sum / cnt as f64);
                    let s = err_sum.entry((ri, algo)).or_insert(0.0);
                    *s = stored(*s + ce);
                    *err_n.entry((ri, algo)).or_insert(0.0) += 1.0;
                    let m = err_max.entry((ri, algo)).or_insert(0.0);
                    if rel(ce, *m) > 0 {
                        *m = ce;
                    }
                }
            }
            let (mut sum_avg, mut cnt_avg) = (0.0, 0u64);
            for k in 1..=n {
                if !have(&c, ri, "Sim", k) {
                    continue;
                }
                let rv = get(&c, ri, "Sim", k);
                if !nonzero(rv) {
                    continue;
                }
                let (mut ssum, mut scnt) = (0.0, 0u64);
                for algo in ["Spectral", "QNA"] {
                    if have(&c, ri, algo, k) {
                        ssum = stored(ssum + get(&c, ri, algo, k));
                        scnt += 1;
                    }
                }
                if scnt > 0 {
                    sum_avg = stored(sum_avg + pct_of(stored(ssum / scnt as f64), rv));
                    cnt_avg += 1;
                }
            }
            if cnt_avg > 0 {
                let ce = stored(sum_avg / cnt_avg as f64);
                let s = err_sum.entry((ri, "Avg")).or_insert(0.0);
                *s = stored(*s + ce);
                *err_n.entry((ri, "Avg")).or_insert(0.0) += 1.0;
            }
        }
    }
    let mut out = String::from("\n");
    out.push_str(&format!(
        "{}  {}  {}  {}  {}  {}\n",
        left("ρ", 7),
        right("Spectral mean", 14),
        right("Spectral max", 12),
        right("QNA mean", 12),
        right("Avg-algos mean", 14),
        right("N", 5)
    ));
    out.push_str(&"─".repeat(83));
    out.push('\n');
    for ri in 0..n_rho as u64 {
        let g = |m: &HashMap<(u64, &str), f64>, a: &str| m.get(&(ri, a)).copied().unwrap_or(0.0);
        let (sn, qn, an) = (g(&err_n, "Spectral"), g(&err_n, "QNA"), g(&err_n, "Avg"));
        let rho = cfmt::f("%-7.3f", rho_list[ri as usize]);
        if sn == 0.0 && qn == 0.0 && an == 0.0 {
            out.push_str(&format!("{rho}  {}  {}  {}  {}  {:>5}\n", right("—", 14), right("—", 12), right("—", 12), right("—", 14), 0));
            continue;
        }
        let sm = if sn > 0.0 { stored(g(&err_sum, "Spectral") / sn) } else { 0.0 };
        let smax = if sn > 0.0 { g(&err_max, "Spectral") } else { 0.0 };
        let qm = if qn > 0.0 { stored(g(&err_sum, "QNA") / qn) } else { 0.0 };
        let am = if an > 0.0 { stored(g(&err_sum, "Avg") / an) } else { 0.0 };
        let mut nmax = sn;
        if qn > nmax {
            nmax = qn;
        }
        if an > nmax {
            nmax = an;
        }
        out.push_str(&format!(
            "{rho}  {}%  {}%  {}%  {}%  {:>5}\n",
            cfmt::f("%13.2f", sm),
            cfmt::f("%11.2f", smax),
            cfmt::f("%11.2f", qm),
            cfmt::f("%13.2f", am),
            nmax as i64
        ));
    }
    out.push('\n');
    out.push_str("Each row: per-case mean abs % error of E[Q_k] vs Sim, averaged across\n");
    out.push_str("the cases that reached that rho.  Spectral converges toward the QNA\n");
    out.push_str("accuracy band as rho approaches 1 (heavy-traffic regime); QNA stays\n");
    out.push_str("flat near zero for the Markovian-style random networks generated here.\n");
    out.push_str(&"═".repeat(66));
    out.push('\n');
    out
}
