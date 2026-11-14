//! The traffic equations and the station-level SRBM primitives (0.90.34 `SRBMExporter.computeData`).
//!
//! From the drawn network this works out each class's arrival rate at each station, the per-class
//! throughputs α (by solving α = λ + Pᵀα), the throughput-weighted service rate and SCV of each
//! station, the aggregated routing matrix, the capacities, and from those the SRBM's drift θ,
//! covariance Γ and reflection matrix R (d × 2d, columns interleaved lower, upper face). Utilisation
//! badges, `--dump-rho`, Analyze, Primitives and the finite-buffer exporters all start here.
//!
//! The loops are 0.90.34's, in its order, so every number comes out bit for bit the same: the
//! corpus compares the printed digits of each one (tests/golden_rho.rs).

use std::collections::{HashMap, HashSet, VecDeque};

use crate::cfmt;
use crate::dist::parse_params_numeric_last;
use crate::model::{Distribution, Link, Node, NodeKind};
use crate::naming;

/// Why a network can't be turned into a station model (0.90.34 `NetworkExportError`).
#[derive(Clone, Debug, PartialEq)]
pub enum NetworkError {
    NoStations,
    NoSource,
    NoSink,
    StationMissingBuffer(String),
    StationMultipleBuffers(String),
    /// Station, the row sum, the class index.
    RoutingExceedsOne(String, f64, i64),
    /// Station, class index: a closed cycle makes the throughput unbounded.
    TrafficSingular(String, i64),
    SourceNotConnectedToStation1,
    SourceUnresolvedEntry(String),
}

/// "Class 1" for class index 0 (`CustomerClass.label`).
pub fn class_label(index: i64) -> String {
    format!("Class {}", index + 1)
}

impl NetworkError {
    /// The sentence 0.90.34 showed.
    pub fn message(&self) -> String {
        match self {
            NetworkError::NoStations => "The network has no stations.".into(),
            NetworkError::NoSource => "The network has no source node.".into(),
            NetworkError::NoSink => "The network has no sink node.".into(),
            NetworkError::StationMissingBuffer(n) => format!("Station {n} has no buffer feeding into it."),
            NetworkError::StationMultipleBuffers(n) => format!("Station {n} has more than one buffer feeding into it."),
            NetworkError::RoutingExceedsOne(n, sum, k) => {
                format!("Routing probabilities from {n} for {} sum to {}, which exceeds 1.0.", class_label(*k), cfmt::f("%.4f", *sum))
            }
            NetworkError::TrafficSingular(n, k) => format!(
                "Routing for {} returns every job that reaches {n} to {n}, so its throughput is unbounded and no arrival rate can be computed. Lower a routing probability on that cycle, or send part of it to a sink.",
                class_label(*k)
            ),
            NetworkError::SourceNotConnectedToStation1 => "The source must connect (possibly via a buffer) to station S1.".into(),
            NetworkError::SourceUnresolvedEntry(n) => format!("Source {n} is not connected to a station (directly or via a buffer)."),
        }
    }
}

/// Why the SRBM primitives can't be computed (0.90.34 `SRBMExportError`).
#[derive(Clone, Debug, PartialEq)]
pub enum SrbmError {
    Network(NetworkError),
    InfiniteMean(String),
    InfiniteVariance(String),
    DegenerateCovariance,
}

impl SrbmError {
    pub fn message(&self) -> String {
        match self {
            SrbmError::Network(e) => e.message(),
            SrbmError::InfiniteMean(n) => format!("{n} has a distribution with infinite mean (e.g. Pareto with shape <= 1)."),
            SrbmError::InfiniteVariance(n) => format!("{n} has a distribution with infinite variance (e.g. Pareto with shape <= 2)."),
            SrbmError::DegenerateCovariance => {
                "The covariance matrix is zero (all distributions are constant with deterministic routing). SRBM requires randomness.".into()
            }
        }
    }
}

