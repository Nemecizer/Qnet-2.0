//! Finding a loadable copy of each solver, and a Python that can run the Python ones (a port of
//! 0.90.34 `SolverRuntimeResolver.swift`, with the dual-engine choice from `QnetGUIApp.swift`
//! `resolveEngine` in `resolver/engine.rs` and the two probes in `resolver/probe.rs`).
//!
//! Every lookup walks one ordered list of roots: the running app's own `Contents/Resources/bin`,
//! then `QNET_SOLVER_ROOT` (accepted as an app bundle, a `bin` folder, a folder holding `bin`, or a
//! folder holding `Contents/Resources/bin`), then a `Qnet.app` beside the working directory or the
//! executable in up to seven ancestors, then the development tree. Each root is tried as
//! `<root>/<group>/<dir>/<name>` for each group and then `<root>/<dir>/<name>`. A native solver
//! must exist, be executable and pass a short real launch (the loadability probe), so a file that
//! has its execute bit but fails in the dynamic loader is skipped for the next candidate; a Python
//! solver need only be readable, and then an interpreter that imports the solver's modules is
//! found. Every attempt is recorded with where it came from, so a run's record names its
//! provenance and a failure names every candidate it rejected, in 0.90.34's sentences.
//!
//! Probe results are cached per path and reused while the file's size and modification time are
//! unchanged, separately for native and Python probes. `Resolver` is `Send + Sync`: the caches
//! sit behind a mutex that is not held while a probe runs, as in 0.90.34.
//!
//! Where 2.0 differs, deliberately:
//!
//! - The development tree. 0.90.34 searched the same seven ancestors of the working directory and
//!   the executable for `finite/<dir>/<name>`, because its solvers were built in place in the
//!   source checkout. 2.0's `solvers/` stays source only and `scripts/stage-solvers.sh` builds,
//!   relocates and signs the solvers into `~/Library/Caches/qnet/solvers/stage/Resources/bin`, so
//!   the "development source tree" tier is now an explicit list of roots
//!   ([`ResolverConfig::development_roots`]): by default that staged `bin` folder, then (in debug
//!   builds only) the repository's `solvers/` folder in case someone ran `make` there. The
//!   provenance text stays "development source tree". (A ledger Changed row on RUN-001.)
//! - All inputs are injected through [`ResolverConfig`]: the bundle's resources folder, the
//!   environment (`QNET_SOLVER_ROOT`, `PATH`, and everything passed on to the probes), the working
//!   directory, the executable's folder and the development roots. A relative `QNET_SOLVER_ROOT`
//!   or `PATH` entry is taken against the injected working directory (0.90.34 used the process's).
//! - The bundle's resources folder is only known inside a `.app`; 0.90.34's `Bundle.main` also
//!   answered for a bare executable (its own folder), which never held solvers.
//! - Python solvers are launched as an argument vector `<python> -B <script>` (decision D1), not
//!   the shell string `"<python>" -B "<script>"`; see [`SolverLookup::launch_prefix`].
//! - Qnet's own Python comes first (ROADMAP A2). 0.90.34 only knew the user's `python3`: every
//!   `PATH` entry, then three standard locations. 2.0 carries an interpreter with NumPy in
//!   `Contents/Resources/python` (made by `scripts/stage-python.sh`), so a lookup for `python3`
//!   tries [`Resolver::bundled_python`], then [`Resolver::development_python`] (that script's
//!   stage, for a run from the source tree), and only then 0.90.34's search, which stays as the
//!   fallback with its probes, its cache and its sentences. Both are `bin/python3`, a launcher
//!   that starts the interpreter beside it with no `PYTHON*` variable and no user site-packages,
//!   so the run record's "runtime" reads `…; Python runtime: <Resources>/python/bin/python3`
//!   while the probe's sentence names the interpreter itself (`…/python/bin/python3.15`).

mod engine;
mod probe;

