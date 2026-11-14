//! File › Export › All Solver Inputs to Folder (0.90.34 `QnetGUIApp.exportAllSolverInputs`, and the
//! headless `--export-cmp` that wrote the same seven files).
//!
//! The files are the inputs Run Comparison hands its solvers: the box SRBM for fBNAsm (`sm.in`,
//! degree 8), fBNAfm (`fm.in`, mesh 12) and fBNAlp (`lp.in`), the finite simulator's text
//! (`sim.txt`), the QNA file (`qna.qna`), the orthant SRBM for BNAsm (`cmp_sm.in`, degree 8) and
//! the infinite simulator's input (`cmp_sim.sim`). Each one an exporter refuses is reported with
//! its sentence and left out; the rest are still written.

use crate::model::Network;

use super::{fbnasim, jackson_sim, qna, srbm_box, srbm_orthant};

/// How the finite-buffer SRBM files treat blocking (0.90.34 `SRBMExportSheet.BlockingConvention`).
/// Infinite-buffer networks ignore it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockingConvention {
    /// The offered rate α feeds every station, as the box solvers assume.
    Manufacturing,
    /// Thins arrivals by the blocking probability, to compare with a loss simulation (`--loss-fix`).
    LossCorrection,
    /// Adjusts the drift for blocking after service with external loss (`--bas-fix`).
    BasCorrection,
}

impl BlockingConvention {
    pub const ALL: [BlockingConvention; 3] = [BlockingConvention::Manufacturing, BlockingConvention::LossCorrection, BlockingConvention::BasCorrection];

    pub fn title(self) -> &'static str {
        match self {
            BlockingConvention::Manufacturing => "Manufacturing blocking (SRBM default)",
            BlockingConvention::LossCorrection => "Loss-network correction",
            BlockingConvention::BasCorrection => "BAS + external-loss correction",
        }
    }

    pub fn detail(self) -> &'static str {
        match self {
            BlockingConvention::Manufacturing => "The offered arrival rate α feeds every station; matches the spectral, finite-element and LP solvers.",
            BlockingConvention::LossCorrection => "Thins the arrival stream by the blocking probability, for comparison against a loss-network simulation (--loss-fix).",
            BlockingConvention::BasCorrection => "Adjusts drift for blocking-after-service with external loss (--bas-fix).",
        }
    }
}

/// One file of the set: its name, and its text or the exporter's refusal.
#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub file: &'static str,
    pub result: Result<String, String>,
}

/// The seven files, in 0.90.34's order. `generated` is the time text of `sim.txt`'s
/// `# Generated:` line (`fbnasim::export`).
pub fn export_all(net: &Network, convention: BlockingConvention, generated: &str) -> Vec<Output> {
    let (nodes, links, inf) = (&net.nodes[..], &net.links[..], net.infinite_buffers);
    let loss = !inf && convention == BlockingConvention::LossCorrection;
    let bas = !inf && convention == BlockingConvention::BasCorrection;
    let out = |file, result: Result<String, String>| Output { file, result };
    vec![
        out("sm.in", srbm_box::export_for_spectral(nodes, links, inf, srbm_box::DEFAULT_SPECTRAL_DEGREE, loss, bas).map_err(|e| e.message())),
        out("fm.in", srbm_box::export_for_finite_element(nodes, links, inf, srbm_box::EXPORT_ALL_MESH_SIZE, loss, bas).map_err(|e| e.message())),
        out("lp.in", srbm_box::export_for_finite_lp(nodes, links, &srbm_box::FiniteLpParams::default(), loss, bas).map_err(|e| e.message())),
        out("sim.txt", fbnasim::export(nodes, links, generated).map_err(|e| e.message())),
        out("qna.qna", qna::export(nodes, links).map_err(|e| e.message())),
        out("cmp_sm.in", srbm_orthant::export_for_spectral(nodes, links, srbm_orthant::DEFAULT_SPECTRAL_DEGREE).map_err(|e| e.message())),
        out("cmp_sim.sim", jackson_sim::export(nodes, links).map_err(|e| e.message())),
    ]
}

/// The Status lines 0.90.34 wrote after an export to `folder`: the success line naming what was
/// written (and the convention, for finite buffers), and when something was refused, the warning
/// with one "<file>: <reason>" line per refusal as its detail.
pub fn status_lines(outputs: &[Output], folder: &str, net: &Network, convention: BlockingConvention) -> (String, Option<(String, String)>) {
    let written: Vec<&str> = outputs.iter().filter(|o| o.result.is_ok()).map(|o| o.file).collect();
    let failures: Vec<String> = outputs.iter().filter_map(|o| o.result.as_ref().err().map(|e| format!("{}: {e}", o.file))).collect();
    let note = if net.infinite_buffers { String::new() } else { format!(" Blocking convention: {}.", convention.title()) };
    let ok = format!("Exported {} solver input file(s) to {folder}: {}.{note}", written.len(), written.join(", "));
    let warn = (!failures.is_empty()).then(|| (format!("{} of {} solver input files were not written.", failures.len(), outputs.len()), failures.join("\n")));
    (ok, warn)
}