impl std::fmt::Display for SrbmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// The station model, indexed by station in export order (0.90.34 `SRBMData`).
#[derive(Clone, Debug, PartialEq)]
pub struct SrbmData {
    pub d: usize,
    /// Customer classes: the larger of the number of sources and the highest class a link names, plus one.
    pub k: usize,
    pub drift: Vec<f64>,
    pub gamma: Vec<Vec<f64>>,
    /// d × 2d, columns [lower₀, upper₀, lower₁, upper₁, …].
    pub r: Vec<Vec<f64>>,
    /// The box's sides: buffer size plus servers.
    pub a_vec: Vec<f64>,
    /// Effective per-server service rate μ_eff.
    pub service_rates: Vec<f64>,
    pub servers: Vec<i64>,
    /// Total throughput α_i.
    pub alpha: Vec<f64>,
    /// α[k][i].
    pub alpha_per_class: Vec<Vec<f64>>,
    pub aggregated_p: Vec<Vec<f64>>,
    /// c_i = servers × μ_eff.
    pub capacity: Vec<f64>,
    /// λ_k, summed over stations.
    pub class_external_arrivals: Vec<f64>,
    /// λ[k][i].
    pub class_external_arrival_rates: Vec<Vec<f64>>,
    /// μ[k][i].
    pub class_service_rates: Vec<Vec<f64>>,
    pub arrival_scvs: Vec<f64>,
    pub effective_service_scvs: Vec<f64>,
}

impl SrbmData {
    /// ρ_i = α_i / c_i, NaN when the capacity is (nearly) zero, as `--dump-rho` computes it.
    pub fn rho(&self, i: usize) -> f64 {
        if self.capacity[i] > 1e-12 {
            self.alpha[i] / self.capacity[i]
        } else {
            f64::NAN
        }
    }
}

/// Swift's `max`: `y >= x ? y : x` (Rust's `f64::max` treats NaN differently).
fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

fn swift_min(x: f64, y: f64) -> f64 {
    if y < x {
        y
    } else {
        x
    }
}

/// A family's rate, 1/mean, filling missing parameters with its defaults (`extractRate`). A
/// Poisson source's rate is λ.
pub fn rate(d: Distribution, parameters: &str) -> f64 {
    let p = parse_params_numeric_last(parameters);
    let g = |k: &str, default: f64| p.get(k).copied().unwrap_or(default);
    match d {
        Distribution::Exponential => g("rate", 1.0),
        Distribution::Gamma => 1.0 / (g("shape", 2.0) * g("scale", 1.0)),
        Distribution::Uniform => 2.0 / (g("min", 0.5) + g("max", 1.5)),
        Distribution::Constant => {
            let v = g("value", 1.0);
            if v > 0.0 {
                1.0 / v
            } else {
                0.0
            }
        }
        Distribution::Weibull => 1.0 / (g("scale", 1.0) * cfmt::tgamma(1.0 + 1.0 / g("shape", 1.5))),
        Distribution::Erlang => g("rate", 1.0) / g("k", 2.0),
        Distribution::Lognormal => {
            let (mu, sigma) = (g("mu", 0.0), g("sigma", 0.25));
            1.0 / (mu + sigma * sigma / 2.0).exp()
        }
        Distribution::Pareto => {
            let (a, xm) = (g("shape", 2.5), g("scale", 1.0));
            if a <= 1.0 {
                0.0
            } else {
                (a - 1.0) / (a * xm)
            }
        }
        Distribution::Poisson => g("lambda", 1.0),
    }
}

/// A family's SCV, filling missing parameters with its defaults; infinite for Pareto at α ≤ 2
/// (`extractSCV`).
pub fn scv(d: Distribution, parameters: &str) -> f64 {
    let p = parse_params_numeric_last(parameters);
    let g = |k: &str, default: f64| p.get(k).copied().unwrap_or(default);
    match d {
        Distribution::Exponential | Distribution::Poisson => 1.0,
        Distribution::Gamma => 1.0 / g("shape", 2.0),
        Distribution::Uniform => {
            let (a, b) = (g("min", 0.5), g("max", 1.5));
            let (diff, sum) = (b - a, a + b);
            (diff * diff) / (3.0 * sum * sum)
        }
        Distribution::Constant => 0.0,
        Distribution::Weibull => {
            let k = g("shape", 1.5);
            let g1 = cfmt::tgamma(1.0 + 1.0 / k);
            let g2 = cfmt::tgamma(1.0 + 2.0 / k);
            (g2 - g1 * g1) / (g1 * g1)
        }
        Distribution::Erlang => 1.0 / g("k", 2.0),
        Distribution::Lognormal => {
            let s = g("sigma", 0.25);
            (s * s).exp() - 1.0
        }
        Distribution::Pareto => {
            let a = g("shape", 2.5);
            if a <= 2.0 {
                f64::INFINITY
            } else {
                1.0 / (a * (a - 2.0))
            }
        }
    }
}

