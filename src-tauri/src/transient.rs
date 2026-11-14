//! Transient analysis (new in 2.1, ROADMAP D4): Run ▸ Transient…. `transient_prepare` says which
//! tiers apply to a document and suggests a horizon; `transient_analyze` computes the mean number
//! at each station over time — exactly, by uniformisation of the network's Markov chain, where
//! the network is an open Jackson network small enough, and by the fluid model for any open
//! network with infinite buffers — all in process (`qnet_core::transient`, which has the exact
//! checks). The exact tier can take seconds: the command is async, reports progress on its
//! channel and is stopped by `transient_stop`. Nothing is run and nothing is filed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;

use qnet_core::jackson::{self, JacksonModel};
use qnet_core::transient::{self, Initial, Refusal, Request, Surge};

use crate::errors::QnError;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialRequest {
    /// "empty", "steady" or "given".
    pub kind: String,
    /// For "given": the number at each station, in the order `transient_prepare` lists them.
    #[serde(default)]
    pub numbers: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurgeRequest {
    pub factor: f64,
    pub from: f64,
    pub until: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientRequest {
    /// The caller's name for this computation, for `transient_stop`.
    pub id: String,
    pub document: Value,
    /// Time units.
    pub horizon: f64,
    /// Equal intervals of the time grid (default 200).
    #[serde(default)]
    pub intervals: Option<usize>,
    pub initial: InitialRequest,
    #[serde(default)]
    pub surge: Option<SurgeRequest>,
    /// 0.05: settled means within 5 % of the long-run mean.
    pub settle_fraction: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransientStation {
    pub id: String,
    pub name: String,
    pub servers: i64,
    /// ρ = α/(cμ); null when the traffic equations have no solution.
    pub utilisation: Option<f64>,
    /// The long-run mean number L (customers), exact; null when there is no steady state.
    pub stationary: Option<f64>,
    /// 1/(√(cμ) − √α)², time units; null when the station is not stable.
    pub relaxation: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransientPrepare {
    /// Why the exact tier does not apply (before any size is known), or null.
    pub exact_reason: Option<String>,
    /// Why the fluid tier does not apply, or null.
    pub fluid_reason: Option<String>,
    pub stations: Vec<TransientStation>,
    /// Time units; null when neither tier applies.
    pub suggested_horizon: Option<f64>,
    /// The network's stored rate profiles (new in 2.1), when a source has one: the analysis
    /// follows them, and a surge cannot be added on top.
    pub profile: Option<StoredProfile>,
}

/// What the document's rate profiles are, for the view's words.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfile {
    /// The sources that have one.
    pub sources: Vec<String>,
    pub periodic: bool,
    /// The longest profile: its period, or the time after which it is over.
    pub span: f64,
}

fn stored_profile(net: &qnet_core::model::Network) -> Option<StoredProfile> {
    let with: Vec<_> = net.nodes.iter().filter(|n| n.kind == qnet_core::model::NodeKind::Source).filter_map(|n| n.rate_profile.as_ref().map(|r| (n.name.clone(), r))).collect();
    (!with.is_empty()).then(|| StoredProfile { sources: with.iter().map(|(n, _)| n.clone()).collect(), periodic: with.iter().any(|(_, r)| r.periodic), span: with.iter().map(|(_, r)| r.span()).fold(0.0, f64::max) })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExactAnswer {
    /// `[station][time]`: E[number at the station], customers: a lower bound on the true mean.
    pub mean: Vec<Vec<f64>>,
    /// Per station: the most the true mean can exceed the computed one at any time shown
    /// (customers; core `Exact::shortfall`, a proven bound), or null when no bound holds: a
    /// surge that overloads the network.
    pub shortfall: Vec<Option<f64>>,
    /// Per station: true when a settling time could not be certified (the mean's error interval
    /// is not inside the band, or has no upper end), so `settling` is null without meaning "not settled".
    pub uncertified: Vec<bool>,
    /// P(station empty).
    pub empty: Vec<Vec<f64>>,
    /// Total-variation distance to the steady state at each time.
    pub distance: Vec<f64>,
    /// Per station: the time after which the mean stays inside the band, or null.
    pub settling: Vec<Option<f64>>,
    pub settle_from: f64,
    pub levels: Vec<usize>,
    pub states: usize,
    pub uniformisation_rate: f64,
    pub products: usize,
    /// The a priori bound on the Poisson tails, and the whole ℓ₁ error at the horizon.
    pub poisson_bound: f64,
    pub missing_mass: f64,
    pub stationary_tail: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Emptied {
    pub station: usize,
    pub time: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FluidAnswer {
    /// `[station][time]`: fluid level, customers.
    pub level: Vec<Vec<f64>>,
    pub emptied: Vec<Emptied>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransientAnalysis {
    pub times: Vec<f64>,
    pub stations: Vec<TransientStation>,
    pub exact: Option<ExactAnswer>,
    /// Why there is no exact answer (a sentence), when there isn't.
    pub exact_reason: Option<String>,
    pub fluid: Option<FluidAnswer>,
    pub fluid_reason: Option<String>,
    /// The exact calculation was stopped.
    pub stopped: bool,
    /// The pointwise stationary approximation (new in 2.1; core `transient::psa`), when the
    /// rates change in time (a stored profile or a surge) and the network is a Jackson network:
    /// `[station][time]`, null where the frozen network is overloaded. **An approximation.**
    pub psa: Option<Vec<Vec<Option<f64>>>>,
    /// The times at which a stored rate profile changes, within the horizon.
    pub profile_breaks: Vec<f64>,
    /// The stored profile repeats: the means cycle and never settle, and the drawn network's
    /// steady state is not where they go.
    pub profile_periodic: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientProgress {
    pub fraction: f64,
}

fn finite(x: f64) -> Option<f64> {
    Some(x).filter(|v| v.is_finite())
}

fn read(document: &Value) -> Result<qnet_core::model::Network, QnError> {
    let text = serde_json::to_string(document).map_err(|e| QnError::invalid(e.to_string()))?;
    qnet_core::bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't read the network.").with_detail(e.to_string()))
}

fn stations_of(model: &JacksonModel) -> Vec<TransientStation> {
    let alpha = jackson::throughputs(model);
    let solution = jackson::solve(model).ok();
    (0..model.mu.len())
        .map(|i| {
            let cap = model.servers[i].max(1) as f64 * model.mu[i];
            TransientStation {
                id: model.ids[i].clone(),
                name: model.names[i].clone(),
                servers: model.servers[i],
                utilisation: alpha.as_ref().and_then(|a| finite(a[i] / cap)),
                stationary: solution.as_ref().and_then(|s| finite(s.number[i])),
                relaxation: alpha.as_ref().and_then(|a| finite(transient::relaxation_time(a[i], cap))),
            }
        })
        .collect()
}

/// What Run ▸ Transient… can do for the document (the command, as a plain function).
pub fn prepare(document: &Value) -> Result<TransientPrepare, QnError> {
    let net = read(document)?;
    let a = transient::applicability(&net);
    let model = a.exact.as_ref().ok().or(a.fluid.as_ref().ok());
    let stations = model.map(stations_of).unwrap_or_default();
    let profile = model.and_then(|_| stored_profile(&net));
    // With a stored profile: long enough to show all of it (two periods of a periodic one).
    let shown = profile.as_ref().map(|p| if p.periodic { 2.0 * p.span } else { 1.5 * p.span }).unwrap_or(0.0);
    let suggested_horizon = model.and_then(|m| jackson::throughputs(m).map(|alpha| transient::suggested_horizon(m, &alpha).max(shown))).and_then(finite);
    Ok(TransientPrepare { exact_reason: a.exact.err(), fluid_reason: a.fluid.err(), stations, suggested_horizon, profile })
}

/// The analysis (the command, as a plain function): `progress` returns false to stop.
pub fn analyze(req: &TransientRequest, progress: &mut dyn FnMut(f64) -> bool) -> Result<TransientAnalysis, QnError> {
    let net = read(&req.document)?;
    let a = transient::applicability(&net);
    let Some(model) = a.exact.as_ref().ok().or(a.fluid.as_ref().ok()) else {
        return Ok(TransientAnalysis { exact_reason: a.exact.err(), fluid_reason: a.fluid.err(), ..Default::default() });
    };
    let initial = match req.initial.kind.as_str() {
        "empty" => Initial::Empty,
        "steady" => Initial::Steady,
        "given" => Initial::Given(req.initial.numbers.clone()),
        other => return Err(QnError::invalid(format!("There's no starting condition called “{other}”."))),
    };
    // New in 2.1: the network's stored rate profiles (`transient::profile_of`).
    let profile = if req.horizon > 0.0 && req.horizon.is_finite() { transient::profile_of(&net, model, req.horizon).map_err(QnError::invalid)? } else { None };
    let request = Request {
        horizon: req.horizon,
        intervals: req.intervals.unwrap_or(200),
        initial,
        surge: req.surge.map(|s| Surge { factor: s.factor, from: s.from, until: s.until }),
        profile,
        settle_fraction: req.settle_fraction,
        ..Request::default()
    };
    transient::validate(model, &request).map_err(QnError::invalid)?;
    let psa = match &a.exact {
        Ok(jm) if request.profile.is_some() || request.surge.is_some() => Some(transient::psa(jm, &request).into_iter().map(|row| row.into_iter().map(|x| x.and_then(finite)).collect()).collect()),
        _ => None,
    };
    let profile_breaks = request.profile.as_ref().map(|p| p.breaks.clone()).unwrap_or_default();
    let profile_periodic = request.profile.as_ref().is_some_and(|p| p.periodic);

    let f = transient::fluid(model, &request);
    let fluid = Some(FluidAnswer { level: f.level, emptied: f.emptied.into_iter().map(|(station, time)| Emptied { station, time }).collect() });
    let mut out = TransientAnalysis { times: f.times, stations: stations_of(model), fluid, psa, profile_breaks, profile_periodic, ..Default::default() };
    match a.exact {
        Err(reason) => out.exact_reason = Some(reason),
        Ok(ref jm) => match transient::exact(jm, &request, progress) {
            Ok(e) => {
                out.exact = Some(ExactAnswer {
                    mean: e.mean,
                    shortfall: e.shortfall.iter().map(|row| row.iter().try_fold(0.0f64, |m, b| b.map(|b| m.max(b))).and_then(finite)).collect(),
                    uncertified: e.uncertified,
                    empty: e.empty,
                    distance: e.distance,
                    settling: e.settling,
                    settle_from: e.settle_from,
                    levels: e.levels,
                    states: e.states,
                    uniformisation_rate: e.uniformisation_rate,
                    products: e.products,
                    poisson_bound: e.poisson_bound,
                    missing_mass: e.missing_mass.last().copied().unwrap_or(0.0),
                    stationary_tail: e.stationary_tail,
                })
            }
            Err(Refusal::Stopped) => out.stopped = true,
            Err(r) => out.exact_reason = Some(r.message()),
        },
    }
    Ok(out)
}

/// The computations in flight, by the caller's id, for `transient_stop`.
fn active() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}

/// Run ▸ Transient…: which tiers apply, the stations and a horizon to suggest.
#[tauri::command(async)]
pub fn transient_prepare(document: Value) -> Result<TransientPrepare, QnError> {
    prepare(&document)
}

/// Run ▸ Transient…: the curves. Progress (a fraction of the exact tier's work) arrives on `channel`.
#[tauri::command(async)]
pub fn transient_analyze(request: TransientRequest, channel: Channel<TransientProgress>) -> Result<TransientAnalysis, QnError> {
    let stop = Arc::new(AtomicBool::new(false));
    active().lock().unwrap().insert(request.id.clone(), stop.clone());
    let mut last = Instant::now();
    let result = analyze(&request, &mut |fraction| {
        if last.elapsed() >= Duration::from_millis(80) {
            last = Instant::now();
            let _ = channel.send(TransientProgress { fraction });
        }
        !stop.load(Ordering::Relaxed)
    });
    active().lock().unwrap().remove(&request.id);
    result
}

/// Stop: the computation named `id` ends with `stopped: true`.
#[tauri::command]
pub fn transient_stop(id: String) {
    if let Some(flag) = active().lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn example(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(format!("{name}.bnet"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn request(name: &str, horizon: f64) -> TransientRequest {
        TransientRequest { id: "t".into(), document: example(name), horizon, intervals: Some(100), initial: InitialRequest { kind: "empty".into(), numbers: vec![] }, surge: None, settle_fraction: 0.05 }
    }

    /// A surge that overloads the network (arrivals ×2 at ρ = 0.7): no bound on the means is
    /// claimed (null), and no settling time is declared from them.
    #[test]
    fn an_overloading_surge_claims_no_bound_and_no_settling_time() {
        let mut req = request("OpenJackson.d2.feedback.p30.inf", 300.0);
        req.surge = Some(SurgeRequest { factor: 2.0, from: 5.0, until: 15.0 });
        req.initial = InitialRequest { kind: "steady".into(), numbers: vec![] };
        let e = analyze(&req, &mut |_| true).unwrap().exact.unwrap();
        assert_eq!(e.shortfall, vec![None, None]);
        assert_eq!((e.settling.clone(), e.uncertified.clone()), (vec![None, None], vec![true, true]));
    }

    /// The Jackson example end to end, in the shape the interface reads: both tiers, the curves
    /// ending at the exact stationary means (7/3 at both stations, the recorded Product Form
    /// run), settling times inside the suggested horizon, the error figures present.
    #[test]
    fn a_jackson_example_answers_with_both_tiers() {
        let p = prepare(&example("OpenJackson.d2.feedback.p30.inf")).unwrap();
        assert_eq!((p.exact_reason.clone(), p.fluid_reason.clone()), (None, None));
        let h = p.suggested_horizon.unwrap();
        assert!(h > 10.0 && h < 200.0, "{h}");
        assert!((p.stations[0].utilisation.unwrap() - 0.7).abs() < 1e-12);
        let r = analyze(&request("OpenJackson.d2.feedback.p30.inf", h), &mut |_| true).unwrap();
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["times"].as_array().unwrap().len(), 101);
        assert!(json["exact"]["missingMass"].as_f64().unwrap() < 1e-6);
        assert!(json["exact"]["poissonBound"].as_f64().unwrap() <= 1e-8);
        // The means are lower bounds with a proven bound on the shortfall, here far below any
        // band: the levels are chosen for it (core `Exact::shortfall`).
        for b in json["exact"]["shortfall"].as_array().unwrap() {
            assert!(b.as_f64().unwrap() < 1e-6, "{b}");
        }
        assert_eq!(json["exact"]["uncertified"], serde_json::json!([false, false]));
        let e = r.exact.unwrap();
        for i in 0..2 {
            assert!((r.stations[i].stationary.unwrap() - 7.0 / 3.0).abs() < 1e-9);
            let s = e.settling[i].expect("settles inside the suggested horizon");
            assert!(s > 0.0 && s < h);
            assert!((e.mean[i][100] - 7.0 / 3.0).abs() < 0.05 * 7.0 / 3.0);
        }
        assert!(r.fluid.unwrap().level.iter().all(|row| row.iter().all(|&q| q == 0.0)));
        assert!(!r.stopped);
    }

    /// Where a tier does not apply the answer says why: finite buffers (neither), a larger
    /// tandem (fluid only: too many states), a stop.
    #[test]
    fn refusals_are_sentences_and_the_fluid_tier_still_answers() {
        let p = prepare(&example("MM1K.d1.c1.fin")).unwrap();
        assert!(p.exact_reason.unwrap().contains("infinite buffers") && p.fluid_reason.is_some() && p.suggested_horizon.is_none());
        let r = analyze(&request("10stationtandem.inf", 20.0), &mut |_| true).unwrap();
        assert!(r.exact.is_none() && r.fluid.is_some());
        assert!(r.exact_reason.unwrap().contains("states"));
        let r = analyze(&request("OpenJackson.d2.feedback.p30.inf", 50.0), &mut |_| false).unwrap();
        assert!(r.stopped && r.exact.is_none() && r.fluid.is_some());
        let mut bad = request("OpenJackson.d2.feedback.p30.inf", -1.0);
        assert!(analyze(&bad, &mut |_| true).is_err());
        bad.horizon = 10.0;
        bad.initial = InitialRequest { kind: "given".into(), numbers: vec![1] };
        assert!(analyze(&bad, &mut |_| true).unwrap_err().message.contains("one number for each station"));
    }
}
