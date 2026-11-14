//! The result record of a solver run, as 0.90.34 kept it (`ResultsWorkspace.swift`, the Codable
//! types `ResultModelLayer`, `ResultFidelity`, `ResultMethodMetadata`, `ResultUncertainty`,
//! `ResultNumericalEvidence`, `ResultMeasurement`, `ResultNetworkSnapshot`, `ResultProvenance`,
//! `ResultRunStatus` and `ResultRunRecord`), with JSON reading and writing that reproduce Swift's
//! synthesized `Codable` form exactly, so a `results-v1.json` written by 0.90.34 reads here and
//! a record written here reads in 0.90.34.
//!
//! Writing: keys are the Swift property names, sorted; an optional that is nil is left out (the
//! synthesized `encodeIfPresent`), never written as null; enums are their raw strings; dates as
//! `.iso8601` writes them (`codec::Date`); UUIDs in upper case; a non-finite Double can't be written
//! (`JSONEncoder` throws), and `EncodeError` says which field held it.
//!
//! Reading is as strict as Swift's decoder, and lenient only where it was: unknown keys are
//! ignored, the first of two duplicate keys wins, a missing or null optional is nil, and an
//! integer may be written `1.0` or `1e2`. Every non-optional field must be present and not null
//! (`replicationSeeds` and `shortName` included); a value of the wrong type, an unknown enum raw
//! value (a status, layer or fidelity 0.90.34 didn't know), an invalid UUID or date, an `Int` that
//! isn't whole, or a negative or fractional seed makes the whole archive unreadable, as it did in
//! 0.90.34. A decoded record is kept as read: an empty `{}` uncertainty stays an empty uncertainty
//! (only the record and measurement constructors turn empty ones into nil, as Swift's `init`s did).
//!
//! The network snapshot holds the model's `Node`s and `Link`s and goes through `bnet`'s reader and
//! writer, which already reproduce `NetworkNode`'s and `NetworkLink`'s Codable form; its fingerprint
//! is the SHA-256 of the compact sorted-key JSON of the snapshot with nodes and links sorted by id,
//! as `ResultNetworkSnapshot.fingerprint` computed it.

use std::collections::BTreeMap;

use super::codec::{self, at, DecodeError, Obj};
pub use super::codec::Date;
use crate::bnet;
use crate::json::{self, Json};
use crate::model::{Link, Network, Node, NodeKind};
use crate::naming;

/// The mathematical object a method evaluates (`ResultModelLayer`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ModelLayer {
    Queue,
    QueueApproximation,
    Srbm,
    Bound,
    Mixed,
}

impl ModelLayer {
    pub const ALL: [ModelLayer; 5] = [ModelLayer::Queue, ModelLayer::QueueApproximation, ModelLayer::Srbm, ModelLayer::Bound, ModelLayer::Mixed];

    /// The stored value.
    pub fn raw(self) -> &'static str {
        match self {
            ModelLayer::Queue => "Queueing process",
            ModelLayer::QueueApproximation => "Queue approximation",
            ModelLayer::Srbm => "SRBM diffusion",
            ModelLayer::Bound => "Certified bound",
            ModelLayer::Mixed => "Mixed model layers",
        }
    }

    pub fn from_raw(s: &str) -> Option<ModelLayer> {
        ModelLayer::ALL.into_iter().find(|x| x.raw() == s)
    }

    pub fn short_name(self) -> &'static str {
        match self {
            ModelLayer::Queue => "Queue",
            ModelLayer::QueueApproximation => "Approximation",
            ModelLayer::Srbm => "SRBM",
            ModelLayer::Bound => "Bound",
            ModelLayer::Mixed => "Mixed",
        }
    }
}

/// What kind of claim may be made about a method's output (`ResultFidelity`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Fidelity {
    ExactQueue,
    QueueSimulation,
    QueueApproximation,
    SrbmAnalytical,
    SrbmNumerical,
    SrbmSimulation,
    SrbmBoundRelaxation,
    CertifiedBound,
    MixedEvidence,
}

impl Fidelity {
    pub const ALL: [Fidelity; 9] = [
        Fidelity::ExactQueue,
        Fidelity::QueueSimulation,
        Fidelity::QueueApproximation,
        Fidelity::SrbmAnalytical,
        Fidelity::SrbmNumerical,
        Fidelity::SrbmSimulation,
        Fidelity::SrbmBoundRelaxation,
        Fidelity::CertifiedBound,
        Fidelity::MixedEvidence,
    ];

    /// The stored value.
    pub fn raw(self) -> &'static str {
        match self {
            Fidelity::ExactQueue => "Exact queueing result",
            Fidelity::QueueSimulation => "Queue simulation",
            Fidelity::QueueApproximation => "Queueing approximation",
            Fidelity::SrbmAnalytical => "SRBM analytical result",
            Fidelity::SrbmNumerical => "SRBM numerical result",
            Fidelity::SrbmSimulation => "SRBM simulation",
            Fidelity::SrbmBoundRelaxation => "SRBM bound relaxation",
            Fidelity::CertifiedBound => "Certified bound",
            Fidelity::MixedEvidence => "Mixed-method evidence",
        }
    }

    pub fn from_raw(s: &str) -> Option<Fidelity> {
        Fidelity::ALL.into_iter().find(|x| x.raw() == s)
    }
}

/// A method as a record names it (`ResultMethodMetadata`). `identifier` is the durable key.
#[derive(Clone, Debug, PartialEq)]
pub struct MethodMetadata {
    pub identifier: String,
    pub display_name: String,
    pub short_name: String,
    pub layer: ModelLayer,
    pub fidelity: Fidelity,
    pub implementation: Option<String>,
}

/// The method identifiers the parser and the run labels key on.
pub mod ids {
    pub const MONTE_CARLO: &str = "queue.des";
    pub const REGENERATIVE_MONTE_CARLO: &str = "queue.regenerative-mc";
    pub const JACKSON: &str = "queue.jackson";
    pub const OPEN_PRODUCT_FORM: &str = "queue.open-bcmp-product-form";
    pub const QBD: &str = "queue.matrix-analytic-qbd";
    pub const FINITE_CTMC: &str = "queue.finite-ctmc";
    pub const FINITE_DECOMPOSITION: &str = "queue-approx.finite-decomposition";
    pub const TRUNCATED_CTMC: &str = "queue.infinite-truncated-ctmc";
    pub const ADAPTIVE_LOW_RANK_BAR: &str = "srbm.adaptive-low-rank-bar";
    pub const BAR_MOMENT_BOUNDS: &str = "srbm.bar-moment-bounds";
    pub const QNA: &str = "queue-approx.qna";
    pub const RQNA: &str = "queue-approx.rqna";
    pub const SBD: &str = "queue-approx.sbd";
    pub const SPECTRAL: &str = "srbm.spectral";
    pub const FINITE_ELEMENT: &str = "srbm.fem";
    pub const LINEAR_PROGRAM: &str = "srbm.lp";
    pub const SRBM_MLMC: &str = "srbm.mlmc";
    pub const ANALYTICAL_SRBM: &str = "srbm.product-form";
    pub const MULTI_CLASS_SRBM: &str = "srbm.multiclass-station";
    pub const COMPARISON: &str = "comparison.mixed";
    pub const TEST_SET: &str = "benchmark.test-set";
    pub const SPECTRAL_CONVERGENCE: &str = "benchmark.spectral-convergence";
    /// New in 2.1 (closed.rs): not in 0.90.34's catalogue.
    pub const CLOSED_PRODUCT_FORM: &str = "queue.closed-product-form";
    /// New in 2.1 (simstat.rs): not in 0.90.34's catalogue.
    pub const REPLICATED_SIMULATION: &str = "queue.des-replications";
    /// New in 2.1 (priority.rs, batch.rs): not in 0.90.34's catalogue.
    pub const PRIORITY_EXACT: &str = "queue.priority-exact";
    pub const BATCH_EXACT: &str = "queue.batch-arrival-exact";
}

