//! The display-precision filter: what the Shell pane shows of a run's output, with every decimal
//! number rewritten to Settings ▸ Output Format ▸ Output decimals.
//!
//! In 0.90.34 this was a perl program, `outputPrecisionProgram` in QnetGUIApp.swift, written to
//! `BNET_outfmt_<pid>.pl` by `outputPrecisionFilter(decimals:normalize:)` and run as the last stage
//! of each run wrapper's pipeline, after the `tee` that kept the full-precision archive. Under D1
//! the app starts the solvers itself, so 2.0 runs the same rules in-process (SH-083 and FILE-024,
//! Changed): a [`PrecisionFilter`] is fed the bytes a solver writes and returns the bytes to show.
//! The archive the result parser reads is never filtered, exactly as before.
//!
//! What is kept byte for byte (the perl program is the test oracle, `tests/output_precision.rs`):
//! records split after CR as well as LF, so progress frames pass through one by one; an
//! unterminated tail released after 50 ms of quiet unless it could still become a `QNET_`
//! sentinel or ends inside a number; `QNET_NODE_METRIC_V1` and `QNET_QBD_{METRIC,EVIDENCE,ERROR}_V1`
//! records hidden; the named float fields of every other `QNET_*_V1` record reformatted; the token
//! scope, the number rule and the column-alignment rules of `fmtnum`.
//!
//! The one deliberate difference is the clock. The perl program waited on `select` with a 50 ms
//! timeout; here the caller passes the time in (`feed`, `poll`) or asks for the idle release
//! directly (`release_idle`), so the timing can be driven by the supervisor's own loop and by
//! tests without sleeping.

use std::time::{Duration, Instant};

use crate::cfmt;

/// How long the stream must be quiet before an unterminated tail is shown (the perl program's
/// `select` timeout of 0.05 s).
pub const IDLE_RELEASE: Duration = Duration::from_millis(50);

/// The default of Settings ▸ Output Format ▸ Output decimals (`output.decimals`). Settings offers
/// 0…6; the filter accepts 0…9.
pub const DEFAULT_DECIMALS: i64 = 6;

/// Clamps a decimals setting to the 0…9 the filter accepts, as both `outputPrecisionFilter` and
/// the perl program did.
pub fn clamp_decimals(decimals: i64) -> u32 {
    decimals.clamp(0, 9) as u32
}

/// One run's display filter. Feed it the solver's bytes as they arrive; it returns what to show.
#[derive(Debug, Clone)]
pub struct PrecisionFilter {
    normalize: bool,
    rules: Rules,
    buf: Vec<u8>,
    last_input: Option<Instant>,
}

impl PrecisionFilter {
    /// A filter at `decimals` (clamped to 0…9). With `normalize` false it passes every byte through
    /// at once, untouched: 0.90.34 used a plain `cat` stage for runs whose output is prose rather
    /// than solver numbers.
    pub fn new(decimals: i64, normalize: bool) -> Self {
        PrecisionFilter { normalize, rules: Rules::new(clamp_decimals(decimals)), buf: Vec::new(), last_input: None }
    }

    /// The clamped number of fraction digits.
    pub fn decimals(&self) -> u32 {
        self.rules.d
    }

    /// Takes the next chunk of output that arrived at `now` and returns the display bytes of every
    /// record it completed (a record ends after its first CR or LF).
    pub fn feed(&mut self, chunk: &[u8], now: Instant) -> Vec<u8> {
        if !self.normalize {
            return chunk.to_vec();
        }
        self.last_input = Some(now);
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0;
        while let Some(i) = self.buf[start..].iter().position(|&b| b == b'\r' || b == b'\n') {
            let end = start + i + 1;
            self.rules.emit(&self.buf[start..end], &mut out);
            start = end;
        }
        self.buf.drain(..start);
        out
    }

    /// The bytes received but not yet shown (an unterminated tail).
    pub fn pending(&self) -> &[u8] {
        &self.buf
    }

