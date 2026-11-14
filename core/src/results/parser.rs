//! The result parser: a solver's captured output turned into a run's measurements, evidence,
//! warnings and outcome (0.90.34 `ResultOutputParser.swift`, ported completely).
//!
//! The parser reads the full-precision archive of a run (never the display stream). It strips ANSI
//! escape sequences and comparison-table percent deltas such as ` (+1.2%)`, turns every carriage
//! return into a line break, and reads each line by its semantic row name (`rho_1`, `E[X_2]`,
//! `Station s1: …`, the `QNET_*_V1` sentinels), never by column position. Rules are tried in
//! 0.90.34's order and the first one whose row matches and whose numbers convert takes the line; a
//! row that matches a pattern but whose number won't convert falls through to the next rule, as the
//! Swift `if let` chain did. A value already recorded for a station and metric keeps the first one.
//! Station index i is the i-th id of the record's `exportStationIDs`, else the i-th station of the
//! snapshot, else "S<i>". Then run-wide evidence is read from the whole text, and the outcome is
//! decided: completed, partial or failed, with 0.90.34's sentences.
//!
//! Matching follows `NSRegularExpression` and Foundation exactly (see `icu.rs`): Unicode digits match
//! `\d` but don't convert, `\s` is Unicode white space, case-insensitive rules fold case fully, and
//! sentinels are found with `localizedCaseInsensitiveContains` over the whole cleaned text.
//!
//! Measurement ids are random UUIDs, as in 0.90.34; `parse_with_ids` takes the id source so tests
//! can compare everything else.

use std::sync::OnceLock;

use super::icu::{alt, group, lazy_star, lit, localized_ci_contains, not_set, opt, plus, removing_percent_encoding, seq, set, star, swift_double, swift_int, Node, Regex};
use super::model::{ids, Measurement, NumericalEvidence, RunRecord, Uncertainty};
use crate::model::{Node as NetworkNode, NodeKind};

/// How a run ended, as the parser judges it (`ParsedResultOutput.Disposition`).
#[derive(Clone, Debug, PartialEq)]
pub enum Disposition {
    Completed,
    Partial(String),
    Failed(String),
}

/// What the parser read (`ParsedResultOutput`).
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedOutput {
    pub measurements: Vec<Measurement>,
    pub evidence: Option<NumericalEvidence>,
    pub warnings: Vec<String>,
    pub disposition: Disposition,
}

const DIGITS: &[(char, char)] = &[('0', '9')];
const SIGN: &[(char, char)] = &[('+', '+'), ('-', '-')];
const EXP: &[(char, char)] = &[('e', 'e'), ('E', 'E')];
const XQY: &[(char, char)] = &[('X', 'X'), ('Q', 'Q'), ('Y', 'Y')];
const S_LETTER: &[(char, char)] = &[('s', 's'), ('S', 'S')];
const COLON: &[(char, char)] = &[(':', ':')];
const CLOSE_PAREN: &[(char, char)] = &[(')', ')')];
const COLON_OR_EQUALS: &[(char, char)] = &[(':', ':'), ('=', '=')];

/// `[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`
fn number() -> Node {
    seq(vec![
        opt(set(SIGN)),
        alt(vec![seq(vec![plus(Node::Digit), opt(seq(vec![lit("."), star(Node::Digit)]))]), seq(vec![lit("."), plus(Node::Digit)])]),
        opt(seq(vec![set(EXP), opt(set(SIGN)), plus(Node::Digit)])),
    ])
}

/// `(?:\s+(?:\((<number>)\)|±\s*(<number>)))?` with its two groups numbered `a` and `b`.
fn uncertainty_suffix(a: usize, b: usize) -> Node {
    opt(seq(vec![
        plus(Node::Space),
        alt(vec![seq(vec![lit("("), group(a, number()), lit(")")]), seq(vec![lit("±"), star(Node::Space), group(b, number())])]),
    ]))
}

fn ws() -> Node {
    star(Node::Space)
}

fn ws1() -> Node {
    plus(Node::Space)
}

fn index() -> Node {
    plus(set(DIGITS))
}

fn yes_no() -> Node {
    alt(vec![lit("yes"), lit("no")])
}

/// `^\s*` + `items`.
fn anchored(items: Vec<Node>) -> Node {
    let mut v = vec![Node::Start, ws()];
    v.extend(items);
    seq(v)
}

