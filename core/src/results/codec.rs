//! The JSON details of 0.90.34's results file that `json.rs` doesn't cover: `JSONEncoder` without
//! pretty printing (the store writes `[.sortedKeys]` only, and so does the network fingerprint),
//! dates as `.iso8601` writes and reads them, UUIDs as `UUID(uuidString:)` reads them, and the
//! strict field readers Swift's synthesized `Decodable` amounts to.
//!
//! Measured with Swift 6.4.2 on macOS 27.2:
//!
//! - Compact output is the pretty form without its whitespace: `{"a":1,"b":[]}`, keys in byte
//!   order, `/` written `\/`, the same number and string forms as `json::to_pretty`.
//! - A date is written `yyyy-MM-ddTHH:mm:ssZ` in UTC, the fraction of a second dropped (rounded
//!   down, also before 1970). Reading is lenient, and this port accepts the same broad forms:
//!   1- or more-digit fields, a fraction of a second, `Z`/`z`, `GMT`/`UTC` with or without an
//!   offset, or an offset `±H`, `±HH`, `±HHMM`, `±HH:MM`, `±HH:MM:SS` up to 18 hours, with any text
//!   after the zone ignored; hours, minutes and seconds past their range roll over. It refuses what
//!   Foundation refused: no time zone, no seconds, a lower-case `t`, a sign before the year, a
//!   month outside 1…12, a day outside 1…31, a `,` fraction, spaces. Not reproduced: Foundation's
//!   odd arithmetic for a day past the month's end (it read 31 November as 21 days later, this
//!   reads it as 1 December), which never occurs in a file 0.90.34 wrote. Dates before 15 October
//!   1582 are Julian, as in Foundation's Gregorian calendar.
//! - A UUID is 8-4-4-4-12 hex digits in either case and is kept in upper case, as Swift writes it.

use std::collections::BTreeMap;

use crate::json::Json;

/// Seconds between 1970-01-01 and Swift's reference date, 2001-01-01 (UTC).
const REFERENCE_FROM_1970: f64 = 978_307_200.0;

/// A point in time as Swift's `Date` holds one: seconds since 2001-01-01 00:00:00 UTC, as a Double,
/// so differences (`elapsedSeconds`) come out as 0.90.34 computed them.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Date {
    pub since_reference: f64,
}

impl Date {
    pub fn from_unix(seconds: f64) -> Date {
        Date { since_reference: seconds - REFERENCE_FROM_1970 }
    }

    pub fn unix(self) -> f64 {
        self.since_reference + REFERENCE_FROM_1970
    }

    /// The current time, as `Date()` gives it.
    pub fn now() -> Date {
        let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        Date::from_unix(d.as_secs_f64())
    }

    /// `timeIntervalSince(_:)`.
    pub fn seconds_since(self, other: Date) -> f64 {
        self.since_reference - other.since_reference
    }

    /// The date as `JSONEncoder.dateEncodingStrategy = .iso8601` writes it.
    pub fn iso8601(self) -> String {
        // Whole seconds, rounded down in Swift's own reference space (adding the 1970 offset
        // first could round a time just short of a second up to it).
        let secs = self.since_reference.floor() + REFERENCE_FROM_1970;
        let days = (secs / 86_400.0).floor();
        let rem = (secs - days * 86_400.0) as i64;
        let (y, m, d) = civil_from_days(days as i64);
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, rem / 3600, rem / 60 % 60, rem % 60)
    }

    /// Reads a date as `JSONDecoder.dateDecodingStrategy = .iso8601` reads one (see the module
    /// comment for what is accepted).
    pub fn parse_iso8601(text: &str) -> Option<Date> {
        let b = text.as_bytes();
        let mut i = 0;
        let number = |i: &mut usize| -> Option<i64> {
            let start = *i;
            let mut v: i64 = 0;
            while *i < b.len() && b[*i].is_ascii_digit() {
                v = v.checked_mul(10)?.checked_add((b[*i] - b'0') as i64)?;
                *i += 1;
            }
            (*i > start).then_some(v)
        };
        let expect = |i: &mut usize, c: u8| -> Option<()> {
            (b.get(*i) == Some(&c)).then(|| *i += 1)
        };
        let year = number(&mut i)?;
        expect(&mut i, b'-')?;
        let month = number(&mut i)?;
        expect(&mut i, b'-')?;
        let day = number(&mut i)?;
        expect(&mut i, b'T')?;
        let hour = number(&mut i)?;
        expect(&mut i, b':')?;
        let minute = number(&mut i)?;
        expect(&mut i, b':')?;
        let second = number(&mut i)?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || year > 1_000_000 {
            return None;
        }
        let mut fraction = 0.0;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i == start {
                return None;
            }
            fraction = format!("0.{}", &text[start..i]).parse().ok()?;
        }
        let rest = &text[i..];
        let offset = if rest.starts_with(['Z', 'z']) {
            0
        } else if rest.len() >= 3 && (rest[..3].eq_ignore_ascii_case("GMT") || rest[..3].eq_ignore_ascii_case("UTC")) {
            if rest[3..].starts_with(['+', '-']) {
                offset_seconds(&rest[3..])?
            } else {
                0
            }
        } else if rest.starts_with(['+', '-']) {
            offset_seconds(rest)?
        } else {
            return None;
        };
        let days = days_from_civil(year, month, day);
        let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset - REFERENCE_FROM_1970 as i64;
        Some(Date { since_reference: seconds as f64 + fraction })
    }
}

