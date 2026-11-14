//! The machine interface (new in 2.1, cli/src/api.rs, docs/CLI.md): each JSON subcommand of the
//! built `qnet-cli`, on example networks, against the core functions it is written over; `build`
//! and `describe` against the files; `methods` against the fixture the app's Method Chooser is
//! held to (cli/tests/fixtures/methods.json); and `run --json` against a recorded 0.90.34 run.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use qnet_core::json::{self, Json};
use qnet_core::model::Network;
use qnet_core::sensitivity::{self, Context, Family, Measure, ParamSpec};
use qnet_core::{bnet, closed, jackson, optimise, transient, uncertainty};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn example(name: &str) -> String {
    root().join("examples").join(format!("{name}.bnet")).to_string_lossy().into_owned()
}

fn network(name: &str) -> Network {
    bnet::read(&std::fs::read_to_string(example(name)).unwrap()).unwrap()
}

fn cli(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_qnet-cli")).args(args).output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8(out.stdout).unwrap(), String::from_utf8(out.stderr).unwrap())
}

/// The document a command prints, which must exit 0 and carry the envelope.
fn document(args: &[&str]) -> Json {
    let (code, out, err) = cli(args);
    assert_eq!(code, 0, "{args:?}: {err}");
    let v = json::parse(&out).unwrap_or_else(|e| panic!("{args:?} did not print JSON ({e}): {out}"));
    assert_eq!(at(&v, "schema").as_i64(), Some(1), "{args:?}");
    assert_eq!(at(&v, "command").as_str(), Some(args[0]), "{args:?}");
    assert_eq!(at(&v, "qnetVersion").as_str(), Some(env!("CARGO_PKG_VERSION")));
    assert_eq!(at(&v, "fingerprint").as_str().map(str::len), Some(64), "{args:?}");
    v
}

/// `at(v, "stations.0.name")`.
fn at<'a>(v: &'a Json, path: &str) -> &'a Json {
    path.split('.').fold(v, |v, key| match v {
        Json::Object(m) => m.get(key).unwrap_or_else(|| panic!("no key {key} in {path}")),
        Json::Array(a) => &a[key.parse::<usize>().unwrap()],
        _ => panic!("{path}: nothing under {key}"),
    })
}

fn f(v: &Json, path: &str) -> f64 {
    at(v, path).as_f64().unwrap_or_else(|| panic!("{path} is not a number: {:?}", at(v, path)))
}

