//! JSON as Qnet 0.90.34 read and wrote it, so a `.bnet` file round-trips byte for byte.
//!
//! 0.90.34 read documents with Foundation's `JSONDecoder` and wrote them with `JSONEncoder` set to
//! `[.prettyPrinted, .sortedKeys]`. This module reproduces both, as measured by running those two
//! classes on edge cases (macOS 27.2, Swift 6.4.2), not as JSON in general:
//!
//! Reading: the first of two duplicate keys wins; numbers keep their text, so an integer field
//! takes `1` or `1.0` but not `1.5`.
//!
//! Writing: two-space indent and `"key" : value`; keys in byte order; an empty object or array is
//! its brackets with an empty line between; `/` is escaped `\/`; `\b \f \n \r \t` by name and other
//! control characters as `\u00xx` (DEL and every non-ASCII character are written as they are); a
//! number whose value is a whole number of magnitude up to 2^53 is written as an integer (`1`,
//! `-0`), any other in its shortest round-trip digits, in exponent form (`1e-05`, `1.5e+16`) below
//! 1e-4 or from 2^53 up.

use std::collections::BTreeMap;

/// A JSON value. Objects keep keys sorted by byte (`BTreeMap`), which is `.sortedKeys`' order.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// A number as written in the file, so integer fields can be checked as Swift checks them.
    Number(String),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

impl Json {
    pub fn num(v: f64) -> Json {
        Json::Number(format_number(v))
    }

    pub fn int(v: i64) -> Json {
        Json::Number(v.to_string())
    }

    pub fn str(s: impl Into<String>) -> Json {
        Json::String(s.into())
    }

    pub fn as_object(&self) -> Option<&BTreeMap<String, Json>> {
        match self {
            Json::Object(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(a) => Some(a),
            _ => None,
        }
    }

    /// The value as a Double, as `JSONDecoder` reads one: any JSON number.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number(t) => t.parse::<f64>().ok(),
            _ => None,
        }
    }

    /// The value as an Int, as `JSONDecoder` reads one: a number whose value is a whole number in
    /// range. `1`, `1.0` and `1e2` are integers; `1.5` is not.
    pub fn as_i64(&self) -> Option<i64> {
        let Json::Number(t) = self else { return None };
        if let Ok(i) = t.parse::<i64>() {
            return Some(i);
        }
        let v = t.parse::<f64>().ok()?;
        (v.fract() == 0.0 && v >= -9.223_372_036_854_775_808e18 && v < 9.223_372_036_854_775_808e18).then_some(v as i64)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

/// Where and why a text isn't JSON.
#[derive(Clone, Debug, PartialEq)]
pub struct ParseError {
    pub offset: usize,
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (at byte {})", self.message, self.offset)
    }
}

/// Parses a JSON text. Duplicate keys: the first one wins, as in `JSONDecoder`.
pub fn parse(text: &str) -> Result<Json, ParseError> {
    let mut p = Parser { s: text.as_bytes(), i: 0 };
    // A UTF-8 byte-order mark is allowed before the value, as Foundation allows it.
    if p.s.starts_with(&[0xEF, 0xBB, 0xBF]) {
        p.i = 3;
    }
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err("Unexpected text after the JSON value"));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

const MAX_DEPTH: usize = 512;