pub use engine::{
    fallback_note, neither_engine_sentence, DualEngineMethod, EngineUnavailable, LaunchPrefix, NativeExecutable,
    ResolvedEngine, SolverEngine,
};

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{CString, OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use probe::ProbeResult;

/// The groups searched by default, in order.
pub const DEFAULT_GROUPS: &[&str] = &["finite", "infinite"];

/// How long a native solver is given to show it loads (0.8 s).
pub const NATIVE_PROBE_TIMEOUT: Duration = Duration::from_millis(800);

/// How long a Python interpreter is given to import the modules and answer (2.0 s).
pub const PYTHON_PROBE_TIMEOUT: Duration = Duration::from_millis(2000);

/// Where Qnet's own Python sits under `Contents/Resources` (and under the development stage's
/// `Resources`): the launcher `scripts/stage-python.sh` writes.
pub const OWN_PYTHON: &str = "python/bin/python3";

/// The development stage of Qnet's own Python, under the home folder.
const PYTHON_STAGE_RESOURCES: &str = "Library/Caches/qnet/python/stage/Resources";

/// The bundle manifest's file name, looked for at a bin root and up to two folders above it.
pub const MANIFEST_NAME: &str = "solver-runtime-status-v1.tsv";

/// The shortest probe timeout; shorter requests are raised to it (0.90.34's `max(0.1, …)`).
const MIN_PROBE_TIMEOUT: Duration = Duration::from_millis(100);

/// Where a candidate came from. The label is part of every provenance string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provenance {
    BundledResources,
    EnvironmentOverride,
    NearbyAppBundle,
    SourceTree,
}

impl Provenance {
    /// "bundled app resources", "QNET_SOLVER_ROOT", "nearby Qnet.app" or "development source tree".
    pub fn label(self) -> &'static str {
        match self {
            Provenance::BundledResources => "bundled app resources",
            Provenance::EnvironmentOverride => "QNET_SOLVER_ROOT",
            Provenance::NearbyAppBundle => "nearby Qnet.app",
            Provenance::SourceTree => "development source tree",
        }
    }
}

/// What became of one candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Outcome {
    NotFound,
    NotExecutable,
    NotReadable,
    LoaderRejected,
    RuntimeUnavailable,
    Selected,
}

impl Outcome {
    /// 0.90.34's raw value ("not found", "dynamic loader rejected", …).
    pub fn label(self) -> &'static str {
        match self {
            Outcome::NotFound => "not found",
            Outcome::NotExecutable => "not executable",
            Outcome::NotReadable => "not readable",
            Outcome::LoaderRejected => "dynamic loader rejected",
            Outcome::RuntimeUnavailable => "runtime unavailable",
            Outcome::Selected => "selected",
        }
    }
}

/// One root of the search, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchRoot {
    pub path: PathBuf,
    pub provenance: Provenance,
}

/// One candidate file and what the resolver found when it looked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    pub path: PathBuf,
    pub provenance: Provenance,
    pub outcome: Outcome,
    pub detail: String,
}

/// The file chosen, where it came from, the probe's sentence, and for a Python solver the
/// interpreter that passed the import probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    pub path: PathBuf,
    pub provenance: Provenance,
    pub probe_detail: String,
    pub runtime_executable: Option<PathBuf>,
}

impl Resolution {
    /// The result record's "runtime" parameter: "<provenance>: <path>[; Python runtime: <path>]".
    pub fn provenance_description(&self) -> String {
        let mut text = format!("{}: {}", self.provenance.label(), self.path.display());
        if let Some(runtime) = &self.runtime_executable {
            text.push_str(&format!("; Python runtime: {}", runtime.display()));
        }
        text
    }
}

/// Everything one lookup found: the resolution if any, every attempt in order, and the reason a
/// bundle manifest gives for declaring the solver unavailable.
#[derive(Clone, Debug)]
pub struct SolverLookup {
    pub requested_name: String,
    pub requested_subdirectory: String,
    pub resolution: Option<Resolution>,
    pub attempts: Vec<Attempt>,
    pub declared_unavailable_reason: Option<String>,
}

impl SolverLookup {
    /// The chosen file, if any.
    pub fn url(&self) -> Option<&Path> {
        self.resolution.as_ref().map(|r| r.path.as_path())
    }

    /// The program and leading arguments to start this solver with: the file itself for a native
    /// solver, `<python> -B <script>` for a Python one. None when nothing resolved.
    pub fn launch_prefix(&self) -> Option<LaunchPrefix> {
        let r = self.resolution.as_ref()?;
        Some(match &r.runtime_executable {
            Some(python) => LaunchPrefix {
                program: python.clone(),
                args: vec![OsString::from("-B"), r.path.clone().into_os_string()],
            },
            None => LaunchPrefix { program: r.path.clone(), args: Vec::new() },
        })
    }

