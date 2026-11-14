//! The text a run shows besides the solvers' own output: the display-precision filter, the
//! comparison table, the banners above it, and the aggregators that summarise replicated or
//! multi-case runs.
//!
//! In 0.90.34 each of these was a program generated into the bash wrapper a run typed into the
//! Shell: a perl filter and a family of awk scripts (read by BWK `/usr/bin/awk`). Under D1 2.0 starts
//! the solvers itself, so they are pure Rust text functions over the solvers' captured output, with
//! no process and no interpreter at run time (RUN-066, Changed). The text they produce is
//! 0.90.34's, byte for byte; `tests/output_*.rs` run the original programs as oracles.

pub mod awk;
pub mod precision;
pub mod table;
pub mod banner;
pub mod mlmc;
pub mod adaptive_bar;
pub mod lp;
pub mod aggregate;
