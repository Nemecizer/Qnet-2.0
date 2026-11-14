//! The solver resolver against fake solver trees, the real staged solvers and the golden runs.
//!
//! The first nine tests are 0.90.34's headless harness `validation/solver_runtime_resolver/
//! main.swift`, case for case with the same inputs and expectations (its "source tree found by
//! walking up from the working directory" is an explicit development root in 2.0). The rest pin
//! what the harness left implicit: the root order, the candidate list, the probes' arguments,
//! environment and timeouts, the caches, the Python search, every sentence word for word, the
//! dual-engine choice, all 17 staged solvers passing the real loadability probe, and the
//! "runtime" provenance of each golden run record.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use qnet_runner::resolver::*;

/// A scratch folder removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Scratch {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "qnet-runtime-resolver-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(standardize(&dir))
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(path: &Path, text: &str, executable: bool) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
    let mode = if executable { 0o755 } else { 0o644 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<OsString, OsString> {
    pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
}

fn config(bundle: Option<&Path>, vars: &[(&str, &str)], cwd: &Path) -> ResolverConfig {
    ResolverConfig {
        bundle_resources: bundle.map(Path::to_path_buf),
        env: env(vars),
        current_dir: cwd.to_path_buf(),
        executable_dir: None,
        development_roots: Vec::new(),
    }
}

/// A probe timeout for fakes that answer at once: generous, so a loaded machine running the
/// tests in parallel cannot turn a pass into a timeout (0.90.34's harness used 0.2 s).
const SHORT: Duration = Duration::from_millis(2000);

fn python_request(name: &str, modules: &[&str], timeout: Duration) -> PythonRequest {
    PythonRequest {
        interpreter_name: name.to_string(),
        required_modules: modules.iter().map(|m| m.to_string()).collect(),
        probe_timeout: timeout,
    }
}

/// The harness's shared fixture: a bundle whose solver the loader rejects, an override holding a
/// good copy and a Python support file, and a folder of fake interpreters.
struct Fixture {
    s: Scratch,
    resources: PathBuf,
    override_root: PathBuf,
    override_good: PathBuf,
    support: PathBuf,
    python_bin: PathBuf,
}

fn fixture() -> Fixture {
    let s = Scratch::new();
    let resources = s.path("bundle/Resources");
    write(
        &resources.join("bin/infinite/TestSolver/probe_solver"),
        "#!/bin/sh\necho 'dyld[123]: Library not loaded: /opt/homebrew/lib/libmissing.dylib' >&2\nexit 134\n",
        true,
    );
    let override_root = s.path("override");
    let override_good = override_root.join("infinite/TestSolver/probe_solver");
    write(&override_good, "#!/bin/sh\nexit 64\n", true);
    let support = override_root.join("finite/Support/tool.py");
    write(&support, "print('ok')\n", false);
    let python_bin = s.path("python-bin");
    std::fs::create_dir_all(&python_bin).unwrap();
    Fixture { s, resources, override_root, override_good, support, python_bin }
}

impl Fixture {
    fn python_resolver(&self) -> Resolver {
        Resolver::new(config(
            None,
            &[("QNET_SOLVER_ROOT", self.override_root.to_str().unwrap()), ("PATH", self.python_bin.to_str().unwrap())],
            &self.s.0,
        ))
    }
    fn tool(&self, r: &Resolver, interpreter: &str, modules: &[&str], timeout: Duration) -> SolverLookup {
        r.resolve_python_support_file_in("tool.py", "Support", &["finite"], &python_request(interpreter, modules, timeout))
    }
}

// ---- 0.90.34's harness, case for case ----

/// A recorded file's text as this Mac would have written it. The corpus is published with its
/// recording Mac's home folder written as `/Users/nobody` (plain and JSON-escaped; see
/// scripts/make-golden-runs.sh); the comparison needs this Mac's own.
fn golden_read(path: impl AsRef<std::path::Path>) -> std::io::Result<String> {
    let text = std::fs::read_to_string(path)?;
    let Some(home) = std::env::var("HOME").ok().filter(|h| !h.is_empty()) else { return Ok(text) };
    Ok(text.replace("\\/Users\\/nobody", &home.replace('/', "\\/")).replace("/Users/nobody", &home))
}

#[test]
fn a_broken_bundled_binary_falls_through_to_the_override() {
    let f = fixture();
    let r = Resolver::new(config(Some(&f.resources), &[("QNET_SOLVER_ROOT", f.override_root.to_str().unwrap())], &f.s.0));
    let lookup = r.resolve_executable_in("probe_solver", "TestSolver", &["infinite"], SHORT);
    assert_eq!(lookup.url(), Some(f.override_good.as_path()));
    assert_eq!(lookup.resolution.as_ref().unwrap().provenance, Provenance::EnvironmentOverride);
    let rejected: Vec<&Attempt> = lookup.attempts.iter().filter(|a| a.outcome == Outcome::LoaderRejected).collect();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0].detail, "dyld[123]: Library not loaded: /opt/homebrew/lib/libmissing.dylib");
    assert_eq!(rejected[0].provenance, Provenance::BundledResources);
}

#[test]
fn a_nearby_app_is_preferred_over_the_development_tree() {
    let s = Scratch::new();
    let project = s.path("project");
    let nearby_good = project.join("Qnet.app/Contents/Resources/bin/infinite/TestSolver/nearby");
    write(&nearby_good, "#!/bin/sh\nexit 0\n", true);
    write(
        &project.join("infinite/TestSolver/nearby"),
        "#!/bin/sh\necho 'dyld: Library not loaded: libstale.dylib' >&2\nexit 134\n",
        true,
    );
    let nested = project.join("work/deep");
    std::fs::create_dir_all(&nested).unwrap();
    let mut c = config(None, &[], &nested);
    c.development_roots = vec![project.clone()];
    let lookup = Resolver::new(c).resolve_executable_in("nearby", "TestSolver", &["infinite"], SHORT);
    assert_eq!(lookup.url(), Some(nearby_good.as_path()));
    assert_eq!(lookup.resolution.unwrap().provenance, Provenance::NearbyAppBundle);
}

#[test]
fn a_readable_support_file_resolves_without_an_interpreter() {
    let f = fixture();
    let r = Resolver::new(config(Some(&f.resources), &[("QNET_SOLVER_ROOT", f.override_root.to_str().unwrap())], &f.s.0));
    let lookup = r.resolve_support_file_in("tool.py", "Support", &["finite"]);
    assert_eq!(lookup.url(), Some(f.support.as_path()));
    let resolution = lookup.resolution.unwrap();
    assert_eq!(resolution.runtime_executable, None);
    assert_eq!(resolution.probe_detail, "support file is readable");
}

