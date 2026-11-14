//! Does this network have a known closed form? (0.90.34 `AnalyticalTractability.swift`)
//!
//! Checked strongest first: an open Jackson network (exact, M/M/s product form; also K disjoint
//! Jackson networks drawn side by side); Harrison–Williams (1987) skew symmetry (exact SRBM product
//! form); and the three asymptotic product forms of Guang, Chen, Dai and Glynn (2025,
//! arXiv:2503.19710): Corollary 3 (lower-triangular R), Corollary 2 (d = 2, P-matrix R), Corollary
//! 1 (M-matrix R). `allow_gcdg` false turns the three asymptotic cases off.
//!
//! Every loop, tolerance and comparison is 0.90.34's, in its order, and every sentence is its
//! wording to the character: the kind, detail and means are compared with 0.90.34's `--dump-rho`
//! for every example (tests/golden_tractability.rs). Swift's `max(a, b)` is `b >= a ? b : a`, which
//! is what `swift_max` does, so a NaN falls through the same way.

use std::collections::VecDeque;

use crate::model::{Distribution, Node, NodeKind};
use crate::naming;
use crate::traffic::SrbmData;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    ExactJackson,
    ExactSkewSymmetric,
    AsymptoticLowerTriangular,
    Asymptotic2D,
    AsymptoticMMatrix,
    None,
}

impl Kind {
    /// Swift's `"\(kind)"`: the case name, which `--dump-rho` prints ("exactJackson", "none").
    pub fn case_name(self) -> &'static str {
        match self {
            Kind::ExactJackson => "exactJackson",
            Kind::ExactSkewSymmetric => "exactSkewSymmetric",
            Kind::AsymptoticLowerTriangular => "asymptoticLowerTriangular",
            Kind::Asymptotic2D => "asymptotic2D",
            Kind::AsymptoticMMatrix => "asymptoticMMatrix",
            Kind::None => "none",
        }
    }
}

/// The assessment (0.90.34 `AnalyticalTractability.Result`).
#[derive(Clone, Debug, PartialEq)]
pub struct Assessment {
    pub kind: Kind,
    /// Short banner title.
    pub title: String,
    /// Banner subtitle (one or two lines).
    pub detail: String,
    /// Closed-form E[X_i] when there are some.
    pub means: Vec<f64>,
    /// Header for the analytical column.
    pub means_label: String,
    /// Multi-line text for Analyze Network and Help.
    pub explanation: String,
}

impl Assessment {
    pub fn is_tractable(&self) -> bool {
        self.kind != Kind::None
    }

    pub fn is_exact(&self) -> bool {
        matches!(self.kind, Kind::ExactJackson | Kind::ExactSkewSymmetric)
    }
}

const TRACTABLE: &str = "This network is analytically tractable";
const ASYMPTOTIC_LABEL: &str = "Asymptotic E[X]";

