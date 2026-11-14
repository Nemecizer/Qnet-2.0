//! Run Regenerative Monte Carlo… (`regenerative_mc`), offered in both buffer modes: a port of
//! `runRegenerativeMonteCarlo` and `estimatedMarkovEmptyProbability` in
//! `2_QNET/Sources/Qnet/QnetGUIApp.swift` (ledger METH-038…METH-042).
//!
//! The order is 0.90.34's: the engine is settled first (`bna_rmc` or `regenerative_mc.py`, from
//! `engine.regenerative`, falling back to the other with a warning); then the parameter sheet;
//! then, for an infinite-buffer network, the cycle-scarcity forecast (the product of the stations'
//! exact M/M/c empty probabilities, a warning below 1e-4, METH-040); then the exporter with the
//! sheet's stopping contract (METH-039) and seed; then the run under the spinner, whose input file
//! is removed however it ends.
//!
//! The sheet itself is P6. As in the golden corpus, which pressed Run at once, a run here takes the
//! sheet's initial values: confidence 0.95, absolute half-width 0.05, relative half-width 0.10,
//! 500 to 20,000 cycles, 30 wall-clock seconds, stream 0, and the seed fields from the settings
//! (`sim.seedFixed`, `sim.seed`). An unfixed seed is drawn from 1…2,147,483,647 as 0.90.34 drew it
//! (but not from Swift's generator: an unfixed seed is meant to differ run to run).
//!
//! Where 2.0 differs: D1, as for every exact-family method (see `exact.rs`).

use qnet_core::cfmt;
use qnet_core::export::regenerative::{self, StoppingOptions, SHEET_DEFAULTS};
use qnet_core::model::Network;
use qnet_core::traffic;

use crate::resolver::DualEngineMethod;
use crate::supervisor::{Severity, TempFiles};

use super::exact::{blocked, icu_scientific, launch_spec, parameters, resolve_engine, spinner_body, write_input};
use super::{Method, Prepared, PreparedRun, RunContext, StatusLine};

/// The empty-system probability below which the forecast warns.
const SCARCE_CYCLES: f64 = 1e-4;

/// What the Run Regenerative Monte Carlo sheet answers when Run is pressed at once.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SheetValues {
    pub confidence: f64,
    pub absolute_half_width: f64,
    pub relative_half_width: f64,
    pub minimum_cycles: i64,
    pub maximum_cycles: i64,
    pub maximum_wall_seconds: i64,
    pub seed_fixed: bool,
    pub seed: i64,
    pub stream: i64,
}

impl SheetValues {
    /// What the sheet answered (`RunSettings::sheet`, `regenerative.*`), over its initial values.
    pub(crate) fn answered(s: &super::RunSettings) -> Self {
        let mut v = SheetValues::initial(s.sim_seed_fixed, s.sim_seed);
        v.confidence = s.sheet_f64("regenerative.confidence").unwrap_or(v.confidence);
        v.absolute_half_width = s.sheet_f64("regenerative.absoluteHalfWidth").unwrap_or(v.absolute_half_width);
        v.relative_half_width = s.sheet_f64("regenerative.relativeHalfWidth").unwrap_or(v.relative_half_width);
        v.minimum_cycles = s.sheet_i64("regenerative.minimumCycles").unwrap_or(v.minimum_cycles);
        v.maximum_cycles = s.sheet_i64("regenerative.maximumCycles").unwrap_or(v.maximum_cycles);
        v.maximum_wall_seconds = s.sheet_i64("regenerative.maximumWallSeconds").unwrap_or(v.maximum_wall_seconds);
        v.stream = s.sheet_i64("regenerative.stream").unwrap_or(v.stream);
        v
    }

    /// The sheet's initial values (`RunParameterSpec.regenerativeMonteCarlo(infiniteBuffers:
    /// seedFixed:seed:)`), the seed fields from the settings.
    pub(crate) fn initial(seed_fixed: bool, seed: i64) -> Self {
        let (confidence, absolute_half_width, relative_half_width, minimum_cycles, maximum_cycles, maximum_wall_seconds) =
            SHEET_DEFAULTS;
        SheetValues {
            confidence,
            absolute_half_width,
            relative_half_width,
            minimum_cycles,
            maximum_cycles,
            maximum_wall_seconds,
            seed_fixed,
            seed,
            stream: 0,
        }
    }
}

