//! Capacity planning (new in 2.1, ROADMAP D5): `capacity_plan`, the exact route of Results ▸
//! Capacity. For an open Jackson network it answers the cheapest numbers of servers (marginal
//! allocation, certified by an exact search) or the cheapest service rates (Kleinrock's
//! square-root rule) that meet the targets, from the closed forms of `qnet_core::optimise`.
//! Nothing is run and nothing is filed.
//!
//! A network with no closed form is answered `available: false` with the reason in a sentence;
//! the interface then runs the same greedy over quiet runs (src/optimise/runner.ts).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use qnet_core::jackson::{self, JacksonError, JacksonModel};
use qnet_core::optimise::{plan, plan_rates, planning_model, Constraint, Infeasible, Loads, Problem, Proof, RateInfeasible, SEARCH_NODE_LIMIT};

use crate::errors::QnError;

/// A target: "networkSojourn", "networkNumber", "utilisation" (every station) or "stationWait".
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintRequest {
    pub kind: String,
    #[serde(default)]
    pub station_id: Option<String>,
    pub target: f64,
}

/// What may change at one station, and what it costs. A station not named is free, at cost 1.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StationRequest {
    pub id: String,
    #[serde(default = "yes")]
    pub free: bool,
    /// Cost of one server, and of one unit of service rate.
    #[serde(default = "one")]
    pub cost: f64,
    #[serde(default = "one")]
    pub rate_cost: f64,
    #[serde(default)]
    pub lower: Option<i64>,
    #[serde(default)]
    pub upper: Option<i64>,
}