/// `±H[H][[:]M[M][[:]S[S]]]` in seconds east of UTC; None past 18 hours or for a dangling colon.
fn offset_seconds(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let sign = if b[0] == b'-' { -1 } else { 1 };
    let mut i = 1;
    let part = |i: &mut usize| -> Option<i64> {
        let start = *i;
        let mut v = 0;
        while *i < b.len() && *i - start < 2 && b[*i].is_ascii_digit() {
            v = v * 10 + (b[*i] - b'0') as i64;
            *i += 1;
        }
        (*i > start).then_some(v)
    };
    let hours = part(&mut i)?;
    if hours > 18 {
        return None;
    }
    let mut total = hours * 3600;
    for scale in [60, 1] {
        if b.get(i) == Some(&b':') {
            i += 1;
            total += part(&mut i)? * scale;
        } else if let Some(v) = part(&mut i) {
            total += v * scale;
        } else {
            break;
        }
    }
    Some(sign * total)
}

/// The first day of the Gregorian calendar, 1582-10-15, in days since 1970. Foundation's
/// Gregorian calendar counts earlier dates in the Julian calendar, and so does this.
const GREGORIAN_CUTOVER: i64 = -141_427;

/// Days since 1970-01-01 of a calendar date: Gregorian from 1582-10-15, Julian before.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let gregorian = days_from_gregorian(y, m, d);
    if gregorian >= GREGORIAN_CUTOVER {
        gregorian
    } else {
        days_from_julian(y, m, d)
    }
}

/// The calendar date of a day since 1970-01-01 (Julian before the cutover).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    if z >= GREGORIAN_CUTOVER {
        gregorian_from_days(z)
    } else {
        julian_from_days(z)
    }
}

/// Proleptic Gregorian (Howard Hinnant's algorithms).
fn days_from_gregorian(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn gregorian_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// Proleptic Julian: the same March-based count with a four-year cycle of 1461 days.
fn days_from_julian(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(4);
    let yoe = y - era * 4;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    // Day 0 is 0000-03-01 Julian, which is 719_470 days before 1970-01-01.
    era * 1461 + yoe * 365 + doy - 719_470
}

fn julian_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_470;
    let era = z.div_euclid(1461);
    let doe = z - era * 1461;
    let yoe = ((doe - doe / 1460) / 365).min(3);
    let doy = doe - 365 * yoe;
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 4 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// `UUID(uuidString:)`: 8-4-4-4-12 hex digits in either case, returned in upper case.
pub fn parse_uuid(s: &str) -> Option<String> {
    let groups: Vec<&str> = s.split('-').collect();
    let ok = groups.len() == 5 && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()));
    ok.then(|| s.to_ascii_uppercase())
}

