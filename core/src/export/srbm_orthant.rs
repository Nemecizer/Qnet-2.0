//! The infinite-buffer SRBM solver inputs: the orthant files read by BNAsm, BNAmc, BNAlp and the
//! two BAR solvers (BNAalr, BNAbb), written exactly as Qnet 0.90.34's `BNASRBMExporter.swift` wrote
//! them.
//!
//! Unlike the box exporters, this one has its own station model (`compute`, 0.90.34's
//! `BNASRBMExporter.computeData`): the same traffic equations and throughput-weighted service as
//! `traffic::compute`, but no buffer pairing, a refusal when any station's load ρ reaches 1, the
//! d × d orthant reflection R = I − Pᵀ, and the workload scaling of gjn.c (Γ_ij·τ_iτ_j,
//! R_ij·τ_i/τ_j, θ = R(ρ − 1), with τ_i = 1/(s_i μ_i)). It is ported as it stands, in its loop
//! order, rather than built on `traffic::compute`, because 0.90.34 computed it separately and the
//! digits of every file come from it. It also resolves a link into a buffer differently: through
//! any chain of buffers to the first station reached, where `traffic` takes only a station the
//! buffer links to directly.
//!
//! Numbers are printed by C's `printf` (`cfmt::f`), the two BAR documents by `JSONSerialization`'s
//! rules (`json::to_pretty_serialization`, doubles as `%.17g`). 0.90.34's `export` (d, θ, Γ, R only)
//! and `exportForFEM` had no caller and are not ported (PLAN.md §4; ledger EXP-046); the block they
//! wrote survives inside the BNAmc file.

use std::collections::{BTreeMap, HashMap};

use crate::cfmt;
use crate::json::{self, Json};
use crate::model::{Link, Node, NodeKind};
use crate::naming;
use crate::traffic::{self, class_label};

/// The spectral method's default polynomial degree (`sm.degree`, 8).
pub const DEFAULT_SPECTRAL_DEGREE: i64 = 8;

/// The adaptive low-rank BAR's default maximum rank (12; no caller changes it).
pub const DEFAULT_MAX_RANK: i64 = 12;

/// The BAR moment relaxation's default order (2; no caller changes it).
pub const DEFAULT_BAR_ORDER: i64 = 2;

/// Why the orthant SRBM can't be built (0.90.34 `BNASRBMExportError`).
#[derive(Clone, Debug, PartialEq)]
pub enum OrthantError {
    NoStations,
    NoSource,
    NoSink,
    /// Station, the row sum, the class index.
    RoutingExceedsOne(String, f64, i64),
    SourceNotConnectedToStation1,
    InfiniteMean(String),
    InfiniteVariance(String),
    /// Declared by 0.90.34 but never returned.
    DegenerateCovariance,
    /// Station, its load ρ.
    StationOverloaded(String, f64),
    /// Station, class index: a closed cycle makes the throughput unbounded.
    TrafficSingular(String, i64),
    /// A BAR document held a value JSON can't carry.
    Encoding(String),
}

impl OrthantError {
    /// The sentence 0.90.34 showed.
    pub fn message(&self) -> String {
        match self {
            OrthantError::NoStations => "The network has no stations.".into(),
            OrthantError::NoSource => "The network has no source node.".into(),
            OrthantError::NoSink => "The network has no sink node.".into(),
            OrthantError::RoutingExceedsOne(n, sum, k) => {
                format!("Routing probabilities from {n} for {} sum to {}, which exceeds 1.0.", class_label(*k), cfmt::f("%.4f", *sum))
            }
            OrthantError::SourceNotConnectedToStation1 => "The source must connect (possibly via a buffer) to station S1.".into(),
            OrthantError::InfiniteMean(n) => format!("{n} has a distribution with infinite mean (e.g. Pareto with shape <= 1)."),
            OrthantError::InfiniteVariance(n) => format!("{n} has a distribution with infinite variance (e.g. Pareto with shape <= 2)."),
            OrthantError::DegenerateCovariance => {
                "The covariance matrix is zero (all distributions are constant with deterministic routing). SRBM requires randomness.".into()
            }
            OrthantError::StationOverloaded(n, rho) => format!(
                "{n} has traffic intensity rho = {} >= 1. The service rate must exceed the arrival rate at every station for the SRBM to have a stationary distribution.",
                cfmt::f("%.4f", *rho)
            ),
            OrthantError::TrafficSingular(n, k) => format!(
                "Routing for {} returns every job that reaches {n} to {n}, so its throughput is unbounded and no arrival rate can be computed. Lower a routing probability on that cycle, or send part of it to a sink.",
                class_label(*k)
            ),
            OrthantError::Encoding(m) => format!("The SRBM parameters could not be encoded as JSON: {m}"),
        }
    }
}

