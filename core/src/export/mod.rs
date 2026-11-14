//! The solver-input exporters (P2): each turns a network into the text one family of solvers
//! reads, exactly as Qnet 0.90.34 wrote it, and each refusal is 0.90.34's sentence.
//!
//! | Module | 0.90.34 | Solvers |
//! |---|---|---|
//! | `srbm_box` | `SRBMExporter` (export functions) | fBNAsm, fBNAfm, fBNAlp (finite buffers, the box) |
//! | `srbm_orthant` | `BNASRBMExporter` | BNAsm, BNAmc, BNAlp, BNAalr, BNAbb (infinite buffers, the orthant) |
//! | `qna` | `QNAExporter` | BNAqna, BNArqna, BNAsbd |
//! | `jackson_sim` | `BNANetworkExporter` | jackson_sim (BNAsim) |
//! | `fbnasim` | `NetworkExporter` | fBNAsim |
//! | `regenerative`, `product_form`, `qbd` | `RegenerativeExporter`, `ProductFormExporter`, `QBDExporter` | BNArmc, BNApf, BNAqbd |
//! | `finite_markov` | `FiniteMarkovExporter` | fBNAgc, fBNAdecomp, BNAtc |
//! | `all` | File › Export › All Solver Inputs to Folder (`--export-cmp`) | all of the above |
//!
//! Every exporter is compared with 0.90.34's output for all 50 examples (core/tests/golden_export_*.rs).

pub mod all;
pub mod finite_markov;
pub mod fbnasim;
pub mod jackson_sim;
pub mod product_form;
pub mod qbd;
pub mod qna;
pub mod regenerative;
pub mod srbm_box;
pub mod srbm_orthant;
