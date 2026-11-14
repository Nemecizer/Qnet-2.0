//! The pieces of Foundation the 0.90.34 result parser (`ResultOutputParser.swift`) leaned on,
//! reproduced as that runtime behaved (measured on macOS 27.2, Swift 6.4.2) so that the parser reads
//! a solver's output exactly as 0.90.34 did:
//!
//! - a small backtracking matcher with `NSRegularExpression`'s (ICU's) semantics for the constructs
//!   the parser's patterns use. The patterns are built as trees in `parser.rs` rather than parsed
//!   from text. ICU's rules that matter here: `\d` is any Unicode decimal digit (Arabic-Indic digits
//!   match, and then fail `Double(...)`); `\s` is Unicode White_Space (including U+0085, U+00A0,
//!   U+2028, U+3000, but not U+200B or U+FEFF); `.` matches anything but `\n \v \f \r`, U+0085,
//!   U+2028 and U+2029; `^` is the start of the text (no multi-line option); `$` is the end, or just
//!   before one final line terminator (or `\r\n`); with the case-insensitive option a single
//!   literal character compares by simple case folding (so `s` also matches `ſ` and `k` the Kelvin
//!   sign), a run of two or more literal characters by full case folding (so "ß" matches "ss" and
//!   "ﬁ" matches "fi", but only when the expansion lies wholly inside the run), and a set such as
//!   `[sS]` is closed over case;
//! - Swift's `Double(String)` and `Int(String)`, which are stricter than C's `strtod` in some ways
//!   (no leading or trailing space, hexadecimal only with a lower-case `0x`) and looser in others
//!   (`inf`, `nan`, hexadecimal floats, the text ends at a NUL);
//! - `removingPercentEncoding`, which fails on a stray `%` or bytes that aren't UTF-8;
//! - `localizedCaseInsensitiveContains`, which folds case fully (ß = ss, ſ = s) and refuses a match
//!   whose last letter carries a combining mark ("no" is not in "nó").

use super::tables::{in_table, DECIMAL_DIGITS, NONBASE};

