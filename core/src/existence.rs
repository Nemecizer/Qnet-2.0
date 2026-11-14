//! Does an SRBM with these data exist, and is it positive recurrent? (0.90.34 `SRBMExistence.swift`)
//!
//! Both questions are decided from the drift θ and the reflection directions alone. In the orthant
//! an SRBM exists, and is unique in law, if and only if R is completely-S (Reiman–Williams 1988,
//! Taylor–Williams 1993). In a box the Dai–Williams (1995) condition is sufficient. Positive
//! recurrence (orthant only): R⁻¹θ < 0 is necessary; sufficient with an M-matrix R
//! (Harrison–Williams 1987), with a P-matrix R in d = 2 (El Kharroubi–Ben Tahar–Yaacoubi 2000), and
//! decided exactly in d = 3 (Bramson–Dai–Harrison 2010). Otherwise the answer is "undecided",
//! never a guess. Every statement is shown to the user verbatim.
//!
//! Every decision is made on the double-precision data as given. An S-matrix test returns a witness
//! vector and checks it against a rounding-error bound, so "yes" and "no" both rest on an inequality
//! that holds exactly; the few scalar comparisons of the 2-D and 3-D procedures use a relative band
//! of `BOUNDARY_TOLERANCE`, and data inside it are reported undecided rather than rounded to a side.
//! The arithmetic, loop orders and sentences follow 0.90.34 step for step, because the statements are
//! compared byte for byte with its output.

use crate::traffic::SrbmData;

/// Relative width of the band around a decision boundary inside which the 2-D and 3-D procedures
/// decline to decide.
pub const BOUNDARY_TOLERANCE: f64 = 1e-10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Holds,
    Fails,
    Undecided,
}

impl Outcome {
    /// The raw value 0.90.34 printed ("holds", "fails", "undecided").
    pub fn raw(self) -> &'static str {
        match self {
            Outcome::Holds => "holds",
            Outcome::Fails => "fails",
            Outcome::Undecided => "undecided",
        }
    }
}

/// One answered question: the outcome and a sentence naming the theorem it rests on.
#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub outcome: Outcome,
    pub statement: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    /// Does the SRBM exist (and is it unique in law)?
    pub existence: Finding,
    /// Is it positive recurrent? None when existence did not hold, and always for a box.
    pub recurrence: Option<Finding>,
}

impl Verdict {
    /// True only when both questions were answered "holds".
    pub fn is_usable(&self) -> bool {
        self.existence.outcome == Outcome::Holds && self.recurrence.as_ref().is_some_and(|r| r.outcome == Outcome::Holds)
    }

    /// One line for a status banner. "Undefined" and "not positive recurrent" are never merged.
    pub fn headline(&self) -> String {
        match self.existence.outcome {
            Outcome::Fails => return format!("SRBM undefined: {}", self.existence.statement),
            Outcome::Undecided => return format!("SRBM existence undecided: {}", self.existence.statement),
            Outcome::Holds => {}
        }
        let Some(r) = &self.recurrence else { return self.existence.statement.clone() };
        match r.outcome {
            Outcome::Holds => r.statement.clone(),
            Outcome::Fails => format!("SRBM not positive recurrent: {}", r.statement),
            Outcome::Undecided => format!("SRBM stability undecided: {}", r.statement),
        }
    }
}

/// The S-matrix test's answer: there is a witness, there provably isn't, or it's on the boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SDecision {
    Yes,
    No,
    Boundary,
}

/// Classifies an orthant SRBM with reflection matrix `r` (column j is the direction on face
/// {z_j = 0}) and drift `theta` (`classifyOrthant`, default `enumerationLimit` 16).
pub fn classify_orthant(r: &[Vec<f64>], theta: &[f64], enumeration_limit: usize) -> Verdict {
    let d = theta.len();
    let shaped = d > 0
        && r.len() == d
        && r.iter().all(|row| row.len() == d)
        && theta.iter().all(|x| x.is_finite())
        && r.iter().all(|row| row.iter().all(|x| x.is_finite()));
    if !shaped {
        return Verdict {
            existence: finding(Outcome::Fails, "the drift and reflection matrix do not have matching finite dimensions."),
            recurrence: None,
        };
    }
    let existence = completely_s(r, enumeration_limit);
    if existence.outcome != Outcome::Holds {
        return Verdict { existence, recurrence: None };
    }
    let recurrence = orthant_recurrence(r, theta);
    Verdict { existence, recurrence: Some(recurrence) }
}

/// The completely-S test with a named failing principal submatrix (`completelyS`).
pub fn completely_s(r: &[Vec<f64>], enumeration_limit: usize) -> Finding {
    let d = r.len();
    // A Z-matrix is an S-matrix exactly when it is a nonsingular M-matrix, and then every principal
    // submatrix is one too, so one test settles all 2^d − 1 of them.
    if is_z_matrix(r) {
        let whole = s_matrix(r);
        if whole == SDecision::Yes {
            return finding(
                Outcome::Holds,
                "R is a nonsingular M-matrix, so it is completely-S and the SRBM exists and is unique in law.",
            );
        }
        // Otherwise enumerate to name the smallest failing set, if affordable.
        if d > enumeration_limit {
            let all: Vec<usize> = (0..d).collect();
            return if whole == SDecision::No {
                Finding {
                    outcome: Outcome::Fails,
                    statement: format!(
                        "R is a Z-matrix but not a nonsingular M-matrix, so it is not completely-S and no SRBM with this reflection matrix exists (Taylor–Williams 1993).{}",
                        cycle_hint(r, &all)
                    ),
                }
            } else {
                Finding {
                    outcome: Outcome::Undecided,
                    statement: format!(
                        "R is a Z-matrix within rounding error of a singular M-matrix, so existence can be neither shown nor refuted.{}",
                        cycle_hint(r, &all)
                    ),
                }
            };
        }
    }
    if d > enumeration_limit {
        return Finding {
            outcome: Outcome::Undecided,
            statement: format!(
                "R is not a Z-matrix and d = {d} exceeds the {enumeration_limit}-dimension limit for checking its 2^d − 1 principal submatrices."
            ),
        };
    }

    let mut saw_boundary: Option<Vec<usize>> = None;
    for mask in masks_by_size(d) {
        let idx = indices(mask, d);
        match s_matrix(&principal(r, &idx)) {
            SDecision::Yes => continue,
            SDecision::No => {
                return Finding {
                    outcome: Outcome::Fails,
                    statement: format!(
                        "R is not completely-S: its principal submatrix on coordinates {} is not an S-matrix, so no SRBM with this reflection matrix exists (Taylor–Williams 1993).{}",
                        label(&idx),
                        cycle_hint(r, &idx)
                    ),
                };
            }
            SDecision::Boundary => {
                if saw_boundary.is_none() {
                    saw_boundary = Some(idx);
                }
            }
        }
    }
    if let Some(idx) = saw_boundary {
        return Finding {
            outcome: Outcome::Undecided,
            statement: format!(
                "the principal submatrix of R on coordinates {} lies within rounding error of the boundary of the S-matrices, so existence can be neither shown nor refuted.{}",
                label(&idx),
                cycle_hint(r, &idx)
            ),
        };
    }
    finding(
        Outcome::Holds,
        "every principal submatrix of R is an S-matrix, so R is completely-S and the SRBM exists and is unique in law.",
    )
}

