//! Sensitivity and bottleneck analysis (new in 2.1, ROADMAP D1): `sensitivity_analyze`, the exact
//! route of Results ▸ Sensitivity. For a network that is an open Jackson network it answers, for
//! one measure and every parameter the interface offers (src/sweeps/model.ts
//! `discoverParameters`), the derivative, the elasticity, the effect of one more server and — for
//! a target change of the measure — the value of each single parameter that reaches it, all from
//! the closed formulas of `qnet_core::sensitivity`. Nothing is run and nothing is filed.
//!
//! A network with no closed form is answered `available: false` with the reason in a sentence;
//! the interface then differentiates numerically over quiet runs (src/sensitivity/runner.ts).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use qnet_core::jackson::JacksonError;
use qnet_core::sensitivity::{invert, sensitivity, Context, Inversion, Measure, ParamSpec, Why};

use crate::errors::QnError;

/// What is measured: "networkNumber", "networkSojourn", or a station's "stationNumber",
/// "stationQueue", "stationSojourn", "stationUtilisation", "stationThroughput".
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureRequest {
    pub kind: String,
    #[serde(default)]
    pub station_id: Option<String>,
}

/// One parameter, as src/sweeps/model.ts names it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterRequest {
    pub id: String,
    /// "load", "arrival", "service", "servers", "buffer" or "routing".
    pub kind: String,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub customer_class: Option<i64>,
    #[serde(default)]
    pub link_id: Option<String>,
    #[serde(default)]
    pub complement_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitivityRequest {
    pub document: Value,
    pub measure: MeasureRequest,
    pub parameters: Vec<ParameterRequest>,
    /// The change of the measure asked for, as a fraction (−0.1: cut it by 10 %); none: no "what would it take".
    #[serde(default)]
    pub target_change: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InversionAnswer {
    /// The parameter value that does it, and the measure solved again at that value.
    #[serde(rename_all = "camelCase")]
    Achieved { value: f64, measure: f64 },
    /// `why`: "noEffect", "rangeEnds", "levels" or "overload".
    #[serde(rename_all = "camelCase")]
    Infeasible { why: &'static str, limit_value: Option<f64>, limit_measure: Option<f64> },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SensitivityRow {
    pub id: String,
    /// The parameter's value now.
    pub current: Option<f64>,
    pub integer: bool,
    pub derivative: Option<f64>,
    pub elasticity: Option<f64>,
    /// A whole-number parameter: the measure with one more.
    pub one_more: Option<f64>,
    pub inversion: Option<InversionAnswer>,
    /// Why the parameter is not analysed, when it isn't.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SensitivityStation {
    pub id: String,
    pub name: String,
    pub utilisation: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SensitivityAnalysis {
    /// False when no closed form applies; `reason` and `sentence` say why.
    pub available: bool,
    /// "network", "unstable" or "notJackson".
    pub reason: Option<&'static str>,
    pub sentence: Option<String>,
    /// The measure now, and its unit ("customers", "time", "ratio", "customers / time").
    pub value: Option<f64>,
    pub unit: Option<&'static str>,
    /// The measure asked for by `targetChange`.
    pub target: Option<f64>,
    pub stations: Vec<SensitivityStation>,
    /// The station(s) with the highest utilisation: several when they tie (core `jackson::TIE_TOLERANCE`).
    pub bottlenecks: Vec<String>,
    pub rows: Vec<SensitivityRow>,
}

fn finite(x: Option<f64>) -> Option<f64> {
    x.filter(|v| v.is_finite())
}

pub(crate) fn measure_of(ctx: &Context, m: &MeasureRequest) -> Result<Measure, QnError> {
    let station = || m.station_id.as_deref().and_then(|id| ctx.station(id)).ok_or_else(|| QnError::invalid("The station this measure belongs to is no longer in the network."));
    Ok(match m.kind.as_str() {
        "networkNumber" => Measure::NetworkNumber,
        "networkSojourn" => Measure::NetworkSojourn,
        "stationNumber" => Measure::StationNumber(station()?),
        "stationQueue" => Measure::StationQueue(station()?),
        "stationSojourn" => Measure::StationSojourn(station()?),
        "stationUtilisation" => Measure::StationUtilisation(station()?),
        "stationThroughput" => Measure::StationThroughput(station()?),
        other => return Err(QnError::invalid(format!("There's no measure called “{other}”."))),
    })
}

pub(crate) fn spec_of(p: &ParameterRequest) -> Result<ParamSpec, String> {
    let node = || p.node_id.clone().ok_or_else(|| "The parameter names no node.".to_string());
    match p.kind.as_str() {
        "load" => Ok(ParamSpec::Load),
        "arrival" => Ok(ParamSpec::Arrival { node_id: node()? }),
        "service" => Ok(ParamSpec::Service { node_id: node()?, class: p.customer_class }),
        "servers" => Ok(ParamSpec::Servers { node_id: node()? }),
        "routing" => match (&p.link_id, &p.complement_id) {
            (Some(l), Some(c)) => Ok(ParamSpec::Routing { link_id: l.clone(), complement_id: c.clone() }),
            _ => Err("The parameter names no pair of links.".into()),
        },
        "buffer" => Err("A buffer's size has no effect while buffers are infinite.".into()),
        other => Err(format!("There's no parameter kind called “{other}”.")),
    }
}

/// The analysis of `req` (the command, as a plain function).
pub fn analyze(req: &SensitivityRequest) -> Result<SensitivityAnalysis, QnError> {
    let text = serde_json::to_string(&req.document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = qnet_core::bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the network.").with_detail(e.to_string()))?;
    // A network drawn as a closed one is told so, by core's one rule, not "no source node".
    // (and one with priorities, batch arrivals or a rate profile by the other: `extended::classical_only`).
    if let Some((reason, sentence)) = qnet_core::extended::classical_only(&net, "Sensitivity analysis") {
        return Ok(SensitivityAnalysis { available: false, reason: Some(reason), sentence: Some(sentence), ..Default::default() });
    }
    let ctx = match Context::new(&net) {
        Ok(c) => c,
        Err(e) => {
            let reason = match e {
                JacksonError::Network(_) => "network",
                JacksonError::Unstable(..) => "unstable",
                JacksonError::NotJackson => "notJackson",
            };
            return Ok(SensitivityAnalysis { available: false, reason: Some(reason), sentence: Some(e.message()), ..Default::default() });
        }
    };
    let measure = measure_of(&ctx, &req.measure)?;
    let value = measure.value(&ctx.solution);
    let target = req.target_change.filter(|c| c.is_finite() && *c != 0.0).map(|c| value * (1.0 + c));
    let rows = req
        .parameters
        .iter()
        .map(|p| {
            let family = match spec_of(p).and_then(|spec| ctx.family(&net, &spec)) {
                Ok(f) => f,
                Err(note) => return SensitivityRow { id: p.id.clone(), current: None, integer: false, derivative: None, elasticity: None, one_more: None, inversion: None, note: Some(note) },
            };
            let s = sensitivity(&ctx.model, &ctx.solution, measure, &family);
            let inversion = target.map(|t| match invert(&ctx.model, measure, &family, t) {
                Inversion::Achieved { value, measure } => InversionAnswer::Achieved { value, measure },
                Inversion::Infeasible { why, limit_value, limit_measure } => InversionAnswer::Infeasible {
                    why: match why {
                        Why::NoEffect => "noEffect",
                        Why::RangeEnds => "rangeEnds",
                        Why::Levels => "levels",
                        Why::Overload => "overload",
                    },
                    limit_value: finite(limit_value),
                    limit_measure: finite(limit_measure),
                },
            });
            SensitivityRow { id: p.id.clone(), current: Some(family.current), integer: family.integer, derivative: finite(s.derivative), elasticity: finite(s.elasticity), one_more: finite(s.one_more), inversion, note: None }
        })
        .collect();
    let stations: Vec<SensitivityStation> = (0..ctx.model.ids.len()).map(|i| SensitivityStation { id: ctx.model.ids[i].clone(), name: ctx.model.names[i].clone(), utilisation: ctx.solution.rho[i] }).collect();
    let rho: Vec<Option<f64>> = stations.iter().map(|s| Some(s.utilisation)).collect();
    let bottlenecks = qnet_core::jackson::most_loaded(&rho).into_iter().map(|i| stations[i].id.clone()).collect();
    Ok(SensitivityAnalysis { available: true, reason: None, sentence: None, value: Some(value), unit: Some(measure.unit()), target, stations, bottlenecks, rows })
}

/// Results ▸ Sensitivity, the exact route: derivatives, elasticities and "what would it take" by closed formula.
#[tauri::command(async)]
pub fn sensitivity_analyze(request: SensitivityRequest) -> Result<SensitivityAnalysis, QnError> {
    analyze(&request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiet_runs::{run, QuietOutcome, QuietRequest};
    use crate::runs::Runs;
    use qnet_runner::methods::RunSettings;
    use qnet_runner::resolver::{Resolver, ResolverConfig};
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    const SRC: &str = "1FB829CC-F9CC-4662-BA52-1408AE0849C2";
    const S1: &str = "1EA5D945-A8FE-4026-9B40-F78369F6FDDA";
    const S2: &str = "3A8845FE-6084-4B63-B474-2FE42F64FFED";
    const FORWARD: &str = "30AF7BAE-9054-46CE-B0D7-EF7FB4A2EF15";
    const BACK: &str = "9EEA3EDD-0C9A-4DE3-8859-BA41045A0444";

    fn example(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(format!("{name}.bnet"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn parameters() -> Vec<ParameterRequest> {
        let p = |id: &str, kind: &str, node: Option<&str>| ParameterRequest { id: id.into(), kind: kind.into(), node_id: node.map(str::to_string), customer_class: None, link_id: None, complement_id: None };
        vec![
            p("load", "load", None),
            p("arrival", "arrival", Some(SRC)),
            p("service1", "service", Some(S1)),
            p("service2", "service", Some(S2)),
            p("servers1", "servers", Some(S1)),
            ParameterRequest { link_id: Some(FORWARD.into()), complement_id: Some(BACK.into()), ..p("routing", "routing", None) },
            p("buffer", "buffer", Some(S1)),
        ]
    }

    fn request(kind: &str, target_change: Option<f64>) -> SensitivityRequest {
        SensitivityRequest { document: example("OpenJackson.d2.feedback.p30.inf"), measure: MeasureRequest { kind: kind.into(), station_id: None }, parameters: parameters(), target_change }
    }

    /// A closed network is refused as one, in the closed-network sentence, never "The network has
    /// no source node." (core's one rule, `closed::drawn_as`); one that carries a population but
    /// has a source and a sink is the open network it is.
    #[test]
    fn a_closed_network_is_refused_in_its_own_sentence() {
        let mut req = request("networkNumber", None);
        req.document = example("closed/ClosedCentralServer.d3.N8");
        let a = analyze(&req).unwrap();
        assert_eq!((a.available, a.reason), (false, Some("closed")));
        assert_eq!(a.sentence.as_deref(), Some("This is a closed network: a fixed number of customers circulates and nothing arrives from outside. Sensitivity analysis covers open networks."));
        req.document.as_object_mut().unwrap().remove("closedPopulation");
        let a = analyze(&req).unwrap();
        assert_eq!(a.reason, Some("closedNoPopulation"));
        assert!(a.sentence.unwrap().starts_with("The network has no source and no sink, but no number of customers is set."));
        let mut req = request("networkNumber", None);
        req.document["closedPopulation"] = serde_json::json!(5);
        assert!(analyze(&req).unwrap().available);
    }

    /// OpenJackson.d2.feedback.p30: γ = 1, S1 → S2 with 0.7 and back to S1 with 0.3, so
    /// α₁ = 1/0.7, α₂ = 1; μ₁ = 1/0.49, μ₂ = 1/0.7: ρ₁ = ρ₂ = 0.7 and L = 2·(7/3) (the recorded
    /// product-form run in golden/runs gives 2.33333333 at each station). With L = Σ ρ/(1 − ρ):
    /// elasticity of L in γ is 1/(1 − ρ) = 10/3; in μ₁ it is −(1/2)/(1 − ρ) = −5/3 (half of L sits
    /// at each station); in the forward probability q it is −(1/2)/(1 − ρ) = −5/3 (only ρ₁ ∝ 1/q).
    #[test]
    fn the_command_answers_the_jackson_example_in_the_shape_the_interface_reads() {
        let a = analyze(&request("networkNumber", Some(-0.1))).unwrap();
        assert!(a.available);
        assert_eq!(a.unit, Some("customers"));
        assert!((a.value.unwrap() - 14.0 / 3.0).abs() < 1e-9);
        assert!((a.target.unwrap() - 0.9 * 14.0 / 3.0).abs() < 1e-9);
        let row = |id: &str| a.rows.iter().find(|r| r.id == id).unwrap();
        for (id, e) in [("load", 10.0 / 3.0), ("arrival", 10.0 / 3.0), ("service1", -5.0 / 3.0), ("service2", -5.0 / 3.0), ("routing", -5.0 / 3.0)] {
            assert!((row(id).elasticity.unwrap() - e).abs() < 1e-9, "{id}: {:?}", row(id).elasticity);
            assert!(matches!(row(id).inversion, Some(InversionAnswer::Achieved { .. })), "{id}: {:?}", row(id).inversion);
        }
        assert!(row("servers1").integer && row("servers1").derivative.is_none() && row("servers1").one_more.unwrap() < 14.0 / 3.0);
        assert_eq!(row("buffer").note.as_deref(), Some("A buffer's size has no effect while buffers are infinite."));
        assert_eq!(a.stations.len(), 2);
        // ρ₁ = ρ₂ = 0.7: the two share the top, and neither is "the" bottleneck.
        assert_eq!(a.bottlenecks, [S1, S2]);
        let json = serde_json::to_value(&a).unwrap();
        assert_eq!(json["rows"][1]["inversion"]["kind"], "achieved");
        assert!(json["rows"][4]["oneMore"].is_number());
        // No target: no inversions.
        assert!(analyze(&request("networkSojourn", None)).unwrap().rows.iter().all(|r| r.inversion.is_none()));
    }

    #[test]
    fn a_network_with_no_closed_form_says_why() {
        let mut req = request("networkNumber", None);
        req.document = example("MM1K.d1.c1.fin");
        let a = analyze(&req).unwrap();
        assert_eq!((a.available, a.reason), (false, Some("notJackson")));
        assert!(a.sentence.unwrap().contains("not an open Jackson network"));
        req.document = example("3d3ctandem.inf");
        assert!(!analyze(&req).unwrap().available);
        req = request("stationNumber", None);
        assert!(analyze(&req).is_err(), "a station measure needs its station");
    }

    fn staged_resolver() -> Option<Arc<Resolver>> {
        let home = std::env::var_os("HOME")?;
        let solvers = PathBuf::from(home).join("Library/Caches/qnet/solvers/stage/Resources");
        if !solvers.join("bin").is_dir() {
            return None;
        }
        let mut cfg = ResolverConfig::from_process();
        cfg.bundle_resources = None;
        cfg.env.insert(OsString::from("QNET_SOLVER_ROOT"), solvers.into_os_string());
        Some(Arc::new(Resolver::new(cfg)))
    }

    /// The two routes on one network, through the real solver: the interface's finite-difference
    /// route (src/sensitivity/model.ts: a central difference over quiet runs at θ(1 ± h),
    /// h = 0.5 %) with the Exact Open Product Form solver, against the closed formula. For this
    /// network the difference's truncation error is about (h·ρ/(1 − ρ))² ≈ 1.4·10⁻⁴ relative and
    /// the solver prints eight decimals; the two must agree within 0.5 % (seen: about 0.02 %).
    /// "What would it take" is then verified the same way: the solver, run at the proposed
    /// value, gives the target within 10⁻⁶ relative.
    #[test]
    fn the_closed_formula_agrees_with_differences_of_the_product_form_solver() {
        let Some(resolver) = staged_resolver() else {
            println!("skipped: the staged solvers are absent (scripts/stage-solvers.sh)");
            return;
        };
        let _turn = crate::runs::TEST_TURN.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!("qnet-sensitivity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let runs = Runs::with_resolver(dir.join("results-v1.json"), resolver);
        let golden = RunSettings::golden();
        let settings: BTreeMap<String, Value> = RunSettings::KEYS.iter().map(|k| (k.to_string(), Value::String(golden.get(k).unwrap()))).collect();
        let name = "OpenJackson.d2.feedback.p30.inf";
        let set = |node: &str, parameters: String| {
            let mut doc = example(name);
            for n in doc["nodes"].as_array_mut().unwrap() {
                if n["id"] == node {
                    n["distributionParameters"] = Value::String(parameters.clone());
                }
            }
            doc
        };
        let solved = |doc: Value| -> f64 {
            let req = QuietRequest { tab_id: "C0000000-0000-4000-8000-000000000009".into(), title: format!("{name}.bnet"), document: doc, method: "product_form".into(), settings: settings.clone(), overrides: BTreeMap::new(), sweep_id: None };
            match run(&runs.resolver, &runs.registry, &req, |_| {}).unwrap() {
                QuietOutcome::Record { record, .. } => record["measurements"].as_array().unwrap().iter().filter(|m| m["metric"] == "Mean number in system" && m["customerClass"].is_null()).map(|m| m["estimate"].as_f64().unwrap()).sum(),
                other => panic!("{other:?}"),
            }
        };
        let a = analyze(&request("networkNumber", Some(-0.1))).unwrap();
        let row = |id: &str| a.rows.iter().find(|r| r.id == id).unwrap().clone();
        let base = solved(example(name));
        assert!((base - a.value.unwrap()).abs() < 1e-6, "the solver's L {base} against the formula's {:?}", a.value);
        let h = 0.005;
        let mu1 = 2.0408163265306123;
        for (id, node, key, theta) in [("arrival", SRC, "lambda", 1.0), ("service1", S1, "rate", mu1)] {
            let fd = (solved(set(node, format!("{key}={}", theta * (1.0 + h)))) - solved(set(node, format!("{key}={}", theta * (1.0 - h))))) / (2.0 * h * theta);
            let an = row(id).derivative.unwrap();
            assert!((fd - an).abs() <= 0.005 * an.abs(), "{id}: differences {fd}, formula {an}");
        }
        // The proposed values, solved again by the solver.
        for (id, node, key) in [("arrival", SRC, "lambda"), ("service1", S1, "rate")] {
            let Some(InversionAnswer::Achieved { value, .. }) = row(id).inversion else { panic!("{id}") };
            let got = solved(set(node, format!("{key}={value}")));
            assert!((got - a.target.unwrap()).abs() <= 1e-6 * a.target.unwrap(), "{id} at {value}: {got} against {:?}", a.target);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