/// The parser's patterns, each the tree of the Swift pattern of the same name.
struct Patterns {
    ansi: Regex,
    percent_delta: Regex,
    station_row: Regex,
    expectation_row: Regex,
    comparison_expectation_row: Regex,
    converted_queue_row: Regex,
    ctmc_station_row: Regex,
    product_form_station_row: Regex,
    decomposition_station_row: Regex,
    closed_station_row: Regex,
    truncated_node_row: Regex,
    adaptive_bar_row: Regex,
    bar_exact_row: Regex,
    bar_numerical_row: Regex,
    residual_row: Regex,
    refinement_row: Regex,
    cap_row: Regex,
    heuristic_row: Regex,
    adaptive_residual_row: Regex,
    adaptive_rank_row: Regex,
    bar_certified_row: Regex,
    bar_relaxation_row: Regex,
    regenerative_metric_row: Regex,
    replicated_metric_row: Regex,
    replicated_status_row: Regex,
    regenerative_cycles_row: Regex,
    regenerative_precision_row: Regex,
    mlmc_status_row: Regex,
    qbd_metric_row: Regex,
    qbd_evidence_row: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let ci = |root: Node, groups: usize| Regex::new(root, groups, true);
        let cs = |root: Node, groups: usize| Regex::new(root, groups, false);
        let g = group;
        let n = number;
        Patterns {
            // \u001B\[[0-?]*[ -/]*[@-~]
            ansi: cs(seq(vec![lit("\u{1B}["), star(set(&[('0', '?')])), star(set(&[(' ', '/')])), set(&[('@', '~')])]), 0),
            // \s*\([+-]?(?:\d+(?:\.\d*)?|\.\d+)%\)
            percent_delta: cs(
                seq(vec![
                    ws(),
                    lit("("),
                    opt(set(SIGN)),
                    alt(vec![seq(vec![plus(Node::Digit), opt(seq(vec![lit("."), star(Node::Digit)]))]), seq(vec![lit("."), plus(Node::Digit)])]),
                    lit("%)"),
                ]),
                0,
            ),
            // ^\s*(rho|Gamma|sojourn)_([0-9]+)\s*(?:=\s*)?(<n>)<unc>
            station_row: ci(
                anchored(vec![
                    g(1, alt(vec![lit("rho"), lit("Gamma"), lit("sojourn")])),
                    lit("_"),
                    g(2, index()),
                    ws(),
                    opt(seq(vec![lit("="), ws()])),
                    g(3, n()),
                    uncertainty_suffix(4, 5),
                ]),
                5,
            ),
            // ^\s*E\[([XQY])_([0-9]+)\]\s*(?:=\s*)?(<n>)<unc>
            expectation_row: ci(
                anchored(vec![lit("E["), g(1, set(XQY)), lit("_"), g(2, index()), lit("]"), ws(), opt(seq(vec![lit("="), ws()])), g(3, n()), uncertainty_suffix(4, 5)]),
                5,
            ),
            // ^\s*E\[([XQY])_([0-9]+)\]\s+.*?(<n>)(?:\s|$)
            comparison_expectation_row: ci(
                anchored(vec![lit("E["), g(1, set(XQY)), lit("_"), g(2, index()), lit("]"), ws1(), lazy_star(Node::Any), g(3, n()), alt(vec![Node::Space, Node::End])]),
                3,
            ),
            // ^\s*L_([0-9]+)\s*=\s*(<n>)\s*(?:±\s*(<n>))?
            converted_queue_row: ci(anchored(vec![lit("L_"), g(1, index()), ws(), lit("="), ws(), g(2, n()), ws(), opt(seq(vec![lit("±"), ws(), g(3, n())]))]), 3),
            // ^\s*Station\s+s([0-9]+):\s+E\[N\]=(<n>)\s+utilization=(<n>)\s+P\(full\)=(<n>)\s+throughput=(<n>)\s+E\[T\]=(<n>)
            ctmc_station_row: ci(
                anchored(vec![
                    lit("Station"),
                    ws1(),
                    lit("s"),
                    g(1, index()),
                    lit(":"),
                    ws1(),
                    lit("E[N]="),
                    g(2, n()),
                    ws1(),
                    lit("utilization="),
                    g(3, n()),
                    ws1(),
                    lit("P(full)="),
                    g(4, n()),
                    ws1(),
                    lit("throughput="),
                    g(5, n()),
                    ws1(),
                    lit("E[T]="),
                    g(6, n()),
                ]),
                6,
            ),
            // ^\s*Station\s+s([0-9]+)\s+\(fcfs\):\s+E\[N\]=(<n>)\s+throughput=(<n>)\s+utilization=(<n>)\s+margin=(<n>)
            product_form_station_row: ci(
                anchored(vec![
                    lit("Station"),
                    ws1(),
                    lit("s"),
                    g(1, index()),
                    ws1(),
                    lit("(fcfs):"),
                    ws1(),
                    lit("E[N]="),
                    g(2, n()),
                    ws1(),
                    lit("throughput="),
                    g(3, n()),
                    ws1(),
                    lit("utilization="),
                    g(4, n()),
                    ws1(),
                    lit("margin="),
                    g(5, n()),
                ]),
                5,
            ),
            // ^\s*[sS]([0-9]+)\s+[^:]*:\s+offered=(<n>)\s+throughput=(<n>)\s+P\(full\)=(<n>)\s+E\[N\]=(<n>)\s+E\[Q\]=(<n>)\s+util=(<n>)\s+W=(<n>)\s+T=(<n>)
            decomposition_station_row: ci(
                anchored(vec![
                    set(S_LETTER),
                    g(1, index()),
                    ws1(),
                    star(not_set(COLON)),
                    lit(":"),
                    ws1(),
                    lit("offered="),
                    g(2, n()),
                    ws1(),
                    lit("throughput="),
                    g(3, n()),
                    ws1(),
                    lit("P(full)="),
                    g(4, n()),
                    ws1(),
                    lit("E[N]="),
                    g(5, n()),
                    ws1(),
                    lit("E[Q]="),
                    g(6, n()),
                    ws1(),
                    lit("util="),
                    g(7, n()),
                    ws1(),
                    lit("W="),
                    g(8, n()),
                    ws1(),
                    lit("T="),
                    g(9, n()),
                ]),
                9,
            ),
            // New in 2.1 (runner/src/methods/closed.rs `report`), not a 0.90.34 pattern:
            // ^\s*(?:Closed|Exact)\s+station\s+s([0-9]+)\s+[^:]*:\s+visits=(<n>)\s+X=(<n>)\s+E\[N\]=(<n>)\s+E\[Q\]=(<n>)\s+util=(<n>)\s+W=(<n>)\s+T=(<n>)
            // ("Exact station": runner/src/methods/singlestation.rs, the priority and batch methods.)
            closed_station_row: ci(
                anchored(vec![
                    alt(vec![lit("Closed"), lit("Exact")]),
                    ws1(),
                    lit("station"),
                    ws1(),
                    lit("s"),
                    g(1, index()),
                    ws1(),
                    star(not_set(COLON)),
                    lit(":"),
                    ws1(),
                    lit("visits="),
                    g(2, n()),
                    ws1(),
                    lit("X="),
                    g(3, n()),
                    ws1(),
                    lit("E[N]="),
                    g(4, n()),
                    ws1(),
                    lit("E[Q]="),
                    g(5, n()),
                    ws1(),
                    lit("util="),
                    g(6, n()),
                    ws1(),
                    lit("W="),
                    g(7, n()),
                    ws1(),
                    lit("T="),
                    g(8, n()),
                ]),
                8,
            ),
            // ^\s*Node\s+([0-9]+)\s+[^:]+:\s+E\[N\]=(<n>)\s+utilization=(<n>)\s+departure=(<n>)
            truncated_node_row: ci(
                anchored(vec![
                    lit("Node"),
                    ws1(),
                    g(1, index()),
                    ws1(),
                    plus(not_set(COLON)),
                    lit(":"),
                    ws1(),
                    lit("E[N]="),
                    g(2, n()),
                    ws1(),
                    lit("utilization="),
                    g(3, n()),
                    ws1(),
                    lit("departure="),
                    g(4, n()),
                ]),
                4,
            ),
            // ^\s*E\[Z_([0-9]+)\]\s*=\s*(<n>)\s+Var\[Z_[0-9]+\]\s*=\s*(<n>)
            adaptive_bar_row: ci(
                anchored(vec![lit("E[Z_"), g(1, index()), lit("]"), ws(), lit("="), ws(), g(2, n()), ws1(), lit("Var[Z_"), index(), lit("]"), ws(), lit("="), ws(), g(3, n())]),
                3,
            ),
            // ^\s*mean_workload_([0-9]+):\s*\[(<n>),\s*(<n>)\]\s*\(exact\)
            bar_exact_row: ci(
                anchored(vec![lit("mean_workload_"), g(1, index()), lit(":"), ws(), lit("["), g(2, n()), lit(","), ws(), g(3, n()), lit("]"), ws(), lit("(exact)")]),
                3,
            ),
            // ^\s*mean_workload_([0-9]+):\s*lower=(<n>)\s*\([^)]*\),\s*upper=(<n>)\s*\([^)]*\)
            bar_numerical_row: ci(
                anchored(vec![
                    lit("mean_workload_"),
                    g(1, index()),
                    lit(":"),
                    ws(),
                    lit("lower="),
                    g(2, n()),
                    ws(),
                    lit("("),
                    star(not_set(CLOSE_PAREN)),
                    lit("),"),
                    ws(),
                    lit("upper="),
                    g(3, n()),
                    ws(),
                    lit("("),
                    star(not_set(CLOSE_PAREN)),
                    lit(")"),
                ]),
                3,
            ),
            // (?:residual|stationarity error|\|\|pi Q\|\|_1)\s*[:=]\s*(<n>)
            residual_row: ci(seq(vec![alt(vec![lit("residual"), lit("stationarity error"), lit("||pi Q||_1")]), ws(), set(COLON_OR_EQUALS), ws(), g(1, n())]), 1),
            // successive refinement relative change\s*=\s*(<n>)
            refinement_row: ci(seq(vec![lit("successive refinement relative change"), ws(), lit("="), ws(), g(1, n())]), 1),
            // Selected total cap:\s*([0-9]+)
            cap_row: ci(seq(vec![lit("Selected total cap:"), ws(), g(1, index())]), 1),
            // Heuristic converged:\s*(yes|no)
            heuristic_row: ci(seq(vec![lit("Heuristic converged:"), ws(), g(1, yes_no())]), 1),
            // Held-out relative BAR RMS\s*=\s*(<n>)
            adaptive_residual_row: ci(seq(vec![lit("Held-out relative BAR RMS"), ws(), lit("="), ws(), g(1, n())]), 1),
            // Rank:\s*([0-9]+)\s+converged:\s*(yes|no)
            adaptive_rank_row: ci(seq(vec![lit("Rank:"), ws(), g(1, index()), ws1(), lit("converged:"), ws(), g(2, yes_no())]), 2),
            // Certified:\s*(yes|no)
            bar_certified_row: ci(seq(vec![lit("Certified:"), ws(), g(1, yes_no())]), 1),
            // Relaxation:\s*([0-9]+)\s+moments,\s*([0-9]+)\s+equalities,\s*([0-9]+)\s+PSD blocks
            bar_relaxation_row: ci(
                seq(vec![lit("Relaxation:"), ws(), g(1, index()), ws1(), lit("moments,"), ws(), g(2, index()), ws1(), lit("equalities,"), ws(), g(3, index()), ws1(), lit("PSD blocks")]),
                3,
            ),
            // ^QNET_NODE_METRIC_V1 node_id=(\S+) metric=(\S+) … effective_cycles=(\S+)$ (case-sensitive)
            regenerative_metric_row: {
                let fields = ["metric", "class_id", "estimate", "standard_error", "ci_confidence", "ci_low", "ci_high", "ci_half_width", "effective_cycles"];
                let labels = [" metric=", " class_id=", " estimate=", " standard_error=", " ci_confidence=", " ci_low=", " ci_high=", " ci_half_width=", " effective_cycles="];
                let mut v = vec![Node::Start, lit("QNET_NODE_METRIC_V1 node_id="), g(1, plus(Node::NotSpace))];
                for (i, label) in labels.iter().enumerate() {
                    debug_assert!(label.contains(fields[i]));
                    v.push(lit(label));
                    v.push(g(i + 2, plus(Node::NotSpace)));
                }
                v.push(Node::End);
                cs(seq(v), 10)
            },
            // New in 2.1 (runner/src/methods/siminproc.rs `report`), not a 0.90.34 pattern:
            // ^QNET_SIM_METRIC_V1 node_id=(\S+) metric=(\S+) estimate=(\S+) standard_error=(\S+) ci_confidence=(\S+) ci_low=(\S+) ci_high=(\S+) replications=([0-9]+)$ (case-sensitive)
            replicated_metric_row: {
                let labels = [" metric=", " estimate=", " standard_error=", " ci_confidence=", " ci_low=", " ci_high="];
                let mut v = vec![Node::Start, lit("QNET_SIM_METRIC_V1 node_id="), g(1, plus(Node::NotSpace))];
                for (i, label) in labels.iter().enumerate() {
                    v.push(lit(label));
                    v.push(g(i + 2, plus(Node::NotSpace)));
                }
                v.push(lit(" replications="));
                v.push(g(8, index()));
                v.push(Node::End);
                cs(seq(v), 8)
            },
            // QNET_SIM_STATUS_V1 replications=([0-9]+) target_met=(yes|no|na) warmup_inconclusive=(yes|no) (case-sensitive)
            replicated_status_row: cs(
                seq(vec![lit("QNET_SIM_STATUS_V1 replications="), g(1, index()), lit(" target_met="), g(2, alt(vec![lit("yes"), lit("no"), lit("na")])), lit(" warmup_inconclusive="), g(3, yes_no())]),
                3,
            ),
            // Complete empty-to-empty cycles:\s*([0-9]+)
            regenerative_cycles_row: ci(seq(vec![lit("Complete empty-to-empty cycles:"), ws(), g(1, index())]), 1),
            // Precision target met:\s*(yes|no)
            regenerative_precision_row: ci(seq(vec![lit("Precision target met:"), ws(), g(1, yes_no())]), 1),
            // QNET_MLMC_STATUS_V1\s+adaptive=(yes|no)\s+precision_met=(yes|no|na)\s+cap_hits=([0-9]+)
            mlmc_status_row: ci(
                seq(vec![
                    lit("QNET_MLMC_STATUS_V1"),
                    ws1(),
                    lit("adaptive="),
                    g(1, yes_no()),
                    ws1(),
                    lit("precision_met="),
                    g(2, alt(vec![lit("yes"), lit("no"), lit("na")])),
                    ws1(),
                    lit("cap_hits="),
                    g(3, index()),
                ]),
                3,
            ),
            // ^QNET_QBD_METRIC_V1 metric=(\S+)(?: level=([0-9]+))? estimate=(<n>)$ (case-sensitive)
            qbd_metric_row: cs(
                seq(vec![Node::Start, lit("QNET_QBD_METRIC_V1 metric="), g(1, plus(Node::NotSpace)), opt(seq(vec![lit(" level="), g(2, index())])), lit(" estimate="), g(3, n()), Node::End]),
                3,
            ),
            // ^QNET_QBD_EVIDENCE_V1 key=(\S+) value=(\S+)$ (case-sensitive)
            qbd_evidence_row: cs(seq(vec![Node::Start, lit("QNET_QBD_EVIDENCE_V1 key="), g(1, plus(Node::NotSpace)), lit(" value="), g(2, plus(Node::NotSpace)), Node::End]), 2),
        }
    })
}

