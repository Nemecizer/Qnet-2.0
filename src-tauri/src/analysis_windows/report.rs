//! Network ▸ Analyze Network (⇧⌘A) and Network ▸ Show Network Primitives (⇧⌘P), and the
//! Primitives run after every open (0.90.34 QnetGUIApp.swift `analyzeNetwork`,
//! `showNetworkPrimitives`, `silentScript`; ledger ANA-138…143, ANA-170…175, RUN-045, WS-111).
//!
//! Two commands, in the order 0.90.34 did the work:
//!
//! - [`analysis_report`] computes everything from the tab's document: the report text (core's
//!   `report::analysis` / `report::primitives`, golden for every example), the Status lines 0.90.34
//!   wrote before showing it ("Analyze Network ρ (data.alpha/data.capacity): …"; for Primitives the
//!   tractability notes `applyTractability` writes, "Primitives ρ: …" and one "class k α·μ per
//!   station" line per class), and for Primitives the whole silent analysis, which it publishes as
//!   the tab's flags (ANA-173). When the station model can't be computed it returns 0.90.34's
//!   "… aborted: <reason>" sentence instead, for the page to report as `reportBlocked` did.
//! - [`analysis_report_show`] shows a report in the Shell pane through the run path: it claims the
//!   one single-flight slot (`registry.begin("analyze" | "primitives", …)`, refused with 0.90.34's
//!   sentence when a run is active), sends the report's bytes as `output` messages and then
//!   `finished`, and releases the slot. Numbers are not normalised to Output Format's decimals and
//!   no Results record is filed (RUN-045).
//!
//! What 2.0 changes (decision D1): 0.90.34 wrote the report to `BNET_analysis_<pid>.txt` /
//! `BNET_primitives_<pid>.txt` and typed a `cat` wrapper into the user's shell; 2.0 sends the
//! bytes itself, so there is no temporary file and no "could not write temp file" failure.

use std::sync::Arc;

use qnet_core::cfmt::f;
use qnet_core::model::Network;
use qnet_core::extended::ReportModel;
use qnet_core::{bnet, flags, report};
use qnet_runner::supervisor::{run_job, OutputSink, RunEvent, RunOwner};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::analysis::{analyse, SilentAnalysis};
use crate::errors::QnError;
use crate::runs::{base64, severity_word, Emit, RunMessage, Runs};

/// Which report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportKind {
    Analyze,
    Primitives,
}

impl ReportKind {
    pub fn from_word(word: &str) -> Option<ReportKind> {
        match word {
            "analyze" => Some(ReportKind::Analyze),
            "primitives" => Some(ReportKind::Primitives),
            _ => None,
        }
    }

    /// 0.90.34's run label (`silentScript(label:)`), shown as "Analyze Network" / "Network Primitives".
    pub fn label(self) -> &'static str {
        match self {
            ReportKind::Analyze => "analyze",
            ReportKind::Primitives => "primitives",
        }
    }

    /// The command's name in a sentence.
    fn title(self) -> &'static str {
        match self {
            ReportKind::Analyze => "Analyze Network",
            ReportKind::Primitives => "Show Network Primitives",
        }
    }

    /// The start of the sentence `reportBlocked` wrote when the station model failed.
    fn aborted(self) -> &'static str {
        match self {
            ReportKind::Analyze => "Analyze network aborted",
            ReportKind::Primitives => "Network primitives aborted",
        }
    }
}

/// What [`analysis_report`] found (src/lib/types.ts `PreparedReport`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedReport {
    /// "Analyze network aborted: <reason>" when the station model can't be computed; then nothing
    /// else is set.
    pub failed: Option<String>,
    /// The Status lines written before the report is shown, in order. 0.90.34 wrote them without a
    /// severity, so the interface infers one from the words.
    pub status: Vec<String>,
    /// The report, exactly as the Shell shows it.
    pub report: String,
    /// Primitives only: the analysis it publishes as the tab's flags, warnings and tractability.
    pub analysis: Option<SilentAnalysis>,
}

