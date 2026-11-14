//! One run specification per Run-menu method (PLAN.md §7 P3): what each of 0.90.34's `run…()`
//! actions in `2_QNET/Sources/Qnet/QnetGUIApp.swift` checked, exported, ran and printed, as a
//! function from a network and its settings to either a refusal or a prepared run.
//!
//! The split follows what 0.90.34 did before and after it typed a command into the Shell:
//!
//! - **Preparing** ([`prepare`]) is everything up to that point: resolving the solver, the
//!   pre-checks and their Status sentences, the exporter, writing the input file, choosing seeds,
//!   and the parameters the Results record keeps. It runs on the caller's thread, quickly, and
//!   either refuses ([`Prepared::Refused`], with the Status lines 0.90.34 wrote) or returns a
//!   [`PreparedRun`].
//! - **Running** is the prepared run's `body`, executed by the supervisor as a job
//!   ([`launch`]): the steps the bash wrapper ran, the text its awk and perl stages printed
//!   (composed by `qnet_core::output`), and the exit status the wrapper reported.
//!
//! Where a Status line appears matters and is kept: a line 0.90.34 wrote before `runScript` is in
//! [`PreparedRun::before`] (written even if the launch is then refused, as 0.90.34 did); a line it
//! wrote only when `runScript` returned true ("Running QNA...") is in [`PreparedRun::accepted`].
//!
//! The methods themselves live in submodules, one family per file.

pub mod settings;
pub mod shell;

// One file per family of methods.
mod exact; // product_form, qbd, truncated_ctmc, generic_ctmc, fb_decomp
mod regenerative; // regenerative_mc
mod bar; // adaptive_bar, bar_bounds
mod multiclass; // mc
mod single; // qna, rqna, sbd, inf_sm, inf_sim, sm, fm, sim
mod comparison; // inf_cmp, cmp
mod mlmc; // mlmc
mod lp; // lp, flp
pub mod closed; // closed_pf (new in 2.1: in process, no solver)
pub mod siminproc; // sim_inproc (new in 2.1: in process, no solver)
pub mod singlestation; // priority_exact, batch_exact (new in 2.1: in process, no solver)
pub mod testset; // Run › Test Set and Run › Spectral Convergence (not Run-menu methods)

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;

use qnet_core::flags::{self, Flags};
use qnet_core::model::Network;
use qnet_core::traffic::SrbmData;

use crate::resolver::Resolver;
use crate::supervisor::{
    run_job, Job, JobReport, OutputSink, Refused, Reporter, RunEvent, RunOwner, RunRegistry, Severity,
    TempFiles,
};

pub use settings::{RunSettings, SpectralConvergenceParameters, TestSetParameters};