/// A new random (version 4) UUID in upper case, as `UUID().uuidString` gives one.
pub fn random_uuid() -> String {
    use std::io::Read;
    let mut b = [0u8; 16];
    let read = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    if read.is_err() {
        // No random device: mix the clock, the process and a counter through SHA-256.
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let seed = format!("{:?}{}{}", std::time::SystemTime::now(), std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
        b.copy_from_slice(&super::sha256::digest(seed.as_bytes())[..16]);
    }
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// A Double as `JSONEncoder` writes it: `json::format_number`, which breaks an exact tie between
/// two shortest digit strings to the even digit as Swift does (`cfmt::ties_to_even`; measured on
/// an elapsed time 0.90.34 wrote as `1.0023269653320312`).
pub fn number(v: f64) -> Json {
    Json::Number(crate::json::format_number(v))
}

/// Writes `v` as `JSONEncoder` with `.sortedKeys` and no pretty printing writes it.
pub fn to_compact(v: &Json) -> String {
    let mut out = String::new();
    write_compact(&mut out, v);
    out
}

fn write_compact(out: &mut String, v: &Json) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Number(t) => out.push_str(t),
        Json::String(s) => write_string(out, s),
        Json::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_compact(out, x);
            }
            out.push(']');
        }
        Json::Object(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_compact(out, x);
            }
            out.push('}');
        }
    }
}

/// A string as `JSONEncoder` escapes it (the same rules as `json::to_pretty`).
fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '/' => out.push_str("\\/"),
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

/// Why a results file, or part of one, doesn't decode: the path to the field ("records[2].status")
/// and what Swift's decoder would have objected to.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodeError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

impl std::error::Error for DecodeError {}

pub(crate) fn err<T>(path: &str, message: impl Into<String>) -> Result<T, DecodeError> {
    Err(DecodeError { path: path.to_string(), message: message.into() })
}

pub(crate) fn at(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// A keyed container: the object at `path`.
pub(crate) struct Obj<'a> {
    pub map: &'a BTreeMap<String, Json>,
    pub path: String,
}

impl<'a> Obj<'a> {
    pub fn of(v: &'a Json, path: &str) -> Result<Obj<'a>, DecodeError> {
        match v {
            Json::Object(map) => Ok(Obj { map, path: path.to_string() }),
            _ => err(path, "Expected an object."),
        }
    }

    pub fn key_path(&self, key: &str) -> String {
        at(&self.path, key)
    }

    /// `decode(_:forKey:)`: missing → keyNotFound, null → valueNotFound.
    pub fn required(&self, key: &str) -> Result<&'a Json, DecodeError> {
        match self.map.get(key) {
            None => err(&self.key_path(key), "This field is missing."),
            Some(Json::Null) => err(&self.key_path(key), "A value is required, not null."),
            Some(v) => Ok(v),
        }
    }

    /// `decodeIfPresent(_:forKey:)`: missing or null → None; a value of the wrong type is still an
    /// error.
    pub fn optional(&self, key: &str) -> Option<&'a Json> {
        self.map.get(key).filter(|v| **v != Json::Null)
    }

    pub fn string(&self, key: &str) -> Result<String, DecodeError> {
        string(self.required(key)?, &self.key_path(key))
    }

    pub fn opt_string(&self, key: &str) -> Result<Option<String>, DecodeError> {
        self.optional(key).map(|v| string(v, &self.key_path(key))).transpose()
    }

    pub fn double(&self, key: &str) -> Result<f64, DecodeError> {
        double(self.required(key)?, &self.key_path(key))
    }

    pub fn opt_double(&self, key: &str) -> Result<Option<f64>, DecodeError> {
        self.optional(key).map(|v| double(v, &self.key_path(key))).transpose()
    }

    pub fn opt_int(&self, key: &str) -> Result<Option<i64>, DecodeError> {
        self.optional(key).map(|v| int(v, &self.key_path(key))).transpose()
    }

    pub fn uuid(&self, key: &str) -> Result<String, DecodeError> {
        uuid(self.required(key)?, &self.key_path(key))
    }

    pub fn opt_uuid(&self, key: &str) -> Result<Option<String>, DecodeError> {
        self.optional(key).map(|v| uuid(v, &self.key_path(key))).transpose()
    }

    pub fn date(&self, key: &str) -> Result<Date, DecodeError> {
        date(self.required(key)?, &self.key_path(key))
    }

    pub fn opt_date(&self, key: &str) -> Result<Option<Date>, DecodeError> {
        self.optional(key).map(|v| date(v, &self.key_path(key))).transpose()
    }

    pub fn array(&self, key: &str) -> Result<&'a [Json], DecodeError> {
        array(self.required(key)?, &self.key_path(key))
    }

    pub fn opt_array(&self, key: &str) -> Result<Option<&'a [Json]>, DecodeError> {
        self.optional(key).map(|v| array(v, &self.key_path(key))).transpose()
    }
}

