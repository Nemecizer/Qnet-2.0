//! The queueing network: nodes, links and the document that holds them (0.90.34 `Models.swift`).
//!
//! A network is drawn from four kinds of node. Sources create jobs, buffers hold them, stations
//! serve them and sinks remove them; links route jobs between nodes with a probability, carrying
//! a customer class and optionally changing it. Customer classes have no table of their own: class
//! k is the k-th source in name order, and links may name more classes than there are sources.
//!
//! The enums' raw values are the strings `.bnet` files use, and are a file-format contract.

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NodeKind {
    Station,
    Buffer,
    Source,
    Sink,
}

impl NodeKind {
    pub const ALL: [NodeKind; 4] = [NodeKind::Station, NodeKind::Buffer, NodeKind::Source, NodeKind::Sink];

    pub fn raw(self) -> &'static str {
        match self {
            NodeKind::Station => "station",
            NodeKind::Buffer => "buffer",
            NodeKind::Source => "source",
            NodeKind::Sink => "sink",
        }
    }

    pub fn from_raw(s: &str) -> Option<NodeKind> {
        NodeKind::ALL.into_iter().find(|k| k.raw() == s)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            NodeKind::Station => "Station",
            NodeKind::Buffer => "Buffer",
            NodeKind::Source => "Source",
            NodeKind::Sink => "Sink",
        }
    }
}

/// A service or inter-arrival time law. `Poisson` is offered for sources only: a Poisson arrival
/// process, whose inter-arrival times are Exponential.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Distribution {
    Exponential,
    Gamma,
    Uniform,
    Constant,
    Weibull,
    Erlang,
    Lognormal,
    Pareto,
    Poisson,
}

impl Distribution {
    /// Picker order (0.90.34 `QueueDistribution.allCases`).
    pub const ALL: [Distribution; 9] = [
        Distribution::Exponential,
        Distribution::Gamma,
        Distribution::Uniform,
        Distribution::Constant,
        Distribution::Weibull,
        Distribution::Erlang,
        Distribution::Lognormal,
        Distribution::Pareto,
        Distribution::Poisson,
    ];

    pub fn raw(self) -> &'static str {
        match self {
            Distribution::Exponential => "exponential",
            Distribution::Gamma => "gamma",
            Distribution::Uniform => "uniform",
            Distribution::Constant => "constant",
            Distribution::Weibull => "weibull",
            Distribution::Erlang => "erlang",
            Distribution::Lognormal => "lognormal",
            Distribution::Pareto => "pareto",
            Distribution::Poisson => "poisson",
        }
    }

    pub fn from_raw(s: &str) -> Option<Distribution> {
        Distribution::ALL.into_iter().find(|d| d.raw() == s)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Distribution::Exponential => "Exponential",
            Distribution::Gamma => "Gamma",
            Distribution::Uniform => "Uniform",
            Distribution::Constant => "Deterministic",
            Distribution::Weibull => "Weibull",
            Distribution::Erlang => "Erlang",
            Distribution::Lognormal => "Lognormal",
            Distribution::Pareto => "Pareto",
            Distribution::Poisson => "Poisson",
        }
    }

    /// The parameter string a new node of this family starts with.
    pub fn default_parameters(self) -> &'static str {
        match self {
            Distribution::Exponential => "rate=1.0",
            Distribution::Gamma => "shape=2.0,scale=1.0",
            Distribution::Uniform => "min=0.5,max=1.5",
            Distribution::Constant => "value=1.0",
            Distribution::Weibull => "shape=1.5,scale=1.0",
            Distribution::Erlang => "k=2,rate=1.0",
            Distribution::Lognormal => "mu=0.0,sigma=0.25",
            Distribution::Pareto => "shape=2.5,scale=1.0",
            Distribution::Poisson => "lambda=1.0",
        }
    }

    /// Stations may not use Poisson, a count process.
    pub fn is_available_for_stations(self) -> bool {
        self != Distribution::Poisson
    }
}

/// The picture drawn inside a station: an SF Symbol name in 0.90.34, kept as the raw value so files
/// stay interchangeable. The interface draws each with a lucide icon (PLAN.md §4). A value not in
/// this catalogue makes the whole document unreadable, as it did in 0.90.34 (ledger FILE-005).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StationPicture {
    None,
    SingleOperator,
    TwoOperators,
    Team,
    Machine,
    Workbench,
    RepairStation,
    Printer,
    Automated,
    Healthcare,
    Cashier,
    Teller,
    CallCenter,
    PackageBox,
    Inspection,
    ServerRack,
    Gear,
}