    /// True when the pending tail must not be released yet: it could still grow into a `QNET_`
    /// sentinel, or it ends in a character that may be the middle of a number.
    pub fn is_holding(&self) -> bool {
        let b = &self.buf;
        if b.is_empty() {
            return false;
        }
        if b.starts_with(b"QNET_") || b"QNET_".starts_with(b) {
            return true;
        }
        matches!(b[b.len() - 1], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
    }

    /// When the caller should next call [`poll`](Self::poll): 50 ms after the last input, if a
    /// tail is pending and could be released. None when there is nothing to wait for (an empty or
    /// held tail waits for more input).
    pub fn idle_deadline(&self) -> Option<Instant> {
        if self.buf.is_empty() || self.is_holding() {
            return None;
        }
        self.last_input.map(|t| t + IDLE_RELEASE)
    }

    /// Releases the pending tail if the stream has been quiet for 50 ms at `now` and the tail is not
    /// held; otherwise returns nothing.
    pub fn poll(&mut self, now: Instant) -> Vec<u8> {
        match self.idle_deadline() {
            Some(t) if now >= t => self.release_idle(),
            _ => Vec::new(),
        }
    }

    /// What the perl program did when its 50 ms wait ran out: shows the pending tail as a record of
    /// its own, unless it is held. The caller decides that the stream has been idle.
    pub fn release_idle(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.normalize || self.buf.is_empty() || self.is_holding() {
            return out;
        }
        let rec = std::mem::take(&mut self.buf);
        self.rules.emit(&rec, &mut out);
        out
    }

    /// The end of the stream: shows whatever is still pending, held or not.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let rec = std::mem::take(&mut self.buf);
            self.rules.emit(&rec, &mut out);
        }
        out
    }
}

/// Filters a whole stream at once (feed everything, then finish): what the Shell would show if the
/// output arrived in one piece.
pub fn filter_all(input: &[u8], decimals: i64, normalize: bool) -> Vec<u8> {
    let mut f = PrecisionFilter::new(decimals, normalize);
    let now = Instant::now();
    let mut out = f.feed(input, now);
    out.extend(f.finish());
    out
}

/// The display form of one record (a line with its CR or LF, or a released tail), as `emit` printed
/// it; empty for a hidden sentinel.
pub fn filter_record(record: &[u8], decimals: i64) -> Vec<u8> {
    let mut out = Vec::new();
    Rules::new(clamp_decimals(decimals)).emit(record, &mut out);
    out
}

/// One number token as the filter rewrites it in prose (no padding, no column debt): the number
/// rule alone.
pub fn format_token(token: &str, decimals: i64) -> String {
    let mut r = Rules::new(clamp_decimals(decimals));
    String::from_utf8(r.fmtnum(b"", token.as_bytes(), true, false)).expect("ASCII")
}

/// The fixed rules at one setting, and the per-record state `fmtnum` keeps.
#[derive(Debug, Clone)]
struct Rules {
    /// Fraction digits, 0…9.
    d: u32,
    /// Mantissa digits of the scientific fallback, max(1, D − 1).
    e: u32,
    /// The lower threshold 10^−D, as perl parsed the literal "1e-D"; 0 at D = 0.
    t: f64,
    /// Characters the previous replacement on this record grew by and has not paid back.
    debt: usize,
    /// Set once a number on this record was introduced by '=', ':' or ',': the rest is prose.
    prose_run: bool,
}

const U: f64 = 1e9;

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Perl's `\s` on a byte string: space, \t, \n, \r, \f and \v.
fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0c | 0x0b)
}

fn digits_from(s: &[u8], i: usize) -> usize {
    s[i.min(s.len())..].iter().take_while(|b| b.is_ascii_digit()).count()
}

/// The end of `[eE][+-]?\d+` starting at `i`, when it matches.
fn exponent_end(s: &[u8], i: usize) -> Option<usize> {
    if i < s.len() && (s[i] == b'e' || s[i] == b'E') {
        let mut j = i + 1;
        if j < s.len() && (s[j] == b'+' || s[j] == b'-') {
            j += 1;
        }
        let n = digits_from(s, j);
        if n > 0 {
            return Some(j + n);
        }
    }
    None
}

/// Perl's numeric value of a token in the filter's grammar (`$tok + 0`).
fn perl_num(tok: &[u8]) -> f64 {
    let s = std::str::from_utf8(tok).expect("ASCII token");
    let (neg, body) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let (mant, exp) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], &body[i..]),
        None => (body, ""),
    };
    let mut m = String::new();
    if mant.starts_with('.') {
        m.push('0');
    }
    m.push_str(mant);
    if m.ends_with('.') {
        m.push('0');
    }
    let v: f64 = format!("{m}{exp}").parse().expect("a number token");
    if neg {
        -v
    } else {
        v
    }
}

