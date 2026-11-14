//! Help's two commands (0.90.34 QnetGUIApp.swift `printHelpToTerminal`, AboutQnetWindow.swift;
//! ledger HELP-091, RUN-045, ABOUT-002).
//!
//! - [`help_show`] prints a Help topic in the Shell pane when Settings ▸ Help ▸ "Send help output
//!   to" is the Shell. It goes through the run path as Analyze Network does
//!   (`analysis_windows::report::analysis_report_show`): it claims the one single-flight slot under
//!   the topic's label ("help_alg_qna", shown as "Help Alg Qna", as 0.90.34 showed it), sends the
//!   text's bytes as `output` messages and then `finished`, and releases the slot. Numbers are not
//!   normalised to Output Format's decimals (Help is prose: "eq. 2.7" stays "eq. 2.7") and no
//!   Results record is filed.
//! - [`about_info`] tells the About window when this build was made.
//!
//! What 2.0 changes (decision D1): 0.90.34 wrote the topic to `BNET_<label>_<pid>.txt` and typed
//! `cat "<file>"; rm -f "<file>"` into the user's shell; 2.0 sends the bytes itself, so there is no
//! temporary file and no "Help (<label>): failed to write temp file." failure.

use std::sync::Arc;

use qnet_runner::supervisor::{run_job, OutputSink, RunEvent, RunOwner};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::errors::QnError;
use crate::runs::{base64, severity_word, Emit, RunMessage, Runs};

/// What the page asks [`help_show`] to print.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpShowRequest {
    pub tab_id: String,
    pub title: String,
    /// The topic's label, 0.90.34's `HelpTopic.label`: "help_alg_qna".
    pub label: String,
    /// The topic as plain text.
    pub text: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelpShowOutcome {
    /// False when another run holds the slot (its refusal sentence was sent as a warning).
    pub started: bool,
}

/// A Help label is "help_" and lower-case letters, digits and underscores: it can never be a
/// method's label, so a Help topic can never be taken for a run that files a record.
pub fn is_help_label(label: &str) -> bool {
    label.strip_prefix("help_").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
}

/// Passes the text's bytes to the page as they are: no display-precision filter (RUN-045).
struct RawSink(Emit);

impl OutputSink for RawSink {
    fn write(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            (self.0)(RunMessage::Output { data: base64(bytes) });
        }
    }
}

/// Claims the single-flight slot and prints `text` as the run `label`, on a thread of its own.
/// Returns whether it started, and the thread.
pub fn show(runs: &Runs, req: HelpShowRequest, emit: Emit) -> Result<(HelpShowOutcome, Option<std::thread::JoinHandle<()>>), QnError> {
    if !is_help_label(&req.label) {
        return Err(QnError::from(format!("“{}” is not a Help topic's label.", req.label)));
    }
    let reporter = {
        let emit = emit.clone();
        Arc::new(move |event: &RunEvent| match event {
            RunEvent::Status { text, severity } => emit(RunMessage::Status { text: text.clone(), severity: severity_word(*severity) }),
            RunEvent::Progress(_) => {}
            RunEvent::Finished(summary) => emit(RunMessage::Finished {
                summary: summary.text(),
                status_bar: summary.status_bar_text(),
                exit_code: summary.exit_code,
                user_stopped: summary.user_stopped,
                succeeded: summary.succeeded(),
                record_id: None,
                filed: None,
                filed_reason: None,
            }),
        })
    };
    let owner = RunOwner { id: req.tab_id.clone(), title: req.title.clone() };
    let ticket = match runs.registry.begin(&req.label, owner, reporter) {
        Ok(t) => t,
        // The refusal sentence has gone to the tab as a warning; the page beeps.
        Err(_) => return Ok((HelpShowOutcome { started: false }, None)),
    };
    let mut bytes = req.text.into_bytes();
    if bytes.last() != Some(&b'\n') {
        bytes.push(b'\n');
    }
    let handle = std::thread::spawn(move || {
        let _ = run_job(ticket, Box::new(RawSink(emit)), move |job| {
            job.emit(&bytes);
            0
        });
    });
    Ok((HelpShowOutcome { started: true }, Some(handle)))
}

/// Prints a Help topic in the Shell pane through the run path (`run_start`'s channel shape).
#[tauri::command]
pub fn help_show(app: AppHandle, runs: State<'_, Runs>, request: HelpShowRequest, channel: Channel<RunMessage>) -> Result<HelpShowOutcome, QnError> {
    let emit: Emit = Arc::new(move |m| {
        let _ = channel.send(m);
    });
    let (outcome, _thread) = show(&runs, request, emit)?;
    let _ = app.emit("runs://changed", ());
    Ok(outcome)
}