    /// The sentence for the Status pane: "Using <provenance>. <probe detail>" when found, else
    /// 0.90.34's "No loadable copy of …" diagnostic naming up to eight rejected candidates.
    pub fn actionable_diagnostic(&self) -> String {
        if let Some(r) = &self.resolution {
            return format!("Using {}. {}", r.provenance_description(), r.probe_detail);
        }
        let mut lines = vec![format!(
            "No loadable copy of {} was found for {}.",
            self.requested_name, self.requested_subdirectory
        )];
        if let Some(reason) = &self.declared_unavailable_reason {
            lines.push(format!("This app build declares the solver unavailable: {reason}"));
        }
        let useful: Vec<&Attempt> = self.attempts.iter().filter(|a| a.outcome != Outcome::NotFound).collect();
        if useful.is_empty() {
            lines.push(
                "Searched the app bundle, QNET_SOLVER_ROOT, a nearby Qnet.app, and the development source tree."
                    .to_string(),
            );
        } else {
            lines.push("Candidates checked:".to_string());
            for a in useful.iter().take(8) {
                lines.push(format!("• {} [{}]: {}", a.path.display(), a.provenance.label(), a.detail));
            }
        }
        if useful.iter().any(|a| a.outcome == Outcome::RuntimeUnavailable) {
            lines.push("Install a usable Python 3 runtime and any named modules, then relaunch Qnet.".to_string());
        }
        lines.push(
            "Rebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree."
                .to_string(),
        );
        lines.join("\n")
    }
}

/// The interpreter chosen and its probe's sentence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythonResolution {
    pub executable: PathBuf,
    pub probe_detail: String,
}

/// One interpreter tried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythonAttempt {
    pub executable: PathBuf,
    pub loadable: bool,
    pub detail: String,
}

/// Everything a Python runtime lookup found.
#[derive(Clone, Debug)]
pub struct PythonLookup {
    pub interpreter_name: String,
    pub required_modules: Vec<String>,
    pub resolution: Option<PythonResolution>,
    pub attempts: Vec<PythonAttempt>,
}

impl PythonLookup {
    /// The probe's sentence when found, else why no interpreter would do (up to four attempts).
    pub fn actionable_diagnostic(&self) -> String {
        if let Some(r) = &self.resolution {
            return r.probe_detail.clone();
        }
        if self.attempts.is_empty() {
            return format!(
                "Python runtime '{}' was not found in PATH or a standard installation location",
                self.interpreter_name
            );
        }
        let dependency = if self.required_modules.is_empty() {
            "Python interpreter preflight failed".to_string()
        } else {
            format!("Python preflight could not import required module(s) {}", self.required_modules.join(", "))
        };
        let failures: Vec<String> =
            self.attempts.iter().take(4).map(|a| format!("{}: {}", a.executable.display(), a.detail)).collect();
        format!("{dependency}. {}", failures.join("; "))
    }
}

/// What a Python lookup asks for: the interpreter's name (or a path), the modules it must import,
/// and the probe's timeout. The default is `python3`, no modules, 2.0 s.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythonRequest {
    pub interpreter_name: String,
    pub required_modules: Vec<String>,
    pub probe_timeout: Duration,
}

impl Default for PythonRequest {
    fn default() -> Self {
        PythonRequest {
            interpreter_name: "python3".to_string(),
            required_modules: Vec::new(),
            probe_timeout: PYTHON_PROBE_TIMEOUT,
        }
    }
}

impl PythonRequest {
    /// `python3` importing `modules`.
    pub fn with_modules(modules: &[&str]) -> Self {
        PythonRequest { required_modules: modules.iter().map(|m| m.to_string()).collect(), ..Default::default() }
    }
}

/// Everything the resolver reads from the world, so the app and tests can each supply their own.
#[derive(Clone, Debug)]
pub struct ResolverConfig {
    /// The running app's `Contents/Resources`, whose `bin` folder is searched first.
    pub bundle_resources: Option<PathBuf>,
    /// The environment: `QNET_SOLVER_ROOT` and `PATH` are read from it, and the probes run with
    /// exactly this environment (plus their one marker variable).
    pub env: BTreeMap<OsString, OsString>,
    /// The working directory: an anchor for the nearby-app search, the empty `PATH` entry, and
    /// the Python probe's working directory.
    pub current_dir: PathBuf,
    /// The folder holding the running executable: the second anchor for the nearby-app search.
    pub executable_dir: Option<PathBuf>,
    /// The development tree's roots, searched last, in order.
    pub development_roots: Vec<PathBuf>,
}

impl ResolverConfig {
    /// The running process's configuration: its environment, working directory and executable,
    /// the bundle's `Contents/Resources` when the executable sits in `<X>.app/Contents/MacOS`,
    /// and [`ResolverConfig::default_development_roots`].
    pub fn from_process() -> ResolverConfig {
        let exe = std::env::current_exe().ok();
        let executable_dir = exe.as_ref().and_then(|e| e.parent().map(Path::to_path_buf));
        let bundle_resources = executable_dir.as_ref().and_then(|d| bundle_resources_for(d));
        ResolverConfig {
            bundle_resources,
            env: std::env::vars_os().collect(),
            current_dir: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            executable_dir,
            development_roots: ResolverConfig::default_development_roots(),
        }
    }