impl MethodMetadata {
    /// `ResultMethodMetadata.init`: the short name defaults to the display name.
    pub fn new(identifier: &str, display_name: &str, short_name: Option<&str>, layer: ModelLayer, fidelity: Fidelity, implementation: Option<&str>) -> MethodMetadata {
        MethodMetadata {
            identifier: identifier.into(),
            display_name: display_name.into(),
            short_name: short_name.unwrap_or(display_name).into(),
            layer,
            fidelity,
            implementation: implementation.map(Into::into),
        }
    }

    /// 0.90.34's static catalogue, in its order.
    pub fn catalogue() -> Vec<MethodMetadata> {
        use Fidelity as F;
        use ModelLayer as L;
        let m = MethodMetadata::new;
        vec![
            m(ids::MONTE_CARLO, "Monte Carlo", None, L::Queue, F::QueueSimulation, Some("BNAsim/fBNAsim")),
            m(ids::REGENERATIVE_MONTE_CARLO, "Regenerative Monte Carlo", Some("Regen MC"), L::Queue, F::QueueSimulation, Some("regenerative_mc")),
            m(ids::JACKSON, "Jackson Product Form", Some("Jackson"), L::Queue, F::ExactQueue, None),
            m(ids::OPEN_PRODUCT_FORM, "Exact Open Product Form", Some("Product Form"), L::Queue, F::ExactQueue, Some("product_form/open_bcmp")),
            m(ids::QBD, "Exact Matrix-Analytic QBD", Some("QBD"), L::Queue, F::ExactQueue, Some("matrix_analytic/qbd_solver")),
            m(ids::FINITE_CTMC, "Exact Sparse CTMC", Some("CTMC"), L::Queue, F::ExactQueue, Some("generic_ctmc")),
            m(ids::FINITE_DECOMPOSITION, "Finite-Buffer Decomposition", Some("FB Decomp"), L::QueueApproximation, F::QueueApproximation, Some("fBNAdecomp")),
            m(ids::TRUNCATED_CTMC, "Adaptive Truncated CTMC", Some("Truncated CTMC"), L::Queue, F::QueueApproximation, Some("truncated_ctmc")),
            m(ids::ADAPTIVE_LOW_RANK_BAR, "Adaptive Low-Rank BAR", Some("Low-Rank BAR"), L::Srbm, F::SrbmNumerical, Some("adaptive_srbm")),
            m(ids::BAR_MOMENT_BOUNDS, "BAR Moment Bounds", Some("BAR Bounds"), L::Srbm, F::SrbmBoundRelaxation, Some("bar_bounds")),
            m(ids::QNA, "Whitt QNA", Some("QNA"), L::QueueApproximation, F::QueueApproximation, Some("BNAqna")),
            m(ids::RQNA, "Whitt–You RQNA", Some("RQNA"), L::QueueApproximation, F::QueueApproximation, Some("BNArqna")),
            m(ids::SBD, "Sequential Bottleneck Decomposition", Some("SBD"), L::QueueApproximation, F::QueueApproximation, Some("BNAsbd")),
            m(ids::SPECTRAL, "Spectral Method", Some("Spectral"), L::Srbm, F::SrbmNumerical, Some("BNAsm/fBNAsm")),
            m(ids::FINITE_ELEMENT, "Finite Element Method", Some("FEM"), L::Srbm, F::SrbmNumerical, Some("BNAfm/fBNAfm")),
            m(ids::LINEAR_PROGRAM, "BAR Linear Program", Some("LP"), L::Srbm, F::SrbmNumerical, Some("BNAlp/fBNAlp")),
            m(ids::SRBM_MLMC, "SRBM MLMC", Some("MLMC"), L::Srbm, F::SrbmSimulation, Some("BNAmc")),
            m(ids::ANALYTICAL_SRBM, "SRBM Product Form", Some("SRBM PF"), L::Srbm, F::SrbmAnalytical, None),
            m(ids::MULTI_CLASS_SRBM, "Multi-Class SRBM", Some("MC SRBM"), L::Srbm, F::SrbmNumerical, Some("multiclass_diffusion/mc_solver")),
            m(ids::COMPARISON, "Method Comparison", Some("Comparison"), L::Mixed, F::MixedEvidence, None),
            m(ids::TEST_SET, "Test Set", None, L::Mixed, F::MixedEvidence, None),
            m(ids::SPECTRAL_CONVERGENCE, "Spectral Convergence", Some("Convergence"), L::Mixed, F::MixedEvidence, None),
        ]
    }

    /// Exact Closed Product Form (new in 2.1; `closed.rs`, run label `closed_pf`). Kept out of
    /// `catalogue`, which is 0.90.34's list.
    pub fn closed_product_form() -> MethodMetadata {
        MethodMetadata::new(ids::CLOSED_PRODUCT_FORM, "Exact Closed Product Form", Some("Closed PF"), ModelLayer::Queue, Fidelity::ExactQueue, Some("qnet-core/closed (convolution, MVA)"))
    }

    /// Replicated Simulation (new in 2.1; `simstat.rs`, run label `sim_inproc`). Kept out of
    /// `catalogue`, which is 0.90.34's list.
    pub fn replicated_simulation() -> MethodMetadata {
        MethodMetadata::new(ids::REPLICATED_SIMULATION, "Replicated Simulation", Some("Replicated Sim"), ModelLayer::Queue, Fidelity::QueueSimulation, Some("qnet-core/simstat (independent replications)"))
    }

    /// Exact Priority Queue (new in 2.1; `priority.rs`, run label `priority_exact`).
    pub fn priority_exact() -> MethodMetadata {
        MethodMetadata::new(ids::PRIORITY_EXACT, "Exact Priority Queue", Some("Priority"), ModelLayer::Queue, Fidelity::ExactQueue, Some("qnet-core/priority (Cobham; Kleinrock; Kella–Yechiali; Buzen–Bondi)"))
    }

    /// Exact Batch-Arrival Queue (new in 2.1; `batch.rs`, run label `batch_exact`).
    pub fn batch_exact() -> MethodMetadata {
        MethodMetadata::new(ids::BATCH_EXACT, "Exact Batch-Arrival Queue", Some("Batch"), ModelLayer::Queue, Fidelity::ExactQueue, Some("qnet-core/batch (M^X/G/1 mean values)"))
    }

    /// The catalogue entry with this identifier.
    pub fn named(identifier: &str) -> Option<MethodMetadata> {
        if identifier == ids::PRIORITY_EXACT {
            return Some(MethodMetadata::priority_exact());
        }
        if identifier == ids::BATCH_EXACT {
            return Some(MethodMetadata::batch_exact());
        }
        if identifier == ids::REPLICATED_SIMULATION {
            return Some(MethodMetadata::replicated_simulation());
        }
        if identifier == ids::CLOSED_PRODUCT_FORM {
            return Some(MethodMetadata::closed_product_form());
        }
        MethodMetadata::catalogue().into_iter().find(|m| m.identifier == identifier)
    }