/// Perl's `sprintf` of one double with a `%e` or `%f` conversion: C's, except that infinities print
/// as "Inf".
fn perl_sprintf(plus: bool, digits: u32, conv: char, v: f64) -> String {
    if v.is_infinite() {
        let sign = if v < 0.0 {
            "-"
        } else if plus {
            "+"
        } else {
            ""
        };
        return format!("{sign}Inf");
    }
    let flag = if plus { "+" } else { "" };
    cfmt::f(&format!("%{flag}.{digits}{conv}"), v)
}

/// One FIELD_RE match.
enum Field {
    /// An ANSI CSI escape, passed through.
    Ansi(usize),
    /// A number: the end of its optional '=', ':' or ',' prefix, of its pad, and of the token.
    Num { prefix_end: usize, pad_end: usize, end: usize },
}

impl Rules {
    fn new(d: u32) -> Self {
        let e = if d < 2 { 1 } else { d - 1 };
        let t = if d > 0 { format!("1e-{d}").parse().unwrap() } else { 0.0 };
        Rules { d, e, t, debt: 0, prose_run: false }
    }

    /// FIELD_RE at position `p` of `s`, as perl's backtracking matcher decides it.
    fn field_at(s: &[u8], p: usize) -> Option<Field> {
        // Branch 1: \e\[[0-?]*[ -\/]*[@-~]
        if s[p] == 0x1b && p + 1 < s.len() && s[p + 1] == b'[' {
            let mut j = p + 2;
            while j < s.len() && (0x30..=0x3f).contains(&s[j]) {
                j += 1;
            }
            while j < s.len() && (0x20..=0x2f).contains(&s[j]) {
                j += 1;
            }
            if j < s.len() && (0x40..=0x7e).contains(&s[j]) {
                return Some(Field::Ansi(j + 1));
            }
            return None;
        }
        // Branch 2: ([=:,]?)( *)(?<![\w.@/])(token)(?![\w%/])(?!\.\S). Without the prefix the match
        // would have to start at the prefix character itself, which no token can, so only the
        // greedy choice can succeed; likewise only the whole run of spaces.
        let prefix_end = if matches!(s[p], b'=' | b':' | b',') { p + 1 } else { p };
        let mut t = prefix_end;
        while t < s.len() && s[t] == b' ' {
            t += 1;
        }
        if t >= s.len() {
            return None;
        }
        if t > 0 {
            let b = s[t - 1];
            if is_word(b) || b == b'.' || b == b'@' || b == b'/' {
                return None;
            }
        }
        let mut i = t;
        if s[i] == b'+' || s[i] == b'-' {
            i += 1;
        }
        let n1 = digits_from(s, i);
        let mant_end = if n1 > 0 {
            let j = i + n1;
            if j < s.len() && s[j] == b'.' && digits_from(s, j + 1) > 0 {
                j + 1 + digits_from(s, j + 1)
            } else if j < s.len() && (s[j] == b'e' || s[j] == b'E') {
                j
            } else {
                return None;
            }
        } else if i < s.len() && s[i] == b'.' && digits_from(s, i + 1) > 0 {
            i + 1 + digits_from(s, i + 1)
        } else {
            return None;
        };
        let end = exponent_end(s, mant_end).unwrap_or(mant_end);
        if end < s.len() {
            let b = s[end];
            if is_word(b) || b == b'%' || b == b'/' {
                return None;
            }
            if b == b'.' && end + 1 < s.len() && !is_space(s[end + 1]) {
                return None;
            }
        }
        Some(Field::Num { prefix_end, pad_end: t, end })
    }