/// Prepares `regenerative_mc` with what its sheet answered (its initial values when it answered
/// nothing, as the golden runs did).
pub(crate) fn prepare(method: Method, ctx: &RunContext) -> Prepared {
    if method != Method::RegenerativeMonteCarlo {
        return super::unimplemented_method(method);
    }
    prepare_with(ctx, &SheetValues::answered(&ctx.settings))
}

/// Prepares `regenerative_mc` with what the sheet answered.
pub(crate) fn prepare_with(ctx: &RunContext, values: &SheetValues) -> Prepared {
    let mut lines = Vec::new();
    let Some(engine) = resolve_engine(
        ctx,
        DualEngineMethod::RegenerativeMonteCarlo,
        ctx.settings.engine_regenerative,
        "Regenerative Monte Carlo aborted: simulator not found.",
        &mut lines,
    ) else {
        return Prepared::Refused(lines);
    };

    // The sheet's answer, read as `onRun` read it.
    let confidence = values.confidence;
    let absolute_half_width = values.absolute_half_width;
    let relative_half_width = values.relative_half_width;
    let minimum_cycles = values.minimum_cycles.max(30);
    let maximum_cycles = values.maximum_cycles.max(minimum_cycles);
    let maximum_wall_seconds = values.maximum_wall_seconds.max(1);
    let entered_seed = values.seed.max(0);
    let seed: u64 =
        if values.seed_fixed { entered_seed as u64 } else { ctx.random_in(1, i32::MAX as u64) };
    let stream = values.stream.max(0) as u64;

    let empty_probability = estimated_markov_empty_probability(&ctx.network);
    if let Some(p) = empty_probability.filter(|p| *p < SCARCE_CYCLES) {
        lines.push(StatusLine::warning(scarcity_warning(p)));
    }
    let stopping = StoppingOptions::monte_carlo_sheet(
        confidence,
        absolute_half_width,
        relative_half_width,
        minimum_cycles,
        maximum_cycles,
        maximum_wall_seconds,
    );
    let options = regenerative::Options { base_seed: seed, stream, stopping };
    let input = match regenerative::export(&ctx.network, &ctx.title, &options) {
        Ok(input) => input,
        Err(e) => {
            blocked(&mut lines, &format!("Regenerative Monte Carlo not started: {}", e.message()), None, Severity::Warning);
            return Prepared::Refused(lines);
        }
    };
    let mut temps = TempFiles::new();
    let path = match write_input(ctx, &format!("qnet_regenerative_{}.json", ctx.uuid()), &input, &mut temps) {
        Ok(path) => path,
        Err(reason) => {
            blocked(
                &mut lines,
                &format!("Regenerative Monte Carlo aborted: could not write the solver input file: {reason}"),
                None,
                Severity::Error,
            );
            return Prepared::Refused(lines);
        }
    };
    let spec = launch_spec(&engine.launch).arg(&path);
    let regime = if ctx.network.infinite_buffers { "infinite" } else { "finite loss on full" };
    let mut parameters = parameters(&[
        ("buffer regime", regime),
        ("confidence", &cfmt::swift_description(confidence)),
        ("absolute half-width", &cfmt::swift_description(absolute_half_width)),
        ("relative half-width", &cfmt::swift_description(relative_half_width)),
        ("minimum cycles", &minimum_cycles.to_string()),
        ("maximum cycles", &maximum_cycles.to_string()),
        ("maximum wall seconds", &maximum_wall_seconds.to_string()),
        ("stream", &stream.to_string()),
        ("IID unit", "complete empty-to-empty cycle"),
        ("interval", "asymptotic regenerative-ratio t"),
        ("engine", engine.engine.title()),
        ("runtime", &engine.provenance),
    ]);
    if let Some(p) = empty_probability {
        parameters.insert("estimated empty-system probability".into(), cfmt::swift_description(p));
    }
    Prepared::Launch(PreparedRun {
        method: Method::RegenerativeMonteCarlo,
        parameters,
        seed: Some(seed),
        replication_seeds: Vec::new(),
        before: lines,
        accepted: vec![StatusLine::info(format!(
            "Running regenerative Monte Carlo on the {} (seed {seed}, stream {stream}).",
            engine.engine.descriptive_name()
        ))],
        temps,
        body: spinner_body(format!("Running regenerative simulation ({}) ...  ", engine.engine.title()), spec),
    })
}