pub(crate) fn string(v: &Json, path: &str) -> Result<String, DecodeError> {
    v.as_str().map(str::to_string).ok_or_else(|| DecodeError { path: path.into(), message: "Expected text.".into() })
}

pub(crate) fn double(v: &Json, path: &str) -> Result<f64, DecodeError> {
    v.as_f64().ok_or_else(|| DecodeError { path: path.into(), message: "Expected a number.".into() })
}

/// An `Int`: a number whose value is whole and in range (`1`, `1.0` and `1e2`, not `2.5`).
pub(crate) fn int(v: &Json, path: &str) -> Result<i64, DecodeError> {
    match v {
        Json::Number(t) => v.as_i64().ok_or_else(|| DecodeError { path: path.into(), message: format!("Number {t} is not representable in Swift.") }),
        _ => err(path, "Expected a whole number."),
    }
}

/// A `UInt64`: a whole number from 0 to 2^64 − 1, digits read exactly.
pub(crate) fn uint64(v: &Json, path: &str) -> Result<u64, DecodeError> {
    let Json::Number(t) = v else { return err(path, "Expected a whole number.") };
    if let Ok(u) = t.parse::<u64>() {
        return Ok(u);
    }
    let x: f64 = t.parse().unwrap_or(f64::NAN);
    if x.fract() == 0.0 && (0.0..18_446_744_073_709_551_616.0).contains(&x) {
        return Ok(x as u64);
    }
    err(path, format!("Number {t} is not representable in Swift."))
}

pub(crate) fn uuid(v: &Json, path: &str) -> Result<String, DecodeError> {
    let s = string(v, path)?;
    parse_uuid(&s).ok_or_else(|| DecodeError { path: path.into(), message: "Attempted to decode UUID from invalid UUID string.".into() })
}

pub(crate) fn date(v: &Json, path: &str) -> Result<Date, DecodeError> {
    let s = string(v, path)?;
    Date::parse_iso8601(&s).ok_or_else(|| DecodeError { path: path.into(), message: "Expected date string to be ISO8601-formatted.".into() })
}

pub(crate) fn array<'a>(v: &'a Json, path: &str) -> Result<&'a [Json], DecodeError> {
    v.as_array().ok_or_else(|| DecodeError { path: path.into(), message: "Expected a list.".into() })
}