/// Positive recurrence in the orthant, given that R is completely-S (`orthantRecurrence`).
fn orthant_recurrence(r: &[Vec<f64>], theta: &[f64]) -> Finding {
    let d = theta.len();
    // Completely-S implies a positive diagonal; scale each column to 1.
    let rn = normalized_columns(r);

    // R⁻¹θ < 0, decided with a forward-error bound from cond(R). With Rn = R·diag(R_jj)⁻¹,
    // u = −Rn⁻¹θ has u_k = −R_kk (R⁻¹θ)_k: the same signs.
    let neg_theta: Vec<f64> = theta.iter().map(|x| -x).collect();
    let (Some(u), Some(inv)) = (solve(&rn, &neg_theta), inverse(&rn)) else {
        return finding(Outcome::Undecided, "R is numerically singular, so R⁻¹θ < 0 cannot be evaluated.");
    };
    let cond = inf_norm(&rn) * inf_norm(&inv);
    let u_norm = swift_seq_max(u.iter().map(|x| x.abs())).unwrap_or(0.0);
    let band = swift_max(BOUNDARY_TOLERANCE, (10 * d) as f64 * cond * f64::EPSILON) * u_norm;
    if let Some(k) = u.iter().position(|&x| x < -band) {
        return Finding {
            outcome: Outcome::Fails,
            statement: format!(
                "component {} of R⁻¹θ is positive ({}), so the SRBM has no stationary distribution (El Kharroubi–Ben Tahar–Yaacoubi 2000). For a single-class network this is a station with ρ ≥ 1.",
                k + 1,
                fmt(-u[k] / r[k][k])
            ),
        };
    }
    if let Some(k) = u.iter().position(|&x| x <= band) {
        return Finding {
            outcome: Outcome::Undecided,
            statement: format!("component {} of R⁻¹θ is zero to within rounding, the boundary of stability.", k + 1),
        };
    }

    if is_z_matrix(r) {
        return finding(Outcome::Holds, "positive recurrent: R is an M-matrix and R⁻¹θ < 0 (Harrison–Williams 1987).");
    }
    match d {
        // A 1×1 completely-S matrix is positive, hence a Z-matrix.
        1 => finding(Outcome::Holds, "positive recurrent: R⁻¹θ < 0 in one dimension."),
        2 => {
            // Completely-S gives a positive diagonal, so P-matrix ⇔ det R > 0.
            let det = diff_of_products(r[0][0], r[1][1], r[0][1], r[1][0]);
            if det > 0.0 {
                return finding(
                    Outcome::Holds,
                    "positive recurrent: R is a P-matrix and R⁻¹θ < 0, which is exact in two dimensions (El Kharroubi–Ben Tahar–Yaacoubi 2000).",
                );
            }
            finding(
                Outcome::Fails,
                "R is not a P-matrix (det R ≤ 0), which in two dimensions rules out positive recurrence even though R⁻¹θ < 0 (El Kharroubi–Ben Tahar–Yaacoubi 2000).",
            )
        }
        3 => three_dimensional_recurrence(r, theta),
        _ => Finding {
            outcome: Outcome::Undecided,
            statement: format!(
                "R⁻¹θ < 0 holds, but R is not an M-matrix and d = {d} ≥ 4, where no test for positive recurrence is known (Bramson–Dai–Harrison 2010). The condition that holds is necessary, not sufficient."
            ),
        },
    }
}

/// Bramson–Dai–Harrison (2010), Figure 2, with R⁻¹θ < 0 already established. A divergent solution
/// of the linear complementarity problem v = θ + Ru, u, v ≥ 0, u·v = 0 rules out positive
/// recurrence (Theorem 4); a boundary spiral with gain β ≥ 1 rules it out (Theorem 3); otherwise the
/// SRBM is positive recurrent. Every inequality is a sign of D(i, j) = θ_i R_jj − θ_j R_ij, the
/// paper's unit-diagonal normalization multiplied through by R_jj > 0, so the signs are exact.
fn three_dimensional_recurrence(r: &[Vec<f64>], t: &[f64]) -> Finding {
    let dd = |i: usize, j: usize| diff_of_products(t[i], r[j][j], t[j], r[i][j]);

    match divergent_lcp_solution(r, t, &dd) {
        LcpSearch::Found(support) => {
            return Finding {
                outcome: Outcome::Fails,
                statement: format!(
                    "the fluid model has a divergent linear path pushing on face(s) {}, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 4).",
                    label(&support)
                ),
            };
        }
        LcpSearch::Boundary => {
            return finding(
                Outcome::Undecided,
                "a candidate divergent fluid path lies within rounding of feasibility, so the Bramson–Dai–Harrison test cannot decide.",
            );
        }
        LcpSearch::None => {}
    }

    // Spiral classes C1 (counter-clockwise) and C2 (clockwise), eqs. 3.1–3.4: C1 needs D(0,1),
    // D(1,2), D(2,0) > 0 and D(2,1), D(0,2), D(1,0) < 0.
    let out = [dd(0, 1), dd(1, 2), dd(2, 0)];
    let back = [dd(2, 1), dd(0, 2), dd(1, 0)];
    let in_c1 = out.iter().all(|&x| x > 0.0) && back.iter().all(|&x| x < 0.0);
    let in_c2 = out.iter().all(|&x| x < 0.0) && back.iter().all(|&x| x > 0.0);
    if t.iter().all(|&x| x < 0.0) && (in_c1 || in_c2) {
        // (3.6): β₁ = Π D(i,j) / −D(k,j); R_jj cancels within each factor.
        let beta1 = (out[0] / -back[0]) * (out[1] / -back[1]) * (out[2] / -back[2]);
        let beta = if in_c1 { beta1 } else { 1.0 / beta1 };
        return match compare(beta - 1.0, 1.0) {
            Sign::Negative => Finding {
                outcome: Outcome::Holds,
                statement: format!(
                    "positive recurrent: fluid paths spiral inward on the boundary with cycle gain β = {} < 1 (El Kharroubi–Ben Tahar–Yaacoubi 2002; Bramson–Dai–Harrison 2010).",
                    fmt(beta)
                ),
            },
            Sign::Positive | Sign::Zero => Finding {
                outcome: Outcome::Fails,
                statement: format!(
                    "fluid paths spiral on the boundary with cycle gain β = {} ≥ 1, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 3).",
                    fmt(beta)
                ),
            },
            Sign::Boundary => finding(Outcome::Undecided, "the boundary-spiral gain β is 1 to within rounding."),
        };
    }
    finding(
        Outcome::Holds,
        "positive recurrent: in three dimensions, R⁻¹θ < 0 with no boundary spiral and no divergent fluid path is exact (El Kharroubi–Ben Tahar–Yaacoubi 2002; Bramson–Dai–Harrison 2010).",
    )
}

enum LcpSearch {
    None,
    Found(Vec<usize>),
    Boundary,
}