impl std::fmt::Display for OrthantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// The workload-scaled orthant SRBM, indexed by station in export order (0.90.34 `BNASRBMData`).
#[derive(Clone, Debug, PartialEq)]
pub struct OrthantData {
    pub d: usize,
    /// Workload drift θ.
    pub drift: Vec<f64>,
    /// Workload covariance Γ.
    pub gamma: Vec<Vec<f64>>,
    /// d × d workload-scaled reflection matrix.
    pub r: Vec<Vec<f64>>,
    /// τ_i = 1 / (s_i μ_eff,i).
    pub mean_service_times: Vec<f64>,
    /// Customer classes.
    pub k: usize,
    /// α_i.
    pub total_throughput: Vec<f64>,
    /// μ_eff,i.
    pub effective_service_rates: Vec<f64>,
    /// λ_k, summed over stations.
    pub class_external_arrivals: Vec<f64>,
    /// α[k][i].
    pub class_throughput: Vec<Vec<f64>>,
    /// μ[k][i].
    pub class_service_rates: Vec<Vec<f64>>,
}

/// Swift's `max`: `y >= x ? y : x`.
fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

/// The station a link into `node_id` delivers to (this exporter's `resolveTargetStation`): the node
/// itself if it's a station; for a buffer, the first of its outgoing links (in document order)
/// that leads, through any further buffers, to a station. 0.90.34 recursed without a guard, so a
/// cycle of buffers overflowed its stack; here a buffer already on the path resolves to nothing.
fn resolve_target_station(node_id: &str, nodes: &[Node], links: &[Link], station_index: &HashMap<&str, usize>, path: &mut Vec<String>) -> Option<usize> {
    let node = nodes.iter().find(|n| n.id == node_id)?;
    match node.kind {
        NodeKind::Station => station_index.get(node.id.as_str()).copied(),
        NodeKind::Buffer => {
            if path.contains(&node.id) {
                return None;
            }
            path.push(node.id.clone());
            let mut found = None;
            for link in links.iter().filter(|l| l.from == node.id) {
                if let Some(i) = resolve_target_station(&link.to, nodes, links, station_index, path) {
                    found = Some(i);
                    break;
                }
            }
            path.pop();
            found
        }
        _ => None,
    }
}

