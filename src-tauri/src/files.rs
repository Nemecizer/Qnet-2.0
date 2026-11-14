//! The File menu's Rust side (ledger 5.9, 8.7, 14.6, 14.8): where the bundled examples are, the
//! solver-input exports, and Network ▸ Generate Random Network.
//!
//! The interface owns the open document and sends it as the `.bnet` JSON object; each command
//! parses it with `qnet_core::bnet::read` (as src-tauri/src/documents.rs does) and hands it to
//! core's exporter or generator, which reproduce 0.90.34 byte for byte (core/tests/golden_*.rs).
//! Every file is written atomically (`util::write_atomic`).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use qnet_core::export::all::{self, BlockingConvention};
use qnet_core::export::{fbnasim, qna, srbm_box};
use qnet_core::generate::{self, Topology};
use qnet_core::model::Network;

use crate::documents::file_name;
use crate::errors::QnError;
use crate::util;

// ---------------------------------------------------------------------------------------------
// The examples folder (ledger WS-114, WS-115, EX-053, EX-054)

/// One lookup: the folder when a candidate exists, and always every candidate tried, in order.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExamplesLookup {
    pub path: Option<String>,
    pub searched: Vec<String>,
    /// The first four candidates joined, plus ", and N more" (0.90.34 `ExamplesLookup.searchTrail`).
    pub trail: String,
    /// Where the panel opens when nothing was found (0.90.34: the home folder).
    pub home: Option<String>,
}

/// What the lookup reads from the world, so a test can supply its own.
pub struct ExamplesWorld {
    /// 0.90.34's `Bundle.main.resourceURL`: `<X>.app/Contents/Resources` in a bundle, else the
    /// executable's own folder.
    pub resources: Option<PathBuf>,
    pub solver_root: Option<String>,
    pub current_dir: PathBuf,
    pub executable_dir: Option<PathBuf>,
    /// 2.0's addition, searched last: the repository's `examples/` in a debug build.
    pub development: Option<PathBuf>,
}

impl ExamplesWorld {
    pub fn from_process() -> ExamplesWorld {
        let executable_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
        let resources = executable_dir.as_ref().map(|d| bundle_resources_for(d).unwrap_or_else(|| d.clone()));
        let development = cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples"));
        ExamplesWorld {
            resources,
            solver_root: std::env::var("QNET_SOLVER_ROOT").ok(),
            current_dir: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            executable_dir,
            development,
        }
    }
}

/// `<X>.app/Contents/Resources` for an executable folder `<X>.app/Contents/MacOS`, else None
/// (as runner/src/resolver.rs finds the bundle).
fn bundle_resources_for(executable_dir: &Path) -> Option<PathBuf> {
    let contents = executable_dir.parent()?;
    let app = contents.parent()?;
    let is_bundle = executable_dir.file_name() == Some(OsStr::new("MacOS"))
        && contents.file_name() == Some(OsStr::new("Contents"))
        && app.extension() == Some(OsStr::new("app"));
    is_bundle.then(|| contents.join("Resources"))
}

/// Foundation's `standardizedFileURL` path: `.` dropped and `..` removing the component before it,
/// by text alone.
fn standardize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 0.90.34 `locateExamples`, in its order: the app's Resources `examples` then `input/examples`;
/// `$QNET_SOLVER_ROOT/Contents/Resources/examples`, `…/examples`, `…/input/examples`; for up to 7
/// ancestors of the working directory and then of the executable, `Qnet.app/Contents/Resources/
/// examples`; then `examples` and `input/examples` in those ancestors. 2.0 adds the repository's
/// `examples/` last in a debug build, so `tauri dev` finds them whatever its working directory.
pub fn candidates(world: &ExamplesWorld) -> Vec<PathBuf> {
    let leaves = ["examples", "input/examples"];
    let mut out = Vec::new();
    if let Some(r) = &world.resources {
        out.extend(leaves.iter().map(|l| r.join(l)));
    }
    if let Some(raw) = world.solver_root.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        let root = PathBuf::from(raw);
        out.push(root.join("Contents/Resources/examples"));
        out.extend(leaves.iter().map(|l| root.join(l)));
    }
    let mut anchors = vec![world.current_dir.clone()];
    anchors.extend(world.executable_dir.clone());
    let mut ancestors: Vec<PathBuf> = Vec::new();
    for anchor in anchors {
        let mut current = standardize(&anchor);
        for _ in 0..7 {
            if !ancestors.contains(&current) {
                ancestors.push(current.clone());
            }
            let Some(parent) = current.parent().map(Path::to_path_buf) else { break };
            if parent == current {
                break;
            }
            current = parent;
        }
    }
    for a in &ancestors {
        out.push(a.join("Qnet.app/Contents/Resources/examples"));
    }
    for a in &ancestors {
        out.extend(leaves.iter().map(|l| a.join(l)));
    }
    if let Some(d) = &world.development {
        out.push(standardize(d));
    }
    out
}