/// Looks for a solution of the LCP with v ≠ 0, one supported on a proper subset J of the faces:
/// u_J = −R_JJ⁻¹θ_J ≥ 0 and v_K = θ_K + R_KJ u_J ≥ 0 off J. Under R⁻¹θ < 0 every such solution is
/// divergent, J = ∅ is impossible, and a singular 2×2 R_JJ admits none, so this enumeration is
/// complete for d = 3. Only v_K for |J| = 2 is not an exact sign.
fn divergent_lcp_solution(r: &[Vec<f64>], t: &[f64], dd: &dyn Fn(usize, usize) -> f64) -> LcpSearch {
    let mut saw_boundary = false;
    for mask in masks_by_size(3).into_iter().filter(|&m| m != 0b111) {
        let j_set = indices(mask, 3);
        let k_set: Vec<usize> = (0..3).filter(|x| !j_set.contains(x)).collect();
        if j_set.len() == 1 {
            // u_j = −θ_j / R_jj ≥ 0 and v_k = D(k, j) / R_jj ≥ 0.
            let j = j_set[0];
            if t[j] < 0.0 && k_set.iter().all(|&k| dd(k, j) >= 0.0) {
                return LcpSearch::Found(j_set);
            }
            continue;
        }
        let (a, b) = (j_set[0], j_set[1]);
        let det = diff_of_products(r[a][a], r[b][b], r[a][b], r[b][a]);
        if det == 0.0 {
            continue;
        }
        // Cramer: u_a = −D(a, b)/det, u_b = −D(b, a)/det, signs exact.
        let ua = -dd(a, b) / det;
        let ub = -dd(b, a) / det;
        if !(ua >= 0.0 && ub >= 0.0) {
            continue;
        }
        let k = k_set[0];
        let v = t[k] + r[k][a] * ua + r[k][b] * ub;
        match compare(v, t[k].abs() + (r[k][a] * ua).abs() + (r[k][b] * ub).abs()) {
            Sign::Positive | Sign::Zero => {
                let support = j_set.iter().copied().filter(|&x| (if x == a { ua } else { ub }) > 0.0).collect();
                return LcpSearch::Found(support);
            }
            Sign::Negative => continue,
            Sign::Boundary => saw_boundary = true,
        }
    }
    if saw_boundary {
        LcpSearch::Boundary
    } else {
        LcpSearch::None
    }
}

/// Classifies a box SRBM from its lower- and upper-face reflection matrices (`classifyBox`).
///
/// Both are d×d with columns as directions (column i is the direction on face {z_i = 0},
/// respectively {z_i = K_i}); the inward normals are e_i and −e_i. Every set of faces that does not
/// hold both faces of one coordinate meets, so the Dai–Williams condition is checked on all 3^d − 1
/// of them, up to 10 dimensions.
pub fn classify_box(lower: &[Vec<f64>], upper: &[Vec<f64>]) -> Verdict {
    const ENUMERATION_LIMIT: usize = 10;
    let d = lower.len();
    let shaped = d > 0
        && upper.len() == d
        && lower.iter().all(|row| row.len() == d && row.iter().all(|x| x.is_finite()))
        && upper.iter().all(|row| row.len() == d && row.iter().all(|x| x.is_finite()));
    if !shaped {
        return Verdict {
            existence: finding(Outcome::Fails, "the box reflection directions do not have matching finite dimensions."),
            recurrence: None,
        };
    }
    if d > ENUMERATION_LIMIT {
        return Verdict {
            existence: Finding {
                outcome: Outcome::Undecided,
                statement: format!(
                    "d = {d} exceeds the {ENUMERATION_LIMIT}-dimension limit for checking the 3^d − 1 face sets of the box."
                ),
            },
            recurrence: None,
        };
    }

    // G[a][b] = n_a · r_b over all 2d faces: face f < d is the lower face of coordinate f, face
    // f ≥ d the upper face of coordinate f − d.
    let g: Vec<Vec<f64>> = (0..2 * d)
        .map(|a| {
            (0..2 * d)
                .map(|b| {
                    let r = if b < d { lower[a % d][b] } else { upper[a % d][b - d] };
                    if a < d {
                        r
                    } else {
                        -r
                    }
                })
                .collect()
        })
        .collect();

    // Every meeting face set lies within one vertex's d faces, so the condition says each vertex
    // matrix [NᵀR]_vertex is completely-S. A matrix is completely-S exactly when its transpose is
    // (Dai–Williams 1995, Proposition 1.1), so the [RᵀN]_I half is not tested again.
    let total = 3usize.pow(d as u32);
    let mut saw_boundary: Option<Vec<usize>> = None;
    for code in 1..total {
        let mut faces: Vec<usize> = Vec::new();
        let mut c = code;
        for i in 0..d {
            match c % 3 {
                1 => faces.push(i),
                2 => faces.push(i + d),
                _ => {}
            }
            c /= 3;
        }
        let m: Vec<Vec<f64>> = faces.iter().map(|&a| faces.iter().map(|&b| g[a][b]).collect()).collect();
        match s_matrix(&m) {
            SDecision::Yes => continue,
            SDecision::No => {
                // The condition is sufficient, not known to be necessary, so its failure leaves
                // existence open rather than refuted.
                return Verdict {
                    existence: Finding {
                        outcome: Outcome::Undecided,
                        statement: format!(
                            "the reflection directions on faces {} fail the Dai–Williams (1995) sufficient condition, so existence of this box SRBM is not established.",
                            face_label(&faces, d)
                        ),
                    },
                    recurrence: None,
                };
            }
            SDecision::Boundary => {
                if saw_boundary.is_none() {
                    saw_boundary = Some(faces);
                }
            }
        }
    }
    if let Some(faces) = saw_boundary {
        return Verdict {
            existence: Finding {
                outcome: Outcome::Undecided,
                statement: format!(
                    "the Dai–Williams condition on faces {} holds or fails only to within rounding.",
                    face_label(&faces, d)
                ),
            },
            recurrence: None,
        };
    }
    Verdict {
        existence: finding(
            Outcome::Holds,
            "the reflection directions satisfy the Dai–Williams (1995) condition on every set of meeting faces, so the box SRBM exists and is unique in law.",
        ),
        recurrence: Some(finding(Outcome::Holds, "the state space is bounded, so no drift can make the SRBM transient.")),
    }
}