fn list<'a>(v: &'a Json, path: &str) -> &'a [Json] {
    at(v, path).as_array().unwrap_or_else(|| panic!("{path} is not a list"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-cli-json-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const JACKSON: &str = "OpenJackson.d2.feedback.p30.inf";

#[test]
fn describe_then_build_writes_the_file_qnet_saves_and_build_refuses_in_plain_words() {
    let dir = scratch("build");
    for name in [JACKSON, "MM1K.d1.c1.fin", "KumarSeidman90.d2.c4.reentrant.inf", "closed/ClosedCentralServer.d3.N8"] {
        let d = document(&["describe", &example(name)]);
        let spec = dir.join("spec.json");
        std::fs::write(&spec, json::to_pretty(at(&d, "spec"))).unwrap();
        let (code, built, err) = cli(&["build", spec.to_str().unwrap()]);
        assert_eq!(code, 0, "{name}: {err}");
        assert_eq!(built, cli(&["resave", &example(name)]).1, "{name}");
        // Written to a file, the answer is the envelope, with the fingerprint of what was written.
        let out = dir.join("out.bnet");
        let wrote = document(&["build", spec.to_str().unwrap(), out.to_str().unwrap()]);
        assert_eq!(std::fs::read_to_string(&out).unwrap(), built);
        assert_eq!(at(&wrote, "fingerprint"), at(&d, "fingerprint"), "{name}");
    }
    // A description with names only, through stdin.
    let mut child = Command::new(env!("CARGO_BIN_EXE_qnet-cli")).args(["build", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    std::io::Write::write_all(
        child.stdin.as_mut().unwrap(),
        br#"{"nodes":[{"kind":"source","name":"In","parameters":{"lambda":0.5}},{"kind":"buffer","name":"Q"},{"kind":"station","name":"M"},{"kind":"sink","name":"Out"}],
            "links":[{"from":"In","to":"Q"},{"from":"Q","to":"M"},{"from":"M","to":"Out"}]}"#,
    )
    .unwrap();
    let built = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
    let net = bnet::read(&built).unwrap();
    assert!((jackson::live(&net).stations[0].mean_in_system.unwrap() - 1.0).abs() < 1e-12, "M/M/1 at ρ = 0.5 holds one customer on average");

    let bad = dir.join("bad.json");
    std::fs::write(&bad, r#"{"nodes":[{"kind":"station","name":"M"}],"links":[{"from":"M","to":"Nowhere"}]}"#).unwrap();
    assert_eq!(cli(&["build", bad.to_str().unwrap()]), (1, String::new(), "The link from “M” to “Nowhere”: there is no node called “Nowhere”.\n".into()));
    std::fs::write(&bad, "{").unwrap();
    let (code, _, err) = cli(&["build", bad.to_str().unwrap()]);
    assert!(code == 1 && err.starts_with("The description isn't valid JSON"), "{err}");
    assert_eq!(cli(&["build"]).0, 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn describe_gives_the_station_model_of_the_traffic_equations() {
    let net = network(JACKSON);
    let d = document(&["describe", &example(JACKSON)]);
    let data = qnet_core::traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
    assert_eq!(list(&d, "stations").len(), data.d);
    for i in 0..data.d {
        assert_eq!(f(&d, &format!("stations.{i}.throughput")), data.alpha[i]);
        assert_eq!(f(&d, &format!("stations.{i}.utilisation")), data.rho(i));
        assert_eq!(f(&d, &format!("stations.{i}.capacity")), data.capacity[i]);
    }
    assert_eq!(at(&d, "stations.0.name").as_str(), Some("S1"));
    assert_eq!(at(&d, "drawnAs").as_str(), Some("open"));
    assert_eq!(at(&d, "closedForm.kind").as_str(), Some("exactJackson"));
    assert_eq!(at(&d, "routingCycles").as_bool(), Some(true));
    assert_eq!(at(&d, "units.utilisation").as_str(), Some("ratio"));
    let ids: Vec<&str> = list(&d, "parameters").iter().map(|p| at(p, "id").as_str().unwrap()).collect();
    assert_eq!(ids, ["load", "arrival:Src1", "service:S1", "service:S2", "servers:S1", "servers:S2"]);
    // A closed network has no open station model, and says so by core's rule.
    let c = document(&["describe", &example("closed/ClosedCentralServer.d3.N8")]);
    assert_eq!(at(&c, "drawnAs").as_str(), Some("closed"));
    assert!(at(&c, "modelError").as_str().unwrap().starts_with("This is a closed network"));
    assert_eq!(at(&c, "network.population").as_i64(), Some(8));
    // A file that is not a network: 0.90.34's sentence, exit 1.
    let (code, out, err) = cli(&["describe", "/nonexistent.bnet"]);
    assert!(code == 1 && out.is_empty() && err.starts_with("Couldn't read /nonexistent.bnet"), "{err}");
}

#[test]
fn live_is_the_closed_form_of_core_for_open_and_closed_networks() {
    let d = document(&["live", &example(JACKSON)]);
    let r = jackson::live(&network(JACKSON));
    assert_eq!(at(&d, "tier").as_str(), Some("exact"));
    for (i, s) in r.stations.iter().enumerate() {
        assert_eq!(f(&d, &format!("stations.{i}.meanInSystem")), s.mean_in_system.unwrap());
        assert_eq!(f(&d, &format!("stations.{i}.meanSojourn")), s.mean_sojourn.unwrap());
        assert_eq!(f(&d, &format!("stations.{i}.utilisation")), s.utilisation.unwrap());
    }
    assert_eq!(f(&d, "totals.meanDelay"), r.network.as_ref().unwrap().mean_delay);
    assert_eq!(at(&d, "units.meanSojourn").as_str(), Some("time"));

    // Finite buffers: utilisation only, and the reason.
    let fin = document(&["live", &example("MM1K.d1.c1.fin")]);
    assert_eq!((at(&fin, "tier").as_str(), at(&fin, "reason").as_str()), (Some("utilisation"), Some("finiteBuffers")));
    assert_eq!(at(&fin, "stations.0.meanInSystem"), &Json::Null);
    assert_eq!(at(&fin, "totals"), &Json::Null);

    // A closed network: convolution and MVA.
    let name = "closed/ClosedCentralServer.d3.N8";
    let c = document(&["live", &example(name)]);
    let m = closed::from_network(&network(name)).unwrap();
    let s = closed::means(&m).unwrap();
    assert_eq!(at(&c, "tier").as_str(), Some("exact"));
    assert_eq!(f(&c, "totals.throughput"), s.throughput);
    assert_eq!(f(&c, "totals.meanDelay"), s.cycle_time(m.population));
    for i in 0..m.ids.len() {
        assert_eq!(f(&c, &format!("stations.{i}.meanInSystem")), s.number[i]);
    }
    assert_eq!(at(&c, "closed.population").as_i64(), Some(8));
}

#[test]
fn sensitivity_is_cores_derivative_elasticity_and_inversion() {
    let net = network(JACKSON);
    let ctx = Context::new(&net).unwrap();
    let d = document(&["sensitivity", &example(JACKSON), r#"{"measure": {"kind": "stationNumber", "station": "S2"}, "targetChange": -0.2}"#]);
    let measure = Measure::StationNumber(1);
    assert_eq!(f(&d, "value"), measure.value(&ctx.solution));
    assert_eq!((at(&d, "unit").as_str(), at(&d, "tier").as_str()), (Some("customers"), Some("exact")));
    let rows = list(&d, "parameters");
    let source = net.nodes.iter().find(|n| n.name == "Src1").unwrap().id.clone();
    let s2 = net.nodes.iter().find(|n| n.name == "S2").unwrap().id.clone();
    let cases: [(&str, Family); 3] = [
        ("load", Family::load(&ctx.model)),
        ("arrival:Src1", ctx.family(&net, &ParamSpec::Arrival { node_id: source }).unwrap()),
        ("servers:S2", ctx.family(&net, &ParamSpec::Servers { node_id: s2 }).unwrap()),
    ];
    for (id, family) in cases {
        let row = rows.iter().find(|r| at(r, "id").as_str() == Some(id)).unwrap();
        let s = sensitivity::sensitivity(&ctx.model, &ctx.solution, measure, &family);
        assert_eq!(at(row, "derivative").as_f64(), s.derivative.filter(|x| x.is_finite()), "{id}");
        assert_eq!(at(row, "elasticity").as_f64(), s.elasticity.filter(|x| x.is_finite()), "{id}");
        assert_eq!(at(row, "oneMore").as_f64(), s.one_more.filter(|x| x.is_finite()), "{id}");
        match sensitivity::invert(&ctx.model, measure, &family, f(&d, "target")) {
            sensitivity::Inversion::Achieved { value, .. } => assert_eq!(f(row, "whatItTakes.value"), value, "{id}"),
            sensitivity::Inversion::Infeasible { .. } => assert_eq!(at(row, "whatItTakes.achieved").as_bool(), Some(false), "{id}"),
        }
    }
    // No closed form: an answer, not an error.
    let fin = document(&["sensitivity", &example("MM1K.d1.c1.fin")]);
    assert_eq!(at(&fin, "available").as_bool(), Some(false));
    assert!(!at(&fin, "sentence").as_str().unwrap().is_empty());
    let closed = document(&["sensitivity", &example("closed/ClosedCentralServer.d3.N8")]);
    assert_eq!((at(&closed, "available").as_bool(), at(&closed, "reason").as_str()), (Some(false), Some("closed")));
    // Options that make no sense are refused with the choices named.
    let (code, _, err) = cli(&["sensitivity", &example(JACKSON), r#"{"measure": "queueLength"}"#]);
    assert!(code == 1 && err.starts_with("There's no measure called “queueLength”. The measures are networkNumber"), "{err}");
    let (code, _, err) = cli(&["sensitivity", &example(JACKSON), r#"{"measure": {"kind": "stationNumber", "station": "S9"}}"#]);
    assert_eq!((code, err.as_str()), (1, "There is no station called “S9” in this network.\n"));
    assert_eq!(cli(&["sensitivity", &example(JACKSON), "{not json"]).0, 1);
}

#[test]
fn capacity_is_cores_plan() {
    let net = network(JACKSON);
    let model = optimise::planning_model(&net).unwrap();
    let now = jackson::solve(&model).unwrap().network_sojourn();
    let target = now * 0.5;
    let d = document(&["capacity", &example(JACKSON), &format!(r#"{{"constraints": [{{"kind": "networkSojourn", "target": {target}}}]}}"#)]);
    let plan = optimise::plan(&optimise::Problem::new(model.clone(), vec![optimise::Constraint::NetworkSojourn(target)])).unwrap();
    assert_eq!(at(&d, "feasible").as_bool(), Some(true));
    assert_eq!(list(&d, "stations").iter().map(|s| at(s, "servers").as_i64().unwrap()).collect::<Vec<_>>(), plan.servers);
    assert_eq!(f(&d, "cost"), plan.cost);
    assert_eq!(f(&d, "meanDelayNow"), now);
    let mut proposed = model.clone();
    proposed.servers = plan.servers.clone();
    assert_eq!(f(&d, "meanDelay"), jackson::solve(&proposed).unwrap().network_sojourn());
    assert!(f(&d, "meanDelay") <= target && f(&d, "constraints.0.proposed") <= target);
    assert_eq!(at(&d, "constraints.0.unit").as_str(), Some("time"));
    // Service rates by the square-root rule.
    let r = document(&["capacity", &example(JACKSON), &format!(r#"{{"decision": "rates", "constraints": [{{"kind": "networkSojourn", "target": {target}}}]}}"#)]);
    let loads = optimise::Loads::new(&model).unwrap();
    let rates = optimise::plan_rates(&model, target * loads.total_arrivals, &[1.0, 1.0], &[true, true]).unwrap();
    assert_eq!(list(&r, "stations").iter().map(|s| at(s, "rate").as_f64().unwrap()).collect::<Vec<_>>(), rates.mu);
    assert_eq!(at(&r, "proof").as_str(), Some("closedForm"));
    // A delay below the service time itself cannot be met: an answer saying why.
    let low = document(&["capacity", &example(JACKSON), r#"{"constraints": [{"kind": "networkSojourn", "target": 0.01}]}"#]);
    assert_eq!((at(&low, "feasible").as_bool(), at(&low, "infeasible.why").as_str()), (Some(false), Some("serviceFloor")));
    assert_eq!(f(&low, "infeasible.value"), f(&low, "delayFloor"));
    let (code, _, err) = cli(&["capacity", &example(JACKSON)]);
    assert!(code == 1 && err.starts_with("Capacity planning needs at least one target"), "{err}");
}

#[test]
fn uncertainty_is_cores_propagation_with_the_same_seed() {
    let net = network(JACKSON);
    let ctx = Context::new(&net).unwrap();
    let options = r#"{"measure": "networkSojourn", "samples": 4000, "seed": 7,
        "inputs": [{"kind": "arrival", "node": "Src1", "spread": {"kind": "relativeSd", "value": 0.05}},
                   {"kind": "service", "node": "S2", "spread": {"kind": "interval95", "low": 1.3, "high": 1.6}}]}"#;
    let d = document(&["uncertainty", &example(JACKSON), options]);
    let id = |name: &str| net.nodes.iter().find(|n| n.name == name).unwrap().id.clone();
    let families = [ctx.family(&net, &ParamSpec::Arrival { node_id: id("Src1") }).unwrap(), ctx.family(&net, &ParamSpec::Service { node_id: id("S2"), class: None }).unwrap()];
    let laws = [uncertainty::Law::relative_sd(families[0].current, 0.05).unwrap(), uncertainty::Law::interval95(1.3, 1.6).unwrap()];
    let inputs: Vec<uncertainty::Input> = families.into_iter().zip(laws).map(|(family, law)| uncertainty::Input { family, law }).collect();
    let factors = vec![vec![0], vec![1]];
    let measure = Measure::NetworkSojourn;
    let mean_exists = uncertainty::mean_exists(&ctx.model, measure, &inputs);
    let p = uncertainty::propagate_jackson(&ctx.model, measure, &inputs, &factors, &uncertainty::Options { samples: 4000, seed: 7, sobol: mean_exists }, &mut |_, _| {});
    let s = p.summary.unwrap();
    assert_eq!(f(&d, "value"), measure.value(&ctx.solution));
    assert_eq!(f(&d, "sampling.median.value"), s.median.value);
    assert_eq!(f(&d, "sampling.q025.value"), s.q025.value);
    assert_eq!(f(&d, "sampling.q975.value"), s.q975.value);
    assert_eq!(f(&d, "sampling.probabilityUnstable.value"), p.p_unstable.value);
    assert_eq!((at(&d, "sampling.samples").as_i64(), at(&d, "sampling.seed").as_i64()), (Some(4000), Some(7)));
    let derivatives = uncertainty::jackson_derivatives(&ctx.model, &ctx.solution, measure, &inputs);
    let delta = uncertainty::delta(&derivatives, &[inputs[0].law.sd(), inputs[1].law.sd()], &factors);
    assert_eq!(f(&d, "linear.sd"), delta.sd);
    assert_eq!(f(&d, "shares.1.linear"), delta.shares[1]);
    assert_eq!(at(&d, "inputs.1.law").as_str(), Some("lognormal"));
    // Run again: the same document, number for number.
    assert_eq!(document(&["uncertainty", &example(JACKSON), options]), d);
    let (code, _, err) = cli(&["uncertainty", &example(JACKSON), "{}"]);
    assert_eq!((code, err.as_str()), (1, "Nothing is uncertain yet: give at least one rate an uncertainty above zero.\n"));
    let (code, _, err) = cli(&["uncertainty", &example(JACKSON), r#"{"inputs": [{"kind": "servers", "node": "S1", "spread": {"value": 0.1}}]}"#]);
    assert_eq!((code, err.as_str()), (1, "Only arrival rates and service rates can be given an uncertainty.\n"));
}

#[test]
fn transient_is_cores_exact_and_fluid_answers() {
    let net = network(JACKSON);
    let options = r#"{"horizon": 12, "intervals": 24, "initial": "empty", "surge": {"factor": 1.2, "from": 2, "until": 4}}"#;
    let d = document(&["transient", &example(JACKSON), options]);
    let a = transient::applicability(&net);
    let model = a.exact.unwrap();
    let request = transient::Request { horizon: 12.0, intervals: 24, surge: Some(transient::Surge { factor: 1.2, from: 2.0, until: 4.0 }), ..transient::Request::default() };
    let exact = transient::exact(&model, &request, &mut |_| true).unwrap();
    let fluid = transient::fluid(&model, &request);
    let row = |v: &Json, path: &str| list(v, path).iter().map(|x| x.as_f64().unwrap()).collect::<Vec<_>>();
    assert_eq!(row(&d, "times"), exact.times);
    for i in 0..model.mu.len() {
        assert_eq!(row(&d, &format!("exact.mean.{i}")), exact.mean[i]);
        assert_eq!(row(&d, &format!("fluid.level.{i}")), fluid.level[i]);
        assert_eq!(at(&d, &format!("exact.settling.{i}")).as_f64(), exact.settling[i]);
    }
    assert_eq!(f(&d, "exact.stationary.0"), exact.stationary[0]);
    assert_eq!((at(&d, "exact.tier").as_str(), at(&d, "fluid.tier").as_str(), at(&d, "units.mean").as_str()), (Some("exact"), Some("approximation"), Some("customers")));
    // Without a horizon, the suggested one.
    let free = document(&["transient", &example(JACKSON)]);
    assert_eq!(f(&free, "horizon"), f(&free, "suggestedHorizon"));
    assert_eq!(f(&free, "horizon"), transient::suggested_horizon(&model, &jackson::throughputs(&model).unwrap()));
    // Finite buffers: neither tier applies, in core's sentence.
    let fin = document(&["transient", &example("MM1K.d1.c1.fin")]);
    assert_eq!(at(&fin, "available").as_bool(), Some(false));
    assert_eq!(at(&fin, "fluidReason").as_str(), Some(transient::FINITE_SENTENCE));
    let (code, _, err) = cli(&["transient", &example(JACKSON), r#"{"initial": "full"}"#]);
    assert!(code == 1 && err.contains("“initial” must be"), "{err}");
}

fn bnet_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            bnet_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "bnet") {
            out.push(p);
        }
    }
}

/// The fixture the Method Chooser's three homes are held to (cli/src/methods.rs says which).
/// `QNET_WRITE_FIXTURES=1 cargo test -p qnet-cli --test cli_json` writes it again.
#[test]
fn methods_gives_the_method_choosers_rows_and_solves_choice_for_every_example() {
    let mut files = Vec::new();
    bnet_files(&root().join("examples"), &mut files);
    files.sort();
    let mut cases = Vec::new();
    for path in &files {
        let d = document(&["methods", path.to_str().unwrap(), "--assume-installed"]);
        let name = path.strip_prefix(root().join("examples")).unwrap().to_string_lossy().trim_end_matches(".bnet").to_string();
        let mut case = std::collections::BTreeMap::new();
        case.insert("example".to_string(), Json::str(name));
        for key in ["domain", "methods", "solve"] {
            case.insert(key.to_string(), at(&d, key).clone());
        }
        cases.push(Json::Object(case));
    }
    assert!(cases.len() >= 51);
    let said = json::to_pretty_unescaped_slashes(&Json::Array(cases)) + "\n";
    let fixture = root().join("cli/tests/fixtures/methods.json");
    if std::env::var_os("QNET_WRITE_FIXTURES").is_some() {
        std::fs::write(&fixture, &said).unwrap();
    }
    assert!(std::fs::read_to_string(&fixture).unwrap() == said, "cli/tests/fixtures/methods.json is not what `qnet-cli methods --assume-installed` prints now (see cli/src/methods.rs)");

    // What the rows say for networks whose answer is known.
    let solve = |name: &str| at(&document(&["methods", &example(name), "--assume-installed"]), "solve.label").as_str().map(str::to_string);
    assert_eq!(solve(JACKSON).as_deref(), Some("product_form"), "an exact method where one applies");
    assert_eq!(solve("closed/ClosedCentralServer.d3.N8").as_deref(), Some("closed_pf"));
    assert_eq!(solve("2dtandem").as_deref(), Some("sim"), "deterministic service, finite buffers: no exact method, so a simulation");
    let d = document(&["methods", &example("2dtandem"), "--assume-installed"]);
    let ctmc = list(&d, "methods").iter().find(|m| at(m, "label").as_str() == Some("generic_ctmc")).unwrap();
    assert_eq!((at(ctmc, "applicable").as_bool(), at(ctmc, "reason").as_str()), (Some(false), Some("Requires Poisson arrivals and exponential service for every represented class.")));
    // With this installation's solvers the document has the same shape.
    let here = document(&["methods", &example(JACKSON)]);
    assert_eq!(at(&here, "assumedInstalled").as_bool(), Some(false));
    assert_eq!(list(&here, "methods").len(), list(&document(&["methods", &example(JACKSON), "--assume-installed"]), "methods").len());
}

/// `run --json` and `solve --json` against 0.90.34's recorded QNA run of the three-station tandem.
/// Skipped, with a note, where the solvers are not staged (as cli_golden's run tests need them).
#[test]
fn run_json_carries_the_recorded_runs_values_units_and_tier() {
    let name = "3dtandem.inf";
    let (code, out, err) = cli(&["run", "qna", &example(name), "--json"]);
    if code != 0 && err.contains("not found") {
        eprintln!("skipped: the QNA solver is not staged here ({err})");
        return;
    }
    assert_eq!(code, 0, "{err}");
    let d = json::parse(&out).unwrap_or_else(|e| panic!("stdout is one JSON document ({e}): {out}"));
    assert_eq!((at(&d, "schema").as_i64(), at(&d, "status").as_str(), at(&d, "exitCode").as_i64()), (Some(1), Some("completed"), Some(0)));
    // Ledger WF-504: nothing in the document spells out this Mac's home folder (a "runtime" parameter, a Status line).
    if let Some(home) = std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned()).filter(|h| h.len() > 1) {
        assert!(!out.contains(&format!("{home}/")), "the home folder is spelled out: {out}");
    }
    assert_eq!((at(&d, "method.label").as_str(), at(&d, "method.identifier").as_str(), at(&d, "method.tier").as_str()), (Some("qna"), Some("queue-approx.qna"), Some("approximation")));
    let golden = json::parse(&std::fs::read_to_string(root().join("golden/runs").join(name).join("qna/record.json")).unwrap()).unwrap();
    assert_eq!(at(&d, "fingerprint"), at(&golden, "provenance.networkFingerprint"));
    let want = list(&golden, "measurements");
    let got = list(&d, "values");
    assert!(!want.is_empty() && got.len() == want.len(), "{} values, {} recorded", got.len(), want.len());
    for (g, w) in got.iter().zip(want) {
        assert_eq!((at(g, "station"), at(g, "metric"), at(g, "unit")), (at(w, "stationName"), at(w, "metric"), at(w, "unit")));
        assert_eq!(f(g, "value"), f(w, "estimate"), "{:?}", at(g, "metric"));
    }
    assert!(err.lines().any(|l| l.starts_with("info\t") || l.starts_with("qnet-cli: ")), "Status lines stay on stderr: {err}");
    // A method the network's Run menu does not offer: a document saying so, exit 1.
    let (code, out, _) = cli(&["run", "sim", &example(name), "--json"]);
    let refused = json::parse(&out).unwrap();
    assert_eq!((code, at(&refused, "status").as_str()), (1, Some("refused")));
    assert!(at(&refused, "failure").as_str().is_some_and(|s| !s.is_empty()));
    assert!(list(&refused, "values").is_empty());
    assert_eq!(cli(&["solve"]).0, 2);
}

/// Replicated Simulation as the second opinion for a closed network (new in 2.1, ledger SIM-108):
/// `run closed_pf` and `run sim_inproc` on the bundled closed example, filed in one results store
/// as the app files them. Every one of the exact solution's 18 numbers lies inside the
/// simulation's 95 % interval, and within 2 % of its estimate (the Agreement view's "agree").
///
/// The two records, less what differs from run to run and from Mac to Mac (ids, dates, the raw
/// text, the file's path), are the interface's fixture
/// src/panes/results/agreement/fixtures/closed-two-opinions.json, which
/// `QNET_WRITE_FIXTURES=1 cargo test -p qnet-cli --test cli_json` writes again. The fixture's
/// numbers are not compared with this run's: a simulation's path may differ in the last digit of
/// a logarithm between two systems' maths libraries. What is held here is the statement itself,
/// on this machine's run; what the interface's test holds is the same statement on the fixture.
#[test]
fn the_closed_examples_exact_solution_lies_inside_the_replicated_simulations_intervals() {
    let dir = scratch("two-opinions");
    let store = dir.join("results.json");
    let file = example("closed/ClosedCentralServer.d3.N8");
    for args in [vec!["run", "closed_pf", &file], vec!["run", "sim_inproc", &file, "--set", "sim.seedFixed=true", "--set", "sim.seed=12345"]] {
        let mut args = args;
        args.extend(["--store", store.to_str().unwrap()]);
        let (code, _, err) = cli(&args);
        assert_eq!(code, 0, "{args:?}: {err}");
    }
    let filed = json::parse(&std::fs::read_to_string(&store).unwrap()).unwrap();
    let records = list(&filed, "records");
    let of = |identifier: &str| records.iter().find(|r| at(r, "method.identifier").as_str() == Some(identifier)).unwrap_or_else(|| panic!("no record of {identifier}"));
    let (exact, simulated) = (of("queue.closed-product-form"), of("queue.des-replications"));
    assert_eq!((at(exact, "status").as_str(), at(simulated, "status").as_str()), (Some("completed"), Some("completed")));
    assert_eq!(at(simulated, "method.fidelity").as_str(), Some("Queue simulation"));
    assert_eq!(at(exact, "provenance.networkFingerprint"), at(simulated, "provenance.networkFingerprint"), "two runs of one network");
    assert_eq!((list(exact, "measurements").len(), list(simulated, "measurements").len()), (18, 18));
    for m in list(simulated, "measurements") {
        let (station, metric) = (at(m, "stationName").as_str().unwrap(), at(m, "metric").as_str().unwrap());
        let truth = list(exact, "measurements").iter().find(|e| at(e, "stationName").as_str() == Some(station) && at(e, "metric").as_str() == Some(metric) && at(e, "unit") == at(m, "unit")).unwrap_or_else(|| panic!("the exact run has no {station} {metric}"));
        let (value, estimate, low, high) = (f(truth, "estimate"), f(m, "estimate"), f(m, "uncertainty.lowerBound"), f(m, "uncertainty.upperBound"));
        assert!(low <= value && value <= high, "{station} {metric}: exact {value} outside [{low}, {high}]");
        assert!((estimate - value).abs() <= 0.02 * value, "{station} {metric}: {estimate} against {value}");
        assert_eq!((f(m, "uncertainty.confidenceLevel"), at(m, "uncertainty.sampleSize").as_i64()), (0.95, Some(20)));
    }

    // The fixture: the two records with fixed ids and dates, without the raw text and the path.
    let slim = |r: &Json, n: usize| {
        let measurements: Vec<Json> = list(r, "measurements")
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let mut m = m.as_object().unwrap().clone();
                m.insert("id".into(), Json::str(format!("M{n}-{i}")));
                Json::Object(m)
            })
            .collect();
        let mut provenance = std::collections::BTreeMap::new();
        for key in ["networkFingerprint", "networkTitle", "bufferRegime", "parameters"] {
            provenance.insert(key.to_string(), at(r, &format!("provenance.{key}")).clone());
        }
        let mut out = std::collections::BTreeMap::new();
        out.insert("id".to_string(), Json::str(format!("R{n}")));
        out.insert("method".to_string(), at(r, "method").clone());
        out.insert("status".to_string(), at(r, "status").clone());
        out.insert("startedAt".to_string(), Json::str(format!("2026-01-01T00:00:0{n}Z")));
        out.insert("completedAt".to_string(), Json::str(format!("2026-01-01T00:00:0{}Z", n + 1)));
        out.insert("warnings".to_string(), at(r, "warnings").clone());
        out.insert("provenance".to_string(), Json::Object(provenance.into_iter().collect()));
        out.insert("measurements".to_string(), Json::Array(measurements));
        Json::Object(out.into_iter().collect())
    };
    let said = json::to_pretty_unescaped_slashes(&Json::Array(vec![slim(exact, 1), slim(simulated, 3)])) + "\n";
    let fixture = root().join("src/panes/results/agreement/fixtures/closed-two-opinions.json");
    if std::env::var_os("QNET_WRITE_FIXTURES").is_some() {
        std::fs::write(&fixture, &said).unwrap();
    }
    // The fixture has this run's shape: the same methods, stations, metrics and units.
    let shape = |text: &str| -> Vec<String> {
        let v = json::parse(text).unwrap();
        v.as_array().unwrap().iter().flat_map(|r| list(r, "measurements").iter().map(|m| format!("{}|{}|{}|{}|{}", at(r, "method.identifier").as_str().unwrap(), at(m, "stationName").as_str().unwrap(), at(m, "metric").as_str().unwrap(), at(m, "unit").as_str().unwrap(), m.as_object().unwrap().contains_key("uncertainty"))).collect::<Vec<_>>()).collect()
    };
    assert_eq!(shape(&std::fs::read_to_string(&fixture).expect("the fixture (QNET_WRITE_FIXTURES=1 writes it)")), shape(&said));
    let _ = std::fs::remove_dir_all(&dir);
}
