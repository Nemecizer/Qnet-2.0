//! The four methods that ship a C engine beside their original Python one, and the one function
//! that settles which engine a run uses (0.90.34 `SolverEngine.swift` and `QnetGUIApp.swift`
//! `resolveEngine(for:preferred:pythonScript:pythonSubdirectory:)`).
//!
//! The two engines of a method are not two algorithms: each C engine reproduces its Python
//! counterpart's arithmetic, so the choice in Settings ▸ Solvers ▸ Solver Engine is a choice of
//! wait, not of answer. That is why an engine that cannot be found falls back to the other one
//! with a warning instead of refusing the run; only when neither resolves is the run refused,
//! with a sentence naming both.
//!
//! Where 2.0 differs: 0.90.34 returned a shell fragment (`'<python>' -B '<script>'`) because it
//! typed the command into the user's shell; 2.0 starts the solver itself (decision D1), so the
//! result is an argument vector. The provenance and the two sentences are 0.90.34's text. The
//! setting is still read by the caller (`engine.regenerative`, `engine.qbd`, `engine.ctmc`) and
//! passed in, so this stays the only place the choice is honoured (INV-034). The Python script
//! and its folder, which 0.90.34's four callers passed in, are properties of the method here.

use std::ffi::OsString;
use std::path::PathBuf;

use super::{Resolver, SolverLookup, DEFAULT_GROUPS, NATIVE_PROBE_TIMEOUT};

/// Which implementation of a dual-engine method runs. Stored as an integer setting: 0 is C (the
/// default, also for any unknown value), 1 is Python.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SolverEngine {
    C,
    Python,
}

impl SolverEngine {
    /// The engine a stored setting value names; anything but 1 is C, as in 0.90.34.
    pub fn from_stored(value: i64) -> SolverEngine {
        if value == 1 {
            SolverEngine::Python
        } else {
            SolverEngine::C
        }
    }

    /// The value written to the setting.
    pub fn stored_value(self) -> i64 {
        match self {
            SolverEngine::C => 0,
            SolverEngine::Python => 1,
        }
    }

    /// The menu label: "C" or "Python".
    pub fn title(self) -> &'static str {
        match self {
            SolverEngine::C => "C",
            SolverEngine::Python => "Python",
        }
    }

    /// The name used in Status lines and provenance: "C engine" or "Python engine".
    pub fn descriptive_name(self) -> &'static str {
        match self {
            SolverEngine::C => "C engine",
            SolverEngine::Python => "Python engine",
        }
    }

    /// The other engine.
    pub fn other(self) -> SolverEngine {
        match self {
            SolverEngine::C => SolverEngine::Python,
            SolverEngine::Python => SolverEngine::C,
        }
    }
}

/// A method that ships both engines.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DualEngineMethod {
    RegenerativeMonteCarlo,
    MatrixAnalyticQbd,
    TruncatedCtmc,
    FiniteGenericCtmc,
}

/// Where a native solver lives: its file name, its solver folder, and the groups searched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeExecutable {
    pub name: &'static str,
    pub subdirectory: &'static str,
    pub groups: &'static [&'static str],
}

impl DualEngineMethod {
    /// All four, in 0.90.34's declaration order.
    pub const ALL: [DualEngineMethod; 4] = [
        DualEngineMethod::RegenerativeMonteCarlo,
        DualEngineMethod::MatrixAnalyticQbd,
        DualEngineMethod::TruncatedCtmc,
        DualEngineMethod::FiniteGenericCtmc,
    ];

    /// The method as the Run menu names it.
    pub fn display_name(self) -> &'static str {
        match self {
            DualEngineMethod::RegenerativeMonteCarlo => "Regenerative Monte Carlo",
            DualEngineMethod::MatrixAnalyticQbd => "Exact Matrix-Analytic QBD",
            DualEngineMethod::TruncatedCtmc => "Adaptive Truncated CTMC",
            DualEngineMethod::FiniteGenericCtmc => "Exact Sparse CTMC",
        }
    }

    /// The C engine's executable.
    pub fn native_executable(self) -> NativeExecutable {
        let (name, subdirectory, groups): (&str, &str, &[&str]) = match self {
            DualEngineMethod::RegenerativeMonteCarlo => ("bna_rmc", "BNArmc", &["infinite"]),
            DualEngineMethod::MatrixAnalyticQbd => ("bna_qbd", "BNAqbd", &["infinite"]),
            DualEngineMethod::TruncatedCtmc => ("bna_tc", "BNAtc", &["infinite"]),
            DualEngineMethod::FiniteGenericCtmc => ("fbna_gc", "fBNAgc", &["finite"]),
        };
        NativeExecutable { name, subdirectory, groups }
    }

    /// The Python engine's script and its solver folder (searched in both groups, as 0.90.34's
    /// callers did).
    pub fn python_script(self) -> (&'static str, &'static str) {
        match self {
            DualEngineMethod::RegenerativeMonteCarlo => ("regenerative_mc.py", "BNArmc"),
            DualEngineMethod::MatrixAnalyticQbd => ("qbd_solver.py", "BNAqbd"),
            DualEngineMethod::TruncatedCtmc => ("truncated_ctmc.py", "BNAtc"),
            DualEngineMethod::FiniteGenericCtmc => ("solver.py", "fBNAgc"),
        }
    }

    /// The setting key holding this method's engine; the two CTMC methods share one.
    pub fn storage_key(self) -> &'static str {
        match self {
            DualEngineMethod::RegenerativeMonteCarlo => "engine.regenerative",
            DualEngineMethod::MatrixAnalyticQbd => "engine.qbd",
            DualEngineMethod::TruncatedCtmc | DualEngineMethod::FiniteGenericCtmc => "engine.ctmc",
        }
    }
}

