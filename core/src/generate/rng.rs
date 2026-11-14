//! The random numbers behind a generated network, drawn exactly as Qnet 0.90.34 drew them.
//!
//! 0.90.34 seeded a SplitMix64 (`SeededRNG`, seed 0 replaced by 0xdeadbeef) and asked the Swift
//! standard library for bounded integers and doubles from it. Those library algorithms are not
//! documented, so they were measured: a Swift program logged every 64-bit word the generator gave
//! out and what each call returned, over 400,000 calls, and the rules below reproduce every one.
//!
//! - An integer below a bound n is Lemire's multiply-shift: the high word of `word × n`, with the
//!   word redrawn while the low word is below `(2⁶⁴ − n) mod n`, checked only when the low word is
//!   below n (`RandomNumberGenerator.next(upperBound:)`).
//! - `Int.random(in: a..<b)` is `a + below(b − a)`, and `a...b` is `a + below(b − a + 1)`.
//! - `Double.random(in: a...b)` draws r = `below(2⁵³ + 1)`; r = 2⁵³ gives b, otherwise
//!   `(b − a) × (r × 2⁻⁵³) + a`, rounded at each step (no fused multiply-add).
//!
//! golden/generators/swift-random.txt holds the same calls made inside the 0.90.34 build, and
//! tests/golden_generators.rs checks this file against it.

/// 0.90.34's `SeededRNG`: SplitMix64.
#[derive(Clone, Debug)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    /// A generator from a seed; seed 0 is replaced by 0xdeadbeef, as 0.90.34 did.
    pub fn new(seed: u64) -> SplitMix64 {
        SplitMix64 { state: if seed != 0 { seed } else { 0xdead_beef } }
    }

    /// The next 64-bit word.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A uniform integer in 0..n (Swift's `next(upperBound:)`). `n` must not be zero.
    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n != 0, "upperBound cannot be zero");
        let mut m = (self.next_u64() as u128) * (n as u128);
        if (m as u64) < n {
            let t = n.wrapping_neg() % n;
            while (m as u64) < t {
                m = (self.next_u64() as u128) * (n as u128);
            }
        }
        (m >> 64) as u64
    }

    /// Swift's `Int.random(in: lo..<hi)`. The range must not be empty.
    pub fn int_in_range(&mut self, lo: i64, hi: i64) -> i64 {
        assert!(lo < hi, "Range requires lowerBound < upperBound");
        let delta = hi.wrapping_sub(lo) as u64;
        lo.wrapping_add(self.below(delta) as i64)
    }

    /// Swift's `Int.random(in: lo...hi)`.
    pub fn int_in_closed(&mut self, lo: i64, hi: i64) -> i64 {
        assert!(lo <= hi, "ClosedRange requires lowerBound <= upperBound");
        let delta = hi.wrapping_sub(lo) as u64;
        if delta == u64::MAX {
            return self.next_u64() as i64;
        }
        lo.wrapping_add(self.below(delta + 1) as i64)
    }

    /// Swift's `Double.random(in: lo...hi)`.
    pub fn double_in_closed(&mut self, lo: f64, hi: f64) -> f64 {
        assert!(lo <= hi && (hi - lo).is_finite(), "a finite, non-empty ClosedRange");
        let delta = hi - lo;
        let max_significand = 1u64 << 53;
        let r = self.below(max_significand + 1);
        if r == max_significand {
            return hi;
        }
        let unit = (r as f64) * (f64::EPSILON / 2.0);
        delta * unit + lo
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix_gives_the_words_swift_logged() {
        // The first words of seed 42, from the Swift probe (scratch program, Swift 6.4.2).
        let mut g = SplitMix64::new(42);
        assert_eq!(g.next_u64(), 13679457532755275413);
        assert_eq!(g.next_u64(), 2949826092126892291);
        assert_eq!(g.next_u64(), 5139283748462763858);
    }

    #[test]
    fn seed_zero_is_the_same_as_seed_0xdeadbeef() {
        let mut a = SplitMix64::new(0);
        let mut b = SplitMix64::new(0xdead_beef);
        for _ in 0..5 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn bounded_draws_stay_in_their_ranges() {
        let mut g = SplitMix64::new(7);
        for _ in 0..10_000 {
            let i = g.int_in_closed(2, 3);
            assert!((2..=3).contains(&i));
            let j = g.int_in_range(1, 5);
            assert!((1..5).contains(&j));
            let x = g.double_in_closed(0.05, 0.20);
            assert!((0.05..=0.20).contains(&x));
        }
    }

    #[test]
    fn a_double_draw_matches_the_swift_probe_bit_for_bit() {
        // Seed 42: Double.random(in: 0.55...0.85) then (in: 0.2...1.0), logged as bit patterns.
        let mut g = SplitMix64::new(42);
        assert_eq!(g.double_in_closed(0.55, 0.85).to_bits(), 0x3fe8b811e16e98d4);
        assert_eq!(g.double_in_closed(0.2, 1.0).to_bits(), 0x3fd4fcc70a56e164);
    }
}
