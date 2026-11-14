//! Qnet's solver runtime (PLAN.md §7 P3): finding a loadable copy of each solver and a Python that
//! can run the Python ones (`resolver`), running a solver as a supervised child process that Stop
//! can always end (`supervisor`), one run specification per Run-menu method (`methods`), and the
//! results store that keeps every run's record (`store`).
//!
//! 0.90.34 did this by typing generated bash scripts into the user's shell (decision D1 replaces
//! that): the app now starts each solver itself, and the text the scripts' awk and perl stages
//! produced is composed in Rust by `qnet_core::output`.

pub mod resolver;
pub mod supervisor;
pub mod store;
pub mod methods;
pub mod scrub;