/// Is `m` an S-matrix? (`sMatrix`)
///
/// Is there w ≥ 0 with Mw > 0? The matrix game v = max_{w ∈ simplex} min_i (Mw)_i is solved by the
/// simplex method and the witness is then checked: M is an S-matrix iff v > 0 (Ville). "Yes" is
/// confirmed by Mw > 0 for the returned w, "no" by yᵀM ≤ 0 for the returned row strategy y, each
/// past a dot-product rounding bound; anything else is "boundary".
pub fn s_matrix(m: &[Vec<f64>]) -> SDecision {
    let k = m.len();
    if k == 0 {
        return SDecision::Yes;
    }
    let scale = swift_seq_max(m.iter().flatten().map(|x| x.abs())).unwrap_or(0.0);
    if !(scale > 0.0) {
        return SDecision::No;
    }
    let gamma = (k + 2) as f64 * f64::EPSILON;

    // Cheap witness first: w = 1 settles most matrices that arise from networks (positive row sums)
    // without building a tableau.
    let row_sums_positive = (0..k).all(|i| {
        let (mut s, mut bound) = (0.0, 0.0);
        for j in 0..k {
            s += m[i][j];
            bound += m[i][j].abs();
        }
        s > gamma * bound
    });
    if row_sums_positive {
        return SDecision::Yes;
    }

    // Shift to a strictly positive game A = M/scale + 2, entries in [1, 3], and solve
    // max Σy s.t. Aᵀy ≤ 1, y ≥ 0 from the slack basis.
    let rows = k;
    let cols = 2 * k;
    let mut t = vec![vec![0.0f64; cols + 1]; rows + 1];
    for j in 0..k {
        // Constraint j: Σ_i A_ij y_i ≤ 1.
        for i in 0..k {
            t[j][i] = m[i][j] / scale + 2.0;
        }
        t[j][k + j] = 1.0;
        t[j][cols] = 1.0;
    }
    for i in 0..k {
        // The objective row holds the reduced costs.
        t[rows][i] = -1.0;
    }
    let mut basis: Vec<usize> = (k..2 * k).collect();

    let mut iterations = 0;
    while iterations < 50 * (k + 1) {
        iterations += 1;
        // Bland's rule: the lowest-index column with a negative reduced cost.
        let Some(enter) = (0..cols).find(|&c| t[rows][c] < -1e-12) else { break };
        let mut leave: Option<usize> = None;
        let mut best_ratio = f64::INFINITY;
        for r in 0..rows {
            if !(t[r][enter] > 1e-12) {
                continue;
            }
            let ratio = t[r][cols] / t[r][enter];
            // With no row chosen yet the tie test can't hold (it would need |ratio − ∞| ≤ 1e-15),
            // so 0.90.34 never read basis[-1] there.
            if ratio < best_ratio - 1e-15
                || ((ratio - best_ratio).abs() <= 1e-15 && leave.is_some_and(|l| basis[r] < basis[l]))
            {
                best_ratio = ratio;
                leave = Some(r);
            }
        }
        // Unbounded, which is impossible for A > 0.
        let Some(leave) = leave else { return SDecision::Boundary };
        let pivot = t[leave][enter];
        for c in 0..=cols {
            t[leave][c] /= pivot;
        }
        for r in 0..=rows {
            if r == leave {
                continue;
            }
            let f = t[r][enter];
            if f != 0.0 {
                for c in 0..=cols {
                    let sub = f * t[leave][c];
                    t[r][c] -= sub;
                }
            }
        }
        basis[leave] = enter;
    }

    // The dual values of the k constraints are the primal column strategy z.
    let mut y = vec![0.0f64; k];
    for r in 0..rows {
        if basis[r] < k {
            y[basis[r]] = swift_max(0.0, t[r][cols]);
        }
    }
    let z: Vec<f64> = (0..k).map(|i| swift_max(0.0, t[rows][k + i])).collect();
    let y_sum = y.iter().fold(0.0, |a, &b| a + b);
    let z_sum = z.iter().fold(0.0, |a, &b| a + b);
    if !(y_sum > 0.0 && z_sum > 0.0) {
        return SDecision::Boundary;
    }
    let w: Vec<f64> = z.iter().map(|x| x / z_sum).collect();
    let y_row: Vec<f64> = y.iter().map(|x| x / y_sum).collect();

    // The witness for "yes": every component of Mw exceeds its rounding bound.
    let is_s = (0..k).all(|i| {
        let (mut s, mut bound) = (0.0, 0.0);
        for j in 0..k {
            s += m[i][j] * w[j];
            bound += m[i][j].abs() * w[j];
        }
        s > gamma * bound
    });
    if is_s {
        return SDecision::Yes;
    }
    // The witness for "no": some y ≥ 0, y ≠ 0 with yᵀM ≤ 0 (Ville's alternative). The inequality is
    // not strict, so a column that sums to zero exactly (a closed routing cycle gives 1 − 1) counts
    // when no step of its dot product rounded. The LP's y carries rounding, so dyadic roundings of it
    // are tried too; only the sign pattern of y matters.
    let witnesses_not_s = |y: &[f64]| -> bool {
        if !(y.iter().all(|&x| x >= 0.0) && y.iter().any(|&x| x > 0.0)) {
            return false;
        }
        (0..k).all(|j| {
            let (mut s, mut bound) = (0.0, 0.0);
            for i in 0..k {
                s += y[i] * m[i][j];
                bound += y[i] * m[i][j].abs();
            }
            if s < -gamma * bound {
                return true;
            }
            let column: Vec<f64> = (0..k).map(|i| m[i][j]).collect();
            match exact_dot(y, &column) {
                Some(exact) => exact <= 0.0,
                None => false,
            }
        })
    };
    if witnesses_not_s(&y_row) {
        return SDecision::No;
    }
    for bits in [4.0f64, 8.0, 16.0, 24.0, 32.0] {
        let scale = 2.0f64.powf(bits);
        let rounded: Vec<f64> = y_row.iter().map(|x| (x * scale).round()).collect();
        if witnesses_not_s(&rounded) {
            return SDecision::No;
        }
    }
    SDecision::Boundary
}

/// The dot product when every product and partial sum is exact in double precision (checked with
/// FMA and TwoSum), None otherwise.
fn exact_dot(x: &[f64], y: &[f64]) -> Option<f64> {
    let mut s = 0.0f64;
    for i in 0..x.len() {
        let p = x[i] * y[i];
        if x[i].mul_add(y[i], -p) != 0.0 {
            return None;
        }
        let t = s + p;
        let bv = t - s;
        if (s - (t - bv)) + (p - bv) != 0.0 {
            return None;
        }
        s = t;
    }
    Some(s)
}

// Helpers.

fn finding(outcome: Outcome, statement: &str) -> Finding {
    Finding { outcome, statement: statement.to_string() }
}

/// Swift's `max(x, y)` on Doubles, `y >= x ? y : x`: a NaN `y` gives `x`.
fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x {
        y
    } else {
        x
    }
}

/// Swift's `Sequence.max()` on Doubles: keep the running value unless it is `<` the next element,
/// so a NaN never replaces a number and a leading NaN is never replaced.
fn swift_seq_max(mut it: impl Iterator<Item = f64>) -> Option<f64> {
    let mut result = it.next()?;
    for e in it {
        if result < e {
            result = e;
        }
    }
    Some(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sign {
    Positive,
    Negative,
    Zero,
    Boundary,
}

/// Exact 0.0 is zero; anything else within the relative band is boundary.
fn compare(x: f64, scale: f64) -> Sign {
    if x == 0.0 {
        return Sign::Zero;
    }
    let band = BOUNDARY_TOLERANCE * swift_max(scale, f64::MIN_POSITIVE);
    if x > band {
        return Sign::Positive;
    }
    if x < -band {
        return Sign::Negative;
    }
    Sign::Boundary
}

/// a·b − c·d by Kahan's algorithm: relative error at most 2u (Jeannerod–Louvet–Muller 2013), so the
/// sign is exact and the result is zero only when a·b = c·d exactly.
fn diff_of_products(a: f64, b: f64, c: f64, d: f64) -> f64 {
    let w = c * d;
    let e = (-c).mul_add(d, w); // w − c·d, exactly
    let f = a.mul_add(b, -w); // a·b − w, one rounding
    f + e
}

fn is_z_matrix(r: &[Vec<f64>]) -> bool {
    for i in 0..r.len() {
        for j in 0..r.len() {
            if j != i && r[i][j] > 0.0 {
                return false;
            }
        }
    }
    true
}

fn normalized_columns(r: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let d = r.len();
    (0..d).map(|i| (0..d).map(|j| r[i][j] / r[j][j]).collect()).collect()
}

/// The nonempty subsets of {0, …, d−1} as bit masks, smallest first and in numeric order within a
/// size.
fn masks_by_size(d: usize) -> Vec<usize> {
    let mut masks: Vec<usize> = (1..(1usize << d)).collect();
    masks.sort_by_key(|&m| (m.count_ones(), m));
    masks
}

fn indices(mask: usize, d: usize) -> Vec<usize> {
    (0..d).filter(|&i| (mask >> i) & 1 == 1).collect()
}

fn principal(r: &[Vec<f64>], idx: &[usize]) -> Vec<Vec<f64>> {
    idx.iter().map(|&i| idx.iter().map(|&j| r[i][j]).collect()).collect()
}

/// For a Z-matrix the usual failing set is a routing cycle that every customer stays in; say so,
/// since that is how a network produces one.
fn cycle_hint(r: &[Vec<f64>], idx: &[usize]) -> &'static str {
    if is_z_matrix(&principal(r, idx)) {
        " For a single-class network this is a set of stations that customers never leave."
    } else {
        ""
    }
}

/// A coordinate set, 1-based: "{1, 2}".
fn label(idx: &[usize]) -> String {
    let parts: Vec<String> = idx.iter().map(|i| (i + 1).to_string()).collect();
    format!("{{{}}}", parts.join(", "))
}

/// A face set: "{z1 = 0, z2 = K2}".
fn face_label(faces: &[usize], d: usize) -> String {
    let parts: Vec<String> = faces
        .iter()
        .map(|&f| if f < d { format!("z{} = 0", f + 1) } else { format!("z{} = K{}", f - d + 1, f - d + 1) })
        .collect();
    format!("{{{}}}", parts.join(", "))
}

fn fmt(x: f64) -> String {
    crate::cfmt::f("%.6g", x)
}

fn inf_norm(a: &[Vec<f64>]) -> f64 {
    swift_seq_max(a.iter().map(|row| row.iter().fold(0.0, |s, x| s + x.abs()))).unwrap_or(0.0)
}

/// Gaussian elimination with partial pivoting; None when a pivot vanishes relative to the matrix
/// scale.
fn solve(a: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let d = b.len();
    let mut m = a.to_vec();
    let mut rhs = b.to_vec();
    let tiny = 1e-14 * swift_max(inf_norm(a), f64::MIN_POSITIVE);
    for i in 0..d {
        let mut piv = i;
        for r in (i + 1)..d {
            if m[r][i].abs() > m[piv][i].abs() {
                piv = r;
            }
        }
        if m[piv][i].abs() <= tiny {
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
                let sub = f * m[i][c];
                m[r][c] -= sub;
            }
            let sub = f * rhs[i];
            rhs[r] -= sub;
        }
    }
    let mut x = vec![0.0f64; d];
    for i in (0..d).rev() {
        let mut s = rhs[i];
        for c in (i + 1)..d {
            s -= m[i][c] * x[c];
        }
        x[i] = s / m[i][i];
    }
    Some(x)
}