/// A station's per-server rate for one class: its per-class law if it has one, else its own.
pub fn service_rate_for_class(station: &Node, class: usize) -> f64 {
    match station.service_by_class.get(&(class as i64)) {
        Some(c) => rate(c.distribution, &c.parameters),
        None => rate(station.distribution, &station.parameters),
    }
}

pub fn service_scv_for_class(station: &Node, class: usize) -> f64 {
    match station.service_by_class.get(&(class as i64)) {
        Some(c) => scv(c.distribution, &c.parameters),
        None => scv(station.distribution, &station.parameters),
    }
}

/// The nodes and links, with the lookups the computation needs.
struct Graph<'a> {
    nodes: &'a [Node],
    links: &'a [Link],
    station_index: HashMap<&'a str, usize>,
}

impl Graph<'_> {
    /// The station a link into `node_id` delivers to: the node itself if it's a station; for a
    /// buffer, the target of its first link (in document order) that ends at a station.
    fn resolve_target_station(&self, node_id: &str) -> Option<usize> {
        let node = self.nodes.iter().find(|n| n.id == node_id)?;
        match node.kind {
            NodeKind::Station => self.station_index.get(node.id.as_str()).copied(),
            NodeKind::Buffer => {
                for link in self.links.iter().filter(|l| l.from == node.id) {
                    if let Some(target) = self.nodes.iter().find(|n| n.id == link.to) {
                        if target.kind == NodeKind::Station {
                            return self.station_index.get(target.id.as_str()).copied();
                        }
                    }
                }
                None
            }
            _ => None,
        }
    }
}

/// Breadth-first search along links from `start` (`pathExists`).
pub fn path_exists(start: &str, end: &str, links: &[Link]) -> bool {
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::from([start.to_string()]);
    while let Some(current) = queue.pop_front() {
        if current == end {
            return true;
        }
        if !visited.insert(current.clone()) {
            continue;
        }
        for link in links.iter().filter(|l| l.from == current) {
            queue.push_back(link.to.clone());
        }
    }
    false
}

/// Solves α = λ + Pᵀα by Gaussian elimination with partial pivoting (`solveTrafficEquations`).
/// Returns the solution and the smallest variable left undetermined, when there is one.
pub fn solve_traffic_equations(p: &[Vec<f64>], rhs_in: &[f64], d: usize) -> (Vec<f64>, Option<usize>) {
    let mut a = vec![vec![0.0; d]; d];
    for i in 0..d {
        for j in 0..d {
            a[i][j] = (if i == j { 1.0 } else { 0.0 }) - p[j][i];
        }
    }
    let mut rhs = rhs_in.to_vec();
    for col in 0..d {
        let mut max_val = a[col][col].abs();
        let mut max_row = col;
        for row in (col + 1)..d {
            if a[row][col].abs() > max_val {
                max_val = a[row][col].abs();
                max_row = row;
            }
        }
        if max_row != col {
            a.swap(col, max_row);
            rhs.swap(col, max_row);
        }
        let pivot = a[col][col];
        if pivot.abs() < 1e-15 {
            continue;
        }
        for row in (col + 1)..d {
            let factor = a[row][col] / pivot;
            for j in col..d {
                a[row][j] -= factor * a[col][j];
            }
            rhs[row] -= factor * rhs[col];
        }
    }
    let mut x = vec![0.0; d];
    let mut singular = None;
    for i in (0..d).rev() {
        x[i] = rhs[i];
        for j in (i + 1)..d {
            x[i] -= a[i][j] * x[j];
        }
        if a[i][i].abs() > 1e-15 {
            x[i] /= a[i][i];
        } else {
            singular = Some(i);
        }
    }
    (x, singular)
}