/// A pattern node. Literal runs are kept as ICU groups them, because case-insensitive matching of a
/// run differs from that of a single character (see the module comment).
#[derive(Clone, Debug)]
pub(crate) enum Node {
    /// A run of literal characters, as written in the Swift pattern between other constructs.
    Lit(&'static str),
    /// `\d`.
    Digit,
    /// `\s`.
    Space,
    /// `\S`.
    NotSpace,
    /// `.`.
    Any,
    /// A bracketed set of inclusive ranges; `true` negates it (`[^:]`).
    Set(&'static [(char, char)], bool),
    /// `^`.
    Start,
    /// `$`.
    End,
    /// A capturing group, numbered from 1 in the order of its opening parenthesis.
    Group(usize, Box<Node>),
    Seq(Vec<Node>),
    Alt(Vec<Node>),
    Repeat { node: Box<Node>, min: usize, max: Option<usize>, greedy: bool },
}

/// Builders, so pattern trees read close to the Swift patterns they port.
pub(crate) fn lit(s: &'static str) -> Node {
    Node::Lit(s)
}
pub(crate) fn seq(v: Vec<Node>) -> Node {
    Node::Seq(v)
}
pub(crate) fn alt(v: Vec<Node>) -> Node {
    Node::Alt(v)
}
pub(crate) fn group(n: usize, node: Node) -> Node {
    Node::Group(n, Box::new(node))
}
/// `x*`
pub(crate) fn star(node: Node) -> Node {
    Node::Repeat { node: Box::new(node), min: 0, max: None, greedy: true }
}
/// `x*?`
pub(crate) fn lazy_star(node: Node) -> Node {
    Node::Repeat { node: Box::new(node), min: 0, max: None, greedy: false }
}
/// `x+`
pub(crate) fn plus(node: Node) -> Node {
    Node::Repeat { node: Box::new(node), min: 1, max: None, greedy: true }
}
/// `x?`
pub(crate) fn opt(node: Node) -> Node {
    Node::Repeat { node: Box::new(node), min: 0, max: Some(1), greedy: true }
}
pub(crate) fn set(ranges: &'static [(char, char)]) -> Node {
    Node::Set(ranges, false)
}
pub(crate) fn not_set(ranges: &'static [(char, char)]) -> Node {
    Node::Set(ranges, true)
}

/// A compiled pattern: its tree, its number of capturing groups and whether it was built with
/// `.caseInsensitive`.
#[derive(Clone, Debug)]
pub(crate) struct Regex {
    root: Node,
    groups: usize,
    case_insensitive: bool,
}

type Caps = Vec<Option<(usize, usize)>>;

impl Regex {
    pub(crate) fn new(root: Node, groups: usize, case_insensitive: bool) -> Regex {
        Regex { root, groups, case_insensitive }
    }

    /// `firstMatch(in:range:)` over the whole text, turned into strings as the Swift parser's
    /// `strings(for:in:)` did: one entry per group (0 = the whole match), "" for a group that took
    /// no part. None when nothing matches.
    pub(crate) fn first_captures(&self, text: &[char]) -> Option<Vec<String>> {
        let (start, end, caps) = self.first_match(text, 0)?;
        let mut out = vec![text[start..end].iter().collect::<String>()];
        for c in caps.iter().skip(1) {
            out.push(c.map(|(a, b)| text[a..b].iter().collect()).unwrap_or_default());
        }
        Some(out)
    }

    /// The leftmost match starting at or after `from`: (start, end, captures).
    fn first_match(&self, text: &[char], from: usize) -> Option<(usize, usize, Caps)> {
        let firsts = first_chars(&self.root);
        let mut caps: Caps = vec![None; self.groups + 1];
        for start in from..=text.len() {
            // A pattern that must begin with a literal can't match where its first letter isn't.
            if let Some(firsts) = &firsts {
                match text.get(start) {
                    Some(&c) if firsts.iter().any(|&p| self.could_begin(c, p)) => {}
                    _ => continue,
                }
            }
            caps.iter_mut().for_each(|c| *c = None);
            let mut found = None;
            let ok = self.m(&self.root, text, start, &mut caps, &mut |e, c| {
                found = Some((e, c.clone()));
                true
            });
            if ok {
                let (end, mut caps) = found.unwrap();
                caps[0] = Some((start, end));
                return Some((start, end, caps));
            }
        }
        None
    }

    /// Whether text character `c` could begin a match of a literal starting with `p`.
    fn could_begin(&self, c: char, p: char) -> bool {
        if !self.case_insensitive {
            return c == p;
        }
        // Folding can only turn ASCII letters, the Kelvin sign, the long s, ß and the ligatures
        // into ASCII; let every non-ASCII character through to the full comparison.
        simple_fold(c) == simple_fold(p) || !c.is_ascii()
    }

    /// `stringByReplacingMatches(in:range:withTemplate: "")`: every non-overlapping match removed,
    /// scanning left to right.
    pub(crate) fn remove_all(&self, text: &[char]) -> Vec<char> {
        let mut out = Vec::with_capacity(text.len());
        let mut pos = 0;
        while pos <= text.len() {
            match self.first_match(text, pos) {
                Some((s, e, _)) => {
                    out.extend_from_slice(&text[pos..s]);
                    if e == s {
                        // An empty match removes nothing; step over one character.
                        if s < text.len() {
                            out.push(text[s]);
                        }
                        pos = s + 1;
                    } else {
                        pos = e;
                    }
                }
                None => {
                    out.extend_from_slice(&text[pos..]);
                    break;
                }
            }
        }
        out
    }

    /// Matches `node` at `pos`, then calls `k` with the end position; backtracks when `k` refuses.
    fn m(&self, node: &Node, t: &[char], pos: usize, caps: &mut Caps, k: &mut dyn FnMut(usize, &mut Caps) -> bool) -> bool {
        match node {
            Node::Lit(s) => match self.lit_at(s, t, pos) {
                Some(end) => k(end, caps),
                None => false,
            },
            Node::Digit => pos < t.len() && is_digit(t[pos]) && k(pos + 1, caps),
            Node::Space => pos < t.len() && is_space(t[pos]) && k(pos + 1, caps),
            Node::NotSpace => pos < t.len() && !is_space(t[pos]) && k(pos + 1, caps),
            Node::Any => pos < t.len() && !is_line_terminator(t[pos]) && k(pos + 1, caps),
            Node::Set(ranges, negated) => pos < t.len() && (self.set_has(ranges, t[pos]) != *negated) && k(pos + 1, caps),
            Node::Start => pos == 0 && k(pos, caps),
            Node::End => {
                let n = t.len();
                let at_end = pos == n
                    || (pos + 1 == n && is_line_terminator(t[pos]))
                    || (pos + 2 == n && t[pos] == '\r' && t[pos + 1] == '\n');
                at_end && k(pos, caps)
            }
            Node::Group(i, inner) => {
                let i = *i;
                let saved = caps[i];
                let ok = self.m(inner, t, pos, caps, &mut |e, c: &mut Caps| {
                    let before = c[i];
                    c[i] = Some((pos, e));
                    if k(e, c) {
                        return true;
                    }
                    c[i] = before;
                    false
                });
                if !ok {
                    caps[i] = saved;
                }
                ok
            }
            Node::Seq(items) => self.seq(items, t, pos, caps, k),
            Node::Alt(options) => options.iter().any(|o| self.m(o, t, pos, caps, k)),
            Node::Repeat { node, min, max, greedy } => self.repeat(node, *min, *max, *greedy, 0, t, pos, caps, k),
        }
    }

    fn seq(&self, items: &[Node], t: &[char], pos: usize, caps: &mut Caps, k: &mut dyn FnMut(usize, &mut Caps) -> bool) -> bool {
        match items.split_first() {
            None => k(pos, caps),
            Some((first, rest)) => self.m(first, t, pos, caps, &mut |e, c| self.seq(rest, t, e, c, k)),
        }
    }

    // The two orders differ: greedy tries one more iteration first, lazy the rest of the pattern.
    #[allow(clippy::too_many_arguments, clippy::if_same_then_else)]
    fn repeat(
        &self,
        node: &Node,
        min: usize,
        max: Option<usize>,
        greedy: bool,
        count: usize,
        t: &[char],
        pos: usize,
        caps: &mut Caps,
        k: &mut dyn FnMut(usize, &mut Caps) -> bool,
    ) -> bool {
        let can_more = max.is_none_or(|m| count < m);
        let more = |caps: &mut Caps, k: &mut dyn FnMut(usize, &mut Caps) -> bool| {
            can_more
                && self.m(node, t, pos, caps, &mut |e, c| {
                    // An iteration that consumed nothing ends the loop (ICU does the same).
                    e != pos && self.repeat(node, min, max, greedy, count + 1, t, e, c, k)
                })
        };
        if count < min {
            return more(caps, k);
        }
        if greedy {
            more(caps, k) || k(pos, caps)
        } else {
            k(pos, caps) || more(caps, k)
        }
    }

    /// The end of literal run `s` matched at `pos`, if it matches.
    fn lit_at(&self, s: &str, t: &[char], pos: usize) -> Option<usize> {
        if !self.case_insensitive {
            let mut j = pos;
            for p in s.chars() {
                if *t.get(j)? != p {
                    return None;
                }
                j += 1;
            }
            return Some(j);
        }
        let mut pat = s.chars();
        if let (Some(p), None) = (pat.next(), pat.next()) {
            return (pos < t.len() && simple_fold(t[pos]) == simple_fold(p)).then_some(pos + 1);
        }
        // A run: compare the full case folding of the text with the folded pattern; the last text
        // character's expansion must end with the run.
        let mut buf = ['\0'; 96];
        let mut len = 0;
        for c in s.chars() {
            for &f in Fold::of(c).chars() {
                buf[len] = f;
                len += 1;
            }
        }
        let folded = &buf[..len];
        let mut i = 0;
        let mut j = pos;
        while i < folded.len() {
            let exp = Fold::of(*t.get(j)?);
            let exp = exp.chars();
            if i + exp.len() > folded.len() || folded[i..i + exp.len()] != *exp {
                return None;
            }
            i += exp.len();
            j += 1;
        }
        Some(j)
    }

    fn set_has(&self, ranges: &[(char, char)], c: char) -> bool {
        let has = |x: char| ranges.iter().any(|&(lo, hi)| lo <= x && x <= hi);
        if has(c) {
            return true;
        }
        if !self.case_insensitive {
            return false;
        }
        let f = simple_fold(c);
        has(f) || has(f.to_ascii_uppercase())
    }
}

/// The characters a match of `node` must begin with, when it must begin with a literal.
fn first_chars(node: &Node) -> Option<Vec<char>> {
    match node {
        Node::Lit(s) => s.chars().next().map(|c| vec![c]),
        Node::Seq(items) => items.first().and_then(first_chars),
        Node::Group(_, inner) => first_chars(inner),
        Node::Alt(options) => {
            let mut all = vec![];
            for o in options {
                all.extend(first_chars(o)?);
            }
            Some(all)
        }
        Node::Repeat { node, min, .. } if *min > 0 => first_chars(node),
        _ => None,
    }
}

fn is_digit(c: char) -> bool {
    in_table(DECIMAL_DIGITS, c)
}

/// ICU's `\s`: Unicode White_Space.
pub(crate) fn is_space(c: char) -> bool {
    matches!(c as u32, 0x09..=0x0D | 0x20 | 0x85 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000)
}

/// The characters `.` refuses and `$` may stand before.
fn is_line_terminator(c: char) -> bool {
    matches!(c as u32, 0x0A..=0x0D | 0x85 | 0x2028 | 0x2029)
}

/// Simple case folding, as far as it can make a character equal to one in the parser's patterns
/// (all ASCII, plus "±"): ASCII upper case, the Kelvin sign and the long s. Measured: no other
/// scalar matched a case-insensitive single ASCII letter.
fn simple_fold(c: char) -> char {
    match c {
        '\u{212A}' => 'k',
        '\u{17F}' => 's',
        c => c.to_ascii_lowercase(),
    }
}

/// Full case folding, as far as it can produce the ASCII the patterns and sentinels are written in:
/// the simple folds plus ß and the Latin ligatures. Anything else folds to itself (it can't equal
/// ASCII text either way).
#[derive(Clone, Copy)]
struct Fold([char; 3], usize);

impl Fold {
    fn of(c: char) -> Fold {
        match c {
            '\u{DF}' | '\u{1E9E}' => Fold(['s', 's', ' '], 2),
            '\u{FB00}' => Fold(['f', 'f', ' '], 2),
            '\u{FB01}' => Fold(['f', 'i', ' '], 2),
            '\u{FB02}' => Fold(['f', 'l', ' '], 2),
            '\u{FB03}' => Fold(['f', 'f', 'i'], 3),
            '\u{FB04}' => Fold(['f', 'f', 'l'], 3),
            '\u{FB05}' | '\u{FB06}' => Fold(['s', 't', ' '], 2),
            c => Fold([simple_fold(c), ' ', ' '], 1),
        }
    }

    fn chars(&self) -> &[char] {
        &self.0[..self.1]
    }
}

/// Swift's `String.localizedCaseInsensitiveContains(_:)` for an ASCII `needle` (every caller's
/// needle is a fixed ASCII sentinel). Case folds fully on both sides; the match must not end in
/// the middle of a composed character (a combining mark after the last matched letter refuses it)
/// and must cover whole expansions (ß counts as "ss" only as a pair).
pub(crate) fn localized_ci_contains(hay: &str, needle: &str) -> bool {
    let n: Vec<char> = needle.chars().flat_map(|c| Fold::of(c).chars().to_vec()).collect();
    if n.is_empty() {
        return true;
    }
    let h: Vec<char> = hay.chars().collect();
    'start: for s in 0..h.len() {
        let mut i = 0;
        let mut j = s;
        while i < n.len() {
            let Some(&c) = h.get(j) else { continue 'start };
            let exp = Fold::of(c);
            let exp = exp.chars();
            if i + exp.len() > n.len() || n[i..i + exp.len()] != *exp {
                continue 'start;
            }
            i += exp.len();
            j += 1;
        }
        if h.get(j).is_some_and(|&c| in_table(NONBASE, c)) {
            continue;
        }
        return true;
    }
    false
}

/// Swift's `Double(String)` (Swift 6.4): an optional sign, then decimal digits with an optional
/// point and exponent, or `0x` (lower-case x only) hexadecimal digits with an optional point and
/// `p` exponent, or `inf`/`infinity`/`nan`/`nan(digits)` in any case. No surrounding space; the
/// text ends at its first NUL, as the C string Swift parses does. Overflow gives ±infinity.
pub fn swift_double(text: &str) -> Option<f64> {
    let text = text.split('\0').next().unwrap_or("");
    let (neg, body) = match text.as_bytes().first() {
        Some(b'+') => (false, &text[1..]),
        Some(b'-') => (true, &text[1..]),
        _ => (false, text),
    };
    let lower = body.to_ascii_lowercase();
    let value = if lower == "inf" || lower == "infinity" {
        f64::INFINITY
    } else if lower == "nan" || (lower.starts_with("nan(") && lower.ends_with(')') && nan_payload(&lower[4..lower.len() - 1])) {
        f64::NAN
    } else if let Some(hex) = body.strip_prefix("0x") {
        parse_hex(hex)?
    } else {
        if !decimal_grammar(body) {
            return None;
        }
        body.parse::<f64>().ok()?
    };
    Some(if neg { -value } else { value })
}

fn nan_payload(p: &str) -> bool {
    if let Some(h) = p.strip_prefix("0x") {
        !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit())
    } else {
        p.bytes().all(|b| b.is_ascii_digit())
    }
}

/// `digits[.digits*]` or `.digits`, then an optional `e[+-]digits`.
fn decimal_grammar(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let int_digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        frac_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac_digits;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp_digits == 0 {
            return false;
        }
        i += exp_digits;
    }
    i == b.len()
}

