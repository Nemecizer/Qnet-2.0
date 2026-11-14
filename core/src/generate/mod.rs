//! The two ways Qnet builds a network for you: the random-network generator (Network ▸ Generate
//! Random Network…, 0.90.34 `RandomNetworkGenerator.swift`) and the archetype gallery (Network ▸
//! Insert Archetype…, 0.90.34 `NetworkArchetypes.swift`).
//!
//! Both return a whole [`Network`](crate::model::Network) laid out on one grid ([`layout`]), so a
//! generated network and an inserted archetype can't be told apart by their spacing. Every node
//! name, position, parameter string, probability and class is what 0.90.34 built, byte for byte
//! once saved (tests/golden_generators.rs checks them against golden/generators/).
//!
//! Ids come from the caller through [`IdSource`]: 0.90.34 called `UUID()` for every node and link,
//! which the app does too, while a test hands out predictable ones. Ids are drawn in the order
//! 0.90.34 created the nodes and links.
//!
//! A seed reproduces the network 0.90.34 generated from it: [`rng`] is its SplitMix64 and the Swift
//! standard library's `Int.random(in:using:)` and `Double.random(in:using:)` algorithms, measured
//! from Swift itself (golden/generators/swift-random.txt).

pub mod archetypes;
pub mod random;
pub mod rng;

pub use archetypes::{
    archetype, archetype_as_inserted, blueprint, groups, summary, Archetype, ArchetypeParameters, Blueprint, Knob,
    BLUEPRINTS, CANVAS_ORIGIN,
};
pub use random::{fresh_seed, generate, Parameters, Topology};

/// Where new node and link ids come from. Each call returns a fresh id: an upper-case UUID in the
/// app, anything unique in a test.
pub trait IdSource {
    fn next_id(&mut self) -> String;
}

impl<F: FnMut() -> String> IdSource for F {
    fn next_id(&mut self) -> String {
        self()
    }
}

/// Ids "00000000-0000-0000-0000-000000000001", "…002", …: upper-case UUID form, counted from 1.
#[derive(Clone, Debug, Default)]
pub struct CountingIds {
    issued: u64,
}

impl CountingIds {
    pub fn new() -> CountingIds {
        CountingIds::default()
    }
}

impl IdSource for CountingIds {
    fn next_id(&mut self) -> String {
        self.issued += 1;
        let n = self.issued;
        format!("00000000-0000-0000-{:04X}-{:012X}", (n >> 48) & 0xFFFF, n & 0xFFFF_FFFF_FFFF)
    }
}

/// The one layout grid a built network lands on (0.90.34 `RandomNetworkGenerator.Layout`), in
/// canvas points.
pub mod layout {
    /// Y of the Src → B → S → Sink row. Several sources fan out vertically around it.
    pub const Y_ROW: f64 = 220.0;
    /// X of the source column.
    pub const X_SOURCE_COLUMN: f64 = 80.0;
    /// X of the first buffer.
    pub const X_ROW_START: f64 = 200.0;
    /// Buffer-to-buffer pitch; a station sits half a step past its buffer.
    pub const X_STEP: f64 = 130.0;
    /// Vertical pitch between stacked sources.
    pub const SOURCE_SPACING: f64 = 64.0;
    /// Gap between the last column and the sink.
    pub const SINK_GAP: f64 = 40.0;
}

/// Swift's `max(x, y)`: `y >= x ? y : x`, which differs from `f64::max` when one is NaN.
pub(crate) fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

/// Swift's `min(x, y)`: `y < x ? y : x`.
pub(crate) fn swift_min(x: f64, y: f64) -> f64 {
    if y < x {
        y
    } else {
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counting_ids_look_like_upper_case_uuids_and_never_repeat() {
        let mut ids = CountingIds::new();
        let a = ids.next_id();
        let b = ids.next_id();
        assert_eq!(a, "00000000-0000-0000-0000-000000000001");
        assert_eq!(b, "00000000-0000-0000-0000-000000000002");
        let mut many = CountingIds::new();
        let last = (0..300).map(|_| many.next_id()).last().unwrap();
        assert_eq!(last, "00000000-0000-0000-0000-00000000012C");
    }

    #[test]
    fn a_closure_is_an_id_source() {
        let mut n = 0;
        let mut ids = || {
            n += 1;
            format!("ID{n}")
        };
        assert_eq!(IdSource::next_id(&mut ids), "ID1");
        assert_eq!(IdSource::next_id(&mut ids), "ID2");
    }

    #[test]
    fn swift_max_and_min_keep_the_first_argument_when_the_second_is_not_comparable() {
        assert_eq!(swift_max(1.0, 2.0), 2.0);
        assert!(swift_max(f64::NAN, 0.05).is_nan());
        assert_eq!(swift_max(0.05, f64::NAN), 0.05);
        assert!(swift_min(f64::NAN, 0.99).is_nan());
        assert_eq!(swift_min(3.0, 2.0), 2.0);
    }
}