/// The assessment for a network whose station model `data` was computed from `nodes` (`assess`).
pub fn assess(data: &SrbmData, nodes: &[Node], infinite: bool, allow_gcdg: bool) -> Assessment {
    let d = data.d;

    // Stability must hold for any of the results to apply. A NaN ρ passes, as in 0.90.34.
    let mut rho = vec![0.0; d];
    for i in 0..d {
        rho[i] = if data.capacity[i] > 1e-12 { data.alpha[i] / data.capacity[i] } else { 1.0 };
        if rho[i] >= 1.0 || rho[i] <= 0.0 {
            return none("Tractability analysis not applied: one or more stations are unstable (ρ ≥ 1) or receive no traffic.");
        }
    }

    // 1. Exact Jackson.
    if let Some(jackson) = jackson_result(data, nodes, &rho, infinite) {
        return jackson;
    }

    let r = lower_face_r(&data.r, d);
    let gamma = &data.gamma;
    let mu = &data.drift;

    // 2. Harrison–Williams skew symmetry.
    if let Some(skew) = skew_symmetric_result(&r, gamma, mu, d) {
        return skew;
    }

    if !allow_gcdg {
        return none("No exact closed-form distribution matches this network. GCDG 2025 asymptotic approximation is disabled in Settings ▸ GCDG.");
    }

    // 3. GCDG Corollary 3: R lower-triangular after relabelling the stations in topological order.
    if let Some(perm) = permutation_for_lower_triangular(&r, d) {
        let is_identity = perm.iter().enumerate().all(|(a, &b)| a == b);
        let r_p = permute_matrix(&r, &perm);
        let g_p = permute_matrix(gamma, &perm);
        let mu_p: Vec<f64> = perm.iter().map(|&i| mu[i]).collect();
        let m_p = gcdg_means(&r_p, &g_p, &mu_p, d);
        if !m_p.is_empty() {
            // m_p[a] is the mean of station perm[a] in the original numbering.
            let mut means = vec![0.0; d];
            for a in 0..d {
                means[perm[a]] = m_p[a];
            }
            let detail = if is_identity {
                "Asymptotic product form — GCDG 2025 Cor. 3 (lower-triangular R, feed-forward)"
            } else {
                "Asymptotic product form — GCDG 2025 Cor. 3 (feed-forward, station relabel applied)"
            };
            let reason = if is_identity {
                "the reflection matrix R = I − P⊤ is lower-triangular, which arises whenever the network is feed-forward with station numbering respected (e.g. tandem, acyclic layered)."
            } else {
                "the routing graph is acyclic, so the stations can be relabeled in topological order to make R = I − P⊤ lower-triangular. The corollary applies in the relabeled coordinates and the means are unpermuted back to the user's numbering."
            };
            return Assessment {
                kind: Kind::AsymptoticLowerTriangular,
                title: TRACTABLE.into(),
                detail: detail.into(),
                means,
                means_label: ASYMPTOTIC_LABEL.into(),
                explanation: gcdg_explanation(3, reason),
            };
        }
    }

    // 4. GCDG Corollary 2: two stations, R a P-matrix. Tractable even when the means come back empty.
    if d == 2 && is_p_matrix(&r, d) {
        return Assessment {
            kind: Kind::Asymptotic2D,
            title: TRACTABLE.into(),
            detail: "Asymptotic product form — GCDG 2025 Cor. 2 (d = 2, P-matrix R)".into(),
            means: gcdg_means(&r, gamma, mu, d),
            means_label: ASYMPTOTIC_LABEL.into(),
            explanation: gcdg_explanation(2, "the network has two stations and the reflection matrix R is a P-matrix."),
        };
    }

    // 5. GCDG Corollary 1: R an M-matrix. Tractable even when the means come back empty.
    if is_m_matrix(&r, d) {
        return Assessment {
            kind: Kind::AsymptoticMMatrix,
            title: TRACTABLE.into(),
            detail: "Asymptotic product form — GCDG 2025 Cor. 1 (R is an M-matrix)".into(),
            means: gcdg_means(&r, gamma, mu, d),
            means_label: ASYMPTOTIC_LABEL.into(),
            explanation: gcdg_explanation(
                1,
                "the reflection matrix R = I − P⊤ is an M-matrix (non-positive off-diagonals, non-negative inverse). Every open GJN-style SRBM satisfies this.",
            ),
        };
    }

    none("No known closed-form or asymptotic product-form stationary distribution matches this network's data (Γ, R, μ).")
}

/// Whether the aggregated routing matrix has a cycle (`hasRoutingCycles`): a self-loop, or nodes
/// left over after Kahn's algorithm peels the ones nothing routes into. Only entries above 1e-12
/// count as edges.
pub fn has_routing_cycles(p: &[Vec<f64>]) -> bool {
    let d = p.len();
    if (0..d).any(|i| p[i][i] > 1e-12) {
        return true;
    }
    let mut in_deg = vec![0usize; d];
    for i in 0..d {
        for j in 0..d {
            if i != j && p[i][j] > 1e-12 {
                in_deg[j] += 1;
            }
        }
    }
    let mut queue: VecDeque<usize> = (0..d).filter(|&i| in_deg[i] == 0).collect();
    let mut removed = 0;
    while let Some(u) = queue.pop_front() {
        removed += 1;
        for v in 0..d {
            if u != v && p[u][v] > 1e-12 {
                in_deg[v] -= 1;
                if in_deg[v] == 0 {
                    queue.push_back(v);
                }
            }
        }
    }
    removed < d
}

/// A `none` assessment with only an explanation.
fn none(explanation: &str) -> Assessment {
    Assessment {
        kind: Kind::None,
        title: String::new(),
        detail: String::new(),
        means: Vec::new(),
        means_label: String::new(),
        explanation: explanation.into(),
    }
}

/// Swift's `max(x, y)` on Doubles: `y >= x ? y : x`.
fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

/// The one class that visits each station, or None as soon as a station is visited by two (or by
/// none). A class visits when its throughput there is above 1e-12 (`singleClassPerStation`).
///
/// This decides whether a K > 1 document is really multi-class: classes that share no station are
/// disjoint sub-networks, and then μ_eff and P are each station's one class's exactly.
fn single_class_per_station(data: &SrbmData) -> Option<Vec<usize>> {
    let d = data.d;
    if !(data.k >= 1 && data.alpha_per_class.len() == data.k) {
        return None;
    }
    let mut owner = vec![0usize; d];
    for i in 0..d {
        let mut visitor: Option<usize> = None;
        for k in 0..data.k {
            if i >= data.alpha_per_class[k].len() {
                return None;
            }
            if !(data.alpha_per_class[k][i] > 1e-12) {
                continue;
            }
            if visitor.is_some() {
                return None;
            }
            visitor = Some(k);
        }
        owner[i] = visitor?;
    }
    Some(owner)
}