/// The part of a hexadecimal float after `0x`, correctly rounded (to nearest, ties to even).
fn parse_hex(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut mant: u64 = 0;
    let mut sticky = false;
    let mut exp: i64 = 0;
    let mut any = false;
    let mut push = |d: u64, after_point: bool, exp: &mut i64| {
        if mant >> 60 == 0 {
            mant = mant << 4 | d;
            if after_point {
                *exp -= 4;
            }
        } else {
            sticky |= d != 0;
            if !after_point {
                *exp += 4;
            }
        }
    };
    while i < b.len() && b[i].is_ascii_hexdigit() {
        push((b[i] as char).to_digit(16).unwrap() as u64, false, &mut exp);
        i += 1;
        any = true;
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        while i < b.len() && b[i].is_ascii_hexdigit() {
            push((b[i] as char).to_digit(16).unwrap() as u64, true, &mut exp);
            i += 1;
            any = true;
        }
    }
    if !any {
        return None;
    }
    if matches!(b.get(i), Some(b'p' | b'P')) {
        i += 1;
        let neg = match b.get(i) {
            Some(b'+') => {
                i += 1;
                false
            }
            Some(b'-') => {
                i += 1;
                true
            }
            _ => false,
        };
        let start = i;
        let mut e: i64 = 0;
        while i < b.len() && b[i].is_ascii_digit() {
            e = (e * 10 + (b[i] - b'0') as i64).min(1 << 40);
            i += 1;
        }
        if i == start {
            return None;
        }
        exp += if neg { -e } else { e };
    }
    if i != b.len() {
        return None;
    }
    Some(scale_binary(mant, sticky, exp))
}

