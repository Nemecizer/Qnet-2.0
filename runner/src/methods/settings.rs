//! The settings a run reads, with 0.90.34's defaults (`AppSettings.Defaults` in
//! `2_QNET/Sources/Qnet/AppSettings.swift`).
//!
//! In 0.90.34 each Run-menu action read `AppSettings` (UserDefaults) directly while it built its
//! command. In 2.0 the caller hands a run one `RunSettings` value instead, so a run specification
//! is a function of the network and these values alone, and tests can state exactly what they
//! ran with. The Settings window, where these are edited and stored, is P4; the field names here
//! follow the stored keys (`sim.replications` is `sim_replications`), and each doc comment names
//! the key.

/// Every setting a Run-menu method, Run Comparison, Test Set or Spectral Convergence reads.
#[derive(Debug, Clone, PartialEq)]
pub struct RunSettings {
    /// `engine.regenerative`: 0 = C (default), 1 = Python.
    pub engine_regenerative: i64,
    /// `engine.qbd`: 0 = C (default), 1 = Python.
    pub engine_qbd: i64,
    /// `engine.ctmc`: 0 = C (default), 1 = Python; shared by the exact sparse and truncated CTMCs.
    pub engine_ctmc: i64,

    /// `sim.replications` (50).
    pub sim_replications: i64,
    /// `sim.warmup` (1,000,000).
    pub sim_warmup: i64,
    /// `sim.time` (5,000,000).
    pub sim_time: i64,
    /// `sim.parallel`: 0 = Apple GCD (default), 1 = OpenMP, 2 = sequential.
    pub sim_parallel: i64,
    /// `sim.blocking`: 0 = Loss, 1 = BAS, 2 = BAS + external loss (default).
    pub sim_blocking: i64,
    /// `sim.seedFixed` (false): when false each run draws a fresh seed.
    pub sim_seed_fixed: bool,
    /// `sim.seed` (12,345).
    pub sim_seed: i64,

    /// `fem.solver`: 0 = Gauss–Legendre (default), 1 = CBC quasi-Monte Carlo.
    pub fem_solver: i64,
    /// `fem.meshSize` (10).
    pub fem_mesh_size: i64,

    /// `sm.degree` (8).
    pub sm_degree: i64,
    /// `sm.legendre` (false).
    pub sm_legendre: bool,

    /// `mlmc.epsilon` (0.01).
    pub mlmc_epsilon: f64,
    /// `mlmc.gamma` (0.05).
    pub mlmc_gamma: f64,
    /// `mlmc.overrideT` (false).
    pub mlmc_override_t: bool,
    /// `mlmc.T` (10.0).
    pub mlmc_t: f64,
    /// `mlmc.overrideL` (false).
    pub mlmc_override_l: bool,
    /// `mlmc.L` (3).
    pub mlmc_l: i64,
    /// `mlmc.overrideN` (false).
    pub mlmc_override_n: bool,
    /// `mlmc.N` (25,000).
    pub mlmc_n: i64,
    /// `mlmc.backend` (0).
    pub mlmc_backend: i64,
    /// `mlmc.threads` (0).
    pub mlmc_threads: i64,
    /// `mlmc.seedFixed` (false).
    pub mlmc_seed_fixed: bool,
    /// `mlmc.seed` (12,345).
    pub mlmc_seed: i64,
    /// `mlmc.antithetic` (false).
    pub mlmc_antithetic: bool,
    /// `mlmc.adaptive` (false).
    pub mlmc_adaptive: bool,
    /// `mlmc.batchSize` (1,000).
    pub mlmc_batch_size: i64,
    /// `mlmc.minSamples` (5,000).
    pub mlmc_min_samples: i64,
    /// `mlmc.maxSamples` (200,000).
    pub mlmc_max_samples: i64,
    /// `mlmc.replications` (1).
    pub mlmc_replications: i64,

    /// `lp.gridN`: 0 = auto-scaled by dimension (default).
    pub lp_grid_n: i64,
    /// `lp.basisM` (0).
    pub lp_basis_m: i64,
    /// `lp.solver`: 0 = auto (default), 1 = cplex, 2 = glpk, 3 = highs.
    pub lp_solver: i64,
    /// `lp.gridType`: 0 = exponential (default), 1 = dyadic, 2 = exprandom.
    pub lp_grid_type: i64,
    /// `lp.smoothness` (0.0).
    pub lp_smoothness: f64,
    /// `lp.basisNormalize` (false).
    pub lp_basis_normalize: bool,
    /// `lp.askBeforeRun` (false): when true the run asks for its parameters first; a run
    /// specification answers with the values shown, as Run would (the sheet itself is P6).
    pub lp_ask_before_run: bool,
    /// `lp.multiLevel` (false).
    pub lp_multi_level: bool,