    /// 2.0's development tree: the solvers staged by `scripts/stage-solvers.sh`
    /// (`~/Library/Caches/qnet/solvers/stage/Resources/bin`), then, in debug builds only, the
    /// repository's `solvers/` folder this crate was built from.
    pub fn default_development_roots() -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
            roots.push(PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources/bin"));
        }
        if cfg!(debug_assertions) {
            if let Some(repo) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
                roots.push(repo.join("solvers"));
            }
        }
        roots
    }
}

/// `<X>.app/Contents/Resources` for an executable folder `<X>.app/Contents/MacOS`, else None.
pub fn bundle_resources_for(executable_dir: &Path) -> Option<PathBuf> {
    let contents = executable_dir.parent()?;
    let app = contents.parent()?;
    let is_bundle = executable_dir.file_name() == Some(OsStr::new("MacOS"))
        && contents.file_name() == Some(OsStr::new("Contents"))
        && app.extension() == Some(OsStr::new("app"));
    is_bundle.then(|| contents.join("Resources"))
}

/// A cached probe: valid while the file's size and modification time are unchanged.
#[derive(Clone)]
struct CachedProbe {
    size: u64,
    modified: (i64, i64),
    result: ProbeResult,
}

/// The solver resolver: its configuration and its two probe caches. Share one per process (it
/// is `Send + Sync`); each lookup re-reads the file system, only probes are cached.
pub struct Resolver {
    config: ResolverConfig,
    env_pairs: Vec<(OsString, OsString)>,
    probe_cache: Mutex<HashMap<String, CachedProbe>>,
    python_probe_cache: Mutex<HashMap<String, CachedProbe>>,
}

impl Resolver {
    /// A resolver over `config`, with empty caches.
    pub fn new(config: ResolverConfig) -> Resolver {
        let env_pairs = config.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        Resolver {
            config,
            env_pairs,
            probe_cache: Mutex::new(HashMap::new()),
            python_probe_cache: Mutex::new(HashMap::new()),
        }
    }

    /// A resolver for the running process ([`ResolverConfig::from_process`]).
    pub fn from_process() -> Resolver {
        Resolver::new(ResolverConfig::from_process())
    }

    /// The configuration it was made with.
    pub fn config(&self) -> &ResolverConfig {
        &self.config
    }

    /// A native solver in either group, with the 0.8 s probe.
    pub fn resolve_executable(&self, name: &str, subdirectory: &str) -> SolverLookup {
        self.resolve_executable_in(name, subdirectory, DEFAULT_GROUPS, NATIVE_PROBE_TIMEOUT)
    }

    /// A native solver: the first candidate that exists, is executable and passes the
    /// loadability probe (`probe_timeout`, at least 0.1 s).
    pub fn resolve_executable_in(
        &self,
        name: &str,
        subdirectory: &str,
        groups: &[&str],
        probe_timeout: Duration,
    ) -> SolverLookup {
        let roots = self.search_roots();
        let mut attempts = Vec::new();
        for candidate in candidates(&roots, name, subdirectory, groups) {
            let attempt = |outcome: Outcome, detail: String| Attempt {
                path: candidate.path.clone(),
                provenance: candidate.provenance,
                outcome,
                detail,
            };
            if !file_exists(&candidate.path) {
                attempts.push(attempt(Outcome::NotFound, Outcome::NotFound.label().to_string()));
                continue;
            }
            if !access_ok(&candidate.path, libc::X_OK) {
                attempts
                    .push(attempt(Outcome::NotExecutable, "the file exists but lacks execute permission".to_string()));
                continue;
            }
            let probe = self.cached_probe(&candidate.path, probe_timeout.max(MIN_PROBE_TIMEOUT));
            if !probe.loadable {
                attempts.push(attempt(Outcome::LoaderRejected, probe.detail));
                continue;
            }
            attempts.push(attempt(Outcome::Selected, probe.detail.clone()));
            return SolverLookup {
                requested_name: name.to_string(),
                requested_subdirectory: subdirectory.to_string(),
                resolution: Some(Resolution {
                    path: candidate.path.clone(),
                    provenance: candidate.provenance,
                    probe_detail: probe.detail,
                    runtime_executable: None,
                }),
                attempts,
                declared_unavailable_reason: None,
            };
        }
        SolverLookup {
            requested_name: name.to_string(),
            requested_subdirectory: subdirectory.to_string(),
            resolution: None,
            attempts,
            declared_unavailable_reason: unavailable_reason(&roots, name, subdirectory, groups),
        }
    }

