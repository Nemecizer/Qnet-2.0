//! The finite-buffer SRBM solver inputs: the box (hypercube) files read by fBNAsm, fBNAfm and
//! fBNAlp, written exactly as Qnet 0.90.34's `SRBMExporter` wrote them (its export functions, lines
//! 540–832 of `SRBMExporter.swift`).
//!
//! The station model itself (drift θ, covariance Γ, the d × 2d reflection matrix R, the box sides
//! a, the rates) is `traffic::compute`, which is 0.90.34's `computeData`; nothing is re-derived here,
//! so these files and the analysis reports can't drift apart. What this module adds is the layout
//! of each file. The one trap is the reflection matrix's column order, which differs by solver:
//! fBNAsm (`export_for_spectral`, and the plain `export`) and fBNAlp (`export_for_finite_lp`) read
//! it interleaved, `[lower₀, upper₀, lower₁, upper₁, …]`, as `traffic::compute` builds it, while
//! fBNAfm (`export_for_finite_element`) reads it grouped, `[lower₀ … lower_{d−1}, upper₀ …
//! upper_{d−1}]`. Every number is printed by C's `printf` (`cfmt::f`), as `String(format:)` did.
//!
//! The parameters a single-method run passes are arguments here, with 0.90.34's defaults
//! (`AppSettings.Defaults`) named as constants. The spectral method's Legendre basis is a
//! command-line flag of `srbm_solver` (`-L`), not part of the file, so it is not a parameter.
//! Refusals are `traffic::SrbmError`, whose `message()` is 0.90.34's sentence.

use crate::cfmt;
use crate::model::{Link, Node};
use crate::traffic::{self, SrbmData, SrbmError};

/// The spectral method's default polynomial degree (`sm.degree`, 8).
pub const DEFAULT_SPECTRAL_DEGREE: i64 = 8;

/// The finite-element method's default mesh size per axis (`fem.meshSize`, 10). Export All and
/// `--export-cmp` write `fm.in` with mesh 12 instead.
pub const DEFAULT_MESH_SIZE: i64 = 10;

/// The mesh size Export All Solver Inputs and `--export-cmp` use for `fm.in`.
pub const EXPORT_ALL_MESH_SIZE: i64 = 12;

/// `%10.5f`, the one number format of every box file (`formatValue`).
fn value(v: f64) -> String {
    cfmt::f("%10.5f", v)
}

/// A row of values joined by `sep`.
fn row(values: &[f64], sep: &str) -> String {
    values.iter().map(|v| value(*v)).collect::<Vec<_>>().join(sep)
}

/// File › Export › SRBM Solver Input (`SRBMExporter.export`): the interleaved base block only
/// (d, θ, Γ, R, a). `loss` and `bas` are the export sheet's blocking corrections; 0.90.34 passes
/// them only for finite-buffer networks.
pub fn export(nodes: &[Node], links: &[Link], infinite: bool, loss: bool, bas: bool) -> Result<String, SrbmError> {
    let data = traffic::compute(nodes, links, infinite, loss, bas)?;
    Ok(format_interleaved(&data))
}

/// The per-station and per-class tail shared by the spectral and finite-element files: service
/// rates, `customer_classes K`, total throughput, λ per class, K rows of per-class α and K rows of
/// per-class μ, each followed by a blank line.
fn class_tail(data: &SrbmData) -> String {
    let mut text = String::new();
    text += &(row(&data.service_rates, " ") + "\n");
    text += "\n";
    text += &format!("customer_classes {}\n", data.k);
    text += "\n";
    text += &(row(&data.alpha, " ") + "\n");
    text += "\n";
    text += &(row(&data.class_external_arrivals, " ") + "\n");
    text += "\n";
    for k in 0..data.k {
        text += &(row(&data.alpha_per_class[k], " ") + "\n");
    }
    text += "\n";
    for k in 0..data.k {
        text += &(row(&data.class_service_rates[k], " ") + "\n");
    }
    text += "\n";
    text
}