/// Every run 0.90.34's Run menu (and its Test Set and Spectral Convergence sheets) could start.
/// The run label is 0.90.34's (`resultMethod(forRunLabel:)`, the golden folder names).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Method {
    /// Run Comparison, infinite buffers (`inf_cmp`).
    InfiniteComparison,
    /// Run Monte Carlo…, infinite buffers (`inf_sim`, jackson_sim).
    InfiniteMonteCarlo,
    /// Run Exact Open Product Form (`product_form`).
    ProductForm,
    /// Run Exact Matrix-Analytic QBD (`qbd`).
    Qbd,
    /// Run Adaptive Truncated CTMC (`truncated_ctmc`).
    TruncatedCtmc,
    /// Run Regenerative Monte Carlo…, either buffer mode (`regenerative_mc`).
    RegenerativeMonteCarlo,
    /// Run Spectral Method…, infinite buffers (`inf_sm`, bnet).
    InfiniteSpectral,
    /// Run Whitt QNA (`qna`).
    Qna,
    /// Run Whitt–You RQNA (`rqna`).
    Rqna,
    /// Run SBD (`sbd`).
    Sbd,
    /// Run SRBM MLMC (`mlmc`).
    Mlmc,
    /// Run Linear Program, infinite buffers (`lp`, srbm_lp).
    LinearProgram,
    /// Run Adaptive Low-Rank BAR (`adaptive_bar`).
    AdaptiveBar,
    /// Run BAR Moment Bounds (`bar_bounds`).
    BarBounds,
    /// Run Multi-Class SRBM… (experimental, `mc`).
    MultiClassSrbm,
    /// Run Comparison, finite buffers (`cmp`).
    FiniteComparison,
    /// Run Monte Carlo…, finite buffers (`sim`, fBNAsim).
    FiniteMonteCarlo,
    /// Run Exact Sparse CTMC (`generic_ctmc`).
    GenericCtmc,
    /// Run Finite-Buffer Decomposition (`fb_decomp`).
    FiniteDecomposition,
    /// Run Spectral Method…, finite buffers (`sm`, srbm_solver).
    FiniteSpectral,
    /// Run Finite Element… (`fm`).
    FiniteElement,
    /// Run Finite-Buffer LP (`flp`).
    FiniteLinearProgram,
    /// Exact Closed Product Form (`closed_pf`; new in 2.1). In neither 0.90.34 menu: it is the
    /// method of a closed network (`qnet_core::closed::looks_closed`), whatever its buffer mode.
    ClosedProductForm,
    /// Replicated Simulation (`sim_inproc`; new in 2.1). In neither 0.90.34 menu: a simulation
    /// with confidence intervals computed in process, for a closed network and for an open
    /// infinite-buffer one (`qnet_core::simstat::plan`).
    InProcessSimulation,
    /// Exact Priority Queue (`priority_exact`; new in 2.1). In neither 0.90.34 menu: the exact
    /// mean values of one station with priority service (`qnet_core::priority`).
    PriorityExact,
    /// Exact Batch-Arrival Queue (`batch_exact`; new in 2.1): the exact mean values of one
    /// single-server station with batch Poisson arrivals (`qnet_core::batch`).
    BatchExact,
}

impl Method {
    /// The methods computed inside Qnet (new in 2.1), which are in neither 0.90.34 menu.
    pub const IN_PROCESS: [Method; 4] = [Method::ClosedProductForm, Method::InProcessSimulation, Method::PriorityExact, Method::BatchExact];

    /// The Run menu of an infinite-buffer network, in menu order (`QnetCommands.swift`).
    pub const INFINITE: [Method; 15] = [
        Method::InfiniteComparison,
        Method::InfiniteMonteCarlo,
        Method::ProductForm,
        Method::Qbd,
        Method::TruncatedCtmc,
        Method::RegenerativeMonteCarlo,
        Method::InfiniteSpectral,
        Method::Qna,
        Method::Rqna,
        Method::Sbd,
        Method::Mlmc,
        Method::LinearProgram,
        Method::AdaptiveBar,
        Method::BarBounds,
        Method::MultiClassSrbm,
    ];

    /// The Run menu of a finite-buffer network, in menu order.
    pub const FINITE: [Method; 8] = [
        Method::FiniteComparison,
        Method::FiniteMonteCarlo,
        Method::RegenerativeMonteCarlo,
        Method::GenericCtmc,
        Method::FiniteDecomposition,
        Method::FiniteSpectral,
        Method::FiniteElement,
        Method::FiniteLinearProgram,
    ];

    /// 0.90.34's run label: the key of `resultMethod(forRunLabel:)` and the golden folder name.
    pub fn label(self) -> &'static str {
        match self {
            Method::InfiniteComparison => "inf_cmp",
            Method::InfiniteMonteCarlo => "inf_sim",
            Method::ProductForm => "product_form",
            Method::Qbd => "qbd",
            Method::TruncatedCtmc => "truncated_ctmc",
            Method::RegenerativeMonteCarlo => "regenerative_mc",
            Method::InfiniteSpectral => "inf_sm",
            Method::Qna => "qna",
            Method::Rqna => "rqna",
            Method::Sbd => "sbd",
            Method::Mlmc => "mlmc",
            Method::LinearProgram => "lp",
            Method::AdaptiveBar => "adaptive_bar",
            Method::BarBounds => "bar_bounds",
            Method::MultiClassSrbm => "mc",
            Method::FiniteComparison => "cmp",
            Method::FiniteMonteCarlo => "sim",
            Method::GenericCtmc => "generic_ctmc",
            Method::FiniteDecomposition => "fb_decomp",
            Method::FiniteSpectral => "sm",
            Method::FiniteElement => "fm",
            Method::FiniteLinearProgram => "flp",
            Method::ClosedProductForm => "closed_pf",
            Method::InProcessSimulation => "sim_inproc",
            Method::PriorityExact => "priority_exact",
            Method::BatchExact => "batch_exact",
        }
    }

    /// The method a run label names (the `qnet-cli run` argument and the golden folder name).
    pub fn from_label(label: &str) -> Option<Method> {
        Method::INFINITE
            .iter()
            .chain(Method::FINITE.iter())
            .chain(Method::IN_PROCESS.iter())
            .copied()
            .find(|m| m.label() == label)
    }

    /// Whether the Run menu offers this method for a network with this buffer mode.
    pub fn in_menu(self, infinite: bool) -> bool {
        if infinite {
            Method::INFINITE.contains(&self)
        } else {
            Method::FINITE.contains(&self)
        }
    }
}

