//! Qnet's core: the network model and its `.bnet` files, the analysis 0.90.34 ran as the network
//! was edited, and (from P2) the solver-input exporters and (P3) the result parser.
//!
//! Nothing here knows about windows or processes, so every rule is tested with `cargo test` alone,
//! and the outputs are checked against what 0.90.34 produced (`golden/`, tests/golden_*.rs).

pub mod bnet;
pub mod build;
pub mod scenarios;
pub mod cfmt;
pub mod json;
pub mod model;
pub mod naming;
pub mod dist;
pub mod traffic;
pub mod dump;
pub mod existence;
pub mod tractability;
pub mod jackson;
pub mod closed;
pub mod extended;
pub mod priority;
pub mod batch;
pub mod sensitivity;
pub mod uncertainty;
pub mod transient;
pub mod sim;
pub mod simstat;
pub mod optimise;
pub mod generate;
pub mod report;
pub mod editor;
pub mod flags;
pub mod export;
pub mod results;
pub mod output;
