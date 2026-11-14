//! The two maps keyed by a run's internal label ("inf_cmp", "qna", "regenerative_mc"): the name the
//! interface shows for the run, and the Results method the run files its record under.
//!
//! Ports `TerminalModel.displayLabel(forRunLabel:)` (ledger RUN-053) and
//! `QnetGUIApp.resultMethod(forRunLabel:)` (RUN-054) from 0.90.34. Both are pure functions with the
//! same cases in the same order. The fallback of `displayLabel` is Foundation's
//! `String.capitalized` after replacing underscores with spaces, which the golden runs show
//! ("adaptive_bar" → "Adaptive Bar", "regenerative_mc" → "Regenerative Mc"); `capitalize_like_swift`
//! reproduces the word boundaries Foundation uses, measured with Swift on this machine.

/// The name a run is shown under (status bar, Status log, summaries) for an internal run label.
///
/// The named cases are 0.90.34's; any other label has its underscores turned into spaces and is
/// capitalised the way Swift's `String.capitalized` does it.
pub fn display_label(label: &str) -> String {
    let named = match label {
        "inf_cmp" | "cmp" => "Run Comparison",
        "inf_sim" | "sim" => "Monte Carlo",
        "inf_sm" | "sm" => "Spectral",
        "qna" => "QNA",
        "closed_pf" => "Closed Product Form",
        "sim_inproc" => "Replicated Simulation",
        "priority_exact" => "Exact Priority Queue",
        "batch_exact" => "Exact Batch-Arrival Queue",
        "rqna" => "Robust QNA",
        "sbd" => "SBD",
        "mlmc" => "SRBM MLMC",
        "lp" | "flp" => "Linear Program",
        "fm" => "Finite Element",
        "mc" => "Multi-class SRBM",
        "testset" => "Test Set",
        "spc" => "Spectral Convergence",
        "primitives" => "Network Primitives",
        "analyze" => "Analyze Network",
        _ => return capitalize_like_swift(&label.replace('_', " ")),
    };
    named.to_string()
}

/// The Results method identifier a run label files its record under, or `None` for the utility runs
/// (Analyze, Primitives, Help) that are diagnostics rather than steady-state estimates and so open
/// no record.
///
/// The identifiers are `ResultMethodMetadata.identifier` from 0.90.34's `ResultsWorkspace.swift`.
pub fn result_method_identifier(label: &str) -> Option<&'static str> {
    Some(match label {
        "sim" | "inf_sim" => "queue.des",
        "sm" | "inf_sm" => "srbm.spectral",
        "fm" => "srbm.fem",
        "flp" | "lp" => "srbm.lp",
        "mc" => "srbm.multiclass-station",
        "qna" => "queue-approx.qna",
        "rqna" => "queue-approx.rqna",
        "sbd" => "queue-approx.sbd",
        "mlmc" => "srbm.mlmc",
        "generic_ctmc" => "queue.finite-ctmc",
        "fb_decomp" => "queue-approx.finite-decomposition",
        "truncated_ctmc" => "queue.infinite-truncated-ctmc",
        "adaptive_bar" => "srbm.adaptive-low-rank-bar",
        "bar_bounds" => "srbm.bar-moment-bounds",
        "regenerative_mc" => "queue.regenerative-mc",
        "product_form" => "queue.open-bcmp-product-form",
        "closed_pf" => "queue.closed-product-form",
        "sim_inproc" => "queue.des-replications",
        "priority_exact" => "queue.priority-exact",
        "batch_exact" => "queue.batch-arrival-exact",
        "qbd" => "queue.matrix-analytic-qbd",
        "cmp" | "inf_cmp" => "comparison.mixed",
        "testset" => "benchmark.test-set",
        "spc" => "benchmark.spectral-convergence",
        _ => return None,
    })
}