/// `groups[safe: i]`: the group's text, or None when it is absent or empty.
fn safe(groups: &[String], i: usize) -> Option<&str> {
    groups.get(i).map(String::as_str).filter(|s| !s.is_empty())
}

/// Parses `raw` for `run`, giving each measurement a fresh random UUID (`ResultOutputParser.parse`).
pub fn parse(raw: Option<&str>, run: &RunRecord) -> ParsedOutput {
    parse_with_ids(raw, run, &mut super::codec::random_uuid)
}

/// `parse`, taking each measurement's id from `next_id` (one call per measurement built, including
/// duplicates the parser then drops).
pub fn parse_with_ids(raw: Option<&str>, run: &RunRecord, next_id: &mut dyn FnMut() -> String) -> ParsedOutput {
    let raw = match raw {
        Some(r) if !r.is_empty() => r,
        _ => {
            return ParsedOutput {
                measurements: vec![],
                evidence: None,
                warnings: vec!["The solver completed without capturable standard output.".into()],
                disposition: Disposition::Failed("The solver exited successfully but produced no output. No performance measures can be trusted from this run.".into()),
            }
        }
    };
    let p = patterns();
    let clean = normalized(raw);
    let clean_chars: Vec<char> = clean.chars().collect();
    let method = run.method.identifier.as_str();
    let mut out = Collected { measurements: vec![], seen: std::collections::HashSet::new() };
    let mut qbd_residuals: Vec<f64> = vec![];
    let mut qbd_iterations: Option<String> = None;
    let mut qbd_stability: Option<String> = None;

    for line in clean.split('\n') {
        let line: Vec<char> = line.chars().collect();
        let line = &line[..];

        if let Some(g) = p.station_row.first_captures(line) {
            if let (Some(index), Some(estimate)) = (swift_int(&g[2]), swift_double(&g[3])) {
                let (metric, unit) = match g[1].to_lowercase().as_str() {
                    "rho" => ("Utilization", "ratio"),
                    "gamma" => ("Throughput", "customers / time"),
                    _ => ("Mean sojourn time", "time"),
                };
                let m = measurement(index, metric, estimate, unit, safe(&g, 4).or(safe(&g, 5)), run, next_id);
                out.append(m, format!("{index}|{metric}"));
                continue;
            }
        }

        if let Some(g) = p.expectation_row.first_captures(line) {
            if let (Some(index), Some(estimate)) = (swift_int(&g[2]), swift_double(&g[3])) {
                let (metric, unit) = match g[1].to_uppercase().as_str() {
                    "Y" => ("Mean workload", "work"),
                    "Q" => ("Mean number in system", "customers"),
                    _ => ("Mean reported occupancy", "customers"),
                };
                let m = measurement(index, metric, estimate, unit, safe(&g, 4).or(safe(&g, 5)), run, next_id);
                out.append(m, format!("{index}|{metric}"));
                continue;
            }
        }

        // A comparison may have an unavailable first column (an em dash) before successful method
        // columns; the first actual estimate is kept.
        if method == ids::COMPARISON {
            if let Some(g) = p.comparison_expectation_row.first_captures(line) {
                if let (Some(index), Some(estimate)) = (swift_int(&g[2]), swift_double(&g[3])) {
                    let y = g[1].to_uppercase() == "Y";
                    let (metric, unit) = if y { ("Mean workload", "work") } else { ("Mean reported occupancy", "customers") };
                    let m = measurement(index, metric, estimate, unit, None, run, next_id);
                    out.append(m, format!("{index}|{metric}"));
                    continue;
                }
            }
        }

        if let Some(g) = p.converted_queue_row.first_captures(line) {
            if let (Some(index), Some(estimate)) = (swift_int(&g[1]), swift_double(&g[2])) {
                let mut m = measurement(index, "Mean queue length", estimate, "customers", None, run, next_id);
                if let Some(h) = safe(&g, 3).and_then(swift_double) {
                    m.uncertainty = Some(Uncertainty { lower_bound: Some(estimate - h), upper_bound: Some(estimate + h), confidence_level: Some(0.95), ..Default::default() });
                }
                out.append(m, format!("{index}|Mean queue length"));
                continue;
            }
        }

        if let Some(g) = p.ctmc_station_row.first_captures(line) {
            if let Some(index) = swift_int(&g[1]) {
                let values = [
                    ("Mean number in system", "customers", &g[2]),
                    ("Server utilization", "ratio", &g[3]),
                    ("Full probability", "probability", &g[4]),
                    ("Throughput", "customers / time", &g[5]),
                    ("Mean sojourn time", "time", &g[6]),
                ];
                out.append_station_values(&values, index, run, next_id);
                continue;
            }
        }

        if let Some(g) = p.product_form_station_row.first_captures(line) {
            if let Some(index) = swift_int(&g[1]) {
                let values = [
                    ("Mean number in system", "customers", &g[2]),
                    ("Throughput", "customers / time", &g[3]),
                    ("Server utilization", "ratio", &g[4]),
                    ("Stability margin", "ratio", &g[5]),
                ];
                out.append_station_values(&values, index, run, next_id);
                continue;
            }
        }

        if let Some(g) = p.closed_station_row.first_captures(line) {
            if let Some(index) = swift_int(&g[1]) {
                let values = [
                    ("Throughput", "customers / time", &g[3]),
                    ("Mean number in system", "customers", &g[4]),
                    ("Mean queue length", "customers", &g[5]),
                    ("Server utilization", "ratio", &g[6]),
                    ("Mean waiting time", "time", &g[7]),
                    ("Mean sojourn time", "time", &g[8]),
                ];
                out.append_station_values(&values, index, run, next_id);
                continue;
            }
        }

        if let Some(g) = p.decomposition_station_row.first_captures(line) {
            if let Some(index) = swift_int(&g[1]) {
                let values = [
                    ("Offered arrival rate", "customers / time", &g[2]),
                    ("Throughput", "customers / time", &g[3]),
                    ("Full probability", "probability", &g[4]),
                    ("Mean number in system", "customers", &g[5]),
                    ("Mean queue length", "customers", &g[6]),
                    ("Server utilization", "ratio", &g[7]),
                    ("Mean waiting time", "time", &g[8]),
                    ("Mean sojourn time", "time", &g[9]),
                ];
                out.append_station_values(&values, index, run, next_id);
                continue;
            }
        }

        if let Some(g) = p.truncated_node_row.first_captures(line) {
            if let Some(index) = swift_int(&g[1]) {
                let values = [("Mean number in system", "customers", &g[2]), ("Server utilization", "ratio", &g[3]), ("External departure rate", "customers / time", &g[4])];
                out.append_station_values(&values, index, run, next_id);
                continue;
            }
        }

        if let Some(g) = p.adaptive_bar_row.first_captures(line) {
            if let Some(index) = swift_int(&g[1]) {
                let values = [("Mean workload", "work", &g[2]), ("Workload variance", "work²", &g[3])];
                out.append_station_values(&values, index, run, next_id);
                continue;
            }
        }

        if let Some(g) = p.bar_exact_row.first_captures(line) {
            if let (Some(index), Some(lower), Some(upper)) = (swift_int(&g[1]), swift_double(&g[2]), swift_double(&g[3])) {
                let station = station_at_one_based(index, run);
                let m = Measurement::new(
                    next_id(),
                    station.map(|s| s.id.clone()),
                    station.map(|s| s.name.clone()).unwrap_or_else(|| format!("S{index}")),
                    None,
                    "Mean workload".into(),
                    (lower + upper) / 2.0,
                    "work".into(),
                    Some(Uncertainty { lower_bound: Some(lower), upper_bound: Some(upper), ..Default::default() }),
                    None,
                    Some("Certified exact SRBM point bound".into()),
                );
                out.append(m, format!("{index}|Mean workload"));
                continue;
            }
        }

        if let Some(g) = p.bar_numerical_row.first_captures(line) {
            if let (Some(index), Some(lower), Some(upper)) = (swift_int(&g[1]), swift_double(&g[2]), swift_double(&g[3])) {
                let station = station_at_one_based(index, run);
                for (metric, value) in [("Mean workload lower bound", lower), ("Mean workload upper bound", upper)] {
                    let m = Measurement::new(
                        next_id(),
                        station.map(|s| s.id.clone()),
                        station.map(|s| s.name.clone()).unwrap_or_else(|| format!("S{index}")),
                        None,
                        metric.into(),
                        value,
                        "work".into(),
                        None,
                        None,
                        Some("Floating SDP value; not a certified numerical bound".into()),
                    );
                    out.append(m, format!("{index}|{metric}"));
                }
                continue;
            }
        }

        if let Some(g) = p.regenerative_metric_row.first_captures(line) {
            if let Some(estimate) = finite_number(&g[4]) {
                let node_id = removing_percent_encoding(&g[1]).unwrap_or_else(|| g[1].clone());
                let metric_id = g[2].as_str();
                let class_id = if g[3] == "-" { None } else { Some(removing_percent_encoding(&g[3]).unwrap_or_else(|| g[3].clone())) };
                let Some(index) = numeric_identifier(&node_id, 's') else { continue };
                let station = station_at_one_based(index, run);
                let (metric, unit) = match metric_id {
                    "mean_number" => ("Mean number in system", "customers"),
                    "mean_queue" => ("Mean queue length", "customers"),
                    "utilization" => ("Server utilization", "ratio"),
                    "service_completion_rate" => ("Service completion rate", "customers / time"),
                    "mean_number_class" => ("Mean number in system", "customers"),
                    _ => continue,
                };
                let class_index = class_id.as_deref().and_then(|c| numeric_identifier(c, 'c')).map(|c| c - 1);
                let effective_cycles = finite_number(&g[10]);
                let m = Measurement::new(
                    next_id(),
                    station.map(|s| s.id.clone()),
                    station.map(|s| s.name.clone()).unwrap_or_else(|| node_id.clone()),
                    class_index,
                    metric.into(),
                    estimate,
                    unit.into(),
                    Some(Uncertainty {
                        standard_error: finite_number(&g[5]),
                        lower_bound: finite_number(&g[7]),
                        upper_bound: finite_number(&g[8]),
                        confidence_level: finite_number(&g[6]),
                        sample_size: None,
                    }),
                    None,
                    effective_cycles.map(|c| format!("Effective complete cycles: {}", crate::dist::format_significant(c, 6))),
                );
                let class_key = class_index.map(|c| c.to_string()).unwrap_or_else(|| "all".into());
                out.append(m, format!("{index}|{class_key}|{metric}"));
                continue;
            }
        }

        // Replicated Simulation (new in 2.1): the interval is the Student interval the run
        // printed, never rebuilt from the standard error.
        if method == ids::REPLICATED_SIMULATION {
            if let Some(g) = p.replicated_metric_row.first_captures(line) {
                if let (Some(estimate), Some(index)) = (finite_number(&g[3]), numeric_identifier(&g[1], 's')) {
                    let (metric, unit) = match g[2].as_str() {
                        "throughput" => ("Throughput", "customers / time"),
                        "mean_number" => ("Mean number in system", "customers"),
                        "mean_queue" => ("Mean queue length", "customers"),
                        "utilization" => ("Server utilization", "ratio"),
                        "mean_waiting_time" => ("Mean waiting time", "time"),
                        "mean_sojourn_time" => ("Mean sojourn time", "time"),
                        _ => continue,
                    };
                    let station = station_at_one_based(index, run);
                    let m = Measurement::new(
                        next_id(),
                        station.map(|s| s.id.clone()),
                        station.map(|s| s.name.clone()).unwrap_or_else(|| format!("S{index}")),
                        None,
                        metric.into(),
                        estimate,
                        unit.into(),
                        Some(Uncertainty { standard_error: finite_number(&g[4]), lower_bound: finite_number(&g[6]), upper_bound: finite_number(&g[7]), confidence_level: finite_number(&g[5]), sample_size: swift_int(&g[8]) }),
                        None,
                        None,
                    );
                    out.append(m, format!("{index}|{metric}"));
                    continue;
                }
            }
        }

        if method == ids::QBD {
            if let Some(g) = p.qbd_metric_row.first_captures(line) {
                if let Some(estimate) = finite_number(&g[3]) {
                    let level = swift_int(&g[2]);
                    let station = station_at_one_based(1, run);
                    let (metric, unit, note): (String, &str, Option<&str>) = match g[1].as_str() {
                        "mean_level" => ("Mean number in system".into(), "customers", Some("QBD level equals customer count for the strict one-phase adapter")),
                        "second_moment_level" => ("Second moment of number in system".into(), "customers²", None),
                        "variance_level" => ("Variance of number in system".into(), "customers²", None),
                        "standard_deviation_level" => ("Standard deviation of number in system".into(), "customers", None),
                        "probability_empty" => ("Empty-system probability".into(), "probability", None),
                        "tail_probability" => {
                            let Some(level) = level else { continue };
                            (format!("Tail probability P(N ≥ {level})"), "probability", Some("Exact matrix-geometric tail probability"))
                        }
                        _ => continue,
                    };
                    let m = Measurement::new(
                        next_id(),
                        station.map(|s| s.id.clone()),
                        station.map(|s| s.name.clone()).unwrap_or_else(|| "S1".into()),
                        None,
                        metric.clone(),
                        estimate,
                        unit.into(),
                        None,
                        None,
                        note.map(Into::into),
                    );
                    out.append(m, format!("1|{metric}"));
                    continue;
                }
            }
        }

        if method == ids::QBD {
            if let Some(g) = p.qbd_evidence_row.first_captures(line) {
                let key = removing_percent_encoding(&g[1]).unwrap_or_else(|| g[1].clone());
                let value = removing_percent_encoding(&g[2]).unwrap_or_else(|| g[2].clone());
                match key.as_str() {
                    "rate_equation_residual_inf" | "boundary_balance_residual_scaled" | "normalization_residual" => {
                        if let Some(r) = swift_double(&value).filter(|r| r.is_finite()) {
                            qbd_residuals.push(r.abs());
                        }
                    }
                    "iterations" => qbd_iterations = Some(value),
                    "stability_classification" => qbd_stability = Some(value.replace('_', " ")),
                    _ => {}
                }
            }
        }
    }

    let measurements = out.measurements;
    let first = |re: &Regex| re.first_captures(&clean_chars);
    let mut evidence = NumericalEvidence::default();
    if let Some(v) = first(&p.residual_row).and_then(|g| safe(&g, 1).and_then(swift_double)) {
        evidence.residual = Some(v);
    }
    if let Some(v) = first(&p.refinement_row).and_then(|g| safe(&g, 1).and_then(swift_double)) {
        evidence.refinement_delta = Some(v);
    }
    if let Some(cap) = first(&p.cap_row).and_then(|g| safe(&g, 1).map(String::from)) {
        evidence.discretization = Some(format!("total-population cap {cap}"));
    }
    if let Some(state) = first(&p.heuristic_row).and_then(|g| safe(&g, 1).map(String::from)) {
        evidence.convergence_note = Some(format!("Truncation criteria met: {} (heuristic)", state.to_lowercase()));
    }
    if let Some(v) = first(&p.adaptive_residual_row).and_then(|g| safe(&g, 1).and_then(swift_double)) {
        evidence.residual = Some(v);
    }
    if let Some(g) = first(&p.adaptive_rank_row) {
        if let (Some(rank), Some(converged)) = (safe(&g, 1), safe(&g, 2)) {
            evidence.discretization = Some(format!("mixture rank {rank}"));
            evidence.convergence_note = Some(format!("Adaptive BAR criteria met: {}", converged.to_lowercase()));
        }
    }
    if let Some(certified) = first(&p.bar_certified_row).and_then(|g| safe(&g, 1).map(String::from)) {
        evidence.convergence_note = Some(if certified.to_lowercase() == "yes" { "Certified exact SRBM special case" } else { "Uncertified BAR relaxation result" }.into());
    }
    if let Some(g) = first(&p.bar_relaxation_row) {
        evidence.discretization = Some(format!("{} moments, {} equalities, {} PSD blocks", g[1], g[2], g[3]));
    }
    if let Some(cycles) = first(&p.regenerative_cycles_row).and_then(|g| safe(&g, 1).map(String::from)) {
        evidence.discretization = Some(format!("{cycles} complete regenerative cycles"));
    }
    if let Some(met) = first(&p.regenerative_precision_row).and_then(|g| safe(&g, 1).map(String::from)) {
        evidence.convergence_note = Some(format!("Sequential fixed-width target met: {}", met.to_lowercase()));
    }
    if method == ids::SRBM_MLMC {
        if let Some(g) = first(&p.mlmc_status_row) {
            if let (Some(adaptive), Some(met), Some(cap_hits)) = (safe(&g, 1), safe(&g, 2), safe(&g, 3)) {
                evidence.convergence_note = Some(if adaptive.to_lowercase() == "yes" {
                    format!("Adaptive MLMC precision target met: {} (cap hits: {cap_hits})", met.to_lowercase())
                } else {
                    "Fixed-sample MLMC plan".into()
                });
            }
        }
    }
    let replicated_status = if method == ids::REPLICATED_SIMULATION { first(&p.replicated_status_row) } else { None };
    if let Some(g) = &replicated_status {
        evidence.discretization = Some(format!("{} independent replications", g[1]));
        evidence.convergence_note = match g[2].as_str() {
            "yes" => Some("Sequential relative-precision target met: yes".into()),
            "no" => Some("Sequential relative-precision target met: no".into()),
            _ => None,
        };
    }
    if method == ids::QBD {
        // Array.max(): the first largest; nil (clearing an earlier residual) when there is none.
        evidence.residual = qbd_residuals.iter().copied().reduce(|best, x| if best < x { x } else { best });
        if let Some(it) = &qbd_iterations {
            evidence.discretization = Some(format!("matrix-geometric rate solve, {it} iterations"));
        }
        if let Some(st) = &qbd_stability {
            evidence.convergence_note = Some(format!("QBD stability classification: {st}"));
        }
    }

    let contains = |needle: &str| localized_ci_contains(&clean, needle);
    let mut warnings: Vec<String> = vec![];
    let mut disposition = Disposition::Completed;
    if measurements.is_empty() {
        if method == ids::BAR_MOMENT_BOUNDS {
            warnings.push("No numerical bounds were produced. The conic relaxation was built, but a general model needs an installed SDP backend; inspect the retained relaxation summary.".into());
            disposition = Disposition::Failed("The BAR relaxation produced no performance bounds. Install a supported CVXPY SDP backend or use an exact special case.".into());
        } else {
            warnings.push("No recognized station measurements were found; inspect the retained raw output.".into());
            disposition = Disposition::Failed("The solver produced no recognized station performance measures.".into());
        }
    }
    if method == ids::COMPARISON {
        warnings.push("The structured table records the first value in each comparison row; the retained raw output contains every method column.".into());
    }
    if method == ids::BAR_MOMENT_BOUNDS && contains("Certified: no") {
        warnings.push("General floating-point SDP values are feasibility-checked but are not certified numerical bounds.".into());
    }
    if method == ids::ADAPTIVE_LOW_RANK_BAR && contains("converged: no") {
        warnings.push("The maximum mixture rank was reached before both adaptive criteria passed.".into());
        disposition = Disposition::Partial("The maximum mixture rank was reached before the adaptive BAR validation criteria passed.".into());
    }
    if method == ids::REGENERATIVE_MONTE_CARLO && contains("Precision target met: no") {
        warnings.push("The run stopped at a safeguard before every requested precision target was met.".into());
        disposition = Disposition::Partial("The regenerative simulation returned estimates, but its requested precision target was not met.".into());
    }
    if method == ids::SRBM_MLMC && !measurements.is_empty() && contains("QNET_MLMC_STATUS_V1") && contains("adaptive=yes") && contains("precision_met=no") {
        warnings.push("At least one adaptive MLMC replication reached its maximum-sample safeguard before meeting the requested standard-error target.".into());
        disposition = Disposition::Partial("SRBM MLMC returned estimates, but at least one adaptive replication hit its sample cap before meeting the requested precision target.".into());
    }
    if method == ids::REGENERATIVE_MONTE_CARLO && first(&p.regenerative_cycles_row).is_some_and(|g| safe(&g, 1) == Some("0")) {
        disposition = Disposition::Failed("No complete empty-to-empty regenerative cycle was observed, so the reported values are not steady-state regenerative estimates.".into());
    }
    // The line runner/src/methods/siminproc.rs `time_cap_sentence` writes (review finding FIX-205).
    if method == ids::REPLICATED_SIMULATION && contains("Reproducibility: not by the seed alone.") {
        warnings.push("This result is not reproducible from its seed alone: the run stopped on the cap on wall time, and how many replications fit in that time depends on the machine's speed. Each replication is still the one its seed gives.".into());
    }
    if let Some(g) = &replicated_status {
        if g[3] == "yes" {
            warnings.push("The replications are too short for MSER on 200 batch means to find where the warm-up ends; half of each was deleted. Lengthen the replications.".into());
        }
        if g[2] == "no" && !measurements.is_empty() {
            warnings.push("The run stopped at a cap before the requested precision target was met.".into());
            disposition = Disposition::Partial("The replicated simulation returned estimates with valid intervals, but they are wider than the requested precision target.".into());
        }
    }
    if method == ids::TRUNCATED_CTMC && contains("Heuristic converged: no") {
        warnings.push("The state-space cap was reached before the truncation checks passed.".into());
        disposition = Disposition::Partial("The truncated CTMC returned estimates, but its boundary-mass and refinement checks did not converge.".into());
    }
    if method == ids::SBD && contains("QNET_SBD_STATUS_V1") && contains("fallback_used=yes") {
        warnings.push("SBD used a one-dimensional fallback because an internal spectral subproblem failed.".into());
        disposition = Disposition::Partial("SBD completed with a fallback approximation after an internal spectral solve failed.".into());
    }
    if method == ids::COMPARISON && contains("QNET_COMPARISON_STATUS_V1") && contains("partial=yes") {
        warnings.push("One or more comparison methods failed or were skipped; successful columns remain available.".into());
        disposition = if measurements.is_empty() {
            Disposition::Failed("Every method in the comparison failed or was skipped.".into())
        } else {
            Disposition::Partial("The comparison contains successful results, but one or more methods failed or were skipped.".into())
        };
    }
    ParsedOutput { measurements, evidence: (!evidence.is_empty()).then_some(evidence), warnings, disposition }
}

