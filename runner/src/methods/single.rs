//! The Run menu's single-method runs: one solver, one table. The infinite-buffer ones (Whitt QNA,
//! Whitt–You RQNA, SBD, the spectral method and the Monte Carlo simulation) are in
//! `single/infinite.rs`, and the finite-buffer ones (the spectral method, finite elements and the
//! Monte Carlo simulation) in `single/finite.rs`, each porting its `run…()` actions in
//! `2_QNET/Sources/Qnet/QnetGUIApp.swift`. This file only routes a method to its half.

mod finite; // sm, fm, sim
mod infinite; // qna, rqna, sbd, inf_sm, inf_sim

use super::{Method, Prepared, RunContext};

/// The spectral method's 2 GB guard, which Run Comparison's spectral column applies too.
pub(super) use infinite::spectral_resource_issue;

/// Prepares one of the eight single-method runs.
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    match method {
        Method::Qna | Method::Rqna | Method::Sbd | Method::InfiniteSpectral | Method::InfiniteMonteCarlo => {
            infinite::prepare(method, ctx)
        }
        Method::FiniteSpectral | Method::FiniteElement | Method::FiniteMonteCarlo => finite::prepare(method, ctx),
        _ => super::unimplemented_method(method),
    }
}