    /// Prints one record (`emit`).
    fn emit(&mut self, rec: &[u8], out: &mut Vec<u8>) {
        self.debt = 0;
        self.prose_run = false;
        if let Some(rest) = rec.strip_prefix(b"QNET_") {
            let hidden = [&b"NODE_METRIC_V1"[..], b"QBD_METRIC_V1", b"QBD_EVIDENCE_V1", b"QBD_ERROR_V1"];
            for h in hidden {
                if rest.starts_with(h) && !rest.get(h.len()).is_some_and(|&b| is_word(b)) {
                    return;
                }
            }
            // \AQNET_[A-Z0-9_]+_V1(?![A-Za-z0-9_]): the run of [A-Z0-9_] must end in "_V1" with at
            // least one character before it, and no lower-case letter may follow.
            let n = rest.iter().take_while(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || **b == b'_').count();
            if n >= 4 && rest[..n].ends_with(b"_V1") && !rest.get(n).is_some_and(|&b| is_word(b)) {
                self.rewrite_sentinel(rec, out);
                return;
            }
        }
        let mut fields = 0;
        let mut p = 0;
        while p < rec.len() {
            match Self::field_at(rec, p) {
                Some(Field::Ansi(end)) => p = end,
                Some(Field::Num { end, .. }) => {
                    fields += 1;
                    p = end;
                }
                None => p += 1,
            }
        }
        let lone = fields < 2;
        let mut p = 0;
        while p < rec.len() {
            match Self::field_at(rec, p) {
                Some(Field::Ansi(end)) => {
                    out.extend_from_slice(&rec[p..end]);
                    p = end;
                }
                Some(Field::Num { prefix_end, pad_end, end }) => {
                    out.extend_from_slice(&rec[p..prefix_end]);
                    if prefix_end > p {
                        self.prose_run = true;
                    }
                    let prose = self.prose_run;
                    let s = self.fmtnum(&rec[prefix_end..pad_end], &rec[pad_end..end], prose, lone);
                    out.extend(s);
                    p = end;
                }
                None => {
                    out.push(rec[p]);
                    p += 1;
                }
            }
        }
    }