/// The fBNAsm spectral input (`exportForSpectral`): the interleaved base block, then the
/// polynomial degree and the class tail. 0.90.34 runs it with `DEFAULT_SPECTRAL_DEGREE` unless the
/// run sheet changes it.
pub fn export_for_spectral(nodes: &[Node], links: &[Link], infinite: bool, degree: i64, loss: bool, bas: bool) -> Result<String, SrbmError> {
    let data = traffic::compute(nodes, links, infinite, loss, bas)?;
    let mut text = format_interleaved(&data);
    text += &format!("{degree}\n");
    text += "\n";
    text += &class_tail(&data);
    Ok(text)
}

/// The fBNAfm finite-element input (`exportForFiniteElement`): the GROUPED base block, then the
/// mesh size once per station and the class tail. Default mesh `DEFAULT_MESH_SIZE`.
pub fn export_for_finite_element(nodes: &[Node], links: &[Link], infinite: bool, mesh_size: i64, loss: bool, bas: bool) -> Result<String, SrbmError> {
    let data = traffic::compute(nodes, links, infinite, loss, bas)?;
    let mut text = format_grouped(&data);
    text += &(vec![mesh_size.to_string(); data.d].join(" ") + "\n");
    text += "\n";
    text += &class_tail(&data);
    Ok(text)
}

/// The (grid n, basis m) fBNAlp uses when both are left at 0, by dimension
/// (`recommendedFiniteLPGrid`).
pub fn recommended_finite_lp_grid(d: usize) -> (i64, i64) {
    match d {
        0..=1 => (64, 8),
        2 => (20, 6),
        3 => (12, 4),
        4 => (8, 3),
        _ => (6, 3),
    }
}

/// What a finite LP run passes to the fBNAlp file. `Default` is 0.90.34's fresh settings: grid and
/// basis 0 (auto, `recommended_finite_lp_grid`), a `uniform` grid (`chebyshev` is the other),
/// solver `highs` (or `glpk`, `cplex`), no output prefix, smoothness 0 (the line is left out) and
/// no basis normalisation. A run sets `output_prefix` to a temporary path.
#[derive(Clone, Debug, PartialEq)]
pub struct FiniteLpParams {
    pub grid_n: i64,
    pub basis_m: i64,
    pub grid_type: String,
    pub solver: String,
    pub output_prefix: Option<String>,
    pub smoothness_weight: f64,
    pub basis_normalize: bool,
}

impl Default for FiniteLpParams {
    fn default() -> Self {
        FiniteLpParams {
            grid_n: 0,
            basis_m: 0,
            grid_type: "uniform".into(),
            solver: "highs".into(),
            output_prefix: None,
            smoothness_weight: 0.0,
            basis_normalize: false,
        }
    }
}

/// Why fBNAlp cannot take a problem of `d` stations with these settings, or None: the mirror of
/// the solver's own check (`srbm_params_check_size` in solvers/finite/fBNAlp/src/srbm_params.c),
/// so the app refuses with the sentence before it launches anything. Every count the solver
/// holds in a C `int` must fit one: grid points n^d and n^(d−1) per face, basis functions
/// C(m + d, d), the dense evaluation matrices, and the LP's rows, columns and entries. `grid_n`
/// and `basis_m` of 0 are the recommended ones, as in [`format_finite_lp_input`].
pub fn finite_lp_size_refusal(d: usize, params: &FiniteLpParams) -> Option<String> {
    const LIMIT: u64 = i32::MAX as u64;
    let rec = recommended_finite_lp_grid(d);
    let grid = if params.grid_n > 0 { params.grid_n } else { rec.0 };
    let basis = if params.basis_m > 0 { params.basis_m } else { rec.1 };
    let fits = || -> Option<()> {
        let within = |x: u64| (x <= LIMIT).then_some(x);
        let (d, n, m) = (d as u64, u64::try_from(grid).ok()?, u64::try_from(basis).ok()?);
        // n^(d−1) and n^d
        let mut per_face = 1u64;
        for _ in 1..d {
            per_face = within(per_face.checked_mul(n)?)?;
        }
        let npoints = within(per_face.checked_mul(n)?)?;
        // C(m + d, d) = Π_{i=1..d} (m + i)/i, exact at every step
        let mut n_basis = 1u64;
        for i in 1..=d {
            n_basis = within(n_basis.checked_mul(m.checked_add(i)?)? / i)?;
        }
        let total_bdy = 2 * d * per_face;
        let n_slack = if params.smoothness_weight > 0.0 && params.grid_type == "uniform" { d * n.saturating_sub(1) * per_face } else { 0 };
        let cols = npoints + total_bdy + 1;
        let rows = 2 * n_basis + 4 * d + 2;
        within(n_slack)?;
        within(cols + n_slack)?;
        within(rows + 2 * n_slack)?;
        within(npoints * d)?;
        within(npoints.checked_mul(n_basis)?)?;
        within(n_basis.checked_mul(n_basis)?.checked_mul(2 * d + 1)?)?;
        within((2 * n_basis).checked_mul(cols)?.checked_add(2 * (npoints + total_bdy) + 256)?)?;
        Some(())
    };
    match fits() {
        Some(()) => None,
        None => Some(format!(
            "this problem is too large for the LP solver: {d} station{} with grid size {grid} and basis size {basis} give{} more grid points, basis functions or matrix entries than it can index (the limit is 2,147,483,647). Use a smaller grid size or basis size, or a network with fewer stations.",
            if d == 1 { "" } else { "s" },
            if d == 1 { "s" } else { "" }
        )),
    }
}

