//! Errors the interface can act on. Every command returns `QnError`, serialised as
//! `{kind, message, detail?}`; the front end (src/lib/api.ts) receives the same shape whatever
//! failed, and src/lib/errors.ts turns the kind into a sentence and, where there is one, a button
//! that fixes it. Messages are complete sentences written for the person using Qnet.
//!
//! The shape is NetMon's `SbError` without the cluster vocabulary (nodes, fences, Admin mode):
//! Qnet changes only its own documents, so it has no gate to report.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// Qnet won't accept the input as it is (a bad parameter, a malformed file).
    Invalid,
    /// A file or folder isn't there.
    NotFound,
    /// A solver, Python or a library it needs can't be found or doesn't load.
    Unavailable,
    /// Stopped by the user.
    Cancelled,
    /// It ran, and failed.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QnError {
    pub kind: ErrorKind,
    pub message: String,
    /// Extra text for a Details disclosure (stderr, an exit code, a path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl QnError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> QnError {
        QnError { kind, message: message.into(), detail: None }
    }

    pub fn invalid(message: impl Into<String>) -> QnError {
        QnError::new(ErrorKind::Invalid, message)
    }

    pub fn failed(message: impl Into<String>) -> QnError {
        QnError::new(ErrorKind::Failed, message)
    }

    /// Adds a Details text; blank text adds nothing. (First caller: P3's solver runs, with stderr.)
    #[allow(dead_code)]
    pub fn with_detail(mut self, detail: impl Into<String>) -> QnError {
        let d = detail.into();
        self.detail = (!d.trim().is_empty()).then_some(d);
        self
    }
}

impl std::fmt::Display for QnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for QnError {}

/// Lower layers say what went wrong in a sentence; at a command's edge that becomes a failure.
impl From<String> for QnError {
    fn from(message: String) -> QnError {
        QnError::failed(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_as_kind_and_message_with_details_only_when_there_are_some() {
        let e = QnError::new(ErrorKind::Unavailable, "The spectral solver isn't in this build.");
        assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({"kind": "unavailable", "message": "The spectral solver isn't in this build."}));
        let d = QnError::failed("bnet stopped with exit code 2.").with_detail("Cholesky failed at column 30");
        assert_eq!(serde_json::to_value(&d).unwrap()["detail"], "Cholesky failed at column 30");
        assert_eq!(QnError::failed("x").with_detail("  \n").detail, None, "blank details are dropped");
    }

    #[test]
    fn a_lower_layers_sentence_becomes_a_failure() {
        let e: QnError = String::from("Couldn't save prefs.json: disk full").into();
        assert_eq!((e.kind, e.message.as_str()), (ErrorKind::Failed, "Couldn't save prefs.json: disk full"));
    }
}
