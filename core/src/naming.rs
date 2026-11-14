//! The one place a node name's number is read (0.90.34 `NodeNaming.swift`).
//!
//! Stations, sources and buffers are numbered by the digits in their names ("S2" → 2, "Src10" →
//! 10), and every exporter and every solver's output vector follows that order. The rule is
//! Swift's `Int(name.drop(while: { !$0.isNumber }))`: skip to the first character that is a number,
//! and read everything from there as an integer, or nothing if the rest isn't one ("S2a", "CPU").

/// The number in a node name, or None when there is none.
pub fn numeric_suffix(name: &str) -> Option<i64> {
    let start = name.char_indices().find(|(_, c)| c.is_numeric()).map(|(i, _)| i)?;
    let rest = &name[start..];
    // Int(String) takes ASCII digits after an optional sign; the drop leaves no sign, so digits only.
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok()
}

/// The sort key every exporter uses: a name without a number sorts last.
pub fn sort_index(name: &str) -> i64 {
    numeric_suffix(name).unwrap_or(i64::MAX)
}

/// True when the names don't give one order: a name without a number, or two with the same one.
/// A caller labelling an index-ordered solver vector then falls back to "S1 … Sn".
pub fn order_is_ambiguous<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    let suffixes: Vec<Option<i64>> = names.into_iter().map(numeric_suffix).collect();
    if suffixes.iter().any(|s| s.is_none()) {
        return true;
    }
    let mut seen: Vec<i64> = suffixes.into_iter().flatten().collect();
    let n = seen.len();
    seen.sort_unstable();
    seen.dedup();
    seen.len() != n
}

/// `items` in export order: by `sort_index` of the name, ties kept in document order (Swift's
/// `sorted` is stable, and so is this).
pub fn in_export_order<'a, T>(items: impl IntoIterator<Item = &'a T>, name: impl Fn(&T) -> &str) -> Vec<&'a T> {
    let mut v: Vec<&T> = items.into_iter().collect();
    v.sort_by_key(|t| sort_index(name(t)));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_number_is_everything_from_the_first_digit_on() {
        assert_eq!(numeric_suffix("S2"), Some(2));
        assert_eq!(numeric_suffix("Src10"), Some(10));
        assert_eq!(numeric_suffix("Sink 007"), Some(7));
        assert_eq!(numeric_suffix("S-2"), Some(2), "the drop skips the sign too");
        assert_eq!(numeric_suffix("S2a"), None, "Int(\"2a\") is nil");
        assert_eq!(numeric_suffix("CPU"), None);
        assert_eq!(numeric_suffix("S99999999999999999999"), None, "too large for an Int");
        assert_eq!(sort_index("CPU"), i64::MAX);
    }

    #[test]
    fn names_without_numbers_or_with_repeats_make_the_order_ambiguous() {
        assert!(!order_is_ambiguous(["S1", "S2", "S10"]));
        assert!(order_is_ambiguous(["S1", "Disk"]));
        assert!(order_is_ambiguous(["S1", "T1"]));
        let names = ["S10", "S2", "X", "S2b", "S1"];
        let sorted: Vec<&&str> = in_export_order(names.iter(), |s| s);
        assert_eq!(sorted, [&"S1", &"S2", &"S10", &"X", &"S2b"], "unnumbered names last, in document order");
    }
}