/// What About shows besides `app_info` (src/lib/types.ts `AboutInfo`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AboutInfo {
    /// When this executable was written, in milliseconds since 1970: the build's time. `None` when
    /// the file can't be read.
    pub built_ms: Option<u64>,
}

/// The time the file at `path` was last written.
pub fn built_ms(path: &std::path::Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// About's build line ("Built 12 May 2026 at 06:06", ABOUT-002). 0.90.34 compiled a stamp in; 2.0
/// reads the executable's own modification time, which the build sets and nothing changes after.
#[tauri::command]
pub fn about_info() -> AboutInfo {
    AboutInfo { built_ms: std::env::current_exe().ok().and_then(|p| built_ms(&p)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn collector() -> (Emit, Arc<Mutex<Vec<RunMessage>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        (Arc::new(move |m| s.lock().unwrap().push(m)), seen)
    }

    fn decode(data: &str) -> Vec<u8> {
        let t = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        for c in data.as_bytes().chunks(4) {
            let v: Vec<u32> = c.iter().filter(|b| **b != b'=').map(|b| t.iter().position(|x| x == b).unwrap() as u32).collect();
            let n = v.iter().enumerate().fold(0u32, |n, (i, x)| n | x << (18 - 6 * i));
            out.extend_from_slice(&n.to_be_bytes()[1..v.len()]);
        }
        out
    }

    fn runs() -> Runs {
        Runs::new(std::env::temp_dir().join(format!("qnet-help-test-{}.json", crate::analysis_windows::upper_uuid())))
    }

    #[test]
    fn a_help_topic_goes_through_the_run_path_under_its_label_unfiltered_and_files_no_record() {
        let runs = runs();
        let (emit, seen) = collector();
        let text = "QNA\n===\n\nSee eq. 2.7; ρ in 0.7–0.95, default 1.0";
        let req = HelpShowRequest { tab_id: "TAB".into(), title: "tandem.bnet".into(), label: "help_alg_qna".into(), text: text.into() };
        let (outcome, thread) = show(&runs, req, emit).unwrap();
        assert!(outcome.started);
        thread.unwrap().join().unwrap();
        assert!(runs.registry.active().is_none(), "the slot is released");
        let seen = seen.lock().unwrap();
        let bytes: Vec<u8> = seen.iter().filter_map(|m| if let RunMessage::Output { data } = m { Some(decode(data)) } else { None }).flatten().collect();
        assert_eq!(String::from_utf8(bytes).unwrap(), format!("{text}\n"), "the bytes are the topic, numbers untouched, ending in a newline");
        match seen.last().unwrap() {
            RunMessage::Finished { summary, succeeded, record_id, filed, .. } => {
                assert!(summary.starts_with("Help Alg Qna finished in "), "{summary}");
                assert!(*succeeded && record_id.is_none() && filed.is_none(), "no record is filed (RUN-045)");
            }
            m => panic!("ends with {m:?}"),
        }
    }

    #[test]
    fn help_is_refused_while_a_run_is_active_in_0_90_34s_words() {
        let runs = runs();
        let quiet: qnet_runner::supervisor::Reporter = Arc::new(|_: &RunEvent| {});
        let _ticket = runs.registry.begin("qna", RunOwner { id: "A".into(), title: "tandem.bnet".into() }, quiet).unwrap();
        let (emit, seen) = collector();
        let req = HelpShowRequest { tab_id: "B".into(), title: "other.bnet".into(), label: "help_shortcuts".into(), text: "x\n".into() };
        let (outcome, thread) = show(&runs, req, emit).unwrap();
        assert!(!outcome.started && thread.is_none());
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[RunMessage::Status {
                text: "Help Shortcuts was not started because QNA is already running for \u{201C}tandem.bnet\u{201D}. Stop or wait for that run first.".into(),
                severity: "warning"
            }]
        );
    }

    #[test]
    fn only_a_help_label_is_accepted() {
        assert!(is_help_label("help_alg_qna") && is_help_label("help_srbm_orthant") && is_help_label("help_general"));
        for bad in ["qna", "help_", "help", "help_Alg", "help alg", "analyze", "help_a;rm"] {
            assert!(!is_help_label(bad), "{bad}");
        }
        let (emit, _) = collector();
        let req = HelpShowRequest { tab_id: "T".into(), title: "t".into(), label: "qna".into(), text: "x".into() };
        assert!(show(&runs(), req, emit).is_err());
    }

    #[test]
    fn the_build_time_is_the_executables_modification_time() {
        let exe = std::env::current_exe().unwrap();
        let ms = built_ms(&exe).expect("the test binary has a modification time");
        assert!(ms > 1_700_000_000_000, "{ms}");
        assert_eq!(built_ms(std::path::Path::new("/no/such/file")), None);
        assert_eq!(about_info().built_ms, Some(ms));
    }
}