    /// A support file in either group.
    pub fn resolve_support_file(&self, name: &str, subdirectory: &str) -> SolverLookup {
        self.resolve_support_file_in(name, subdirectory, DEFAULT_GROUPS)
    }

    /// A support file: the first candidate that exists and is readable. No interpreter is
    /// attached; Python solvers go through [`Resolver::resolve_python_support_file`].
    pub fn resolve_support_file_in(&self, name: &str, subdirectory: &str, groups: &[&str]) -> SolverLookup {
        let roots = self.search_roots();
        let mut attempts = Vec::new();
        for candidate in candidates(&roots, name, subdirectory, groups) {
            let attempt = |outcome: Outcome, detail: &str| Attempt {
                path: candidate.path.clone(),
                provenance: candidate.provenance,
                outcome,
                detail: detail.to_string(),
            };
            if !file_exists(&candidate.path) {
                attempts.push(attempt(Outcome::NotFound, Outcome::NotFound.label()));
                continue;
            }
            if !access_ok(&candidate.path, libc::R_OK) {
                attempts.push(attempt(Outcome::NotReadable, "the file exists but is not readable"));
                continue;
            }
            let detail = "support file is readable";
            attempts.push(attempt(Outcome::Selected, detail));
            return SolverLookup {
                requested_name: name.to_string(),
                requested_subdirectory: subdirectory.to_string(),
                resolution: Some(Resolution {
                    path: candidate.path.clone(),
                    provenance: candidate.provenance,
                    probe_detail: detail.to_string(),
                    runtime_executable: None,
                }),
                attempts,
                declared_unavailable_reason: None,
            };
        }
        SolverLookup {
            requested_name: name.to_string(),
            requested_subdirectory: subdirectory.to_string(),
            resolution: None,
            attempts,
            declared_unavailable_reason: unavailable_reason(&roots, name, subdirectory, groups),
        }
    }

    /// A Python interpreter on its own: every candidate is probed in turn until one imports all
    /// the required modules (a Finder-launched app may see Apple's Python first while NumPy lives
    /// in Homebrew's).
    pub fn resolve_python_runtime(&self, request: &PythonRequest) -> PythonLookup {
        let modules = normalized_module_names(&request.required_modules);
        let timeout = request.probe_timeout.max(MIN_PROBE_TIMEOUT);
        let mut attempts = Vec::new();
        for interpreter in self.executable_candidates(&request.interpreter_name) {
            let probe = self.cached_python_probe(&interpreter, &modules, timeout);
            attempts.push(PythonAttempt {
                executable: interpreter.clone(),
                loadable: probe.loadable,
                detail: probe.detail.clone(),
            });
            if probe.loadable {
                return PythonLookup {
                    interpreter_name: request.interpreter_name.clone(),
                    required_modules: modules,
                    resolution: Some(PythonResolution { executable: interpreter, probe_detail: probe.detail }),
                    attempts,
                };
            }
        }
        PythonLookup {
            interpreter_name: request.interpreter_name.clone(),
            required_modules: modules,
            resolution: None,
            attempts,
        }
    }

    /// A Python solver in either group run by `python3`, importing `required_modules`.
    pub fn resolve_python_support_file(&self, name: &str, subdirectory: &str, required_modules: &[&str]) -> SolverLookup {
        self.resolve_python_support_file_in(name, subdirectory, DEFAULT_GROUPS, &PythonRequest::with_modules(required_modules))
    }

    /// A Python solver: the script as a support file, then an interpreter as
    /// [`Resolver::resolve_python_runtime`]. When no interpreter will do, the selected attempt
    /// becomes "runtime unavailable" carrying the runtime's diagnostic, and nothing resolves.
    pub fn resolve_python_support_file_in(
        &self,
        name: &str,
        subdirectory: &str,
        groups: &[&str],
        request: &PythonRequest,
    ) -> SolverLookup {
        let support = self.resolve_support_file_in(name, subdirectory, groups);
        let Some(script) = support.resolution.clone() else {
            return support;
        };
        let runtime = self.resolve_python_runtime(request);
        let Some(python) = runtime.resolution.clone() else {
            let detail = runtime.actionable_diagnostic();
            let attempts = support
                .attempts
                .into_iter()
                .map(|a| {
                    if a.outcome == Outcome::Selected {
                        Attempt { outcome: Outcome::RuntimeUnavailable, detail: detail.clone(), ..a }
                    } else {
                        a
                    }
                })
                .collect();
            return SolverLookup { resolution: None, attempts, ..support };
        };
        let module_detail = if runtime.required_modules.is_empty() {
            "no optional modules required".to_string()
        } else {
            format!("imported modules: {}", runtime.required_modules.join(", "))
        };
        SolverLookup {
            resolution: Some(Resolution {
                path: script.path,
                provenance: script.provenance,
                probe_detail: format!("support file is readable; {}; {}", python.probe_detail, module_detail),
                runtime_executable: Some(python.executable),
            }),
            ..support
        }
    }