/// The fBNAlp keyword file (`exportForFiniteLP`). It always computes the model with finite
/// buffers, whatever the document says, as 0.90.34 did.
pub fn export_for_finite_lp(nodes: &[Node], links: &[Link], params: &FiniteLpParams, loss: bool, bas: bool) -> Result<String, SrbmError> {
    let data = traffic::compute(nodes, links, false, loss, bas)?;
    Ok(format_finite_lp_input(&data, params))
}

/// The fBNAlp keyword file from an already computed model (`formatFiniteLPInput`): a header, the
/// hyperparameters, then the drift, covariance, interleaved reflection, upper bounds and service
/// rates blocks, two-space indented and two-space joined.
pub fn format_finite_lp_input(data: &SrbmData, params: &FiniteLpParams) -> String {
    let rec = recommended_finite_lp_grid(data.d);
    let n = if params.grid_n > 0 { params.grid_n } else { rec.0 };
    let m = if params.basis_m > 0 { params.basis_m } else { rec.1 };

    let mut lines: Vec<String> = Vec::new();
    lines.push("# Qnet -> fBNAlp finite-buffer SRBM input".into());
    lines.push(format!("# d = {}, buffers = {}", data.d, data.a_vec.iter().map(|a| cfmt::f("%.0f", *a)).collect::<Vec<_>>().join(", ")));
    lines.push(String::new());

    lines.push(format!("dimension  {}", data.d));
    lines.push(format!("grid_n     {n}"));
    lines.push(format!("basis_m    {m}"));
    lines.push(format!("grid_type  {}", params.grid_type));
    lines.push(format!("solver     {}", params.solver));
    if let Some(prefix) = &params.output_prefix {
        lines.push(format!("output_prefix {prefix}"));
    }
    if params.smoothness_weight > 0.0 {
        lines.push(format!("smoothness_weight {}", cfmt::swift_description(params.smoothness_weight)));
    }
    if params.basis_normalize {
        lines.push("basis_normalize 1".into());
    }
    lines.push(String::new());

    lines.push("drift".into());
    lines.push(format!("  {}", row(&data.drift, "  ")));
    lines.push(String::new());

    lines.push("covariance".into());
    for r in &data.gamma {
        lines.push(format!("  {}", row(r, "  ")));
    }
    lines.push(String::new());

    lines.push("reflection_form interleaved".into());
    lines.push("reflection".into());
    for r in &data.r {
        lines.push(format!("  {}", row(r, "  ")));
    }
    lines.push(String::new());

    lines.push("upper_bounds".into());
    lines.push(format!("  {}", row(&data.a_vec, "  ")));
    lines.push(String::new());

    if !data.service_rates.is_empty() {
        lines.push("service_rates".into());
        lines.push(format!("  {}", row(&data.service_rates, "  ")));
        lines.push(String::new());
    }

    lines.join("\n")
}