/// The exact Jackson result: infinite buffers, one class per station, every source Poisson or
/// exponential, and every station exponential for the class that visits it (`jacksonResult`).
fn jackson_result(data: &SrbmData, nodes: &[Node], rho: &[f64], infinite: bool) -> Option<Assessment> {
    if !infinite {
        return None;
    }
    let class_at_station = single_class_per_station(data)?;
    let d = data.d;
    let disjoint_classes = data.k > 1;

    // The stations in the station model's order, which `class_at_station` is indexed by.
    let stations = naming::in_export_order(nodes.iter().filter(|n| n.kind == NodeKind::Station), |n| &n.name);
    if stations.len() != d {
        return None;
    }

    for s in nodes.iter().filter(|n| n.kind == NodeKind::Source) {
        if !matches!(s.distribution, Distribution::Poisson | Distribution::Exponential) {
            return None;
        }
    }

    // Only the visiting class's service law is checked: an override left behind for a class that
    // no longer reaches the station never enters μ_eff.
    for (i, st) in stations.iter().enumerate() {
        match st.service_by_class.get(&(class_at_station[i] as i64)) {
            Some(cfg) => {
                if cfg.distribution != Distribution::Exponential {
                    return None;
                }
            }
            None => {
                if st.distribution != Distribution::Exponential {
                    return None;
                }
            }
        }
    }

    let means: Vec<f64> = (0..d).map(|i| mms_mean_in_system(rho[i], data.servers[i])).collect();

    let premise = if disjoint_classes {
        format!(
            "All inter-arrival and service distributions are exponential and buffers are infinite. \
             This document holds {} customer classes, but no station is visited by more than \
             one of them, so they are disjoint sub-networks rather than streams competing for a \
             server: every station sees a single exponential class, and the document as a whole is \
             the same stochastic object as one single-class Jackson network over all {} stations.",
            data.k, d
        )
    } else {
        "All inter-arrival and service distributions are exponential, buffers are infinite, \
         and there is a single customer class."
            .to_string()
    };
    let detail = if disjoint_classes {
        format!("Open Jackson network — exact M/M/s product form ({} classes, no shared station)", data.k)
    } else {
        "Open Jackson network — exact M/M/s product form".to_string()
    };

    Some(Assessment {
        kind: Kind::ExactJackson,
        title: TRACTABLE.into(),
        detail,
        means,
        means_label: "Exact E[N]  (Jackson)".into(),
        explanation: format!(
            "{premise} By Jackson's theorem the stationary \
             joint distribution of station populations factorises; each station i behaves \
             as an independent M/M/sᵢ queue with\n    \
             ρᵢ = αᵢ / (sᵢ · μᵢ)  < 1\n    \
             E[Nᵢ] = closed-form M/M/sᵢ mean (Erlang-C for sᵢ > 1, ρᵢ/(1−ρᵢ) for sᵢ = 1)."
        ),
    })
}

/// The mean number in system of an M/M/s queue at utilisation ρ (`mmsMeanInSystem`): ρ/(1 − ρ)
/// for one server, otherwise Erlang-C with offered load a = ρs, E[N] = Lq + a.
fn mms_mean_in_system(rho: f64, servers: i64) -> f64 {
    let s = if servers >= 1 { servers } else { 1 };
    if s == 1 {
        return rho / (1.0 - rho);
    }
    let a = rho * s as f64;
    let mut sum = 0.0;
    let mut term = 1.0;
    for n in 0..s {
        if n > 0 {
            term *= a / n as f64;
        }
        sum += term;
    }
    let a_s_over_s_fact = term * a / s as f64;
    let c = a_s_over_s_fact / (1.0 - rho) / (sum + a_s_over_s_fact / (1.0 - rho));
    let lq = c * rho / (1.0 - rho);
    lq + a
}

