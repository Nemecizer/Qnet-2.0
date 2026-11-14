//! The startup dependency check (Help ▸ Check Dependencies…, and at launch for a source-tree run;
//! 0.90.34 StartupDependencyChecker.swift; ledger ANA-237…ANA-250, FILE-032, INV-033).
//!
//! [`dependency_catalog`] answers which build this is (packaged: running from inside a `.app`, or
//! `QNET_STARTUP_CHECK_MODE=packaged|development`) and lists its rows in 0.90.34's order, with
//! each row's scope and repair commands; the rows' names and summaries are words, in
//! src/analysis/words.ts. What the two lists are for (ROADMAP A1, A2):
//!
//! - A packaged app needs nothing installed: it carries its Python, its solvers and their
//!   libraries. Its rows only confirm that each of those is in the bundle and starts; none has an
//!   install command, because nothing installed on the Mac changes a signed bundle.
//! - A source-tree run is a developer's: the solvers and the libraries they link are built from
//!   source, by `scripts/build-deps.sh` (which needs Xcode's command-line tools and cmake) and
//!   `scripts/stage-solvers.sh`. Its rows check those two tools, the Python the solvers will use,
//!   and that the libraries have been built. Nothing is taken from Homebrew when a solver is built
//!   or run (0.90.34 linked Homebrew's libomp, SuiteSparse, HiGHS, cJSON and gcc@13, and checked
//!   each formula with `brew list --versions`; those rows are gone). Homebrew is only one way to
//!   install cmake, which is why that row still names a formula.
//!
//! [`dependency_probe`] checks one row:
//!
//! - Xcode's command-line tools: `/usr/bin/xcode-select -p` (2 s) names the developer folder, and
//!   its `usr/bin/clang` must be there.
//! - cmake: the first `cmake` on the probes' `PATH`, `cmake --version` (2 s).
//! - The solver libraries: `manifest.json` in `$QNET_DEPS_DIR` or `~/Library/Caches/qnet/deps`
//!   (written by `scripts/build-deps.sh`) and every library it lists under `prefix/lib`.
//! - Python and its modules: an interpreter through the solver resolver (2 s probe, importing the
//!   row's modules), then `python3 -B -c <check>` (2 s). 2.0 carries its own Python with NumPy
//!   (ROADMAP A2; the resolver tries it first), so a packaged app lists "Python 3" and "NumPy" as
//!   bundled rows with nothing to install, their result reading "Bundled with Qnet: Python 3.x.y",
//!   and has no CVXPY row: the bundled Python runs the BAR bounds and has no CVXPY, and a
//!   `pip install` into another Python would not change that. A source-tree run keeps 0.90.34's
//!   three rows, checked against whichever interpreter the resolver finds (the staged one first).
//! - A bundled solver: the resolver's lookup with its 0.8 s launch check, which must come from the
//!   app's own resources.
//!
//! Each probe process gets stdin from /dev/null, `PATH` prefixed with the standard folders, and
//! writes to `qnet-dependency-<uuid>.out/.err` in the temporary folder, removed afterwards; past
//! its time it is sent SIGTERM, and SIGKILL 0.2 s later. The page runs the rows one at a time.
//! (`/opt/homebrew/bin` and `/usr/local/bin` are on that `PATH` so a cmake or a Python installed
//! there is found when Qnet is started from the Finder; no solver or library is looked for there.)

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use qnet_runner::resolver::{bundle_resources_for, Provenance, PythonRequest, Resolver};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::errors::QnError;
use crate::runs::Runs;

/// Why a row is in the checklist (`StartupDependencyScope`).
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub enum Scope {
    Runtime,
    Optional,
    Bundled,
    Developer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// Xcode's command-line tools (the compiler the solvers and their libraries are built with).
    XcodeTools,
    /// cmake, which `scripts/build-deps.sh` builds the libraries with.
    Cmake,
    /// The libraries `scripts/build-deps.sh` builds for the solvers.
    SolverLibraries,
    Python { modules: &'static [&'static str], code: &'static str },
    Bundled { name: &'static str, subdirectory: &'static str, group: &'static str },
}

/// One row of the catalog (src/lib/types.ts `DependencyRequirement`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub id: &'static str,
    pub scope: Scope,
    pub brew_formulae: Vec<&'static str>,
    pub supplemental_install_commands: Vec<&'static str>,
    #[serde(skip)]
    pub probe: Probe,
}