pub fn locate(world: &ExamplesWorld) -> ExamplesLookup {
    let searched = candidates(world);
    let found = searched.iter().find(|c| c.is_dir()).map(|c| c.display().to_string());
    let names: Vec<String> = searched.iter().map(|c| c.display().to_string()).collect();
    let shown = names.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
    let rest = names.len().saturating_sub(4);
    let trail = if rest > 0 { format!("{shown}, and {rest} more") } else { shown };
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    ExamplesLookup { path: found, searched: names, trail, home }
}

/// Where File ▸ Open Example… starts.
#[tauri::command]
pub fn examples_locate() -> ExamplesLookup {
    locate(&ExamplesWorld::from_process())
}

// ---------------------------------------------------------------------------------------------
// Exports (ledger EXP-108…115, MENU-024…027)

fn network_of(document: &Value) -> Result<Network, QnError> {
    let text = serde_json::to_string(document).map_err(|e| QnError::invalid(e.to_string()))?;
    qnet_core::bnet::read(&text)
        .map_err(|e| QnError::invalid("Qnet couldn't export this network: it isn't complete.").with_detail(e.to_string()))
}

fn convention_of(name: &str) -> Result<BlockingConvention, QnError> {
    match name {
        "manufacturing" => Ok(BlockingConvention::Manufacturing),
        "loss" => Ok(BlockingConvention::LossCorrection),
        "bas" => Ok(BlockingConvention::BasCorrection),
        other => Err(QnError::invalid(format!("There's no blocking convention called “{other}”."))),
    }
}

/// One single-file export's text, or the exporter's refusal (its 0.90.34 sentence as the message).
/// `format` is "fbnasim" (`NetworkExporter`), "qna" (`QNAExporter`) or "srbm" (`SRBMExporter.export`,
/// with `convention` applied to finite-buffer networks only); `generated` is fBNAsim's
/// `# Generated:` time text.
pub fn export_text_of(format: &str, net: &Network, convention: BlockingConvention, generated: &str) -> Result<String, QnError> {
    let (n, l, inf) = (&net.nodes[..], &net.links[..], net.infinite_buffers);
    // No exporter writes priorities, batch sizes or a rate profile (core's one rule).
    if let Some(sentence) = qnet_core::extended::export_refusal(net) {
        return Err(QnError::invalid(sentence));
    }
    match format {
        "fbnasim" => fbnasim::export(n, l, generated).map_err(|e| QnError::invalid(e.message())),
        "qna" => qna::export(n, l).map_err(|e| QnError::invalid(e.message())),
        "srbm" => {
            let loss = !inf && convention == BlockingConvention::LossCorrection;
            let bas = !inf && convention == BlockingConvention::BasCorrection;
            srbm_box::export(n, l, inf, loss, bas).map_err(|e| QnError::invalid(e.message()))
        }
        other => Err(QnError::invalid(format!("There's no export format called “{other}”."))),
    }
}

#[tauri::command]
pub fn export_text(format: String, document: Value, convention: Option<String>, generated: Option<String>) -> Result<String, QnError> {
    let net = network_of(&document)?;
    let convention = convention_of(convention.as_deref().unwrap_or("manufacturing"))?;
    export_text_of(&format, &net, convention, generated.as_deref().unwrap_or(""))
}