/// One line for the owning tab's Status log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusLine {
    pub text: String,
    pub severity: Severity,
}

impl StatusLine {
    pub fn new(text: impl Into<String>, severity: Severity) -> Self {
        Self { text: text.into(), severity }
    }
    pub fn info(text: impl Into<String>) -> Self {
        Self::new(text, Severity::Info)
    }
    pub fn warning(text: impl Into<String>) -> Self {
        Self::new(text, Severity::Warning)
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self::new(text, Severity::Error)
    }
}

/// Everything a run specification may read: the network as the tab holds it, the tab's title,
/// the settings, the solver resolver, and the few facts about this process that 0.90.34 read
/// from the system (its pid, which stamps temp file names; the CPU count, which the thread banner
/// prints; randomness for unfixed seeds and uuid-stamped names).
pub struct RunContext {
    /// The network, as the tab holds it.
    pub network: Network,
    /// The tab's title: the file name after File › Open (`2dtandem.bnet`), else "Untitled".
    /// Exporters name their document after it.
    pub title: String,
    pub settings: RunSettings,
    pub resolver: Arc<Resolver>,
    /// Where inputs and solver outputs are written (`NSTemporaryDirectory()` in 0.90.34).
    pub temp_dir: PathBuf,
    /// This process's id, stamped into 0.90.34's temp file names (`BNET_qna_<pid>.qna`).
    pub pid: u32,
    /// `ProcessInfo.activeProcessorCount`, printed by the thread banner.
    pub cpu_count: usize,
    /// A source of random 64-bit words, for unfixed seeds and uuid-stamped file names. Tests pass
    /// a fixed sequence.
    pub entropy: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl RunContext {
    /// A context for this process: the system temp folder, its pid and CPU count, and the OS's
    /// randomness.
    pub fn new(network: Network, title: impl Into<String>, settings: RunSettings, resolver: Arc<Resolver>) -> Self {
        Self {
            network,
            title: title.into(),
            settings,
            resolver,
            temp_dir: std::env::temp_dir(),
            pid: std::process::id(),
            cpu_count: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
            entropy: Arc::new(os_random_u64),
        }
    }

    /// A random integer in `lo..=hi` (Swift's `Int.random(in:)` is not reproduced here: an
    /// unfixed seed is meant to differ from run to run).
    pub fn random_in(&self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        let span = hi - lo + 1;
        lo + (self.entropy)() % span
    }

    /// A lowercase version-4 UUID, for the `qnet_<method>_<uuid>.json` names.
    pub fn uuid(&self) -> String {
        let a = (self.entropy)();
        let b = (self.entropy)();
        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&a.to_be_bytes());
        bytes[8..].copy_from_slice(&b.to_be_bytes());
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
    }

    /// A path in the temp folder.
    pub fn temp_path(&self, name: &str) -> PathBuf {
        self.temp_dir.join(name)
    }

    /// The traffic data the editor's silent analysis computed (`SRBMExporter.computeData` without
    /// the loss or BAS corrections), or `None` when it fails.
    pub fn analysis_data(&self) -> Option<SrbmData> {
        let n = &self.network;
        // At the sources' long-run customer rates, as the silent analysis: `extended::traffic`
        // is `traffic::compute` itself for a network without batch arrivals or rate profiles.
        qnet_core::extended::traffic(n, n.infinite_buffers, false, false).ok()
    }