const PYTHON_CODE: &str = "import sys; assert sys.version_info >= (3, 9), 'Qnet requires Python 3.9 or newer'; print(f'Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')";
const NUMPY_CODE: &str = "import numpy as np; print(f'NumPy {np.__version__}')";
const CVXPY_CODE: &str = "import cvxpy as cp; choices = sorted({'SCS', 'CLARABEL', 'CVXOPT', 'MOSEK'} & set(cp.installed_solvers())); assert choices, 'CVXPY has no supported SDP solver'; print(f'CVXPY {cp.__version__}; solver {choices[0]}')";

fn req(id: &'static str, scope: Scope, probe: Probe, formulae: &[&'static str], supplemental: &[&'static str]) -> Requirement {
    Requirement { id, scope, probe, brew_formulae: formulae.to_vec(), supplemental_install_commands: supplemental.to_vec() }
}

fn bundled(name: &'static str, subdirectory: &'static str) -> Probe {
    Probe::Bundled { name, subdirectory, group: "infinite" }
}

/// The checklist of a packaged app or of a source-tree run (ANA-239, ANA-240). A packaged app's
/// rows are all its own contents, with nothing to install; a source-tree run's are what a
/// developer needs to build the solvers, each with the command that provides it.
pub fn requirements(packaged: bool) -> Vec<Requirement> {
    let mut out = Vec::new();
    if !packaged {
        out.push(req("developer.xcode-tools", Scope::Developer, Probe::XcodeTools, &[], &["xcode-select --install"]));
        out.push(req("developer.cmake", Scope::Developer, Probe::Cmake, &["cmake"], &[]));
    }
    if packaged {
        // The app's own Python and NumPy: nothing for the user to install.
        out.push(req("runtime.python", Scope::Bundled, Probe::Python { modules: &[], code: PYTHON_CODE }, &[], &[]));
        out.push(req("optional.numpy", Scope::Bundled, Probe::Python { modules: &["numpy"], code: NUMPY_CODE }, &[], &[]));
    } else {
        out.push(req("runtime.python", Scope::Runtime, Probe::Python { modules: &[], code: PYTHON_CODE }, &["python"], &[]));
        out.push(req("optional.numpy", Scope::Optional, Probe::Python { modules: &["numpy"], code: NUMPY_CODE }, &["numpy"], &[]));
        out.push(req("optional.cvxpy", Scope::Optional, Probe::Python { modules: &["numpy", "cvxpy"], code: CVXPY_CODE }, &[], &["python3 -m pip install cvxpy"]));
    }
    if packaged {
        // One solver for each bundled library: it starts only if the library is in the bundle
        // and loads. (0.90.34 had a "GCC 13 runtime" row too; no solver links GCC's runtime now.)
        out.push(req("bundled.rqna", Scope::Bundled, bundled("bna_rqna", "BNArqna"), &[], &[]));
        out.push(req("bundled.libomp", Scope::Bundled, bundled("jackson_sim", "BNAsim"), &[], &[]));
        out.push(req("bundled.suite-sparse", Scope::Bundled, bundled("bnet", "BNAsm"), &[], &[]));
        out.push(req("bundled.highs", Scope::Bundled, bundled("srbm_lp", "BNAlp"), &[], &[]));
        out.push(req("optional.cjson", Scope::Bundled, bundled("mc_solver", "BNAmd"), &[], &[]));
    } else {
        out.push(req("developer.solver-libraries", Scope::Developer, Probe::SolverLibraries, &[], &["bash scripts/build-deps.sh"]));
    }
    out
}

/// `StartupDependencyCatalog.isPackagedApplication`: `QNET_STARTUP_CHECK_MODE` decides when set to
/// "packaged" or "development"; otherwise the app is packaged when it runs from inside a `.app`.
pub fn is_packaged(mode: Option<&str>, executable_dir: Option<&Path>) -> bool {
    match mode {
        Some("packaged") => true,
        Some("development") => false,
        _ => executable_dir.and_then(bundle_resources_for).is_some(),
    }
}

