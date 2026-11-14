//! The Regenerative Monte Carlo input (BNArmc's `regenerative_mc.py` and `bna_rmc`), and the strict
//! Markovian validator the exact product-form and QBD inputs are built on (0.90.34
//! `RegenerativeExporter.swift`).
//!
//! The solver takes only an open Markovian network: Poisson arrivals, exponential FCFS service
//! with one rate per station whatever the class, class-preserving Markov routing, and, when buffers
//! are finite, exactly one upstream buffer per station giving its total capacity. Anything a
//! drawing holds outside that is refused with one of 32 sentences rather than approximated, and
//! the checks run in 0.90.34's order, so the first failure is the one 0.90.34 named.
//!
//! The document is `JSONEncoder` with `[.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]`
//! over `Codable` structs, so Doubles are written with `Json::num`, the `Int` fields with
//! `Json::int`, and the two `UInt64` random-stream fields as plain decimal (which `JSONEncoder` also
//! uses for them, up to 2^64 − 1). Stations are `s1…sn` in export order and classes `c1…ck`, one
//! per source in name order.
//!
//! Two places where 0.90.34's result depended on Swift's per-process hash order are made
//! deterministic here; neither can be reached by a valid network (see `export`).

use std::collections::{BTreeMap, HashMap};

use crate::cfmt;
use crate::dist;
use crate::json::{self, Json};
use crate::model::{Distribution, Link, Network, Node, NodeKind};
use crate::naming;

/// `base_seed` when the run gives none (0.90.34's default argument).
pub const DEFAULT_BASE_SEED: u64 = 20_260_904;

/// Two routing sums or rates closer than this count as equal; a row may exceed 1 by this much.
const ROUTING_TOLERANCE: f64 = 1e-12;
/// A routing row whose sum is below 1 − this can send a job out of the network.
const EXIT_PATH_TOLERANCE: f64 = 1e-14;
/// Two classes' service rates at one station match within this relative tolerance.
const RATE_TOLERANCE: f64 = 1e-10;

/// Why the network cannot be written as a regenerative simulation input. Each variant is one of
/// 0.90.34's `RegenerativeExportError` cases, and `message` is its sentence.
#[derive(Clone, Debug, PartialEq)]
pub enum RegenerativeError {
    EmptyName,
    NoStations,
    NoSources,
    /// Station, its server count.
    InvalidServerCount(String, i64),
    /// Station (finite buffers only).
    MissingBuffer(String),
    MultipleBuffers(String),
    /// Buffer, the stations it feeds (sorted).
    SharedBuffer(String, Vec<String>),
    /// Buffer, its waiting capacity.
    InvalidBufferSize(String, i64),
    /// Station whose servers plus waiting capacity overflow an Int.
    CapacityOverflow(String),
    /// Source, its distribution's display name.
    UnsupportedArrival(String, String),
    InvalidArrivalRate(String),
    UnresolvedSource(String),
    /// Source, the class it creates, the class the route is labelled with.
    SourceClassMismatch(String, String, String),
    /// From, to, the class entering, the class leaving.
    ClassTransition(String, String, String, String),
    /// Node the route starts at, the route's class index.
    UnknownClass(String, i64),
    /// Station, class label, distribution display name.
    UnsupportedService(String, String, String),
    /// Station, class label.
    InvalidServiceRate(String, String),
    /// Station, first class, its rate, the other class, its rate.
    ClassDependentService(String, String, f64, String, f64),
    /// Node the route starts at, the probability.
    InvalidRoutingProbability(String, f64),
    /// Node, class label, the row's total.
    RoutingExceedsOne(String, String, f64),
    MissingOrigin,
    /// Node the route starts at.
    MissingDestination(String),
    /// Node the route starts at, the source it points to.
    UnsupportedDestination(String, String),
    BufferWithoutStation(String),
    /// Buffer, the stations it feeds (sorted).
    BufferWithMultipleStations(String, Vec<String>),
    /// Buffer, the node that is not a station.
    BufferWithUnsupportedDestination(String, String),
    /// Buffer, station, the probability that is not 1.
    BufferConnectionProbability(String, String, f64),
    /// Class label, the station that cannot reach an exit.
    ClosedRouting(String, String),
    /// Class label (or "all classes"), the detail.
    InvalidTrafficEquations(String, String),
    /// Station, its offered load.
    UnstableStation(String, f64),
    /// The stopping rule that failed.
    InvalidStopping(String),
    Encoding(String),
}

/// A number in a refusal: `%.7g`, or Swift's description for inf and nan.
fn number(v: f64) -> String {
    if v.is_finite() {
        cfmt::f("%.7g", v)
    } else {
        cfmt::swift_description(v)
    }
}

impl RegenerativeError {
    /// The sentence 0.90.34 showed (`errorDescription`).
    pub fn message(&self) -> String {
        use RegenerativeError::*;
        match self {
            EmptyName => "Enter a name for the regenerative simulation input.".into(),
            NoStations => "The network has no service stations. Add at least one station before exporting.".into(),
            NoSources => "The network has no external arrival source. Add at least one source before exporting.".into(),
            InvalidServerCount(station, count) => {
                format!("{station} has {count} servers. Regenerative simulation requires at least one server at every station.")
            }
            MissingBuffer(station) => format!("{station} needs exactly one upstream buffer to define its finite total capacity."),
            MultipleBuffers(station) => {
                format!("{station} has more than one upstream buffer. Use one buffer per station before exporting a finite network.")
            }
            SharedBuffer(buffer, stations) => format!(
                "{buffer} feeds more than one station ({}). Give each finite station its own upstream buffer.",
                stations.join(", ")
            ),
            InvalidBufferSize(buffer, size) => format!(
                "{buffer} has waiting capacity {size}. Finite regenerative simulation requires a nonnegative waiting capacity."
            ),
            CapacityOverflow(station) => {
                format!("{station}'s server count plus waiting capacity is too large to export. Reduce one of those values.")
            }
            UnsupportedArrival(source, distribution) => format!(
                "{source} uses {distribution} arrivals. Regenerative simulation requires a Poisson process (Poisson or exponential inter-arrivals)."
            ),
            InvalidArrivalRate(source) => format!("{source} does not contain a positive finite arrival rate."),
            UnresolvedSource(source) => format!(
                "{source} does not send positive-rate arrivals to a service station. Connect it directly, or through a buffer, to one or more stations."
            ),
            SourceClassMismatch(source, expected, actual) => format!(
                "A route from {source} is labelled {actual}, but that source creates {expected}. Change the route to preserve the source class."
            ),
            ClassTransition(from, to, incoming, outgoing) => format!(
                "The route from {from} to {to} changes {incoming} to {outgoing}. Regenerative simulation currently requires class-preserving routing."
            ),
            UnknownClass(location, index) => format!(
                "A route from {location} uses class {}, but there is no matching external source. Add the source or change the route class.",
                index.wrapping_add(1)
            ),
            UnsupportedService(station, class, distribution) => format!(
                "{station}, {class} uses {distribution} service. Regenerative simulation requires exponential FCFS service."
            ),
            InvalidServiceRate(station, class) => {
                format!("{station}, {class} does not contain a positive finite exponential service rate.")
            }
            ClassDependentService(station, first, first_rate, other, other_rate) => format!(
                "{station} has class-dependent service rates: {first} uses {} and {other} uses {}. Set one common exponential rate for every class at that station.",
                number(*first_rate),
                number(*other_rate)
            ),
            InvalidRoutingProbability(location, p) => format!(
                "A route from {location} has probability {}. Routing probabilities must be finite and between 0 and 1.",
                number(*p)
            ),
            RoutingExceedsOne(location, class, total) => format!(
                "Routing probabilities from {location} for {class} total {}, above 1. Reduce the outgoing probabilities so their sum is at most 1.",
                number(*total)
            ),
            MissingOrigin => {
                "A route starts at a node that is no longer in the document. Delete that route and reconnect the remaining nodes.".into()
            }
            MissingDestination(location) => {
                format!("A route from {location} points to a node that is no longer in the document. Delete or reconnect that route.")
            }
            UnsupportedDestination(location, destination) => format!(
                "A route from {location} points to source {destination}. Routes may lead only to a station, an upstream buffer, or an exit sink."
            ),
            BufferWithoutStation(buffer) => format!(
                "{buffer} is used as a route destination but does not feed a service station. Connect it to exactly one station."
            ),
            BufferWithMultipleStations(buffer, stations) => format!(
                "{buffer} is used as a route destination but feeds multiple stations ({}). Split it into one buffer per station.",
                stations.join(", ")
            ),
            BufferWithUnsupportedDestination(buffer, destination) => format!(
                "{buffer} has a positive outgoing route to {destination}. An upstream buffer must feed exactly one service station and have no other positive outgoing routes."
            ),
            BufferConnectionProbability(buffer, station, p) => format!(
                "The structural route from {buffer} to {station} has probability {}. Set it to 1 so every waiting job enters that station.",
                number(*p)
            ),
            ClosedRouting(class, station) => format!(
                "{class} cannot reach an exit from {station}. Lower at least one routing row sum below 1 or add a positive-probability path to a sink."
            ),
            InvalidTrafficEquations(class, detail) => format!(
                "The traffic equations for {class} could not be solved reliably ({detail}). Add exit probability or move the routing probabilities farther from a closed loop."
            ),
            UnstableStation(station, load) => format!(
                "{station} has infinite-buffer offered load {}, but regenerative steady state requires load below 1. Reduce arrivals/routing or add service capacity.",
                number(*load)
            ),
            InvalidStopping(message) => format!("The regenerative stopping settings are invalid: {message}"),
            Encoding(message) => format!("The regenerative simulation input could not be encoded: {message}"),
        }
    }
}