/// The Harrison–Williams (1987) result: 2Γ = R·diag(Γ/Rᵢᵢ) + diag(Γ/Rᵢᵢ)·R⊤ element-wise, and then
/// E[Zₖ] = Γₖₖ / (2 Rₖₖ δₖ) with δ = −R⁻¹μ (`skewSymmetricResult`).
fn skew_symmetric_result(r: &[Vec<f64>], gamma: &[Vec<f64>], mu: &[f64], d: usize) -> Option<Assessment> {
    let mut dd = vec![0.0; d];
    for i in 0..d {
        if !(r[i][i] > 1e-12 && gamma[i][i] > 1e-12) {
            return None;
        }
        dd[i] = gamma[i][i] / r[i][i];
    }

    let tol = 1e-6;
    for i in 0..d {
        for j in 0..d {
            let lhs = 2.0 * gamma[i][j];
            let rhs = r[i][j] * dd[j] + dd[i] * r[j][i];
            let scale = swift_max(swift_max(1.0, lhs.abs()), rhs.abs());
            if (lhs - rhs).abs() > tol * scale {
                return None;
            }
        }
    }

    let delta = solve_linear_system(r, &negate(mu), d)?;
    if delta.iter().any(|&x| x <= 0.0) {
        return None;
    }
    let means: Vec<f64> = (0..d).map(|k| gamma[k][k] / (2.0 * r[k][k] * delta[k])).collect();

    Some(Assessment {
        kind: Kind::ExactSkewSymmetric,
        title: TRACTABLE.into(),
        detail: "SRBM skew-symmetric case — Harrison–Williams 1987 exact product form".into(),
        means,
        means_label: "Exact E[X]  (skew-sym)".into(),
        explanation: "The SRBM data (Γ, R) satisfy the Harrison–Williams (1987) skew-symmetry condition\n    \
                      2 Γ = R · diag(Γ/Rᵢᵢ) + diag(Γ/Rᵢᵢ) · R⊤,\n\
                      so the stationary distribution of Z is a product of independent exponentials with\n    \
                      E[Zₖ] = Γₖₖ / (2 Rₖₖ δₖ),   δ = −R⁻¹μ."
            .into(),
    })
}

/// The GCDG 2025 asymptotic means E[Zₖ] ≈ mₖ / δₖ, with δ = −R⁻¹μ and
/// mₖ = uₖ⊤Γuₖ / (2 uₖ⊤R_{:,k}), uₖ = eₖ with its first k entries solving
/// Σ_{j<k} w_j R_{j,ℓ} + R_{k,ℓ} = 0 for ℓ < k (`gcdgMeans`). Empty on any numerical failure.
fn gcdg_means(r: &[Vec<f64>], gamma: &[Vec<f64>], mu: &[f64], d: usize) -> Vec<f64> {
    let mut means = vec![0.0; d];
    let Some(delta) = solve_linear_system(r, &negate(mu), d) else {
        return Vec::new();
    };
    if delta.iter().any(|&x| !(x > 0.0)) {
        return Vec::new();
    }

    for k in 0..d {
        let mut u = vec![0.0; d];
        u[k] = 1.0;
        if k >= 1 {
            let mut a = vec![vec![0.0; k]; k];
            let mut b = vec![0.0; k];
            for ell in 0..k {
                for j in 0..k {
                    a[ell][j] = r[j][ell];
                }
                b[ell] = -r[k][ell];
            }
            let Some(w) = solve_linear_system(&a, &b, k) else {
                return Vec::new();
            };
            u[..k].copy_from_slice(&w[..k]);
        }

        let mut num = 0.0;
        for i in 0..d {
            let mut row_sum = 0.0;
            for j in 0..d {
                row_sum += gamma[i][j] * u[j];
            }
            num += u[i] * row_sum;
        }
        let mut denom = 0.0;
        for i in 0..d {
            denom += u[i] * r[i][k];
        }
        denom *= 2.0;

        if !(denom.abs() > 1e-14) {
            return Vec::new();
        }
        means[k] = num / denom / delta[k];
        if !means[k].is_finite() {
            return Vec::new();
        }
    }
    means
}

/// A topological order π of the routing graph read from R, so that R[π[a]][π[b]] is
/// lower-triangular, or None when the graph has a cycle or a self-loop
/// (`permutationForLowerTriangular`). An edge u → v is −R[v][u] > 1e-12; a self-loop is
/// 1 − R[u][u] > 1e-9.
fn permutation_for_lower_triangular(r: &[Vec<f64>], d: usize) -> Option<Vec<usize>> {
    if (0..d).any(|u| 1.0 - r[u][u] > 1e-9) {
        return None;
    }
    let mut in_deg = vec![0usize; d];
    for v in 0..d {
        for u in 0..d {
            if u != v && -r[v][u] > 1e-12 {
                in_deg[v] += 1;
            }
        }
    }
    let mut queue: VecDeque<usize> = (0..d).filter(|&i| in_deg[i] == 0).collect();
    let mut order = Vec::with_capacity(d);
    while let Some(u) = queue.pop_front() {
        order.push(u);
        for v in 0..d {
            if u != v && -r[v][u] > 1e-12 {
                in_deg[v] -= 1;
                if in_deg[v] == 0 {
                    queue.push_back(v);
                }
            }
        }
    }
    if order.len() == d {
        Some(order)
    } else {
        None
    }
}

/// M[π[a]][π[b]] for all a, b.
fn permute_matrix(m: &[Vec<f64>], perm: &[usize]) -> Vec<Vec<f64>> {
    perm.iter().map(|&pa| perm.iter().map(|&pb| m[pa][pb]).collect()).collect()
}