/// `mant × 2^exp` (with `sticky` marking non-zero bits below `mant`), rounded to a double.
fn scale_binary(mut mant: u64, mut sticky: bool, mut exp: i64) -> f64 {
    if mant == 0 {
        return 0.0;
    }
    // Normalise to 64 significant bits.
    let lz = mant.leading_zeros() as i64;
    mant <<= lz;
    exp -= lz;
    // The value is mant × 2^exp with mant in [2^63, 2^64): its leading bit has weight 2^(exp+63).
    let top = exp + 63;
    if top > 1023 {
        return f64::INFINITY;
    }
    // Bits to keep: 53 for a normal result, fewer for a subnormal one.
    let keep: i64 = if top >= -1022 { 53 } else { 53 - (-1022 - top) };
    if keep <= 0 {
        // Below half the smallest subnormal, or exactly at it: rounds to zero, or up when above.
        let half = keep == 0 && (mant > 1 << 63 || (mant == 1 << 63 && sticky));
        return if half { f64::from_bits(1) } else { 0.0 };
    }
    let drop = 64 - keep;
    let kept = mant >> drop;
    let rest = mant & ((1u64 << drop) - 1);
    let half = 1u64 << (drop - 1);
    sticky |= rest & (half - 1) != 0;
    let round_up = rest & half != 0 && (sticky || kept & 1 == 1);
    let kept = kept + round_up as u64;
    // kept × 2^(exp + drop), exact in a double once rounded.
    let e = exp + drop;
    let v = kept as f64;
    // Multiply in two steps so neither factor overflows or underflows on the way.
    let half_e = e / 2;
    v * 2f64.powi(half_e as i32) * 2f64.powi((e - half_e) as i32)
}