    /// A shown sentinel: only the complete value of a named float field is rewritten, as prose.
    fn rewrite_sentinel(&mut self, s: &[u8], out: &mut Vec<u8>) {
        const KEYS: [&[u8]; 7] =
            [b"estimate", b"standard_error", b"ci_confidence", b"ci_low", b"ci_high", b"ci_half_width", b"effective_cycles"];
        let mut p = 0;
        'scan: while p < s.len() {
            if p == 0 || !is_word(s[p - 1]) {
                for key in KEYS {
                    if s[p..].starts_with(key) && s.get(p + key.len()) == Some(&b'=') {
                        let start = p + key.len() + 1;
                        // [+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?=[\s;,]|\z)
                        let mut i = start;
                        if i < s.len() && (s[i] == b'+' || s[i] == b'-') {
                            i += 1;
                        }
                        let n = digits_from(s, i);
                        let mant_end = if n > 0 {
                            let j = i + n;
                            if j < s.len() && s[j] == b'.' {
                                j + 1 + digits_from(s, j + 1)
                            } else {
                                j
                            }
                        } else if i < s.len() && s[i] == b'.' && digits_from(s, i + 1) > 0 {
                            i + 1 + digits_from(s, i + 1)
                        } else {
                            continue;
                        };
                        let end = exponent_end(s, mant_end).unwrap_or(mant_end);
                        if end == s.len() || is_space(s[end]) || s[end] == b';' || s[end] == b',' {
                            out.extend_from_slice(&s[p..start]);
                            let v = self.fmtnum(b"", &s[start..end], true, false);
                            out.extend(v);
                            p = end;
                            continue 'scan;
                        }
                    }
                }
            }
            out.push(s[p]);
            p += 1;
        }
    }

    /// Reformats one number behind its pad (`fmtnum`).
    fn fmtnum(&mut self, pad: &[u8], tok: &[u8], prose: bool, lone: bool) -> Vec<u8> {
        let mut pad = pad;
        if !prose && self.debt > 0 && pad.len() > 1 {
            let pay = (pad.len() - 1).min(self.debt);
            pad = &pad[pay..];
            self.debt -= pay;
        }
        let v = perl_num(tok);
        let plus = tok[0] == b'+';
        let (d, e, t) = (self.d, self.e, self.t);
        let mut sci = v != 0.0 && (v.abs() < t || v.abs() >= U);
        if !sci && d > 0 && v.abs() == t && tok == perl_sprintf(plus, e, 'e', v).as_bytes() {
            sci = true;
        }
        if sci && v.abs() == U && tok == perl_sprintf(plus, d, 'f', v).as_bytes() {
            sci = false;
        }
        let mut out = if sci {
            let mut digits = e;
            if tok.iter().any(|&b| b == b'e' || b == b'E') {
                let mantissa = &tok[..tok.iter().position(|&b| b == b'e' || b == b'E').unwrap()];
                let trailing = mantissa.iter().rev().take_while(|b| b.is_ascii_digit()).count();
                let have = if trailing > 0 && mantissa.len() > trailing && mantissa[mantissa.len() - trailing - 1] == b'.' {
                    trailing as u32
                } else {
                    0
                };
                if have < e {
                    digits = have;
                }
            }
            perl_sprintf(plus, digits, 'e', v)
        } else {
            perl_sprintf(plus, d, 'f', v)
        };
        // A displayed "-0.000000" reads as a sign error: \A-(0(?:\.0+)?)\z loses the sign.
        if let Some(rest) = out.strip_prefix('-') {
            let b = rest.as_bytes();
            if b == b"0" || (b.len() > 2 && b.starts_with(b"0.") && b[2..].iter().all(|&c| c == b'0')) {
                out = rest.to_string();
            }
        }
        let (lo, lt) = (out.len(), tok.len());
        let mut r = Vec::with_capacity(pad.len() + lt.max(lo));
        if prose || (lone && pad.len() < 2) {
            r.extend_from_slice(pad);
            r.extend_from_slice(out.as_bytes());
            return r;
        }
        if lo > lt {
            self.debt += lo - lt;
        }
        if !pad.is_empty() {
            r.extend_from_slice(pad);
            if lo < lt {
                r.resize(r.len() + (lt - lo), b' ');
            }
        }
        r.extend_from_slice(out.as_bytes());
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(s: &str, d: i64) -> String {
        String::from_utf8(filter_all(s.as_bytes(), d, true)).unwrap()
    }

    #[test]
    fn a_column_value_is_rounded_and_right_aligned_in_its_old_width() {
        assert_eq!(run("rho_1      0.70012345\n", 3), "rho_1           0.700\n");
    }

    #[test]
    fn identifiers_versions_paths_and_percentages_are_left_alone() {
        let s = "S1.2 v0.90.34 /tmp/x_3.4.sh python@3.11/lib (+1.2%) 7\n";
        assert_eq!(run(s, 6), s);
    }

    #[test]
    fn hidden_sentinels_vanish_and_others_rewrite_only_named_fields() {
        assert_eq!(run("QNET_NODE_METRIC_V1 estimate=1.5\n", 3), "");
        assert_eq!(
            run("QNET_MLMC_STATUS_V1 estimate=1 level=2.5 ci_low=0.12345\n", 3),
            "QNET_MLMC_STATUS_V1 estimate=1.000 level=2.5 ci_low=0.123\n"
        );
    }

    #[test]
    fn a_signed_zero_loses_its_sign_and_a_scientific_token_never_gains_digits() {
        assert_eq!(run("x = -0.0001\n", 2), "x = -1.0e-04\n");
        assert_eq!(run("x = -0.00001\n", 0), "x = 0\n");
        assert_eq!(run("x = 4.5e-09\n", 6), "x = 4.5e-09\n");
    }

    #[test]
    fn an_unterminated_number_is_held_until_more_arrives() {
        let mut f = PrecisionFilter::new(3, true);
        let t0 = Instant::now();
        assert!(f.feed(b"value 0.66", t0).is_empty());
        assert!(f.is_holding());
        assert!(f.poll(t0 + Duration::from_millis(100)).is_empty());
        let out = f.feed(b"6666\n", t0 + Duration::from_millis(200));
        assert_eq!(out, b"value 0.667\n");
    }

    #[test]
    fn a_quiet_tail_is_released_after_fifty_milliseconds() {
        let mut f = PrecisionFilter::new(3, true);
        let t0 = Instant::now();
        assert!(f.feed(b"Running ... 1.23456s", t0).is_empty());
        assert_eq!(f.idle_deadline(), Some(t0 + IDLE_RELEASE));
        assert!(f.poll(t0 + Duration::from_millis(49)).is_empty());
        assert_eq!(f.poll(t0 + Duration::from_millis(50)), b"Running ... 1.23456s");
    }

    #[test]
    fn decimals_are_clamped_and_normalize_false_passes_through() {
        assert_eq!(PrecisionFilter::new(42, true).decimals(), 9);
        assert_eq!(PrecisionFilter::new(-1, true).decimals(), 0);
        assert_eq!(filter_all(b"0.123456789\n", 3, false), b"0.123456789\n");
    }
}