/// Positive diagonal (> 1e-12), off-diagonals at most 1e-9, and every entry of R⁻¹ at least −1e-9
/// (`isMMatrix`).
fn is_m_matrix(r: &[Vec<f64>], d: usize) -> bool {
    for i in 0..d {
        if r[i][i] <= 1e-12 {
            return false;
        }
        for j in 0..d {
            if j != i && r[i][j] > 1e-9 {
                return false;
            }
        }
    }
    let Some(inv) = invert_matrix(r, d) else {
        return false;
    };
    !inv.iter().any(|row| row.iter().any(|&x| x < -1e-9))
}

/// Every principal minor above 1e-12, by enumerating the 2^d − 1 subsets; refused (false) outside
/// 1 ≤ d ≤ 6 (`isPMatrix`).
fn is_p_matrix(r: &[Vec<f64>], d: usize) -> bool {
    if !(1..=6).contains(&d) {
        return false;
    }
    let n = 1usize << d;
    for mask in 1..n {
        let idx: Vec<usize> = (0..d).filter(|&i| (mask >> i) & 1 == 1).collect();
        let k = idx.len();
        let sub: Vec<Vec<f64>> = idx.iter().map(|&a| idx.iter().map(|&b| r[a][b]).collect()).collect();
        if determinant(&sub, k) <= 1e-12 {
            return false;
        }
    }
    true
}

/// Gaussian elimination with partial pivoting; None when a pivot is below 1e-14
/// (`solveLinearSystem`).
fn solve_linear_system(a: &[Vec<f64>], b: &[f64], d: usize) -> Option<Vec<f64>> {
    if d == 0 {
        return Some(Vec::new());
    }
    let mut m: Vec<Vec<f64>> = a.to_vec();
    let mut rhs: Vec<f64> = b.to_vec();
    for i in 0..d {
        let mut piv = i;
        let mut best = m[i][i].abs();
        for r in (i + 1)..d {
            if m[r][i].abs() > best {
                best = m[r][i].abs();
                piv = r;
            }
        }
        if best < 1e-14 {
            return None;
        }
        if piv != i {
            m.swap(i, piv);
            rhs.swap(i, piv);
        }
        for r in (i + 1)..d {
            let f = m[r][i] / m[i][i];
            if f == 0.0 {
                continue;
            }
            for c in i..d {
                m[r][c] -= f * m[i][c];
            }
            rhs[r] -= f * rhs[i];
        }
    }
    let mut x = vec![0.0; d];
    for i in (0..d).rev() {
        let mut s = rhs[i];
        for c in (i + 1)..d {
            s -= m[i][c] * x[c];
        }
        x[i] = s / m[i][i];
    }
    Some(x)
}

/// R⁻¹ column by column (`invertMatrix`).
fn invert_matrix(a: &[Vec<f64>], d: usize) -> Option<Vec<Vec<f64>>> {
    let mut inv = vec![vec![0.0; d]; d];
    for k in 0..d {
        let mut e = vec![0.0; d];
        e[k] = 1.0;
        let col = solve_linear_system(a, &e, d)?;
        for i in 0..d {
            inv[i][k] = col[i];
        }
    }
    Some(inv)
}

/// The determinant by pivoted elimination, closed forms for n = 1 and 2 (`determinant`).
fn determinant(a: &[Vec<f64>], n: usize) -> f64 {
    if n == 1 {
        return a[0][0];
    }
    if n == 2 {
        return a[0][0] * a[1][1] - a[0][1] * a[1][0];
    }
    let mut m: Vec<Vec<f64>> = a.to_vec();
    let mut det = 1.0;
    for i in 0..n {
        let mut piv = i;
        let mut best = m[i][i].abs();
        for r in (i + 1)..n {
            if m[r][i].abs() > best {
                best = m[r][i].abs();
                piv = r;
            }
        }
        if best < 1e-14 {
            return 0.0;
        }
        if piv != i {
            m.swap(i, piv);
            det = -det;
        }
        det *= m[i][i];
        for r in (i + 1)..n {
            let f = m[r][i] / m[i][i];
            for c in i..n {
                m[r][c] -= f * m[i][c];
            }
        }
    }
    det
}

fn negate(v: &[f64]) -> Vec<f64> {
    v.iter().map(|x| -x).collect()
}

/// The classical d × d reflection matrix: the lower-face columns (2k) of the exporter's
/// interleaved d × 2d R (`lowerFaceR`).
fn lower_face_r(r2d: &[Vec<f64>], d: usize) -> Vec<Vec<f64>> {
    (0..d).map(|i| (0..d).map(|k| r2d[i][2 * k]).collect()).collect()
}