/// The cycle-scarcity warning for an estimated empty-system probability `p` (METH-040).
pub(crate) fn scarcity_warning(p: f64) -> String {
    format!(
        "Regenerative-cycle warning: estimated empty-system probability is {}; the default wall-time safeguard may produce few complete cycles. A partial result will be labelled as partial.",
        icu_scientific(p, 3)
    )
}

/// `estimatedMarkovEmptyProbability`: for an infinite-buffer network, the product over stations of
/// the exact M/M/c probability that the station is empty, from the traffic solution (servers c,
/// per-server rate capacity/c, offered load α/rate). `None` for a finite network, when the traffic
/// equations fail, when a station has no servers or capacity or a load outside 0 ≤ ρ < 1, or when
/// the product is not finite. A forecast only: it never changes the estimator.
pub(crate) fn estimated_markov_empty_probability(net: &Network) -> Option<f64> {
    if !net.infinite_buffers {
        return None;
    }
    let data = traffic::compute(&net.nodes, &net.links, true, false, false).ok()?;
    if data.d == 0 {
        return None;
    }
    let mut network_empty = 1.0f64;
    for i in 0..data.d {
        let servers = data.servers[i];
        if !(servers > 0 && data.capacity[i] > 0.0) {
            return None;
        }
        let service_rate = data.capacity[i] / servers as f64;
        let offered = data.alpha[i] / service_rate;
        let rho = offered / servers as f64;
        if !(0.0..1.0).contains(&rho) {
            return None;
        }
        let mut term = 1.0f64;
        let mut normalizer = 1.0f64;
        if servers > 1 {
            for k in 1..servers {
                term *= offered / k as f64;
                normalizer += term;
            }
        }
        term *= offered / servers as f64;
        normalizer += term / (1.0 - rho);
        network_empty *= 1.0 / normalizer;
    }
    network_empty.is_finite().then_some(network_empty)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn network(json: &str) -> Network {
        qnet_core::bnet::read(json).expect("network")
    }

    #[test]
    fn the_empty_probability_of_an_m_m_1_is_one_minus_rho() {
        let net = network(super::super::exact::MM1_INFINITE);
        let p = estimated_markov_empty_probability(&net).expect("an M/M/1 at rho 0.5");
        assert!((p - 0.5).abs() < 1e-12, "{p}");
        let mut finite = net.clone();
        finite.infinite_buffers = false;
        assert_eq!(estimated_markov_empty_probability(&finite), None, "only infinite networks are forecast");
    }

    #[test]
    fn the_empty_probability_of_an_m_m_c_uses_the_erlang_c_normalizer() {
        // Two servers at rate 1, λ = 1: offered a = 1, ρ = 0.5, P0 = 1 / (1 + a + a²/2 / (1 − ρ)) = 1/3.
        let json = super::super::exact::MM1_INFINITE
            .replace("lambda=0.5", "lambda=1.0")
            .replacen(r#""kind":"station","name":"S1","numberOfServers":1"#, r#""kind":"station","name":"S1","numberOfServers":2"#, 1);
        let p = estimated_markov_empty_probability(&network(&json)).expect("an M/M/2");
        assert!((p - 1.0 / 3.0).abs() < 1e-12, "{p}");
    }

    #[test]
    fn an_overloaded_station_has_no_forecast() {
        let json = super::super::exact::MM1_INFINITE.replace("lambda=0.5", "lambda=1.5");
        assert_eq!(estimated_markov_empty_probability(&network(&json)), None);
    }

    #[test]
    fn the_scarcity_warning_reads_as_0_90_34_wrote_it() {
        assert_eq!(
            scarcity_warning(9.99999e-11),
            "Regenerative-cycle warning: estimated empty-system probability is 1.00E-10; the default wall-time safeguard may produce few complete cycles. A partial result will be labelled as partial."
        );
    }

    #[test]
    fn the_sheets_initial_values_are_0_90_34s() {
        let v = SheetValues::initial(true, 12_345);
        assert_eq!(
            (v.confidence, v.absolute_half_width, v.relative_half_width, v.minimum_cycles, v.maximum_cycles, v.maximum_wall_seconds, v.stream),
            (0.95, 0.05, 0.10, 500, 20_000, 30, 0)
        );
    }

    #[test]
    fn the_sheets_answer_is_clamped_as_0_90_34_clamped_it() {
        use std::sync::Arc;
        let Some(home) = std::env::var_os("HOME") else { return };
        let stage = std::path::PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources");
        if !stage.join("bin").is_dir() {
            println!("skipped: the staged solvers are absent");
            return;
        }
        let mut cfg = crate::resolver::ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.development_roots = Vec::new();
        cfg.env.insert("QNET_SOLVER_ROOT".into(), stage.into_os_string());
        let resolver = Arc::new(crate::resolver::Resolver::new(cfg));
        let net = network(super::super::exact::MM1_INFINITE);
        let mut ctx = RunContext::new(net, "mm1.bnet", crate::methods::RunSettings::golden(), resolver);
        ctx.temp_dir = std::env::temp_dir().join(format!("qnet-regen-unit-{}", std::process::id()));
        std::fs::create_dir_all(&ctx.temp_dir).unwrap();
        let values = SheetValues {
            confidence: 0.9,
            absolute_half_width: 0.0,
            relative_half_width: 0.2,
            minimum_cycles: 10,
            maximum_cycles: 5,
            maximum_wall_seconds: 0,
            seed_fixed: true,
            seed: -4,
            stream: -2,
        };
        let Prepared::Launch(run) = prepare_with(&ctx, &values) else { panic!("refused") };
        let p = &run.parameters;
        assert_eq!(
            (p["confidence"].as_str(), p["absolute half-width"].as_str(), p["relative half-width"].as_str()),
            ("0.9", "0.0", "0.2")
        );
        assert_eq!((p["minimum cycles"].as_str(), p["maximum cycles"].as_str(), p["maximum wall seconds"].as_str()), ("30", "30", "1"));
        assert_eq!((run.seed, p["stream"].as_str()), (Some(0), "0"), "a negative seed or stream is 0");
        assert_eq!(p["estimated empty-system probability"], "0.5");
        let input = std::fs::read_to_string(&run.temps.paths()[0]).unwrap();
        let expected = regenerative::export(
            &ctx.network,
            "mm1.bnet",
            &regenerative::Options { base_seed: 0, stream: 0, stopping: StoppingOptions::monte_carlo_sheet(0.9, 0.0, 0.2, 30, 30, 1) },
        )
        .unwrap();
        assert_eq!(input, expected);
        drop(run);
        let _ = std::fs::remove_dir_all(&ctx.temp_dir);
    }
}

#[cfg(test)]
mod sheet_answers {
    use super::*;

    #[test]
    fn the_sheets_answers_replace_its_initial_values_and_nothing_else() {
        let mut s = crate::methods::RunSettings::golden();
        assert_eq!(SheetValues::answered(&s), SheetValues::initial(s.sim_seed_fixed, s.sim_seed));
        s.sheet.insert("regenerative.confidence".into(), "0.99".into());
        s.sheet.insert("regenerative.maximumCycles".into(), "5000".into());
        s.sheet.insert("regenerative.stream".into(), "7".into());
        let v = SheetValues::answered(&s);
        assert_eq!((v.confidence, v.maximum_cycles, v.stream), (0.99, 5000, 7));
        assert_eq!(v.minimum_cycles, SheetValues::initial(true, 0).minimum_cycles);
    }
}