    /// `flp.gridN` (0).
    pub flp_grid_n: i64,
    /// `flp.basisM` (0).
    pub flp_basis_m: i64,
    /// `flp.solver`: 0 = highs (default), 1 = glpk, 2 = cplex.
    pub flp_solver: i64,
    /// `flp.gridType`: 0 = uniform (default), 1 = chebyshev.
    pub flp_grid_type: i64,
    /// `flp.basisNormalize` (false).
    pub flp_basis_normalize: bool,
    /// `flp.askBeforeRun` (false).
    pub flp_ask_before_run: bool,

    /// `runCompare.remember` (false): when true Run Comparison uses `sim_blocking` without asking.
    pub run_compare_remember: bool,

    /// `output.decimals` (6): the Shell's display precision.
    pub output_decimals: i64,

    /// What a run's parameter sheet answered, by key, for this one run (P6): the sheets that
    /// 0.90.34 showed before Regenerative Monte Carlo (`regenerative.*`), Multi-Class SRBM
    /// (`mc.formulation`, `mc.meshSize`) and Finite Element (`fem.meshSize` as typed, which the
    /// sheet accepts above the cap it opens at). Empty means the sheet was answered with its
    /// initial values, as the golden runs were. Not a stored setting.
    pub sheet: std::collections::BTreeMap<String, String>,
}

impl Default for RunSettings {
    fn default() -> Self {
        Self {
            engine_regenerative: 0,
            engine_qbd: 0,
            engine_ctmc: 0,
            sim_replications: 50,
            sim_warmup: 1_000_000,
            sim_time: 5_000_000,
            sim_parallel: 0,
            sim_blocking: 2,
            sim_seed_fixed: false,
            sim_seed: 12_345,
            fem_solver: 0,
            fem_mesh_size: 10,
            sm_degree: 8,
            sm_legendre: false,
            mlmc_epsilon: 0.01,
            mlmc_gamma: 0.05,
            mlmc_override_t: false,
            mlmc_t: 10.0,
            mlmc_override_l: false,
            mlmc_l: 3,
            mlmc_override_n: false,
            mlmc_n: 25_000,
            mlmc_backend: 0,
            mlmc_threads: 0,
            mlmc_seed_fixed: false,
            mlmc_seed: 12_345,
            mlmc_antithetic: false,
            mlmc_adaptive: false,
            mlmc_batch_size: 1_000,
            mlmc_min_samples: 5_000,
            mlmc_max_samples: 200_000,
            mlmc_replications: 1,
            lp_grid_n: 0,
            lp_basis_m: 0,
            lp_solver: 0,
            lp_grid_type: 0,
            lp_smoothness: 0.0,
            lp_basis_normalize: false,
            lp_ask_before_run: false,
            lp_multi_level: false,
            flp_grid_n: 0,
            flp_basis_m: 0,
            flp_solver: 0,
            flp_grid_type: 0,
            flp_basis_normalize: false,
            flp_ask_before_run: false,
            run_compare_remember: false,
            output_decimals: 6,
            sheet: std::collections::BTreeMap::new(),
        }
    }
}

impl RunSettings {
    /// The settings `golden/runs/` was made with (`golden/tools/GoldenRuns.swift`
    /// `goldenPrepareSettings`): the defaults, with fixed seeds, short sequential simulations, and
    /// Run Comparison not asking for the blocking regime.
    ///
    /// `goldenPrepareSettings` wrote those keys into `UserDefaults.standard`, the owner's own
    /// 0.90.34 domain on the Mac that recorded the corpus, so a value already stored there and not
    /// overwritten was used too. The runs show one: `output.decimals` = 3 (the default is 6), seen
    /// in every comparison table and the multi-class SRBM's.
    pub fn golden() -> Self {
        Self {
            sim_seed_fixed: true,
            sim_replications: 8,
            sim_warmup: 10_000,
            sim_time: 200_000,
            sim_parallel: 2,
            mlmc_seed_fixed: true,
            run_compare_remember: true,
            output_decimals: 3,
            ..Self::default()
        }
    }
}