/// Gauss–Jordan inverse with partial pivoting, O(d³).
fn inverse(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let d = a.len();
    let mut m = a.to_vec();
    let mut inv: Vec<Vec<f64>> = (0..d).map(|i| (0..d).map(|j| if i == j { 1.0 } else { 0.0 }).collect()).collect();
    let tiny = 1e-14 * swift_max(inf_norm(a), f64::MIN_POSITIVE);
    for i in 0..d {
        let mut piv = i;
        for r in (i + 1)..d {
            if m[r][i].abs() > m[piv][i].abs() {
                piv = r;
            }
        }
        if m[piv][i].abs() <= tiny {
            return None;
        }
        if piv != i {
            m.swap(i, piv);
            inv.swap(i, piv);
        }
        let p = m[i][i];
        for c in 0..d {
            m[i][c] /= p;
            inv[i][c] /= p;
        }
        for r in 0..d {
            if r == i {
                continue;
            }
            let f = m[r][i];
            if f == 0.0 {
                continue;
            }
            for c in 0..d {
                let sub = f * m[i][c];
                m[r][c] -= sub;
                let sub = f * inv[i][c];
                inv[r][c] -= sub;
            }
        }
    }
    Some(inv)
}

/// The verdict for a network's station model (0.90.34 `QnetGUIApp.srbmExistence(of:)`): the
/// orthant test for infinite buffers; the box test for finite ones up to 10 stations (no box solver
/// takes more, and 3^d − 1 face sets would cost seconds), none above.
pub fn srbm_existence(data: &SrbmData, infinite: bool) -> Option<Verdict> {
    let d = data.d;
    if d == 0 {
        return None;
    }
    let lower: Vec<Vec<f64>> = (0..d).map(|i| (0..d).map(|k| data.r[i][2 * k]).collect()).collect();
    if infinite {
        return Some(classify_orthant(&lower, &data.drift, 16));
    }
    if d > 10 {
        return None;
    }
    let upper: Vec<Vec<f64>> = (0..d).map(|i| (0..d).map(|k| data.r[i][2 * k + 1]).collect()).collect();
    Some(classify_box(&lower, &upper))
}

#[cfg(test)]
mod tests {
    //! The headless check of 0.90.34 (`validation/srbm_existence/main.swift`, 36 checks: 7 S-matrix,
    //! 26 classification, 3 timing), one test per check, then cases that check this port's own
    //! reasoning about the boundary band, the enumeration limit and non-finite input.

    use super::*;
    use std::time::Instant;

    use Outcome::{Fails, Holds, Undecided};

    fn m(rows: &[&[f64]]) -> Vec<Vec<f64>> {
        rows.iter().map(|r| r.to_vec()).collect()
    }

    /// The Swift harness's `expect`: both outcomes match and the headline holds `mentions`. The
    /// whole headline 0.90.34 printed for the case is compared as well.
    fn expect(v: &Verdict, existence: Outcome, recurrence: Option<Outcome>, mentions: Option<&str>, headline: &str) {
        assert_eq!(v.headline(), headline);
        assert_eq!(v.existence.outcome, existence, "existence: {}", v.headline());
        assert_eq!(v.recurrence.as_ref().map(|r| r.outcome), recurrence, "recurrence: {}", v.headline());
        if let Some(s) = mentions {
            assert!(v.headline().contains(s), "headline {:?} lacks {:?}", v.headline(), s);
        }
    }

    fn orthant(r: &[&[f64]], theta: &[f64]) -> Verdict {
        classify_orthant(&m(r), theta, 16)
    }

    // S-matrix witnesses, both directions.

    #[test]
    fn the_one_by_one_matrix_one_is_an_s_matrix() {
        assert_eq!(s_matrix(&m(&[&[1.0]])), SDecision::Yes);
    }

    #[test]
    fn the_one_by_one_matrix_zero_is_not_an_s_matrix() {
        assert_eq!(s_matrix(&m(&[&[0.0]])), SDecision::No);
    }

    #[test]
    fn the_one_by_one_matrix_minus_one_is_not_an_s_matrix() {
        assert_eq!(s_matrix(&m(&[&[-1.0]])), SDecision::No);
    }

    #[test]
    fn a_closed_two_cycle_is_not_an_s_matrix() {
        assert_eq!(s_matrix(&m(&[&[1.0, -1.0], &[-1.0, 1.0]])), SDecision::No);
    }

    #[test]
    fn a_z_matrix_that_is_not_an_m_matrix_is_not_an_s_matrix() {
        assert_eq!(s_matrix(&m(&[&[1.0, -2.0], &[-2.0, 1.0]])), SDecision::No);
    }

    #[test]
    fn a_non_p_matrix_can_be_an_s_matrix() {
        assert_eq!(s_matrix(&m(&[&[1.0, 2.0], &[2.0, 1.0]])), SDecision::Yes);
    }

    #[test]
    fn an_s_matrix_that_needs_a_mixed_witness_is_found() {
        assert_eq!(s_matrix(&m(&[&[1.0, -1.0], &[-1.0, 2.0]])), SDecision::Yes);
    }

    // Orthant: M-matrix cases (Harrison–Williams 1987).

    #[test]
    fn the_e07_tandem_exists_and_is_recurrent_as_an_m_matrix() {
        expect(&orthant(&[&[1.0, 0.0], &[-1.0, 1.0]], &[-1.0, 0.0]), Holds, Some(Holds), Some("M-matrix"), "positive recurrent: R is an M-matrix and R⁻¹θ < 0 (Harrison–Williams 1987).");
    }

    #[test]
    fn the_e06_skew_network_exists_and_is_recurrent() {
        expect(&orthant(&[&[1.0, -0.6], &[-0.25, 1.0]], &[-0.85, 0.0]), Holds, Some(Holds), None, "positive recurrent: R is an M-matrix and R⁻¹θ < 0 (Harrison–Williams 1987).");
    }

    #[test]
    fn an_mm1_queue_at_rho_one_and_a_half_exists_but_is_not_recurrent() {
        expect(&orthant(&[&[1.0]], &[0.5]), Holds, Some(Fails), Some("ρ ≥ 1"), "SRBM not positive recurrent: component 1 of R⁻¹θ is positive (0.5), so the SRBM has no stationary distribution (El Kharroubi–Ben Tahar–Yaacoubi 2000). For a single-class network this is a station with ρ ≥ 1.");
    }