/// d, θ, Γ, the given reflection rows and a, blank-separated and ending in a blank line.
fn base_block(data: &SrbmData, reflection: &[Vec<f64>]) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(data.d.to_string());
    lines.push(String::new());
    lines.push(row(&data.drift, " "));
    lines.push(String::new());
    for r in &data.gamma {
        lines.push(row(r, " "));
    }
    lines.push(String::new());
    for r in reflection {
        lines.push(row(r, " "));
    }
    lines.push(String::new());
    lines.push(row(&data.a_vec, " "));
    lines.push(String::new());
    lines.join("\n")
}

/// The base block with R's columns as `traffic::compute` builds them, interleaved (fBNAsm).
fn format_interleaved(data: &SrbmData) -> String {
    base_block(data, &data.r)
}

/// R's columns regrouped, all lower faces then all upper faces (fBNAfm).
pub fn grouped_reflection(data: &SrbmData) -> Vec<Vec<f64>> {
    let d = data.d;
    let mut grouped = vec![vec![0.0; 2 * d]; d];
    for (r, out) in grouped.iter_mut().enumerate() {
        for (j, cell) in out.iter_mut().enumerate() {
            let interleaved = if j < d { 2 * j } else { 2 * (j - d) + 1 };
            *cell = data.r[r][interleaved];
        }
    }
    grouped
}