/// M/M/1/K blocking probability, K the whole system's capacity (`mm1kBlockingProb`).
fn mm1k_blocking(rho: f64, k: i64) -> f64 {
    if !(k >= 1 && rho > 0.0) {
        return 0.0;
    }
    if (rho - 1.0).abs() < 1e-9 {
        return 1.0 / (k + 1) as f64;
    }
    let r_pow_k = rho.powf(k as f64);
    let r_pow_k1 = r_pow_k * rho;
    let denom = 1.0 - r_pow_k1;
    // Swift's `guard abs(denom) > 1e-15 else`: a NaN takes the fallback too.
    if !(denom.abs() > 1e-15) {
        return r_pow_k / (r_pow_k + 1.0);
    }
    let p = r_pow_k * (1.0 - rho) / denom;
    swift_min(swift_max(p, 0.0), 1.0)
}

/// Σ = A + (I − Pᵀ) diag(B) (I − P) + Σ_routing (`computeCovariance`), with r the throughput
/// (infinite buffers) or the capacity (finite).
fn covariance(p: &[Vec<f64>], lambda_ext: &[Vec<f64>], arrival_scvs: &[f64], rates: &[f64], service_scvs: &[f64], d: usize) -> Vec<Vec<f64>> {
    let mut m = vec![vec![0.0; d]; d];
    for i in 0..d {
        for j in 0..d {
            m[i][j] = (if i == j { 1.0 } else { 0.0 }) - p[j][i];
        }
    }
    let b: Vec<f64> = (0..d).map(|k| rates[k] * service_scvs[k]).collect();
    let mut mb = vec![vec![0.0; d]; d];
    for i in 0..d {
        for j in 0..d {
            mb[i][j] = m[i][j] * b[j];
        }
    }
    let mut term1 = vec![vec![0.0; d]; d];
    for i in 0..d {
        for j in 0..d {
            let mut sum = 0.0;
            for k in 0..d {
                sum += mb[i][k] * m[j][k];
            }
            term1[i][j] = sum;
        }
    }
    let mut routing = vec![vec![0.0; d]; d];
    for k in 0..d {
        for i in 0..d {
            if p[k][i] == 0.0 {
                continue;
            }
            for j in 0..d {
                routing[i][j] += rates[k] * p[k][i] * ((if i == j { 1.0 } else { 0.0 }) - p[k][j]);
            }
        }
    }
    let mut result = vec![vec![0.0; d]; d];
    for i in 0..d {
        for k in 0..arrival_scvs.len() {
            result[i][i] += lambda_ext[k][i] * arrival_scvs[k];
        }
    }
    for i in 0..d {
        for j in 0..d {
            result[i][j] += term1[i][j] + routing[i][j];
        }
    }
    result
}

/// The d × 2d reflection matrix, interleaved (`computeReflectionMatrix`): infinite buffers reflect
/// along (I − Pᵀ) at the lower face and −e_k at the (numerical) upper wall; finite buffers along
/// e_k at the lower face and −e_k + Σ_i P_ik e_i at the upper (manufacturing blocking).
fn reflection(p: &[Vec<f64>], d: usize, infinite: bool) -> Vec<Vec<f64>> {
    let mut r = vec![vec![0.0; 2 * d]; d];
    for k in 0..d {
        let (lo, hi) = (2 * k, 2 * k + 1);
        if infinite {
            for i in 0..d {
                r[i][lo] = (if i == k { 1.0 } else { 0.0 }) - p[k][i];
            }
            r[k][hi] = -1.0;
        } else {
            r[k][lo] = 1.0;
            for i in 0..d {
                r[i][hi] = (if i == k { -1.0 } else { 0.0 }) + p[i][k];
            }
        }
    }
    r
}