/// Writes an export's text to `path` atomically; returns the file name. A failure's message is
/// the system's reason, which the interface puts after "… write failed: ".
#[tauri::command]
pub fn export_save(path: String, text: String) -> Result<String, QnError> {
    let p = Path::new(&path);
    util::write_atomic(p, text.as_bytes()).map_err(QnError::failed)?;
    Ok(file_name(p))
}

/// What Export All wrote, as the Status lines 0.90.34 logged (`all::status_lines`).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportAllReport {
    pub written: Vec<String>,
    /// "Exported N solver input file(s) to <folder>: <names>." (+ the convention for finite buffers).
    pub summary: String,
    /// "k of n solver input files were not written." and one "<file>: <reason>" line per failure.
    pub warning: Option<String>,
    pub warning_detail: Option<String>,
}

pub fn export_all_to(net: &Network, convention: BlockingConvention, folder: &Path, generated: &str) -> ExportAllReport {
    let mut outputs = all::export_all(net, convention, generated);
    for o in outputs.iter_mut() {
        if let Ok(text) = &o.result {
            if let Err(e) = util::write_atomic(&folder.join(o.file), text.as_bytes()) {
                o.result = Err(e);
            }
        }
    }
    let shown = folder.display().to_string();
    let (summary, warning) = all::status_lines(&outputs, &shown, net, convention);
    ExportAllReport {
        written: outputs.iter().filter(|o| o.result.is_ok()).map(|o| o.file.to_string()).collect(),
        summary,
        warning: warning.as_ref().map(|w| w.0.clone()),
        warning_detail: warning.map(|w| w.1),
    }
}

#[tauri::command]
pub fn export_all_inputs(document: Value, convention: String, folder: String, generated: String) -> Result<ExportAllReport, QnError> {
    let net = network_of(&document)?;
    let convention = convention_of(&convention)?;
    if let Some(sentence) = qnet_core::extended::export_refusal(&net) {
        return Err(QnError::invalid(sentence));
    }
    Ok(export_all_to(&net, convention, Path::new(&folder), &generated))
}

// ---------------------------------------------------------------------------------------------
// Generate Random Network (ledger GEN-001…011)

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub stations: i64,
    pub classes: i64,
    pub infinite_buffers: bool,
    pub target_rho: f64,
    /// "feedForward", "jacksonFeedback", "generalPMatrix" or "reentrantFeedback".
    pub topology: String,
    /// Blank for a fresh seed; otherwise a non-negative integer (u64), as text so no digit is lost.
    pub seed: Option<String>,
    /// The new tab's title, "Random N" (chosen by the interface, which knows the tabs).
    pub title: String,
}

/// One Status line; `severity` only where 0.90.34 gave one (otherwise it inferred it).
#[derive(Debug, Serialize, PartialEq)]
pub struct StatusLine {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedNetwork {
    /// The network as 0.90.34 would write it; JSON.parse gives the tab's document.
    pub text: String,
    pub lines: Vec<StatusLine>,
}

fn topology_of(name: &str) -> Result<Topology, QnError> {
    match name {
        "feedForward" => Ok(Topology::FeedForward),
        "jacksonFeedback" => Ok(Topology::JacksonFeedback),
        "generalPMatrix" => Ok(Topology::GeneralPMatrix),
        "reentrantFeedback" => Ok(Topology::ReentrantFeedback),
        other => Err(QnError::invalid(format!("There's no topology called “{other}”."))),
    }
}

/// The topology as 0.90.34's "Generated …" line names it.
fn topology_label(t: Topology) -> &'static str {
    match t {
        Topology::FeedForward => "feed-forward",
        Topology::JacksonFeedback => "Jackson feedback",
        Topology::GeneralPMatrix => "general P-matrix",
        Topology::ReentrantFeedback => "reentrant (class-change)",
    }
}