/// The sequential fixed-width stopping rule written into the document (0.90.34
/// `RegenerativeStoppingOptions`). `Default` is 0.90.34's defaults, which mirror
/// `regenerative_mc.py`'s; the Run sheet overrides some of them (`monte_carlo_sheet`).
#[derive(Clone, Debug, PartialEq)]
pub struct StoppingOptions {
    pub confidence: f64,
    pub absolute_half_width: f64,
    pub relative_half_width: f64,
    pub minimum_cycles: i64,
    pub minimum_effective_cycles: f64,
    pub minimum_positive_cycles: i64,
    pub check_every_cycles: i64,
    pub maximum_cycles: i64,
    pub maximum_events: i64,
    pub maximum_simulated_time: f64,
    pub maximum_cycle_time: f64,
    pub maximum_events_per_cycle: i64,
    pub maximum_wall_seconds: f64,
}

impl Default for StoppingOptions {
    fn default() -> Self {
        StoppingOptions {
            confidence: 0.95,
            absolute_half_width: 0.02,
            relative_half_width: 0.05,
            minimum_cycles: 200,
            minimum_effective_cycles: 30.0,
            minimum_positive_cycles: 5,
            check_every_cycles: 50,
            maximum_cycles: 100_000,
            maximum_events: 10_000_000,
            maximum_simulated_time: 1_000_000_000.0,
            maximum_cycle_time: 10_000_000.0,
            maximum_events_per_cycle: 2_000_000,
            maximum_wall_seconds: 120.0,
        }
    }
}

/// What the Run › Regenerative Monte Carlo sheet offers before the user changes anything
/// (0.90.34's `values.double/int(…, default:)` there): confidence, absolute and relative
/// half-width, minimum and maximum cycles, wall-clock seconds.
pub const SHEET_DEFAULTS: (f64, f64, f64, i64, i64, i64) = (0.95, 0.05, 0.10, 500, 20_000, 30);

impl StoppingOptions {
    /// The options the Run sheet passes for what the user entered, as 0.90.34 built them: at
    /// least 30 minimum cycles, maximum cycles no fewer than that, at least one wall-clock
    /// second, `minimum_effective_cycles` min(30, minimum cycles), `check_every_cycles`
    /// min(100, minimum cycles), and the other limits at their defaults.
    pub fn monte_carlo_sheet(
        confidence: f64,
        absolute_half_width: f64,
        relative_half_width: f64,
        minimum_cycles: i64,
        maximum_cycles: i64,
        maximum_wall_seconds: i64,
    ) -> StoppingOptions {
        let minimum_cycles = minimum_cycles.max(30);
        let maximum_cycles = maximum_cycles.max(minimum_cycles);
        StoppingOptions {
            confidence,
            absolute_half_width,
            relative_half_width,
            minimum_cycles,
            minimum_effective_cycles: minimum_cycles.min(30) as f64,
            minimum_positive_cycles: 5,
            check_every_cycles: minimum_cycles.min(100),
            maximum_cycles,
            maximum_events: 10_000_000,
            maximum_simulated_time: 1_000_000_000.0,
            maximum_cycle_time: 10_000_000.0,
            maximum_events_per_cycle: 2_000_000,
            maximum_wall_seconds: maximum_wall_seconds.max(1) as f64,
        }
    }
}

/// The run's parameters: the random stream and the stopping rule.
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub base_seed: u64,
    pub stream: u64,
    pub stopping: StoppingOptions,
}

impl Default for Options {
    fn default() -> Self {
        Options { base_seed: DEFAULT_BASE_SEED, stream: 0, stopping: StoppingOptions::default() }
    }
}

/// Swift's `max(x, y)` on Doubles.
fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

/// Swift's `Sequence.max()` on Doubles: the first, replaced by each later one it is less than.
fn seq_max(v: impl IntoIterator<Item = f64>) -> Option<f64> {
    let mut it = v.into_iter();
    let mut r = it.next()?;
    for e in it {
        if r < e {
            r = e;
        }
    }
    Some(r)
}

/// Swift's `Sequence.min()` on Doubles.
fn seq_min(v: impl IntoIterator<Item = f64>) -> Option<f64> {
    let mut it = v.into_iter();
    let mut r = it.next()?;
    for e in it {
        if e < r {
            r = e;
        }
    }
    Some(r)
}

/// "Class k" for class index k − 1, with a negative index read as 0 (0.90.34's `classLabel`).
fn class_label(index: i64) -> String {
    crate::traffic::class_label(index.max(0))
}

fn station_id(index: usize) -> String {
    format!("s{}", index + 1)
}

fn class_id(index: usize) -> String {
    format!("c{}", index + 1)
}

/// Swift's `.whitespacesAndNewlines` trim.
pub(crate) fn trim_name(name: &str) -> &str {
    name.trim_matches(char::is_whitespace)
}

fn rates_match(a: f64, b: f64) -> bool {
    (a - b).abs() <= RATE_TOLERANCE * swift_max(1.0, swift_max(a.abs(), b.abs()))
}

/// Where a route ends once buffers are looked through.
enum Resolved {
    Station(usize),
    Exit,
}

/// What every resolution needs: the nodes by id, the links, the stations' export positions.
struct Ctx<'a> {
    by_id: HashMap<&'a str, &'a Node>,
    links: &'a [Link],
    station_index: HashMap<&'a str, usize>,
}