#[test]
fn a_python_support_file_keeps_its_interpreter_and_module_check() {
    let f = fixture();
    let good = f.python_bin.join("qnet-python-good");
    write(&good, "#!/bin/sh\necho \"$0 (Python test runtime)\"\nexit 0\n", true);
    let lookup = f.tool(&f.python_resolver(), "qnet-python-good", &["numpy", "numpy", " "], SHORT);
    assert_eq!(lookup.url(), Some(f.support.as_path()));
    let resolution = lookup.resolution.clone().unwrap();
    assert_eq!(resolution.runtime_executable.as_deref(), Some(good.as_path()));
    assert_eq!(
        resolution.probe_detail,
        format!("support file is readable; Python preflight passed with {} (Python test runtime); imported modules: numpy", good.display())
    );
    assert_eq!(
        resolution.provenance_description(),
        format!("QNET_SOLVER_ROOT: {}; Python runtime: {}", f.support.display(), good.display())
    );
    let prefix = lookup.launch_prefix().unwrap();
    assert_eq!(prefix.to_argv(), vec![good.into_os_string(), "-B".into(), f.support.clone().into_os_string()]);
}

#[test]
fn the_systems_python_passes_a_real_import_probe() {
    let f = fixture();
    let mut vars: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    vars.insert("QNET_SOLVER_ROOT".into(), f.override_root.clone().into_os_string());
    let r = Resolver::new(ResolverConfig {
        bundle_resources: None,
        env: vars,
        current_dir: f.s.0.clone(),
        executable_dir: None,
        development_roots: Vec::new(),
    });
    let lookup = r.resolve_python_support_file_in("tool.py", "Support", &["finite"], &PythonRequest::with_modules(&["json"]));
    assert_eq!(lookup.url(), Some(f.support.as_path()), "{}", lookup.actionable_diagnostic());
    let resolution = lookup.resolution.unwrap();
    assert!(resolution.runtime_executable.is_some());
    assert!(resolution.probe_detail.contains("(Python 3."), "{}", resolution.probe_detail);
    assert!(resolution.probe_detail.ends_with("; imported modules: json"));
}

#[test]
fn a_missing_interpreter_is_reported_as_not_found() {
    let f = fixture();
    let lookup = f.tool(&f.python_resolver(), "qnet-python-missing", &[], SHORT);
    assert_eq!(lookup.url(), None);
    assert!(lookup.attempts.iter().any(|a| a.outcome == Outcome::RuntimeUnavailable));
    assert_eq!(
        lookup.actionable_diagnostic(),
        format!(
            "No loadable copy of tool.py was found for Support.\nCandidates checked:\n• {} [QNET_SOLVER_ROOT]: Python runtime \
             'qnet-python-missing' was not found in PATH or a standard installation location\nInstall a usable Python 3 runtime \
             and any named modules, then relaunch Qnet.\nRebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT \
             at a verified Qnet solver tree.",
            f.support.display()
        )
    );
}

#[test]
fn a_missing_module_reports_the_import_error() {
    let f = fixture();
    let python = f.python_bin.join("qnet-python-no-module");
    write(&python, "#!/bin/sh\necho \"ModuleNotFoundError: No module named 'numpy'\" >&2\nexit 1\n", true);
    let lookup = f.tool(&f.python_resolver(), "qnet-python-no-module", &["numpy"], SHORT);
    assert_eq!(lookup.url(), None);
    assert_eq!(
        lookup.actionable_diagnostic(),
        format!(
            "No loadable copy of tool.py was found for Support.\nCandidates checked:\n• {} [QNET_SOLVER_ROOT]: Python preflight \
             could not import required module(s) numpy. {}: Python preflight exited with status 1: ModuleNotFoundError: No \
             module named 'numpy'\nInstall a usable Python 3 runtime and any named modules, then relaunch Qnet.\nRebuild \
             Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree.",
            f.support.display(),
            python.display()
        )
    );
}

#[test]
fn a_hanging_interpreter_times_out_within_its_bound() {
    let f = fixture();
    write(&f.python_bin.join("qnet-python-hangs"), "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n", true);
    let start = Instant::now();
    let lookup = f.tool(&f.python_resolver(), "qnet-python-hangs", &[], Duration::from_millis(100));
    let elapsed = start.elapsed();
    assert_eq!(lookup.url(), None);
    let diagnostic = lookup.actionable_diagnostic();
    assert!(diagnostic.contains("Python interpreter preflight failed. "), "{diagnostic}");
    assert!(diagnostic.contains(": Python preflight timed out after 0.10 seconds\n"), "{diagnostic}");
    assert!(elapsed < Duration::from_millis(1250), "took {elapsed:?}");
}

#[test]
fn a_manifest_unavailable_row_is_surfaced() {
    let f = fixture();
    write(
        &f.resources.join(MANIFEST_NAME),
        "QNET_SOLVER_RUNTIME_V1\nunavailable\texecutable\tinfinite/BNAmd/mc_solver\trequires research dependencies\n",
        false,
    );
    let r = Resolver::new(config(Some(&f.resources), &[], &f.s.0));
    let lookup = r.resolve_executable_in("mc_solver", "BNAmd", &["infinite"], SHORT);
    assert_eq!(lookup.url(), None);
    assert_eq!(lookup.declared_unavailable_reason.as_deref(), Some("requires research dependencies"));
    assert_eq!(
        lookup.actionable_diagnostic(),
        "No loadable copy of mc_solver was found for BNAmd.\nThis app build declares the solver unavailable: requires \
         research dependencies\nSearched the app bundle, QNET_SOLVER_ROOT, a nearby Qnet.app, and the development source \
         tree.\nRebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified Qnet solver tree."
    );
}

// ---- What the harness left implicit ----