impl RunSettings {
    /// A sheet answer as a number, when the sheet gave one that parses.
    pub fn sheet_f64(&self, key: &str) -> Option<f64> {
        self.sheet.get(key)?.trim().parse::<f64>().ok().filter(|x| x.is_finite())
    }

    /// A sheet answer as a whole number, when the sheet gave one that parses.
    pub fn sheet_i64(&self, key: &str) -> Option<i64> {
        let t = self.sheet.get(key)?.trim();
        t.parse::<i64>().ok().or_else(|| t.parse::<f64>().ok().filter(|x| x.fract() == 0.0 && x.abs() < 9e15).map(|x| x as i64))
    }

    /// Every stored key this struct holds, in declaration order.
    pub const KEYS: [&'static str; 48] = ["engine.regenerative", "engine.qbd", "engine.ctmc", "sim.replications", "sim.warmup", "sim.time", "sim.parallel", "sim.blocking", "sim.seedFixed", "sim.seed", "fem.solver", "fem.meshSize", "sm.degree", "sm.legendre", "mlmc.epsilon", "mlmc.gamma", "mlmc.overrideT", "mlmc.T", "mlmc.overrideL", "mlmc.L", "mlmc.overrideN", "mlmc.N", "mlmc.backend", "mlmc.threads", "mlmc.seedFixed", "mlmc.seed", "mlmc.antithetic", "mlmc.adaptive", "mlmc.batchSize", "mlmc.minSamples", "mlmc.maxSamples", "mlmc.replications", "lp.gridN", "lp.basisM", "lp.solver", "lp.gridType", "lp.smoothness", "lp.basisNormalize", "lp.askBeforeRun", "lp.multiLevel", "flp.gridN", "flp.basisM", "flp.solver", "flp.gridType", "flp.basisNormalize", "flp.askBeforeRun", "runCompare.remember", "output.decimals"];

    /// Sets one setting by its stored key (`"sim.replications"`, `"mlmc.epsilon"`,
    /// `"sm.legendre"`) from text: integers and doubles as Swift reads them, booleans as `true`,
    /// `false`, `1` or `0`.
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        let int = |v: &str| v.trim().parse::<i64>().map_err(|_| format!("{key} needs a whole number, not “{v}”."));
        let float = |v: &str| v.trim().parse::<f64>().ok().filter(|x| x.is_finite()).ok_or_else(|| format!("{key} needs a number, not “{v}”."));
        let boolean = |v: &str| match v.trim() {
            "true" | "1" => Ok(true),
            "false" | "0" => Ok(false),
            _ => Err(format!("{key} needs true or false, not “{v}”.")),
        };
        match key {
            "engine.regenerative" => self.engine_regenerative = int(value)?,
            "engine.qbd" => self.engine_qbd = int(value)?,
            "engine.ctmc" => self.engine_ctmc = int(value)?,
            "sim.replications" => self.sim_replications = int(value)?,
            "sim.warmup" => self.sim_warmup = int(value)?,
            "sim.time" => self.sim_time = int(value)?,
            "sim.parallel" => self.sim_parallel = int(value)?,
            "sim.blocking" => self.sim_blocking = int(value)?,
            "sim.seedFixed" => self.sim_seed_fixed = boolean(value)?,
            "sim.seed" => self.sim_seed = int(value)?,
            "fem.solver" => self.fem_solver = int(value)?,
            "fem.meshSize" => self.fem_mesh_size = int(value)?,
            "sm.degree" => self.sm_degree = int(value)?,
            "sm.legendre" => self.sm_legendre = boolean(value)?,
            "mlmc.epsilon" => self.mlmc_epsilon = float(value)?,
            "mlmc.gamma" => self.mlmc_gamma = float(value)?,
            "mlmc.overrideT" => self.mlmc_override_t = boolean(value)?,
            "mlmc.T" => self.mlmc_t = float(value)?,
            "mlmc.overrideL" => self.mlmc_override_l = boolean(value)?,
            "mlmc.L" => self.mlmc_l = int(value)?,
            "mlmc.overrideN" => self.mlmc_override_n = boolean(value)?,
            "mlmc.N" => self.mlmc_n = int(value)?,
            "mlmc.backend" => self.mlmc_backend = int(value)?,
            "mlmc.threads" => self.mlmc_threads = int(value)?,
            "mlmc.seedFixed" => self.mlmc_seed_fixed = boolean(value)?,
            "mlmc.seed" => self.mlmc_seed = int(value)?,
            "mlmc.antithetic" => self.mlmc_antithetic = boolean(value)?,
            "mlmc.adaptive" => self.mlmc_adaptive = boolean(value)?,
            "mlmc.batchSize" => self.mlmc_batch_size = int(value)?,
            "mlmc.minSamples" => self.mlmc_min_samples = int(value)?,
            "mlmc.maxSamples" => self.mlmc_max_samples = int(value)?,
            "mlmc.replications" => self.mlmc_replications = int(value)?,
            "lp.gridN" => self.lp_grid_n = int(value)?,
            "lp.basisM" => self.lp_basis_m = int(value)?,
            "lp.solver" => self.lp_solver = int(value)?,
            "lp.gridType" => self.lp_grid_type = int(value)?,
            "lp.smoothness" => self.lp_smoothness = float(value)?,
            "lp.basisNormalize" => self.lp_basis_normalize = boolean(value)?,
            "lp.askBeforeRun" => self.lp_ask_before_run = boolean(value)?,
            "lp.multiLevel" => self.lp_multi_level = boolean(value)?,
            "flp.gridN" => self.flp_grid_n = int(value)?,
            "flp.basisM" => self.flp_basis_m = int(value)?,
            "flp.solver" => self.flp_solver = int(value)?,
            "flp.gridType" => self.flp_grid_type = int(value)?,
            "flp.basisNormalize" => self.flp_basis_normalize = boolean(value)?,
            "flp.askBeforeRun" => self.flp_ask_before_run = boolean(value)?,
            "runCompare.remember" => self.run_compare_remember = boolean(value)?,
            "output.decimals" => self.output_decimals = int(value)?,
            // Replicated Simulation's answers (new in 2.1) are no stored setting: they travel as
            // sheet answers, from the app's sheet and from `qnet-cli run --set` alike.
            k if super::siminproc::KEYS.contains(&k) => {
                float(value)?;
                self.sheet.insert(key.to_string(), value.trim().to_string());
            }
            _ => return Err(format!("There's no run setting called “{key}”.")),
        }
        Ok(())
    }