/// The start of a solver's command line: the program and the arguments that come before the
/// solver's own (`-B <script>` for a Python solver, nothing for a native one).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchPrefix {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

impl LaunchPrefix {
    /// The prefix as one argument vector, program first.
    pub fn to_argv(&self) -> Vec<OsString> {
        std::iter::once(self.program.clone().into_os_string()).chain(self.args.iter().cloned()).collect()
    }
}

/// How a dual-engine run is launched once its engine is settled.
#[derive(Clone, Debug)]
pub struct ResolvedEngine {
    /// The engine that will run, which may not be the one asked for.
    pub engine: SolverEngine,
    /// Program and leading arguments.
    pub launch: LaunchPrefix,
    /// The result record's "runtime" parameter: "<C engine|Python engine>[ (fallback)]; <provenance>".
    pub provenance: String,
    /// The warning for the Status pane when the preferred engine was unavailable.
    pub note: Option<String>,
}

impl ResolvedEngine {
    /// True when the other engine ran because the preferred one was unavailable.
    pub fn fell_back(&self) -> bool {
        self.note.is_some()
    }
}

/// Why neither engine of a method could be launched.
#[derive(Clone, Debug)]
pub struct EngineUnavailable {
    /// The sentence naming both attempts (0.90.34's text).
    pub diagnostic: String,
    /// The C engine's lookup, for logs and the dependency check.
    pub native: Box<SolverLookup>,
    /// The Python engine's lookup.
    pub python: Box<SolverLookup>,
}

impl Resolver {
    /// Settles which engine a dual-engine method runs: the preferred one if it resolves, else the
    /// other with a warning, else an error naming both. `preferred` comes from the method's
    /// setting, which the caller reads.
    pub fn resolve_engine(
        &self,
        method: DualEngineMethod,
        preferred: SolverEngine,
    ) -> Result<ResolvedEngine, EngineUnavailable> {
        let native = method.native_executable();
        let (script, script_dir) = method.python_script();

        let resolve_c = || {
            let lookup = self.resolve_executable_in(native.name, native.subdirectory, native.groups, NATIVE_PROBE_TIMEOUT);
            let found = lookup.resolution.as_ref().map(|r| {
                (LaunchPrefix { program: r.path.clone(), args: Vec::new() }, r.provenance_description())
            });
            (found, lookup)
        };
        let resolve_python = || {
            let lookup = self.resolve_python_support_file_in(script, script_dir, DEFAULT_GROUPS, &Default::default());
            let found = lookup.resolution.as_ref().and_then(|r| {
                let interpreter = r.runtime_executable.clone()?;
                let args = vec![OsString::from("-B"), r.path.clone().into_os_string()];
                Some((LaunchPrefix { program: interpreter, args }, r.provenance_description()))
            });
            (found, lookup)
        };
        let resolve = |engine: SolverEngine| match engine {
            SolverEngine::C => resolve_c(),
            SolverEngine::Python => resolve_python(),
        };

        let (chosen, chosen_lookup) = resolve(preferred);
        if let Some((launch, provenance)) = chosen {
            return Ok(ResolvedEngine {
                engine: preferred,
                launch,
                provenance: format!("{}; {}", preferred.descriptive_name(), provenance),
                note: None,
            });
        }
        let fallback = preferred.other();
        let (other, other_lookup) = resolve(fallback);
        if let Some((launch, provenance)) = other {
            return Ok(ResolvedEngine {
                engine: fallback,
                launch,
                provenance: format!("{} (fallback); {}", fallback.descriptive_name(), provenance),
                note: Some(fallback_note(method, preferred)),
            });
        }
        let (native_lookup, python_lookup) = match preferred {
            SolverEngine::C => (chosen_lookup, other_lookup),
            SolverEngine::Python => (other_lookup, chosen_lookup),
        };
        Err(EngineUnavailable {
            diagnostic: neither_engine_sentence(method),
            native: Box::new(native_lookup),
            python: Box::new(python_lookup),
        })
    }
}

/// The Status-pane warning when `preferred` was unavailable and the other engine ran.
pub fn fallback_note(method: DualEngineMethod, preferred: SolverEngine) -> String {
    format!(
        "{}: the {} is not available in this installation, so the {} ran instead. The two produce \
         the same result; only the run time differs. Settings ▸ Solvers ▸ Solver Engine chooses.",
        method.display_name(),
        preferred.descriptive_name(),
        preferred.other().descriptive_name()
    )
}

/// The refusal when neither engine of `method` resolves.
pub fn neither_engine_sentence(method: DualEngineMethod) -> String {
    let native = method.native_executable();
    let (script, _) = method.python_script();
    format!(
        "Neither engine for {} could be resolved: no loadable {} and no runnable {}. Rebuild the \
         solvers with ./build_all_algorithms.sh, or reinstall the application.",
        method.display_name(),
        native.name,
        script
    )
}