/// An upper-case version-4 UUID, as 0.90.34's `UUID()` gave every node and link.
fn random_uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// The Status lines 0.90.34's `createRandomNetworkTab` wrote for a generated network (GEN-010, 011).
pub fn generated_lines(title: &str, params: &generate::Parameters, net: &Network) -> Vec<StatusLine> {
    let line = |text: String| StatusLine { text, severity: None };
    let mut lines = vec![line(format!(
        "Generated {title}: d={}, c={}, {}target ρ={}, topology={}.",
        params.stations,
        params.classes,
        if params.infinite_buffers { "infinite buffers, " } else { "finite buffers, " },
        qnet_core::cfmt::f("%.2f", params.target_rho),
        topology_label(params.topology),
    ))];
    match qnet_core::traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false) {
        Ok(data) => {
            let mut rho = String::from("Qnet-computed ρ:");
            for i in 0..data.d {
                // String(format: "  S%d=%.3f", i + 1, rho): NaN where the capacity is ~0.
                rho += &format!("  S{}={}", i + 1, qnet_core::cfmt::f("%.3f", data.rho(i)));
            }
            lines.push(line(rho));
            let warnings = qnet_core::report::network_warnings(&data, net.infinite_buffers);
            if warnings.is_empty() {
                lines.push(line("No warnings — banner should stay hidden.".into()));
            } else {
                lines.push(line(format!("Banner WILL fire — warnings: {}", warnings.len())));
                lines.extend(warnings.into_iter().map(|w| line(format!("  • {w}"))));
            }
        }
        Err(e) => lines.push(StatusLine { text: format!("SRBMExporter failed on generated network: {}", e.message()), severity: Some("error") }),
    }
    lines
}

pub fn generate_with(req: &GenerateRequest, ids: &mut impl generate::IdSource) -> Result<GeneratedNetwork, QnError> {
    let seed = match req.seed.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => Some(s.parse::<u64>().map_err(|_| QnError::invalid("Seed must be a non-negative integer, or blank for a random seed."))?),
    };
    let params = generate::Parameters {
        stations: req.stations,
        classes: req.classes,
        infinite_buffers: req.infinite_buffers,
        target_rho: req.target_rho,
        topology: topology_of(&req.topology)?,
        seed,
    }
    .sheet_clamped();
    let net = generate::generate(&params, ids);
    Ok(GeneratedNetwork { text: qnet_core::bnet::write(&net), lines: generated_lines(&req.title, &params, &net) })
}