/// The measurements so far and the keys already taken.
struct Collected {
    measurements: Vec<Measurement>,
    seen: std::collections::HashSet<String>,
}

impl Collected {
    /// Keeps the first value for each key: raw compact rows printed before a formatted table win.
    fn append(&mut self, m: Measurement, key: String) {
        if self.seen.insert(key) {
            self.measurements.push(m);
        }
    }

    /// The multi-value station rows: a value that won't convert is skipped, its neighbours kept.
    fn append_station_values(&mut self, values: &[(&str, &str, &String)], index: i64, run: &RunRecord, next_id: &mut dyn FnMut() -> String) {
        for (metric, unit, text) in values {
            let Some(estimate) = swift_double(text) else { continue };
            let m = measurement(index, metric, estimate, unit, None, run, next_id);
            self.append(m, format!("{index}|{metric}"));
        }
    }
}

/// A station measurement, with a reported half-width turned into the 95 % interval it describes
/// (never a standard error).
fn measurement(index: i64, metric: &str, estimate: f64, unit: &str, half_width_text: Option<&str>, run: &RunRecord, next_id: &mut dyn FnMut() -> String) -> Measurement {
    let station = station_at_one_based(index, run);
    let half_width = half_width_text.and_then(swift_double);
    Measurement::new(
        next_id(),
        station.map(|s| s.id.clone()),
        station.map(|s| s.name.clone()).unwrap_or_else(|| format!("S{index}")),
        None,
        metric.into(),
        estimate,
        unit.into(),
        half_width.map(|h| Uncertainty { lower_bound: Some(estimate - h), upper_bound: Some(estimate + h), confidence_level: Some(0.95), ..Default::default() }),
        None,
        None,
    )
}