    /// One setting's value as text, by its stored key, or `None` for an unknown key.
    pub fn get(&self, key: &str) -> Option<String> {
        Some(match key {
            "engine.regenerative" => self.engine_regenerative.to_string(),
            "engine.qbd" => self.engine_qbd.to_string(),
            "engine.ctmc" => self.engine_ctmc.to_string(),
            "sim.replications" => self.sim_replications.to_string(),
            "sim.warmup" => self.sim_warmup.to_string(),
            "sim.time" => self.sim_time.to_string(),
            "sim.parallel" => self.sim_parallel.to_string(),
            "sim.blocking" => self.sim_blocking.to_string(),
            "sim.seedFixed" => self.sim_seed_fixed.to_string(),
            "sim.seed" => self.sim_seed.to_string(),
            "fem.solver" => self.fem_solver.to_string(),
            "fem.meshSize" => self.fem_mesh_size.to_string(),
            "sm.degree" => self.sm_degree.to_string(),
            "sm.legendre" => self.sm_legendre.to_string(),
            "mlmc.epsilon" => crate::methods::settings::swift_double(self.mlmc_epsilon),
            "mlmc.gamma" => crate::methods::settings::swift_double(self.mlmc_gamma),
            "mlmc.overrideT" => self.mlmc_override_t.to_string(),
            "mlmc.T" => crate::methods::settings::swift_double(self.mlmc_t),
            "mlmc.overrideL" => self.mlmc_override_l.to_string(),
            "mlmc.L" => self.mlmc_l.to_string(),
            "mlmc.overrideN" => self.mlmc_override_n.to_string(),
            "mlmc.N" => self.mlmc_n.to_string(),
            "mlmc.backend" => self.mlmc_backend.to_string(),
            "mlmc.threads" => self.mlmc_threads.to_string(),
            "mlmc.seedFixed" => self.mlmc_seed_fixed.to_string(),
            "mlmc.seed" => self.mlmc_seed.to_string(),
            "mlmc.antithetic" => self.mlmc_antithetic.to_string(),
            "mlmc.adaptive" => self.mlmc_adaptive.to_string(),
            "mlmc.batchSize" => self.mlmc_batch_size.to_string(),
            "mlmc.minSamples" => self.mlmc_min_samples.to_string(),
            "mlmc.maxSamples" => self.mlmc_max_samples.to_string(),
            "mlmc.replications" => self.mlmc_replications.to_string(),
            "lp.gridN" => self.lp_grid_n.to_string(),
            "lp.basisM" => self.lp_basis_m.to_string(),
            "lp.solver" => self.lp_solver.to_string(),
            "lp.gridType" => self.lp_grid_type.to_string(),
            "lp.smoothness" => crate::methods::settings::swift_double(self.lp_smoothness),
            "lp.basisNormalize" => self.lp_basis_normalize.to_string(),
            "lp.askBeforeRun" => self.lp_ask_before_run.to_string(),
            "lp.multiLevel" => self.lp_multi_level.to_string(),
            "flp.gridN" => self.flp_grid_n.to_string(),
            "flp.basisM" => self.flp_basis_m.to_string(),
            "flp.solver" => self.flp_solver.to_string(),
            "flp.gridType" => self.flp_grid_type.to_string(),
            "flp.basisNormalize" => self.flp_basis_normalize.to_string(),
            "flp.askBeforeRun" => self.flp_ask_before_run.to_string(),
            "runCompare.remember" => self.run_compare_remember.to_string(),
            "output.decimals" => self.output_decimals.to_string(),
            _ => return None,
        })
    }
}