/// Queue-length covariance before the workload scaling (`computeCovariance`):
/// Γ = A + (I − Pᵀ) diag(α c²) (I − P) + Γ_routing.
fn covariance(p: &[Vec<f64>], lambda_ext: &[Vec<f64>], arrival_scvs: &[f64], alpha: &[f64], service_scvs: &[f64], d: usize) -> Vec<Vec<f64>> {
    let mut m = vec![vec![0.0; d]; d];
    for i in 0..d {
        for j in 0..d {
            m[i][j] = (if i == j { 1.0 } else { 0.0 }) - p[j][i];
        }
    }
    let b: Vec<f64> = (0..d).map(|k| alpha[k] * service_scvs[k]).collect();
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
                routing[i][j] += alpha[k] * p[k][i] * ((if i == j { 1.0 } else { 0.0 }) - p[k][j]);
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

/// The d × d orthant reflection matrix R = I − Pᵀ (`computeReflectionMatrix`).
fn reflection(p: &[Vec<f64>], d: usize) -> Vec<Vec<f64>> {
    let mut r = vec![vec![0.0; d]; d];
    for k in 0..d {
        r[k][k] = 1.0;
        for j in 0..d {
            if p[k][j] > 0.0 {
                r[j][k] -= p[k][j];
            }
        }
    }
    r
}

/// The workload-scaled orthant SRBM of a network (`BNASRBMExporter.computeData`).
pub fn compute(nodes: &[Node], links: &[Link]) -> Result<OrthantData, OrthantError> {
    let sources = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Source), |n| &n.name);
    let sinks = nodes.iter().filter(|n| n.kind == NodeKind::Sink).count();
    let stations = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);
    if stations.is_empty() {
        return Err(OrthantError::NoStations);
    }
    if sources.is_empty() {
        return Err(OrthantError::NoSource);
    }
    if sinks == 0 {
        return Err(OrthantError::NoSink);
    }

    let max_link_class = links.iter().fold(-1i64, |acc, l| acc.max(l.class).max(l.to_class.unwrap_or(-1)));
    let k_classes = (sources.len() as i64).max(max_link_class + 1) as usize;
    let d = stations.len();

    if !traffic::path_exists(&sources[0].id, &stations[0].id, links) {
        return Err(OrthantError::SourceNotConnectedToStation1);
    }

    let mut station_index: HashMap<&str, usize> = HashMap::new();
    for (i, s) in stations.iter().enumerate() {
        station_index.insert(s.id.as_str(), i);
    }
    let resolve = |id: &str| resolve_target_station(id, nodes, links, &station_index, &mut Vec::new());

    // External arrivals per class and station.
    let mut lambda_ext = vec![vec![0.0; d]; k_classes];
    let mut arrival_scvs = vec![1.0; k_classes];
    for (k, source) in sources.iter().enumerate() {
        let rate = traffic::rate(source.distribution, &source.parameters);
        if rate <= 0.0 {
            return Err(OrthantError::InfiniteMean(source.name.clone()));
        }
        let scv = traffic::scv(source.distribution, &source.parameters);
        if scv.is_infinite() {
            return Err(OrthantError::InfiniteVariance(source.name.clone()));
        }
        arrival_scvs[k] = scv;
        for link in links.iter().filter(|l| l.from == source.id) {
            if let Some(i) = resolve(&link.to) {
                lambda_ext[k][i] += rate * link.probability;
            }
        }
    }

    // Per-class routing between stations.
    let mut p_class = Vec::with_capacity(k_classes);
    for class in 0..k_classes {
        let mut matrix = vec![vec![0.0; d]; d];
        for (i, station) in stations.iter().enumerate() {
            for link in links.iter().filter(|l| l.from == station.id && l.class == class as i64) {
                if let Some(t) = resolve(&link.to) {
                    matrix[i][t] += link.probability;
                }
            }
            let row_sum: f64 = matrix[i].iter().fold(0.0, |a, b| a + b);
            if row_sum > 1.0 + 1e-9 {
                return Err(OrthantError::RoutingExceedsOne(station.name.clone(), row_sum, class as i64));
            }
        }
        p_class.push(matrix);
    }

    // Traffic equations: per class when no link changes class, else on the (class, station) pairs.
    let mut alpha_per_class = vec![vec![0.0; d]; k_classes];
    if !links.iter().any(|l| l.has_class_transition()) {
        for k in 0..k_classes {
            let (alpha, singular) = traffic::solve_traffic_equations(&p_class[k], &lambda_ext[k], d);
            if let Some(bad) = singular {
                return Err(OrthantError::TrafficSingular(stations[bad].name.clone(), k as i64));
            }
            alpha_per_class[k] = alpha;
        }
    } else {
        let n = k_classes * d;
        let mut p_ex = vec![vec![0.0; n]; n];
        for (i, station) in stations.iter().enumerate() {
            for link in links.iter().filter(|l| l.from == station.id) {
                let Some(t) = resolve(&link.to) else { continue };
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
        let (alpha_ex, singular) = traffic::solve_traffic_equations(&p_ex, &lambda_ex, n);
        if let Some(bad) = singular {
            return Err(OrthantError::TrafficSingular(stations[bad % d].name.clone(), (bad / d) as i64));
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
                let mu_ik = traffic::service_rate_for_class(station, k);
                let scv_ik = traffic::service_scv_for_class(station, k);
                if !(mu_ik > 0.0) {
                    return Err(OrthantError::InfiniteMean(station.name.clone()));
                }
                let mean_svc = 1.0 / mu_ik;
                m1 += weight * mean_svc;
                m2 += weight * (1.0 + scv_ik) * mean_svc * mean_svc;
            }
            if !(m1 > 0.0) {
                return Err(OrthantError::InfiniteMean(station.name.clone()));
            }
            mu_eff[i] = 1.0 / m1;
            scv_eff[i] = swift_max(0.0, (m2 - m1 * m1) / (m1 * m1));
        } else {
            mu_eff[i] = traffic::service_rate_for_class(station, 0);
            scv_eff[i] = traffic::service_scv_for_class(station, 0);
        }
        if mu_eff[i] <= 0.0 {
            return Err(OrthantError::InfiniteMean(station.name.clone()));
        }
        if scv_eff[i].is_infinite() {
            return Err(OrthantError::InfiniteVariance(station.name.clone()));
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

    let tau: Vec<f64> = (0..d).map(|i| 1.0 / (servers[i] as f64 * mu_eff[i])).collect();

    for (j, station) in stations.iter().enumerate() {
        let rho_j = tau[j] * alpha[j];
        if rho_j >= 1.0 {
            return Err(OrthantError::StationOverloaded(station.name.clone(), rho_j));
        }
    }

    let mut gamma = covariance(&p, &lambda_ext, &arrival_scvs, &alpha, &scv_eff, d);
    let mut r = reflection(&p, d);

    // Workload scaling (gjn.c lines 105–111).
    for i in 0..d {
        for j in 0..d {
            gamma[i][j] *= tau[i] * tau[j];
            r[i][j] *= tau[i] / tau[j];
        }
    }

    // Workload drift θ_i = Σ_j R_ij (ρ_j − 1) (gjn.c lines 129–135).
    let mut drift = vec![0.0; d];
    for i in 0..d {
        for j in 0..d {
            let rho_j = tau[j] * alpha[j];
            drift[i] += r[i][j] * (rho_j - 1.0);
        }
    }

    let class_external_arrivals: Vec<f64> = lambda_ext.iter().map(|row| row.iter().fold(0.0, |a, b| a + b)).collect();
    let class_service_rates: Vec<Vec<f64>> = (0..k_classes).map(|k| stations.iter().map(|s| traffic::service_rate_for_class(s, k)).collect()).collect();

    Ok(OrthantData {
        d,
        drift,
        gamma,
        r,
        mean_service_times: tau,
        k: k_classes,
        total_throughput: alpha,
        effective_service_rates: mu_eff,
        class_external_arrivals,
        class_throughput: alpha_per_class,
        class_service_rates,
    })
}

/// `%10.5f` (`formatValue`).
fn value(v: f64) -> String {
    cfmt::f("%10.5f", v)
}

fn row(values: &[f64], fmt: &str, sep: &str) -> String {
    values.iter().map(|v| cfmt::f(fmt, *v)).collect::<Vec<_>>().join(sep)
}

/// d, θ, Γ and the d × d R at `%10.5f`, blank-separated and ending in a blank line
/// (`formatStandard`).
fn format_standard(data: &OrthantData) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(data.d.to_string());
    lines.push(String::new());
    lines.push(row(&data.drift, "%10.5f", " "));
    lines.push(String::new());
    for r in &data.gamma {
        lines.push(row(r, "%10.5f", " "));
    }
    lines.push(String::new());
    for r in &data.r {
        lines.push(row(r, "%10.5f", " "));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// The BNAsm spectral input (`exportForSpectral`): d, θ, Γ, R at `%10.5f`, the polynomial degree,
/// `customer_classes K`, then at `%g` τ, total throughput, effective service rate, λ per class, K
/// rows of per-class α and K rows of per-class μ. 0.90.34 runs it with `DEFAULT_SPECTRAL_DEGREE`
/// unless the run sheet changes it; the Legendre basis is a command-line flag, not in the file.
pub fn export_for_spectral(nodes: &[Node], links: &[Link], degree: i64) -> Result<String, OrthantError> {
    let data = compute(nodes, links)?;
    let mut lines: Vec<String> = Vec::new();
    lines.push(data.d.to_string());
    lines.push(String::new());
    lines.push(row(&data.drift, "%10.5f", " "));
    lines.push(String::new());
    for r in &data.gamma {
        lines.push(row(r, "%10.5f", " "));
    }
    lines.push(String::new());
    for r in &data.r {
        lines.push(row(r, "%10.5f", " "));
    }
    lines.push(String::new());
    lines.push(degree.to_string());
    lines.push(String::new());

    lines.push(format!("customer_classes {}", data.k));
    lines.push(String::new());
    lines.push(row(&data.mean_service_times, "%g", " "));
    lines.push(String::new());
    lines.push(row(&data.total_throughput, "%g", " "));
    lines.push(String::new());
    lines.push(row(&data.effective_service_rates, "%g", " "));
    lines.push(String::new());
    lines.push(row(&data.class_external_arrivals, "%g", " "));
    lines.push(String::new());
    for k in 0..data.k {
        lines.push(row(&data.class_throughput[k], "%g", " "));
    }
    lines.push(String::new());
    for k in 0..data.k {
        lines.push(row(&data.class_service_rates[k], "%g", " "));
    }
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// ½(M + Mᵀ) (`symmetrized`).
fn symmetrized(m: &[Vec<f64>]) -> Vec<Vec<f64>> {
    (0..m.len()).map(|r| (0..m.len()).map(|c| 0.5 * (m[r][c] + m[c][r])).collect()).collect()
}

/// A double for a `JSONSerialization` document; a value JSON can't hold is refused with the
/// reason Foundation gives.
fn number(v: f64) -> Result<Json, OrthantError> {
    if v.is_nan() {
        return Err(OrthantError::Encoding("Invalid number value (NaN) in JSON write".into()));
    }
    if v.is_infinite() {
        return Err(OrthantError::Encoding("Invalid number value (infinite) in JSON write".into()));
    }
    Ok(json::ns_double(v))
}

fn vector(v: &[f64]) -> Result<Json, OrthantError> {
    Ok(Json::Array(v.iter().map(|x| number(*x)).collect::<Result<_, _>>()?))
}

fn matrix(m: &[Vec<f64>]) -> Result<Json, OrthantError> {
    Ok(Json::Array(m.iter().map(|r| vector(r)).collect::<Result<_, _>>()?))
}

fn object(entries: Vec<(&str, Json)>) -> Json {
    Json::Object(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<BTreeMap<_, _>>())
}

/// `JSONSerialization` with `[.prettyPrinted, .sortedKeys]`, plus the newline `encodeJSON` adds.
fn encode(document: &Json) -> String {
    json::to_pretty_serialization(document) + "\n"
}

/// The adaptive low-rank BAR document (`exportForAdaptiveBAR`), read by BNAalr. `name` is the
/// tab title in the app, the file's base name in the headless flags.
///
/// 0.90.34 crashed (an uncaught `NSInvalidArgumentException`) when a computed value was NaN or
/// infinite; this refuses with its `encoding` sentence and Foundation's reason instead.
pub fn export_for_adaptive_bar(nodes: &[Node], links: &[Link], name: &str, max_rank: i64) -> Result<String, OrthantError> {
    let data = compute(nodes, links)?;
    let d = data.d as i64;
    let document = object(vec![
        ("schema_version", Json::int(1)),
        ("name", Json::str(name)),
        ("drift", vector(&data.drift)?),
        ("covariance", matrix(&symmetrized(&data.gamma))?),
        ("reflection", matrix(&data.r)?),
        (
            "options",
            object(vec![
                ("max_rank", Json::int(max_rank.max(1))),
                ("training_points", Json::int(64i64.max(6 * d))),
                ("validation_points", Json::int(32i64.max(6 * d))),
                ("bar_tolerance", json::ns_double(2e-5)),
                ("moment_tolerance", json::ns_double(2e-3)),
                ("log_rate_span", json::ns_double(1.6)),
                ("max_iterations", Json::int(6000)),
            ]),
        ),
    ]);
    Ok(encode(&document))
}

/// The BAR moment-relaxation document (`exportForBARBounds`), read by BNAbb: the first moment of
/// each workload coordinate as the targets. Non-finite values are refused as in
/// `export_for_adaptive_bar`.
pub fn export_for_bar_bounds(nodes: &[Node], links: &[Link], name: &str, order: i64) -> Result<String, OrthantError> {
    let data = compute(nodes, links)?;
    let targets: Vec<Json> = (0..data.d)
        .map(|index| {
            let moment: Vec<Json> = (0..data.d).map(|j| Json::int(if j == index { 1 } else { 0 })).collect();
            object(vec![("name", Json::str(format!("mean_workload_{}", index + 1))), ("moment", Json::Array(moment))])
        })
        .collect();
    let document = object(vec![
        ("schema_version", Json::int(1)),
        ("model_type", Json::str("orthant_srbm_bar_bounds")),
        ("name", Json::str(name)),
        ("drift", vector(&data.drift)?),
        ("covariance", matrix(&symmetrized(&data.gamma))?),
        ("reflection", matrix(&data.r)?),
        (
            "relaxation",
            object(vec![
                ("order", Json::int(order.max(1))),
                ("max_variables", Json::int(100_000)),
                ("max_psd_entries", Json::int(5_000_000)),
                ("targets", Json::Array(targets)),
            ]),
        ),
    ]);
    Ok(encode(&document))
}

/// `# mu_eff per station (1/tau) = …`, each 1/τ at `%.4f` (0 when τ ≤ 0).
fn mu_eff_comment(data: &OrthantData) -> String {
    let rates: Vec<String> = data.mean_service_times.iter().map(|tau| cfmt::f("%.4f", if *tau > 0.0 { 1.0 / tau } else { 0.0 })).collect();
    format!("# mu_eff per station (1/tau) = {}", rates.join(", "))
}

/// The BNAmc / rbm_mlmc input (`formatBNAmcInput`): five comment lines, a blank line, then d, θ,
/// Γ and R.
pub fn format_bnamc_input(data: &OrthantData) -> String {
    let header = [
        "# BNET -> BNAmc SRBM input (workload scaling)".to_string(),
        "# Produced by BNASRBMExporter".to_string(),
        format!("# d = {}", data.d),
        mu_eff_comment(data),
        "# mean queue length L_i = mu_eff_i * E[Y_i]".to_string(),
        String::new(),
    ];
    header.join("\n") + &format_standard(data)
}

/// The (grid n, basis m) BNAlp uses when none is given, by dimension (`recommendedBNAlpGrid`).
pub fn recommended_bnalp_grid(d: usize) -> (i64, i64) {
    match d {
        0..=2 => (100, 6),
        3 => (25, 5),
        4 => (12, 4),
        5 => (10, 3),
        6 => (6, 3),
        7 => (5, 3),
        8 => (4, 3),
        9..=10 => (3, 3),
        _ => (2, 2),
    }
}

/// What a BNAlp run passes to the file. `Default` is 0.90.34's: grid and basis `None` (taken from
/// `recommended_bnalp_grid`; a run resolves its setting's 0 to that before calling, and stages
/// several grid sizes, one file each), grid type `exponential` (or `dyadic`, `exprandom`),
/// smoothness 0 (the line is left out) and no basis normalisation.
#[derive(Clone, Debug, PartialEq)]
pub struct BnaLpParams {
    pub grid_n: Option<i64>,
    pub basis_m: Option<i64>,
    pub grid_type: String,
    pub smoothness_weight: f64,
    pub basis_normalize: bool,
}

impl Default for BnaLpParams {
    fn default() -> Self {
        BnaLpParams { grid_n: None, basis_m: None, grid_type: "exponential".into(), smoothness_weight: 0.0, basis_normalize: false }
    }
}

/// The BNAlp / srbm_lp keyword file (`formatBNAlpInput`): the five-line header, the
/// hyperparameters, the drift, covariance and reflection blocks, zero grid spacing (the solver
/// picks ρ/2) and 2d + 1 loose tightness bounds.
pub fn format_bnalp_input(data: &OrthantData, params: &BnaLpParams) -> String {
    let rec = recommended_bnalp_grid(data.d);
    let grid_n = params.grid_n.unwrap_or(rec.0);
    let basis_m = params.basis_m.unwrap_or(rec.1);
    let d = data.d;
    let mut lines: Vec<String> = Vec::new();

    lines.push("# BNET -> BNAlp SRBM input (LP solver)".into());
    lines.push("# Produced by BNASRBMExporter".into());
    lines.push(format!("# d = {d}"));
    lines.push(mu_eff_comment(data));
    lines.push("# mean queue length L_i = mu_eff_i * E[Y_i]".into());
    lines.push(String::new());

    lines.push(format!("dimension  {d}"));
    lines.push(format!("grid_n     {grid_n}"));
    lines.push(format!("basis_m    {basis_m}"));
    lines.push(format!("grid_type  {}", params.grid_type));
    if params.smoothness_weight > 0.0 {
        lines.push(format!("smoothness_weight {}", cfmt::swift_description(params.smoothness_weight)));
    }
    if params.basis_normalize {
        lines.push("basis_normalize 1".into());
    }
    lines.push(String::new());

    lines.push("drift".into());
    lines.push(format!("  {}", data.drift.iter().map(|v| value(*v)).collect::<Vec<_>>().join("  ")));
    lines.push(String::new());

    lines.push("covariance".into());
    for r in &data.gamma {
        lines.push(format!("  {}", r.iter().map(|v| value(*v)).collect::<Vec<_>>().join("  ")));
    }
    lines.push(String::new());

    lines.push("reflection".into());
    for r in &data.r {
        lines.push(format!("  {}", r.iter().map(|v| value(*v)).collect::<Vec<_>>().join("  ")));
    }
    lines.push(String::new());

    lines.push("grid_spacing".into());
    lines.push(format!("  {}", vec!["0.0"; d].join("  ")));
    lines.push(String::new());

    lines.push("tightness_bounds".into());
    lines.push(format!("  {}", vec!["100000"; 2 * d + 1].join(" ")));
    lines.push(String::new());

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Distribution;

    fn link(id: &str, from: &str, to: &str, p: f64) -> Link {
        Link { id: id.into(), from: from.into(), to: to.into(), probability: p, class: 0, to_class: None }
    }

    /// Source → buffer → station → sink.
    fn mm1(lambda: f64, mu: f64) -> (Vec<Node>, Vec<Link>) {
        let mut src = Node::new("A", NodeKind::Source, "Src1", (0.0, 0.0));
        src.distribution = Distribution::Poisson;
        src.parameters = format!("lambda={lambda}");
        let buf = Node::new("B", NodeKind::Buffer, "B1", (0.0, 0.0));
        let mut st = Node::new("C", NodeKind::Station, "S1", (0.0, 0.0));
        st.parameters = format!("rate={mu}");
        let sink = Node::new("D", NodeKind::Sink, "Sink1", (0.0, 0.0));
        (vec![src, buf, st, sink], vec![link("1", "A", "B", 1.0), link("2", "B", "C", 1.0), link("3", "C", "D", 1.0)])
    }

    #[test]
    fn an_mm1_station_has_the_workload_scaled_textbook_srbm() {
        let (n, l) = mm1(0.5, 2.0);
        let d = compute(&n, &l).unwrap();
        assert_eq!(d.mean_service_times, vec![0.5]);
        assert_eq!(d.r, vec![vec![1.0]]);
        assert_eq!(d.drift, vec![0.25 - 1.0]);
        // (λ·1 + α·1)·τ² = 1.0 · 0.25.
        assert_eq!(d.gamma, vec![vec![0.25]]);
    }

    #[test]
    fn an_overloaded_station_is_refused_with_its_load() {
        let (n, l) = mm1(1.2, 1.0);
        assert_eq!(
            compute(&n, &l).unwrap_err().message(),
            "S1 has traffic intensity rho = 1.2000 >= 1. The service rate must exceed the arrival rate at every station for the SRBM to have a stationary distribution."
        );
    }

    #[test]
    fn every_structural_refusal_has_0_90_34s_sentence() {
        let (n, l) = mm1(0.5, 1.0);
        let without = |kind| n.iter().filter(|x| x.kind != kind).cloned().collect::<Vec<_>>();
        assert_eq!(compute(&without(NodeKind::Station), &l).unwrap_err().message(), "The network has no stations.");
        assert_eq!(compute(&without(NodeKind::Source), &l).unwrap_err().message(), "The network has no source node.");
        assert_eq!(compute(&without(NodeKind::Sink), &l).unwrap_err().message(), "The network has no sink node.");
        let cut: Vec<Link> = l.iter().filter(|x| x.id != "2").cloned().collect();
        assert_eq!(compute(&n, &cut).unwrap_err().message(), "The source must connect (possibly via a buffer) to station S1.");
        let mut over = l.clone();
        over.push(link("4", "C", "B", 0.75));
        over.push(link("5", "C", "B", 0.75));
        assert_eq!(compute(&n, &over).unwrap_err().message(), "Routing probabilities from S1 for Class 1 sum to 1.5000, which exceeds 1.0.");
        let mut closed = l.clone();
        closed[2].to = "B".into();
        assert!(compute(&n, &closed).unwrap_err().message().starts_with("Routing for Class 1 returns every job that reaches S1 to S1"));
    }

    #[test]
    fn infinite_mean_and_variance_are_refused_by_name() {
        let (mut n, l) = mm1(0.5, 1.0);
        n[0].distribution = Distribution::Pareto;
        n[0].parameters = "shape=1,scale=1".into();
        assert_eq!(compute(&n, &l).unwrap_err().message(), "Src1 has a distribution with infinite mean (e.g. Pareto with shape <= 1).");
        n[0].parameters = "shape=1.5,scale=1".into();
        assert_eq!(compute(&n, &l).unwrap_err().message(), "Src1 has a distribution with infinite variance (e.g. Pareto with shape <= 2).");
        let (mut n, l) = mm1(0.5, 1.0);
        n[2].distribution = Distribution::Pareto;
        n[2].parameters = "shape=1.5,scale=0.1".into();
        assert_eq!(compute(&n, &l).unwrap_err().message(), "S1 has a distribution with infinite variance (e.g. Pareto with shape <= 2).");
    }

    #[test]
    fn the_declared_but_unused_sentences_read_as_in_0_90_34() {
        assert_eq!(
            OrthantError::DegenerateCovariance.message(),
            "The covariance matrix is zero (all distributions are constant with deterministic routing). SRBM requires randomness."
        );
        assert_eq!(
            OrthantError::Encoding("Invalid number value (NaN) in JSON write".into()).message(),
            "The SRBM parameters could not be encoded as JSON: Invalid number value (NaN) in JSON write"
        );
    }

    #[test]
    fn a_link_into_a_chain_of_buffers_reaches_the_station_behind_them() {
        let (mut n, mut l) = mm1(0.5, 1.0);
        n.push(Node::new("E", NodeKind::Buffer, "B2", (0.0, 0.0)));
        l[0].to = "E".into();
        l.push(link("6", "E", "B", 1.0));
        let d = compute(&n, &l).unwrap();
        assert_eq!(d.total_throughput, vec![0.5]);
        // A cycle of buffers resolves to nothing rather than recursing forever.
        l.push(link("7", "B", "E", 1.0));
        l.retain(|x| x.id != "2");
        assert_eq!(compute(&n, &l).unwrap_err(), OrthantError::SourceNotConnectedToStation1);
    }

    #[test]
    fn a_bar_document_with_a_non_finite_value_is_refused_not_written() {
        // An unreachable station with no servers has τ = ∞ and ρ = ∞·0 = NaN, which passes the load check.
        let (mut n, mut l) = mm1(0.5, 1.0);
        let mut s2 = Node::new("F", NodeKind::Station, "S2", (0.0, 0.0));
        s2.servers = 0;
        n.push(s2);
        n.push(Node::new("G", NodeKind::Buffer, "B2", (0.0, 0.0)));
        l.push(link("8", "G", "F", 1.0));
        assert!(compute(&n, &l).is_ok());
        let e = export_for_adaptive_bar(&n, &l, "x", DEFAULT_MAX_RANK).unwrap_err();
        assert_eq!(e.message(), "The SRBM parameters could not be encoded as JSON: Invalid number value (NaN) in JSON write");
        assert!(export_for_bar_bounds(&n, &l, "x", DEFAULT_BAR_ORDER).is_err());
    }

    #[test]
    fn the_bar_options_clamp_rank_and_order_at_one() {
        let (n, l) = mm1(0.5, 1.0);
        assert!(export_for_adaptive_bar(&n, &l, "x", 0).unwrap().contains("\"max_rank\" : 1,"));
        assert!(export_for_bar_bounds(&n, &l, "x", -3).unwrap().contains("\"order\" : 1,"));
    }

    #[test]
    fn the_lp_grid_defaults_follow_the_dimension() {
        let got: Vec<(i64, i64)> = (1..=12).map(recommended_bnalp_grid).collect();
        assert_eq!(got, [(100, 6), (100, 6), (25, 5), (12, 4), (10, 3), (6, 3), (5, 3), (4, 3), (3, 3), (3, 3), (2, 2), (2, 2)]);
    }

    #[test]
    fn the_lp_file_writes_every_option_a_run_can_pass() {
        let (n, l) = mm1(0.5, 1.0);
        let data = compute(&n, &l).unwrap();
        let params = BnaLpParams { grid_n: Some(40), basis_m: Some(0), grid_type: "dyadic".into(), smoothness_weight: 0.1, basis_normalize: true };
        let text = format_bnalp_input(&data, &params);
        assert!(
            text.contains("\ndimension  1\ngrid_n     40\nbasis_m    0\ngrid_type  dyadic\nsmoothness_weight 0.1\nbasis_normalize 1\n\ndrift\n"),
            "{text}"
        );
        assert!(text.ends_with("grid_spacing\n  0.0\n\ntightness_bounds\n  100000 100000 100000\n"), "{text}");
    }

    #[test]
    fn the_spectral_file_writes_the_degree_a_run_passes() {
        let (n, l) = mm1(0.5, 1.0);
        let text = export_for_spectral(&n, &l, 11).unwrap();
        assert!(text.contains("\n\n11\n\ncustomer_classes 1\n\n1\n\n0.5\n\n1\n\n0.5\n\n0.5\n\n1\n"), "{text}");
    }
}