/// The report of `kind` for `net`, with its Status lines.
pub fn prepare(kind: ReportKind, net: &Network) -> PreparedReport {
    let infinite = net.infinite_buffers;
    // Core's one gate for the reports (`extended::report_model`, review finding FIX-202): a
    // network with priorities, batch arrivals or a rate profile is not read as a plain one. Its
    // report is the sentence and the station model at the long-run customer rates; the SRBM
    // and closed-form parts, which are for classical networks, are not printed.
    let model = match qnet_core::extended::report_model(net, kind.title()) {
        Ok(m) => m,
        Err(e) => return PreparedReport { failed: Some(format!("{}: {e}", kind.aborted())), status: Vec::new(), report: String::new(), analysis: None },
    };
    let data = match model {
        ReportModel::Classical(data) => data,
        ReportModel::Extended { data, sentence, text } => {
            let mut line = format!("{} ρ at the long-run customer rates:", kind.title());
            for i in 0..data.d {
                line += &format!("  S{} α={} ρ={}", i + 1, f("%.4f", data.alpha[i]), f("%.4f", data.rho(i)));
            }
            let status = vec![format!("{} shows the station model only: {sentence}", kind.title()), line];
            return PreparedReport { failed: None, status, report: text, analysis: (kind == ReportKind::Primitives).then(|| analyse(net)) };
        }
    };
    let rho = |i: usize| if data.capacity[i] > 1e-12 { data.alpha[i] / data.capacity[i] } else { f64::NAN };
    match kind {
        ReportKind::Analyze => {
            let mut line = String::from("Analyze Network ρ (data.alpha/data.capacity):");
            for i in 0..data.d {
                line += &format!("  S{} α={} c={} ρ={}", i + 1, f("%.4f", data.alpha[i]), f("%.4f", data.capacity[i]), f("%.4f", rho(i)));
            }
            PreparedReport { failed: None, status: vec![line], report: report::analysis(&data, &net.nodes, &net.links, infinite), analysis: None }
        }
        ReportKind::Primitives => {
            let warnings = report::primitives_warnings(&data, &net.nodes, &net.links, infinite);
            // applyTractability(to:data:) runs non-quiet first and writes its notes.
            let mut status = flags::assess(&data, &net.nodes, infinite).status;
            let mut line = String::from("Primitives ρ:");
            for i in 0..data.d {
                line += &format!("  S{}[α={},μ={},ρ={}]", i + 1, f("%.4f", data.alpha[i]), f("%.4f", data.service_rates[i]), f("%.4f", rho(i)));
            }
            status.push(line);
            for k in 0..data.k {
                let mut line = format!("  class {} α·μ per station:", k + 1);
                for i in 0..data.d {
                    line += &format!("  [{}/{}]", f("%.3f", data.alpha_per_class[k][i]), f("%.3f", data.class_service_rates[k][i]));
                }
                status.push(line);
            }
            PreparedReport { failed: None, status, report: report::primitives(&data, &warnings, infinite), analysis: Some(analyse(net)) }
        }
    }
}

fn read_network(document: &Value) -> Result<Network, QnError> {
    let text = serde_json::to_string(document).map_err(|e| QnError::invalid(e.to_string()))?;
    bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't analyse this network: it isn't complete.").with_detail(e.to_string()))
}

fn kind_of(word: &str) -> Result<ReportKind, QnError> {
    ReportKind::from_word(word).ok_or_else(|| QnError::invalid(format!("There's no report called “{word}”.")))
}

/// Network ▸ Analyze Network / Show Network Primitives: the report and its Status lines for a
/// tab's document. `kind` is "analyze" or "primitives".
#[tauri::command]
pub fn analysis_report(document: Value, kind: String) -> Result<PreparedReport, QnError> {
    let kind = kind_of(&kind)?;
    Ok(prepare(kind, &read_network(&document)?))
}

/// What the page asks [`analysis_report_show`] to show.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowRequest {
    pub tab_id: String,
    pub title: String,
    /// "analyze" or "primitives".
    pub kind: String,
    /// The report from [`analysis_report`].
    pub report: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShowOutcome {
    /// False when another run holds the slot (its refusal sentence was sent as a warning).
    pub started: bool,
}

/// Passes the report's bytes to the page as they are: no display-precision filter (RUN-045).
struct RawSink(Emit);

impl OutputSink for RawSink {
    fn write(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            (self.0)(RunMessage::Output { data: base64(bytes) });
        }
    }
}

