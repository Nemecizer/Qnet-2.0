//! C's number formatting and maths, for output that must match 0.90.34 to the byte.
//!
//! 0.90.34 formatted numbers with `String(format:)` ("%10.5f", "%.6f", "%g"), which is Darwin's
//! printf, and used libm's `tgamma`, which Rust's standard library doesn't have. Both are called
//! here through the C library itself rather than re-implemented, so rounding and edge cases
//! (`-0.000000`, `nan`, `inf`, `%g`'s exponent switch) are the same by construction. The one
//! exception is a NaN's sign, which `f` handles itself so that glibc prints what Darwin does.

use std::ffi::CString;
use std::ops::Range;

/// One double through a printf conversion: `f("%10.5f", x)`. The format must hold exactly one
/// double conversion; anything else is a programming error and panics.
pub fn f(format: &str, x: f64) -> String {
    let flags = one_double_conversion(format);
    // Darwin's printf prints every NaN as "nan": it ignores the sign bit and the + and space
    // flags. glibc prints "-nan" and "+nan". Pass a positive NaN without those flags so that
    // every platform writes what 0.90.34 did.
    let (format, x) = if x.is_nan() {
        let mut unsigned = String::with_capacity(format.len());
        unsigned.push_str(&format[..flags.start]);
        unsigned.extend(format[flags.clone()].chars().filter(|c| *c != '+' && *c != ' '));
        unsigned.push_str(&format[flags.end..]);
        (unsigned, x.abs())
    } else {
        (format.to_string(), x)
    };
    let fmt = CString::new(format.as_str()).expect("a format without NUL bytes");
    let mut buf = vec![0u8; 64];
    loop {
        // SAFETY: the buffer is writable for its length, the format is NUL-terminated, and
        // one_double_conversion has checked that it takes exactly one double, which is passed.
        let n = unsafe { libc::snprintf(buf.as_mut_ptr() as *mut libc::c_char, buf.len(), fmt.as_ptr(), x) };
        assert!(n >= 0, "snprintf refused {format}");
        let n = n as usize;
        if n < buf.len() {
            buf.truncate(n);
            return String::from_utf8(buf).expect("printf writes ASCII for numbers");
        }
        buf.resize(n + 1, 0);
    }
}

/// Checks that `format` holds exactly one double conversion: `%`, flags from `-+ #0`, an optional
/// width and precision in digits (no `*`), and one of `f F e E g G a A`, with any `%%` and other
/// text around it. Returns the byte range of that conversion's flags. Panics on anything else,
/// because snprintf given another conversion (`%d`, `%s`, `%n`) would read or write memory it
/// was not given.
fn one_double_conversion(format: &str) -> Range<usize> {
    let b = format.as_bytes();
    let digits = |mut j: usize| {
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        j
    };
    let mut found = None;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            i += 1;
            continue;
        }
        if b.get(i + 1) == Some(&b'%') {
            i += 2;
            continue;
        }
        let start = i + 1;
        let mut j = start;
        while j < b.len() && b"-+ #0".contains(&b[j]) {
            j += 1;
        }
        let flags = start..j;
        j = digits(j);
        if b.get(j) == Some(&b'.') {
            j = digits(j + 1);
        }
        let double = b.get(j).is_some_and(|c| b"fFeEgGaA".contains(c));
        assert!(double, "cfmt::f takes only a double conversion (%f %e %g %a), not {format:?}");
        assert!(found.is_none(), "cfmt::f takes one conversion, and {format:?} has more");
        found = Some(flags);
        i = j + 1;
    }
    found.unwrap_or_else(|| panic!("cfmt::f takes one double conversion, and {format:?} has none"))
}

/// Swift's `"\(x)"` for a Double: its `description` ("1.0", "0.5", "1e-05", "1e+16", "nan", "inf").
pub fn swift_description(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let a = x.abs();
    if a != 0.0 && (a < 1e-4 || a >= 9_007_199_254_740_992.0) {
        let s = ties_to_even(format!("{x:e}"), x);
        let (m, e) = s.split_once('e').unwrap();
        let (sign, digits) = match e.strip_prefix('-') {
            Some(d) => ('-', d),
            None => ('+', e),
        };
        return format!("{m}e{sign}{digits:0>2}");
    }
    let s = ties_to_even(format!("{x}"), x);
    if s.contains('.') {
        s
    } else {
        format!("{s}.0")
    }
}