/// The station model of a network (`computeData`). `loss` and `bas` apply 0.90.34's optional
/// finite-buffer corrections (Run Comparison's loss and BAS regimes); they're ignored for infinite
/// buffers, and `bas` is ignored when `loss` is set.
pub fn compute(nodes: &[Node], links: &[Link], infinite: bool, loss: bool, bas: bool) -> Result<SrbmData, SrbmError> {
    let net_err = |e| Err(SrbmError::Network(e));
    let sources = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Source), |n| &n.name);
    let sinks = nodes.iter().filter(|n| n.kind == NodeKind::Sink).count();
    let stations = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);
    if stations.is_empty() {
        return net_err(NetworkError::NoStations);
    }
    if sources.is_empty() {
        return net_err(NetworkError::NoSource);
    }
    if sinks == 0 {
        return net_err(NetworkError::NoSink);
    }

    let max_link_class = links.iter().fold(-1i64, |acc, l| acc.max(l.class).max(l.to_class.unwrap_or(-1)));
    let k_classes = (sources.len() as i64).max(max_link_class + 1) as usize;
    let d = stations.len();

    let mut buffer_sizes = Vec::with_capacity(d);
    for station in &stations {
        let feeding: Vec<&Node> = nodes
            .iter()
            .filter(|c| c.kind == NodeKind::Buffer && links.iter().any(|l| l.from == c.id && l.to == station.id))
            .collect();
        if feeding.is_empty() {
            return net_err(NetworkError::StationMissingBuffer(station.name.clone()));
        }
        if feeding.len() != 1 {
            return net_err(NetworkError::StationMultipleBuffers(station.name.clone()));
        }
        buffer_sizes.push(feeding[0].buffer_size);
    }

    if !path_exists(&sources[0].id, &stations[0].id, links) {
        return net_err(NetworkError::SourceNotConnectedToStation1);
    }

    let graph = Graph { nodes, links, station_index: stations.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect() };

    // External arrivals per class and station.
    let mut lambda_ext = vec![vec![0.0; d]; k_classes];
    let mut arrival_scvs = vec![1.0; k_classes];
    for (k, source) in sources.iter().enumerate() {
        let r = rate(source.distribution, &source.parameters);
        if r <= 0.0 {
            return Err(SrbmError::InfiniteMean(source.name.clone()));
        }
        let c = scv(source.distribution, &source.parameters);
        if c.is_infinite() {
            return Err(SrbmError::InfiniteVariance(source.name.clone()));
        }
        arrival_scvs[k] = c;
        for link in links.iter().filter(|l| l.from == source.id) {
            if let Some(i) = graph.resolve_target_station(&link.to) {
                lambda_ext[k][i] += r * link.probability;
            }
        }
    }

    // Per-class routing between stations.
    let mut p_class = Vec::with_capacity(k_classes);
    for class in 0..k_classes {
        let mut matrix = vec![vec![0.0; d]; d];
        for (i, station) in stations.iter().enumerate() {
            for link in links.iter().filter(|l| l.from == station.id && l.class == class as i64) {
                if let Some(t) = graph.resolve_target_station(&link.to) {
                    matrix[i][t] += link.probability;
                }
            }
            let row_sum: f64 = matrix[i].iter().fold(0.0, |a, b| a + b);
            if row_sum > 1.0 + 1e-9 {
                return net_err(NetworkError::RoutingExceedsOne(station.name.clone(), row_sum, class as i64));
            }
        }
        p_class.push(matrix);
    }

    // Traffic equations: per class when no link changes class, else on the (class, station) pairs.
    let mut alpha_per_class = vec![vec![0.0; d]; k_classes];
    let has_transitions = links.iter().any(|l| l.has_class_transition());
    if !has_transitions {
        for k in 0..k_classes {
            let (alpha, singular) = solve_traffic_equations(&p_class[k], &lambda_ext[k], d);
            if let Some(bad) = singular {
                return net_err(NetworkError::TrafficSingular(stations[bad].name.clone(), k as i64));
            }
            alpha_per_class[k] = alpha;
        }
    } else {
        let n = k_classes * d;
        let mut p_ex = vec![vec![0.0; n]; n];
        for (i, station) in stations.iter().enumerate() {
            for link in links.iter().filter(|l| l.from == station.id) {
                let Some(t) = graph.resolve_target_station(&link.to) else { continue };
                let from_class = link.class;
                let to_class = link.to_class.unwrap_or(link.class);
                if !(from_class >= 0 && (from_class as usize) < k_classes && to_class >= 0 && (to_class as usize) < k_classes) {
                    continue;
                }
                p_ex[from_class as usize * d + i][to_class as usize * d + t] += link.probability;
            }
        }
        let mut lambda_ex = vec![0.0; n];
        for k in 0..k_classes {
            for i in 0..d {
                lambda_ex[k * d + i] = lambda_ext[k][i];
            }
        }
        let (alpha_ex, singular) = solve_traffic_equations(&p_ex, &lambda_ex, n);
        if let Some(bad) = singular {
            return net_err(NetworkError::TrafficSingular(stations[bad % d].name.clone(), (bad / d) as i64));
        }
        for k in 0..k_classes {
            for i in 0..d {
                alpha_per_class[k][i] = alpha_ex[k * d + i];
            }
        }
    }

    let mut alpha = vec![0.0; d];
    for i in 0..d {
        for k in 0..k_classes {
            alpha[i] += alpha_per_class[k][i];
        }
    }
    let servers: Vec<i64> = stations.iter().map(|s| s.servers).collect();

    // Throughput-weighted service: harmonic mean of the classes' rates, and the mixture's SCV.
    let mut mu_eff = vec![0.0; d];
    let mut scv_eff = vec![0.0; d];
    for (i, station) in stations.iter().enumerate() {
        if alpha[i] > 1e-15 {
            let (mut m1, mut m2) = (0.0, 0.0);
            for k in 0..k_classes {
                let weight = alpha_per_class[k][i] / alpha[i];
                let mu_ik = service_rate_for_class(station, k);
                let scv_ik = service_scv_for_class(station, k);
                if !(mu_ik > 0.0) {
                    return Err(SrbmError::InfiniteMean(station.name.clone()));
                }
                let mean_svc = 1.0 / mu_ik;
                m1 += weight * mean_svc;
                m2 += weight * (1.0 + scv_ik) * mean_svc * mean_svc;
            }
            if !(m1 > 0.0) {
                return Err(SrbmError::InfiniteMean(station.name.clone()));
            }
            mu_eff[i] = 1.0 / m1;
            scv_eff[i] = swift_max(0.0, (m2 - m1 * m1) / (m1 * m1));
        } else {
            mu_eff[i] = service_rate_for_class(station, 0);
            scv_eff[i] = service_scv_for_class(station, 0);
        }
        if mu_eff[i] <= 0.0 {
            return Err(SrbmError::InfiniteMean(station.name.clone()));
        }
        if scv_eff[i].is_infinite() {
            return Err(SrbmError::InfiniteVariance(station.name.clone()));
        }
    }

    // Aggregated routing, weighted by each class's share of the station's throughput.
    let mut p = vec![vec![0.0; d]; d];
    for i in 0..d {
        if alpha[i] > 1e-15 {
            for j in 0..d {
                for k in 0..k_classes {
                    p[i][j] += (alpha_per_class[k][i] / alpha[i]) * p_class[k][i][j];
                }
            }
        }
    }

    let mut capacity: Vec<f64> = (0..d).map(|i| servers[i] as f64 * mu_eff[i]).collect();

    // Loss correction: arrivals that find a full station are lost, which thins the throughput.
    if loss && !infinite {
        let mut alpha_arrive = alpha_per_class.clone();
        for _ in 0..30 {
            let mut total = vec![0.0; d];
            for i in 0..d {
                for k in 0..k_classes {
                    total[i] += alpha_arrive[k][i];
                }
            }
            let mut p_loss = vec![0.0; d];
            for i in (0..d).filter(|i| capacity[*i] > 1e-15) {
                p_loss[i] = mm1k_blocking(total[i] / capacity[i], buffer_sizes[i] + servers[i]);
            }
            let mut next = vec![vec![0.0; d]; k_classes];
            let mut max_delta = 0.0;
            for k in 0..k_classes {
                let mut p_eff = vec![vec![0.0; d]; d];
                for i in 0..d {
                    let factor = 1.0 - p_loss[i];
                    for j in 0..d {
                        p_eff[i][j] = p_class[k][i][j] * factor;
                    }
                }
                let (a, singular) = solve_traffic_equations(&p_eff, &lambda_ext[k], d);
                if let Some(bad) = singular {
                    return net_err(NetworkError::TrafficSingular(stations[bad].name.clone(), k as i64));
                }
                next[k] = a;
                for i in 0..d {
                    let delta = (next[k][i] - alpha_arrive[k][i]).abs();
                    if delta > max_delta {
                        max_delta = delta;
                    }
                }
            }
            alpha_arrive = next;
            if max_delta < 1e-7 {
                break;
            }
        }
        let mut total = vec![0.0; d];
        for i in 0..d {
            for k in 0..k_classes {
                total[i] += alpha_arrive[k][i];
            }
        }
        let mut p_loss = vec![0.0; d];
        for i in (0..d).filter(|i| capacity[*i] > 1e-15) {
            p_loss[i] = mm1k_blocking(total[i] / capacity[i], buffer_sizes[i] + servers[i]);
        }
        for k in 0..k_classes {
            for i in 0..d {
                alpha_per_class[k][i] = alpha_arrive[k][i] * (1.0 - p_loss[i]);
            }
        }
        for i in 0..d {
            alpha[i] = 0.0;
            for k in 0..k_classes {
                alpha[i] += alpha_per_class[k][i];
            }
        }
    }

    // BAS correction: a full downstream buffer blocks the server upstream, shrinking its capacity.
    if bas && !infinite && !loss {
        let beta = 0.5;
        let mu_base = mu_eff.clone();
        for _ in 0..30 {
            let mut p_block = vec![0.0; d];
            for i in (0..d).filter(|i| capacity[*i] > 1e-15) {
                let rho = swift_min(alpha[i] / capacity[i], 0.999);
                p_block[i] = mm1k_blocking(rho, buffer_sizes[i] + servers[i]);
            }
            let mut max_delta = 0.0;
            for i in 0..d {
                let mut block_sum = 0.0;
                for j in 0..d {
                    block_sum += p[i][j] * p_block[j];
                }
                let factor = swift_max(0.05, 1.0 - beta * block_sum);
                let new_mu = mu_base[i] * factor;
                let new_cap = servers[i] as f64 * new_mu;
                max_delta = swift_max(max_delta, (new_cap - capacity[i]).abs());
                capacity[i] = new_cap;
                mu_eff[i] = new_mu;
            }
            if max_delta < 1e-7 {
                break;
            }
        }
    }

    // Drift: the netput α − c for finite buffers; in R's coordinates, (I − Pᵀ)(α − c), for infinite.
    let mut drift: Vec<f64> = (0..d).map(|i| alpha[i] - capacity[i]).collect();
    if infinite {
        let netput = drift.clone();
        for i in 0..d {
            for k in 0..d {
                drift[i] -= p[k][i] * netput[k];
            }
        }
    }

    let gamma = covariance(&p, &lambda_ext, &arrival_scvs, if infinite { &alpha } else { &capacity }, &scv_eff, d);
    let r = reflection(&p, d, infinite);
    let a_vec: Vec<f64> = (0..d).map(|i| (buffer_sizes[i] + servers[i]) as f64).collect();
    let class_external_arrivals: Vec<f64> = lambda_ext.iter().map(|row| row.iter().fold(0.0, |a, b| a + b)).collect();
    let class_service_rates: Vec<Vec<f64>> = (0..k_classes).map(|k| stations.iter().map(|s| service_rate_for_class(s, k)).collect()).collect();

    Ok(SrbmData {
        d,
        k: k_classes,
        drift,
        gamma,
        r,
        a_vec,
        service_rates: mu_eff,
        servers,
        alpha,
        alpha_per_class,
        aggregated_p: p,
        capacity,
        class_external_arrivals,
        class_external_arrival_rates: lambda_ext,
        class_service_rates,
        arrival_scvs,
        effective_service_scvs: scv_eff,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Node;

    /// Source → buffer → station → sink, with one link each.
    fn mm1(lambda: f64, mu: f64) -> (Vec<Node>, Vec<Link>) {
        let mut src = Node::new("A", NodeKind::Source, "Src1", (0.0, 0.0));
        src.distribution = Distribution::Poisson;
        src.parameters = format!("lambda={lambda}");
        let buf = Node::new("B", NodeKind::Buffer, "B1", (0.0, 0.0));
        let mut st = Node::new("C", NodeKind::Station, "S1", (0.0, 0.0));
        st.parameters = format!("rate={mu}");
        let sink = Node::new("D", NodeKind::Sink, "Sink1", (0.0, 0.0));
        let l = |id: &str, from: &str, to: &str| Link { id: id.into(), from: from.into(), to: to.into(), probability: 1.0, class: 0, to_class: None };
        (vec![src, buf, st, sink], vec![l("1", "A", "B"), l("2", "B", "C"), l("3", "C", "D")])
    }

    #[test]
    fn a_single_mm1_station_has_the_textbook_load() {
        let (n, l) = mm1(0.8, 1.0);
        let d = compute(&n, &l, true, false, false).unwrap();
        assert_eq!((d.d, d.k), (1, 1));
        assert!((d.rho(0) - 0.8).abs() < 1e-15);
        assert!((d.drift[0] - (0.8 - 1.0)).abs() < 1e-15);
        // Throughput-weighted Γ for an M/M/1 station: λ·1 + α·1 = 1.6.
        assert!((d.gamma[0][0] - 1.6).abs() < 1e-12);
        assert_eq!(d.r[0], vec![1.0, -1.0]);
        assert_eq!(d.a_vec, vec![2.0], "buffer 1 + one server");
    }

    #[test]
    fn a_closed_self_loop_is_refused_by_name() {
        let (n, mut l) = mm1(0.5, 1.0);
        l[2].to = "B".into(); // S1 → B1 with probability 1: every job comes back.
        let e = compute(&n, &l, true, false, false).unwrap_err();
        assert_eq!(e, SrbmError::Network(NetworkError::TrafficSingular("S1".into(), 0)));
        assert!(e.message().starts_with("Routing for Class 1 returns every job that reaches S1 to S1"));
    }

    #[test]
    fn structural_errors_are_reported_in_0_90_34s_order_and_words() {
        let (n, l) = mm1(0.5, 1.0);
        let without = |kind| n.iter().filter(|x| x.kind != kind).cloned().collect::<Vec<_>>();
        assert_eq!(compute(&without(NodeKind::Station), &l, true, false, false).unwrap_err().message(), "The network has no stations.");
        assert_eq!(compute(&without(NodeKind::Source), &l, true, false, false).unwrap_err().message(), "The network has no source node.");
        assert_eq!(compute(&without(NodeKind::Sink), &l, true, false, false).unwrap_err().message(), "The network has no sink node.");
        assert_eq!(compute(&without(NodeKind::Buffer), &l, true, false, false).unwrap_err().message(), "Station S1 has no buffer feeding into it.");
        let mut over = l.clone();
        // Links to a sink aren't in the station routing matrix; two S1 → B1 links (B1 feeds S1) at
        // 0.75 each make the row sum 1.5.
        for id in ["4", "5"] {
            over.push(Link { id: id.into(), from: "C".into(), to: "B".into(), probability: 0.75, class: 0, to_class: None });
        }
        assert_eq!(compute(&n, &over, true, false, false).unwrap_err().message(), "Routing probabilities from S1 for Class 1 sum to 1.5000, which exceeds 1.0.");
    }

    #[test]
    fn the_default_parameter_fill_is_the_pipelines_not_the_inspectors() {
        assert_eq!(rate(Distribution::Exponential, ""), 1.0, "a missing rate is 1 here");
        assert_eq!(rate(Distribution::Erlang, "rate=3"), 1.5, "k defaults to 2");
        assert_eq!(rate(Distribution::Poisson, "lambda=4"), 4.0, "a Poisson source's rate is λ");
        assert!(scv(Distribution::Pareto, "shape=2").is_infinite());
        assert_eq!(rate(Distribution::Constant, "value=0"), 0.0);
    }

    /// 0.90.34's SRBMExporter.parseParams skips a value that isn't a number, so an earlier readable
    /// one stands; the inspector's reading drops the key instead (found while porting the exporters).
    #[test]
    fn a_later_unreadable_value_leaves_the_last_readable_one_in_force() {
        assert_eq!(rate(Distribution::Exponential, "rate=2,rate=x"), 2.0);
        assert_eq!(crate::dist::mean(Distribution::Exponential, &crate::dist::parse_params("rate=2,rate=x")), None, "the inspector has no rate");
    }
}