/// The station a solver's 1-based row index names (`station(atOneBased:in:)`): the record's
/// export-order id when it has one for that index, else the index-th station of the snapshot in
/// canvas order. Index 0 or less is no station.
pub fn station_at_one_based(index: i64, run: &RunRecord) -> Option<&NetworkNode> {
    if index <= 0 {
        return None;
    }
    let i = (index - 1) as usize;
    let snapshot = &run.provenance.network_snapshot;
    if let Some(id) = run.provenance.export_station_ids.as_ref().and_then(|ids| ids.get(i)) {
        return snapshot.node(id);
    }
    snapshot.nodes.iter().filter(|n| n.kind == NodeKind::Station).nth(i)
}

/// `finiteNumber`: None for "NA" (any case), text Swift's `Double` refuses, or a non-finite value.
fn finite_number(text: &str) -> Option<f64> {
    if text.to_uppercase() == "NA" {
        return None;
    }
    swift_double(text).filter(|v| v.is_finite())
}

/// `numericIdentifier`: "s3" → 3 for prefix 's' (either case), positive only.
fn numeric_identifier(text: &str, prefix: char) -> Option<i64> {
    let mut chars = text.chars();
    let first = chars.next()?;
    if first.to_ascii_lowercase() != prefix || !first.is_ascii() {
        return None;
    }
    swift_int(chars.as_str()).filter(|v| *v > 0)
}