impl Parser<'_> {
    fn err(&self, m: &str) -> ParseError {
        ParseError { offset: self.i, message: m.to_string() }
    }

    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &str) -> bool {
        if self.s[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, ParseError> {
        if depth > MAX_DEPTH {
            return Err(self.err("The JSON is nested too deeply"));
        }
        match self.s.get(self.i) {
            None => Err(self.err("Unexpected end of the JSON")),
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(Json::String(self.string()?)),
            Some(b't') if self.eat("true") => Ok(Json::Bool(true)),
            Some(b'f') if self.eat("false") => Ok(Json::Bool(false)),
            Some(b'n') if self.eat("null") => Ok(Json::Null),
            Some(c) if *c == b'-' || c.is_ascii_digit() => self.number(),
            Some(_) => Err(self.err("Unexpected character in the JSON")),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.i += 1;
        let mut m = BTreeMap::new();
        self.ws();
        if self.eat("}") {
            return Ok(Json::Object(m));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return Err(self.err("An object key must be a string"));
            }
            let k = self.string()?;
            self.ws();
            if !self.eat(":") {
                return Err(self.err("Expected “:” after an object key"));
            }
            self.ws();
            let v = self.value(depth + 1)?;
            m.entry(k).or_insert(v);
            self.ws();
            if self.eat(",") {
                continue;
            }
            if self.eat("}") {
                return Ok(Json::Object(m));
            }
            return Err(self.err("Expected “,” or “}” in an object"));
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.i += 1;
        let mut a = Vec::new();
        self.ws();
        if self.eat("]") {
            return Ok(Json::Array(a));
        }
        loop {
            self.ws();
            a.push(self.value(depth + 1)?);
            self.ws();
            if self.eat(",") {
                continue;
            }
            if self.eat("]") {
                return Ok(Json::Array(a));
            }
            return Err(self.err("Expected “,” or “]” in an array"));
        }
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.i;
        let digits = |p: &mut Parser| {
            let s = p.i;
            while p.i < p.s.len() && p.s[p.i].is_ascii_digit() {
                p.i += 1;
            }
            p.i > s
        };
        self.eat("-");
        if self.eat("0") {
        } else if !digits(self) {
            return Err(self.err("A number needs digits"));
        }
        if self.eat(".") && !digits(self) {
            return Err(self.err("A number needs digits after its point"));
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !digits(self) {
                return Err(self.err("A number needs digits in its exponent"));
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).unwrap().to_string();
        match text.parse::<f64>() {
            Ok(v) if v.is_finite() => Ok(Json::Number(text)),
            _ => Err(ParseError { offset: start, message: format!("Number {text} is not representable") }),
        }
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i] != b'"' && self.s[self.i] != b'\\' && self.s[self.i] >= 0x20 {
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.s[start..self.i]).map_err(|_| self.err("The text isn't UTF-8"))?);
            match self.s.get(self.i) {
                None => return Err(self.err("A string is not closed")),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = *self.s.get(self.i).ok_or_else(|| self.err("A string is not closed"))?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&hi) {
                                if !self.eat("\\u") {
                                    return Err(self.err("A lone surrogate in a string"));
                                }
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(self.err("A lone surrogate in a string"));
                                }
                                char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))
                            } else {
                                char::from_u32(hi)
                            };
                            out.push(ch.ok_or_else(|| self.err("A lone surrogate in a string"))?);
                        }
                        _ => return Err(self.err("Unknown escape in a string")),
                    }
                }
                Some(_) => return Err(self.err("A control character in a string")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, ParseError> {
        let h = self.s.get(self.i..self.i + 4).ok_or_else(|| self.err("A short \\u escape"))?;
        let v = u32::from_str_radix(std::str::from_utf8(h).unwrap_or("x"), 16).map_err(|_| self.err("A bad \\u escape"))?;
        self.i += 4;
        Ok(v)
    }
}

/// A Double as `JSONEncoder` writes it (see the module comment).
pub fn format_number(v: f64) -> String {
    const TWO_53: f64 = 9_007_199_254_740_992.0;
    let a = v.abs();
    if v.fract() == 0.0 && a <= TWO_53 {
        return format!("{v}");
    }
    if a < 1e-4 || a >= TWO_53 {
        return exponent_form(v);
    }
    crate::cfmt::ties_to_even(format!("{v}"), v)
}

/// `d[.ddd]e±XX` with the shortest round-trip digits and at least two exponent digits.
fn exponent_form(v: f64) -> String {
    let s = crate::cfmt::ties_to_even(format!("{v:e}"), v);
    let (mantissa, exp) = s.split_once('e').unwrap();
    let (sign, digits) = match exp.strip_prefix('-') {
        Some(d) => ('-', d),
        None => ('+', exp),
    };
    format!("{mantissa}e{sign}{digits:0>2}")
}

/// A Double as `JSONSerialization` writes an `NSNumber` holding one: `%.17g` ("0.10000000000000001",
/// "1e+17", "1", "-0"). Build `JSONSerialization` documents' doubles with this, their integers with
/// `Json::int`, and write them with `to_pretty_serialization`.
pub fn ns_double(v: f64) -> Json {
    Json::Number(crate::cfmt::f("%.17g", v))
}