/// Swift's rule for a tie between shortest digit strings, applied to Rust's shortest text `text`
/// of `v` (plain or `d.ddde±x` form).
///
/// Both languages print the fewest digits that read back as `v`. When two such strings exist and
/// `v`'s exact value lies exactly halfway between them, Swift takes the one whose last digit is
/// even and Rust takes the upper one. Measured on macOS 27.2: Swift writes 1.00232696533203125
/// (exactly representable) as `1.0023269653320312`, Rust as `…313`. Such values are dyadic
/// fractions with many digits: rare in numbers typed by hand, common in computed ones (differences
/// of dates, halved coordinates).
pub fn ties_to_even(text: String, v: f64) -> String {
    if !v.is_finite() {
        return text;
    }
    let (mantissa, exponent) = match text.find('e') {
        Some(i) => (&text[..i], &text[i..]),
        None => (text.as_str(), ""),
    };
    let last = mantissa.as_bytes()[mantissa.len() - 1];
    if !last.is_ascii_digit() || (last - b'0') % 2 == 0 {
        return text;
    }
    let lower = format!("{}{}{}", &mantissa[..mantissa.len() - 1], (last - 1) as char, exponent);
    if lower.parse::<f64>() != Ok(v) {
        return text;
    }
    // Both read back as v. It is a tie only if v's exact decimal value is the lower string's
    // digits followed by a single 5 (a double's exact expansion has at most 767 significant digits).
    let digits = |s: &str| -> String {
        s.chars()
            .take_while(|c| *c != 'e')
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .trim_start_matches('0')
            .to_string()
    };
    let exact = digits(&format!("{:.1100e}", v.abs()));
    let low = digits(&lower);
    let tie = exact.len() > low.len()
        && exact.starts_with(&low)
        && exact.as_bytes()[low.len()] == b'5'
        && exact[low.len() + 1..].bytes().all(|b| b == b'0');
    if tie {
        lower
    } else {
        text
    }
}

extern "C" {
    #[link_name = "tgamma"]
    fn c_tgamma(x: f64) -> f64;
}

/// libm's Γ(x), as Swift's `tgamma` calls it.
pub fn tgamma(x: f64) -> f64 {
    // SAFETY: tgamma is a pure libm function taking and returning a double.
    unsafe { c_tgamma(x) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Swift printed (macOS 27.2): a tie between two shortest strings goes to the even digit.
    #[test]
    fn shortest_digits_break_exact_ties_to_the_even_digit_as_swift_does() {
        for (v, want) in [
            (1.0023269653320312, "1.0023269653320312"),
            (1.8018264770507812, "1.8018264770507812"),
            (1.5479965209960938, "1.5479965209960938"),
            (-1.0023269653320312, "-1.0023269653320312"),
            (0.30000000000000004, "0.30000000000000004"),
            (0.1, "0.1"),
        ] {
            assert_eq!(swift_description(v), want, "{v:e}");
            assert_eq!(crate::json::format_number(v), want, "{v:e}");
        }
    }

    #[test]
    fn printf_conversions_come_from_the_c_library() {
        assert_eq!(f("%10.5f", 1.0), "   1.00000");
        assert_eq!(f("%.6f", -0.0000001), "-0.000000");
        assert_eq!(f("%.4f", f64::NAN), "nan");
        assert_eq!(f("%g", 1e-5), "1e-05");
        assert_eq!(f("%+8.5f", 0.25), "+0.25000");
        assert_eq!(f("%.17g", 0.1), "0.10000000000000001");
        assert_eq!(f("%400.1f", 1.0).len(), 400, "long output grows the buffer");
        assert_eq!(f("lambda=%.6f", 0.5), "lambda=0.500000");
        assert_eq!(f("%.1f%%", 12.34), "12.3%");
    }

    /// Darwin's printf, which 0.90.34 used, never signs a NaN; glibc writes "-nan" and "+nan".
    #[test]
    fn nan_prints_unsigned_as_darwin_does() {
        let negative = -f64::NAN;
        assert!(negative.is_sign_negative());
        assert_eq!(f("%.4f", negative), "nan");
        assert_eq!(f("%+8.3f", f64::NAN), "     nan");
        assert_eq!(f("% .3e", negative), "nan");
        assert_eq!(f("%-+6g|", negative), "nan   |");
        assert_eq!(f("%+.1f", -1.0), "-1.0", "flags still apply to numbers");
    }

    #[test]
    fn formats_other_than_one_double_conversion_panic() {
        for bad in ["%d", "%s", "%n", "%Lf", "%*.2f", "%.*f", "%f %f", "no conversion", "50%%", "%"] {
            let r = std::panic::catch_unwind(|| f(bad, 1.0));
            assert!(r.is_err(), "{bad:?} should panic");
        }
    }

    #[test]
    fn descriptions_read_as_swift_prints_a_double() {
        for (x, want) in [(1.0, "1.0"), (0.5, "0.5"), (100.0, "100.0"), (1e-5, "1e-05"), (1e16, "1e+16"), (1e15, "1000000000000000.0"), (-0.0, "-0.0"), (0.1 + 0.2, "0.30000000000000004")] {
            assert_eq!(swift_description(x), want);
        }
        assert_eq!(swift_description(f64::NAN), "nan");
    }

    #[test]
    fn tgamma_is_libms() {
        assert_eq!(tgamma(5.0), 24.0);
        assert!((tgamma(0.5) - std::f64::consts::PI.sqrt()).abs() < 1e-15);
    }
}