    /// The method a run label files its record under (0.90.34 `resultMethod(forRunLabel:)`), or None
    /// for the diagnostics (`analyze`, `primitives`) and any other label, which file no record.
    pub fn for_run_label(label: &str) -> Option<MethodMetadata> {
        let id = match label {
            "sim" | "inf_sim" => ids::MONTE_CARLO,
            "sm" | "inf_sm" => ids::SPECTRAL,
            "fm" => ids::FINITE_ELEMENT,
            "flp" | "lp" => ids::LINEAR_PROGRAM,
            "mc" => ids::MULTI_CLASS_SRBM,
            "qna" => ids::QNA,
            "rqna" => ids::RQNA,
            "sbd" => ids::SBD,
            "mlmc" => ids::SRBM_MLMC,
            "generic_ctmc" => ids::FINITE_CTMC,
            "fb_decomp" => ids::FINITE_DECOMPOSITION,
            "truncated_ctmc" => ids::TRUNCATED_CTMC,
            "adaptive_bar" => ids::ADAPTIVE_LOW_RANK_BAR,
            "bar_bounds" => ids::BAR_MOMENT_BOUNDS,
            "regenerative_mc" => ids::REGENERATIVE_MONTE_CARLO,
            "product_form" => ids::OPEN_PRODUCT_FORM,
            "closed_pf" => return Some(MethodMetadata::closed_product_form()),
            "sim_inproc" => return Some(MethodMetadata::replicated_simulation()),
            "priority_exact" => return Some(MethodMetadata::priority_exact()),
            "batch_exact" => return Some(MethodMetadata::batch_exact()),
            "qbd" => ids::QBD,
            "cmp" | "inf_cmp" => ids::COMPARISON,
            "testset" => ids::TEST_SET,
            "spc" => ids::SPECTRAL_CONVERGENCE,
            _ => return None,
        };
        MethodMetadata::named(id)
    }
}

/// A measurement's statistical uncertainty (`ResultUncertainty`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Uncertainty {
    pub standard_error: Option<f64>,
    pub lower_bound: Option<f64>,
    pub upper_bound: Option<f64>,
    /// A fraction (0.95), not a percentage.
    pub confidence_level: Option<f64>,
    pub sample_size: Option<i64>,
}

impl Uncertainty {
    pub fn is_empty(&self) -> bool {
        self.standard_error.is_none() && self.lower_bound.is_none() && self.upper_bound.is_none() && self.confidence_level.is_none() && self.sample_size.is_none()
    }

    /// Half the interval's width, when both bounds are present. A standard error is never derived
    /// from it.
    pub fn half_width(&self) -> Option<f64> {
        Some((self.upper_bound? - self.lower_bound?) / 2.0)
    }

    /// The half-width, or else the standard error: the one sort key both spellings have.
    pub fn spread(&self) -> Option<f64> {
        self.half_width().or(self.standard_error)
    }
}

/// Method-specific numerical evidence, per measurement or per run (`ResultNumericalEvidence`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NumericalEvidence {
    pub residual: Option<f64>,
    pub discretization: Option<String>,
    pub refinement_delta: Option<f64>,
    pub convergence_note: Option<String>,
}

impl NumericalEvidence {
    pub fn is_empty(&self) -> bool {
        self.residual.is_none() && self.discretization.is_none() && self.refinement_delta.is_none() && self.convergence_note.is_none()
    }
}

/// One estimate for one station (`ResultMeasurement`).
#[derive(Clone, Debug, PartialEq)]
pub struct Measurement {
    pub id: String,
    pub station_id: Option<String>,
    pub station_name: String,
    /// Zero-based; None is the aggregate.
    pub customer_class: Option<i64>,
    pub metric: String,
    pub estimate: f64,
    pub unit: String,
    pub uncertainty: Option<Uncertainty>,
    pub numerical_evidence: Option<NumericalEvidence>,
    pub note: Option<String>,
}

impl Measurement {
    /// `ResultMeasurement.init`: an empty uncertainty or evidence is stored as nil.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: String,
        station_id: Option<String>,
        station_name: String,
        customer_class: Option<i64>,
        metric: String,
        estimate: f64,
        unit: String,
        uncertainty: Option<Uncertainty>,
        numerical_evidence: Option<NumericalEvidence>,
        note: Option<String>,
    ) -> Measurement {
        Measurement {
            id,
            station_id,
            station_name,
            customer_class,
            metric,
            estimate,
            unit,
            uncertainty: uncertainty.filter(|u| !u.is_empty()),
            numerical_evidence: numerical_evidence.filter(|e| !e.is_empty()),
            note,
        }
    }

    /// "C1", "C2" … for a class, "All" for the aggregate.
    pub fn class_label(&self) -> String {
        self.customer_class.map(|c| format!("C{}", c + 1)).unwrap_or_else(|| "All".into())
    }
}

/// The network as it was when the run started, in canvas order (`ResultNetworkSnapshot`).
#[derive(Clone, Debug, PartialEq)]
pub struct NetworkSnapshot {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
    pub infinite_buffers: bool,
    /// A closed network's population (new in 2.1); `None` for an open network, and then neither
    /// the JSON nor the fingerprint differs from 0.90.34's.
    pub population: Option<i64>,
}

impl NetworkSnapshot {
    pub fn of(net: &Network) -> NetworkSnapshot {
        NetworkSnapshot { nodes: net.nodes.clone(), links: net.links.clone(), infinite_buffers: net.infinite_buffers, population: net.population }
    }

    /// The snapshot as a document (`ResultNetworkSnapshot.document`), with the default canvas.
    pub fn to_network(&self) -> Network {
        Network { nodes: self.nodes.clone(), links: self.links.clone(), infinite_buffers: self.infinite_buffers, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: self.population }
    }

    /// The lowercase-hex SHA-256 of the compact sorted-key JSON of the snapshot with its nodes and
    /// links sorted by id (`fingerprint`). Positions count, so moving a node changes it.
    pub fn fingerprint(&self) -> String {
        let mut nodes = self.nodes.clone();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        let mut links = self.links.clone();
        links.sort_by(|a, b| a.id.cmp(&b.id));
        let canonical = NetworkSnapshot { nodes, links, infinite_buffers: self.infinite_buffers, population: self.population };
        super::sha256::hex(codec::to_compact(&canonical.to_json()).as_bytes())
    }

    /// `{"infiniteBuffers", "links", "nodes"}`, each node and link as `bnet` writes it.
    pub fn to_json(&self) -> Json {
        // bnet's writer is the one encoder of NetworkNode and NetworkLink; take its arrays.
        let doc = json::parse(&bnet::write(&self.to_network())).expect("bnet writes JSON");
        let mut doc = match doc {
            Json::Object(m) => m,
            _ => unreachable!("bnet writes an object"),
        };
        let mut m = BTreeMap::new();
        if let Some(n) = self.population {
            m.insert("closedPopulation".into(), Json::int(n));
        }
        m.insert("infiniteBuffers".into(), Json::Bool(self.infinite_buffers));
        m.insert("links".into(), swift_numbers(doc.remove("links").unwrap_or(Json::Array(vec![]))));
        m.insert("nodes".into(), swift_numbers(doc.remove("nodes").unwrap_or(Json::Array(vec![]))));
        Json::Object(m)
    }

    pub(crate) fn from_json(v: &Json, path: &str) -> Result<NetworkSnapshot, DecodeError> {
        let o = Obj::of(v, path)?;
        let nodes = o.array("nodes")?;
        let links = o.array("links")?;
        let infinite_buffers = codec::bool(o.required("infiniteBuffers")?, &o.key_path("infiniteBuffers"))?;
        // NetworkNode's and NetworkLink's decoders are bnet's: hand it a document of just these.
        let mut doc = BTreeMap::new();
        doc.insert("nodes".to_string(), Json::Array(nodes.to_vec()));
        doc.insert("links".to_string(), Json::Array(links.to_vec()));
        if let Some(n) = o.optional("closedPopulation") {
            doc.insert("closedPopulation".to_string(), n.clone());
        }
        let net = bnet::read(&codec::to_compact(&Json::Object(doc))).map_err(|e| DecodeError { path: at(path, &e.path), message: e.message })?;
        Ok(NetworkSnapshot { nodes: net.nodes, links: net.links, infinite_buffers, population: net.population })
    }