#[tauri::command]
pub fn network_generate(request: GenerateRequest) -> Result<GeneratedNetwork, QnError> {
    generate_with(&request, &mut random_uuid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        standardize(&Path::new(env!("CARGO_MANIFEST_DIR")).join(".."))
    }

    fn examples() -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(repo().join("examples"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("bnet"))
            .collect();
        v.sort();
        v
    }

    /// The example as the interface holds it: what document_read hands back, JSON.parse'd.
    fn document(path: &Path) -> Value {
        let opened = crate::documents::read(path).unwrap();
        serde_json::from_str(&opened.text).unwrap()
    }

    fn golden(example: &Path, file: &str) -> PathBuf {
        repo().join("golden").join(example.file_stem().unwrap()).join(file)
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qnet-files-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Every line but fBNAsim's `# Generated:` line, which carries the time.
    fn without_generated(text: &str) -> String {
        text.lines().filter(|l| !l.starts_with("# Generated:")).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn every_examples_qna_and_fbnasim_export_through_the_command_equals_the_golden_corpus() {
        let mut compared = 0;
        for ex in examples() {
            let doc = document(&ex);
            for (format, file) in [("qna", "qna.qna"), ("fbnasim", "fbnasim.txt")] {
                let got = export_text(format.into(), doc.clone(), None, Some("11/10/26, 14:11:04".into()));
                let ok = golden(&ex, file);
                let err = golden(&ex, &format!("{file}.error.txt"));
                if ok.exists() {
                    let want = std::fs::read_to_string(&ok).unwrap();
                    let got = got.unwrap_or_else(|e| panic!("{}: {format}: {}", ex.display(), e.message));
                    assert_eq!(without_generated(&got), without_generated(&want), "{} {format}", ex.display());
                    compared += 1;
                } else if err.exists() {
                    let e = got.unwrap_err();
                    assert!(std::fs::read_to_string(&err).unwrap().contains(&e.message), "{}: {}", ex.display(), e.message);
                    compared += 1;
                }
            }
        }
        assert!(compared >= 90, "compared {compared}");
    }

    #[test]
    fn the_srbm_export_is_the_base_block_of_the_spectral_file_and_applies_the_convention_to_finite_networks_only() {
        let mut finite_seen = false;
        for ex in examples() {
            let doc = document(&ex);
            let net = network_of(&doc).unwrap();
            let Ok(plain) = export_text("srbm".into(), doc.clone(), Some("manufacturing".into()), None) else { continue };
            // fbnasm.in is exportForSpectral: the same base block, then the degree and class tail.
            if let Ok(spectral) = std::fs::read_to_string(golden(&ex, "fbnasm.in")) {
                assert!(spectral.starts_with(&plain), "{}", ex.display());
            }
            let loss = export_text("srbm".into(), doc.clone(), Some("loss".into()), None).unwrap();
            if net.infinite_buffers {
                assert_eq!(loss, plain, "{}", ex.display());
            } else {
                let want = srbm_box::export(&net.nodes, &net.links, false, true, false).unwrap();
                assert_eq!(loss, want);
                finite_seen = true;
            }
        }
        assert!(finite_seen);
        assert!(export_text("srbm".into(), serde_json::json!({"nodes": []}), None, None).is_err());
    }

    /// Review finding FIX-202: no exporter writes priorities, batch sizes or a rate profile,
    /// so a solver input for such a network would be a plain network's.
    #[test]
    fn a_network_with_batches_or_priorities_is_not_exported_as_a_plain_one() {
        for name in ["BatchArrivals.mx-m-1.geometric.bnet", "PriorityHelpDesk.mg1.2class.bnet"] {
            let doc: Value = serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/extended").join(name)).unwrap()).unwrap();
            for format in ["fbnasim", "qna", "srbm"] {
                let e = export_text(format.into(), doc.clone(), None, None).unwrap_err();
                assert!(e.message.contains("A solver input file does not model that"), "{name} {format}: {}", e.message);
            }
            let out = temp(&format!("refused-{name}"));
            assert!(export_all_inputs(doc, "manufacturing".into(), out.display().to_string(), String::new()).is_err());
            assert!(!out.join("case.qna").exists());
        }
    }

    #[test]
    fn export_all_writes_the_seven_files_the_corpus_has_and_says_so_in_0_90_34s_words() {
        let mut n = 0;
        for ex in examples() {
            let dir = golden(&ex, "export-all");
            if !dir.is_dir() {
                continue;
            }
            let out = temp(&format!("all-{}", ex.file_stem().unwrap().to_string_lossy()));
            let net = network_of(&document(&ex)).unwrap();
            let r = export_all_inputs(document(&ex), "manufacturing".into(), out.display().to_string(), "11/10/26, 14:11:04".into()).unwrap();
            for name in &r.written {
                let want = std::fs::read_to_string(dir.join(name)).unwrap();
                let got = std::fs::read_to_string(out.join(name)).unwrap();
                assert_eq!(without_generated(&got), without_generated(&want), "{} {name}", ex.display());
            }
            assert!(r.summary.starts_with(&format!("Exported {} solver input file(s) to {}: ", r.written.len(), out.display())), "{}", r.summary);
            assert_eq!(r.summary.ends_with(" Blocking convention: Manufacturing blocking (SRBM default)."), !net.infinite_buffers);
            if r.written.len() < 7 {
                assert_eq!(r.warning.as_deref().unwrap(), format!("{} of 7 solver input files were not written.", 7 - r.written.len()));
            }
            n += 1;
        }
        assert!(n >= 40, "{n}");
    }

    #[test]
    fn a_write_failure_is_reported_per_file_not_as_a_refusal() {
        let blocked = temp("blocked").join("not-a-folder");
        std::fs::write(&blocked, "a file where the folder should be").unwrap();
        let ex = examples().into_iter().next().unwrap();
        let r = export_all_inputs(document(&ex), "manufacturing".into(), blocked.display().to_string(), "x".into()).unwrap();
        assert!(r.written.is_empty());
        assert_eq!(r.warning.as_deref(), Some("7 of 7 solver input files were not written."));
        assert_eq!(r.warning_detail.unwrap().lines().count(), 7);
        assert!(export_save(blocked.join("x.qna").display().to_string(), "t".into()).is_err());
        let ok = temp("save").join("t.qna");
        assert_eq!(export_save(ok.display().to_string(), "text".into()).unwrap(), "t.qna");
        assert_eq!(std::fs::read_to_string(ok).unwrap(), "text");
    }

    #[test]
    fn the_examples_folder_is_looked_for_in_0_90_34s_order_and_the_trail_names_four() {
        let world = ExamplesWorld {
            resources: Some(PathBuf::from("/A/Qnet.app/Contents/Resources")),
            solver_root: Some(" /S ".into()),
            current_dir: PathBuf::from("/w/x"),
            executable_dir: Some(PathBuf::from("/A/Qnet.app/Contents/MacOS")),
            development: None,
        };
        let c: Vec<String> = candidates(&world).iter().map(|p| p.display().to_string()).collect();
        assert_eq!(
            &c[..8],
            [
                "/A/Qnet.app/Contents/Resources/examples",
                "/A/Qnet.app/Contents/Resources/input/examples",
                "/S/Contents/Resources/examples",
                "/S/examples",
                "/S/input/examples",
                "/w/x/Qnet.app/Contents/Resources/examples",
                "/w/Qnet.app/Contents/Resources/examples",
                "/Qnet.app/Contents/Resources/examples",
            ]
        );
        // Ancestors of the working directory first, then of the executable, each once.
        assert!(c.contains(&"/A/Qnet.app/Contents/MacOS/Qnet.app/Contents/Resources/examples".to_string()));
        assert_eq!(c.iter().filter(|p| *p == "/Qnet.app/Contents/Resources/examples").count(), 1);
        assert_eq!(c.last().unwrap(), "/A/input/examples");
        let l = locate(&world);
        assert_eq!(l.path, None);
        assert_eq!(l.trail, format!("{}, and {} more", c[..4].join(", "), c.len() - 4));

        let dev = ExamplesWorld { resources: None, solver_root: None, current_dir: repo().join("src-tauri"), executable_dir: None, development: None };
        assert_eq!(locate(&dev).path.unwrap(), repo().join("examples").display().to_string());
    }

    #[test]
    fn a_generated_network_and_its_status_lines() {
        let req = GenerateRequest {
            stations: 4,
            classes: 3,
            infinite_buffers: true,
            target_rho: 0.9,
            topology: "feedForward".into(),
            seed: Some("42".into()),
            title: "Random 2".into(),
        };
        let a = generate_with(&req, &mut generate::CountingIds::new()).unwrap();
        let b = generate_with(&req, &mut generate::CountingIds::new()).unwrap();
        assert_eq!(a.text, b.text, "a seed reproduces the network");
        assert_eq!(a.lines[0].text, "Generated Random 2: d=4, c=3, infinite buffers, target ρ=0.90, topology=feed-forward.");
        assert!(a.lines[1].text.starts_with("Qnet-computed ρ:  S1="), "{}", a.lines[1].text);
        assert_eq!(a.lines[1].text.matches("  S").count(), 4);
        assert!(a.lines[2].text == "No warnings — banner should stay hidden." || a.lines[2].text.starts_with("Banner WILL fire — warnings: "));
        let net = qnet_core::bnet::read(&a.text).unwrap();
        assert!(net.infinite_buffers);

        let finite = GenerateRequest { infinite_buffers: false, topology: "reentrantFeedback".into(), target_rho: 0.125, stations: 99, ..req };
        let f = generate_with(&finite, &mut generate::CountingIds::new()).unwrap();
        // The sheet's clamp (stations to 20) and C's rounding of 0.125 (to even: 0.12).
        assert_eq!(f.lines[0].text, "Generated Random 2: d=20, c=3, finite buffers, target ρ=0.12, topology=reentrant (class-change).");
        let bad = GenerateRequest { seed: Some("-1".into()), ..finite };
        assert_eq!(generate_with(&bad, &mut generate::CountingIds::new()).unwrap_err().message, "Seed must be a non-negative integer, or blank for a random seed.");
        assert!(random_uuid().chars().all(|c| c == '-' || c.is_ascii_digit() || c.is_ascii_uppercase()));
    }
}