    /// The interpreter the running app carries: `<Contents/Resources>/python/bin/python3`. None
    /// outside a `.app`. The path is given whether or not the file is there.
    pub fn bundled_python(&self) -> Option<PathBuf> {
        self.config.bundle_resources.as_ref().map(|r| standardize(&r.join(OWN_PYTHON)))
    }

    /// The interpreter `scripts/stage-python.sh` staged for a run from the source tree:
    /// `$HOME/Library/Caches/qnet/python/stage/Resources/python/bin/python3`, `HOME` being the
    /// injected environment's. None without a `HOME`.
    pub fn development_python(&self) -> Option<PathBuf> {
        let home = self.config.env.get(OsStr::new("HOME")).filter(|h| !h.is_empty())?;
        Some(standardize(&self.config.current_dir.join(home).join(PYTHON_STAGE_RESOURCES).join(OWN_PYTHON)))
    }

    /// The interpreters a name could mean, in order, deduplicated, executable only: a name with a
    /// slash is that path (relative to the working directory); otherwise, for `python3`, Qnet's
    /// own ([`Resolver::bundled_python`], then [`Resolver::development_python`]), then every
    /// `PATH` entry (an empty one is the working directory), and for `python3` also
    /// `/usr/bin/python3`, `/opt/homebrew/bin/python3` and `/usr/local/bin/python3`.
    pub fn executable_candidates(&self, raw_name: &str) -> Vec<PathBuf> {
        let name = raw_name.trim();
        if name.is_empty() {
            return Vec::new();
        }
        let cwd = &self.config.current_dir;
        let mut list = Vec::new();
        if name.contains('/') {
            list.push(if name.starts_with('/') { PathBuf::from(name) } else { cwd.join(name) });
        } else {
            if name == "python3" {
                list.extend(self.bundled_python());
                list.extend(self.development_python());
            }
            let search = self.config.env.get(OsStr::new("PATH")).cloned().unwrap_or_default();
            for component in search.as_bytes().split(|b| *b == b':') {
                let dir =
                    if component.is_empty() { cwd.clone() } else { cwd.join(OsStr::from_bytes(component)) };
                list.push(dir.join(name));
            }
            if name == "python3" {
                list.push(PathBuf::from("/usr/bin/python3"));
                list.push(PathBuf::from("/opt/homebrew/bin/python3"));
                list.push(PathBuf::from("/usr/local/bin/python3"));
            }
        }
        let mut seen = HashSet::new();
        list.into_iter()
            .map(|p| standardize(&p))
            .filter(|p| seen.insert(p.clone()) && access_ok(p, libc::X_OK))
            .collect()
    }

    /// The roots every lookup walks, in order, deduplicated per provenance.
    pub fn search_roots(&self) -> Vec<SearchRoot> {
        let mut roots = Vec::new();
        let mut add = |path: PathBuf, provenance: Provenance| roots.push(SearchRoot { path: standardize(&path), provenance });

        // A packaged app must be self-contained and is always authoritative.
        if let Some(resources) = &self.config.bundle_resources {
            add(resources.join("bin"), Provenance::BundledResources);
        }

        // The override may name an app bundle, a bin folder, or a folder holding either.
        let raw = self.config.env.get(OsStr::new("QNET_SOLVER_ROOT")).map(|v| v.to_string_lossy().trim().to_string());
        if let Some(raw) = raw.filter(|r| !r.is_empty()) {
            let root = self.config.current_dir.join(&raw);
            if root.extension() == Some(OsStr::new("app")) {
                add(root.join("Contents/Resources/bin"), Provenance::EnvironmentOverride);
            }
            add(root.clone(), Provenance::EnvironmentOverride);
            add(root.join("bin"), Provenance::EnvironmentOverride);
            add(root.join("Contents/Resources/bin"), Provenance::EnvironmentOverride);
        }

        // A verified Qnet.app beside the working directory or the executable.
        for anchor in self.search_anchors() {
            for ancestor in ancestors(&anchor, 7) {
                add(ancestor.join("Qnet.app/Contents/Resources/bin"), Provenance::NearbyAppBundle);
            }
        }

        // The development tree last: its binaries may not be relocated or signed.
        for root in &self.config.development_roots {
            add(self.config.current_dir.join(root), Provenance::SourceTree);
        }

        let mut seen = HashSet::new();
        roots.retain(|r| seen.insert((r.provenance, r.path.clone())));
        roots
    }