impl StationPicture {
    pub const ALL: [StationPicture; 17] = [
        StationPicture::None,
        StationPicture::SingleOperator,
        StationPicture::TwoOperators,
        StationPicture::Team,
        StationPicture::Machine,
        StationPicture::Workbench,
        StationPicture::RepairStation,
        StationPicture::Printer,
        StationPicture::Automated,
        StationPicture::Healthcare,
        StationPicture::Cashier,
        StationPicture::Teller,
        StationPicture::CallCenter,
        StationPicture::PackageBox,
        StationPicture::Inspection,
        StationPicture::ServerRack,
        StationPicture::Gear,
    ];

    pub fn raw(self) -> &'static str {
        match self {
            StationPicture::None => "",
            StationPicture::SingleOperator => "person.fill",
            StationPicture::TwoOperators => "person.2.fill",
            StationPicture::Team => "person.3.fill",
            StationPicture::Machine => "gearshape.2.fill",
            StationPicture::Workbench => "hammer.fill",
            StationPicture::RepairStation => "wrench.and.screwdriver.fill",
            StationPicture::Printer => "printer.fill",
            StationPicture::Automated => "cpu.fill",
            StationPicture::Healthcare => "stethoscope",
            StationPicture::Cashier => "cart.fill",
            StationPicture::Teller => "creditcard.fill",
            StationPicture::CallCenter => "phone.fill",
            StationPicture::PackageBox => "shippingbox.fill",
            StationPicture::Inspection => "magnifyingglass",
            StationPicture::ServerRack => "server.rack",
            StationPicture::Gear => "gear",
        }
    }

    pub fn from_raw(s: &str) -> Option<StationPicture> {
        StationPicture::ALL.into_iter().find(|p| p.raw() == s)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            StationPicture::None => "No Picture",
            StationPicture::SingleOperator => "Operator",
            StationPicture::TwoOperators => "Two Operators",
            StationPicture::Team => "Team",
            StationPicture::Machine => "Machine",
            StationPicture::Workbench => "Workbench",
            StationPicture::RepairStation => "Repair / Maintenance",
            StationPicture::Printer => "Printer / 3D Print",
            StationPicture::Automated => "Automated / Robot",
            StationPicture::Healthcare => "Healthcare",
            StationPicture::Cashier => "Cashier",
            StationPicture::Teller => "Teller / ATM",
            StationPicture::CallCenter => "Call Center",
            StationPicture::PackageBox => "Package Box",
            StationPicture::Inspection => "Inspection",
            StationPicture::ServerRack => "Server Rack",
            StationPicture::Gear => "Gear",
        }
    }

    /// One operator, two, or a team for three or more servers.
    pub fn suggested_for_servers(servers: i64) -> StationPicture {
        match servers {
            i64::MIN..=1 => StationPicture::SingleOperator,
            2 => StationPicture::TwoOperators,
            _ => StationPicture::Team,
        }
    }
}

/// A per-class service-time law at a station, overriding the station's own.
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceConfig {
    pub distribution: Distribution,
    pub parameters: String,
}

/// The order of service at a station (new in 2.1, ledger SCI-1001). The raw values are the file's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Discipline {
    /// First come, first served, whatever the class: 0.90.34's only discipline, and the default.
    Fcfs,
    /// Head-of-the-line priority: a free server takes the waiting customer of the highest
    /// class; a service that has started is never interrupted.
    NonPreemptive,
    /// A higher class interrupts the service of a lower one at once; the interrupted customer
    /// later resumes where it stopped (no work is lost or repeated).
    PreemptiveResume,
}

impl Discipline {
    pub const ALL: [Discipline; 3] = [Discipline::Fcfs, Discipline::NonPreemptive, Discipline::PreemptiveResume];

    pub fn raw(self) -> &'static str {
        match self {
            Discipline::Fcfs => "fcfs",
            Discipline::NonPreemptive => "priorityNonPreemptive",
            Discipline::PreemptiveResume => "priorityPreemptiveResume",
        }
    }

    pub fn from_raw(s: &str) -> Option<Discipline> {
        Discipline::ALL.into_iter().find(|d| d.raw() == s)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Discipline::Fcfs => "First come, first served",
            Discipline::NonPreemptive => "Priority, non-preemptive",
            Discipline::PreemptiveResume => "Priority, preemptive-resume",
        }
    }
}

/// The law of the number of customers that arrive together at a source (new in 2.1, ledger
/// SCI-1010). The source's inter-arrival law then applies to batches.
#[derive(Clone, Debug, PartialEq)]
pub enum BatchSize {
    /// Always `k` customers (k ≥ 1).
    Constant(i64),
    /// P(X = n) = (1 − α)·α^(n−1), n ≥ 1, written by its mean 1/(1 − α) ≥ 1.
    Geometric { mean: f64 },
    /// P(X = n) = `p[n − 1]`, n = 1 … p.len().
    Pmf(Vec<f64>),
}