impl<'a> Ctx<'a> {
    fn resolve(&self, destination_id: &str, location: &str) -> Result<Resolved, RegenerativeError> {
        let Some(destination) = self.by_id.get(destination_id) else {
            return Err(RegenerativeError::MissingDestination(location.into()));
        };
        match destination.kind {
            NodeKind::Station => match self.station_index.get(destination.id.as_str()) {
                Some(&i) => Ok(Resolved::Station(i)),
                None => Err(RegenerativeError::MissingDestination(location.into())),
            },
            NodeKind::Sink => Ok(Resolved::Exit),
            NodeKind::Source => Err(RegenerativeError::UnsupportedDestination(location.into(), destination.name.clone())),
            NodeKind::Buffer => self.resolve_buffer(destination).map(Resolved::Station),
        }
    }

    /// A buffer is a structural waiting room, not a probabilistic stage: its positive routes must
    /// all go, with probability 1, to one station.
    fn resolve_buffer(&self, buffer: &Node) -> Result<usize, RegenerativeError> {
        let outgoing: Vec<&Link> = self.links.iter().filter(|l| l.from == buffer.id && l.probability > 0.0).collect();
        if outgoing.is_empty() {
            return Err(RegenerativeError::BufferWithoutStation(buffer.name.clone()));
        }
        let mut station_ids: Vec<&str> = Vec::new();
        for link in outgoing {
            let Some(destination) = self.by_id.get(link.to.as_str()) else {
                return Err(RegenerativeError::MissingDestination(buffer.name.clone()));
            };
            if destination.kind != NodeKind::Station {
                return Err(RegenerativeError::BufferWithUnsupportedDestination(buffer.name.clone(), destination.name.clone()));
            }
            if (link.probability - 1.0).abs() > ROUTING_TOLERANCE {
                return Err(RegenerativeError::BufferConnectionProbability(
                    buffer.name.clone(),
                    destination.name.clone(),
                    link.probability,
                ));
            }
            if !station_ids.contains(&destination.id.as_str()) {
                station_ids.push(destination.id.as_str());
            }
        }
        if station_ids.len() != 1 {
            let mut names: Vec<String> = station_ids.iter().filter_map(|id| self.by_id.get(id).map(|n| n.name.clone())).collect();
            names.sort();
            return Err(RegenerativeError::BufferWithMultipleStations(buffer.name.clone(), names));
        }
        match self.station_index.get(station_ids[0]) {
            Some(&i) => Ok(i),
            None => Err(RegenerativeError::BufferWithoutStation(buffer.name.clone())),
        }
    }
}

/// Why the traffic equations failed (0.90.34 `TrafficEquationError`).
enum TrafficEquationError {
    Singular,
    NegativeRate,
    IllConditioned(f64, f64),
    Nonfinite,
}

impl TrafficEquationError {
    fn detail(&self) -> String {
        match self {
            TrafficEquationError::Singular => "the routing matrix is closed or numerically singular".into(),
            TrafficEquationError::NegativeRate => "the solution contains a negative arrival rate".into(),
            TrafficEquationError::IllConditioned(residual, tolerance) => {
                format!("residual {} exceeds tolerance {}", cfmt::f("%.7g", *residual), cfmt::f("%.7g", *tolerance))
            }
            TrafficEquationError::Nonfinite => "the numerical solution is not finite".into(),
        }
    }
}

/// Solves λ = external + λP with the regenerative parser's scaled partial pivoting and residual
/// policy (0.90.34 `trafficRates`).
fn traffic_rates(routing: &[Vec<f64>], external: &[f64]) -> Result<Vec<f64>, TrafficEquationError> {
    let n = routing.len();
    if n == 0 || external.len() != n || routing.iter().any(|r| r.len() != n) {
        return Err(TrafficEquationError::Singular);
    }
    let equations: Vec<Vec<f64>> =
        (0..n).map(|row| (0..n).map(|col| (if row == col { 1.0 } else { 0.0 }) - routing[col][row]).collect()).collect();
    let mut rates = solve_linear(&equations, external)?;
    if !rates.iter().all(|r| r.is_finite()) {
        return Err(TrafficEquationError::Nonfinite);
    }
    let tolerance = 2e-11 * swift_max(1.0, seq_max(rates.iter().copied()).unwrap_or(0.0));
    if !(seq_min(rates.iter().copied()).unwrap_or(0.0) >= -tolerance) {
        return Err(TrafficEquationError::NegativeRate);
    }
    rates = rates.into_iter().map(|r| swift_max(0.0, r)).collect();
    let mut residual = 0.0;
    for destination in 0..n {
        let mut routed = 0.0;
        for k in 0..n {
            routed += rates[k] * routing[k][destination];
        }
        residual = swift_max(residual, (rates[destination] - external[destination] - routed).abs());
    }
    if !(residual <= tolerance) {
        return Err(TrafficEquationError::IllConditioned(residual, tolerance));
    }
    Ok(rates)
}

/// Gaussian elimination with scaled partial pivoting (0.90.34 `solveLinear`).
fn solve_linear(matrix: &[Vec<f64>], rhs: &[f64]) -> Result<Vec<f64>, TrafficEquationError> {
    let n = matrix.len();
    let mut aug: Vec<Vec<f64>> = (0..n)
        .map(|i| {
            let mut r = matrix[i].clone();
            r.push(rhs[i]);
            r
        })
        .collect();
    let mut scales: Vec<f64> = matrix.iter().map(|row| seq_max(row.iter().map(|x| x.abs())).unwrap_or(0.0)).collect();
    if !scales.iter().all(|&s| s > 0.0 && s.is_finite()) {
        return Err(TrafficEquationError::Singular);
    }
    for column in 0..n {
        // Swift's max(by:): the first candidate, replaced by each later one it orders before.
        let mut pivot = column;
        for candidate in column + 1..n {
            if aug[pivot][column].abs() / scales[pivot] < aug[candidate][column].abs() / scales[candidate] {
                pivot = candidate;
            }
        }
        let floor = 16.0 * f64::EPSILON * n as f64 * scales[pivot];
        if !(aug[pivot][column].abs() > floor) {
            return Err(TrafficEquationError::Singular);
        }
        if pivot != column {
            aug.swap(pivot, column);
            scales.swap(pivot, column);
        }
        let pivot_value = aug[column][column];
        for row in column + 1..n {
            let factor = aug[row][column] / pivot_value;
            aug[row][column] = 0.0;
            for index in column + 1..=n {
                let v = factor * aug[column][index];
                aug[row][index] -= v;
            }
        }
    }
    let mut answer = vec![0.0; n];
    for row in (0..n).rev() {
        let mut remainder = aug[row][n];
        for column in row + 1..n {
            remainder -= aug[row][column] * answer[column];
        }
        answer[row] = remainder / aug[row][row];
    }
    if !answer.iter().all(|a| a.is_finite()) {
        return Err(TrafficEquationError::Nonfinite);
    }
    Ok(answer)
}

/// The first station from which no positive-probability path leads to a row that can exit.
fn first_station_without_exit_path(routing: &[Vec<f64>]) -> Option<usize> {
    let mut can_exit: Vec<bool> = routing
        .iter()
        .map(|row| {
            let mut s = 0.0;
            for &p in row {
                s += p;
            }
            s < 1.0 - EXIT_PATH_TOLERANCE
        })
        .collect();
    let mut changed = true;
    while changed {
        changed = false;
        for source in 0..routing.len() {
            if can_exit[source] {
                continue;
            }
            if (0..routing[source].len()).any(|j| routing[source][j] > 0.0 && can_exit[j]) {
                can_exit[source] = true;
                changed = true;
            }
        }
    }
    can_exit.iter().position(|&c| !c)
}