fn yes() -> bool {
    true
}
fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityRequest {
    pub document: Value,
    /// "servers" (the default) or "rates".
    #[serde(default)]
    pub decision: Option<String>,
    pub constraints: Vec<ConstraintRequest>,
    #[serde(default)]
    pub stations: Vec<StationRequest>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapacityStation {
    pub id: String,
    pub name: String,
    pub free: bool,
    /// Offered load a = α/μ (the mean number of busy servers) as drawn.
    pub load: f64,
    pub servers_now: i64,
    pub servers: i64,
    pub rate_now: f64,
    pub rate: f64,
    /// The cost of one server (servers) or of one unit of rate (rates), as asked.
    pub unit_cost: f64,
    pub cost_now: f64,
    pub cost: f64,
    /// None where the station is overloaded as drawn.
    pub utilisation_now: Option<f64>,
    pub utilisation: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapacityConstraint {
    pub kind: String,
    pub station_id: Option<String>,
    pub target: f64,
    /// "time", "customers" or "ratio".
    pub unit: &'static str,
    /// The value as drawn (none while the network is overloaded) and as proposed.
    pub now: Option<f64>,
    pub proposed: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapacityPoint {
    pub cost: f64,
    pub number: f64,
    pub delay: f64,
    /// The station that got the server that led here.
    pub added: Option<String>,
    pub feasible: bool,
}

/// Why no plan meets the targets. `why`: "badTarget", "badStation", "fixedOverloaded",
/// "limitOverloaded", "stationLimit", "floor", "serviceFloor", "tooMany", "ratesTarget",
/// "severalServers", "nothingFree", "fixedTooFull".
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapacityInfeasible {
    pub why: &'static str,
    /// The constraint (its index in the request) and the station it is about.
    pub constraint: Option<usize>,
    pub station_id: Option<String>,
    /// The least the constraint's measure can reach, in its unit.
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapacityPlan {
    /// False when no closed form applies; `reason` ("network", "noTraffic", "notJackson",
    /// "closed") and `sentence` say why.
    pub available: bool,
    pub reason: Option<&'static str>,
    pub sentence: Option<String>,
    pub decision: &'static str,
    pub infeasible: Option<CapacityInfeasible>,
    pub stations: Vec<CapacityStation>,
    pub constraints: Vec<CapacityConstraint>,
    pub cost_now: f64,
    pub cost: Option<f64>,
    /// "marginal" (optimal by theorem), "search" (certified by the exact search), "closedForm"
    /// (the square-root rule) or "none" (good, not proven best).
    pub proof: Option<&'static str>,
    pub searched: bool,
    pub search_nodes: u64,
    pub search_limit: u64,
    /// The exact search found an allocation cheaper than marginal allocation's.
    pub improved: bool,
    /// Cost against congestion: the greedy path (servers) or the least-cost frontier (rates).
    pub path: Vec<CapacityPoint>,
    /// The network's mean delay and mean number as drawn (none while overloaded) and as proposed.
    pub delay_now: Option<f64>,
    pub delay: Option<f64>,
    pub number_now: Option<f64>,
    pub number: Option<f64>,
    /// The delay no number of servers shortens: Σ aᵢ/Λ, the visit-weighted sum of service times.
    pub delay_floor: Option<f64>,
    pub total_arrivals: Option<f64>,
}

fn refuse(reason: &'static str, sentence: String) -> CapacityPlan {
    CapacityPlan { available: false, reason: Some(reason), sentence: Some(sentence), decision: "servers", ..Default::default() }
}

/// What Capacity says of a network drawn as a closed one (the rule and the words are core's).
const SUBJECT: &str = "Capacity planning";

fn constraint_of(model: &JacksonModel, c: &ConstraintRequest) -> Result<Constraint, QnError> {
    Ok(match c.kind.as_str() {
        "networkSojourn" => Constraint::NetworkSojourn(c.target),
        "networkNumber" => Constraint::NetworkNumber(c.target),
        "utilisation" => Constraint::Utilisation(c.target),
        "stationWait" => {
            let i = c.station_id.as_deref().and_then(|id| model.ids.iter().position(|x| x == id)).ok_or_else(|| QnError::invalid("The station this target belongs to is no longer in the network."))?;
            Constraint::StationWait(i, c.target)
        }
        other => return Err(QnError::invalid(format!("There's no target called “{other}”."))),
    })
}

/// The plan for `req` (the command, as a plain function).
pub fn capacity(req: &CapacityRequest) -> Result<CapacityPlan, QnError> {
    let text = serde_json::to_string(&req.document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = qnet_core::bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the network.").with_detail(e.to_string()))?;
    if let Some((reason, sentence)) = qnet_core::extended::classical_only(&net, SUBJECT) {
        return Ok(refuse(reason, sentence));
    }
    let model = match planning_model(&net) {
        Ok(m) => m,
        Err(e) => {
            let reason = match e {
                JacksonError::Network(_) => "network",
                JacksonError::Unstable(..) => "noTraffic",
                JacksonError::NotJackson => "notJackson",
            };
            return Ok(refuse(reason, e.message()));
        }
    };
    let loads = match Loads::new(&model) {
        Ok(l) => l,
        Err(e) => return Ok(refuse("noTraffic", e.message())),
    };
    let d = model.mu.len();
    let rates = req.decision.as_deref() == Some("rates");
    let asked = |i: usize| req.stations.iter().find(|s| s.id == model.ids[i]);
    let free: Vec<bool> = (0..d).map(|i| asked(i).map_or(true, |s| s.free)).collect();
    let unit_cost: Vec<f64> = (0..d).map(|i| asked(i).map_or(1.0, |s| if rates { s.rate_cost } else { s.cost })).collect();
    let constraints: Vec<Constraint> = req.constraints.iter().map(|c| constraint_of(&model, c)).collect::<Result<_, _>>()?;
    let now: Vec<i64> = model.servers.iter().map(|c| (*c).max(1)).collect();
    let solved_now = jackson::solve(&model).ok();
    let infeasible = |why: &'static str, constraint: Option<usize>, station: Option<usize>, value: Option<f64>| CapacityInfeasible { why, constraint, station_id: station.map(|i| model.ids[i].clone()), value: value.filter(|v| v.is_finite()) };

    let mut servers = now.clone();
    let mut mu = model.mu.clone();
    let mut out = CapacityPlan { available: true, decision: if rates { "rates" } else { "servers" }, search_limit: SEARCH_NODE_LIMIT, total_arrivals: Some(loads.total_arrivals), delay_floor: Some(loads.a.iter().sum::<f64>() / loads.total_arrivals), ..Default::default() };
    let point = |cost: f64, number: f64, added: Option<usize>, feasible: bool| CapacityPoint { cost, number, delay: number / loads.total_arrivals, added: added.map(|i| model.ids[i].clone()), feasible };
    let mut planned = false;

    if rates {
        // The square-root rule bounds the network's mean number: the tightest network target.
        let number = constraints
            .iter()
            .filter_map(|c| match c {
                Constraint::NetworkNumber(n) => Some(*n),
                Constraint::NetworkSojourn(t) => Some(t * loads.total_arrivals),
                _ => None,
            })
            .fold(f64::INFINITY, f64::min);
        if constraints.is_empty() || constraints.iter().any(|c| matches!(c, Constraint::Utilisation(_) | Constraint::StationWait(..))) {
            out.infeasible = Some(infeasible("ratesTarget", constraints.iter().position(|c| matches!(c, Constraint::Utilisation(_) | Constraint::StationWait(..))), None, None));
        } else {
            match plan_rates(&model, number, &unit_cost, &free) {
                Ok(p) => {
                    planned = true;
                    out.proof = Some("closedForm");
                    out.cost = Some(p.cost);
                    out.cost_now = p.cost_now;
                    // The least-cost frontier around the target: what each mean number would cost.
                    out.path = (0..=24)
                        .filter_map(|k| {
                            let n = number * 2f64.powf(1.5 - k as f64 / 8.0);
                            plan_rates(&model, n, &unit_cost, &free).ok().map(|q| point(q.cost, n, None, n <= number))
                        })
                        .collect();
                    mu = p.mu;
                }
                Err(e) => {
                    let unit = |v: f64| if constraints.iter().all(|c| matches!(c, Constraint::NetworkSojourn(_))) { v / loads.total_arrivals } else { v };
                    out.infeasible = Some(match e {
                        RateInfeasible::BadTarget => infeasible("badTarget", Some(0), None, None),
                        RateInfeasible::BadStation(i) => infeasible("badStation", None, Some(i), None),
                        RateInfeasible::SeveralServers(i) => infeasible("severalServers", None, Some(i), None),
                        RateInfeasible::FixedOverloaded(i) => infeasible("fixedOverloaded", None, Some(i), None),
                        RateInfeasible::NothingFree => infeasible("nothingFree", None, None, None),
                        RateInfeasible::FixedTooFull { fixed } => infeasible("fixedTooFull", None, None, Some(unit(fixed))),
                    });
                    out.cost_now = (0..d).filter(|i| free[*i]).map(|i| unit_cost[i] * model.mu[i]).sum();
                }
            }
        }
    } else {
        let problem = Problem {
            model: model.clone(),
            constraints: constraints.clone(),
            cost: unit_cost.clone(),
            free: free.clone(),
            lower: (0..d).map(|i| asked(i).and_then(|s| s.lower).unwrap_or(1)).collect(),
            upper: (0..d).map(|i| asked(i).and_then(|s| s.upper)).collect(),
        };
        out.cost_now = now.iter().zip(&unit_cost).map(|(c, k)| *c as f64 * k).sum();
        match plan(&problem) {
            Ok(p) => {
                planned = true;
                out.proof = Some(match p.proof {
                    Proof::Marginal => "marginal",
                    Proof::Search => "search",
                    Proof::None => "none",
                });
                out.cost = Some(p.cost);
                out.searched = p.searched;
                out.search_nodes = p.search_nodes;
                out.improved = p.improved;
                out.path = p.path.iter().map(|x| point(x.cost, x.number, x.added, x.feasible)).collect();
                servers = p.servers;
            }
            Err(e) => {
                out.infeasible = Some(match e {
                    Infeasible::BadTarget(k) => infeasible("badTarget", Some(k), None, None),
                    Infeasible::BadStation(i) => infeasible("badStation", None, Some(i), None),
                    Infeasible::FixedOverloaded(i) => infeasible("fixedOverloaded", None, Some(i), None),
                    Infeasible::LimitOverloaded(i) => infeasible("limitOverloaded", None, Some(i), Some(loads.minimal_stable(i) as f64)),
                    Infeasible::StationLimit { constraint, station, best } => infeasible("stationLimit", Some(constraint), Some(station), Some(best)),
                    Infeasible::Floor { constraint, floor, service_only } => infeasible(if service_only { "serviceFloor" } else { "floor" }, Some(constraint), None, Some(floor)),
                    Infeasible::TooMany => infeasible("tooMany", None, None, None),
                });
            }
        }
    }

    // The proposal, solved again by the closed form every other view uses.
    let mut proposed = model.clone();
    proposed.servers = servers.clone();
    proposed.mu = mu.clone();
    let solved = if planned { jackson::solve(&proposed).ok() } else { None };
    let proposed_loads = Loads::new(&proposed).ok();
    out.delay_now = solved_now.as_ref().map(|s| s.network_sojourn());
    out.number_now = solved_now.as_ref().map(|s| s.network_number());
    out.delay = solved.as_ref().map(|s| s.network_sojourn());
    out.number = solved.as_ref().map(|s| s.network_number());
    out.constraints = req
        .constraints
        .iter()
        .zip(&constraints)
        .map(|(asked, c)| CapacityConstraint {
            kind: asked.kind.clone(),
            station_id: asked.station_id.clone(),
            target: asked.target,
            unit: c.unit(),
            now: solved_now.as_ref().map(|_| loads.value(*c, &now)).filter(|v| v.is_finite()),
            proposed: solved.as_ref().and(proposed_loads.as_ref()).map(|l| l.value(*c, &servers)).filter(|v| v.is_finite()),
        })
        .collect();
    out.stations = (0..d)
        .map(|i| {
            let (amount_now, amount) = if rates { (model.mu[i], mu[i]) } else { (now[i] as f64, servers[i] as f64) };
            let rho_now = loads.utilisation(i, now[i]);
            CapacityStation {
                id: model.ids[i].clone(),
                name: model.names[i].clone(),
                free: free[i],
                load: loads.a[i],
                servers_now: now[i],
                servers: servers[i],
                rate_now: model.mu[i],
                rate: mu[i],
                unit_cost: unit_cost[i],
                cost_now: unit_cost[i] * amount_now,
                cost: unit_cost[i] * amount,
                utilisation_now: (rho_now < 1.0).then_some(rho_now),
                utilisation: loads.alpha[i] / (mu[i] * servers[i] as f64),
            }
        })
        .collect();
    Ok(out)
}

/// Results ▸ Capacity, the exact route: the cheapest servers or service rates that meet the targets.
#[tauri::command(async)]
pub fn capacity_plan(request: CapacityRequest) -> Result<CapacityPlan, QnError> {
    capacity(&request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const S1: &str = "1EA5D945-A8FE-4026-9B40-F78369F6FDDA";
    const S2: &str = "3A8845FE-6084-4B63-B474-2FE42F64FFED";

    fn example(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(format!("{name}.bnet"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn request(decision: &str, constraints: &[(&str, Option<&str>, f64)]) -> CapacityRequest {
        CapacityRequest {
            document: example("OpenJackson.d2.feedback.p30.inf"),
            decision: Some(decision.into()),
            constraints: constraints.iter().map(|(k, s, t)| ConstraintRequest { kind: (*k).into(), station_id: s.map(str::to_string), target: *t }).collect(),
            stations: Vec::new(),
        }
    }

    /// OpenJackson.d2.feedback.p30: γ = 1, α = (1/0.7, 1), μ = (1/0.49, 1/0.7): a = (0.7, 0.7),
    /// one server each, L = 7/3 at each station, W = 14/3 (the recorded product-form run in
    /// golden/runs gives 2.33333333). The floor of the delay is Σ a/Λ = 1.4. With two servers at
    /// a station (M/M/2, a = 0.7: L = a/(1 − (a/2)²) = 0.7/0.8775 = 0.797721) the delay is
    /// 7/3 + 0.797721 = 3.131054; with two at both, 1.595442. So W ≤ 3.2 takes one more server
    /// (3 in all), W ≤ 2 takes two more, and W ≤ 1.4 cannot be met.
    #[test]
    fn the_command_plans_the_jackson_example_in_the_shape_the_interface_reads() {
        let p = capacity(&request("servers", &[("networkSojourn", None, 3.2)])).unwrap();
        assert!(p.available && p.infeasible.is_none());
        assert_eq!((p.cost_now, p.cost, p.proof), (2.0, Some(3.0), Some("marginal")));
        assert!((p.delay_now.unwrap() - 14.0 / 3.0).abs() < 1e-9 && (p.delay_floor.unwrap() - 1.4).abs() < 1e-9);
        let m2 = 0.7 / (1.0 - 0.35 * 0.35);
        assert!((p.delay.unwrap() - (7.0 / 3.0 + m2)).abs() < 1e-9, "{:?}", p.delay);
        assert_eq!(p.stations.iter().map(|s| s.servers).sum::<i64>(), 3);
        assert_eq!(p.constraints[0].unit, "time");
        assert!((p.constraints[0].now.unwrap() - 14.0 / 3.0).abs() < 1e-9 && p.constraints[0].proposed.unwrap() <= 3.2);
        // The path: start (1, 1), then one server at a time; the first feasible point costs 3.
        assert_eq!(p.path[0].cost, 2.0);
        assert!(!p.path[0].feasible && p.path[1].feasible && p.path[1].added.is_some());
        let two = capacity(&request("servers", &[("networkSojourn", None, 2.0)])).unwrap();
        assert_eq!(two.stations.iter().map(|s| s.servers).collect::<Vec<_>>(), [2, 2]);
        assert!((two.delay.unwrap() - 2.0 * m2).abs() < 1e-9);
        let json = serde_json::to_value(&two).unwrap();
        assert!(json["stations"][0]["serversNow"] == 1 && json["path"][0]["delay"].is_number() && json["searchLimit"].is_number());
        // Below the pure service time.
        let none = capacity(&request("servers", &[("networkSojourn", None, 1.4)])).unwrap();
        let why = none.infeasible.unwrap();
        assert_eq!((why.why, why.constraint), ("serviceFloor", Some(0)));
        assert!((why.value.unwrap() - 1.4).abs() < 1e-9 && none.cost.is_none() && none.constraints[0].proposed.is_none());
        // Several targets, a station held, a cost: S1 may not change, S2 is dear; ρ ≤ 0.5 at every station cannot be met by S1.
        let mut held = request("servers", &[("utilisation", None, 0.5), ("stationWait", Some(S2), 0.05)]);
        held.stations = vec![StationRequest { id: S1.into(), free: false, cost: 1.0, rate_cost: 1.0, lower: None, upper: None }];
        let why = capacity(&held).unwrap().infeasible.unwrap();
        assert_eq!((why.why, why.station_id.as_deref()), ("stationLimit", Some(S1)));
        held.constraints.remove(0);
        held.stations.push(StationRequest { id: S2.into(), free: true, cost: 2.5, rate_cost: 1.0, lower: None, upper: None });
        let p = capacity(&held).unwrap();
        // Wq at S2 (α = 1, a = 0.7): one server 1.633, two 0.0977, three 0.0107 → three servers, at 2.5 each.
        assert_eq!((p.stations[0].servers, p.stations[1].servers, p.cost), (1, 3, Some(1.0 + 7.5)));
        assert!(capacity(&request("servers", &[("stationWait", None, 1.0)])).is_err(), "a station target needs its station");
    }

    /// Service rates by the square-root rule on the same network: α = (1/0.7, 1), unit costs,
    /// target L ≤ 2: S = √(1/0.7) + 1, μᵢ = αᵢ + √αᵢ·S/2; solved again the mean number is 2.
    #[test]
    fn the_command_plans_service_rates_by_the_square_root_rule() {
        let p = capacity(&request("rates", &[("networkNumber", None, 2.0)])).unwrap();
        assert_eq!((p.decision, p.proof), ("rates", Some("closedForm")));
        let (a1, a2) = (1.0 / 0.7f64, 1.0f64);
        let s = a1.sqrt() + a2.sqrt();
        assert!((p.stations[0].rate - (a1 + a1.sqrt() * s / 2.0)).abs() < 1e-9 && (p.stations[1].rate - (a2 + s / 2.0)).abs() < 1e-9);
        assert!((p.number.unwrap() - 2.0).abs() < 1e-9 && (p.cost.unwrap() - (a1 + a2 + s * s / 2.0)).abs() < 1e-9);
        assert!((p.cost_now - (1.0 / 0.49 + 1.0 / 0.7)).abs() < 1e-9);
        assert!(p.path.len() == 25 && p.path.windows(2).all(|w| w[1].cost > w[0].cost && w[1].number < w[0].number));
        // A station target has no square-root form.
        assert_eq!(capacity(&request("rates", &[("utilisation", None, 0.5)])).unwrap().infeasible.unwrap().why, "ratesTarget");
    }

    #[test]
    fn a_network_with_no_closed_form_says_why() {
        let mut req = request("servers", &[("networkSojourn", None, 3.0)]);
        req.document = example("MM1K.d1.c1.fin");
        let p = capacity(&req).unwrap();
        assert_eq!((p.available, p.reason), (false, Some("notJackson")));
    }

    /// Closed-ness is core's one rule (`closed::drawn_as`): no source and no sink. A population on
    /// a network that has a source and a sink is ignored (the problems list says so), and the
    /// network is planned as the open network it is.
    #[test]
    fn closed_is_decided_by_the_one_rule() {
        let mut req = request("servers", &[("networkSojourn", None, 3.0)]);
        // The bundled closed example: refused with the closed sentence.
        req.document = example("closed/ClosedCentralServer.d3.N8");
        let p = capacity(&req).unwrap();
        assert_eq!((p.available, p.reason), (false, Some("closed")));
        assert_eq!(p.sentence.as_deref(), Some("This is a closed network: a fixed number of customers circulates and nothing arrives from outside. Capacity planning covers open networks."));
        // The same with its population taken away: not closed yet, and told so.
        req.document.as_object_mut().unwrap().remove("closedPopulation");
        let p = capacity(&req).unwrap();
        assert_eq!(p.reason, Some("closedNoPopulation"));
        assert!(p.sentence.unwrap().starts_with("The network has no source and no sink, but no number of customers is set."));
        // An open network that carries a population (a closed one given a source and a sink) is open.
        let mut marked = example("OpenJackson.d2.feedback.p30.inf");
        marked["closedPopulation"] = serde_json::json!(5);
        req.document = marked;
        let p = capacity(&req).unwrap();
        assert!(p.available, "{:?} {:?}", p.reason, p.sentence);
        // A source taken away, the sink kept: an open network with a problem, not a closed one.
        let mut doc = example("OpenJackson.d2.feedback.p30.inf");
        let nodes = doc["nodes"].as_array().unwrap().iter().filter(|n| n["kind"] != "source").cloned().collect::<Vec<_>>();
        doc["nodes"] = Value::Array(nodes);
        req.document = doc;
        let p = capacity(&req).unwrap();
        assert_eq!((p.available, p.reason, p.sentence.as_deref()), (false, Some("network"), Some("The network has no source node.")));
    }

    /// An overloaded network is planned: the example with every arrival tripled (a = 2.1 at both
    /// stations) has no steady state as drawn, and ρ ≤ 0.8 needs ⌈2.1/0.8⌉ = 3 servers at each.
    #[test]
    fn an_overloaded_network_is_planned() {
        let mut req = request("servers", &[("utilisation", None, 0.8)]);
        let text = serde_json::to_string(&req.document).unwrap();
        assert!(text.contains("lambda=1"), "the example's source is Poisson at rate 1");
        for n in req.document["nodes"].as_array_mut().unwrap() {
            if n["kind"] == "source" {
                n["distributionParameters"] = Value::String("lambda=3".into());
            }
        }
        let p = capacity(&req).unwrap();
        assert!(p.available && p.delay_now.is_none() && p.constraints[0].now.is_none() && p.stations[0].utilisation_now.is_none());
        assert_eq!(p.stations.iter().map(|s| s.servers).collect::<Vec<_>>(), [3, 3]);
        assert!((p.constraints[0].proposed.unwrap() - 0.7).abs() < 1e-9);
    }
}