/// Swift's `Int(String)`: an optional sign and ASCII digits, nothing else, within 64 bits.
pub fn swift_int(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // `i64::from_str` takes the same grammar.
    text.parse().ok()
}

/// `String.removingPercentEncoding`: None for a `%` not followed by two hex digits, or when the
/// decoded bytes aren't UTF-8.
pub fn removing_percent_encoding(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3)?;
            let v = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            if !hex.iter().all(|h| h.is_ascii_hexdigit()) {
                return None;
            }
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    /// Each answer is what Swift 6.4.2 gave on macOS 27.2.
    #[test]
    fn doubles_parse_as_swift_parses_them() {
        let cases: &[(&str, Option<f64>)] = &[
            ("0x1p3", Some(8.0)), ("0X1A", None), ("0x1A", Some(26.0)), ("0x1a", Some(26.0)), ("0X1p3", None), ("0x1P3", Some(8.0)),
            ("0x1.8p1", Some(3.0)), ("0x.8p1", Some(1.0)), ("-0x1p-2", Some(-0.25)), ("+0x1p-2", Some(0.25)), ("0x1", Some(1.0)),
            ("0x1.", Some(1.0)), ("0x.p1", None), ("0xp1", None), ("0x1p", None), ("0x1p+", None), ("0xg", None), ("0x1.8", Some(1.5)),
            ("0x1fffffffffffffp0", Some(9007199254740991.0)), ("0x10", Some(16.0)), ("0x 1", None), (" 1", None), ("1 ", None),
            ("1e400", Some(f64::INFINITY)), ("-1e400", Some(f64::NEG_INFINITY)), ("1e-400", Some(0.0)), ("1.", Some(1.0)), (".5", Some(0.5)),
            ("+.5", Some(0.5)), ("1e", None), ("١", None), ("", None), ("+", None), ("1_0", None), ("0x", None), ("1\0x", Some(1.0)),
            ("\u{0}1", None), ("infinit", None), ("1.5e+3", Some(1500.0)), ("00012", Some(12.0)), ("1e+", None), ("e5", None), (".", None),
            ("-.", None), ("1.e5", Some(100000.0)), ("1.e", None), ("+-1", None), ("1e+0005", Some(100000.0)), ("1E5", Some(100000.0)),
            ("1d5", None), ("1.0f", None), ("0.1e-1", Some(0.01)), ("1e99999999999", Some(f64::INFINITY)), ("0e99999999999", Some(0.0)),
            ("INF", Some(f64::INFINITY)), ("Infinity", Some(f64::INFINITY)), ("+inf", Some(f64::INFINITY)), ("-Infinity", Some(f64::NEG_INFINITY)),
            ("infx", None), ("1x", None), ("0x1\0zz", Some(1.0)),
        ];
        for (text, want) in cases {
            assert_eq!(swift_double(text), *want, "{text:?}");
        }
        for nan in ["nan", "NAN", "NaN(12)", "nan()", "nan(0x12)", "-nan", "+nan"] {
            assert!(swift_double(nan).unwrap().is_nan(), "{nan}");
        }
        for bad in ["nan(12a)", "nan("] {
            assert_eq!(swift_double(bad), None, "{bad}");
        }
        assert_eq!(swift_double("0x1p-1074"), Some(5e-324));
        assert_eq!(swift_double("0x1p-1075"), Some(0.0), "exactly half the smallest subnormal rounds to even (zero)");
        assert_eq!(swift_double("0x1.8p-1075"), Some(5e-324));
        assert_eq!(swift_double("0x1p1024"), Some(f64::INFINITY));
        assert_eq!(swift_double("0x1.fffffffffffff8p0"), Some(2.0), "a tie rounds to even");
        assert_eq!(swift_double("0x1.fffffffffffff7p0"), Some(f64::from_bits(0x3FFF_FFFF_FFFF_FFFF)));
    }

    #[test]
    fn integers_parse_as_swift_parses_them() {
        for (text, want) in [("+3", Some(3)), ("-0", Some(0)), ("٣", None), ("", None), ("+", None), ("99999999999999999999", None), ("03", Some(3)), (" 3", None), ("3 ", None)] {
            assert_eq!(swift_int(text), want, "{text:?}");
        }
    }

    #[test]
    fn percent_decoding_fails_as_foundation_fails() {
        for (text, want) in [
            ("s%31", Some("s1")), ("%", None), ("%2", None), ("%zz", None), ("a%20b", Some("a b")), ("%C3%A9", Some("é")), ("%C3", None),
            ("%FF", None), ("%e2%82%ac", Some("€")), ("plain", Some("plain")), ("%00x", Some("\0x")), ("100%", None), ("%+1", None),
        ] {
            assert_eq!(removing_percent_encoding(text).as_deref(), want, "{text:?}");
        }
    }

    /// Each answer is what `localizedCaseInsensitiveContains` gave (en_US, macOS 27.2).
    #[test]
    fn contains_folds_case_and_respects_composed_characters() {
        let n = "Certified: no";
        for (hay, want) in [
            ("Certified: no", true), ("CERTIFIED: NO", true), ("Certified: nó", false), ("Certified: no\u{301}", false), ("Certi\u{FB01}ed: no", true),
            ("Certified:  no", false), ("certified: noted", true), ("Ｃertified: no", false), ("Certi\u{AD}fied: no", false), ("Certi\u{200B}fied: no", false),
            ("Certified:\u{A0}no", false), ("\u{301}Certified: no", true), ("x\u{301}Certified: no", true), ("Certified: noß", true),
            ("Certified: no\u{200D}", true), ("CERTIF\u{130}ED: NO", false), ("Cert\u{131}fied: no", false), ("Certified: no\u{1F3FB}", false),
            ("Certified: NO\r\n", true), ("Certified: no\u{FE0F}", false),
        ] {
            assert_eq!(localized_ci_contains(hay, n), want, "{hay:?}");
        }
        assert!(localized_ci_contains("fallbac\u{212A}_used=yes", "fallback_used=yes"));
        assert!(localized_ci_contains("\u{17F}tatus", "status"));
        assert!(localized_ci_contains("partial=ye\u{17F}", "partial=yes"));
        assert!(!localized_ci_contains("fallback_used=ye", "fallback_used=yes"));
    }

    fn word(s: &'static str, ci: bool) -> Regex {
        Regex::new(group(1, lit(s)), 1, ci)
    }

    /// Each answer is what NSRegularExpression gave (macOS 27.2).
    #[test]
    fn literal_runs_fold_case_as_icu_folds_them() {
        let m = |re: &Regex, s: &str| re.first_captures(&chars(s)).map(|g| g[1].clone());
        assert_eq!(m(&word("sojourn", true), "\u{17F}ojourn").as_deref(), Some("\u{17F}ojourn"));
        assert_eq!(m(&word("blocks", true), "bloc\u{212A}s").as_deref(), Some("bloc\u{212A}s"));
        assert_eq!(m(&word("Certified", true), "Certi\u{FB01}ed").as_deref(), Some("Certi\u{FB01}ed"));
        assert_eq!(m(&word("Station", true), "\u{FB06}ation").as_deref(), Some("\u{FB06}ation"));
        assert_eq!(m(&word("ss", true), "\u{DF}").as_deref(), Some("\u{DF}"));
        assert_eq!(m(&word("ss", true), "\u{1E9E}").as_deref(), Some("\u{1E9E}"));
        assert_eq!(m(&word("ss", true), "S\u{17F}").as_deref(), Some("S\u{17F}"));
        assert_eq!(m(&word("ab", true), "a\u{FB00}"), None, "an expansion may not run past the literal");
        assert_eq!(m(&word("af", true), "\u{FB00}"), None);
        assert_eq!(m(&word("ff", true), "\u{FB00}x").as_deref(), Some("\u{FB00}"));
        assert_eq!(m(&word("f", true), "\u{FB00}"), None, "a single character folds simply");
        assert_eq!(m(&word("fi", true), "\u{FB03}"), None);
        assert_eq!(m(&word("Rank", true), "RAN\u{212A}").as_deref(), Some("RAN\u{212A}"));
        assert_eq!(m(&word("Rank", false), "RANK"), None);
        let s_set = Regex::new(group(1, set(&[('s', 's'), ('S', 'S')])), 1, true);
        assert_eq!(m(&s_set, "\u{17F}").as_deref(), Some("\u{17F}"), "a set is closed over case");
        let s_set_cs = Regex::new(group(1, set(&[('s', 's'), ('S', 'S')])), 1, false);
        assert_eq!(m(&s_set_cs, "\u{17F}"), None);
        let xqy = Regex::new(group(1, set(&[('X', 'X'), ('Q', 'Q'), ('Y', 'Y')])), 1, true);
        assert_eq!(m(&xqy, "x").as_deref(), Some("x"));
    }

    #[test]
    fn classes_and_anchors_follow_icu() {
        let is_match = |re: &Regex, s: &str| re.first_captures(&chars(s)).is_some();
        let a_space_b = Regex::new(seq(vec![lit("a"), Node::Space, lit("b")]), 0, false);
        for (c, want) in [
            (0x09, true), (0x0A, true), (0x0B, true), (0x0C, true), (0x0D, true), (0x20, true), (0x85, true), (0xA0, true), (0x1680, true),
            (0x180E, false), (0x2000, true), (0x200A, true), (0x200B, false), (0x2028, true), (0x2029, true), (0x202F, true), (0x205F, true),
            (0x3000, true), (0xFEFF, false), (0x1C, false), (0x1F, false),
        ] {
            let s = format!("a{}b", char::from_u32(c).unwrap());
            assert_eq!(is_match(&a_space_b, &s), want, "\\s and U+{c:04X}");
        }
        let a_dot_b = Regex::new(seq(vec![lit("a"), Node::Any, lit("b")]), 0, false);
        for (c, want) in [(0x0A, false), (0x0B, false), (0x0C, false), (0x0D, false), (0x85, false), (0x2028, false), (0x2029, false), (0x1C, true), (0x1E, true)] {
            let s = format!("a{}b", char::from_u32(c).unwrap());
            assert_eq!(is_match(&a_dot_b, &s), want, ". and U+{c:04X}");
        }
        let b_end = Regex::new(seq(vec![lit("b"), Node::End]), 0, false);
        for c in [0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029] {
            let t = char::from_u32(c).unwrap();
            assert!(is_match(&b_end, &format!("ab{t}")), "$ before one final U+{c:04X}");
            assert!(!is_match(&b_end, &format!("ab{t}{t}")), "but not before two");
        }
        assert!(is_match(&b_end, "ab\r\n"));
        let digits = Regex::new(group(1, plus(Node::Digit)), 1, false);
        assert_eq!(digits.first_captures(&chars("x١٢٣")).unwrap()[1], "١٢٣", "\\d is any decimal digit");
        assert_eq!(digits.first_captures(&chars("x１２")).unwrap()[1], "１２");
        let start = Regex::new(seq(vec![Node::Start, lit("a")]), 0, false);
        assert!(!is_match(&start, "\na"), "^ is the start of the text only");
    }

    #[test]
    fn removing_matches_scans_left_to_right() {
        let ansi = Regex::new(seq(vec![lit("\u{1B}["), star(set(&[('0', '?')])), star(set(&[(' ', '/')])), set(&[('@', '~')])]), 0, false);
        let out: String = ansi.remove_all(&chars("x\u{1B}[0;31mred\u{1B}[Kz\u{1B}[")).into_iter().collect();
        assert_eq!(out, "xredz\u{1B}[");
    }
}