    #[test]
    fn a_feedback_station_at_rho_one_is_on_the_boundary_of_stability() {
        expect(&orthant(&[&[0.5]], &[0.0]), Holds, Some(Undecided), None, "SRBM stability undecided: component 1 of R⁻¹θ is zero to within rounding, the boundary of stability.");
    }

    #[test]
    fn a_closed_routing_cycle_is_undefined_with_the_cycle_hint() {
        expect(&orthant(&[&[1.0, -1.0], &[-1.0, 1.0]], &[0.0, 0.0]), Fails, None, Some("never leave"), "SRBM undefined: R is not completely-S: its principal submatrix on coordinates {1, 2} is not an S-matrix, so no SRBM with this reflection matrix exists (Taylor–Williams 1993). For a single-class network this is a set of stations that customers never leave.");
    }

    #[test]
    fn a_closed_cycle_inside_a_larger_network_is_named_by_its_stations() {
        let v = orthant(&[&[1.0, 0.0, 0.0], &[-0.5, 0.75, -1.0], &[0.0, -0.75, 1.0]], &[-1.0, 0.0, 0.0]);
        expect(&v, Fails, None, Some("{2, 3}"), "SRBM undefined: R is not completely-S: its principal submatrix on coordinates {2, 3} is not an S-matrix, so no SRBM with this reflection matrix exists (Taylor–Williams 1993). For a single-class network this is a set of stations that customers never leave.");
    }

    #[test]
    fn a_z_matrix_that_is_not_an_m_matrix_is_undefined_on_the_whole_set() {
        expect(&orthant(&[&[1.0, -2.0], &[-2.0, 1.0]], &[-1.0, -1.0]), Fails, None, Some("{1, 2}"), "SRBM undefined: R is not completely-S: its principal submatrix on coordinates {1, 2} is not an S-matrix, so no SRBM with this reflection matrix exists (Taylor–Williams 1993). For a single-class network this is a set of stations that customers never leave.");
    }

    #[test]
    fn a_negative_diagonal_entry_is_undefined_on_its_coordinate() {
        expect(&orthant(&[&[1.0, 0.0], &[0.0, -1.0]], &[-1.0, -1.0]), Fails, None, Some("{2}"), "SRBM undefined: R is not completely-S: its principal submatrix on coordinates {2} is not an S-matrix, so no SRBM with this reflection matrix exists (Taylor–Williams 1993). For a single-class network this is a set of stations that customers never leave.");
    }

    #[test]
    fn a_non_completely_s_matrix_is_reported_undefined_with_its_submatrix() {
        let v = orthant(&[&[1.0, 2.0, -3.0], &[0.0, 1.0, 0.0], &[-3.0, 0.0, 1.0]], &[-1.0, -1.0, -1.0]);
        expect(&v, Fails, None, Some("{1, 3}"), "SRBM undefined: R is not completely-S: its principal submatrix on coordinates {1, 3} is not an S-matrix, so no SRBM with this reflection matrix exists (Taylor–Williams 1993). For a single-class network this is a set of stations that customers never leave.");
    }

    // Two dimensions (El Kharroubi–Ben Tahar–Yaacoubi 2000).

    #[test]
    fn a_two_dimensional_p_matrix_that_is_not_z_is_recurrent() {
        expect(&orthant(&[&[1.0, 0.5], &[0.5, 1.0]], &[-1.0, -1.0]), Holds, Some(Holds), Some("P-matrix"), "positive recurrent: R is a P-matrix and R⁻¹θ < 0, which is exact in two dimensions (El Kharroubi–Ben Tahar–Yaacoubi 2000).");
    }

    #[test]
    fn a_two_dimensional_completely_s_matrix_that_is_not_p_is_not_recurrent() {
        expect(&orthant(&[&[1.0, 2.0], &[2.0, 1.0]], &[-1.0, -1.0]), Holds, Some(Fails), Some("not a P-matrix"), "SRBM not positive recurrent: R is not a P-matrix (det R ≤ 0), which in two dimensions rules out positive recurrence even though R⁻¹θ < 0 (El Kharroubi–Ben Tahar–Yaacoubi 2000).");
    }

    // Three dimensions (Bramson–Dai–Harrison 2010).

    const SPIRAL: [[f64; 3]; 3] = [[1.0, 3.0, 0.0], [0.0, 1.0, 3.0], [3.0, 0.0, 1.0]];
    const INWARD: [[f64; 3]; 3] = [[1.0, 1.5, 0.0], [0.0, 1.0, 1.5], [1.5, 0.0, 1.0]];

    fn rows3(a: &[[f64; 3]; 3]) -> Vec<Vec<f64>> {
        a.iter().map(|r| r.to_vec()).collect()
    }

    #[test]
    fn the_bernard_el_kharroubi_spiral_with_gain_eight_is_not_recurrent() {
        expect(&classify_orthant(&rows3(&SPIRAL), &[-1.0, -1.0, -1.0], 16), Holds, Some(Fails), Some("β = 8"), "SRBM not positive recurrent: fluid paths spiral on the boundary with cycle gain β = 8 ≥ 1, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 3).");
    }

    #[test]
    fn an_inward_spiral_with_gain_one_eighth_is_recurrent() {
        expect(&classify_orthant(&rows3(&INWARD), &[-1.0, -1.0, -1.0], 16), Holds, Some(Holds), Some("β = 0.125"), "positive recurrent: fluid paths spiral inward on the boundary with cycle gain β = 0.125 < 1 (El Kharroubi–Ben Tahar–Yaacoubi 2002; Bramson–Dai–Harrison 2010).");
    }

    #[test]
    fn scaling_a_column_of_the_inward_spiral_does_not_move_the_decision() {
        let scaled: Vec<Vec<f64>> = INWARD.iter().map(|r| vec![r[0], 4.0 * r[1], r[2]]).collect();
        expect(&classify_orthant(&scaled, &[-1.0, -1.0, -1.0], 16), Holds, Some(Holds), Some("β = 0.125"), "positive recurrent: fluid paths spiral inward on the boundary with cycle gain β = 0.125 < 1 (El Kharroubi–Ben Tahar–Yaacoubi 2002; Bramson–Dai–Harrison 2010).");
    }

    #[test]
    fn the_clockwise_spiral_with_gain_eight_is_not_recurrent() {
        let clockwise = m(&[&[1.0, 0.0, 3.0], &[3.0, 1.0, 0.0], &[0.0, 3.0, 1.0]]);
        expect(&classify_orthant(&clockwise, &[-1.0, -1.0, -1.0], 16), Holds, Some(Fails), Some("β = 8"), "SRBM not positive recurrent: fluid paths spiral on the boundary with cycle gain β = 8 ≥ 1, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 3).");
    }

    #[test]
    fn bdh_category_one_has_a_divergent_fluid_path() {
        let v = orthant(&[&[1.0, 1.0 / 3.0, 1.0 / 3.0], &[2.0, 1.0, -0.5], &[2.0, -0.5, 1.0]], &[-1.0, -1.0, -1.0]);
        expect(&v, Holds, Some(Fails), Some("Theorem 4"), "SRBM not positive recurrent: the fluid model has a divergent linear path pushing on face(s) {1}, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 4).");
    }