    /// The node with this id, as `Dictionary(uniqueKeysWithValues:)` would find it. (0.90.34
    /// trapped on a snapshot with two nodes of one id; this takes the first.)
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }
}

/// Rewrites every fractional number as Swift writes it (`codec::number`): `json::format_number`,
/// which `bnet` writes with, breaks a tie between two shortest digit strings upward where Swift
/// takes the even one, and the fingerprint hashes these digits.
fn swift_numbers(v: Json) -> Json {
    match v {
        Json::Number(t) if t.contains(['.', 'e']) => t.parse::<f64>().map(codec::number).unwrap_or(Json::Number(t)),
        Json::Array(a) => Json::Array(a.into_iter().map(swift_numbers).collect()),
        Json::Object(m) => Json::Object(m.into_iter().map(|(k, x)| (k, swift_numbers(x))).collect()),
        other => other,
    }
}

/// Where a run came from (`ResultProvenance`).
#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    pub tab_id: String,
    pub network_title: String,
    pub source_file_url: Option<String>,
    pub network_fingerprint: String,
    pub network_snapshot: NetworkSnapshot,
    pub buffer_regime: String,
    pub parameters: BTreeMap<String, String>,
    pub seed: Option<u64>,
    pub replication_seeds: Vec<u64>,
    pub application_version: String,
    pub solver_version: Option<String>,
    /// Station ids in the order every solver exporter used at launch. Optional so archives written
    /// before structured parsing stay readable.
    pub export_station_ids: Option<Vec<String>>,
}

impl Provenance {
    /// What `ResultProvenance.init(tabID:networkTitle:editor:…)` captured from the tab's network at
    /// launch. `source_file_url` is the file's URL as text (`currentFileURL?.absoluteString`, see
    /// `file_url`); `solver_version` is left nil, as every 0.90.34 caller left it.
    #[allow(clippy::too_many_arguments)]
    pub fn capture(
        tab_id: &str,
        network_title: &str,
        net: &Network,
        source_file_url: Option<String>,
        parameters: BTreeMap<String, String>,
        seed: Option<u64>,
        replication_seeds: Vec<u64>,
        application_version: &str,
    ) -> Provenance {
        let snapshot = NetworkSnapshot::of(net);
        Provenance {
            tab_id: tab_id.to_ascii_uppercase(),
            network_title: network_title.into(),
            source_file_url,
            network_fingerprint: snapshot.fingerprint(),
            buffer_regime: if snapshot.infinite_buffers { "Infinite capacity" } else { "Finite capacity" }.into(),
            network_snapshot: snapshot,
            parameters,
            seed,
            replication_seeds,
            application_version: application_version.into(),
            solver_version: None,
            export_station_ids: Some(export_station_ids(net)),
        }
    }
}

/// A run's status (`ResultRunStatus`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RunStatus {
    Running,
    Completed,
    Partial,
    Failed,
    /// Kept so older archives decode; a cancelled run's record is deleted instead.
    Cancelled,
}

impl RunStatus {
    pub const ALL: [RunStatus; 5] = [RunStatus::Running, RunStatus::Completed, RunStatus::Partial, RunStatus::Failed, RunStatus::Cancelled];

    pub fn raw(self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Partial => "partial",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_raw(s: &str) -> Option<RunStatus> {
        RunStatus::ALL.into_iter().find(|x| x.raw() == s)
    }

    pub fn label(self) -> &'static str {
        match self {
            RunStatus::Running => "Running",
            RunStatus::Completed => "Completed",
            RunStatus::Partial => "Partial",
            RunStatus::Failed => "Failed",
            RunStatus::Cancelled => "Cancelled",
        }
    }
}

/// One run's record (`ResultRunRecord`).
#[derive(Clone, Debug, PartialEq)]
pub struct RunRecord {
    pub id: String,
    pub method: MethodMetadata,
    pub provenance: Provenance,
    pub status: RunStatus,
    pub started_at: Date,
    pub completed_at: Option<Date>,
    pub elapsed_seconds: Option<f64>,
    pub measurements: Vec<Measurement>,
    pub run_evidence: Option<NumericalEvidence>,
    pub warnings: Vec<String>,
    pub failure_message: Option<String>,
    /// The full solver transcript, kept for audit; never reparsed by the table.
    pub raw_output: Option<String>,
}

/// Swift's `max(0, x)` on a Double: `x >= 0 ? x : 0`.
fn elapsed(completed: Date, started: Date) -> f64 {
    let d = completed.seconds_since(started);
    if d >= 0.0 {
        d
    } else {
        0.0
    }
}

fn nonempty(e: Option<NumericalEvidence>) -> Option<NumericalEvidence> {
    e.filter(|e| !e.is_empty())
}

impl RunRecord {
    /// A new record, running, with no measurements (`ResultRunRecord.init` with its defaults).
    pub fn new(id: &str, method: MethodMetadata, provenance: Provenance, started_at: Date) -> RunRecord {
        RunRecord {
            id: id.to_ascii_uppercase(),
            method,
            provenance,
            status: RunStatus::Running,
            started_at,
            completed_at: None,
            elapsed_seconds: None,
            measurements: vec![],
            run_evidence: None,
            warnings: vec![],
            failure_message: None,
            raw_output: None,
        }
    }

    /// True when the network has changed since this run (its fingerprint differs).
    pub fn is_stale(&self, current_fingerprint: &str) -> bool {
        self.provenance.network_fingerprint != current_fingerprint
    }

    /// `ResultsStore.completeRun`'s change: measurements replaced when given, evidence, warnings and
    /// transcript set, status completed, completion time and elapsed seconds (never negative) set.
    pub fn complete(&mut self, measurements: Option<Vec<Measurement>>, evidence: Option<NumericalEvidence>, warnings: Vec<String>, raw_output: Option<String>, completed_at: Date) {
        if let Some(m) = measurements {
            self.measurements = m;
        }
        self.run_evidence = nonempty(evidence);
        self.warnings = warnings;
        self.raw_output = raw_output;
        self.status = RunStatus::Completed;
        self.completed_at = Some(completed_at);
        self.elapsed_seconds = Some(elapsed(completed_at, self.started_at));
    }

    /// `ResultsStore.partialRun`'s change: as `complete`, plus the message, with status partial.
    #[allow(clippy::too_many_arguments)]
    pub fn partial(
        &mut self,
        message: &str,
        measurements: Option<Vec<Measurement>>,
        evidence: Option<NumericalEvidence>,
        warnings: Vec<String>,
        raw_output: Option<String>,
        completed_at: Date,
    ) {
        if let Some(m) = measurements {
            self.measurements = m;
        }
        self.run_evidence = nonempty(evidence);
        self.warnings = warnings;
        self.failure_message = Some(message.into());
        self.raw_output = raw_output;
        self.status = RunStatus::Partial;
        self.completed_at = Some(completed_at);
        self.elapsed_seconds = Some(elapsed(completed_at, self.started_at));
    }

    /// `ResultsStore.failRun`'s change: status failed, the message and transcript, the times.
    /// Measurements, evidence and warnings are left as they were.
    pub fn fail(&mut self, message: &str, raw_output: Option<String>, completed_at: Date) {
        self.status = RunStatus::Failed;
        self.failure_message = Some(message.into());
        self.raw_output = raw_output;
        self.completed_at = Some(completed_at);
        self.elapsed_seconds = Some(elapsed(completed_at, self.started_at));
    }