#[test]
fn roots_are_searched_bundle_then_override_then_nearby_app_then_development_tree() {
    let s = Scratch::new();
    let cwd = s.path("a/b");
    let exe = s.path("x/MacOS");
    let r = Resolver::new(ResolverConfig {
        bundle_resources: Some(s.path("Q.app/Contents/Resources")),
        env: env(&[("QNET_SOLVER_ROOT", &format!("  {}  ", s.path("Other.app").display()))]),
        current_dir: cwd.clone(),
        executable_dir: Some(exe.clone()),
        development_roots: vec![s.path("dev1"), PathBuf::from("rel/dev2")],
    });
    let roots = r.search_roots();
    let mut expected = vec![
        (s.path("Q.app/Contents/Resources/bin"), Provenance::BundledResources),
        (s.path("Other.app/Contents/Resources/bin"), Provenance::EnvironmentOverride),
        (s.path("Other.app"), Provenance::EnvironmentOverride),
        (s.path("Other.app/bin"), Provenance::EnvironmentOverride),
    ];
    for anchor in [&cwd, &exe] {
        let mut dir = anchor.clone();
        for _ in 0..7 {
            let candidate = (dir.join("Qnet.app/Contents/Resources/bin"), Provenance::NearbyAppBundle);
            if !expected.contains(&candidate) {
                expected.push(candidate);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    expected.push((s.path("dev1"), Provenance::SourceTree));
    expected.push((cwd.join("rel/dev2"), Provenance::SourceTree));
    let got: Vec<(PathBuf, Provenance)> = roots.into_iter().map(|r| (r.path, r.provenance)).collect();
    assert_eq!(got, expected);
}

#[test]
fn each_root_is_tried_per_group_then_directly_without_duplicates() {
    let s = Scratch::new();
    let r = Resolver::new(config(None, &[("QNET_SOLVER_ROOT", s.path("root").to_str().unwrap())], &s.path("cwd")));
    let lookup = r.resolve_executable("nothing", "Dir");
    let override_paths: Vec<PathBuf> = lookup
        .attempts
        .iter()
        .filter(|a| a.provenance == Provenance::EnvironmentOverride)
        .map(|a| a.path.clone())
        .collect();
    assert_eq!(
        override_paths,
        ["root/finite/Dir/nothing", "root/infinite/Dir/nothing", "root/Dir/nothing", "root/bin/finite/Dir/nothing",
         "root/bin/infinite/Dir/nothing", "root/bin/Dir/nothing", "root/Contents/Resources/bin/finite/Dir/nothing",
         "root/Contents/Resources/bin/infinite/Dir/nothing", "root/Contents/Resources/bin/Dir/nothing"]
            .iter()
            .map(|p| s.path(p))
            .collect::<Vec<_>>()
    );
    assert!(lookup.attempts.iter().all(|a| a.outcome == Outcome::NotFound && a.detail == "not found"));
    assert_eq!(
        lookup.actionable_diagnostic(),
        "No loadable copy of nothing was found for Dir.\nSearched the app bundle, QNET_SOLVER_ROOT, a nearby Qnet.app, and \
         the development source tree.\nRebuild Qnet.app to bundle its libraries, or point QNET_SOLVER_ROOT at a verified \
         Qnet solver tree."
    );
}

#[test]
fn a_file_without_execute_permission_is_recorded_and_skipped() {
    let s = Scratch::new();
    let root = s.path("root");
    write(&root.join("finite/D/tool"), "#!/bin/sh\nexit 0\n", false);
    let good = root.join("infinite/D/tool");
    write(&good, "#!/bin/sh\nexit 0\n", true);
    let r = Resolver::new(config(None, &[("QNET_SOLVER_ROOT", root.to_str().unwrap())], &s.0));
    let lookup = r.resolve_executable("tool", "D");
    assert_eq!(lookup.url(), Some(good.as_path()));
    assert_eq!(lookup.attempts[0].outcome, Outcome::NotExecutable);
    assert_eq!(lookup.attempts[0].detail, "the file exists but lacks execute permission");
    assert_eq!(lookup.attempts[1].outcome, Outcome::Selected);
    assert_eq!(lookup.attempts[1].detail, "dynamic loader probe passed (probe exit status 0)");
    assert_eq!(
        lookup.actionable_diagnostic(),
        format!("Using QNET_SOLVER_ROOT: {}. dynamic loader probe passed (probe exit status 0)", good.display())
    );
    assert_eq!(lookup.launch_prefix().unwrap().to_argv(), vec![good.into_os_string()]);
}

#[test]
fn the_loadability_probe_runs_with_its_flag_marker_and_own_folder_and_no_stdin() {
    let s = Scratch::new();
    let root = s.path("root");
    let record = s.path("record.txt");
    let tool = root.join("finite/D/tool");
    write(
        &tool,
        &format!(
            "#!/bin/sh\n{{ echo \"args=$*\"; echo \"marker=$QNET_RUNTIME_PROBE\"; echo \"extra=$EXTRA\"; echo \"pwd=$(pwd -P)\"; \
             echo \"stdin=$(cat)\"; }} > '{}'\nexit 64\n",
            record.display()
        ),
        true,
    );
    let r = Resolver::new(config(None, &[("QNET_SOLVER_ROOT", root.to_str().unwrap()), ("EXTRA", "kept"), ("PATH", "/usr/bin:/bin")], &s.0));
    let lookup = r.resolve_executable("tool", "D");
    assert_eq!(lookup.resolution.unwrap().probe_detail, "dynamic loader probe passed (probe exit status 64)");
    let folder = std::fs::canonicalize(root.join("finite/D")).unwrap();
    assert_eq!(
        std::fs::read_to_string(&record).unwrap(),
        format!("args=--qnet-loadability-probe\nmarker=1\nextra=kept\npwd={}\nstdin=\n", folder.display())
    );
}

#[test]
fn a_solver_still_running_at_the_deadline_passes_and_is_stopped() {
    let s = Scratch::new();
    let root = s.path("root");
    write(&root.join("finite/D/slow"), "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n", true);
    let r = Resolver::new(config(None, &[("QNET_SOLVER_ROOT", root.to_str().unwrap())], &s.0));
    let start = Instant::now();
    let lookup = r.resolve_executable_in("slow", "D", DEFAULT_GROUPS, Duration::from_millis(150));
    assert!(start.elapsed() < Duration::from_millis(1500), "took {:?}", start.elapsed());
    assert_eq!(lookup.resolution.unwrap().probe_detail, "dynamic loader probe passed (process reached user code)");
}

#[test]
fn a_loader_message_before_the_deadline_still_rejects_a_solver_that_keeps_running() {
    let s = Scratch::new();
    let root = s.path("root");
    write(
        &root.join("finite/D/stuck"),
        "#!/bin/sh\necho 'dyld: Symbol not found: _x' >&2\necho '  Referenced from: y' >&2\nwhile :; do :; done\n",
        true,
    );
    let r = Resolver::new(config(None, &[("QNET_SOLVER_ROOT", root.to_str().unwrap())], &s.0));
    let lookup = r.resolve_executable("stuck", "D");
    assert_eq!(lookup.url(), None, "{:?}", lookup.attempts);
    assert_eq!(lookup.attempts.iter().find(|a| a.outcome == Outcome::LoaderRejected).unwrap().detail,
               "dyld: Symbol not found: _x   Referenced from: y");
}

#[test]
fn the_diagnostic_lists_at_most_eight_candidates() {
    let s = Scratch::new();
    let mut c = config(None, &[], &s.0);
    for i in 0..10 {
        let root = s.path(&format!("dev{i}"));
        write(&root.join("finite/D/tool"), "#!/bin/sh\nexit 0\n", false);
        c.development_roots.push(root);
    }
    let lookup = Resolver::new(c).resolve_executable("tool", "D");
    let text = lookup.actionable_diagnostic();
    assert_eq!(text.matches("\n• ").count(), 8);
    assert!(text.contains(&format!("\n• {} [development source tree]: the file exists but lacks execute permission\n",
                                   s.path("dev0/finite/D/tool").display())));
}

#[test]
fn native_probes_are_cached_until_the_file_changes() {
    let s = Scratch::new();
    let root = s.path("root");
    let count = s.path("count");
    let tool = root.join("finite/D/tool");
    let script = format!("#!/bin/sh\necho x >> '{}'\nexit 0\n", count.display());
    write(&tool, &script, true);
    let r = Resolver::new(config(None, &[("QNET_SOLVER_ROOT", root.to_str().unwrap())], &s.0));
    let runs = || std::fs::read_to_string(&count).map_or(0, |t| t.lines().count());
    assert!(r.resolve_executable("tool", "D").url().is_some());
    assert!(r.resolve_executable("tool", "D").url().is_some());
    assert_eq!(runs(), 1);
    write(&tool, &format!("{script}# changed\n"), true);
    assert!(r.resolve_executable("tool", "D").url().is_some());
    assert_eq!(runs(), 2);
    // A fresh resolver has its own cache.
    let r2 = Resolver::new(config(None, &[("QNET_SOLVER_ROOT", root.to_str().unwrap())], &s.0));
    assert!(r2.resolve_executable("tool", "D").url().is_some());
    assert_eq!(runs(), 3);
}

#[test]
fn python_probes_are_cached_per_interpreter_modules_and_timeout() {
    let f = fixture();
    let count = f.s.path("count");
    write(&f.python_bin.join("qnet-python-count"), &format!("#!/bin/sh\necho x >> '{}'\necho ok\n", count.display()), true);
    let r = f.python_resolver();
    let runs = || std::fs::read_to_string(&count).map_or(0, |t| t.lines().count());
    for _ in 0..2 {
        assert!(f.tool(&r, "qnet-python-count", &["numpy"], SHORT).url().is_some());
    }
    assert_eq!(runs(), 1);
    assert!(f.tool(&r, "qnet-python-count", &["scipy"], SHORT).url().is_some());
    assert_eq!(runs(), 2);
    assert!(f.tool(&r, "qnet-python-count", &["scipy"], Duration::from_millis(3000)).url().is_some());
    assert_eq!(runs(), 3);
}

#[test]
fn python_is_looked_for_on_path_with_an_empty_entry_meaning_the_working_directory() {
    let s = Scratch::new();
    let a = s.path("a");
    let b = s.path("b");
    let cwd = s.path("cwd");
    write(&a.join("py"), "#!/bin/sh\n", true);
    write(&b.join("py"), "#!/bin/sh\n", false);
    write(&cwd.join("py"), "#!/bin/sh\n", true);
    let path_var = format!("{}::{}:{}/:{}", a.display(), a.display(), b.display(), a.display());
    let r = Resolver::new(config(None, &[("PATH", &path_var)], &cwd));
    assert_eq!(r.executable_candidates("py"), vec![a.join("py"), cwd.join("py")]);
    assert_eq!(r.executable_candidates(" ./py "), vec![cwd.join("py")]);
    assert_eq!(r.executable_candidates(""), Vec::<PathBuf>::new());
    // No PATH at all is one empty entry: the working directory.
    let bare = Resolver::new(config(None, &[], &cwd));
    assert_eq!(bare.executable_candidates("py"), vec![cwd.join("py")]);
    // python3 adds the three standard locations, in order, when they exist.
    let fixed: Vec<PathBuf> = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
        .iter()
        .map(PathBuf::from)
        .filter(|p| std::fs::metadata(p).is_ok())
        .collect();
    assert_eq!(bare.executable_candidates("python3"), fixed);
}

#[test]
fn the_python_probe_passes_its_arguments_environment_and_working_directory() {
    let f = fixture();
    let record = f.s.path("record.txt");
    write(
        &f.python_bin.join("qnet-python-record"),
        &format!(
            "#!/bin/sh\nfor a in \"$@\"; do echo \"[$a]\"; done > '{}'\necho \"bytecode=$PYTHONDONTWRITEBYTECODE pwd=$(/bin/pwd -P)\" >> '{}'\n",
            record.display(),
            record.display()
        ),
        true,
    );
    let lookup = f.tool(&f.python_resolver(), "qnet-python-record", &["numpy", "scipy"], SHORT);
    assert!(lookup.url().is_some(), "{}", lookup.actionable_diagnostic());
    let cwd = std::fs::canonicalize(&f.s.0).unwrap();
    assert_eq!(
        std::fs::read_to_string(&record).unwrap(),
        format!(
            "[-B]\n[-c]\n[import importlib, sys; [importlib.import_module(name) for name in sys.argv[1:]]; print(f'{{sys.executable}} \
             (Python {{sys.version_info.major}}.{{sys.version_info.minor}}.{{sys.version_info.micro}})')]\n[numpy]\n[scipy]\n\
             bytecode=1 pwd={}\n",
            cwd.display()
        )
    );
    // An interpreter that prints nothing passes with its own path named.
    assert_eq!(
        lookup.resolution.unwrap().probe_detail,
        format!(
            "support file is readable; Python preflight passed with {}; imported modules: numpy, scipy",
            f.python_bin.join("qnet-python-record").display()
        )
    );
}

#[test]
fn the_python_probe_output_goes_to_temporary_files_that_are_removed() {
    if std::fs::metadata("/usr/sbin/lsof").is_err() {
        eprintln!("note: /usr/sbin/lsof is absent; the probe's temporary file names were not checked");
        return;
    }
    let f = fixture();
    let record = f.s.path("fd1.txt");
    write(
        &f.python_bin.join("qnet-python-fd"),
        &format!("#!/bin/sh\n/usr/sbin/lsof -a -p $$ -d 1,2 -Fn | /usr/bin/sed -n 's/^n//p' > '{}'\necho ok\n", record.display()),
        true,
    );
    // lsof walks every process and takes seconds on a busy Mac, so the allowance is generous.
    let lookup = f.tool(&f.python_resolver(), "qnet-python-fd", &[], Duration::from_secs(30));
    assert!(lookup.url().is_some(), "{}", lookup.actionable_diagnostic());
    let paths: Vec<String> = std::fs::read_to_string(&record).unwrap().lines().map(str::to_string).collect();
    assert_eq!(paths.len(), 2, "{paths:?}");
    let tmp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    for (path, ext) in paths.iter().zip([".out", ".err"]) {
        let p = Path::new(path);
        let name = p.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("qnet-python-probe-") && name.ends_with(ext), "{name}");
        assert_eq!(name.len(), "qnet-python-probe-".len() + 36 + ext.len());
        assert_eq!(std::fs::canonicalize(p.parent().unwrap()).unwrap(), tmp);
        assert!(std::fs::metadata(p).is_err(), "{path} was left behind");
    }
}

#[test]
fn a_python_probe_that_prints_is_quoted_in_its_detail() {
    let f = fixture();
    write(&f.python_bin.join("qnet-python-say"), "#!/bin/sh\nprintf '  /x/python3 (Python 3.12.1)\\n\\n'\n", true);
    let r = f.python_resolver();
    let runtime = r.resolve_python_runtime(&python_request("qnet-python-say", &[], SHORT));
    assert_eq!(runtime.actionable_diagnostic(), "Python preflight passed with /x/python3 (Python 3.12.1)");
    let lookup = f.tool(&r, "qnet-python-say", &[], SHORT);
    assert_eq!(
        lookup.resolution.unwrap().probe_detail,
        "support file is readable; Python preflight passed with /x/python3 (Python 3.12.1); no optional modules required"
    );
}

#[test]
fn every_failing_interpreter_is_tried_and_at_most_four_are_named() {
    let s = Scratch::new();
    let mut dirs = Vec::new();
    for i in 0..5 {
        let d = s.path(&format!("p{i}"));
        write(&d.join("py"), &format!("#!/bin/sh\necho 'fail {i}' >&2\nexit {}\n", i + 1), true);
        dirs.push(d.display().to_string());
    }
    let r = Resolver::new(config(None, &[("PATH", &dirs.join(":"))], &s.0));
    let lookup = r.resolve_python_runtime(&python_request("py", &[], SHORT));
    assert_eq!(lookup.attempts.len(), 5);
    let expected: Vec<String> = (0..4)
        .map(|i| format!("{}/py: Python preflight exited with status {}: fail {i}", dirs[i], i + 1))
        .collect();
    assert_eq!(lookup.actionable_diagnostic(), format!("Python interpreter preflight failed. {}", expected.join("; ")));
}

#[test]
fn the_resolver_can_be_used_from_several_threads_at_once() {
    let s = Scratch::new();
    let root = s.path("root");
    for i in 0..6 {
        write(&root.join(format!("finite/D{i}/tool")), "#!/bin/sh\nexit 0\n", true);
    }
    let r = Arc::new(Resolver::new(config(None, &[("QNET_SOLVER_ROOT", root.to_str().unwrap())], &s.0)));
    let handles: Vec<_> = (0..24)
        .map(|i| {
            let r = Arc::clone(&r);
            std::thread::spawn(move || r.resolve_executable("tool", &format!("D{}", i % 6)).url().map(Path::to_path_buf))
        })
        .collect();
    for (i, h) in handles.into_iter().enumerate() {
        assert_eq!(h.join().unwrap(), Some(root.join(format!("finite/D{}/tool", i % 6))));
    }
}

// ---- Dual-engine choice ----

/// A tree with a working C engine and Python script for every dual-engine method, and a fake
/// `python3` first on PATH.
fn engine_tree(with_c: bool, with_python: bool) -> (Scratch, Resolver, PathBuf) {
    let s = Scratch::new();
    let root = s.path("root");
    for method in DualEngineMethod::ALL {
        let native = method.native_executable();
        if with_c {
            write(&root.join(native.groups[0]).join(native.subdirectory).join(native.name), "#!/bin/sh\nexit 2\n", true);
        }
        let (script, dir) = method.python_script();
        if with_python {
            write(&root.join(native.groups[0]).join(dir).join(script), "print(1)\n", false);
        }
    }
    let python = s.path("pybin/python3");
    write(&python, "#!/bin/sh\necho \"$0 (Python 3.99.0)\"\n", true);
    let r = Resolver::new(config(
        None,
        &[("QNET_SOLVER_ROOT", root.to_str().unwrap()), ("PATH", s.path("pybin").to_str().unwrap())],
        &s.0,
    ));
    (s, r, python)
}

#[test]
fn the_preferred_engine_runs_when_it_resolves() {
    let (s, r, python) = engine_tree(true, true);
    let c = r.resolve_engine(DualEngineMethod::RegenerativeMonteCarlo, SolverEngine::C).unwrap();
    let exe = s.path("root/infinite/BNArmc/bna_rmc");
    assert_eq!(c.engine, SolverEngine::C);
    assert_eq!(c.launch.to_argv(), vec![exe.clone().into_os_string()]);
    assert_eq!(c.provenance, format!("C engine; QNET_SOLVER_ROOT: {}", exe.display()));
    assert!(!c.fell_back());

    let py = r.resolve_engine(DualEngineMethod::FiniteGenericCtmc, SolverEngine::Python).unwrap();
    let script = s.path("root/finite/fBNAgc/solver.py");
    assert_eq!(py.engine, SolverEngine::Python);
    assert_eq!(py.launch.to_argv(), vec![python.clone().into_os_string(), "-B".into(), script.clone().into_os_string()]);
    assert_eq!(
        py.provenance,
        format!("Python engine; QNET_SOLVER_ROOT: {}; Python runtime: {}", script.display(), python.display())
    );
    assert_eq!(py.note, None);
}

#[test]
fn an_unavailable_engine_falls_back_to_the_other_with_a_warning() {
    let (s, r, python) = engine_tree(false, true);
    let got = r.resolve_engine(DualEngineMethod::MatrixAnalyticQbd, SolverEngine::C).unwrap();
    let script = s.path("root/infinite/BNAqbd/qbd_solver.py");
    assert_eq!(got.engine, SolverEngine::Python);
    assert_eq!(
        got.provenance,
        format!("Python engine (fallback); QNET_SOLVER_ROOT: {}; Python runtime: {}", script.display(), python.display())
    );
    assert_eq!(
        got.note.as_deref(),
        Some(
            "Exact Matrix-Analytic QBD: the C engine is not available in this installation, so the Python engine ran \
             instead. The two produce the same result; only the run time differs. Settings ▸ Solvers ▸ Solver Engine chooses."
        )
    );

    let (s, r, _) = engine_tree(true, false);
    let got = r.resolve_engine(DualEngineMethod::TruncatedCtmc, SolverEngine::Python).unwrap();
    assert_eq!(got.engine, SolverEngine::C);
    assert_eq!(got.provenance, format!("C engine (fallback); QNET_SOLVER_ROOT: {}", s.path("root/infinite/BNAtc/bna_tc").display()));
    assert_eq!(
        got.note.as_deref(),
        Some(
            "Adaptive Truncated CTMC: the Python engine is not available in this installation, so the C engine ran \
             instead. The two produce the same result; only the run time differs. Settings ▸ Solvers ▸ Solver Engine chooses."
        )
    );
}

#[test]
fn a_method_with_neither_engine_is_refused_naming_both() {
    let (_s, r, _) = engine_tree(false, false);
    let expected = [
        "Neither engine for Regenerative Monte Carlo could be resolved: no loadable bna_rmc and no runnable regenerative_mc.py. Rebuild the solvers with ./build_all_algorithms.sh, or reinstall the application.",
        "Neither engine for Exact Matrix-Analytic QBD could be resolved: no loadable bna_qbd and no runnable qbd_solver.py. Rebuild the solvers with ./build_all_algorithms.sh, or reinstall the application.",
        "Neither engine for Adaptive Truncated CTMC could be resolved: no loadable bna_tc and no runnable truncated_ctmc.py. Rebuild the solvers with ./build_all_algorithms.sh, or reinstall the application.",
        "Neither engine for Exact Sparse CTMC could be resolved: no loadable fbna_gc and no runnable solver.py. Rebuild the solvers with ./build_all_algorithms.sh, or reinstall the application.",
    ];
    for (method, sentence) in DualEngineMethod::ALL.into_iter().zip(expected) {
        for preferred in [SolverEngine::C, SolverEngine::Python] {
            let err = r.resolve_engine(method, preferred).unwrap_err();
            assert_eq!(err.diagnostic, sentence);
            assert_eq!(err.native.requested_name, method.native_executable().name);
            assert_eq!(err.python.requested_name, method.python_script().0);
        }
    }
}

#[test]
fn the_engine_setting_reads_one_as_python_and_anything_else_as_c() {
    assert_eq!(SolverEngine::from_stored(0), SolverEngine::C);
    assert_eq!(SolverEngine::from_stored(1), SolverEngine::Python);
    assert_eq!(SolverEngine::from_stored(7), SolverEngine::C);
    assert_eq!(SolverEngine::from_stored(-1), SolverEngine::C);
    assert_eq!(SolverEngine::Python.stored_value(), 1);
    assert_eq!(DualEngineMethod::TruncatedCtmc.storage_key(), DualEngineMethod::FiniteGenericCtmc.storage_key());
    assert_eq!(DualEngineMethod::RegenerativeMonteCarlo.storage_key(), "engine.regenerative");
    assert_eq!(DualEngineMethod::MatrixAnalyticQbd.storage_key(), "engine.qbd");
}

// ---- The real staged solvers and the golden runs ----

/// The staged tree from `scripts/stage-solvers.sh`, or None (with a note) when it is absent.
fn staged_resources() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let resources = PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources");
    if resources.join("bin").is_dir() {
        Some(resources)
    } else {
        eprintln!("note: {} is absent; run scripts/stage-solvers.sh to check the staged solvers", resources.display());
        None
    }
}

fn staged_resolver(resources: &Path) -> Resolver {
    let mut vars: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    vars.insert("QNET_SOLVER_ROOT".into(), resources.as_os_str().to_owned());
    let cwd = std::env::temp_dir();
    Resolver::new(ResolverConfig {
        bundle_resources: None,
        env: vars,
        current_dir: standardize(&cwd),
        executable_dir: None,
        development_roots: Vec::new(),
    })
}

/// The 17 native solvers 2.0 ships (the staged manifest's executable rows).
const SHIPPED: [&str; 17] = [
    "infinite/BNAsbd/bna_sbd",
    "infinite/BNAqna/bna_qna",
    "infinite/BNArqna/bna_rqna",
    "infinite/BNAsim/jackson_sim",
    "infinite/BNAsm/bnet",
    "infinite/BNAlp/srbm_lp",
    "infinite/BNAmc/rbm_mlmc",
    "finite/fBNAfm/bna_fm_gauss",
    "finite/fBNAfm/bna_fm_cbc",
    "finite/fBNAlp/fBNAlp_solver",
    "finite/fBNAsim/fBNAsim",
    "finite/fBNAsm/srbm_solver",
    "infinite/BNArmc/bna_rmc",
    "infinite/BNAqbd/bna_qbd",
    "infinite/BNAtc/bna_tc",
    "finite/fBNAgc/fbna_gc",
    "infinite/BNAmd/mc_solver",
];

#[test]
fn all_17_staged_solvers_resolve_and_pass_the_real_loadability_probe() {
    let Some(resources) = staged_resources() else { return };
    let r = Arc::new(staged_resolver(&resources));
    let handles: Vec<_> = SHIPPED
        .iter()
        .map(|rel| {
            let r = Arc::clone(&r);
            let rel = rel.to_string();
            std::thread::spawn(move || {
                let parts: Vec<&str> = rel.split('/').collect();
                (rel.clone(), r.resolve_executable(parts[2], parts[1]))
            })
        })
        .collect();
    for h in handles {
        let (rel, lookup) = h.join().unwrap();
        let resolution = lookup.resolution.clone().unwrap_or_else(|| panic!("{rel}: {}", lookup.actionable_diagnostic()));
        assert_eq!(resolution.path, standardize(&resources.join("bin").join(&rel)), "{rel}");
        assert_eq!(resolution.provenance, Provenance::EnvironmentOverride, "{rel}");
        assert!(resolution.probe_detail.starts_with("dynamic loader probe passed ("), "{rel}: {}", resolution.probe_detail);
        assert!(lookup.attempts.iter().all(|a| a.outcome != Outcome::LoaderRejected), "{rel}: {:?}", lookup.attempts);
    }
}

#[test]
fn every_dual_engine_method_resolves_both_engines_from_the_staged_tree() {
    let Some(resources) = staged_resources() else { return };
    let r = staged_resolver(&resources);
    for method in DualEngineMethod::ALL {
        for preferred in [SolverEngine::C, SolverEngine::Python] {
            let got = r.resolve_engine(method, preferred).unwrap_or_else(|e| panic!("{}", e.diagnostic));
            assert_eq!(got.engine, preferred, "{method:?}: {:?}", got.note);
            assert!(got.provenance.starts_with(&format!("{}; QNET_SOLVER_ROOT: ", preferred.descriptive_name())));
        }
    }
}

/// Every string value stored under the key "runtime" in a JSON tree.
fn runtime_values(json: &qnet_core::json::Json, out: &mut Vec<String>) {
    if let Some(object) = json.as_object() {
        for (key, value) in object {
            match value.as_str() {
                Some(text) if key == "runtime" => out.push(text.to_string()),
                _ => runtime_values(value, out),
            }
        }
    } else if let Some(items) = json.as_array() {
        for item in items {
            runtime_values(item, out);
        }
    }
}

#[test]
fn the_golden_runs_runtime_provenance_is_reproduced() {
    let Some(resources) = staged_resources() else { return };
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("../golden/runs");
    if !golden.join("PROVENANCE.json").is_file() {
        eprintln!("note: golden/runs is not generated yet; the runtime provenance was not compared");
        return;
    }
    let r = staged_resolver(&resources);
    let bin = format!("{}/", standardize(&resources.join("bin")).display());
    let mut compared = 0;
    for example in std::fs::read_dir(&golden).unwrap().flatten() {
        let Ok(methods) = std::fs::read_dir(example.path()) else { continue };
        for method in methods.flatten() {
            let Ok(text) = golden_read(method.path().join("record.json")) else { continue };
            let mut values = Vec::new();
            runtime_values(&qnet_core::json::parse(&text).unwrap(), &mut values);
            for runtime in values {
                let (engine, rest) = match runtime.split_once("; QNET_SOLVER_ROOT: ") {
                    Some((engine, path)) => (Some(engine.to_string()), format!("QNET_SOLVER_ROOT: {path}")),
                    None => (None, runtime.clone()),
                };
                let path_part = rest.strip_prefix("QNET_SOLVER_ROOT: ").expect("an override provenance");
                let (script_path, python) = match path_part.split_once("; Python runtime: ") {
                    Some((p, py)) => (p, Some(py)),
                    None => (path_part, None),
                };
                let rel = script_path.strip_prefix(&bin).unwrap_or_else(|| panic!("{runtime} is outside {bin}"));
                let parts: Vec<&str> = rel.split('/').collect();
                let (name, dir) = (parts[2], parts[1]);
                let ours = if let Some(engine) = &engine {
                    let method = DualEngineMethod::ALL
                        .into_iter()
                        .find(|m| m.native_executable().name == name || m.python_script() == (name, dir))
                        .unwrap();
                    let preferred = if engine.starts_with("C engine") { SolverEngine::C } else { SolverEngine::Python };
                    r.resolve_engine(method, preferred).unwrap().provenance
                } else if python.is_some() {
                    let modules: &[&str] = if name == "ctmc_dtandem.py" { &["numpy"] } else { &[] };
                    r.resolve_python_support_file(name, dir, modules).resolution.unwrap().provenance_description()
                } else {
                    r.resolve_executable(name, dir).resolution.unwrap().provenance_description()
                };
                match python {
                    Some(py) if !ours.ends_with(&format!("; Python runtime: {py}")) => {
                        // A different PATH can pick a different python3; the rest must still agree.
                        let cut = ours.find("; Python runtime: ").unwrap();
                        assert_eq!(&ours[..cut], &runtime[..runtime.find("; Python runtime: ").unwrap()]);
                        eprintln!("note: {runtime} matched apart from the interpreter ({ours})");
                    }
                    _ => assert_eq!(ours, runtime),
                }
                compared += 1;
            }
        }
    }
    eprintln!("compared {compared} golden runtime strings");
}

// ---- Qnet's own Python (ROADMAP A2) ----

/// A bundle, a home folder and a PATH folder, each able to hold a fake `python3`, and a Python
/// support file found through `QNET_SOLVER_ROOT`.
struct OwnPython {
    s: Scratch,
    resources: PathBuf,
    bundled: PathBuf,
    staged: PathBuf,
    users: PathBuf,
    script: PathBuf,
}

fn own_python() -> OwnPython {
    let s = Scratch::new();
    let resources = s.path("Qnet.app/Contents/Resources");
    let bundled = resources.join("python/bin/python3");
    let staged = s.path("home/Library/Caches/qnet/python/stage/Resources/python/bin/python3");
    let users = s.path("userbin/python3");
    let script = s.path("root/infinite/BNApf/solver.py");
    write(&script, "print(1)\n", false);
    OwnPython { s, resources, bundled, staged, users, script }
}

impl OwnPython {
    fn resolver(&self) -> Resolver {
        Resolver::new(config(
            Some(&self.resources),
            &[
                ("QNET_SOLVER_ROOT", self.s.path("root").to_str().unwrap()),
                ("HOME", self.s.path("home").to_str().unwrap()),
                ("PATH", self.s.path("userbin").to_str().unwrap()),
            ],
            &self.s.0,
        ))
    }
    fn says(path: &Path, version: &str) {
        write(path, &format!("#!/bin/sh\necho \"$0 (Python {version})\"\n"), true);
    }
    /// The candidates this fixture controls (the three standard locations depend on the Mac).
    fn candidates(&self) -> Vec<PathBuf> {
        self.resolver().executable_candidates("python3").into_iter().filter(|p| p.starts_with(&self.s.0)).collect()
    }
}

#[test]
fn qnets_own_python_comes_before_the_users() {
    let f = own_python();
    OwnPython::says(&f.bundled, "3.1.1");
    OwnPython::says(&f.staged, "3.2.2");
    OwnPython::says(&f.users, "3.3.3");
    let r = f.resolver();
    assert_eq!(r.bundled_python(), Some(f.bundled.clone()));
    assert_eq!(r.development_python(), Some(f.staged.clone()));
    assert_eq!(f.candidates(), vec![f.bundled.clone(), f.staged.clone(), f.users.clone()]);

    // The bundled interpreter is used, and the run record's "runtime" names it.
    let lookup = r.resolve_python_support_file("solver.py", "BNApf", &["numpy"]);
    let resolution = lookup.resolution.clone().unwrap();
    assert_eq!(resolution.runtime_executable.as_deref(), Some(f.bundled.as_path()));
    assert_eq!(
        resolution.provenance_description(),
        format!("QNET_SOLVER_ROOT: {}; Python runtime: {}", f.script.display(), f.bundled.display())
    );
    assert_eq!(
        resolution.probe_detail,
        format!("support file is readable; Python preflight passed with {} (Python 3.1.1); imported modules: numpy", f.bundled.display())
    );
    assert_eq!(
        lookup.launch_prefix().unwrap().to_argv(),
        vec![f.bundled.clone().into_os_string(), "-B".into(), f.script.clone().into_os_string()]
    );

    // Without it (a run from the source tree) the staged one; without that, the user's own.
    std::fs::remove_file(&f.bundled).unwrap();
    assert_eq!(f.candidates(), vec![f.staged.clone(), f.users.clone()]);
    let runtime = f.resolver().resolve_python_runtime(&PythonRequest::default());
    assert_eq!(runtime.resolution.unwrap().executable, f.staged);
    std::fs::remove_file(&f.staged).unwrap();
    let runtime = f.resolver().resolve_python_runtime(&PythonRequest::default());
    assert_eq!(runtime.resolution.unwrap().executable, f.users);
}

#[test]
fn a_bundled_python_that_fails_its_check_gives_way_to_the_users() {
    let f = own_python();
    write(&f.bundled, "#!/bin/sh\necho \"ModuleNotFoundError: No module named 'cvxpy'\" >&2\nexit 1\n", true);
    OwnPython::says(&f.users, "3.3.3");
    let runtime = f.resolver().resolve_python_runtime(&PythonRequest::with_modules(&["cvxpy"]));
    assert_eq!(runtime.resolution.as_ref().unwrap().executable, f.users);
    assert_eq!(runtime.attempts.len(), 2);
    assert_eq!(runtime.attempts[0].executable, f.bundled);
    assert!(!runtime.attempts[0].loadable);

    // When none will do, 0.90.34's sentence, the bundled interpreter named first.
    write(&f.users, "#!/bin/sh\necho no >&2\nexit 2\n", true);
    let r = f.resolver();
    let runtime = r.resolve_python_runtime(&PythonRequest::with_modules(&["cvxpy"]));
    assert!(runtime.resolution.is_none());
    let diagnostic = runtime.actionable_diagnostic();
    assert!(
        diagnostic.starts_with(&format!(
            "Python preflight could not import required module(s) cvxpy. {}: Python preflight exited with status 1: \
             ModuleNotFoundError: No module named 'cvxpy'; {}: Python preflight exited with status 2: no",
            f.bundled.display(),
            f.users.display()
        )),
        "{diagnostic}"
    );
    let lookup = r.resolve_python_support_file("solver.py", "BNApf", &["cvxpy"]);
    assert!(lookup.actionable_diagnostic().contains("Install a usable Python 3 runtime and any named modules, then relaunch Qnet."));
}

#[test]
fn only_python3_means_qnets_own_python() {
    let f = own_python();
    OwnPython::says(&f.bundled, "3.1.1");
    OwnPython::says(&f.staged, "3.2.2");
    write(&f.s.path("userbin/pypy3"), "#!/bin/sh\necho pypy\n", true);
    let r = f.resolver();
    assert_eq!(r.executable_candidates("pypy3"), vec![f.s.path("userbin/pypy3")]);
    assert_eq!(r.executable_candidates("/usr/bin/python3").len(), usize::from(Path::new("/usr/bin/python3").exists()));
    // No bundle and no home folder: nothing of Qnet's own to offer.
    let bare = Resolver::new(config(None, &[("PATH", f.s.path("userbin").to_str().unwrap())], &f.s.0));
    assert_eq!((bare.bundled_python(), bare.development_python()), (None, None));
}

/// The real runtime `scripts/stage-python.sh` staged, copied to stand as a bundle's: it is
/// chosen with nothing else on offer (no PATH, no HOME), imports NumPy, and ignores a hostile
/// PYTHONPATH. Skipped when the runtime has not been staged.
#[test]
fn the_staged_runtime_works_as_a_bundled_one_with_no_python_installed() {
    let Some(home) = std::env::var_os("HOME") else { return };
    let staged = PathBuf::from(home).join("Library/Caches/qnet/python/stage/Resources");
    if !staged.join(OWN_PYTHON).is_file() {
        eprintln!("skipped: no staged Python runtime (scripts/stage-python.sh)");
        return;
    }
    let s = Scratch::new();
    let script = s.path("root/finite/fBNActmc/ctmc_dtandem.py");
    write(&script, "print(1)\n", false);
    // A module of the user's that must not be imported in place of the runtime's.
    write(&s.path("leak/numpy.py"), "raise SystemExit('the user PYTHONPATH leaked in')\n", false);
    let r = Resolver::new(config(
        Some(&staged),
        &[
            ("QNET_SOLVER_ROOT", s.path("root").to_str().unwrap()),
            ("PATH", s.path("nowhere").to_str().unwrap()),
            ("PYTHONPATH", s.path("leak").to_str().unwrap()),
        ],
        &s.0,
    ));
    let lookup = r.resolve_python_support_file("ctmc_dtandem.py", "fBNActmc", &["numpy"]);
    let resolution = lookup.resolution.clone().unwrap_or_else(|| panic!("{}", lookup.actionable_diagnostic()));
    assert_eq!(resolution.runtime_executable, Some(staged.join(OWN_PYTHON)));
    assert!(
        resolution.probe_detail.starts_with(&format!(
            "support file is readable; Python preflight passed with {}/python/bin/python3.",
            staged.display()
        )) && resolution.probe_detail.ends_with("); imported modules: numpy"),
        "{}",
        resolution.probe_detail
    );
    assert!(resolution.provenance_description().ends_with(&format!("; Python runtime: {}/python/bin/python3", staged.display())));
}