    fn search_anchors(&self) -> Vec<PathBuf> {
        let mut values = vec![standardize(&self.config.current_dir)];
        if let Some(dir) = &self.config.executable_dir {
            values.push(standardize(&self.config.current_dir.join(dir)));
        }
        let mut seen = HashSet::new();
        values.retain(|v| seen.insert(v.clone()));
        values
    }

    fn cached_probe(&self, path: &Path, timeout: Duration) -> ProbeResult {
        let (size, modified) = file_stamp(path);
        let key = standardize(path).to_string_lossy().into_owned();
        if let Some(hit) = lookup_cache(&self.probe_cache, &key, size, modified) {
            return hit;
        }
        let result = probe::launch_native_probe(path, &self.env_pairs, timeout);
        store_cache(&self.probe_cache, key, size, modified, &result);
        result
    }

    fn cached_python_probe(&self, interpreter: &Path, modules: &[String], timeout: Duration) -> ProbeResult {
        let (size, modified) = file_stamp(interpreter);
        let key = format!(
            "{}|{}|{}",
            standardize(interpreter).display(),
            modules.join("\u{1f}"),
            qnet_core::cfmt::f("%.6f", timeout.as_secs_f64())
        );
        if let Some(hit) = lookup_cache(&self.python_probe_cache, &key, size, modified) {
            return hit;
        }
        let result =
            probe::launch_python_probe(interpreter, modules, &self.config.current_dir, &self.env_pairs, timeout);
        store_cache(&self.python_probe_cache, key, size, modified, &result);
        result
    }
}

fn lookup_cache(cache: &Mutex<HashMap<String, CachedProbe>>, key: &str, size: u64, modified: (i64, i64)) -> Option<ProbeResult> {
    let cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    cache.get(key).filter(|c| c.size == size && c.modified == modified).map(|c| c.result.clone())
}

fn store_cache(cache: &Mutex<HashMap<String, CachedProbe>>, key: String, size: u64, modified: (i64, i64), result: &ProbeResult) {
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    cache.insert(key, CachedProbe { size, modified, result: result.clone() });
}

/// The file's size and modification time, or zeros when it can't be read. Like 0.90.34's
/// `attributesOfItem`, a symbolic link's own attributes are used, not its target's.
fn file_stamp(path: &Path) -> (u64, (i64, i64)) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return (0, (0, 0));
    };
    let modified = meta
        .modified()
        .ok()
        .map(|t| match t.duration_since(UNIX_EPOCH) {
            Ok(d) => (d.as_secs() as i64, d.subsec_nanos() as i64),
            Err(e) => (-(e.duration().as_secs() as i64), -(e.duration().subsec_nanos() as i64)),
        })
        .unwrap_or((0, 0));
    (meta.len(), modified)
}

/// Every candidate path for `name`: per root, each group then the root itself, deduplicated.
fn candidates(roots: &[SearchRoot], name: &str, subdirectory: &str, groups: &[&str]) -> Vec<SearchRoot> {
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let mut push = |path: PathBuf| {
            let path = standardize(&path);
            if seen.insert((root.provenance, path.clone())) {
                values.push(SearchRoot { path, provenance: root.provenance });
            }
        };
        for group in groups {
            push(root.path.join(group).join(subdirectory).join(name));
        }
        push(root.path.join(subdirectory).join(name));
    }
    values
}

/// The reason a bundle manifest gives for an `unavailable` row matching `<group>/<dir>/<name>`,
/// read from bundled, override and nearby-app roots (not the development tree), at the root and
/// up to two folders above it.
fn unavailable_reason(roots: &[SearchRoot], name: &str, subdirectory: &str, groups: &[&str]) -> Option<String> {
    let suffixes: HashSet<String> = groups.iter().map(|g| format!("{g}/{subdirectory}/{name}")).collect();
    for root in roots.iter().filter(|r| r.provenance != Provenance::SourceTree) {
        for manifest in manifest_candidates(&root.path) {
            let Ok(text) = std::fs::read_to_string(&manifest) else {
                continue;
            };
            if let Some(reason) = manifest_unavailable_reason(&text, &suffixes) {
                return Some(reason);
            }
        }
    }
    None
}