    /// The record as JSON. Fails on a non-finite number, as `JSONEncoder` did.
    pub fn to_json(&self) -> Result<Json, EncodeError> {
        let mut m = BTreeMap::new();
        if let Some(d) = self.completed_at {
            m.insert("completedAt".into(), Json::str(d.iso8601()));
        }
        if let Some(e) = self.elapsed_seconds {
            m.insert("elapsedSeconds".into(), num(e, "elapsedSeconds")?);
        }
        if let Some(f) = &self.failure_message {
            m.insert("failureMessage".into(), Json::str(f.clone()));
        }
        m.insert("id".into(), Json::str(self.id.clone()));
        let measurements = self.measurements.iter().enumerate().map(|(i, x)| x.to_json(&format!("measurements[{i}]"))).collect::<Result<_, _>>()?;
        m.insert("measurements".into(), Json::Array(measurements));
        m.insert("method".into(), self.method.to_json());
        m.insert("provenance".into(), self.provenance.to_json());
        if let Some(r) = &self.raw_output {
            m.insert("rawOutput".into(), Json::str(r.clone()));
        }
        if let Some(e) = &self.run_evidence {
            m.insert("runEvidence".into(), e.to_json("runEvidence")?);
        }
        m.insert("startedAt".into(), Json::str(self.started_at.iso8601()));
        m.insert("status".into(), Json::str(self.status.raw()));
        m.insert("warnings".into(), Json::Array(self.warnings.iter().map(|w| Json::str(w.clone())).collect()));
        Ok(Json::Object(m))
    }

    /// Reads a record as `JSONDecoder` (`.iso8601` dates) read one.
    pub fn from_json(v: &Json, path: &str) -> Result<RunRecord, DecodeError> {
        let o = Obj::of(v, path)?;
        let status_text = o.string("status")?;
        let status = RunStatus::from_raw(&status_text).ok_or_else(|| DecodeError { path: o.key_path("status"), message: format!("Cannot initialize ResultRunStatus from invalid String value {status_text}") })?;
        Ok(RunRecord {
            id: o.uuid("id")?,
            method: MethodMetadata::from_json(o.required("method")?, &o.key_path("method"))?,
            provenance: Provenance::from_json(o.required("provenance")?, &o.key_path("provenance"))?,
            status,
            started_at: o.date("startedAt")?,
            completed_at: o.opt_date("completedAt")?,
            elapsed_seconds: o.opt_double("elapsedSeconds")?,
            measurements: o.array("measurements")?.iter().enumerate().map(|(i, x)| Measurement::from_json(x, &format!("{}[{i}]", o.key_path("measurements")))).collect::<Result<_, _>>()?,
            run_evidence: o.optional("runEvidence").map(|x| NumericalEvidence::from_json(x, &o.key_path("runEvidence"))).transpose()?,
            warnings: o.array("warnings")?.iter().enumerate().map(|(i, x)| codec::string(x, &format!("{}[{i}]", o.key_path("warnings")))).collect::<Result<_, _>>()?,
            failure_message: o.opt_string("failureMessage")?,
            raw_output: o.opt_string("rawOutput")?,
        })
    }

    /// The record as 0.90.34's golden dump wrote it: `JSONEncoder` with `[.prettyPrinted,
    /// .sortedKeys]` and `.iso8601` dates.
    pub fn to_pretty(&self) -> Result<String, EncodeError> {
        Ok(json::to_pretty(&self.to_json()?))
    }

    /// Reads one record from its JSON text.
    pub fn parse(text: &str) -> Result<RunRecord, DecodeError> {
        let v = json::parse(text).map_err(|e| DecodeError { path: String::new(), message: format!("The data isn't valid JSON: {e}.") })?;
        RunRecord::from_json(&v, "")
    }
}

/// Why a record can't be written: a NaN or infinity, which `JSONEncoder` refused
/// ("Unable to encode Double.inf directly in JSON.").
#[derive(Clone, Debug, PartialEq)]
pub struct EncodeError {
    pub path: String,
    pub value: f64,
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let v = if self.value.is_nan() {
            "nan".to_string()
        } else if self.value > 0.0 {
            "inf".to_string()
        } else {
            "-inf".to_string()
        };
        write!(f, "Unable to encode Double.{v} directly in JSON (at {}).", self.path)
    }
}

impl std::error::Error for EncodeError {}

fn num(v: f64, path: &str) -> Result<Json, EncodeError> {
    if v.is_finite() {
        Ok(codec::number(v))
    } else {
        Err(EncodeError { path: path.into(), value: v })
    }
}

impl MethodMetadata {
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("displayName".into(), Json::str(self.display_name.clone()));
        m.insert("fidelity".into(), Json::str(self.fidelity.raw()));
        m.insert("identifier".into(), Json::str(self.identifier.clone()));
        if let Some(i) = &self.implementation {
            m.insert("implementation".into(), Json::str(i.clone()));
        }
        m.insert("layer".into(), Json::str(self.layer.raw()));
        m.insert("shortName".into(), Json::str(self.short_name.clone()));
        Json::Object(m)
    }

    pub(crate) fn from_json(v: &Json, path: &str) -> Result<MethodMetadata, DecodeError> {
        let o = Obj::of(v, path)?;
        let layer = o.string("layer")?;
        let fidelity = o.string("fidelity")?;
        Ok(MethodMetadata {
            identifier: o.string("identifier")?,
            display_name: o.string("displayName")?,
            short_name: o.string("shortName")?,
            layer: ModelLayer::from_raw(&layer).ok_or_else(|| DecodeError { path: o.key_path("layer"), message: format!("Cannot initialize ResultModelLayer from invalid String value {layer}") })?,
            fidelity: Fidelity::from_raw(&fidelity).ok_or_else(|| DecodeError { path: o.key_path("fidelity"), message: format!("Cannot initialize ResultFidelity from invalid String value {fidelity}") })?,
            implementation: o.opt_string("implementation")?,
        })
    }
}

impl Uncertainty {
    fn to_json(&self, path: &str) -> Result<Json, EncodeError> {
        let mut m = BTreeMap::new();
        for (key, v) in [("confidenceLevel", self.confidence_level), ("lowerBound", self.lower_bound), ("standardError", self.standard_error), ("upperBound", self.upper_bound)] {
            if let Some(v) = v {
                m.insert(key.to_string(), num(v, &at(path, key))?);
            }
        }
        if let Some(n) = self.sample_size {
            m.insert("sampleSize".into(), Json::int(n));
        }
        Ok(Json::Object(m))
    }

    fn from_json(v: &Json, path: &str) -> Result<Uncertainty, DecodeError> {
        let o = Obj::of(v, path)?;
        Ok(Uncertainty {
            standard_error: o.opt_double("standardError")?,
            lower_bound: o.opt_double("lowerBound")?,
            upper_bound: o.opt_double("upperBound")?,
            confidence_level: o.opt_double("confidenceLevel")?,
            sample_size: o.opt_int("sampleSize")?,
        })
    }
}

impl NumericalEvidence {
    fn to_json(&self, path: &str) -> Result<Json, EncodeError> {
        let mut m = BTreeMap::new();
        if let Some(c) = &self.convergence_note {
            m.insert("convergenceNote".into(), Json::str(c.clone()));
        }
        if let Some(d) = &self.discretization {
            m.insert("discretization".into(), Json::str(d.clone()));
        }
        if let Some(r) = self.refinement_delta {
            m.insert("refinementDelta".into(), num(r, &at(path, "refinementDelta"))?);
        }
        if let Some(r) = self.residual {
            m.insert("residual".into(), num(r, &at(path, "residual"))?);
        }
        Ok(Json::Object(m))
    }