/// How a writer orders keys and escapes `/`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Style {
    /// `JSONEncoder`'s `.sortedKeys` sorts by byte; `JSONSerialization`'s by Foundation's standard
    /// comparison (`ns_key_order`).
    foundation_key_order: bool,
    escape_slashes: bool,
}

/// Writes `v` as `JSONEncoder` with `[.prettyPrinted, .sortedKeys]` writes it.
pub fn to_pretty(v: &Json) -> String {
    write_styled(v, Style { foundation_key_order: false, escape_slashes: true })
}

/// Writes `v` as `JSONEncoder` with `[.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]`.
pub fn to_pretty_unescaped_slashes(v: &Json) -> String {
    write_styled(v, Style { foundation_key_order: false, escape_slashes: false })
}

/// Writes `v` as `JSONSerialization` with `[.prettyPrinted, .sortedKeys]` writes it: the same layout
/// and escapes as `to_pretty`, keys in `ns_key_order`. Numbers are written as given, so build
/// doubles with `ns_double`.
pub fn to_pretty_serialization(v: &Json) -> String {
    write_styled(v, Style { foundation_key_order: true, escape_slashes: true })
}

fn write_styled(v: &Json, style: Style) -> String {
    let mut out = String::new();
    write_value(&mut out, v, 0, style);
    out
}

