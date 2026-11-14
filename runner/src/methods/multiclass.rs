//! Run Multi-Class SRBM… (experimental, `mc`): the class-aware workload diffusion solver
//! `infinite/BNAmd/mc_solver`, which reads the network's `.bnet` JSON itself. A port of the two
//! `runMultiClassSRBM` functions in `2_QNET/Sources/Qnet/QnetGUIApp.swift` (ledger METH-092,
//! METH-093, EXP-050).
//!
//! The run writes the tab's document to `BNET_mc_<pid>.bnet` and runs `mc_solver -G
//! [--legacy-params] [-n <mesh>] <file>`. 0.90.34 encoded the document with a fresh `JSONEncoder`
//! set to `[.prettyPrinted, .sortedKeys]` from `NetworkDocument(nodes:links:infiniteBuffers:
//! canvasScale:)`: the same document and the same encoder settings as `TabDocumentWriter.write`
//! (File › Save), so the file is `qnet_core::bnet::write`, byte for byte, with the pan offset again
//! `[0, 0]`. The Shell shows "Running multi-class SRBM (<flavour>, mesh=<n|auto>) ... ", then
//! "done." and a blank line once the solver exits 0, then the single-method table (the regime
//! lines, the tractability line, and the comparison table with one "Multi-Class SRBM" column over
//! E[X_k] rows, beside the exact or asymptotic column when the network is tractable), then
//! "Elapsed time". On a non-zero exit, `runWithStderrOnFailure` shows "⚠ Multi-Class SRBM failed
//! (exit N):" and the solver's standard error, logs them, and the run ends there. There is no
//! spinner, progress bar or thread banner.
//!
//! The parameter sheet (formulation, mesh) is P6. As in the golden corpus, which pressed Run at
//! once, a run here takes its initial values: the research formulation and an automatic mesh.
//!
//! Where 2.0 differs, deliberately:
//!
//! - D1: the solver is started as an argument vector; its standard output is captured instead of
//!   going to `BNET_mc_out_<pid>.txt`, the table is Rust text instead of an awk program
//!   (`qnet_core::output::table`, RUN-066 Changed), and the analytical column comes from
//!   `qnet_core::output::table::analytical_file` instead of `BNET_analytical_<pid>.txt`.
//! - The input `.bnet` is registered with the run's temporary-file guard and removed when the run
//!   ends; 0.90.34 left it, and its output file, in the temporary folder (RUN-021, Changed).

use qnet_core::bnet;
use qnet_core::output::banner::{regime_lines, table_banner, tractability_line};
use qnet_core::output::table::{analytical_file, comparison_table, TableSpec, VarName};

use crate::supervisor::{Job, ProcessSpec, Severity, Step, TempFiles};

use super::exact::{blocked, cocoa_write_error, parameters};
use super::{Method, Prepared, PreparedRun, RunBody, RunContext, StatusLine};

/// The label the stderr policy and the table use.
const LABEL: &str = "Multi-Class SRBM";

/// What the Run Multi-Class SRBM sheet answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SheetValues {
    /// The legacy formulation (matches the production SRBM export) instead of the research one.
    pub use_legacy: bool,
    /// Elements per dimension; 0 lets the solver choose.
    pub mesh_size: i64,
}

impl SheetValues {
    /// The sheet's initial values: research formulation, mesh 0 (automatic).
    pub(crate) fn initial() -> Self {
        SheetValues { use_legacy: false, mesh_size: 0 }
    }
}

/// Prepares `mc` with the sheet's initial values.
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    if method != Method::MultiClassSrbm {
        return super::unimplemented_method(method);
    }
    prepare_with(ctx, SheetValues::answered(&ctx.settings))
}

impl SheetValues {
    /// What the sheet answered (`RunSettings::sheet`): the formulation picker's index (1 = legacy)
    /// and the mesh (0 or empty = automatic), over the initial values.
    pub(crate) fn answered(s: &super::RunSettings) -> Self {
        let mut v = SheetValues::initial();
        if let Some(f) = s.sheet_i64("mc.formulation") {
            v.use_legacy = f == 1;
        }
        if let Some(m) = s.sheet_i64("mc.meshSize") {
            v.mesh_size = m;
        }
        v
    }
}

#[cfg(test)]
mod sheet_answers {
    use super::*;