/// Foundation's `String.capitalized`: the first letter of each word upper-cased, every other letter
/// lower-cased.
///
/// Measured on Swift 6 (macOS 27): a word starts at a letter that does not follow a letter. Digits
/// and punctuation end a word ("mlmc2x" → "Mlmc2X", "x.y" → "X.Y", "a-b" → "A-B"), while an
/// apostrophe (straight or curly), a combining mark or a diaeresis inside a word does not
/// ("o'neil" → "O'neil", "don’t" → "Don’t"). One known difference: Foundation title-cases where a
/// title-case form exists (the digraph "ǆ" becomes "ǅ", the ligature "ﬁ" becomes "Fi"), and Rust's
/// standard library has only upper case, so those become "Ǆ" and "FI". Run labels are ASCII.
pub fn capitalize_like_swift(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_word = false;
    for c in text.chars() {
        if c.is_alphabetic() {
            if in_word {
                out.extend(c.to_lowercase());
            } else {
                out.extend(c.to_uppercase());
            }
            in_word = true;
        } else {
            out.push(c);
            let continues = matches!(c, '\'' | '\u{2019}' | '\u{00A8}') || ('\u{0300}'..='\u{036F}').contains(&c);
            if !(continues && in_word) {
                in_word = false;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_named_label_has_the_display_name_0_90_34_gave_it() {
        let cases = [
            ("inf_cmp", "Run Comparison"),
            ("cmp", "Run Comparison"),
            ("inf_sim", "Monte Carlo"),
            ("sim", "Monte Carlo"),
            ("inf_sm", "Spectral"),
            ("sm", "Spectral"),
            ("qna", "QNA"),
            ("rqna", "Robust QNA"),
            ("sbd", "SBD"),
            ("mlmc", "SRBM MLMC"),
            ("lp", "Linear Program"),
            ("flp", "Linear Program"),
            ("fm", "Finite Element"),
            ("mc", "Multi-class SRBM"),
            ("testset", "Test Set"),
            ("spc", "Spectral Convergence"),
            ("primitives", "Network Primitives"),
            ("analyze", "Analyze Network"),
        ];
        for (label, name) in cases {
            assert_eq!(display_label(label), name, "{label}");
        }
    }

    #[test]
    fn other_labels_are_title_cased_as_the_golden_runs_show() {
        // From golden/runs/*/summary.txt.
        assert_eq!(display_label("adaptive_bar"), "Adaptive Bar");
        assert_eq!(display_label("bar_bounds"), "Bar Bounds");
        assert_eq!(display_label("product_form"), "Product Form");
        assert_eq!(display_label("regenerative_mc"), "Regenerative Mc");
        assert_eq!(display_label("truncated_ctmc"), "Truncated Ctmc");
        assert_eq!(display_label("fb_decomp"), "Fb Decomp");
        assert_eq!(display_label("generic_ctmc"), "Generic Ctmc");
        assert_eq!(display_label("qbd"), "Qbd");
        assert_eq!(display_label("fin_cmp_fm"), "Fin Cmp Fm");
    }

    #[test]
    fn capitalisation_follows_foundation_word_boundaries() {
        // Each expected value was printed by Swift's `capitalized` on this machine.
        let cases = [
            ("hello-world", "Hello-World"),
            ("LP performance hints", "Lp Performance Hints"),
            ("x.y z", "X.Y Z"),
            ("ÉCOLE élève", "École Élève"),
            ("o'neil", "O'neil"),
            ("mlmc2x", "Mlmc2X"),
            ("3d view", "3D View"),
            ("a\tb", "A\tB"),
            ("ABC DEF", "Abc Def"),
            ("help:topic", "Help:Topic"),
            ("foo/bar", "Foo/Bar"),
            ("e2e test", "E2E Test"),
            ("don\u{2019}t", "Don\u{2019}t"),
            ("a\u{00B7}b", "A\u{00B7}B"),
            ("ab12cd", "Ab12Cd"),
            ("x\u{2014}y", "X\u{2014}Y"),
            ("ρ_max", "Ρ_Max"),
            ("αβγ δ", "Αβγ Δ"),
            ("a\u{0301}b", "A\u{0301}b"),
            ("aB'C", "Ab'c"),
            ("a\u{00A8}b", "A\u{00A8}b"),
            ("_x", "_X"),
            ("ab'", "Ab'"),
            ("'ab", "'Ab"),
        ];
        for (input, expected) in cases {
            assert_eq!(capitalize_like_swift(input), expected, "{input:?}");
        }
    }

    #[test]
    fn run_labels_map_to_the_result_method_identifiers_of_0_90_34() {
        let cases = [
            ("sim", "queue.des"),
            ("inf_sim", "queue.des"),
            ("sm", "srbm.spectral"),
            ("inf_sm", "srbm.spectral"),
            ("fm", "srbm.fem"),
            ("flp", "srbm.lp"),
            ("lp", "srbm.lp"),
            ("mc", "srbm.multiclass-station"),
            ("qna", "queue-approx.qna"),
            ("rqna", "queue-approx.rqna"),
            ("sbd", "queue-approx.sbd"),
            ("mlmc", "srbm.mlmc"),
            ("generic_ctmc", "queue.finite-ctmc"),
            ("fb_decomp", "queue-approx.finite-decomposition"),
            ("truncated_ctmc", "queue.infinite-truncated-ctmc"),
            ("adaptive_bar", "srbm.adaptive-low-rank-bar"),
            ("bar_bounds", "srbm.bar-moment-bounds"),
            ("regenerative_mc", "queue.regenerative-mc"),
            ("product_form", "queue.open-bcmp-product-form"),
            ("qbd", "queue.matrix-analytic-qbd"),
            ("cmp", "comparison.mixed"),
            ("inf_cmp", "comparison.mixed"),
            ("testset", "benchmark.test-set"),
            ("spc", "benchmark.spectral-convergence"),
        ];
        for (label, id) in cases {
            assert_eq!(result_method_identifier(label), Some(id), "{label}");
        }
    }

    #[test]
    fn utility_and_sub_run_labels_open_no_result_record() {
        for label in ["analyze", "primitives", "fin_cmp_fm", "inf_cmp_sm", "Help", ""] {
            assert_eq!(result_method_identifier(label), None, "{label}");
        }
    }
}