/// The first `unavailable` row of a manifest whose path is one of `suffixes`: its fourth field.
fn manifest_unavailable_reason(text: &str, suffixes: &HashSet<String>) -> Option<String> {
    for line in text.split(probe::is_newline).filter(|l| !l.is_empty()) {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() >= 4 && fields[0] == "unavailable" && suffixes.contains(fields[2]) {
            return Some(fields[3].to_string());
        }
    }
    None
}

fn manifest_candidates(root: &Path) -> Vec<PathBuf> {
    let parent = parent_of(root);
    let grandparent = parent_of(&parent);
    vec![root.join(MANIFEST_NAME), parent.join(MANIFEST_NAME), grandparent.join(MANIFEST_NAME)]
}

/// `start` and up to `limit - 1` of its parents.
fn ancestors(start: &Path, limit: usize) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut current = standardize(start);
    for _ in 0..limit {
        result.push(current.clone());
        let parent = parent_of(&current);
        if parent == current {
            break;
        }
        current = parent;
    }
    result
}

fn parent_of(path: &Path) -> PathBuf {
    path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf())
}

/// Foundation's `standardizedFileURL` path: `.` and empty components dropped, `..` removing the
/// component before it, by text alone (symbolic links are not resolved).
pub fn standardize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !out.has_root() {
                    out.push("..");
                }
            }
            Component::Normal(c) => out.push(c),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// Module names trimmed, empty ones dropped, duplicates removed in order.
fn normalized_module_names(raw: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    raw.iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty() && seen.insert(m.clone()))
        .collect()
}

/// `FileManager.fileExists(atPath:)`: anything at the path, following symbolic links.
fn file_exists(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

/// access(2) with `mode` (`X_OK` for `isExecutableFile`, `R_OK` for `isReadableFile`).
fn access_ok(path: &Path, mode: libc::c_int) -> bool {
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a NUL-terminated path that outlives the call.
    unsafe { libc::access(c.as_ptr(), mode) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standardizing_removes_dot_segments_by_text() {
        assert_eq!(standardize(Path::new("/a/./b//c/../d")), PathBuf::from("/a/b/d"));
        assert_eq!(standardize(Path::new("/..")), PathBuf::from("/"));
        assert_eq!(standardize(Path::new("/a/b/")), PathBuf::from("/a/b"));
    }

    #[test]
    fn ancestors_stop_at_the_limit_or_the_root() {
        assert_eq!(ancestors(Path::new("/a/b"), 7), vec![PathBuf::from("/a/b"), PathBuf::from("/a"), PathBuf::from("/")]);
        assert_eq!(ancestors(Path::new("/1/2/3/4/5/6/7/8/9"), 7).len(), 7);
    }

    #[test]
    fn a_manifest_row_needs_four_fields_and_the_unavailable_status() {
        let suffixes: HashSet<String> = ["infinite/BNAmd/mc_solver".to_string()].into_iter().collect();
        let text = "QNET_SOLVER_RUNTIME_V1\r\navailable\texecutable\tinfinite/BNAmd/mc_solver\tok\n\
                    unavailable\texecutable\tinfinite/BNAmd/mc_solver\n\
                    unavailable\texecutable\tinfinite/BNAmd/mc_solver\tneeds cJSON\textra\n";
        assert_eq!(manifest_unavailable_reason(text, &suffixes).as_deref(), Some("needs cJSON"));
        assert_eq!(manifest_unavailable_reason("unavailable\tx\tother/a/b\tno\n", &suffixes), None);
    }

    #[test]
    fn module_names_are_trimmed_and_deduplicated_in_order() {
        let raw: Vec<String> = ["numpy", " numpy ", " ", "scipy", "numpy"].iter().map(|s| s.to_string()).collect();
        assert_eq!(normalized_module_names(&raw), vec!["numpy".to_string(), "scipy".to_string()]);
    }

    #[test]
    fn the_bundle_resources_are_known_only_inside_an_app() {
        assert_eq!(
            bundle_resources_for(Path::new("/Applications/Qnet.app/Contents/MacOS")),
            Some(PathBuf::from("/Applications/Qnet.app/Contents/Resources"))
        );
        assert_eq!(bundle_resources_for(Path::new("/Users/x/target/debug")), None);
    }

    #[test]
    fn the_resolver_can_be_shared_between_threads() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Resolver>();
    }
}