    fn from_json(v: &Json, path: &str) -> Result<NumericalEvidence, DecodeError> {
        let o = Obj::of(v, path)?;
        Ok(NumericalEvidence {
            residual: o.opt_double("residual")?,
            discretization: o.opt_string("discretization")?,
            refinement_delta: o.opt_double("refinementDelta")?,
            convergence_note: o.opt_string("convergenceNote")?,
        })
    }
}

impl Measurement {
    fn to_json(&self, path: &str) -> Result<Json, EncodeError> {
        let mut m = BTreeMap::new();
        if let Some(c) = self.customer_class {
            m.insert("customerClass".into(), Json::int(c));
        }
        m.insert("estimate".into(), num(self.estimate, &at(path, "estimate"))?);
        m.insert("id".into(), Json::str(self.id.clone()));
        m.insert("metric".into(), Json::str(self.metric.clone()));
        if let Some(n) = &self.note {
            m.insert("note".into(), Json::str(n.clone()));
        }
        if let Some(e) = &self.numerical_evidence {
            m.insert("numericalEvidence".into(), e.to_json(&at(path, "numericalEvidence"))?);
        }
        if let Some(s) = &self.station_id {
            m.insert("stationID".into(), Json::str(s.clone()));
        }
        m.insert("stationName".into(), Json::str(self.station_name.clone()));
        if let Some(u) = &self.uncertainty {
            m.insert("uncertainty".into(), u.to_json(&at(path, "uncertainty"))?);
        }
        m.insert("unit".into(), Json::str(self.unit.clone()));
        Ok(Json::Object(m))
    }

    fn from_json(v: &Json, path: &str) -> Result<Measurement, DecodeError> {
        let o = Obj::of(v, path)?;
        Ok(Measurement {
            id: o.uuid("id")?,
            station_id: o.opt_uuid("stationID")?,
            station_name: o.string("stationName")?,
            customer_class: o.opt_int("customerClass")?,
            metric: o.string("metric")?,
            estimate: o.double("estimate")?,
            unit: o.string("unit")?,
            uncertainty: o.optional("uncertainty").map(|x| Uncertainty::from_json(x, &o.key_path("uncertainty"))).transpose()?,
            numerical_evidence: o.optional("numericalEvidence").map(|x| NumericalEvidence::from_json(x, &o.key_path("numericalEvidence"))).transpose()?,
            note: o.opt_string("note")?,
        })
    }
}

impl Provenance {
    fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("applicationVersion".into(), Json::str(self.application_version.clone()));
        m.insert("bufferRegime".into(), Json::str(self.buffer_regime.clone()));
        if let Some(ids) = &self.export_station_ids {
            m.insert("exportStationIDs".into(), Json::Array(ids.iter().map(|i| Json::str(i.clone())).collect()));
        }
        m.insert("networkFingerprint".into(), Json::str(self.network_fingerprint.clone()));
        m.insert("networkSnapshot".into(), self.network_snapshot.to_json());
        m.insert("networkTitle".into(), Json::str(self.network_title.clone()));
        m.insert("parameters".into(), Json::Object(self.parameters.iter().map(|(k, v)| (k.clone(), Json::str(v.clone()))).collect()));
        m.insert("replicationSeeds".into(), Json::Array(self.replication_seeds.iter().map(|s| Json::Number(s.to_string())).collect()));
        if let Some(s) = self.seed {
            m.insert("seed".into(), Json::Number(s.to_string()));
        }
        if let Some(s) = &self.solver_version {
            m.insert("solverVersion".into(), Json::str(s.clone()));
        }
        if let Some(s) = &self.source_file_url {
            m.insert("sourceFileURL".into(), Json::str(s.clone()));
        }
        m.insert("tabID".into(), Json::str(self.tab_id.clone()));
        Json::Object(m)
    }

    fn from_json(v: &Json, path: &str) -> Result<Provenance, DecodeError> {
        let o = Obj::of(v, path)?;
        let params_path = o.key_path("parameters");
        let parameters = Obj::of(o.required("parameters")?, &params_path)?
            .map
            .iter()
            .map(|(k, v)| Ok((k.clone(), codec::string(v, &at(&params_path, k))?)))
            .collect::<Result<BTreeMap<_, _>, DecodeError>>()?;
        let seeds_path = o.key_path("replicationSeeds");
        Ok(Provenance {
            tab_id: o.uuid("tabID")?,
            network_title: o.string("networkTitle")?,
            source_file_url: o.opt_string("sourceFileURL")?,
            network_fingerprint: o.string("networkFingerprint")?,
            network_snapshot: NetworkSnapshot::from_json(o.required("networkSnapshot")?, &o.key_path("networkSnapshot"))?,
            buffer_regime: o.string("bufferRegime")?,
            parameters,
            seed: o.optional("seed").map(|s| codec::uint64(s, &o.key_path("seed"))).transpose()?,
            replication_seeds: o.array("replicationSeeds")?.iter().enumerate().map(|(i, s)| codec::uint64(s, &format!("{seeds_path}[{i}]"))).collect::<Result<_, _>>()?,
            application_version: o.string("applicationVersion")?,
            solver_version: o.opt_string("solverVersion")?,
            export_station_ids: o
                .opt_array("exportStationIDs")?
                .map(|a| a.iter().enumerate().map(|(i, x)| codec::uuid(x, &format!("{}[{i}]", o.key_path("exportStationIDs")))).collect::<Result<Vec<_>, _>>())
                .transpose()?,
        })
    }
}

/// The station ids in export order (0.90.34 `stationsInExportOrder.map(\.id)`): stations sorted
/// by the number in their names, ties in canvas order. Recorded with every run as
/// `exportStationIDs`, so solver row i is named after the right station later.
pub fn export_station_ids(net: &Network) -> Vec<String> {
    naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str()).into_iter().map(|n| n.id.clone()).collect()
}

/// True when the station names don't pin the export order down (`stationOrderIsAmbiguous`).
pub fn station_order_is_ambiguous(net: &Network) -> bool {
    naming::order_is_ambiguous(net.nodes_of(NodeKind::Station).map(|n| n.name.as_str()))
}

/// The name for entry `index` (zero-based) of an index-aligned result vector
/// (`stationName(atExportIndex:)`): the station's own name, or "S<index+1>" when the vector is
/// longer than the station list or the naming is ambiguous.
pub fn station_name_at_export_index(net: &Network, index: usize) -> String {
    let stations = naming::in_export_order(net.nodes_of(NodeKind::Station), |n| n.name.as_str());
    match stations.get(index) {
        Some(s) if !station_order_is_ambiguous(net) => s.name.clone(),
        _ => format!("S{}", index + 1),
    }
}