/// The stopping rule's checks, in 0.90.34's order (`validate`).
fn validate(o: &StoppingOptions) -> Option<RegenerativeError> {
    let fail = |m: &str| Some(RegenerativeError::InvalidStopping(m.into()));
    if !(o.confidence.is_finite() && o.confidence > 0.5 && o.confidence < 1.0) {
        return fail("confidence must be finite and strictly between 0.5 and 1.");
    }
    if !(o.absolute_half_width.is_finite()
        && o.absolute_half_width >= 0.0
        && o.relative_half_width.is_finite()
        && o.relative_half_width >= 0.0
        && (o.absolute_half_width > 0.0 || o.relative_half_width > 0.0))
    {
        return fail("half-width targets must be nonnegative and at least one must be positive.");
    }
    if o.minimum_cycles < 30 {
        return fail("minimumCycles must be at least 30 for the regenerative t interval.");
    }
    if !(o.minimum_effective_cycles.is_finite()
        && o.minimum_effective_cycles > 0.0
        && o.minimum_effective_cycles <= o.minimum_cycles as f64)
    {
        return fail("minimumEffectiveCycles must be positive and no greater than minimumCycles.");
    }
    if o.minimum_positive_cycles <= 0 {
        return fail("minimumPositiveCycles must be positive.");
    }
    if o.check_every_cycles <= 0 {
        return fail("checkEveryCycles must be positive.");
    }
    if o.maximum_cycles < o.minimum_cycles {
        return fail("maximumCycles cannot be less than minimumCycles.");
    }
    if o.maximum_events <= 0 {
        return fail("maximumEvents must be positive.");
    }
    if !(o.maximum_simulated_time.is_finite() && o.maximum_simulated_time > 0.0) {
        return fail("maximumSimulatedTime must be positive and finite.");
    }
    if !(o.maximum_cycle_time.is_finite() && o.maximum_cycle_time > 0.0) {
        return fail("maximumCycleTime must be positive and finite.");
    }
    if o.maximum_events_per_cycle <= 0 {
        return fail("maximumEventsPerCycle must be positive.");
    }
    if !(o.maximum_wall_seconds.is_finite() && o.maximum_wall_seconds > 0.0) {
        return fail("maximumWallSeconds must be positive and finite.");
    }
    None
}

fn stopping_json(o: &StoppingOptions) -> Json {
    let mut m = BTreeMap::new();
    m.insert("confidence".into(), Json::num(o.confidence));
    m.insert("absolute_half_width".into(), Json::num(o.absolute_half_width));
    m.insert("relative_half_width".into(), Json::num(o.relative_half_width));
    m.insert("monitored_metrics".into(), Json::Array(vec![Json::str("mean_number_in_system")]));
    m.insert("minimum_cycles".into(), Json::int(o.minimum_cycles));
    m.insert("minimum_effective_cycles".into(), Json::num(o.minimum_effective_cycles));
    m.insert("minimum_positive_cycles".into(), Json::int(o.minimum_positive_cycles));
    m.insert("check_every_cycles".into(), Json::int(o.check_every_cycles));
    m.insert("maximum_cycles".into(), Json::int(o.maximum_cycles));
    m.insert("maximum_events".into(), Json::int(o.maximum_events));
    m.insert("maximum_simulated_time".into(), Json::num(o.maximum_simulated_time));
    m.insert("maximum_cycle_time".into(), Json::num(o.maximum_cycle_time));
    m.insert("maximum_events_per_cycle".into(), Json::int(o.maximum_events_per_cycle));
    m.insert("maximum_wall_seconds".into(), Json::num(o.maximum_wall_seconds));
    Json::Object(m)
}

fn rates_json(m: &BTreeMap<String, f64>) -> Json {
    Json::Object(m.iter().map(|(k, v)| (k.clone(), Json::num(*v))).collect())
}