/// The base block with R's columns grouped (fBNAfm).
fn format_grouped(data: &SrbmData) -> String {
    base_block(data, &grouped_reflection(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Distribution, NodeKind};

    /// Source → buffer → station → sink, with one link each.
    fn mm1() -> (Vec<Node>, Vec<Link>) {
        let mut src = Node::new("A", NodeKind::Source, "Src1", (0.0, 0.0));
        src.distribution = Distribution::Poisson;
        src.parameters = "lambda=0.5".into();
        let mut buf = Node::new("B", NodeKind::Buffer, "B1", (0.0, 0.0));
        buf.buffer_size = 4;
        let mut st = Node::new("C", NodeKind::Station, "S1", (0.0, 0.0));
        st.parameters = "rate=1".into();
        let sink = Node::new("D", NodeKind::Sink, "Sink1", (0.0, 0.0));
        let l = |id: &str, from: &str, to: &str| Link { id: id.into(), from: from.into(), to: to.into(), probability: 1.0, class: 0, to_class: None };
        (vec![src, buf, st, sink], vec![l("1", "A", "B"), l("2", "B", "C"), l("3", "C", "D")])
    }

    #[test]
    fn the_lp_grid_defaults_follow_the_dimension() {
        assert_eq!(recommended_finite_lp_grid(1), (64, 8));
        assert_eq!(recommended_finite_lp_grid(2), (20, 6));
        assert_eq!(recommended_finite_lp_grid(3), (12, 4));
        assert_eq!(recommended_finite_lp_grid(4), (8, 3));
        assert_eq!(recommended_finite_lp_grid(9), (6, 3));
    }

    #[test]
    fn the_lp_file_writes_every_optional_line_a_run_can_ask_for() {
        let (n, l) = mm1();
        let params = FiniteLpParams {
            grid_n: 30,
            basis_m: 5,
            grid_type: "chebyshev".into(),
            solver: "glpk".into(),
            output_prefix: Some("/tmp/x".into()),
            smoothness_weight: 0.25,
            basis_normalize: true,
        };
        let text = export_for_finite_lp(&n, &l, &params, false, false).unwrap();
        let head: Vec<&str> = text.lines().take(11).collect();
        assert_eq!(
            head,
            [
                "# Qnet -> fBNAlp finite-buffer SRBM input",
                "# d = 1, buffers = 5",
                "",
                "dimension  1",
                "grid_n     30",
                "basis_m    5",
                "grid_type  chebyshev",
                "solver     glpk",
                "output_prefix /tmp/x",
                "smoothness_weight 0.25",
                "basis_normalize 1",
            ]
        );
        let plain = export_for_finite_lp(&n, &l, &FiniteLpParams::default(), false, false).unwrap();
        assert!(plain.contains("grid_n     64\nbasis_m    8\ngrid_type  uniform\nsolver     highs\n\ndrift\n"), "{plain}");
    }

    #[test]
    fn the_degree_and_mesh_a_run_passes_are_written_as_given() {
        let (n, l) = mm1();
        let sm = export_for_spectral(&n, &l, false, 13, false, false).unwrap();
        assert!(sm.contains("\n   5.00000\n13\n\n"), "{sm}");
        let fm = export_for_finite_element(&n, &l, false, 7, false, false).unwrap();
        assert!(fm.contains("\n   5.00000\n7\n\n"), "{fm}");
    }

    #[test]
    fn the_plain_export_is_the_interleaved_base_block_alone() {
        let (n, l) = mm1();
        let text = export(&n, &l, false, false, false).unwrap();
        assert!(text.starts_with("1\n\n"));
        assert!(text.ends_with("\n   5.00000\n"));
        assert_eq!(text.lines().count(), 9);
    }

    #[test]
    fn a_refusal_is_the_station_models_sentence() {
        let (n, l) = mm1();
        let no_sink: Vec<Node> = n.into_iter().filter(|x| x.kind != NodeKind::Sink).collect();
        assert_eq!(export_for_spectral(&no_sink, &l, false, 8, false, false).unwrap_err().message(), "The network has no sink node.");
    }

    /// Review finding FIX-208b. The solver's own check cases (solvers/finite/fBNAlp/examples/
    /// check): 12^10 grid points; 12^6 = 2,985,984 points × C(12, 6) = 924 basis functions;
    /// a basis of degree 2^31 − 1; and the two small problems it solves.
    #[test]
    fn the_finite_lp_size_check_mirrors_the_solvers() {
        let with = |grid_n: i64, basis_m: i64| FiniteLpParams { grid_n, basis_m, ..FiniteLpParams::default() };
        assert_eq!(
            finite_lp_size_refusal(10, &with(12, 6)).unwrap(),
            "this problem is too large for the LP solver: 10 stations with grid size 12 and basis size 6 give more grid points, basis functions or matrix entries than it can index (the limit is 2,147,483,647). Use a smaller grid size or basis size, or a network with fewer stations."
        );
        assert!(finite_lp_size_refusal(6, &with(12, 6)).is_some(), "2,985,984 × 924 dense entries");
        assert!(finite_lp_size_refusal(2, &with(12, i32::MAX as i64)).is_some());
        assert_eq!(finite_lp_size_refusal(1, &with(12, 6)), None);
        assert_eq!(finite_lp_size_refusal(2, &with(12, 6)), None);
        // The recommended settings fit up to eight stations (6^8 = 1,679,616 points × C(11, 8) =
        // 165 basis functions = 277,136,640 dense entries); at nine, 6^9 × C(12, 9) =
        // 10,077,696 × 220 = 2,217,093,120 is past 2^31 − 1.
        for d in 1..=8 {
            assert_eq!(finite_lp_size_refusal(d, &FiniteLpParams::default()), None, "{d} stations");
        }
        assert!(finite_lp_size_refusal(9, &FiniteLpParams::default()).unwrap().contains("9 stations with grid size 6 and basis size 3"));
        // An edge: with one station there are m + 1 basis functions and the solver indexes
        // 3·(m + 1)² entries. 3·26,754² = 2,147,329,548 fits; 3·26,755² = 2,147,490,075 does not.
        assert_eq!(finite_lp_size_refusal(1, &with(2, 26_753)), None);
        assert!(finite_lp_size_refusal(1, &with(2, 26_754)).unwrap().starts_with("this problem is too large for the LP solver: 1 station with grid size 2 and basis size 26754 gives more"));
        // The smoothness rows count on a uniform grid only.
        let smooth = |grid_type: &str| FiniteLpParams { grid_n: 30, basis_m: 1, smoothness_weight: 0.5, grid_type: grid_type.into(), ..FiniteLpParams::default() };
        assert_eq!(finite_lp_size_refusal(6, &FiniteLpParams { smoothness_weight: 0.0, ..smooth("uniform") }).is_some(), finite_lp_size_refusal(6, &smooth("chebyshev")).is_some());
    }
}
