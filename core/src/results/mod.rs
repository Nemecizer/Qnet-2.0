//! Run results (P3): the record every solver run files, the store's file format, and the parser
//! that turns a solver's output into measurements. Ported from 0.90.34's `ResultsWorkspace.swift`
//! (the Codable record types and the network fingerprint) and `ResultOutputParser.swift`.
//!
//! - `model`: the record types with JSON that reads and writes exactly as 0.90.34's `JSONEncoder`
//!   and `JSONDecoder` did, the method catalogue, the fingerprint and the export-order station ids.
//! - `parser`: the result parser.
//! - `codec`: dates, UUIDs and the compact JSON form the results file uses.
//! - `sha256`: the fingerprint's hash.
//!
//! The store itself (the file, newest first, begin and finish a run) is `qnet_runner::store`, since
//! it touches the disk; everything it decides about a record's content is here.

pub mod codec;
pub mod model;
pub mod parser;
pub mod sha256;

mod icu;
mod tables;

#[cfg(test)]
mod harness;

pub use codec::{Date, DecodeError};
pub use model::{
    archive, export_station_ids, file_url, ids, station_name_at_export_index, station_order_is_ambiguous, EncodeError, Fidelity, Measurement, MethodMetadata, ModelLayer,
    NetworkSnapshot, NumericalEvidence, Provenance, RunRecord, RunStatus, Uncertainty,
};
pub use parser::{parse, parse_with_ids, Disposition, ParsedOutput};