/// Writes the regenerative simulation input for `net`, named `name` (trimmed), or refuses it with
/// 0.90.34's first failing check (0.90.34 `RegenerativeExporter.export`).
///
/// Two of 0.90.34's choices depended on Swift's random per-process hash order and are fixed here:
/// which shared buffer is named when several are shared (here the first in station order; a
/// shared buffer is in fact always caught earlier, as feeding several stations), and which node
/// wins when two have the same id (0.90.34 stopped with a fatal error; here the first).
pub fn export(net: &Network, name: &str, options: &Options) -> Result<String, RegenerativeError> {
    use RegenerativeError as E;
    let trimmed = trim_name(name);
    if trimmed.is_empty() {
        return Err(E::EmptyName);
    }
    if let Some(e) = validate(&options.stopping) {
        return Err(e);
    }

    let stations = naming::in_export_order(net.nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);
    if stations.is_empty() {
        return Err(E::NoStations);
    }
    let sources = naming::in_export_order(net.nodes.iter().filter(|n| n.kind == NodeKind::Source), |n| &n.name);
    if sources.is_empty() {
        return Err(E::NoSources);
    }

    let mut by_id: HashMap<&str, &Node> = HashMap::new();
    for n in &net.nodes {
        by_id.entry(n.id.as_str()).or_insert(n);
    }
    let mut station_index: HashMap<&str, usize> = HashMap::new();
    for (i, s) in stations.iter().enumerate() {
        station_index.entry(s.id.as_str()).or_insert(i);
    }
    let ctx = Ctx { by_id, links: &net.links, station_index };
    let class_count = sources.len();

    for station in &stations {
        if station.servers <= 0 {
            return Err(E::InvalidServerCount(station.name.clone(), station.servers));
        }
    }

    for link in &net.links {
        let Some(origin) = ctx.by_id.get(link.from.as_str()) else {
            return Err(E::MissingOrigin);
        };
        let Some(destination) = ctx.by_id.get(link.to.as_str()) else {
            return Err(E::MissingDestination(origin.name.clone()));
        };
        if !(link.probability.is_finite() && (0.0..=1.0).contains(&link.probability)) {
            return Err(E::InvalidRoutingProbability(origin.name.clone(), link.probability));
        }
        if !(link.probability > 0.0) {
            continue;
        }
        if link.has_class_transition() {
            return Err(E::ClassTransition(
                origin.name.clone(),
                destination.name.clone(),
                class_label(link.class),
                class_label(link.exit_class()),
            ));
        }
        if (origin.kind == NodeKind::Source || origin.kind == NodeKind::Station) && !(0..class_count as i64).contains(&link.class) {
            return Err(E::UnknownClass(origin.name.clone(), link.class));
        }
    }

    let mut capacities: Vec<Option<i64>> = vec![None; stations.len()];
    if !net.infinite_buffers {
        // Buffer id → the stations it feeds, in the order first met.
        let mut stations_by_buffer: Vec<(&str, Vec<String>)> = Vec::new();
        for (index, station) in stations.iter().enumerate() {
            let feeding: Vec<&Node> = net
                .nodes
                .iter()
                .filter(|c| {
                    c.kind == NodeKind::Buffer && net.links.iter().any(|l| l.from == c.id && l.to == station.id && l.probability > 0.0)
                })
                .collect();
            if feeding.is_empty() {
                return Err(E::MissingBuffer(station.name.clone()));
            }
            if feeding.len() != 1 {
                return Err(E::MultipleBuffers(station.name.clone()));
            }
            let buffer = feeding[0];
            let destination = ctx.resolve_buffer(buffer)?;
            if destination != index {
                let mut names = vec![station.name.clone(), stations[destination].name.clone()];
                names.sort();
                return Err(E::BufferWithMultipleStations(buffer.name.clone(), names));
            }
            if buffer.buffer_size < 0 {
                return Err(E::InvalidBufferSize(buffer.name.clone(), buffer.buffer_size));
            }
            match stations_by_buffer.iter_mut().find(|(id, _)| *id == buffer.id) {
                Some((_, names)) => names.push(station.name.clone()),
                None => stations_by_buffer.push((buffer.id.as_str(), vec![station.name.clone()])),
            }
            let Some(capacity) = station.servers.checked_add(buffer.buffer_size) else {
                return Err(E::CapacityOverflow(station.name.clone()));
            };
            capacities[index] = Some(capacity);
        }
        if let Some((id, names)) = stations_by_buffer.iter().find(|(_, names)| names.len() > 1) {
            if let Some(buffer) = ctx.by_id.get(id) {
                let mut names = names.clone();
                names.sort();
                return Err(E::SharedBuffer(buffer.name.clone(), names));
            }
        }
    }

    // Per station: one exponential rate shared by every class.
    let mut node_docs: Vec<(i64, f64, Option<i64>)> = Vec::new();
    for (index, station) in stations.iter().enumerate() {
        let mut reference: Option<(String, f64)> = None;
        for class_index in 0..class_count {
            let label = class_label(class_index as i64);
            let (distribution, parameters) = match station.service_by_class.get(&(class_index as i64)) {
                Some(c) => (c.distribution, c.parameters.as_str()),
                None => (station.distribution, station.parameters.as_str()),
            };
            if distribution != Distribution::Exponential {
                return Err(E::UnsupportedService(station.name.clone(), label, distribution.display_name().into()));
            }
            let rate = dist::parse_params(parameters).get("rate").copied();
            let Some(rate) = rate.filter(|r| r.is_finite() && *r > 0.0) else {
                return Err(E::InvalidServiceRate(station.name.clone(), label));
            };
            if let Some((ref_class, ref_rate)) = &reference {
                if !rates_match(*ref_rate, rate) {
                    return Err(E::ClassDependentService(station.name.clone(), ref_class.clone(), *ref_rate, label, rate));
                }
            }
            if reference.is_none() {
                reference = Some((label, rate));
            }
        }
        let Some((_, service_rate)) = reference else {
            return Err(E::InvalidServiceRate(station.name.clone(), class_label(0)));
        };
        node_docs.push((station.servers, service_rate, capacities[index]));
    }

    // Per source (= class): where its Poisson arrivals enter.
    let mut external_by_class: Vec<BTreeMap<String, f64>> = vec![BTreeMap::new(); class_count];
    for (class_index, source) in sources.iter().enumerate() {
        let parameters = dist::parse_params(&source.parameters);
        let rate = match source.distribution {
            Distribution::Poisson => parameters.get("lambda").copied(),
            Distribution::Exponential => parameters.get("rate").copied(),
            other => return Err(E::UnsupportedArrival(source.name.clone(), other.display_name().into())),
        };
        let Some(rate) = rate.filter(|r| r.is_finite() && *r > 0.0) else {
            return Err(E::InvalidArrivalRate(source.name.clone()));
        };
        let outgoing: Vec<&Link> = net.links.iter().filter(|l| l.from == source.id).collect();
        if let Some(link) = outgoing.iter().find(|l| l.probability > 0.0 && l.class != class_index as i64) {
            return Err(E::SourceClassMismatch(source.name.clone(), class_label(class_index as i64), class_label(link.class)));
        }
        let total = outgoing.iter().fold(0.0, |s, l| s + l.probability);
        if !(total <= 1.0 + ROUTING_TOLERANCE) {
            return Err(E::RoutingExceedsOne(source.name.clone(), class_label(class_index as i64), total));
        }
        let normalization = if total > 1.0 { total } else { 1.0 };
        for link in outgoing.iter().filter(|l| l.probability > 0.0) {
            match ctx.resolve(&link.to, &source.name)? {
                Resolved::Exit => continue,
                Resolved::Station(d) => {
                    *external_by_class[class_index].entry(station_id(d)).or_insert(0.0) += rate * link.probability / normalization;
                }
            }
        }
        if external_by_class[class_index].is_empty() {
            return Err(E::UnresolvedSource(source.name.clone()));
        }
    }

    // Per class: the routing among stations, which must let every station reach an exit.
    let mut class_docs: Vec<Json> = Vec::new();
    let mut matrices: Vec<Vec<Vec<f64>>> = Vec::new();
    for class_index in 0..class_count {
        let mut matrix = vec![vec![0.0; stations.len()]; stations.len()];
        let mut rows: BTreeMap<String, Json> = BTreeMap::new();
        for (from_index, station) in stations.iter().enumerate() {
            let outgoing: Vec<&Link> = net.links.iter().filter(|l| l.from == station.id && l.class == class_index as i64).collect();
            let total = outgoing.iter().fold(0.0, |s, l| s + l.probability);
            if !(total <= 1.0 + ROUTING_TOLERANCE) {
                return Err(E::RoutingExceedsOne(station.name.clone(), class_label(class_index as i64), total));
            }
            let normalization = if total > 1.0 { total } else { 1.0 };
            let mut destinations: BTreeMap<String, f64> = BTreeMap::new();
            for link in outgoing.iter().filter(|l| l.probability > 0.0) {
                match ctx.resolve(&link.to, &station.name)? {
                    Resolved::Exit => continue,
                    Resolved::Station(d) => {
                        let p = link.probability / normalization;
                        matrix[from_index][d] += p;
                        *destinations.entry(station_id(d)).or_insert(0.0) += p;
                    }
                }
            }
            rows.insert(station_id(from_index), rates_json(&destinations));
        }
        if let Some(closed) = first_station_without_exit_path(&matrix) {
            return Err(E::ClosedRouting(class_label(class_index as i64), stations[closed].name.clone()));
        }
        let mut doc = BTreeMap::new();
        doc.insert("id".to_string(), Json::str(class_id(class_index)));
        doc.insert("external_arrival_rates".to_string(), rates_json(&external_by_class[class_index]));
        doc.insert("routing".to_string(), Json::Object(rows));
        class_docs.push(Json::Object(doc));
        matrices.push(matrix);
    }

    let mut total_traffic = vec![0.0; stations.len()];
    for class_index in 0..class_count {
        let external: Vec<f64> =
            (0..stations.len()).map(|i| external_by_class[class_index].get(&station_id(i)).copied().unwrap_or(0.0)).collect();
        match traffic_rates(&matrices[class_index], &external) {
            Ok(rates) => {
                for i in 0..stations.len() {
                    total_traffic[i] += rates[i];
                }
            }
            Err(e) => return Err(E::InvalidTrafficEquations(class_label(class_index as i64), e.detail())),
        }
    }
    if net.infinite_buffers {
        for i in 0..stations.len() {
            let capacity = node_docs[i].0 as f64 * node_docs[i].1;
            let load = total_traffic[i] / capacity;
            if !load.is_finite() {
                return Err(E::InvalidTrafficEquations(
                    "all classes".into(),
                    format!("the offered load at {} is not finite", stations[i].name),
                ));
            }
            if !(load < 1.0 - ROUTING_TOLERANCE) {
                return Err(E::UnstableStation(stations[i].name.clone(), load));
            }
        }
    }

    let nodes: Vec<Json> = node_docs
        .iter()
        .enumerate()
        .map(|(i, (servers, rate, capacity))| {
            let mut m = BTreeMap::new();
            m.insert("id".to_string(), Json::str(station_id(i)));
            m.insert("servers".to_string(), Json::int(*servers));
            m.insert("service_rate".to_string(), Json::num(*rate));
            m.insert("capacity".to_string(), capacity.map_or(Json::Null, Json::int));
            Json::Object(m)
        })
        .collect();
    let mut random = BTreeMap::new();
    random.insert("base_seed".to_string(), Json::Number(options.base_seed.to_string()));
    random.insert("stream".to_string(), Json::Number(options.stream.to_string()));
    let mut rare = BTreeMap::new();
    rare.insert("method".to_string(), Json::str("none"));
    let mut doc = BTreeMap::new();
    doc.insert("schema_version".to_string(), Json::int(1));
    doc.insert("process".to_string(), Json::str("open_markovian_queueing_network"));
    doc.insert("name".to_string(), Json::str(trimmed));
    doc.insert("nodes".to_string(), Json::Array(nodes));
    doc.insert("classes".to_string(), Json::Array(class_docs));
    doc.insert("initial_jobs".to_string(), Json::Object(BTreeMap::new()));
    doc.insert("random".to_string(), Json::Object(random));
    doc.insert("stopping".to_string(), stopping_json(&options.stopping));
    doc.insert("rare_event".to_string(), Json::Object(rare));
    Ok(json::to_pretty_unescaped_slashes(&Json::Object(doc)) + "\n")
}