pub(crate) fn bool(v: &Json, path: &str) -> Result<bool, DecodeError> {
    v.as_bool().ok_or_else(|| DecodeError { path: path.into(), message: "Expected true or false.".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unix(s: &str) -> Option<f64> {
        Date::parse_iso8601(s).map(|d| d.unix())
    }

    /// Each answer is what JSONDecoder's `.iso8601` gave (macOS 27.2), as seconds after
    /// 2026-11-11T04:05:40Z, or None for a refusal.
    #[test]
    fn dates_read_as_foundation_read_them() {
        let base = 1_794_369_940.0;
        let cases: &[(&str, Option<f64>)] = &[
            ("2026-11-11T04:05:40Z", Some(0.0)), ("2026-11-11T04:05:40+01:00", Some(-3600.0)), ("2026-11-11T04:05:40+0100", Some(-3600.0)),
            ("2026-11-11T04:05:40.5Z", Some(0.5)), ("2026-11-11T04:05:40", None), ("2026-11-11 04:05:40Z", None), ("2026-11-11T04:05Z", None),
            ("2026-11-11t04:05:40z", None), ("2026-11-11T04:05:40-00:00", Some(0.0)), ("20261111T040540Z", None), ("2026-11-11T24:00:00Z", Some(71_660.0)),
            ("2026-11-11T04:05:60Z", Some(20.0)), ("2026-11-11T04:05:40+01", Some(-3600.0)), ("2026-11-11T04:05:40GMT", Some(0.0)),
            (" 2026-11-11T04:05:40Z", None), ("2026-11-11T04:05:40UTC", Some(0.0)), ("2026-11-11T04:05:40+01:30", Some(-5400.0)),
            ("2026-11-11T04:05:40-0530", Some(19_800.0)), ("2026-11-11T04:05:40+1", Some(-3600.0)), ("2026-11-11T04:05:40+01:0", Some(-3600.0)),
            ("2026-11-11T04:05:40,5Z", None), ("2026-1-11T04:05:40Z", Some(-26_265_600.0)), ("2026-11-1T04:05:40Z", Some(-864_000.0)),
            ("2026-11-11T4:05:40Z", Some(0.0)), ("2026-13-11T04:05:40Z", None), ("2026-00-11T04:05:40Z", None), ("2026-11-00T04:05:40Z", None),
            ("2026-11-11T25:05:40Z", Some(75_600.0)), ("2026-11-11T04:61:40Z", Some(3_360.0)), ("2026-11-11T04:05:99Z", Some(59.0)),
            ("2026-11-11T04:05:40.Z", None), ("2026-11-11T04:05:40Zjunk", Some(0.0)), ("2026-11-11T04:05:40+01:00junk", Some(-3600.0)),
            ("2026-11-11T04:05:40+99:00", None), ("2026-11-11T04:05:40GMT+1", Some(-3600.0)), ("2026-11-11T04:05:40gmt", Some(0.0)),
            ("+2026-11-11T04:05:40Z", None), ("-0001-11-11T04:05:40Z", None), ("2026-11-11T04:05:40+01:00:00", Some(-3600.0)),
            ("2026-11-11T04:05:40 Z", None), ("2026-11-11T04:05:40-00", Some(0.0)), ("2026-11-11T04:05:40+0", Some(0.0)),
            ("2026-11-11T04:05:40z", Some(0.0)), ("2026-11-32T04:05:40Z", None), ("2026-11-99T04:05:40Z", None), ("2026-11-11T04:05:40+24", None),
            ("2026-11-11T04:05:40+18:00", Some(-64_800.0)), ("2026-11-11T04:05:40+19:00", None), ("2026-11-11T04:05:40+14:60", Some(-54_000.0)),
            ("2026-11-11T04:05:40UTC+1", Some(-3600.0)), ("2026-11-11T04:05:40GMT-05:00", Some(18_000.0)), ("2026-11-11T04:05:40GMTx", Some(0.0)),
            ("2026-11-11T04:05:40+", None), ("2026-11-11T04:05:40+123", Some(-43_380.0)), ("2026-11-11T04:05:40+12345", Some(-45_245.0)),
            ("2026-11-11T04:05:40+01:", None), ("2026-11-11T04:05:40EST", None), ("2026-11-11T004:05:40Z", Some(0.0)), ("2026-011-11T04:05:40Z", Some(0.0)),
            ("2026-11-011T04:05:40Z", Some(0.0)), ("2026-11-11T04:005:40Z", Some(0.0)), ("2026-11-11T04:05:040Z", Some(0.0)),
            ("2026-11-11T04:05:4Z", Some(-36.0)), ("2026-11-11T04:05:40.1.2Z", None), ("2026--11T04:05:40Z", None), ("-11-11T04:05:40Z", None),
            ("2026-11-11T04:05:40+01:00Z", Some(-3600.0)), ("2026-11-11T04:05:40ZZ", Some(0.0)), ("2026-11-11T04:05:40GMT+01:30", Some(-5400.0)),
            ("2026-11-11T04:05:40+0130", Some(-5400.0)), ("2026-11-11T04:05:40+013", Some(-3780.0)), ("2026-11-11T04:05:40-12:59:59", Some(46_799.0)),
        ];
        for (text, want) in cases {
            let got = unix(text).map(|u| u - base);
            match (got, want) {
                (Some(g), Some(w)) => assert!((g - w).abs() < 1e-6, "{text}: {g} vs {w}"),
                (g, w) => assert_eq!(g, *w, "{text}"),
            }
        }
        assert_eq!(unix("12026-11-11T04:05:40Z"), Some(317_363_889_940.0));
        assert_eq!(unix("026-11-11T04:05:40Z"), Some(-61_319_706_860.0));
        assert_eq!(unix("0001-01-01T00:00:00Z"), Some(-62_135_769_600.0), "Julian before 1582");
        assert_eq!(unix("1582-10-15T00:00:00Z"), Some(-12_219_292_800.0));
        assert_eq!(unix("1582-10-04T00:00:00Z"), Some(-12_219_379_200.0), "the day before the cutover");
    }

    /// Each pair is what JSONEncoder's `.iso8601` wrote for that many seconds since 1970.
    #[test]
    fn dates_are_written_in_utc_with_the_fraction_dropped() {
        for (t, want) in [
            (1_700_000_000.75, "2023-11-14T22:13:20Z"), (-0.5, "1969-12-31T23:59:59Z"), (-1.0, "1969-12-31T23:59:59Z"), (1e10, "2286-11-20T17:46:40Z"),
            (253_402_300_800.0, "10000-01-01T00:00:00Z"), (-0.000_000_1, "1969-12-31T23:59:59Z"), (-62_167_219_200.0, "0000-01-03T00:00:00Z"),
            (317_363_889_940.0, "12026-11-11T04:05:40Z"), (-61_319_706_860.0, "0026-11-11T04:05:40Z"),
        ] {
            assert_eq!(Date::from_unix(t).iso8601(), want, "{t}");
        }
        assert_eq!(Date::parse_iso8601("2026-11-11T04:05:40.9999999Z").unwrap().iso8601(), "2026-11-11T04:05:40Z");
    }

    /// Each pair is what JSONEncoder wrote (macOS 27.2): a tie between two shortest strings goes
    /// to the even last digit.
    #[test]
    fn numbers_break_ties_to_even_as_swift_does() {
        for (v, want) in [
            (1.0023269653320312, "1.0023269653320312"), (1.8018264770507812, "1.8018264770507812"), (1.2692794799804688, "1.2692794799804688"),
            (1.1292495727539062, "1.1292495727539062"), (1.7984390258789062, "1.7984390258789062"), (1.6229629516601562, "1.6229629516601562"),
            (1.9109878540039062, "1.9109878540039062"), (1.5479965209960938, "1.5479965209960938"), (0.5498520135879517, "0.5498520135879517"),
            (0.1, "0.1"), (1.0, "1"), (1e-5, "1e-05"), (0.30000000000000004, "0.30000000000000004"), (-1.0023269653320312, "-1.0023269653320312"),
        ] {
            assert_eq!(number(v), Json::Number(want.into()), "{v:e}");
        }
    }

    #[test]
    fn compact_output_matches_json_encoder_without_pretty_printing() {
        let v = crate::json::parse(r#"{"p":{"b/x":"1","a":"é\n"},"arr":[],"d":"2023-11-14T22:13:20Z","seed":18446744073709551615,"u":{},"k":[{}]}"#).unwrap();
        assert_eq!(to_compact(&v), r#"{"arr":[],"d":"2023-11-14T22:13:20Z","k":[{}],"p":{"a":"é\n","b\/x":"1"},"seed":18446744073709551615,"u":{}}"#);
    }

    #[test]
    fn uuids_read_in_either_case_and_come_back_upper_case() {
        assert_eq!(parse_uuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").as_deref(), Some("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"));
        assert_eq!(parse_uuid("{aaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), None);
        let u = random_uuid();
        assert_eq!(parse_uuid(&u).as_deref(), Some(u.as_str()));
        assert_eq!(&u[14..15], "4", "a version-4 UUID");
        assert_ne!(random_uuid(), u);
    }

    #[test]
    fn unsigned_seeds_read_exactly_up_to_two_to_the_sixty_four() {
        let n = |t: &str| uint64(&Json::Number(t.into()), "seed");
        assert_eq!(n("18446744073709551615"), Ok(u64::MAX));
        assert_eq!(n("1.0"), Ok(1));
        assert_eq!(n("1e2"), Ok(100));
        assert!(n("18446744073709551616").is_err());
        assert!(n("-1").is_err());
        assert!(n("2.5").is_err());
    }
}
