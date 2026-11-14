//! The windows and reports that look at a network before it is run (PLAN.md §7 P6; ledger §10.9,
//! §10.10, §10.12–§10.14, INV-033):
//!
//! - [`report`]: Network ▸ Analyze Network and Show Network Primitives — the report core already
//!   writes as 0.90.34 did, the Status lines 0.90.34 wrote beside it, and its display in the Shell
//!   pane through the one single-flight run path (RUN-045), as a run labelled `analyze` or
//!   `primitives` that files no record.
//! - [`advice`]: what the Method Chooser needs to know, as two separate questions (INV-033): is the
//!   network in each method's domain (arithmetic on the network, here), and is each method's solver
//!   or Python runtime installed (the runner's resolver). The page turns both into the chooser's
//!   rows and words (src/windows/methodchooser/advice.ts).
//! - [`deps`]: Help ▸ Check Dependencies… and the launch-time checklist — the catalog for this
//!   build (packaged or a source-tree run) and one probe per row (the bundled Python, NumPy and
//!   solvers through the resolver; for a source-tree run, the build tools and the built libraries).

pub mod advice;
pub mod deps;
pub mod report;

/// A random (version 4) UUID in upper case, as Foundation's `UUID().uuidString` writes it.
pub(crate) fn upper_uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        // A fallback that is still unique within this process: the time and a counter.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let n = N.fetch_add(1, Ordering::SeqCst) as u128;
        b = (t ^ (n << 64)).to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    #[test]
    fn uuids_are_upper_case_version_4_and_differ() {
        let a = super::upper_uuid();
        assert_ne!(a, super::upper_uuid());
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
        assert!(a.chars().all(|c| c == '-' || c.is_ascii_digit() || ('A'..='F').contains(&c)));
    }
}