    /// The tractability flags the editor held when the run started: what the open-time analysis
    /// (`analyzeActiveTabIfNeeded` → `applyTractability`) set, or the cleared flags when the
    /// analysis failed (`clearTractability`). Runs read them for the "──  <detail>  ──" line and
    /// the comparison's exact column.
    pub fn flags(&self) -> Option<Flags> {
        // No closed form of first-come-first-served networks is this network's (`extended::refusal`).
        if qnet_core::extended::uses_any(&self.network) {
            return None;
        }
        let data = self.analysis_data()?;
        Some(flags::assess(&data, &self.network.nodes, self.network.infinite_buffers))
    }
}

fn os_random_u64() -> u64 {
    let mut bytes = [0u8; 8];
    // SAFETY: arc4random_buf fills exactly the given number of bytes.
    unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
    u64::from_le_bytes(bytes)
}

/// The body of a run: the steps and text of 0.90.34's bash wrapper, returning its exit status.
pub type RunBody = Box<dyn FnOnce(&mut Job) -> i32 + Send>;

/// A run that passed its pre-checks and is ready to launch.
pub struct PreparedRun {
    pub method: Method,
    /// The record's parameters (`runScript(…, parameters:)`), including "runtime" provenance.
    pub parameters: BTreeMap<String, String>,
    /// The record's seed, for simulations.
    pub seed: Option<u64>,
    /// The record's replication seeds.
    pub replication_seeds: Vec<u64>,
    /// Status lines written before the launch, whether or not it is accepted.
    pub before: Vec<StatusLine>,
    /// Status lines written once the launch is accepted ("Running QNA...").
    pub accepted: Vec<StatusLine>,
    /// Input files written while preparing; removed when the run ends, or at once if the launch
    /// is refused.
    pub temps: TempFiles,
    pub body: RunBody,
}

impl std::fmt::Debug for PreparedRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedRun")
            .field("method", &self.method)
            .field("parameters", &self.parameters)
            .field("seed", &self.seed)
            .field("replication_seeds", &self.replication_seeds)
            .field("before", &self.before)
            .field("accepted", &self.accepted)
            .finish_non_exhaustive()
    }
}

/// What preparing a run gives.
#[derive(Debug)]
pub enum Prepared {
    /// The run did not start; these are the Status lines 0.90.34 wrote (a missing solver, an
    /// exporter refusal, a pre-check), in order.
    Refused(Vec<StatusLine>),
    /// The run is ready to launch.
    Launch(PreparedRun),
}