/// A Double as Swift's `"\(x)"` prints it.
pub(crate) fn swift_double(x: f64) -> String {
    qnet_core::cfmt::swift_description(x)
}

/// Test Set parameters (`TestSetParameters` in `TestSetRunner.swift`); the sheet's defaults come
/// from the `testset.inf.*` / `testset.fin.*` settings (P4).
#[derive(Debug, Clone, PartialEq)]
pub struct TestSetParameters {
    pub stations_lower: i64,
    pub stations_upper: i64,
    pub classes_lower: i64,
    pub classes_upper: i64,
    pub rho_lower: f64,
    pub rho_upper: f64,
    pub num_test_cases: i64,
    /// 0 feed-forward, 1 Jackson feedback, 2 general P-matrix, 3 re-entrant line.
    pub topology: i64,
    /// A fixed base seed, or `None` for a fresh one.
    pub seed: Option<u64>,
}

impl Default for TestSetParameters {
    fn default() -> Self {
        Self {
            stations_lower: 3,
            stations_upper: 6,
            classes_lower: 1,
            classes_upper: 3,
            rho_lower: 0.5,
            rho_upper: 0.85,
            num_test_cases: 20,
            topology: 0,
            seed: None,
        }
    }
}

/// Spectral Convergence parameters (`SpectralConvergenceParameters` in `TestSetRunner.swift`).
#[derive(Debug, Clone, PartialEq)]
pub struct SpectralConvergenceParameters {
    pub stations_lower: i64,
    pub stations_upper: i64,
    pub classes_lower: i64,
    pub classes_upper: i64,
    pub rho_start: f64,
    pub rho_end: f64,
    pub rho_step: f64,
    pub num_test_cases: i64,
    pub topology: i64,
    pub seed: Option<u64>,
}

impl Default for SpectralConvergenceParameters {
    fn default() -> Self {
        Self {
            stations_lower: 3,
            stations_upper: 6,
            classes_lower: 1,
            classes_upper: 3,
            rho_start: 0.50,
            rho_end: 0.95,
            rho_step: 0.05,
            num_test_cases: 10,
            topology: 0,
            seed: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_reads_back_what_was_set_and_unknown_keys_are_refused() {
        let mut s = RunSettings::default();
        for key in RunSettings::KEYS {
            let before = s.get(key).expect("a known key");
            s.set(key, &before).expect("its own value");
            assert_eq!(s.get(key).unwrap(), before, "{key}");
        }
        s.set("sim.replications", "8").unwrap();
        assert_eq!(s.sim_replications, 8);
        s.set("mlmc.epsilon", "0.05").unwrap();
        assert_eq!(s.mlmc_epsilon, 0.05);
        s.set("sm.legendre", "true").unwrap();
        assert!(s.sm_legendre);
        assert!(s.set("sim.replications", "eight").is_err());
        assert!(s.set("no.such.key", "1").is_err());
        assert_eq!(RunSettings::KEYS.len(), 48);
    }
}