/// The order `JSONSerialization`'s `.sortedKeys` puts keys in, as measured on macOS 27.2 for the
/// kinds of key Qnet writes: spaces and punctuation before digits, digits before letters; a run of
/// digits compared by its value; letters compared without case or (Latin) accent; ties broken by
/// accent, then lower case before upper, then the shorter digit run. Keys outside that (other
/// scripts, symbols) fall back to code-point order within their class.
pub fn ns_key_order(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    #[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Debug)]
    enum Unit {
        Punct(u32),
        Digits(u128, usize),
        Letter(char, u8, bool),
        Other(u32),
    }
    fn punct_rank(c: char) -> u32 {
        // Unicode collation's order for the punctuation that appears in keys.
        const ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
        ORDER.find(c).map(|i| i as u32).unwrap_or(1000 + c as u32)
    }
    fn fold(c: char) -> (char, u8) {
        let (base, accent) = match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => ('a', 1),
            'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => ('a', 1),
            'ç' | 'Ç' => ('c', 1),
            'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => ('e', 1),
            'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => ('i', 1),
            'ñ' | 'Ñ' => ('n', 1),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => ('o', 1),
            'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => ('u', 1),
            c => (c.to_lowercase().next().unwrap_or(c), 0),
        };
        (base, accent)
    }
    fn units(s: &str) -> Vec<Unit> {
        let cs: Vec<char> = s.chars().collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < cs.len() {
            let c = cs[i];
            if c.is_ascii_digit() {
                let start = i;
                while i < cs.len() && cs[i].is_ascii_digit() {
                    i += 1;
                }
                let run: String = cs[start..i].iter().collect();
                out.push(Unit::Digits(run.parse().unwrap_or(u128::MAX), run.len()));
                continue;
            }
            if c.is_alphabetic() {
                let (base, accent) = fold(c);
                out.push(Unit::Letter(base, accent, c.is_uppercase()));
            } else if c.is_ascii_punctuation() || c.is_whitespace() {
                out.push(Unit::Punct(punct_rank(c)));
            } else {
                out.push(Unit::Other(c as u32));
            }
            i += 1;
        }
        out
    }
    let (ua, ub) = (units(a), units(b));
    // Primary: punctuation rank, digit value, letter base; secondary: accent; tertiary: case, run length.
    let primary = |u: &Unit| match u {
        Unit::Punct(r) => (0u8, *r as u128, '\0'),
        Unit::Digits(v, _) => (1, *v, '\0'),
        Unit::Letter(c, _, _) => (2, 0, *c),
        Unit::Other(c) => (3, *c as u128, '\0'),
    };
    for level in 0..3 {
        for (x, y) in ua.iter().zip(ub.iter()) {
            let o = match level {
                0 => primary(x).cmp(&primary(y)),
                1 => match (x, y) {
                    (Unit::Letter(_, p, _), Unit::Letter(_, q, _)) => p.cmp(q),
                    _ => Ordering::Equal,
                },
                _ => match (x, y) {
                    (Unit::Letter(_, _, p), Unit::Letter(_, _, q)) => p.cmp(q),
                    (Unit::Digits(_, p), Unit::Digits(_, q)) => p.cmp(q),
                    _ => Ordering::Equal,
                },
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        if level == 0 && ua.len() != ub.len() {
            return ua.len().cmp(&ub.len());
        }
    }
    a.cmp(b)
}

fn indent(out: &mut String, level: usize) {
    for _ in 0..level {
        out.push_str("  ");
    }
}

fn write_value(out: &mut String, v: &Json, level: usize, style: Style) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Number(t) => out.push_str(t),
        Json::String(s) => write_string(out, s, style.escape_slashes),
        Json::Array(a) => {
            out.push_str("[\n");
            if a.is_empty() {
                out.push('\n');
            }
            for (i, x) in a.iter().enumerate() {
                indent(out, level + 1);
                write_value(out, x, level + 1, style);
                out.push_str(if i + 1 < a.len() { ",\n" } else { "\n" });
            }
            indent(out, level);
            out.push(']');
        }
        Json::Object(m) => {
            out.push_str("{\n");
            if m.is_empty() {
                out.push('\n');
            }
            let mut entries: Vec<(&String, &Json)> = m.iter().collect();
            if style.foundation_key_order {
                entries.sort_by(|(a, _), (b, _)| ns_key_order(a, b));
            }
            let n = entries.len();
            for (i, (k, x)) in entries.into_iter().enumerate() {
                indent(out, level + 1);
                write_string(out, k, style.escape_slashes);
                out.push_str(" : ");
                write_value(out, x, level + 1, style);
                out.push_str(if i + 1 < n { ",\n" } else { "\n" });
            }
            indent(out, level);
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, s: &str, escape_slashes: bool) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '/' if escape_slashes => out.push_str("\\/"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each pair is what Swift's JSONEncoder wrote for that Double (probe run on macOS 27.2).
    #[test]
    fn numbers_are_written_as_swifts_json_encoder_writes_them() {
        let cases: &[(f64, &str)] = &[
            (1.0, "1"), (0.5, "0.5"), (1e-5, "1e-05"), (0.0001, "0.0001"), (1e15, "1000000000000000"), (1e16, "1e+16"),
            (1.5e16, "1.5e+16"), (123456789012345678.0, "1.2345678901234568e+17"), (-0.0, "-0"), (2.5e-7, "2.5e-07"),
            (1e21, "1e+21"), (0.1 + 0.2, "0.30000000000000004"), (9007199254740992.0, "9007199254740992"), (1e-300, "1e-300"),
            (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (100.0, "100"), (-3.25, "-3.25"),
            (9.5e15, "9.5e+15"), (9007199254740994.0, "9.007199254740994e+15"), (9.999999999999998e15, "9.999999999999998e+15"),
            (4503599627370497.5, "4503599627370498"), (0.00011, "0.00011"), (0.000099999, "9.9999e-05"), (123456789.125, "123456789.125"),
            (-1e-5, "-1e-05"), (12345678901234.5, "12345678901234.5"), (0.1, "0.1"), (3.0e-5, "3e-05"),
            (144.5227864583333, "144.5227864583333"), (168.07040550595244, "168.07040550595244"),
        ];
        for (v, want) in cases {
            assert_eq!(format_number(*v), *want, "{v:e}");
        }
    }

    #[test]
    fn strings_escape_what_swift_escapes_and_nothing_else() {
        let mut s = String::new();
        write_string(&mut s, "a/b \"q\" \\ \u{1} é \t\n ü 😀", true);
        assert_eq!(s, r#""a\/b \"q\" \\ \u0001 é \t\n ü 😀""#);
        s.clear();
        write_string(&mut s, "\r\u{8}\u{c}\u{1f}\u{7f}\u{2028}<>&'", true);
        assert_eq!(s, "\"\\r\\b\\f\\u001f\u{7f}\u{2028}<>&'\"");
    }

    #[test]
    fn pretty_output_matches_swift_layout_with_empty_containers_and_sorted_keys() {
        let mut keys = BTreeMap::new();
        for (k, v) in [("b", 1), ("B", 2), ("a", 3), ("A10", 4), ("A2", 5), ("_x", 6), ("Z", 7)] {
            keys.insert(k.to_string(), Json::int(v));
        }
        let mut dict = BTreeMap::new();
        for (k, v) in [("10", "ten"), ("2", "two"), ("1", "one")] {
            dict.insert(k.to_string(), Json::str(v));
        }
        let mut top = BTreeMap::new();
        top.insert("dict".into(), Json::Object(dict));
        top.insert("empty".into(), Json::Object(BTreeMap::new()));
        top.insert("emptyArr".into(), Json::Array(vec![]));
        top.insert("keys".into(), Json::Object(keys));
        top.insert("nested".into(), Json::Array(vec![Json::Array(vec![Json::num(1.0), Json::num(2.0)]), Json::Array(vec![])]));
        let want = "{\n  \"dict\" : {\n    \"1\" : \"one\",\n    \"10\" : \"ten\",\n    \"2\" : \"two\"\n  },\n  \"empty\" : {\n\n  },\n  \"emptyArr\" : [\n\n  ],\n  \"keys\" : {\n    \"A10\" : 4,\n    \"A2\" : 5,\n    \"B\" : 2,\n    \"Z\" : 7,\n    \"_x\" : 6,\n    \"a\" : 3,\n    \"b\" : 1\n  },\n  \"nested\" : [\n    [\n      1,\n      2\n    ],\n    [\n\n    ]\n  ]\n}";
        assert_eq!(to_pretty(&Json::Object(top)), want);
    }

    #[test]
    fn reading_keeps_the_first_duplicate_and_takes_whole_numbers_as_integers() {
        let v = parse(r#"{"i": 2, "i": 3, "f": 1.0, "g": 1.5, "e": 1e2, "s": "a\/bé😀"}"#).unwrap();
        let m = v.as_object().unwrap();
        assert_eq!(m["i"].as_i64(), Some(2), "the first duplicate wins, as in JSONDecoder");
        assert_eq!(m["f"].as_i64(), Some(1));
        assert_eq!(m["g"].as_i64(), None, "1.5 is not an Int");
        assert_eq!(m["e"].as_i64(), Some(100));
        assert_eq!(m["s"].as_str(), Some("a/bé😀"));
        assert!(parse("{\"a\": 1,}").is_err());
        assert!(parse("[1e999]").is_err(), "a number too large for a Double is refused, as Foundation refuses it");
        assert!(parse("\u{feff}{}").is_ok(), "a byte-order mark is allowed");
    }

    /// The order JSONSerialization's .sortedKeys gave these keys (probe run on macOS 27.2).
    #[test]
    fn serialization_keys_sort_as_foundation_sorts_them() {
        let want = ["_x", "1", "01", "1a", "2", "10", "a", "A", "a b", "a_b", "a-b", "a2", "a10", "aa", "alpha", "Alpha", "b", "B", "beta", "drift", "Drift", "é", "model_type", "schema_version", "x1y", "X1Y", "z", "Z"];
        let mut got: Vec<&str> = want.iter().rev().copied().collect();
        got.sort_by(|a, b| ns_key_order(a, b));
        assert_eq!(got, want);
    }

    /// Each pair is what JSONSerialization wrote for that Double (probe run on macOS 27.2).
    #[test]
    fn serialization_doubles_are_percent_17g() {
        for (v, want) in [(1.0, "1"), (0.5, "0.5"), (1e-5, "1.0000000000000001e-05"), (1e16, "10000000000000000"), (1e17, "1e+17"), (-0.0, "-0"), (0.1, "0.10000000000000001"), (5e-324, "4.9406564584124654e-324"), (123.456, "123.456"), (1e300, "1.0000000000000001e+300")] {
            assert_eq!(ns_double(v), Json::Number(want.into()), "{v:e}");
        }
        let mut m = BTreeMap::new();
        m.insert("s".to_string(), Json::str("a/b"));
        assert_eq!(to_pretty_unescaped_slashes(&Json::Object(m.clone())), "{\n  \"s\" : \"a/b\"\n}");
        assert_eq!(to_pretty_serialization(&Json::Object(m)), "{\n  \"s\" : \"a\\/b\"\n}");
    }

}
