//! The few behaviours of BWK awk (`/usr/bin/awk`, version 20200816, the awk 0.90.34's generated
//! programs ran on) that reach the text those programs printed, so the Rust ports in this module
//! can reproduce them on purpose rather than by accident.
//!
//! - A string's numeric value is C's `atof`: the longest numeric prefix, `inf`/`nan` included.
//! - A numeric comparison is the sign of a − b, so a NaN compares equal to everything (`relop`).
//! - A computed −0 is stored as 0 (`setfval`), so arithmetic never prints "-0.0".
//! - Records split on newline, fields on runs of blanks, tabs and newlines.
//! - `printf "%-22s"` pads by bytes, not characters.
//! - `for (k in a)` visits an array in its hash table's order (`for_in_order`).

use std::ffi::CString;

/// C's `atof`, which BWK awk used for a string's numeric value: the longest numeric prefix after
/// leading white space, including `inf`, `nan` and hexadecimal forms, and 0 when there is none.
pub fn number(s: &str) -> f64 {
    let Ok(c) = CString::new(s.split('\0').next().unwrap_or("")) else { return 0.0 };
    // SAFETY: a NUL-terminated string; a null end pointer is allowed.
    unsafe { libc::strtod(c.as_ptr(), std::ptr::null_mut()) }
}

/// BWK awk's numeric comparison (`relop`): the sign of a − b; a NaN compares equal to anything.
pub fn rel(a: f64, b: f64) -> i32 {
    let j = a - b;
    if j < 0.0 {
        -1
    } else if j > 0.0 {
        1
    } else {
        0
    }
}

/// A computed value as BWK awk stores it: −0 becomes 0.
pub fn stored(x: f64) -> f64 {
    if x == 0.0 {
        0.0
    } else {
        x
    }
}

/// The records of a file: split on newline; a last line without one still counts.
pub fn records(text: &str) -> Vec<&str> {
    let mut v: Vec<&str> = text.split('\n').collect();
    if v.last() == Some(&"") {
        v.pop();
    }
    v
}

/// The default field splitting: runs of blanks, tabs and newlines.
pub fn fields(rec: &str) -> Vec<&str> {
    rec.split([' ', '\t', '\n']).filter(|s| !s.is_empty()).collect()
}

/// `%-<w>s`: left-justified, padded with spaces to `w` bytes.
pub fn left(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(s.len())))
}

/// `%<w>s`: right-justified, padded with spaces to `w` bytes.
pub fn right(s: &str, w: usize) -> String {
    format!("{}{s}", " ".repeat(w.saturating_sub(s.len())))
}

/// The order in which `for (k in a)` visits the keys of an array that received them in
/// `insertion` order (duplicates ignored), as BWK awk's symbol table keeps them: 50 buckets,
/// growing fourfold once it holds more than two keys per bucket, each new key at the head of its
/// bucket's chain, and the hash `h = c + 31·h` over the key's bytes in 32 bits.
pub fn for_in_order(insertion: &[String]) -> Vec<String> {
    fn hash(s: &str, size: usize) -> usize {
        let mut h: u32 = 0;
        for &c in s.as_bytes() {
            h = (c as i8 as i32 as u32).wrapping_add(h.wrapping_mul(31));
        }
        (h as usize) % size
    }
    let mut size = 50;
    let mut tab: Vec<Vec<String>> = vec![Vec::new(); size]; // each chain head first
    let mut n = 0;
    for key in insertion {
        if tab[hash(key, size)].contains(key) {
            continue;
        }
        n += 1;
        if n > 2 * size {
            let nsz = 4 * size;
            let mut np: Vec<Vec<String>> = vec![Vec::new(); nsz];
            for chain in &tab {
                for k in chain {
                    np[hash(k, nsz)].insert(0, k.clone());
                }
            }
            tab = np;
            size = nsz;
        }
        tab[hash(key, size)].insert(0, key.clone());
    }
    tab.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nan_compares_equal_and_negative_zero_is_stored_as_zero() {
        assert_eq!(rel(f64::NAN, 0.0), 0);
        assert_eq!(rel(1.0, 2.0), -1);
        assert!(stored(-0.0).is_sign_positive());
        assert!(number("nan").is_nan());
        assert_eq!(number("1.5abc"), 1.5);
        assert_eq!(number(""), 0.0);
    }

    #[test]
    fn small_integer_keys_come_out_in_bucket_order() {
        let keys: Vec<String> = ["0", "1", "10", "2"].iter().map(|s| s.to_string()).collect();
        // "0"→48, "1"→49, "2"→0 (50 % 50), "10"→(49·31+48) % 50 = 17
        assert_eq!(for_in_order(&keys), vec!["2", "10", "0", "1"]);
    }
}