/// Prepares `method` for the network in `ctx`.
///
/// A method the network's Run menu does not offer is refused with no lines (the menu item is
/// disabled in 0.90.34, so there is nothing it would say).
pub fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    // A closed network (new in 2.1: no source, no sink, a population) has one method, which says
    // itself why any other network is not for it. A network without a population is not closed
    // yet, and every other method answers for it as 0.90.34 did.
    if method == Method::ClosedProductForm {
        return closed::prepare(ctx);
    }
    // Replicated Simulation (new in 2.1) takes closed networks and open infinite-buffer ones,
    // and says itself why any other network is not for it.
    if method == Method::InProcessSimulation {
        return siminproc::prepare(ctx);
    }
    // The exact single-station methods of the model features new in 2.1 say themselves why a
    // network is not for them.
    if method == Method::PriorityExact {
        return singlestation::prepare_priority(ctx);
    }
    if method == Method::BatchExact {
        return singlestation::prepare_batch(ctx);
    }
    if qnet_core::closed::is_closed(&ctx.network) {
        return closed::refuse_open_method(method);
    }
    // Every other method reads a network as first-come-first-served stations and plain
    // sources: on a network with priorities, batches or a rate profile it would answer for a
    // different network, so it refuses (core's one rule, `extended::refusal`).
    if let Some(refused) = singlestation::refuse_classical_method(method, ctx) {
        return refused;
    }
    if !method.in_menu(ctx.network.infinite_buffers) {
        return Prepared::Refused(Vec::new());
    }
    match method {
        Method::ProductForm
        | Method::Qbd
        | Method::TruncatedCtmc
        | Method::GenericCtmc
        | Method::FiniteDecomposition => exact::prepare(method, ctx),
        Method::RegenerativeMonteCarlo => regenerative::prepare(method, ctx),
        Method::AdaptiveBar | Method::BarBounds => bar::prepare(method, ctx),
        Method::MultiClassSrbm => multiclass::prepare(method, ctx),
        Method::Qna
        | Method::Rqna
        | Method::Sbd
        | Method::InfiniteSpectral
        | Method::InfiniteMonteCarlo
        | Method::FiniteSpectral
        | Method::FiniteElement
        | Method::FiniteMonteCarlo => single::prepare(method, ctx),
        Method::InfiniteComparison | Method::FiniteComparison => comparison::prepare(method, ctx),
        Method::Mlmc => mlmc::prepare(method, ctx),
        Method::LinearProgram | Method::FiniteLinearProgram => lp::prepare(method, ctx),
        Method::ClosedProductForm => closed::prepare(ctx),
        Method::InProcessSimulation => siminproc::prepare(ctx),
        Method::PriorityExact => singlestation::prepare_priority(ctx),
        Method::BatchExact => singlestation::prepare_batch(ctx),
    }
}

/// The refusal of a method whose specification is not written yet.
pub(crate) fn unimplemented_method(method: Method) -> Prepared {
    Prepared::Refused(vec![StatusLine::error(format!(
        "{} is not available in this build yet.",
        method.label()
    ))])
}

/// Launches a prepared run through the single-flight registry, on a new thread.
///
/// The `before` lines are reported first. If another run owns the registry, the refusal sentence
/// is reported, the input files are removed and `Err` is returned. Otherwise the `accepted` lines
/// are reported and the body runs as a job whose output goes to `sink`; the handle yields the
/// job's report (its summary and full-precision archive).
pub fn launch(
    run: PreparedRun,
    registry: &Arc<RunRegistry>,
    owner: RunOwner,
    reporter: Reporter,
    sink: Box<dyn OutputSink>,
) -> Result<JoinHandle<JobReport>, Refused> {
    let PreparedRun { method, before, accepted, temps, body, .. } = run;
    for line in &before {
        reporter(&RunEvent::Status { text: line.text.clone(), severity: line.severity });
    }
    let ticket = match registry.begin(method.label(), owner, reporter.clone()) {
        Ok(ticket) => ticket,
        Err(refused) => {
            drop(temps);
            return Err(refused);
        }
    };
    for line in &accepted {
        reporter(&RunEvent::Status { text: line.text.clone(), severity: line.severity });
    }
    Ok(std::thread::spawn(move || {
        run_job(ticket, sink, move |job| {
            job.adopt_temps(temps);
            body(job)
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_method_has_a_distinct_label_that_maps_back() {
        let all: Vec<Method> = Method::INFINITE.iter().chain(Method::FINITE.iter()).copied().collect();
        for m in &all {
            assert_eq!(Method::from_label(m.label()), Some(*m));
        }
        let mut labels: Vec<&str> = all.iter().map(|m| m.label()).collect();
        labels.sort();
        labels.dedup();
        assert_eq!(labels.len(), 22, "regenerative_mc is in both menus");
    }

    #[test]
    fn uuids_are_lowercase_version_four_from_the_entropy_words() {
        let words = std::sync::Mutex::new(vec![u64::MAX, 0x0123_4567_89ab_cdef]);
        let resolver = Arc::new(Resolver::new(crate::resolver::ResolverConfig::from_process()));
        let mut ctx = RunContext::new(qnet_core::bnet::read(r#"{"nodes":[],"links":[]}"#).expect("empty network"), "Untitled", RunSettings::default(), resolver);
        ctx.entropy = Arc::new(move || words.lock().unwrap().pop().unwrap_or(0));
        assert_eq!(ctx.uuid(), "01234567-89ab-4def-bfff-ffffffffffff");
    }
}