/// The explanation shared by the three GCDG corollaries (`gcdgExplanation`).
fn gcdg_explanation(corollary: i64, reason: &str) -> String {
    format!(
        "Under the GCDG 2025 multi-scaling regime (traffic-slackness δᵢ = rⁱ), the stationary \
         distribution of the scaled SRBM (rZ₁, r²Z₂, …) converges to a product of independent \
         exponentials with explicit means mₖ = uₖ⊤Γuₖ / (2 uₖ⊤R_{{:,k}}) (Theorem 1, eqs. 2.4–2.6). \
         The reported mean is E[Zₖ] ≈ mₖ / δₖ with this network's slackness δ = −R⁻¹θ. Corollary \
         {corollary} applies because {reason}\n\
         Reference: Guang, Chen, Dai, Glynn (2025). arXiv:2503.19710, Remark 2 & Cor. {corollary}."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Link, ServiceConfig};
    use crate::traffic::compute;

    /// One station of a test network: its name's number, distribution, parameters and servers.
    struct St(Distribution, &'static str, i64);

    /// A network with one Poisson(λ) source into S1, a buffer in front of every station, the
    /// routes (from, to, probability) between stations (0-based), and the rest of each station's
    /// output to a sink.
    fn network(lambda: f64, stations: &[St], routes: &[(usize, usize, f64)]) -> (Vec<Node>, Vec<Link>) {
        let mut nodes = Vec::new();
        let mut links = Vec::new();
        let mut link = |from: String, to: String, probability: f64| {
            let id = format!("L{}", links.len());
            links.push(Link { id, from, to, probability, class: 0, to_class: None });
        };
        let mut src = Node::new("SRC", NodeKind::Source, "Src1", (0.0, 0.0));
        src.distribution = Distribution::Poisson;
        src.parameters = format!("lambda={lambda}");
        nodes.push(src);
        nodes.push(Node::new("SINK", NodeKind::Sink, "Sink1", (0.0, 0.0)));
        for (i, s) in stations.iter().enumerate() {
            let mut st = Node::new(format!("S{i}"), NodeKind::Station, format!("S{}", i + 1), (0.0, 0.0));
            st.distribution = s.0;
            st.parameters = s.1.to_string();
            st.servers = s.2;
            nodes.push(st);
            nodes.push(Node::new(format!("B{i}"), NodeKind::Buffer, format!("B{}", i + 1), (0.0, 0.0)));
            link(format!("B{i}"), format!("S{i}"), 1.0);
        }
        link("SRC".into(), "B0".into(), 1.0);
        for i in 0..stations.len() {
            let mut out = 0.0;
            for &(from, to, p) in routes.iter().filter(|r| r.0 == i) {
                link(format!("S{from}"), format!("B{to}"), p);
                out += p;
            }
            if out < 1.0 - 1e-12 {
                link(format!("S{i}"), "SINK".into(), 1.0 - out);
            }
        }
        (nodes, links)
    }

    fn assess_network(lambda: f64, stations: &[St], routes: &[(usize, usize, f64)], allow_gcdg: bool) -> (SrbmData, Assessment) {
        let (nodes, links) = network(lambda, stations, routes);
        let data = compute(&nodes, &links, true, false, false).unwrap();
        let a = assess(&data, &nodes, true, allow_gcdg);
        (data, a)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9 * swift_max(1.0, b.abs())
    }

    const EXP: Distribution = Distribution::Exponential;
    const DET: Distribution = Distribution::Constant;

    #[test]
    fn an_mm1_station_is_jackson_with_mean_rho_over_one_minus_rho() {
        let (_, a) = assess_network(0.8, &[St(EXP, "rate=1.0", 1)], &[], true);
        assert_eq!(a.kind, Kind::ExactJackson);
        assert!(a.is_tractable() && a.is_exact());
        assert_eq!(a.detail, "Open Jackson network — exact M/M/s product form");
        assert_eq!(a.means_label, "Exact E[N]  (Jackson)");
        assert!(close(a.means[0], 0.8 / 0.2), "{:?}", a.means);
        assert!(a.explanation.starts_with("All inter-arrival and service distributions are exponential, buffers are infinite, and there is a single customer class. By Jackson's theorem"));
        assert!(a.explanation.ends_with("as an independent M/M/sᵢ queue with\n    ρᵢ = αᵢ / (sᵢ · μᵢ)  < 1\n    E[Nᵢ] = closed-form M/M/sᵢ mean (Erlang-C for sᵢ > 1, ρᵢ/(1−ρᵢ) for sᵢ = 1)."));
    }

    #[test]
    fn an_mm2_station_has_the_erlang_c_mean_two_rho_over_one_minus_rho_squared() {
        // λ = 1.6, μ = 1, s = 2: ρ = 0.8 and E[N] = 2ρ/(1 − ρ²) = 40/9.
        let (_, a) = assess_network(1.6, &[St(EXP, "rate=1.0", 2)], &[], false);
        assert_eq!(a.kind, Kind::ExactJackson);
        assert!(close(a.means[0], 40.0 / 9.0), "{:?}", a.means);
    }

    #[test]
    fn jackson_needs_exponential_service_for_the_visiting_class_only() {
        let (mut nodes, links) = network(0.5, &[St(EXP, "rate=1.0", 1)], &[]);
        let data = compute(&nodes, &links, true, false, false).unwrap();
        nodes[2].service_by_class.insert(3, ServiceConfig { distribution: DET, parameters: "value=1.0".into() });
        assert_eq!(assess(&data, &nodes, true, true).kind, Kind::ExactJackson, "class 3 never visits");
        nodes[2].service_by_class.insert(0, ServiceConfig { distribution: DET, parameters: "value=1.0".into() });
        assert_ne!(assess(&data, &nodes, true, true).kind, Kind::ExactJackson);
        assert_ne!(assess(&data, &network(0.5, &[St(EXP, "rate=1.0", 1)], &[]).0, false, true).kind, Kind::ExactJackson, "finite buffers");
    }

    #[test]
    fn a_single_md1_station_is_skew_symmetric_with_mean_gamma_over_twice_the_slack() {
        // Poisson(0.8) into a constant service of rate 1: Γ = λ·1 + α·0 = 0.8, δ = c − α = 0.2.
        let (data, a) = assess_network(0.8, &[St(DET, "value=1.0", 1)], &[], false);
        assert!((data.gamma[0][0] - 0.8).abs() < 1e-12);
        assert_eq!(a.kind, Kind::ExactSkewSymmetric);
        assert!(a.is_exact());
        assert_eq!(a.detail, "SRBM skew-symmetric case — Harrison–Williams 1987 exact product form");
        assert_eq!(a.means_label, "Exact E[X]  (skew-sym)");
        assert!(close(a.means[0], 0.8 / (2.0 * 0.2)), "{:?}", a.means);
    }

    #[test]
    fn a_tandem_with_a_deterministic_first_station_is_gcdg_corollary_3() {
        // S1 (constant, rate 2) → S2 (exponential, rate 1), λ = 0.5. R = [[1, 0], [−1, 1]], so
        // u₁ = e₁ and u₂ = (1, 1): E[Z₁] = Γ₁₁ / (2δ₁), E[Z₂] = (Γ₁₁ + 2Γ₁₂ + Γ₂₂) / (2δ₂).
        let st = [St(DET, "value=0.5", 1), St(EXP, "rate=1.0", 1)];
        let (data, a) = assess_network(0.5, &st, &[(0, 1, 1.0)], true);
        assert_eq!(a.kind, Kind::AsymptoticLowerTriangular);
        assert!(a.is_tractable() && !a.is_exact());
        assert_eq!(a.detail, "Asymptotic product form — GCDG 2025 Cor. 3 (lower-triangular R, feed-forward)");
        assert_eq!(a.means_label, "Asymptotic E[X]");
        let g = &data.gamma;
        let (d1, d2) = (2.0 - 0.5, 1.0 - 0.5);
        assert!(close(a.means[0], g[0][0] / (2.0 * d1)), "{:?}", a.means);
        assert!(close(a.means[1], (g[0][0] + 2.0 * g[0][1] + g[1][1]) / (2.0 * d2)), "{:?}", a.means);
        assert!(a.explanation.ends_with("Corollary 3 applies because the reflection matrix R = I − P⊤ is lower-triangular, which arises whenever the network is feed-forward with station numbering respected (e.g. tandem, acyclic layered).\nReference: Guang, Chen, Dai, Glynn (2025). arXiv:2503.19710, Remark 2 & Cor. 3."));
        // Without GCDG the same network has no exact form.
        let (_, off) = assess_network(0.5, &st, &[(0, 1, 1.0)], false);
        assert_eq!(off.kind, Kind::None);
        assert_eq!(off.explanation, "No exact closed-form distribution matches this network. GCDG 2025 asymptotic approximation is disabled in Settings ▸ GCDG.");
    }

    #[test]
    fn a_tandem_numbered_against_the_flow_is_relabelled_for_corollary_3() {
        // S1 → S3 → S2, all deterministic: the order is (S1, S3, S2), and the means come back in
        // the user's numbering. The second station of the flow has u = (1, 1) in the relabelled
        // coordinates, the third (S2) u = (1, 1, 1): each mean is the sum of Γ over the stations
        // up to it, over twice its slack.
        let st = [St(DET, "value=0.5", 1), St(DET, "value=0.5", 1), St(DET, "value=0.5", 1)];
        let (data, a) = assess_network(0.5, &st, &[(0, 2, 1.0), (2, 1, 1.0)], true);
        assert_eq!(a.kind, Kind::AsymptoticLowerTriangular);
        assert_eq!(a.detail, "Asymptotic product form — GCDG 2025 Cor. 3 (feed-forward, station relabel applied)");
        let g = &data.gamma;
        let delta = 2.0 - 0.5;
        assert!(close(a.means[0], g[0][0] / (2.0 * delta)), "{:?}", a.means);
        assert!(close(a.means[2], (g[0][0] + 2.0 * g[0][2] + g[2][2]) / (2.0 * delta)), "{:?}", a.means);
        let all: f64 = g.iter().flatten().sum();
        assert!(close(a.means[1], all / (2.0 * delta)), "{:?}", a.means);
        assert_eq!(permutation_for_lower_triangular(&lower_face_r(&data.r, 3), 3), Some(vec![0, 2, 1]));
    }

    #[test]
    fn a_two_station_feedback_loop_is_gcdg_corollary_2() {
        // S1 → S2, S2 → S1 with ½; both deterministic, so not skew-symmetric. R = [[1, −½], [−1, 1]]
        // has minors 1, 1, ½; u₂ = (1, 1) and 2u₂⊤R_{:,2} = 1, so E[Z₂] = (Γ₁₁ + 2Γ₁₂ + Γ₂₂) / δ₂.
        let st = [St(DET, "value=0.25", 1), St(DET, "value=0.25", 1)];
        let (data, a) = assess_network(1.0, &st, &[(0, 1, 1.0), (1, 0, 0.5)], true);
        assert_eq!(a.kind, Kind::Asymptotic2D);
        assert_eq!(a.detail, "Asymptotic product form — GCDG 2025 Cor. 2 (d = 2, P-matrix R)");
        // α = (2, 2), c = (4, 4): δ = c − α.
        let g = &data.gamma;
        assert!(close(a.means[0], g[0][0] / (2.0 * 2.0)), "{:?}", a.means);
        assert!(close(a.means[1], (g[0][0] + 2.0 * g[0][1] + g[1][1]) / 2.0), "{:?}", a.means);
    }

    #[test]
    fn a_three_station_loop_is_gcdg_corollary_1() {
        // S1 → S2 → S3, S3 → S1 with ½. R = [[1, 0, −½], [−1, 1, 0], [0, −1, 1]]: u₂ = (1, 1, 0) with
        // 2u⊤R_{:,2} = 2, u₃ = (1, 1, 1) with 2u⊤R_{:,3} = 1.
        let st = [St(DET, "value=0.25", 1), St(DET, "value=0.25", 1), St(DET, "value=0.25", 1)];
        let (data, a) = assess_network(1.0, &st, &[(0, 1, 1.0), (1, 2, 1.0), (2, 0, 0.5)], true);
        assert_eq!(a.kind, Kind::AsymptoticMMatrix);
        assert_eq!(a.detail, "Asymptotic product form — GCDG 2025 Cor. 1 (R is an M-matrix)");
        let g = &data.gamma;
        let delta = 4.0 - 2.0;
        let q = |n: usize| -> f64 { (0..n).flat_map(|i| (0..n).map(move |j| (i, j))).map(|(i, j)| g[i][j]).sum() };
        assert!(close(a.means[0], g[0][0] / (2.0 * delta)), "{:?}", a.means);
        assert!(close(a.means[1], q(2) / (2.0 * delta)), "{:?}", a.means);
        assert!(close(a.means[2], q(3) / delta), "{:?}", a.means);
    }

    #[test]
    fn an_overloaded_station_is_not_assessed() {
        let (_, a) = assess_network(1.2, &[St(EXP, "rate=1.0", 1)], &[], true);
        assert_eq!(a.kind, Kind::None);
        assert!(!a.is_tractable());
        assert_eq!((a.title.as_str(), a.detail.as_str(), a.means_label.as_str()), ("", "", ""));
        assert!(a.means.is_empty());
        assert_eq!(a.explanation, "Tractability analysis not applied: one or more stations are unstable (ρ ≥ 1) or receive no traffic.");
    }

    #[test]
    fn routing_cycles_are_self_loops_or_what_kahn_cannot_peel() {
        assert!(!has_routing_cycles(&[]));
        assert!(!has_routing_cycles(&[vec![0.0, 1.0], vec![0.0, 0.0]]));
        assert!(has_routing_cycles(&[vec![0.1, 0.0], vec![0.0, 0.0]]));
        assert!(has_routing_cycles(&[vec![0.0, 1.0], vec![0.5, 0.0]]));
        assert!(!has_routing_cycles(&[vec![0.0, 1e-13], vec![0.5, 0.0]]), "1e-13 is not an edge");
    }

    #[test]
    fn the_p_matrix_and_determinant_tests_follow_their_tolerances() {
        assert!(is_p_matrix(&[vec![1.0, -0.5], vec![-1.0, 1.0]], 2));
        assert!(!is_p_matrix(&[vec![1.0, -1.0], vec![-1.0, 1.0]], 2), "a zero minor");
        let i3 = vec![vec![2.0, 0.0, 0.0], vec![0.0, 3.0, 0.0], vec![0.0, 0.0, 4.0]];
        assert_eq!(determinant(&i3, 3), 24.0);
        assert!(!is_p_matrix(&vec![vec![1.0; 7]; 7], 7), "refused above d = 6");
    }
}