/// How far a batch pmf's sum may be from 1.
pub const PMF_TOLERANCE: f64 = 1e-9;
/// The most entries an explicit batch pmf may have.
pub const PMF_MAX: usize = 64;

impl BatchSize {
    /// What is wrong with the law, in a sentence, or None.
    pub fn problem(&self) -> Option<String> {
        match self {
            BatchSize::Constant(k) if *k < 1 => Some("The batch size must be a whole number, 1 or more.".into()),
            BatchSize::Constant(k) if *k > 1_000_000 => Some("The batch size must be at most 1,000,000.".into()),
            BatchSize::Geometric { mean } if !(mean.is_finite() && *mean >= 1.0) => Some("The mean batch size must be a number, 1 or more.".into()),
            BatchSize::Pmf(p) if p.is_empty() => Some("The batch-size probabilities are empty.".into()),
            BatchSize::Pmf(p) if p.len() > PMF_MAX => Some(format!("The batch-size probabilities list at most {PMF_MAX} sizes.")),
            BatchSize::Pmf(p) if p.iter().any(|x| !(x.is_finite() && *x >= 0.0)) => Some("Every batch-size probability must be a number, 0 or more.".into()),
            BatchSize::Pmf(p) if (p.iter().sum::<f64>() - 1.0).abs() > PMF_TOLERANCE => Some(format!("The batch-size probabilities sum to {}, not 1.", crate::dist::format_significant(p.iter().sum::<f64>(), 6))),
            _ => None,
        }
    }

    /// E[X]. Meaningful when `problem` is None.
    pub fn mean(&self) -> f64 {
        match self {
            BatchSize::Constant(k) => *k as f64,
            BatchSize::Geometric { mean } => *mean,
            BatchSize::Pmf(p) => p.iter().enumerate().map(|(i, x)| (i + 1) as f64 * x).sum(),
        }
    }

    /// E[X²]. For the geometric law with α = 1 − 1/m: (1 + α)/(1 − α)² = m·(2m − 1).
    pub fn second_moment(&self) -> f64 {
        match self {
            BatchSize::Constant(k) => (*k as f64) * (*k as f64),
            BatchSize::Geometric { mean } => mean * (2.0 * mean - 1.0),
            BatchSize::Pmf(p) => p.iter().enumerate().map(|(i, x)| ((i + 1) * (i + 1)) as f64 * x).sum(),
        }
    }

    /// True when every batch is one customer: the law changes nothing.
    pub fn is_single(&self) -> bool {
        match self {
            BatchSize::Constant(k) => *k == 1,
            BatchSize::Geometric { mean } => *mean == 1.0,
            BatchSize::Pmf(p) => p.first() == Some(&1.0) && p[1..].iter().all(|x| *x == 0.0),
        }
    }
}

/// One piece of a rate profile: the arrival rate is `multiplier` times the source's own until
/// time `until`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateSegment {
    pub until: f64,
    pub multiplier: f64,
}

/// A piecewise-constant arrival-rate profile of a Poisson source (new in 2.1, ledger SCI-1020):
/// from time 0 the source's rate is multiplied by each segment's multiplier in turn. After the
/// last segment the profile starts again when `periodic` (its period is the last `until`), and
/// otherwise the rate is the source's own (multiplier 1) for good.
#[derive(Clone, Debug, PartialEq)]
pub struct RateProfile {
    pub periodic: bool,
    pub segments: Vec<RateSegment>,
}

/// The most segments a rate profile may have.
pub const PROFILE_MAX: usize = 48;

impl RateProfile {
    /// What is wrong with the profile, in a sentence, or None.
    pub fn problem(&self) -> Option<String> {
        if self.segments.is_empty() {
            return Some("The rate profile has no segments.".into());
        }
        if self.segments.len() > PROFILE_MAX {
            return Some(format!("A rate profile has at most {PROFILE_MAX} segments."));
        }
        let mut last = 0.0;
        for (i, s) in self.segments.iter().enumerate() {
            if !(s.until.is_finite() && s.until > last) {
                return Some(format!("Segment {} of the rate profile has no length: each segment must end later than the one before it (the first later than time 0).", i + 1));
            }
            if !(s.multiplier.is_finite() && s.multiplier >= 0.0) {
                return Some(format!("Segment {} of the rate profile needs a multiplier that is 0 or more.", i + 1));
            }
            last = s.until;
        }
        if self.periodic && !self.segments.iter().any(|s| s.multiplier > 0.0) {
            return Some("The rate profile is zero all the time, so nothing would ever arrive.".into());
        }
        None
    }

    /// The period of a periodic profile, or the time after which a one-off profile is over.
    pub fn span(&self) -> f64 {
        self.segments.last().map(|s| s.until).unwrap_or(0.0)
    }