    #[test]
    fn bdh_category_two_a_as_printed_fails_the_necessary_condition() {
        // As printed, u* = (1, 1, 2) does not satisfy Ru* = −θ: −R⁻¹θ = (1, 1, −2).
        let v = orthant(&[&[1.0, 1.0, 0.5], &[-2.0, 1.0, 0.0], &[3.0, 0.0, 1.0]], &[-1.0, 1.0, -1.0]);
        expect(&v, Holds, Some(Fails), Some("component 3 of R⁻¹θ"), "SRBM not positive recurrent: component 3 of R⁻¹θ is positive (2), so the SRBM has no stationary distribution (El Kharroubi–Ben Tahar–Yaacoubi 2000). For a single-class network this is a station with ρ ≥ 1.");
    }

    #[test]
    fn bdh_category_two_b_has_a_divergent_fluid_path() {
        let v = orthant(&[&[1.0, 0.5, 3.0], &[1.0, 1.0, 2.0], &[2.0, 1.0, 1.0]], &[-1.0, -1.0, -1.0]);
        expect(&v, Holds, Some(Fails), Some("Theorem 4"), "SRBM not positive recurrent: the fluid model has a divergent linear path pushing on face(s) {1}, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 4).");
    }

    #[test]
    fn bdh_category_four_has_a_divergent_fluid_path() {
        let v = orthant(&[&[1.0, 1.1, 2.0], &[2.0, 1.0, 0.0], &[0.0, 2.0, 1.0]], &[-1.0, -1.0, -1.0]);
        expect(&v, Holds, Some(Fails), Some("Theorem 4"), "SRBM not positive recurrent: the fluid model has a divergent linear path pushing on face(s) {2}, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 4).");
    }

    #[test]
    fn bdh_category_five_has_a_divergent_fluid_path() {
        let v = orthant(&[&[1.0, 1.0, -0.4], &[2.0, 1.0, -1.2], &[-2.0, -0.1, 1.0]], &[-1.0, -1.0, 1.0]);
        expect(&v, Holds, Some(Fails), Some("Theorem 4"), "SRBM not positive recurrent: the fluid model has a divergent linear path pushing on face(s) {2}, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 4).");
    }

    #[test]
    fn a_three_dimensional_m_matrix_tandem_is_recurrent() {
        let v = orthant(&[&[1.0, 0.0, 0.0], &[-1.0, 1.0, 0.0], &[0.0, -1.0, 1.0]], &[-1.0, 0.2, 0.2]);
        expect(&v, Holds, Some(Holds), Some("M-matrix"), "positive recurrent: R is an M-matrix and R⁻¹θ < 0 (Harrison–Williams 1987).");
    }

    // Four dimensions: only the necessary condition is available.

    fn d4() -> Vec<Vec<f64>> {
        m(&[&[1.0, 0.2, 0.0, 0.0], &[0.0, 1.0, 0.2, 0.0], &[0.0, 0.0, 1.0, 0.2], &[0.2, 0.0, 0.0, 1.0]])
    }

    #[test]
    fn a_four_dimensional_non_m_matrix_meeting_the_necessary_condition_is_undecided() {
        let v = classify_orthant(&d4(), &[-1.0, -1.0, -1.0, -1.0], 16);
        expect(&v, Holds, Some(Undecided), Some("necessary, not sufficient"), "SRBM stability undecided: R⁻¹θ < 0 holds, but R is not an M-matrix and d = 4 ≥ 4, where no test for positive recurrence is known (Bramson–Dai–Harrison 2010). The condition that holds is necessary, not sufficient.");
    }

    #[test]
    fn a_four_dimensional_non_m_matrix_failing_the_necessary_condition_is_not_recurrent() {
        expect(&classify_orthant(&d4(), &[1.0, -1.0, -1.0, -1.0], 16), Holds, Some(Fails), None, "SRBM not positive recurrent: component 1 of R⁻¹θ is positive (1.16987), so the SRBM has no stationary distribution (El Kharroubi–Ben Tahar–Yaacoubi 2000). For a single-class network this is a station with ρ ≥ 1.");
    }

    // Box (Dai–Williams 1995).

    #[test]
    fn the_normal_box_exists_and_is_recurrent() {
        let v = classify_box(&m(&[&[1.0, 0.0], &[0.0, 1.0]]), &m(&[&[-1.0, 0.0], &[0.0, -1.0]]));
        expect(&v, Holds, Some(Holds), None, "the state space is bounded, so no drift can make the SRBM transient.");
    }

    #[test]
    fn the_dai_harrison_tandem_box_exists_and_is_recurrent() {
        let v = classify_box(&m(&[&[1.0, 0.0], &[-1.0, 1.0]]), &m(&[&[-1.0, 0.0], &[0.0, -1.0]]));
        expect(&v, Holds, Some(Holds), None, "the state space is bounded, so no drift can make the SRBM transient.");
    }

    #[test]
    fn a_box_failing_dai_williams_on_two_meeting_faces_is_undecided_and_names_them() {
        let v = classify_box(&m(&[&[1.0, 0.0], &[2.0, 1.0]]), &m(&[&[-1.0, -2.0], &[0.0, -1.0]]));
        expect(&v, Undecided, None, Some("z1 = 0, z2 = K2"), "SRBM existence undecided: the reflection directions on faces {z1 = 0, z2 = K2} fail the Dai–Williams (1995) sufficient condition, so existence of this box SRBM is not established.");
    }

    // Timing, as 0.90.34 asserted it.

    #[test]
    fn a_twelve_dimensional_non_z_enumeration_holds_within_five_seconds() {
        let mut r12 = vec![vec![0.0f64; 12]; 12];
        for i in 0..12 {
            r12[i][i] = 1.0;
            r12[i][(i + 1) % 12] = 0.3;
            r12[(i + 1) % 12][i] -= 0.2;
        }
        let start = Instant::now();
        let big = completely_s(&r12, 16);
        let seconds = start.elapsed().as_secs_f64();
        assert_eq!(big.outcome, Holds, "{}", big.statement);
        assert!(seconds < 5.0, "took {seconds} s");
    }

    #[test]
    fn a_150_station_tandem_is_usable_within_one_second() {
        let n = 150;
        let mut tandem = vec![vec![0.0f64; n]; n];
        for i in 0..n {
            tandem[i][i] = 1.0;
            if i > 0 {
                tandem[i][i - 1] = -0.9;
            }
        }
        let mut theta = vec![-0.1];
        theta.extend(std::iter::repeat(-0.01).take(n - 1));
        let start = Instant::now();
        let v = classify_orthant(&tandem, &theta, 16);
        let seconds = start.elapsed().as_secs_f64();
        assert!(v.is_usable(), "{}", v.headline());
        assert!(seconds < 1.0, "took {seconds} s");
    }

    #[test]
    fn a_ten_station_finite_buffer_box_is_usable_within_two_seconds() {
        let k = 10;
        let mut lower = vec![vec![0.0f64; k]; k];
        let mut upper = lower.clone();
        for i in 0..k {
            lower[i][i] = 1.0;
            upper[i][i] = -1.0;
            upper[(i + 1) % k][i] = 0.6;
        }
        let start = Instant::now();
        let v = classify_box(&lower, &upper);
        let seconds = start.elapsed().as_secs_f64();
        assert!(v.is_usable(), "{}", v.headline());
        assert!(seconds < 2.0, "took {seconds} s");
    }

    // This port's own cases, each headline taken from 0.90.34's SRBMExistence.swift compiled alone.

    #[test]
    fn a_drift_component_inside_the_rounding_band_is_undecided_not_rounded() {
        // u = (1, −1e-12) against a band of 1e-10 · max|u|.
        let v = orthant(&[&[1.0, 0.0], &[0.0, 1.0]], &[-1.0, 1e-12]);
        assert_eq!(v.headline(), "SRBM stability undecided: component 2 of R⁻¹θ is zero to within rounding, the boundary of stability.");
    }