/// The text the rules read: ANSI sequences removed, then percent deltas, then every `\r` made `\n`.
pub fn normalized(raw: &str) -> String {
    let p = patterns();
    let chars: Vec<char> = raw.chars().collect();
    let without_ansi = p.ansi.remove_all(&chars);
    let without_delta = p.percent_delta.remove_all(&without_ansi);
    without_delta.into_iter().map(|c| if c == '\r' { '\n' } else { c }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cfmt;
    use crate::model::Node as NetworkNode;
    use crate::results::model::{MethodMetadata, NetworkSnapshot, Provenance};
    use std::collections::BTreeMap;

    const CHECKOUT: &str = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const DISK: &str = "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

    /// The record the Swift driver parses against: a buffer, then stations "Checkout" and "Disk";
    /// with `export`, only Checkout is listed in export order (so index 2 falls back to the
    /// snapshot's second station).
    fn run(method: &str, export: bool) -> RunRecord {
        let nodes = vec![
            NetworkNode::new("11111111-2222-3333-4444-555555555555", NodeKind::Buffer, "Waiting Room", (0.0, 0.0)),
            NetworkNode::new(CHECKOUT, NodeKind::Station, "Checkout", (0.0, 0.0)),
            NetworkNode::new(DISK, NodeKind::Station, "Disk", (0.0, 0.0)),
        ];
        let snapshot = NetworkSnapshot { nodes, links: vec![], infinite_buffers: true, population: None };
        let method = MethodMetadata::named(method).unwrap_or_else(|| MethodMetadata::new(method, method, None, crate::results::ModelLayer::Mixed, crate::results::Fidelity::MixedEvidence, None));
        let provenance = Provenance {
            tab_id: "00000000-0000-0000-0000-000000000000".into(),
            network_title: String::new(),
            source_file_url: None,
            network_fingerprint: String::new(),
            network_snapshot: snapshot,
            buffer_regime: String::new(),
            parameters: BTreeMap::new(),
            seed: None,
            replication_seeds: vec![],
            application_version: String::new(),
            solver_version: None,
            export_station_ids: export.then(|| vec![CHECKOUT.to_string()]),
        };
        RunRecord::new("00000000-0000-0000-0000-000000000001", method, provenance, crate::results::Date::from_unix(0.0))
    }

    fn g(v: Option<f64>) -> String {
        v.map(|x| cfmt::f("%.17g", x)).unwrap_or_else(|| "-".into())
    }

    /// The driver's rendering of one parse.
    fn render(n: usize, method: &str, p: &ParsedOutput) -> String {
        let mut out = format!("case {n} {method}\n");
        out += &match &p.disposition {
            Disposition::Completed => "disposition: completed\n".to_string(),
            Disposition::Partial(m) => format!("disposition: partial: {m}\n"),
            Disposition::Failed(m) => format!("disposition: failed: {m}\n"),
        };
        for m in &p.measurements {
            let u = m
                .uncertainty
                .as_ref()
                .map(|u| format!("{},{},{},{},{}", g(u.standard_error), g(u.lower_bound), g(u.upper_bound), g(u.confidence_level), u.sample_size.map(|s| s.to_string()).unwrap_or("-".into())))
                .unwrap_or_else(|| "-".into());
            out += &format!(
                "m: {}|{}|{}|{}|{}|{}|u={}|note={}\n",
                m.station_name,
                m.station_id.as_deref().unwrap_or("-"),
                m.customer_class.map(|c| c.to_string()).unwrap_or("-".into()),
                m.metric,
                g(Some(m.estimate)),
                m.unit,
                u,
                m.note.as_deref().unwrap_or("-")
            );
        }
        match &p.evidence {
            Some(e) => {
                out += &format!(
                    "e: residual={}|disc={}|delta={}|note={}\n",
                    g(e.residual),
                    e.discretization.as_deref().unwrap_or("-"),
                    g(e.refinement_delta),
                    e.convergence_note.as_deref().unwrap_or("-")
                )
            }
            None => out += "e: -\n",
        }
        for w in &p.warnings {
            out += &format!("w: {w}\n");
        }
        out
    }

    /// 44 inputs chosen to reach the corners of 0.90.34's patterns (case folding, Unicode digits,
    /// ANSI and carriage returns, `$` before a final line separator, fall-through when a number
    /// won't convert, duplicate rows, station fallbacks, percent-encoded ids, hexadecimal and NA
    /// fields, evidence overrides, sentinels behind combining marks), each parsed here and by
    /// 0.90.34's own `ResultOutputParser` (fixtures/parser_edge_cases_driver.swift); the two
    /// renderings must be identical.
    #[test]
    fn edge_cases_parse_exactly_as_0_90_34s_parser_parsed_them() {
        let cases = include_str!("fixtures/parser_edge_cases.jsonl");
        let want = include_str!("fixtures/parser_edge_cases.expected");
        let mut got = String::new();
        for (i, line) in cases.lines().enumerate() {
            let v = crate::json::parse(line).unwrap();
            let o = v.as_object().unwrap();
            let method = o["method"].as_str().unwrap();
            let export = o["export"].as_bool().unwrap();
            let raw = o["raw"].as_str().unwrap();
            let mut k = 0;
            let parsed = parse_with_ids(Some(raw), &run(method, export), &mut || {
                k += 1;
                format!("{k}")
            });
            got += &render(i + 1, method, &parsed);
        }
        for (i, (a, b)) in got.lines().zip(want.lines()).enumerate() {
            assert_eq!(a, b, "line {} of the rendering", i + 1);
        }
        assert_eq!(got, want);
    }

    #[test]
    fn normalisation_strips_ansi_and_percent_deltas_and_turns_returns_into_newlines() {
        assert_eq!(normalized("\u{1B}[1;32mrho_1\u{1B}[0m = 0.9 (+1.5%)\r\u{1B}[Kx\r\n"), "rho_1 = 0.9\nx\n\n");
        assert_eq!(normalized("a (12%) b ( 1%)"), "a b ( 1%)");
    }
}