/// One station of a regenerative document as the product-form and QBD adapters decode it again
/// (their private `StrictNode`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StrictNode {
    pub id: String,
    pub servers: i64,
    pub service_rate: f64,
}

/// One class of a regenerative document, decoded again (`StrictClass`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StrictClass {
    pub id: String,
    pub external_arrival_rates: BTreeMap<String, f64>,
    pub routing: BTreeMap<String, BTreeMap<String, f64>>,
}

/// The part of a regenerative document the adapters read (`StrictNetwork`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StrictNetwork {
    pub nodes: Vec<StrictNode>,
    pub classes: Vec<StrictClass>,
}

const DECODE_MISSING: &str = "The data couldn\u{2019}t be read because it is missing.";
const DECODE_FORMAT: &str = "The data couldn\u{2019}t be read because it isn\u{2019}t in the correct format.";

/// Reads a regenerative document back as 0.90.34's adapters did with `JSONDecoder`, in its key
/// order (nodes, then classes; each one's fields in declaration order). The error is
/// `DecodingError`'s `localizedDescription` as Foundation words it (measured on macOS 27.2): a
/// key that is absent or `null` is "missing", anything else wrong is "not in the correct format".
pub(crate) fn decode_strict(text: &str) -> Result<StrictNetwork, String> {
    let root = json::parse(text).map_err(|_| DECODE_FORMAT.to_string())?;
    let obj = root.as_object().ok_or(DECODE_FORMAT)?;
    fn field<'a>(m: &'a BTreeMap<String, Json>, k: &str) -> Result<&'a Json, String> {
        match m.get(k) {
            None | Some(Json::Null) => Err(DECODE_MISSING.into()),
            Some(v) => Ok(v),
        }
    }
    fn object(v: &Json) -> Result<&BTreeMap<String, Json>, String> {
        v.as_object().ok_or_else(|| DECODE_FORMAT.to_string())
    }
    fn double(v: &Json) -> Result<f64, String> {
        match v {
            Json::Null => Err(DECODE_MISSING.into()),
            _ => v.as_f64().ok_or_else(|| DECODE_FORMAT.to_string()),
        }
    }
    fn doubles(v: &Json) -> Result<BTreeMap<String, f64>, String> {
        object(v)?.iter().map(|(k, x)| Ok((k.clone(), double(x)?))).collect()
    }
    let mut nodes = Vec::new();
    for n in field(obj, "nodes")?.as_array().ok_or(DECODE_FORMAT)? {
        let m = object(n)?;
        nodes.push(StrictNode {
            id: field(m, "id")?.as_str().ok_or(DECODE_FORMAT)?.to_string(),
            servers: field(m, "servers")?.as_i64().ok_or(DECODE_FORMAT)?,
            service_rate: double(field(m, "service_rate")?)?,
        });
    }
    let mut classes = Vec::new();
    for c in field(obj, "classes")?.as_array().ok_or(DECODE_FORMAT)? {
        let m = object(c)?;
        let id = field(m, "id")?.as_str().ok_or(DECODE_FORMAT)?.to_string();
        let external_arrival_rates = doubles(field(m, "external_arrival_rates")?)?;
        let routing = object(field(m, "routing")?)?
            .iter()
            .map(|(k, row)| Ok((k.clone(), doubles(row)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        classes.push(StrictClass { id, external_arrival_rates, routing });
    }
    Ok(StrictNetwork { nodes, classes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use RegenerativeError as E;

    /// Each of the 32 sentences, word for word as 0.90.34's `errorDescription` wrote it. The
    /// networks that reach them are in tests/golden_export_markov_json_cases.rs, checked
    /// against the 0.90.34 binary; these pin the wording of all of them, including the three no
    /// network reaches (a shared buffer is always caught first as feeding two stations, and the
    /// encoder cannot fail).
    macro_rules! sentence {
        ($test:ident, $error:expr, $want:literal) => {
            #[test]
            fn $test() {
                assert_eq!($error.message(), $want);
            }
        };
    }

    sentence!(error_1_empty_name, E::EmptyName, "Enter a name for the regenerative simulation input.");
    sentence!(error_2_no_stations, E::NoStations, "The network has no service stations. Add at least one station before exporting.");
    sentence!(error_3_no_sources, E::NoSources, "The network has no external arrival source. Add at least one source before exporting.");
    sentence!(
        error_4_invalid_server_count,
        E::InvalidServerCount("S1".into(), -2),
        "S1 has -2 servers. Regenerative simulation requires at least one server at every station."
    );
    sentence!(
        error_5_missing_buffer,
        E::MissingBuffer("S1".into()),
        "S1 needs exactly one upstream buffer to define its finite total capacity."
    );
    sentence!(
        error_6_multiple_buffers,
        E::MultipleBuffers("S1".into()),
        "S1 has more than one upstream buffer. Use one buffer per station before exporting a finite network."
    );
    sentence!(
        error_7_shared_buffer,
        E::SharedBuffer("B1".into(), vec!["S1".into(), "S2".into()]),
        "B1 feeds more than one station (S1, S2). Give each finite station its own upstream buffer."
    );
    sentence!(
        error_8_invalid_buffer_size,
        E::InvalidBufferSize("B1".into(), -1),
        "B1 has waiting capacity -1. Finite regenerative simulation requires a nonnegative waiting capacity."
    );
    sentence!(
        error_9_capacity_overflow,
        E::CapacityOverflow("S1".into()),
        "S1's server count plus waiting capacity is too large to export. Reduce one of those values."
    );
    sentence!(
        error_10_unsupported_arrival,
        E::UnsupportedArrival("Src1".into(), "Deterministic".into()),
        "Src1 uses Deterministic arrivals. Regenerative simulation requires a Poisson process (Poisson or exponential inter-arrivals)."
    );
    sentence!(error_11_invalid_arrival_rate, E::InvalidArrivalRate("Src1".into()), "Src1 does not contain a positive finite arrival rate.");
    sentence!(
        error_12_unresolved_source,
        E::UnresolvedSource("Src1".into()),
        "Src1 does not send positive-rate arrivals to a service station. Connect it directly, or through a buffer, to one or more stations."
    );
    sentence!(
        error_13_source_class_mismatch,
        E::SourceClassMismatch("Src1".into(), "Class 1".into(), "Class 2".into()),
        "A route from Src1 is labelled Class 2, but that source creates Class 1. Change the route to preserve the source class."
    );
    sentence!(
        error_14_class_transition,
        E::ClassTransition("S1".into(), "B2".into(), "Class 1".into(), "Class 3".into()),
        "The route from S1 to B2 changes Class 1 to Class 3. Regenerative simulation currently requires class-preserving routing."
    );
    sentence!(
        error_15_unknown_class,
        E::UnknownClass("S1".into(), -1),
        "A route from S1 uses class 0, but there is no matching external source. Add the source or change the route class."
    );
    sentence!(
        error_16_unsupported_service,
        E::UnsupportedService("S1".into(), "Class 2".into(), "Gamma".into()),
        "S1, Class 2 uses Gamma service. Regenerative simulation requires exponential FCFS service."
    );
    sentence!(
        error_17_invalid_service_rate,
        E::InvalidServiceRate("S1".into(), "Class 1".into()),
        "S1, Class 1 does not contain a positive finite exponential service rate."
    );
    sentence!(
        error_18_class_dependent_service,
        E::ClassDependentService("S1".into(), "Class 1".into(), 1.0 / 3.0, "Class 2".into(), 1e-9),
        "S1 has class-dependent service rates: Class 1 uses 0.3333333 and Class 2 uses 1e-09. Set one common exponential rate for every class at that station."
    );
    sentence!(
        error_19_invalid_routing_probability,
        E::InvalidRoutingProbability("S1".into(), f64::NAN),
        "A route from S1 has probability nan. Routing probabilities must be finite and between 0 and 1."
    );
    sentence!(
        error_20_routing_exceeds_one,
        E::RoutingExceedsOne("S1".into(), "Class 1".into(), 1.0000001234),
        "Routing probabilities from S1 for Class 1 total 1, above 1. Reduce the outgoing probabilities so their sum is at most 1."
    );
    sentence!(
        error_21_missing_origin,
        E::MissingOrigin,
        "A route starts at a node that is no longer in the document. Delete that route and reconnect the remaining nodes."
    );
    sentence!(
        error_22_missing_destination,
        E::MissingDestination("S1".into()),
        "A route from S1 points to a node that is no longer in the document. Delete or reconnect that route."
    );
    sentence!(
        error_23_unsupported_destination,
        E::UnsupportedDestination("S1".into(), "Src1".into()),
        "A route from S1 points to source Src1. Routes may lead only to a station, an upstream buffer, or an exit sink."
    );
    sentence!(
        error_24_buffer_without_station,
        E::BufferWithoutStation("B1".into()),
        "B1 is used as a route destination but does not feed a service station. Connect it to exactly one station."
    );
    sentence!(
        error_25_buffer_with_multiple_stations,
        E::BufferWithMultipleStations("B1".into(), vec!["S1".into(), "S2".into()]),
        "B1 is used as a route destination but feeds multiple stations (S1, S2). Split it into one buffer per station."
    );
    sentence!(
        error_26_buffer_with_unsupported_destination,
        E::BufferWithUnsupportedDestination("B1".into(), "Sink1".into()),
        "B1 has a positive outgoing route to Sink1. An upstream buffer must feed exactly one service station and have no other positive outgoing routes."
    );
    sentence!(
        error_27_buffer_connection_probability,
        E::BufferConnectionProbability("B1".into(), "S1".into(), 0.999),
        "The structural route from B1 to S1 has probability 0.999. Set it to 1 so every waiting job enters that station."
    );
    sentence!(
        error_28_closed_routing,
        E::ClosedRouting("Class 1".into(), "S2".into()),
        "Class 1 cannot reach an exit from S2. Lower at least one routing row sum below 1 or add a positive-probability path to a sink."
    );
    sentence!(
        error_29_invalid_traffic_equations,
        E::InvalidTrafficEquations("Class 1".into(), TrafficEquationError::IllConditioned(1.5e-10, 2e-11).detail()),
        "The traffic equations for Class 1 could not be solved reliably (residual 1.5e-10 exceeds tolerance 2e-11). Add exit probability or move the routing probabilities farther from a closed loop."
    );
    sentence!(
        error_30_unstable_station,
        E::UnstableStation("S1".into(), f64::INFINITY),
        "S1 has infinite-buffer offered load inf, but regenerative steady state requires load below 1. Reduce arrivals/routing or add service capacity."
    );
    sentence!(
        error_31_invalid_stopping,
        E::InvalidStopping("checkEveryCycles must be positive.".into()),
        "The regenerative stopping settings are invalid: checkEveryCycles must be positive."
    );
    sentence!(
        error_32_encoding,
        E::Encoding("UTF-8 conversion failed.".into()),
        "The regenerative simulation input could not be encoded: UTF-8 conversion failed."
    );

    #[test]
    fn the_traffic_equation_details_are_0_90_34_s() {
        assert_eq!(TrafficEquationError::Singular.detail(), "the routing matrix is closed or numerically singular");
        assert_eq!(TrafficEquationError::NegativeRate.detail(), "the solution contains a negative arrival rate");
        assert_eq!(TrafficEquationError::Nonfinite.detail(), "the numerical solution is not finite");
    }

    #[test]
    fn a_negative_solution_is_a_negative_rate() {
        // No network has a negative routing entry; the check is the solver's own.
        assert!(matches!(traffic_rates(&[vec![-0.5]], &[-1.0]), Err(TrafficEquationError::NegativeRate)));
    }

    #[test]
    fn a_feedback_loop_is_solved_exactly() {
        let rates = traffic_rates(&[vec![0.0, 1.0], vec![0.5, 0.0]], &[1.0, 0.0]).ok().unwrap();
        assert_eq!(rates, vec![2.0, 2.0]);
    }

    /// A one-station network every check accepts, for driving the stopping checks.
    fn mm1() -> Network {
        let mut src = Node::new("A", NodeKind::Source, "Src1", (0.0, 0.0));
        src.distribution = Distribution::Poisson;
        src.parameters = "lambda=0.5".into();
        let st = Node::new("B", NodeKind::Station, "S1", (0.0, 0.0));
        let sink = Node::new("C", NodeKind::Sink, "Sink1", (0.0, 0.0));
        let link = |id: &str, from: &str, to: &str| Link {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            probability: 1.0,
            class: 0,
            to_class: None,
        };
        Network {
            nodes: vec![src, st, sink],
            links: vec![link("L1", "A", "B"), link("L2", "B", "C")],
            infinite_buffers: true,
            canvas_scale: 1.0,
            canvas_pan_offset: (0.0, 0.0),
            population: None,
        }
    }

    fn stopping_refusal(change: impl FnOnce(&mut StoppingOptions)) -> String {
        let mut options = Options::default();
        change(&mut options.stopping);
        export(&mm1(), "net", &options).unwrap_err().message()
    }

    macro_rules! stopping {
        ($test:ident, |$o:ident| $change:expr, $want:literal) => {
            #[test]
            fn $test() {
                assert_eq!(stopping_refusal(|$o| $change), concat!("The regenerative stopping settings are invalid: ", $want));
            }
        };
    }

    stopping!(a_confidence_of_one_half_is_refused, |o| o.confidence = 0.5, "confidence must be finite and strictly between 0.5 and 1.");
    stopping!(a_confidence_of_one_is_refused, |o| o.confidence = 1.0, "confidence must be finite and strictly between 0.5 and 1.");
    stopping!(
        two_zero_half_widths_are_refused,
        |o| {
            o.absolute_half_width = 0.0;
            o.relative_half_width = 0.0
        },
        "half-width targets must be nonnegative and at least one must be positive."
    );
    stopping!(
        a_negative_half_width_is_refused,
        |o| o.relative_half_width = -0.1,
        "half-width targets must be nonnegative and at least one must be positive."
    );
    stopping!(
        fewer_than_30_minimum_cycles_are_refused,
        |o| o.minimum_cycles = 29,
        "minimumCycles must be at least 30 for the regenerative t interval."
    );
    stopping!(
        more_effective_than_minimum_cycles_are_refused,
        |o| o.minimum_effective_cycles = 200.5,
        "minimumEffectiveCycles must be positive and no greater than minimumCycles."
    );
    stopping!(zero_positive_cycles_are_refused, |o| o.minimum_positive_cycles = 0, "minimumPositiveCycles must be positive.");
    stopping!(checking_every_zero_cycles_is_refused, |o| o.check_every_cycles = 0, "checkEveryCycles must be positive.");
    stopping!(
        fewer_maximum_than_minimum_cycles_are_refused,
        |o| o.maximum_cycles = 199,
        "maximumCycles cannot be less than minimumCycles."
    );
    stopping!(zero_maximum_events_are_refused, |o| o.maximum_events = 0, "maximumEvents must be positive.");
    stopping!(
        an_infinite_simulated_time_is_refused,
        |o| o.maximum_simulated_time = f64::INFINITY,
        "maximumSimulatedTime must be positive and finite."
    );
    stopping!(a_zero_cycle_time_is_refused, |o| o.maximum_cycle_time = 0.0, "maximumCycleTime must be positive and finite.");
    stopping!(zero_events_per_cycle_are_refused, |o| o.maximum_events_per_cycle = 0, "maximumEventsPerCycle must be positive.");
    stopping!(a_nan_wall_time_is_refused, |o| o.maximum_wall_seconds = f64::NAN, "maximumWallSeconds must be positive and finite.");

    #[test]
    fn the_stopping_checks_come_after_the_name_and_before_the_network() {
        let mut options = Options::default();
        options.stopping.confidence = 2.0;
        assert_eq!(export(&mm1(), " ", &options).unwrap_err(), E::EmptyName);
        let empty = Network { nodes: vec![], links: vec![], infinite_buffers: true, canvas_scale: 1.0, canvas_pan_offset: (0.0, 0.0), population: None };
        assert!(matches!(export(&empty, "net", &options).unwrap_err(), E::InvalidStopping(_)));
    }

    #[test]
    fn the_defaults_are_0_90_34_s() {
        let o = Options::default();
        assert_eq!((o.base_seed, o.stream), (20_260_904, 0));
        let s = o.stopping;
        assert_eq!((s.confidence, s.absolute_half_width, s.relative_half_width), (0.95, 0.02, 0.05));
        assert_eq!((s.minimum_cycles, s.minimum_effective_cycles, s.minimum_positive_cycles, s.check_every_cycles), (200, 30.0, 5, 50));
        assert_eq!((s.maximum_cycles, s.maximum_events, s.maximum_events_per_cycle), (100_000, 10_000_000, 2_000_000));
        assert_eq!((s.maximum_simulated_time, s.maximum_cycle_time, s.maximum_wall_seconds), (1e9, 1e7, 120.0));
    }

    #[test]
    fn the_run_sheet_s_values_become_the_stopping_rule_as_in_0_90_34() {
        let (c, a, r, min, max, wall) = SHEET_DEFAULTS;
        let s = StoppingOptions::monte_carlo_sheet(c, a, r, min, max, wall);
        assert_eq!((s.confidence, s.absolute_half_width, s.relative_half_width), (0.95, 0.05, 0.10));
        assert_eq!((s.minimum_cycles, s.minimum_effective_cycles, s.check_every_cycles, s.maximum_cycles), (500, 30.0, 100, 20_000));
        assert_eq!((s.minimum_positive_cycles, s.maximum_wall_seconds), (5, 30.0));
        assert_eq!(
            (s.maximum_events, s.maximum_simulated_time, s.maximum_cycle_time, s.maximum_events_per_cycle),
            (10_000_000, 1e9, 1e7, 2_000_000)
        );
        let clamped = StoppingOptions::monte_carlo_sheet(0.9, 0.0, 0.2, 10, 5, 0);
        assert_eq!((clamped.minimum_cycles, clamped.maximum_cycles, clamped.maximum_wall_seconds), (30, 30, 1.0));
        assert_eq!((clamped.minimum_effective_cycles, clamped.check_every_cycles), (30.0, 30));
    }

    #[test]
    fn the_run_sheet_s_stopping_rule_is_written_into_the_document() {
        let options = Options { base_seed: 1, stream: 2, stopping: StoppingOptions::monte_carlo_sheet(0.9, 0.05, 0.1, 500, 20_000, 30) };
        let text = export(&mm1(), "net", &options).unwrap();
        let stopping = &text[text.find("\"stopping\"").unwrap()..];
        assert_eq!(
            stopping,
            r#""stopping" : {
    "absolute_half_width" : 0.05,
    "check_every_cycles" : 100,
    "confidence" : 0.9,
    "maximum_cycle_time" : 10000000,
    "maximum_cycles" : 20000,
    "maximum_events" : 10000000,
    "maximum_events_per_cycle" : 2000000,
    "maximum_simulated_time" : 1000000000,
    "maximum_wall_seconds" : 30,
    "minimum_cycles" : 500,
    "minimum_effective_cycles" : 30,
    "minimum_positive_cycles" : 5,
    "monitored_metrics" : [
      "mean_number_in_system"
    ],
    "relative_half_width" : 0.1
  }
}
"#
        );
        assert!(text.contains("\"base_seed\" : 1,\n    \"stream\" : 2\n"));
    }

    #[test]
    fn a_name_with_a_slash_keeps_it_unescaped() {
        let text = export(&mm1(), "M/M/1", &Options::default()).unwrap();
        assert!(text.contains("\"name\" : \"M/M/1\","), "{text}");
    }

    #[test]
    fn rates_within_the_relative_tolerance_are_one_rate() {
        assert!(rates_match(1e6, 1e6 + 1e-5));
        assert!(!rates_match(1e6, 1e6 + 1e-3));
        assert!(rates_match(0.5, 0.5 + 1e-11));
    }

    #[test]
    fn the_decoder_words_its_failures_as_foundation_does() {
        assert_eq!(decode_strict("{}").unwrap_err(), "The data couldn\u{2019}t be read because it is missing.");
        assert_eq!(
            decode_strict(r#"{"nodes":[{"id":"s1","servers":1.5,"service_rate":1}],"classes":[]}"#).unwrap_err(),
            "The data couldn\u{2019}t be read because it isn\u{2019}t in the correct format."
        );
        assert_eq!(decode_strict("[").unwrap_err(), "The data couldn\u{2019}t be read because it isn\u{2019}t in the correct format.");
        let text = export(&mm1(), "net", &Options::default()).unwrap();
        let strict = decode_strict(&text).unwrap();
        assert_eq!(strict.nodes, vec![StrictNode { id: "s1".into(), servers: 1, service_rate: 1.0 }]);
        assert_eq!(strict.classes[0].external_arrival_rates, BTreeMap::from([("s1".to_string(), 0.5)]));
    }
}