    #[test]
    fn a_drift_component_just_outside_the_band_fails_and_prints_with_six_significant_digits() {
        let v = orthant(&[&[1.0, 0.0], &[0.0, 1.0]], &[-1.0, 1e-9]);
        assert_eq!(v.headline(), "SRBM not positive recurrent: component 2 of R⁻¹θ is positive (1e-09), so the SRBM has no stationary distribution (El Kharroubi–Ben Tahar–Yaacoubi 2000). For a single-class network this is a station with ρ ≥ 1.");
        let v = orthant(&[&[3.0]], &[0.7]);
        assert!(v.headline().contains("component 1 of R⁻¹θ is positive (0.233333)"), "{}", v.headline());
    }

    #[test]
    fn a_non_z_matrix_above_the_enumeration_limit_is_undecided() {
        let r = m(&[&[1.0, 0.5, 0.0], &[0.0, 1.0, 0.5], &[0.5, 0.0, 1.0]]);
        let v = classify_orthant(&r, &[-1.0, -1.0, -1.0], 2);
        assert_eq!(v.headline(), "SRBM existence undecided: R is not a Z-matrix and d = 3 exceeds the 2-dimension limit for checking its 2^d − 1 principal submatrices.");
        assert_eq!(v.recurrence, None);
    }

    #[test]
    fn a_z_matrix_above_the_enumeration_limit_is_decided_on_the_whole_matrix() {
        let v = classify_orthant(&m(&[&[1.0, -2.0], &[-2.0, 1.0]]), &[-1.0, -1.0], 1);
        assert_eq!(v.headline(), "SRBM undefined: R is a Z-matrix but not a nonsingular M-matrix, so it is not completely-S and no SRBM with this reflection matrix exists (Taylor–Williams 1993). For a single-class network this is a set of stations that customers never leave.");
        let v = classify_orthant(&m(&[&[1.0, -0.5], &[-0.5, 1.0]]), &[-1.0, -1.0], 1);
        expect(&v, Holds, Some(Holds), None, "positive recurrent: R is an M-matrix and R⁻¹θ < 0 (Harrison–Williams 1987).");
    }

    #[test]
    fn non_finite_or_mismatched_orthant_data_fail_the_input_guard() {
        let guard = "SRBM undefined: the drift and reflection matrix do not have matching finite dimensions.";
        assert_eq!(orthant(&[&[1.0]], &[f64::NAN]).headline(), guard);
        assert_eq!(orthant(&[&[1.0, f64::INFINITY], &[0.0, 1.0]], &[-1.0, -1.0]).headline(), guard);
        assert_eq!(orthant(&[&[1.0, 0.0]], &[-1.0]).headline(), guard);
        assert_eq!(orthant(&[], &[]).headline(), guard);
        assert_eq!(orthant(&[], &[]).recurrence, None);
    }

    #[test]
    fn non_finite_or_mismatched_box_data_fail_the_input_guard_and_eleven_dimensions_are_undecided() {
        let guard = "SRBM undefined: the box reflection directions do not have matching finite dimensions.";
        assert_eq!(classify_box(&m(&[&[1.0]]), &m(&[&[f64::NAN]])).headline(), guard);
        assert_eq!(classify_box(&m(&[&[1.0]]), &m(&[&[-1.0, 0.0]])).headline(), guard);
        let eye: Vec<Vec<f64>> = (0..11).map(|i| (0..11).map(|j| if i == j { 1.0 } else { 0.0 }).collect()).collect();
        let minus: Vec<Vec<f64>> = eye.iter().map(|r| r.iter().map(|x| -x).collect()).collect();
        let v = classify_box(&eye, &minus);
        assert_eq!(v.headline(), "SRBM existence undecided: d = 11 exceeds the 10-dimension limit for checking the 3^d − 1 face sets of the box.");
        assert_eq!(v.recurrence, None);
    }

    #[test]
    fn a_singular_completely_s_matrix_leaves_recurrence_undecided() {
        let v = orthant(&[&[1.0, 1.0], &[1.0, 1.0]], &[-1.0, -1.0]);
        expect(&v, Holds, Some(Undecided), None, "SRBM stability undecided: R is numerically singular, so R⁻¹θ < 0 cannot be evaluated.");
    }

    #[test]
    fn a_spiral_gain_of_exactly_one_fails_and_one_within_the_band_is_undecided() {
        let spiral = |a: f64| m(&[&[1.0, a, 0.0], &[0.0, 1.0, a], &[a, 0.0, 1.0]]);
        let theta = [-1.0, -1.0, -1.0];
        assert_eq!(classify_orthant(&spiral(2.0), &theta, 16).headline(), "SRBM not positive recurrent: fluid paths spiral on the boundary with cycle gain β = 1 ≥ 1, so the SRBM is not positive recurrent although R⁻¹θ < 0 (Bramson–Dai–Harrison 2010, Theorem 3).");
        let near = "SRBM stability undecided: the boundary-spiral gain β is 1 to within rounding.";
        assert_eq!(classify_orthant(&spiral(2.0 + 1e-12), &theta, 16).headline(), near);
        assert_eq!(classify_orthant(&spiral(2.0 - 1e-12), &theta, 16).headline(), near);
        assert_eq!(classify_orthant(&spiral(1.6), &theta, 16).headline(), "positive recurrent: fluid paths spiral inward on the boundary with cycle gain β = 0.216 < 1 (El Kharroubi–Ben Tahar–Yaacoubi 2002; Bramson–Dai–Harrison 2010).");
        assert!(classify_orthant(&spiral(2.5), &theta, 16).headline().contains("β = 3.375 ≥ 1"));
    }

    #[test]
    fn a_one_by_one_positive_matrix_is_an_m_matrix() {
        expect(&orthant(&[&[2.0]], &[-1.0]), Holds, Some(Holds), None, "positive recurrent: R is an M-matrix and R⁻¹θ < 0 (Harrison–Williams 1987).");
    }

    #[test]
    fn the_s_matrix_test_handles_empty_nan_and_near_singular_input_as_0_90_34_did() {
        assert_eq!(s_matrix(&[]), SDecision::Yes);
        // A NaN scale fails `scale > 0`; a NaN entry beside a finite scale reaches no witness.
        assert_eq!(s_matrix(&m(&[&[f64::NAN]])), SDecision::No);
        assert_eq!(s_matrix(&m(&[&[1.0, f64::NAN], &[0.0, 1.0]])), SDecision::Boundary);
        assert_eq!(s_matrix(&m(&[&[1.0, -1.0], &[-1.0, 1.0 + 1e-15]])), SDecision::Boundary);
        assert_eq!(s_matrix(&m(&[&[1.0, -1.0], &[-1.0, 1.0 - 1e-15]])), SDecision::No);
    }

    #[test]
    fn principal_submatrices_are_enumerated_smallest_first_in_numeric_order() {
        assert_eq!(masks_by_size(3), vec![0b001, 0b010, 0b100, 0b011, 0b101, 0b110, 0b111]);
        assert_eq!(label(&[1, 2]), "{2, 3}");
        assert_eq!(face_label(&[0, 3], 2), "{z1 = 0, z2 = K2}");
    }

    #[test]
    fn swift_max_keeps_the_first_argument_against_nan_as_swift_did() {
        assert_eq!(swift_max(1e-10, f64::NAN), 1e-10);
        assert!(swift_max(f64::NAN, 1.0).is_nan());
        assert_eq!(swift_seq_max([1.0, f64::NAN, 3.0].into_iter()), Some(3.0));
        assert!(swift_seq_max([f64::NAN, 3.0].into_iter()).unwrap().is_nan());
        assert_eq!(compare(1e-300, f64::NAN), Sign::Boundary);
    }
}