fn packaged_now() -> bool {
    let mode = std::env::var("QNET_STARTUP_CHECK_MODE").ok();
    let exe = std::env::current_exe().ok();
    is_packaged(mode.as_deref(), exe.as_deref().and_then(Path::parent))
}

/// What [`dependency_catalog`] answers.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    /// A packaged app: the checklist does not open at launch (ANA-237).
    pub packaged: bool,
    pub items: Vec<Requirement>,
}

#[tauri::command]
pub fn dependency_catalog() -> Catalog {
    let packaged = packaged_now();
    Catalog { packaged, items: requirements(packaged) }
}

/// A row's result (`StartupDependencyStatus`, without pending and checking, which are the page's).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", content = "detail", rename_all = "camelCase")]
pub enum Status {
    Available(String),
    Missing(String),
    TimedOut(String),
}

/// What one probe process did.
#[derive(Debug, Default)]
pub struct CommandResult {
    pub exit_status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub launch_error: Option<String>,
}

/// The probes' `PATH`: the standard folders first, then the app's own.
fn probe_path() -> String {
    let standard = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    format!("{standard}:{}", std::env::var("PATH").unwrap_or_default())
}

/// Runs `program arguments` as 0.90.34's probe did (ANA-247, FILE-032).
pub fn run(program: &Path, arguments: &[&str], timeout: Duration, extra_env: &[(&str, &str)]) -> CommandResult {
    let token = crate::analysis_windows::upper_uuid();
    let tmp = std::env::temp_dir();
    let out_path = tmp.join(format!("qnet-dependency-{token}.out"));
    let err_path = tmp.join(format!("qnet-dependency-{token}.err"));
    struct Remove(Vec<PathBuf>);
    impl Drop for Remove {
        fn drop(&mut self) {
            for p in &self.0 {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    let _remove = Remove(vec![out_path.clone(), err_path.clone()]);
    let (out, err) = match (File::create(&out_path), File::create(&err_path)) {
        (Ok(o), Ok(e)) => (o, e),
        _ => return CommandResult { launch_error: Some("temporary output files could not be created".into()), ..Default::default() },
    };
    let mut cmd = Command::new(program);
    cmd.args(arguments).stdin(Stdio::null()).stdout(out).stderr(err).env("PATH", probe_path());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return CommandResult { launch_error: Some(e.to_string()), ..Default::default() },
    };
    let wait_until = |child: &mut std::process::Child, limit: Duration| -> Option<ExitStatus> {
        let start = Instant::now();
        loop {
            if let Ok(Some(s)) = child.try_wait() {
                return Some(s);
            }
            if start.elapsed() >= limit {
                return None;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    let mut timed_out = false;
    let mut status = wait_until(&mut child, timeout.max(Duration::from_millis(100)));
    if status.is_none() {
        timed_out = true;
        // SAFETY: signalling our own child by its pid.
        unsafe { libc_kill(child.id() as i32, 15) };
        status = wait_until(&mut child, Duration::from_millis(200));
        if status.is_none() {
            let _ = child.kill();
            status = wait_until(&mut child, Duration::from_millis(200));
        }
    }
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default().trim().to_string();
    CommandResult { exit_status: status.and_then(|s| s.code()), stdout: read(&out_path), stderr: read(&err_path), timed_out, launch_error: None }
}

extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

/// The first four lines joined by spaces, at most 600 characters (`compact`).
pub fn compact(text: &str) -> String {
    let joined = text.split(['\n', '\r']).filter(|l| !l.is_empty()).take(4).collect::<Vec<_>>().join(" ");
    joined.chars().take(600).collect()
}

/// `status(from:availableFallback:missingFallback:)` (ANA-248).
pub fn status_from(result: &CommandResult, available_fallback: &str, missing_fallback: &str) -> Status {
    if result.timed_out {
        return Status::TimedOut("The check did not finish within two seconds.".into());
    }
    if let Some(e) = &result.launch_error {
        return Status::Missing(format!("{missing_fallback} {e}"));
    }
    if result.exit_status == Some(0) {
        return Status::Available(if result.stdout.is_empty() { available_fallback.to_string() } else { compact(&result.stdout) });
    }
    let detail = if !result.stderr.is_empty() {
        result.stderr.as_str()
    } else if !result.stdout.is_empty() {
        result.stdout.as_str()
    } else {
        missing_fallback
    };
    Status::Missing(compact(detail))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The first executable called `name` in the folders of `path` (a `PATH` value).
pub fn find_on_path(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':').filter(|c| !c.is_empty()).map(|c| Path::new(c).join(name)).find(|c| is_executable(c))
}

const TWO_SECONDS: Duration = Duration::from_secs(2);

/// Xcode's command-line tools, from what `xcode-select -p` answered: the developer folder it
/// names must hold the compiler.
pub fn xcode_tools_status(result: &CommandResult) -> Status {
    const MISSING: &str = "Xcode's command-line tools are not installed. They provide the compiler that builds the solvers.";
    match status_from(result, "", MISSING) {
        Status::Available(folder) if !folder.is_empty() && is_executable(&Path::new(&folder).join("usr/bin/clang")) => Status::Available(format!("Command-line tools at {folder}")),
        Status::Available(_) => Status::Missing(MISSING.into()),
        Status::Missing(_) => Status::Missing(MISSING.into()),
        timed_out => timed_out,
    }
}

/// Where `scripts/build-deps.sh` builds: `$QNET_DEPS_DIR`, or `~/Library/Caches/qnet/deps`.
pub fn deps_dir(qnet_deps_dir: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    qnet_deps_dir.filter(|d| !d.is_empty()).map(PathBuf::from).or_else(|| home.filter(|h| !h.is_empty()).map(|h| Path::new(h).join("Library/Caches/qnet/deps")))
}

/// The part of `scripts/build-deps.sh`'s `manifest.json` the check reads.
#[derive(Deserialize)]
struct DepsManifest {
    components: Vec<DepsComponent>,
}
#[derive(Deserialize)]
struct DepsComponent {
    key: String,
    version: String,
    libraries: Vec<DepsLibrary>,
}
#[derive(Deserialize)]
struct DepsLibrary {
    file: String,
}

/// The solvers' libraries, as `scripts/build-deps.sh` left them in `dir`: its manifest, and each
/// library the manifest lists in `prefix/lib`.
pub fn solver_libraries_status(dir: Option<&Path>) -> Status {
    const BUILD: &str = "Run scripts/build-deps.sh in the repository (it needs cmake and Xcode's command-line tools), then scripts/stage-solvers.sh.";
    let Some(dir) = dir else { return Status::Missing(format!("The folder the solvers' libraries are built in is not known (HOME is not set). {BUILD}")) };
    let manifest = dir.join("manifest.json");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        return Status::Missing(format!("The solvers' libraries have not been built yet: {} does not exist. {BUILD}", manifest.display()));
    };
    let Ok(manifest) = serde_json::from_str::<DepsManifest>(&text) else {
        return Status::Missing(format!("{} could not be read. {BUILD}", manifest.display()));
    };
    let lib = dir.join("prefix/lib");
    if let Some(gone) = manifest.components.iter().flat_map(|c| &c.libraries).find(|l| !lib.join(&l.file).is_file()) {
        return Status::Missing(format!("{} is missing from {}. {BUILD}", gone.file, lib.display()));
    }
    let built = manifest.components.iter().map(|c| format!("{} {}", c.key, c.version)).collect::<Vec<_>>().join(", ");
    Status::Available(format!("Built by scripts/build-deps.sh: {built}"))
}

/// One row's probe (`probeSynchronously`).
pub fn probe(requirement: &Requirement, resolver: &Resolver) -> Status {
    match requirement.probe {
        Probe::XcodeTools => xcode_tools_status(&run(Path::new("/usr/bin/xcode-select"), &["-p"], TWO_SECONDS, &[])),
        Probe::Cmake => {
            let Some(cmake) = find_on_path("cmake", &probe_path()) else {
                return Status::Missing("cmake was not found. scripts/build-deps.sh needs it to build the solvers' libraries.".into());
            };
            let r = run(&cmake, &["--version"], TWO_SECONDS, &[]);
            match status_from(&r, "cmake is ready.", "cmake could not be started.") {
                // Its first line is the version; the next says who maintains it.
                Status::Available(_) => Status::Available(format!("{} at {}", r.stdout.lines().next().filter(|l| !l.is_empty()).unwrap_or("cmake"), cmake.display())),
                other => other,
            }
        }
        Probe::SolverLibraries => solver_libraries_status(deps_dir(std::env::var("QNET_DEPS_DIR").ok().as_deref(), std::env::var("HOME").ok().as_deref()).as_deref()),
        Probe::Python { modules, code } => {
            let request = PythonRequest { required_modules: modules.iter().map(|m| m.to_string()).collect(), probe_timeout: TWO_SECONDS, ..PythonRequest::default() };
            let lookup = resolver.resolve_python_runtime(&request);
            let Some(runtime) = lookup.resolution.clone() else {
                let diagnostic = lookup.actionable_diagnostic();
                if requirement.scope == Scope::Bundled && lookup.attempts.is_empty() {
                    return Status::Missing("This Qnet.app does not contain its Python runtime.".into());
                }
                return if diagnostic.to_lowercase().contains("timed out") { Status::TimedOut(compact(&diagnostic)) } else { Status::Missing(compact(&diagnostic)) };
            };
            let r = run(&runtime.executable, &["-B", "-c", code], TWO_SECONDS, &[("PYTHONDONTWRITEBYTECODE", "1")]);
            match status_from(&r, &runtime.probe_detail, "The Python capability check failed.") {
                Status::Available(detail) => Status::Available(python_source(resolver, &runtime.executable, requirement.scope, &detail)),
                other => other,
            }
        }
        Probe::Bundled { name, subdirectory, group } => {
            let lookup = resolver.resolve_executable_in(name, subdirectory, &[group], Duration::from_millis(800));
            match &lookup.resolution {
                Some(r) if r.provenance == Provenance::BundledResources => Status::Available("Bundled with Qnet; the component passed its launch check.".into()),
                _ => Status::Missing(compact(&lookup.declared_unavailable_reason.clone().unwrap_or_else(|| format!("This Qnet.app does not contain a loadable {name} component.")))),
            }
        }
    }
}

/// A passed Python row's sentence, saying whose interpreter answered: the app's own ("Bundled
/// with Qnet: Python 3.15.2"), the one staged for a source-tree run, or one of the user's. A
/// packaged app whose own Python did not answer still runs its Python methods through the
/// user's, and says so.
fn python_source(resolver: &Resolver, executable: &Path, scope: Scope, detail: &str) -> String {
    if resolver.bundled_python().as_deref() == Some(executable) {
        format!("Bundled with Qnet: {detail}")
    } else if resolver.development_python().as_deref() == Some(executable) {
        format!("{detail}, Qnet's own (staged by scripts/stage-python.sh)")
    } else if scope == Scope::Bundled {
        format!("{detail} at {}; this Qnet.app's own Python did not answer, so the one installed on this Mac is used.", executable.display())
    } else {
        detail.to_string()
    }
}

/// Checks the row `id` of this build's catalog (it can take a few seconds: off the main thread).
#[tauri::command]
pub async fn dependency_probe(runs: State<'_, Runs>, id: String) -> Result<Status, QnError> {
    let requirement = requirements(packaged_now()).into_iter().find(|r| r.id == id).ok_or_else(|| QnError::invalid(format!("There's no dependency called “{id}”.")))?;
    let resolver = runs.resolver.clone();
    tauri::async_runtime::spawn_blocking(move || probe(&requirement, &resolver)).await.map_err(|e| QnError::invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use qnet_runner::resolver::ResolverConfig;

    /// Held by each test that starts a probe process: one of them counts the probes' temporary
    /// files, which another test's probe would otherwise add to while it looks.
    static PROBE_PROCESSES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn probing() -> std::sync::MutexGuard<'static, ()> {
        PROBE_PROCESSES.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ids(packaged: bool) -> Vec<&'static str> {
        requirements(packaged).iter().map(|r| r.id).collect()
    }

    #[test]
    fn the_catalogs_are_what_each_build_needs_in_order() {
        assert_eq!(ids(false), ["developer.xcode-tools", "developer.cmake", "runtime.python", "optional.numpy", "optional.cvxpy", "developer.solver-libraries"]);
        assert_eq!(ids(true), ["runtime.python", "optional.numpy", "bundled.rqna", "bundled.libomp", "bundled.suite-sparse", "bundled.highs", "optional.cjson"]);
        // A packaged app needs nothing installed: every row is its own contents, with no command.
        for r in requirements(true) {
            assert_eq!((r.scope, r.brew_formulae.len(), r.supplemental_install_commands.len()), (Scope::Bundled, 0, 0), "{}", r.id);
        }
        // A developer needs Xcode's tools and cmake, and runs scripts/build-deps.sh: no library
        // comes from Homebrew, and nothing asks for gcc.
        let dev = requirements(false);
        let commands = |id: &str| dev.iter().find(|r| r.id == id).map(|r| (r.brew_formulae.clone(), r.supplemental_install_commands.clone())).unwrap();
        assert_eq!(commands("developer.xcode-tools"), (vec![], vec!["xcode-select --install"]));
        assert_eq!(commands("developer.cmake"), (vec!["cmake"], vec![]));
        assert_eq!(commands("developer.solver-libraries"), (vec![], vec!["bash scripts/build-deps.sh"]));
        let formulae: Vec<&str> = [requirements(false), requirements(true)].concat().iter().flat_map(|r| r.brew_formulae.clone()).collect();
        assert_eq!(formulae, ["cmake", "python", "numpy"]);
        let cvx = requirements(false).into_iter().find(|r| r.id == "optional.cvxpy").unwrap();
        assert!(cvx.brew_formulae.is_empty());
        assert_eq!(cvx.supplemental_install_commands, ["python3 -m pip install cvxpy"]);
        // A packaged app carries its own Python and NumPy: bundled rows, nothing to install.
        for r in requirements(true).into_iter().filter(|r| matches!(r.probe, Probe::Python { .. })) {
            assert_eq!((r.scope, r.brew_formulae.len(), r.supplemental_install_commands.len()), (Scope::Bundled, 0, 0), "{}", r.id);
        }
        assert_eq!(requirements(false)[2].brew_formulae, ["python"]);
        let json = serde_json::to_value(requirements(false)).unwrap();
        assert_eq!(json[0]["scope"], "Developer");
        assert!(json[0].get("probe").is_none());
    }

    #[test]
    fn a_packaged_app_is_one_run_from_inside_a_dot_app_unless_the_mode_says() {
        let inside = Path::new("/Applications/Qnet.app/Contents/MacOS");
        let outside = Path::new("/Users/x/target/debug");
        assert!(is_packaged(None, Some(inside)));
        assert!(!is_packaged(None, Some(outside)));
        assert!(is_packaged(Some("packaged"), Some(outside)));
        assert!(!is_packaged(Some("development"), Some(inside)));
        assert!(is_packaged(Some("other"), Some(inside)));
    }

    #[test]
    fn results_map_to_0_90_34s_statuses() {
        let ok = CommandResult { exit_status: Some(0), stdout: "Homebrew 4.4.1\nline2\nline3\nline4\nline5".into(), ..Default::default() };
        assert_eq!(status_from(&ok, "ready", "failed"), Status::Available("Homebrew 4.4.1 line2 line3 line4".into()));
        let quiet = CommandResult { exit_status: Some(0), ..Default::default() };
        assert_eq!(status_from(&quiet, "ready", "failed"), Status::Available("ready".into()));
        let bad = CommandResult { exit_status: Some(1), stderr: "boom".into(), stdout: "out".into(), ..Default::default() };
        assert_eq!(status_from(&bad, "ready", "failed"), Status::Missing("boom".into()));
        let silent = CommandResult { exit_status: Some(1), ..Default::default() };
        assert_eq!(status_from(&silent, "ready", "failed"), Status::Missing("failed".into()));
        let slow = CommandResult { timed_out: true, ..Default::default() };
        assert_eq!(status_from(&slow, "ready", "failed"), Status::TimedOut("The check did not finish within two seconds.".into()));
        let unlaunched = CommandResult { launch_error: Some("No such file".into()), ..Default::default() };
        assert_eq!(status_from(&unlaunched, "ready", "failed"), Status::Missing("failed No such file".into()));
        assert_eq!(compact(&"x".repeat(700)).len(), 600);
        assert_eq!(serde_json::to_value(Status::TimedOut("t".into())).unwrap(), serde_json::json!({"state": "timedOut", "detail": "t"}));
    }

    #[test]
    fn probe_processes_run_with_null_stdin_are_stopped_at_their_time_and_leave_no_files() {
        let _alone = probing();
        let before = std::fs::read_dir(std::env::temp_dir()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("qnet-dependency-")).count();
        let r = run(Path::new("/bin/sh"), &["-c", "read x; echo got:$x; echo err >&2"], TWO_SECONDS, &[]);
        assert_eq!((r.exit_status, r.stdout.as_str(), r.stderr.as_str()), (Some(0), "got:", "err"));
        let started = Instant::now();
        let slow = run(Path::new("/bin/sleep"), &["5"], Duration::from_millis(200), &[]);
        assert!(slow.timed_out && started.elapsed() < Duration::from_secs(2));
        let path = run(Path::new("/bin/sh"), &["-c", "echo $PATH"], TWO_SECONDS, &[]);
        assert!(path.stdout.starts_with("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:"), "{}", path.stdout);
        let gone = run(Path::new("/no/such/program"), &[], TWO_SECONDS, &[]);
        assert!(gone.launch_error.is_some());
        let after = std::fs::read_dir(std::env::temp_dir()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("qnet-dependency-")).count();
        assert!(after <= before, "the .out and .err files are removed");
    }

    fn empty_resolver(dir: &Path) -> Resolver {
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), dir.as_os_str().to_os_string());
        Resolver::new(ResolverConfig { bundle_resources: None, env, current_dir: dir.to_path_buf(), executable_dir: None, development_roots: vec![dir.to_path_buf()] })
    }

    #[test]
    fn a_missing_bundled_solver_says_so() {
        let dir = std::env::temp_dir().join(format!("qnet-deps-{}", crate::analysis_windows::upper_uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let resolver = empty_resolver(&dir);
        let rqna = requirements(true).into_iter().find(|r| r.id == "bundled.rqna").unwrap();
        assert_eq!(probe(&rqna, &resolver), Status::Missing("This Qnet.app does not contain a loadable bna_rqna component.".into()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_developer_rows_check_the_build_tools_and_the_built_libraries() {
        let dir = std::env::temp_dir().join(format!("qnet-deps-{}", crate::analysis_windows::upper_uuid()));
        std::fs::create_dir_all(dir.join("bin")).unwrap();

        // cmake: the first executable of that name on the path.
        assert_eq!(find_on_path("cmake", dir.join("bin").to_str().unwrap()), None);
        fake_python(&dir.join("bin/cmake"), "echo 'cmake version 4.4.5'");
        assert_eq!(find_on_path("cmake", &format!("/nowhere::{}", dir.join("bin").display())), Some(dir.join("bin/cmake")));

        // Xcode's tools: the folder xcode-select names must hold clang.
        let missing = Status::Missing("Xcode's command-line tools are not installed. They provide the compiler that builds the solvers.".into());
        let none = CommandResult { exit_status: Some(2), stderr: "xcode-select: error: unable to get active developer directory".into(), ..Default::default() };
        assert_eq!(xcode_tools_status(&none), missing);
        let tools = dir.join("CommandLineTools");
        let named = CommandResult { exit_status: Some(0), stdout: tools.display().to_string(), ..Default::default() };
        assert_eq!(xcode_tools_status(&named), missing, "a folder without clang");
        fake_python(&tools.join("usr/bin/clang"), "true");
        assert_eq!(xcode_tools_status(&named), Status::Available(format!("Command-line tools at {}", tools.display())));
        assert!(matches!(xcode_tools_status(&CommandResult { timed_out: true, ..Default::default() }), Status::TimedOut(_)));

        // The libraries: build-deps.sh's manifest and every library it lists.
        let build = "Run scripts/build-deps.sh in the repository (it needs cmake and Xcode's command-line tools), then scripts/stage-solvers.sh.";
        let deps = dir.join("deps");
        assert_eq!(deps_dir(None, Some("/Users/x")), Some(PathBuf::from("/Users/x/Library/Caches/qnet/deps")));
        assert_eq!(deps_dir(Some("/elsewhere"), Some("/Users/x")), Some(PathBuf::from("/elsewhere")));
        assert_eq!(deps_dir(Some(""), None), None);
        assert_eq!(
            solver_libraries_status(Some(&deps)),
            Status::Missing(format!("The solvers' libraries have not been built yet: {} does not exist. {build}", deps.join("manifest.json").display()))
        );
        std::fs::create_dir_all(deps.join("prefix/lib")).unwrap();
        let manifest = r#"{"components": [
            {"key": "libomp", "name": "LLVM OpenMP runtime (libomp)", "version": "23.1.5", "libraries": [{"file": "libomp.dylib", "loaded_as": "libomp.dylib"}]},
            {"key": "highs", "name": "HiGHS", "version": "1.16.0", "libraries": [{"file": "libhighs.1.16.0.dylib", "loaded_as": "libhighs.1.dylib"}]}]}"#;
        std::fs::write(deps.join("manifest.json"), manifest).unwrap();
        std::fs::write(deps.join("prefix/lib/libomp.dylib"), b"").unwrap();
        assert_eq!(solver_libraries_status(Some(&deps)), Status::Missing(format!("libhighs.1.16.0.dylib is missing from {}. {build}", deps.join("prefix/lib").display())));
        std::fs::write(deps.join("prefix/lib/libhighs.1.16.0.dylib"), b"").unwrap();
        assert_eq!(solver_libraries_status(Some(&deps)), Status::Available("Built by scripts/build-deps.sh: libomp 23.1.5, highs 1.16.0".into()));
        std::fs::write(deps.join("manifest.json"), "not json").unwrap();
        assert!(matches!(solver_libraries_status(Some(&deps)), Status::Missing(why) if why.ends_with(&format!("could not be read. {build}"))));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn fake_python(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_packaged_apps_python_rows_report_the_bundled_runtime() {
        let _alone = probing();
        let dir = std::env::temp_dir().join(format!("qnet-deps-{}", crate::analysis_windows::upper_uuid()));
        let resources = dir.join("Qnet.app/Contents/Resources");
        let users = dir.join("bin/python3");
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), dir.join("bin").into_os_string());
        let resolver = || Resolver::new(ResolverConfig { bundle_resources: Some(resources.clone()), env: env.clone(), current_dir: dir.clone(), executable_dir: None, development_roots: vec![] });
        let python = requirements(true).into_iter().find(|r| r.id == "runtime.python").unwrap();

        // The app's own interpreter answers.
        fake_python(&resources.join("python/bin/python3"), "echo 'Python 3.15.2'");
        assert_eq!(probe(&python, &resolver()), Status::Available("Bundled with Qnet: Python 3.15.2".into()));

        // It is broken and the Mac has a Python: the methods still run, and the row says with what.
        fake_python(&resources.join("python/bin/python3"), "echo broken >&2; exit 1");
        fake_python(&users, "echo 'Python 3.9.6'");
        assert_eq!(
            probe(&python, &resolver()),
            Status::Available(format!("Python 3.9.6 at {}; this Qnet.app's own Python did not answer, so the one installed on this Mac is used.", users.display()))
        );
        // The same interpreter in a source-tree run is simply the user's.
        let dev = requirements(false).into_iter().find(|r| r.id == "runtime.python").unwrap();
        assert_eq!(probe(&dev, &resolver()), Status::Available("Python 3.9.6".into()));

        // Neither: the bundled one's own failure is the reason.
        std::fs::remove_file(&users).unwrap();
        if !["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].iter().any(|p| Path::new(p).exists()) {
            let Status::Missing(why) = probe(&python, &resolver()) else { panic!("expected a missing row") };
            assert!(why.starts_with("Python interpreter preflight failed. ") && why.contains("broken"), "{why}");
            std::fs::remove_file(resources.join("python/bin/python3")).unwrap();
            assert_eq!(probe(&python, &resolver()), Status::Missing("This Qnet.app does not contain its Python runtime.".into()));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