    /// The multiplier in force at time `t` ≥ 0 (a segment holds on [start, until)).
    pub fn multiplier_at(&self, t: f64) -> f64 {
        let span = self.span();
        let t = if self.periodic && span > 0.0 { t.rem_euclid(span) } else { t };
        self.segments.iter().find(|s| t < s.until).map(|s| s.multiplier).unwrap_or(1.0)
    }

    /// The largest multiplier the profile ever applies (1 counts after a one-off profile's end).
    pub fn peak(&self) -> f64 {
        let m = self.segments.iter().map(|s| s.multiplier).fold(0.0, f64::max);
        if self.periodic { m } else { m.max(1.0) }
    }

    /// The long-run average multiplier: the time average over a period, or 1 for a one-off profile.
    pub fn long_run_mean(&self) -> f64 {
        if !self.periodic {
            return 1.0;
        }
        let mut last = 0.0;
        let mut area = 0.0;
        for s in &self.segments {
            area += (s.until - last) * s.multiplier;
            last = s.until;
        }
        area / last
    }

    /// The times in (0, horizon) at which the multiplier may change, ascending.
    pub fn breakpoints(&self, horizon: f64) -> Vec<f64> {
        let span = self.span();
        let mut out = Vec::new();
        if !(span > 0.0) {
            return out;
        }
        let mut base = 0.0;
        loop {
            for s in &self.segments {
                let t = base + s.until;
                if t >= horizon || out.len() > 100_000 {
                    return out;
                }
                out.push(t);
            }
            if !self.periodic {
                return out;
            }
            base += span;
        }
    }
}

/// A node. Ids are UUIDs, kept in the upper-case form `JSONEncoder` writes.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    /// The node's centre, in canvas points.
    pub position: (f64, f64),
    /// The waiting room of a buffer (0.90.34 stores it on every node; only buffers use it).
    pub buffer_size: i64,
    pub distribution: Distribution,
    /// "key=value,key=value", e.g. "rate=1.0".
    pub parameters: String,
    pub servers: i64,
    /// Per-class service laws, by class index.
    pub service_by_class: BTreeMap<i64, ServiceConfig>,
    pub picture: StationPicture,
    /// A station's order of service (new in 2.1). `Fcfs` for every file 0.90.34 or 2.0 wrote.
    pub discipline: Discipline,
    /// With a priority discipline: the class indices, the highest priority first.
    pub priority_order: Vec<i64>,
    /// A source's batch-size law (new in 2.1), or None: customers arrive one at a time.
    pub batch: Option<BatchSize>,
    /// A source's rate profile (new in 2.1), or None: a constant rate.
    pub rate_profile: Option<RateProfile>,
}

impl Node {
    /// A node with 0.90.34's defaults: one waiting place, one server, Exponential(1).
    pub fn new(id: impl Into<String>, kind: NodeKind, name: impl Into<String>, position: (f64, f64)) -> Node {
        Node {
            id: id.into(),
            kind,
            name: name.into(),
            position,
            buffer_size: 1,
            distribution: Distribution::Exponential,
            parameters: Distribution::Exponential.default_parameters().to_string(),
            servers: 1,
            service_by_class: BTreeMap::new(),
            picture: StationPicture::None,
            discipline: Discipline::Fcfs,
            priority_order: Vec::new(),
            batch: None,
            rate_profile: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub id: String,
    pub from: String,
    pub to: String,
    pub probability: f64,
    /// The class a job travels as when it enters the link.
    pub class: i64,
    /// The class it leaves as, when the link changes it (re-entrant lines).
    pub to_class: Option<i64>,
}

impl Link {
    /// The class a job leaves this link with.
    pub fn exit_class(&self) -> i64 {
        self.to_class.unwrap_or(self.class)
    }

    /// True when the link changes the job's class.
    pub fn has_class_transition(&self) -> bool {
        self.to_class.is_some_and(|t| t != self.class)
    }
}

/// A whole `.bnet` document.
#[derive(Clone, Debug, PartialEq)]
pub struct Network {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
    /// Network-wide: every buffer is infinite (the orthant methods) or finite (the box methods).
    pub infinite_buffers: bool,
    pub canvas_scale: f64,
    /// Read from files, never written: 0.90.34 always saved [0, 0] (ledger FILE rows).
    pub canvas_pan_offset: (f64, f64),
    /// A closed network's number of circulating customers (new in 2.1, `closed.rs`). `None` for
    /// every file 0.90.34 or 2.0 wrote; meaningful only when there is no source and no sink.
    pub population: Option<i64>,
}

impl Network {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn nodes_of(&self, kind: NodeKind) -> impl Iterator<Item = &Node> {
        self.nodes.iter().filter(move |n| n.kind == kind)
    }
}