    #[test]
    fn the_formulation_and_mesh_answers_reach_the_run() {
        let mut s = crate::methods::RunSettings::golden();
        assert_eq!(SheetValues::answered(&s), SheetValues::initial());
        s.sheet.insert("mc.formulation".into(), "1".into());
        s.sheet.insert("mc.meshSize".into(), "12".into());
        assert_eq!(SheetValues::answered(&s), SheetValues { use_legacy: true, mesh_size: 12 });
    }
}

/// Prepares `mc` with what the sheet answered.
pub(crate) fn prepare_with(ctx: &RunContext, values: SheetValues) -> Prepared {
    let mut lines = Vec::new();
    if !ctx.network.infinite_buffers {
        blocked(
            &mut lines,
            "Multi-class SRBM aborted: the network has finite buffers.",
            Some("The class-aware workload diffusion is defined for infinite-buffer networks. Use finite queue simulation or an explicitly bounded SRBM method for this network."),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    }
    let lookup = ctx.resolver.resolve_executable("mc_solver", "BNAmd");
    let Some(binary) = lookup.url().map(|p| p.to_path_buf()) else {
        blocked(
            &mut lines,
            "Multi-class SRBM aborted: mc_solver binary not found.",
            Some(&lookup.actionable_diagnostic()),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    };
    let use_legacy = values.use_legacy;
    let mesh_size = values.mesh_size.max(0);

    // `JSONEncoder` throws on a non-finite Double; the document's only Doubles are the canvas
    // scale, the node positions and the routing probabilities.
    if !encodable(ctx) {
        blocked(
            &mut lines,
            "Multi-class SRBM aborted: could not serialize network.",
            Some("The data couldn’t be written because it isn’t in the correct format."),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    }
    let document = bnet::write(&ctx.network);
    let mut temps = TempFiles::new();
    let path = ctx.temp_path(&format!("BNET_mc_{}.bnet", ctx.pid));
    if let Err(e) = std::fs::write(&path, document) {
        let _ = std::fs::remove_file(&path);
        blocked(
            &mut lines,
            "Multi-class SRBM aborted: could not write temp file.",
            Some(&cocoa_write_error(&path, &e)),
            Severity::Error,
        );
        return Prepared::Refused(lines);
    }
    temps.add(&path);

    let mut spec = ProcessSpec::new(binary).arg("-G");
    if use_legacy {
        spec = spec.arg("--legacy-params");
    }
    if mesh_size > 0 {
        spec = spec.arg("-n").arg(mesh_size.to_string());
    }
    let spec = spec.arg(&path);
    let flavour = if use_legacy { "legacy" } else { "research" };
    let mesh_label = if mesh_size > 0 { format!("mesh={mesh_size}") } else { "mesh=auto".to_string() };
    let table = TableText::for_context(ctx);
    Prepared::Launch(PreparedRun {
        method: Method::MultiClassSrbm,
        parameters: parameters(&[
            ("formulation", flavour),
            ("mesh per dimension", &if mesh_size > 0 { mesh_size.to_string() } else { "auto".to_string() }),
        ]),
        seed: None,
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!("Running multi-class SRBM ({flavour}, {mesh_label})..."))],
        temps,
        body: body(format!("Running multi-class SRBM ({flavour}, {mesh_label}) ... "), spec, table),
    })
}

/// Whether `JSONEncoder` could encode the document (every Double finite).
fn encodable(ctx: &RunContext) -> bool {
    let net = &ctx.network;
    net.canvas_scale.is_finite()
        && net.nodes.iter().all(|n| n.position.0.is_finite() && n.position.1.is_finite())
        && net.links.iter().all(|l| l.probability.is_finite())
}

/// What `singleMethodFormatCmd(methodLabel: "Multi-Class SRBM", varName: "X", showGamma: true,
/// showSojourn: true, showXClass: false)` needed from the tab when the command was built.
struct TableText {
    /// The regime lines and the tractability line, each with its newline.
    banner: String,
    analytical: Option<String>,
    analytical_label: String,
    analytical_is_exact: bool,
    decimals: i64,
}

impl TableText {
    fn for_context(ctx: &RunContext) -> TableText {
        let net = &ctx.network;
        let flags = ctx.flags();
        let tractable = flags.as_ref().is_some_and(|f| f.is_analytically_tractable);
        let detail = flags.as_ref().map(|f| f.tractability_detail.clone()).unwrap_or_default();
        let means = flags.as_ref().map(|f| f.tractability_means.clone()).unwrap_or_default();
        let regime = regime_lines(&net.nodes, &net.links, net.infinite_buffers);
        let banner = table_banner(&regime, tractability_line(tractable, &detail).as_deref());
        let data = ctx.analysis_data();
        TableText {
            banner,
            analytical: analytical_file(tractable, &means, data.as_ref(), VarName::X),
            analytical_label: flags.as_ref().map(|f| f.tractability_means_label.clone()).unwrap_or_default(),
            analytical_is_exact: flags.as_ref().is_some_and(|f| f.tractability_is_exact),
            decimals: ctx.settings.output_decimals,
        }
    }

    fn render(&self, solver_output: &str) -> String {
        let spec = TableSpec::single(
            LABEL,
            solver_output,
            VarName::X,
            self.analytical.clone(),
            Some(self.analytical_label.clone()),
            self.analytical_is_exact,
            self.decimals,
        );
        format!("{}{}", self.banner, comparison_table(&spec))
    }
}

/// The run: the opening words, the solver under the stderr policy, then "done.", the table and
/// "Elapsed time" when it exits 0.
fn body(opening: String, spec: ProcessSpec, table: TableText) -> RunBody {
    let step = Step::new(spec).stderr_policy(LABEL).quiet();
    Box::new(move |job: &mut Job| {
        job.emit_str(&opening);
        let outcome = match job.run_step(&step) {
            Ok(outcome) => outcome,
            Err(e) => {
                let message = format!("{} could not start: {e}", job.display_label());
                job.could_not_start(message);
                return -1;
            }
        };
        let code = outcome.shell_code();
        if code != 0 {
            // `exit $_rc` ended the wrapper after the failure text.
            return code;
        }
        job.emit_str("done.\n\n");
        let text = table.render(&String::from_utf8_lossy(&outcome.stdout));
        job.emit_str(&text);
        job.emit_elapsed_footer();
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::methods::RunSettings;
    use crate::resolver::{Resolver, ResolverConfig};

    fn context(json: &str) -> RunContext {
        let network = bnet::read(json).expect("network");
        let mut cfg = ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.development_roots = Vec::new();
        let empty = std::env::temp_dir().join(format!("qnet-mc-unit-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        cfg.env.insert("QNET_SOLVER_ROOT".into(), empty.clone().into_os_string());
        cfg.current_dir = empty.clone();
        cfg.executable_dir = Some(empty);
        RunContext::new(network, "unit.bnet", RunSettings::golden(), Arc::new(Resolver::new(cfg)))
    }

    #[test]
    fn a_finite_network_is_refused_before_the_solver_is_looked_for() {
        let json = super::super::exact::MM1_INFINITE.replace(r#""infiniteBuffers":true"#, r#""infiniteBuffers":false"#);
        let Prepared::Refused(lines) = prepare(Method::MultiClassSrbm, &context(&json)) else { panic!("launched") };
        assert_eq!(
            lines,
            vec![
                StatusLine::error("Multi-class SRBM aborted: the network has finite buffers."),
                StatusLine::info("    The class-aware workload diffusion is defined for infinite-buffer networks. Use finite queue simulation or an explicitly bounded SRBM method for this network."),
            ]
        );
    }

    #[test]
    fn a_missing_solver_is_refused_with_the_resolvers_diagnostic() {
        let Prepared::Refused(lines) = prepare(Method::MultiClassSrbm, &context(super::super::exact::MM1_INFINITE)) else {
            panic!("launched")
        };
        assert_eq!(lines[0], StatusLine::error("Multi-class SRBM aborted: mc_solver binary not found."));
        assert_eq!(lines[1], StatusLine::info("    No loadable copy of mc_solver was found for BNAmd."));
        assert_eq!(
            lines.last().unwrap(),
            &StatusLine::info("    Rebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree.")
        );
    }

    #[test]
    fn a_document_with_a_non_finite_number_cannot_be_encoded() {
        let mut ctx = context(super::super::exact::MM1_INFINITE);
        assert!(encodable(&ctx));
        ctx.network.canvas_scale = f64::NAN;
        assert!(!encodable(&ctx));
        ctx.network.canvas_scale = 1.0;
        ctx.network.nodes[0].position.1 = f64::INFINITY;
        assert!(!encodable(&ctx));
    }
}