/// A file's URL as `URL(fileURLWithPath:).absoluteString` gives it, for `Provenance`'s
/// `sourceFileURL`: `file://` and the absolute path with everything outside letters, digits and
/// `-._~!$&'()*+,;=:@/` percent-encoded as UTF-8 (measured: `/a b/x#y` → `file:///a%20b/x%23y`).
/// Foundation also decomposed accented letters first ("é" → `e%CC%81`); pass the path as the file
/// system reports it (decomposed) to get the same text, since this doesn't normalise.
pub fn file_url(path: &str) -> String {
    let mut out = String::from("file://");
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The results file 0.90.34 kept (`ResultsStore.Archive`): `{"records": [...], "schemaVersion": 1}`.
pub mod archive {
    use super::*;

    /// The schema version 0.90.34 wrote (and the only one).
    pub const SCHEMA_VERSION: i64 = 1;

    /// The archive as the store writes it: `JSONEncoder` with `.sortedKeys` only (not pretty) and
    /// `.iso8601` dates. Fails on a non-finite number, as 0.90.34's write did.
    pub fn encode(records: &[RunRecord]) -> Result<String, EncodeError> {
        let mut m = BTreeMap::new();
        let list = records.iter().enumerate().map(|(i, r)| r.to_json().map_err(|e| EncodeError { path: format!("records[{i}].{}", e.path), value: e.value })).collect::<Result<_, _>>()?;
        m.insert("records".to_string(), Json::Array(list));
        m.insert("schemaVersion".to_string(), Json::int(SCHEMA_VERSION));
        Ok(codec::to_compact(&Json::Object(m)))
    }

    /// Reads an archive as 0.90.34's `load` did: `schemaVersion` must be a whole number (its value
    /// isn't checked) and `records` a list of records; any record that fails makes the whole file
    /// unreadable.
    pub fn decode(text: &str) -> Result<Vec<RunRecord>, DecodeError> {
        let v = json::parse(text).map_err(|e| DecodeError { path: String::new(), message: format!("The data isn't valid JSON: {e}.") })?;
        let o = Obj::of(&v, "")?;
        codec::int(o.required("schemaVersion")?, "schemaVersion")?;
        o.array("records")?.iter().enumerate().map(|(i, r)| RunRecord::from_json(r, &format!("records[{i}]"))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A snapshot as 0.90.34 stored it (Run ▸ QNA on GuangChenDaiGlynn25.sec3.1.2d), with the
    /// fingerprint 0.90.34 computed for it.
    const SNAPSHOT: &str = r#"{"infiniteBuffers":true,"links":[{"customerClass":0,"fromNodeID":"A1AAAAAA-3100-0001-0000-000000000001","id":"A1AAAAAA-3100-0002-0000-000000000001","routingProbability":1,"toNodeID":"A1AAAAAA-3100-0001-0000-000000000002"},{"customerClass":0,"fromNodeID":"A1AAAAAA-3100-0001-0000-000000000002","id":"A1AAAAAA-3100-0002-0000-000000000002","routingProbability":1,"toNodeID":"A1AAAAAA-3100-0001-0000-000000000003"},{"customerClass":0,"fromNodeID":"A1AAAAAA-3100-0001-0000-000000000003","id":"A1AAAAAA-3100-0002-0000-000000000003","routingProbability":0.5,"toNodeID":"A1AAAAAA-3100-0001-0000-000000000004"},{"customerClass":0,"fromNodeID":"A1AAAAAA-3100-0001-0000-000000000003","id":"A1AAAAAA-3100-0002-0000-000000000004","routingProbability":0.5,"toNodeID":"A1AAAAAA-3100-0001-0000-000000000006"},{"customerClass":0,"fromNodeID":"A1AAAAAA-3100-0001-0000-000000000004","id":"A1AAAAAA-3100-0002-0000-000000000005","routingProbability":1,"toNodeID":"A1AAAAAA-3100-0001-0000-000000000005"},{"customerClass":0,"fromNodeID":"A1AAAAAA-3100-0001-0000-000000000005","id":"A1AAAAAA-3100-0002-0000-000000000006","routingProbability":1,"toNodeID":"A1AAAAAA-3100-0001-0000-000000000006"}],"nodes":[{"bufferSize":1,"distribution":"poisson","distributionParameters":"lambda=0.9","id":"A1AAAAAA-3100-0001-0000-000000000001","kind":"source","name":"Src1","numberOfServers":1,"picture":"","position":[100,200],"serviceDistributions":{}},{"bufferSize":1,"distribution":"exponential","distributionParameters":"rate=1.0","id":"A1AAAAAA-3100-0001-0000-000000000002","kind":"buffer","name":"B2","numberOfServers":1,"picture":"","position":[200,200],"serviceDistributions":{}},{"bufferSize":1,"distribution":"erlang","distributionParameters":"k=2,rate=2.0","id":"A1AAAAAA-3100-0001-0000-000000000003","kind":"station","name":"S2","numberOfServers":1,"picture":"","position":[300,200],"serviceDistributions":{}},{"bufferSize":1,"distribution":"exponential","distributionParameters":"rate=1.0","id":"A1AAAAAA-3100-0001-0000-000000000004","kind":"buffer","name":"B1","numberOfServers":1,"picture":"","position":[400,300],"serviceDistributions":{}},{"bufferSize":1,"distribution":"erlang","distributionParameters":"k=2,rate=2.0","id":"A1AAAAAA-3100-0001-0000-000000000005","kind":"station","name":"S1","numberOfServers":1,"picture":"","position":[500,300],"serviceDistributions":{}},{"bufferSize":1,"distribution":"exponential","distributionParameters":"rate=1.0","id":"A1AAAAAA-3100-0001-0000-000000000006","kind":"sink","name":"Sink1","numberOfServers":1,"picture":"","position":[600,200],"serviceDistributions":{}}]}"#;
    const FINGERPRINT: &str = "170ca5517c2696a64f1c1957846007a7bc02b0164ca4f7716a54c64348e97240";

    fn snapshot() -> NetworkSnapshot {
        NetworkSnapshot::from_json(&json::parse(SNAPSHOT).unwrap(), "").unwrap()
    }

    #[test]
    fn the_fingerprint_is_0_90_34s_and_ignores_order_but_not_positions() {
        let s = snapshot();
        assert_eq!(s.fingerprint(), FINGERPRINT);
        assert_eq!(codec::to_compact(&s.to_json()), SNAPSHOT, "the snapshot writes back as 0.90.34 stored it");
        let mut shuffled = s.clone();
        shuffled.nodes.reverse();
        shuffled.links.reverse();
        assert_eq!(shuffled.fingerprint(), FINGERPRINT, "nodes and links are sorted by id first");
        let mut moved = s.clone();
        moved.nodes[0].position.0 += 1.0;
        assert_ne!(moved.fingerprint(), FINGERPRINT);
    }

    #[test]
    fn export_order_names_stations_by_their_numbers() {
        let net = snapshot().to_network();
        assert_eq!(export_station_ids(&net), ["A1AAAAAA-3100-0001-0000-000000000005", "A1AAAAAA-3100-0001-0000-000000000003"], "as 0.90.34 recorded them");
        assert_eq!(station_name_at_export_index(&net, 0), "S1");
        assert_eq!(station_name_at_export_index(&net, 1), "S2");
        assert_eq!(station_name_at_export_index(&net, 2), "S3", "past the end: the index");
        let mut ambiguous = net.clone();
        ambiguous.nodes[2].name = "CPU".into();
        assert!(station_order_is_ambiguous(&ambiguous));
        assert_eq!(station_name_at_export_index(&ambiguous, 0), "S1", "an ambiguous naming is never guessed");
        assert_eq!(station_name_at_export_index(&ambiguous, 1), "S2");
    }

    #[test]
    fn the_catalogue_and_run_labels_are_0_90_34s() {
        let all = MethodMetadata::catalogue();
        assert_eq!(all.len(), 22);
        let mc = MethodMetadata::named(ids::MONTE_CARLO).unwrap();
        assert_eq!((mc.short_name.as_str(), mc.layer.raw(), mc.fidelity.raw()), ("Monte Carlo", "Queueing process", "Queue simulation"), "the short name defaults to the display name");
        let rqna = MethodMetadata::named(ids::RQNA).unwrap();
        assert_eq!((rqna.display_name.as_str(), rqna.implementation.as_deref()), ("Whitt–You RQNA", Some("BNArqna")));
        for (label, id) in [
            ("sim", ids::MONTE_CARLO), ("inf_sim", ids::MONTE_CARLO), ("sm", ids::SPECTRAL), ("inf_sm", ids::SPECTRAL), ("fm", ids::FINITE_ELEMENT), ("flp", ids::LINEAR_PROGRAM),
            ("lp", ids::LINEAR_PROGRAM), ("mc", ids::MULTI_CLASS_SRBM), ("qna", ids::QNA), ("rqna", ids::RQNA), ("sbd", ids::SBD), ("mlmc", ids::SRBM_MLMC),
            ("generic_ctmc", ids::FINITE_CTMC), ("fb_decomp", ids::FINITE_DECOMPOSITION), ("truncated_ctmc", ids::TRUNCATED_CTMC), ("adaptive_bar", ids::ADAPTIVE_LOW_RANK_BAR),
            ("bar_bounds", ids::BAR_MOMENT_BOUNDS), ("regenerative_mc", ids::REGENERATIVE_MONTE_CARLO), ("product_form", ids::OPEN_PRODUCT_FORM), ("qbd", ids::QBD),
            ("cmp", ids::COMPARISON), ("inf_cmp", ids::COMPARISON), ("testset", ids::TEST_SET), ("spc", ids::SPECTRAL_CONVERGENCE),
        ] {
            assert_eq!(MethodMetadata::for_run_label(label).unwrap().identifier, id, "{label}");
        }
        assert!(MethodMetadata::for_run_label("analyze").is_none() && MethodMetadata::for_run_label("primitives").is_none());
        assert_eq!(ModelLayer::QueueApproximation.short_name(), "Approximation");
        assert_eq!(RunStatus::Cancelled.label(), "Cancelled");
    }

    fn record_json() -> String {
        format!(
            r#"{{"id":"d0000000-0000-4000-8000-000000000001","measurements":[{{"estimate":0.5,"id":"E0000000-0000-4000-8000-000000000001","metric":"Utilization","stationName":"S1","uncertainty":{{}},"unit":"ratio","extra":1}}],"method":{{"displayName":"Whitt QNA","fidelity":"Queueing approximation","identifier":"queue-approx.qna","implementation":null,"layer":"Queue approximation","shortName":"QNA"}},"provenance":{{"applicationVersion":"0.90.34","bufferRegime":"Infinite capacity","networkFingerprint":"{FINGERPRINT}","networkSnapshot":{SNAPSHOT},"networkTitle":"t","parameters":{{}},"replicationSeeds":[18446744073709551615],"seed":null,"tabID":"C0000000-0000-4000-8000-000000000001"}},"startedAt":"2026-11-11T04:05:39Z","status":"running","warnings":[]}}"#
        )
    }

    #[test]
    fn records_read_as_swifts_decoder_read_them() {
        let r = RunRecord::parse(&record_json()).unwrap();
        assert_eq!(r.id, "D0000000-0000-4000-8000-000000000001", "UUIDs come back upper case");
        assert_eq!(r.provenance.export_station_ids, None, "archives from before structured parsing have none");
        assert_eq!((r.provenance.seed, r.provenance.replication_seeds.clone()), (None, vec![u64::MAX]));
        assert_eq!(r.measurements[0].uncertainty, Some(Uncertainty::default()), "a stored {{}} stays, as Swift's decoder kept it");
        let back = codec::to_compact(&r.to_json().unwrap());
        assert!(back.contains(r#""uncertainty":{},"unit""#) && !back.contains("extra") && !back.contains("null") && !back.contains("implementation"), "{back}");

        let fails = |from: &str, to: &str| RunRecord::parse(&record_json().replacen(from, to, 1)).unwrap_err();
        assert_eq!(fails(r#""status":"running""#, r#""status":"paused""#).path, "status", "an unknown status makes the record unreadable");
        assert_eq!(fails(r#""layer":"Queue approximation""#, r#""layer":"Queue""#).path, "method.layer");
        assert_eq!(fails(r#""replicationSeeds":[18446744073709551615],"#, "").path, "provenance.replicationSeeds", "required, though empty in most records");
        assert_eq!(fails(r#""shortName":"QNA""#, r#""shortName":null"#).path, "method.shortName");
        assert_eq!(fails("18446744073709551615", "-1").path, "provenance.replicationSeeds[0]");
        assert_eq!(fails(r#""estimate":0.5"#, r#""estimate":"0.5""#).path, "measurements[0].estimate");
        assert_eq!(fails(r#""startedAt":"2026-11-11T04:05:39Z""#, r#""startedAt":"2026-11-11 04:05:39""#).path, "startedAt");
        assert_eq!(fails(r#""stationName":"S1""#, r#""stationName":"S1","customerClass":1.5"#).path, "measurements[0].customerClass");
        assert_eq!(fails(r#""infiniteBuffers":true"#, r#""infiniteBuffers":1"#).path, "provenance.networkSnapshot.infiniteBuffers");
        assert_eq!(fails(r#""kind":"source""#, r#""kind":"router""#).path, "provenance.networkSnapshot.nodes[0].kind");
        let lenient = RunRecord::parse(&record_json().replacen(r#""stationName":"S1""#, r#""stationName":"S1","customerClass":1.0,"note":null"#, 1)).unwrap();
        assert_eq!((lenient.measurements[0].customer_class, lenient.measurements[0].note.clone()), (Some(1), None));
    }

    #[test]
    fn a_record_with_a_non_finite_number_cannot_be_written() {
        let mut r = RunRecord::parse(&record_json()).unwrap();
        r.measurements[0].estimate = f64::INFINITY;
        let e = r.to_json().unwrap_err();
        assert_eq!(e.path, "measurements[0].estimate");
        assert_eq!(e.to_string(), "Unable to encode Double.inf directly in JSON (at measurements[0].estimate).");
        assert!(archive::encode(&[r]).unwrap_err().path.starts_with("records[0].measurements[0]"));
    }

    #[test]
    fn constructors_store_empty_uncertainty_and_evidence_as_nil() {
        let m = Measurement::new("X".into(), None, "S1".into(), Some(0), "m".into(), 1.0, "u".into(), Some(Uncertainty::default()), Some(NumericalEvidence::default()), None);
        assert_eq!((m.class_label(), m.uncertainty, m.numerical_evidence), ("C1".to_string(), None, None));
        let u = Uncertainty { lower_bound: Some(1.0), upper_bound: Some(2.0), standard_error: Some(0.1), ..Default::default() };
        assert_eq!((u.half_width(), u.spread()), (Some(0.5), Some(0.5)));
        let se = Uncertainty { standard_error: Some(0.1), ..Default::default() };
        assert_eq!((se.half_width(), se.spread()), (None, Some(0.1)));
    }

    #[test]
    fn capturing_provenance_records_the_export_order_and_the_regime() {
        let net = snapshot().to_network();
        let p = Provenance::capture("c0000000-0000-4000-8000-000000000001", "t.bnet", &net, Some(file_url("/a b/t#1.bnet")), BTreeMap::new(), Some(7), vec![], "2.0.0");
        assert_eq!(p.network_fingerprint, FINGERPRINT);
        assert_eq!(p.buffer_regime, "Infinite capacity");
        assert_eq!(p.tab_id, "C0000000-0000-4000-8000-000000000001");
        assert_eq!(p.source_file_url.as_deref(), Some("file:///a%20b/t%231.bnet"));
        assert_eq!(p.export_station_ids.unwrap().len(), 2);
    }
}