/// Claims the single-flight slot and shows `report` as the run `kind`, on a thread of its own.
/// Returns whether it started, and the thread.
pub fn show(runs: &Runs, req: ShowRequest, emit: Emit) -> Result<(ShowOutcome, Option<std::thread::JoinHandle<()>>), QnError> {
    let kind = kind_of(&req.kind)?;
    let reporter = {
        let emit = emit.clone();
        Arc::new(move |event: &RunEvent| match event {
            RunEvent::Status { text, severity } => emit(RunMessage::Status { text: text.clone(), severity: severity_word(*severity) }),
            // Nothing to measure: a report takes no time worth a progress line.
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
    let ticket = match runs.registry.begin(kind.label(), owner, reporter) {
        Ok(t) => t,
        // The refusal sentence has gone to the tab as a warning; the page beeps, as 0.90.34 did.
        Err(_) => return Ok((ShowOutcome { started: false }, None)),
    };
    let bytes = req.report.into_bytes();
    let handle = std::thread::spawn(move || {
        let _ = run_job(ticket, Box::new(RawSink(emit)), move |job| {
            job.emit(&bytes);
            0
        });
    });
    Ok((ShowOutcome { started: true }, Some(handle)))
}

/// Shows a prepared report in the Shell pane through the run path (`run_start`'s channel shape).
#[tauri::command]
pub fn analysis_report_show(app: AppHandle, runs: State<'_, Runs>, request: ShowRequest, channel: Channel<RunMessage>) -> Result<ShowOutcome, QnError> {
    let emit: Emit = Arc::new(move |m| {
        let _ = channel.send(m);
    });
    let (outcome, _thread) = show(&runs, request, emit)?;
    let _ = app.emit("runs://changed", ());
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn examples() -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root().join("examples"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter_map(|f| f.strip_suffix(".bnet").map(str::to_string))
            .collect();
        names.sort();
        assert_eq!(names.len(), 50);
        names
    }

    fn document(name: &str) -> Value {
        serde_json::from_str(&std::fs::read_to_string(root().join("examples").join(format!("{name}.bnet"))).unwrap()).unwrap()
    }

    fn golden(name: &str, file: &str) -> Option<String> {
        std::fs::read_to_string(root().join("golden").join(name).join(file)).ok()
    }

    /// The command's report against golden/<example>/<file> for every example, with 2.0's two
    /// Changed sentences put back as 0.90.34 had them (ANA-154, ANA-180), or its refusal against
    /// <file>.error.txt.
    fn check_every_example(kind: &str, file: &str) {
        let mut differ = Vec::new();
        for name in examples() {
            let p = analysis_report(document(&name), kind.into()).unwrap();
            let (ours, want) = match &p.failed {
                Some(sentence) => (format!("{sentence}\n"), golden(&name, &format!("{file}.error.txt"))),
                None => (
                    p.report.replace(report::MD1_TAIL, report::MD1_TAIL_0_90_34).replace(report::MU_LEGEND, report::MU_LEGEND_0_90_34),
                    golden(&name, file),
                ),
            };
            let want = want.unwrap_or_else(|| panic!("{name}: 0.90.34 wrote the other outcome"));
            if ours != want {
                differ.push(name);
            }
        }
        assert!(differ.is_empty(), "{kind} differs from 0.90.34 for {differ:?}");
    }

    #[test]
    fn analyze_networks_report_is_0_90_34s_for_every_example() {
        check_every_example("analyze", "analysis.txt");
    }

    #[test]
    fn network_primitives_report_is_0_90_34s_for_every_example() {
        check_every_example("primitives", "primitives.txt");
    }

    #[test]
    fn the_status_lines_are_0_90_34s() {
        let a = analysis_report(document("OpenJackson.d2.feedback.p50.inf"), "analyze".into()).unwrap();
        assert_eq!(a.status, vec!["Analyze Network ρ (data.alpha/data.capacity):  S1 α=2.0000 c=2.8571 ρ=0.7000  S2 α=1.0000 c=1.4286 ρ=0.7000".to_string()]);
        assert!(a.analysis.is_none(), "Analyze Network publishes no flags (ANA-141)");

        let p = analysis_report(document("2dtandem"), "primitives".into()).unwrap();
        assert_eq!(p.status, vec!["Primitives ρ:  S1[α=1.0000,μ=1.0000,ρ=1.0000]  S2[α=1.0000,μ=1.0000,ρ=1.0000]".to_string(), "  class 1 α·μ per station:  [1.000/1.000]  [1.000/1.000]".into()]);
        let flags = p.analysis.unwrap();
        assert_eq!(flags.outcome, "analysed");
        assert_eq!(flags.warnings.len(), 2, "the warnings it publishes (ANA-173)");

        // applyTractability's note comes first, as the silent analysis writes it.
        let g = analysis_report(document("ShenChenDaiDai02.d2.c1.1.fin"), "primitives".into()).unwrap();
        let notes = golden("ShenChenDaiDai02.d2.c1.1.fin", "flags.txt").unwrap();
        let want: Vec<&str> = notes.split("status:\n").nth(1).unwrap().lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(&g.status[..want.len()], want.as_slice());
        assert!(g.status[want.len()].starts_with("Primitives ρ:"));
    }

    /// Review finding FIX-202: both reports read a batch or priority network as a plain one
    /// (the bundled batch example, 0.24 batches of mean 2.5 per unit time at μ = 1, was ρ = 0.24).
    #[test]
    fn a_network_with_batches_or_priorities_is_reported_as_what_it_is() {
        let extended = |name: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(root().join("examples/extended").join(name)).unwrap()).unwrap() };
        for kind in ["analyze", "primitives"] {
            let b = analysis_report(extended("BatchArrivals.mx-m-1.geometric.bnet"), kind.into()).unwrap();
            assert_eq!(b.failed, None);
            assert!(b.report.starts_with("This network uses batch arrivals at Src1. "), "{}", b.report);
            assert!(b.report.contains("S1: α=0.600000  μ_eff=1.000000  c=1.000000  ρ=0.600000"), "{}", b.report);
            assert!(!b.report.contains("0.2400") && !b.report.contains("SRBM") && !b.report.contains("Covariance"), "{}", b.report);
            assert!(b.status[0].contains("shows the station model only: This network uses batch arrivals"), "{:?}", b.status);
            assert!(b.status[1].ends_with("S1 α=0.6000 ρ=0.6000"), "{:?}", b.status);
            assert!(b.status.iter().all(|l| !l.contains("Jackson")), "{:?}", b.status);
            assert_eq!(b.analysis.is_some(), kind == "primitives");

            let p = analysis_report(extended("PriorityHelpDesk.mg1.2class.bnet"), kind.into()).unwrap();
            assert!(p.report.starts_with("This network uses priority service at "), "{}", p.report);
            assert!(p.report.contains("which do not depend on the order of service") && p.report.contains("ρ=0.700000"), "{}", p.report);
            assert!(!p.report.contains("skew") && p.status.iter().all(|l| !l.contains("skew")), "{:?}", p.status);
        }
    }

    #[test]
    fn a_network_without_a_station_model_is_refused_with_0_90_34s_sentence() {
        let mut doc = document("2dtandem");
        let nodes = doc["nodes"].as_array().unwrap().iter().filter(|n| n["kind"] != "sink").cloned().collect();
        doc["nodes"] = Value::Array(nodes);
        let a = analysis_report(doc.clone(), "analyze".into()).unwrap();
        assert_eq!(a.failed.as_deref(), Some("Analyze network aborted: The network has no sink node."));
        assert!(a.status.is_empty() && a.report.is_empty());
        let p = analysis_report(doc, "primitives".into()).unwrap();
        assert_eq!(p.failed.as_deref(), Some("Network primitives aborted: The network has no sink node."));
        assert!(analysis_report(document("2dtandem"), "summary".into()).is_err());
    }

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

    #[test]
    fn showing_a_report_occupies_the_run_slot_and_sends_its_bytes_then_the_finish() {
        let runs = Runs::new(std::env::temp_dir().join(format!("qnet-report-test-{}.json", crate::analysis_windows::upper_uuid())));
        let golden_text = golden("2dtandem", "analysis.txt").unwrap();
        let (emit, seen) = collector();
        let req = ShowRequest { tab_id: "TAB".into(), title: "2dtandem.bnet".into(), kind: "analyze".into(), report: golden_text.clone() };
        let (outcome, thread) = show(&runs, req, emit).unwrap();
        assert!(outcome.started);
        thread.unwrap().join().unwrap();
        assert!(runs.registry.active().is_none(), "the slot is released");
        let seen = seen.lock().unwrap();
        let bytes: Vec<u8> = seen.iter().filter_map(|m| if let RunMessage::Output { data } = m { Some(decode(data)) } else { None }).flatten().collect();
        assert_eq!(String::from_utf8(bytes).unwrap(), golden_text, "the bytes are the report, numbers untouched");
        match seen.last().unwrap() {
            RunMessage::Finished { summary, succeeded, record_id, filed, .. } => {
                assert!(summary.starts_with("Analyze Network finished in "), "{summary}");
                assert!(*succeeded && record_id.is_none() && filed.is_none(), "no record is filed (RUN-045)");
            }
            m => panic!("ends with {m:?}"),
        }
    }

    #[test]
    fn a_report_is_refused_while_a_run_is_active_in_0_90_34s_words() {
        let runs = Runs::new(std::env::temp_dir().join(format!("qnet-report-test-{}.json", crate::analysis_windows::upper_uuid())));
        let quiet: qnet_runner::supervisor::Reporter = Arc::new(|_: &RunEvent| {});
        let _ticket = runs.registry.begin("qna", RunOwner { id: "A".into(), title: "tandem.bnet".into() }, quiet).unwrap();
        let (emit, seen) = collector();
        let req = ShowRequest { tab_id: "B".into(), title: "other.bnet".into(), kind: "primitives".into(), report: "x\n".into() };
        let (outcome, thread) = show(&runs, req, emit).unwrap();
        assert!(!outcome.started && thread.is_none());
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[RunMessage::Status {
                text: "Network Primitives was not started because QNA is already running for \u{201C}tandem.bnet\u{201D}. Stop or wait for that run first.".into(),
                severity: "warning"
            }]
        );
    }
}
