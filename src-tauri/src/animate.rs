//! Animation of a simulation on the canvas (new in 2.1, ROADMAP Phase E): the commands behind
//! View ▸ Animate. `qnet_core::sim` runs in-process; the interface starts a run (`animate_start`),
//! asks for the events chunk by chunk as it plays them (`animate_next`), may jump ahead without
//! events (`animate_skip`) and ends the run (`animate_stop`).
//!
//! A run is an illustration — one random path — and nothing here writes a run record, a result
//! or a file. The runs live in memory only, in a small table keyed by a session number; the
//! oldest is dropped when more than [`MAX_SESSIONS`] are open, so a window that never said stop
//! cannot grow it.
//!
//! Events travel as columns (`AnimateEvents`), one array per field, which is a third of the size
//! of an array of objects.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

use qnet_core::bnet;
use qnet_core::sim::{Event, Layout, Simulator, Snapshot, Stats};

use crate::errors::QnError;

/// Runs kept at once (one per animating tab or window, in practice one or two).
const MAX_SESSIONS: usize = 8;
/// The most arrivals and completions one `animate_next` simulates, whatever is asked.
const MAX_STEPS: usize = 20_000;
/// The most one `animate_skip` simulates: it returns where it got to.
const MAX_SKIP_STEPS: usize = 5_000_000;

#[derive(Default)]
struct Sessions {
    next: u32,
    open: BTreeMap<u32, Simulator>,
}

fn sessions() -> &'static Mutex<Sessions> {
    static S: OnceLock<Mutex<Sessions>> = OnceLock::new();
    S.get_or_init(Default::default)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimateStation {
    pub id: String,
    pub name: String,
    pub servers: usize,
    pub buffer_id: String,
    /// The exact long-run mean number in system (customers), when a closed form applies.
    pub exact_number: Option<f64>,
    /// With priority service (new in 2.1): each class's rank, 0 the highest, by class index.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rank: Vec<u32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimateSource {
    pub id: String,
    pub name: String,
    pub class: u32,
}

/// src/animate/model.ts `AnimateLayout`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimateLayout {
    pub stations: Vec<AnimateStation>,
    pub sources: Vec<AnimateSource>,
    pub sinks: Vec<String>,
    pub classes: usize,
    pub population: Option<usize>,
    pub unstable: Vec<String>,
    pub event_rate: f64,
}

/// Who is where: per station the queue (head first) and the servers, each customer as
/// [id, class].
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimateSnapshot {
    pub time: f64,
    /// The head of each queue: at most [`SNAPSHOT_HEAD`] customers per station.
    pub queues: Vec<Vec<(u64, u32)>>,
    /// How many wait at each station in all (the queue's whole length).
    pub waiting: Vec<u64>,
    pub servers: Vec<Vec<Option<(u64, u32)>>>,
}

/// How many customers of each queue a snapshot names. The picture draws six tokens and then
/// "+N"; an unstable network skipped ahead can have a million waiting, and one entry each must
/// not cross to the interface (ledger WF-508).
pub const SNAPSHOT_HEAD: usize = 512;

/// The simulator's own running totals at `time` (the interface's bookkeeping is held to them).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimateStats {
    pub time: f64,
    pub area_number: Vec<f64>,
    pub area_queue: Vec<f64>,
    pub arrivals: Vec<u64>,
    pub departures: Vec<u64>,
    pub created: u64,
    pub left: u64,
}

/// Events as columns: time, kind (0 arrive, 1 start, 2 depart, 3 route, 4 leave, 5 preempt:
/// the customer in service goes back to the head of its class's queue), customer,
/// class, station, server (−1 for none), other (source, target station or sink; −1 for none).
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct AnimateEvents {
    pub t: Vec<f64>,
    pub k: Vec<u8>,
    pub c: Vec<u64>,
    pub cls: Vec<u32>,
    pub s: Vec<u32>,
    pub srv: Vec<i32>,
    pub o: Vec<i32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimateStart {
    pub session: u32,
    pub seed: u32,
    pub layout: AnimateLayout,
    pub snapshot: AnimateSnapshot,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimateChunk {
    /// Every event up to this time is in the chunks sent so far.
    pub time: f64,
    pub events: AnimateEvents,
    pub stats: AnimateStats,
    /// After a skip: the state at `time`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<AnimateSnapshot>,
    /// The run has stopped for good (a queue past `sim::MAX_WAITING`): the sentence saying so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<String>,
}

fn layout(l: &Layout) -> AnimateLayout {
    AnimateLayout {
        stations: l.stations.iter().map(|s| AnimateStation { id: s.id.clone(), name: s.name.clone(), servers: s.servers, buffer_id: s.buffer_id.clone(), exact_number: s.exact_number, rank: s.priority_rank.clone() }).collect(),
        sources: l.sources.iter().map(|s| AnimateSource { id: s.id.clone(), name: s.name.clone(), class: s.class }).collect(),
        sinks: l.sinks.clone(),
        classes: l.classes,
        population: l.population,
        unstable: l.unstable.clone(),
        event_rate: l.event_rate,
    }
}

fn snapshot(sim: &Simulator) -> AnimateSnapshot {
    let (s, waiting): (Snapshot, Vec<u64>) = sim.snapshot_head(SNAPSHOT_HEAD);
    AnimateSnapshot { time: s.time, queues: s.queues, waiting, servers: s.servers }
}

/// 1000000 as "1,000,000".
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The sentence for a run stopped at its size limit, or None while it runs.
fn stopped(sim: &Simulator) -> Option<String> {
    sim.halted().map(|(i, _)| {
        let name = sim.layout().stations.get(i).map(|s| s.name.as_str()).unwrap_or("a station");
        format!("The queue at {name} has passed {} customers; the animation has stopped. The network is overloaded there: its queue grows without limit.", grouped(qnet_core::sim::MAX_WAITING))
    })
}

fn stats(s: Stats) -> AnimateStats {
    AnimateStats { time: s.time, area_number: s.area_number, area_queue: s.area_queue, arrivals: s.arrivals, departures: s.departures, created: s.created, left: s.left }
}

fn columns(events: &[Event]) -> AnimateEvents {
    let mut out = AnimateEvents::default();
    for e in events {
        out.t.push(e.time);
        out.k.push(e.kind as u8);
        out.c.push(e.customer);
        out.cls.push(e.class);
        out.s.push(e.station);
        out.srv.push(e.server);
        out.o.push(e.other);
    }
    out
}

fn gone() -> QnError {
    QnError::invalid("This animation has ended. Restart it.")
}

/// Starts a run of the document from `seed`, or says in a sentence why it cannot be animated.
pub fn start(document: &Value, seed: u32) -> Result<AnimateStart, QnError> {
    let text = serde_json::to_string(document).map_err(|e| QnError::invalid(e.to_string()))?;
    let net = bnet::read(&text).map_err(|e| QnError::invalid("Qnet couldn't animate the network: it isn't complete.").with_detail(e.to_string()))?;
    let sim = Simulator::new(&net, seed as u64).map_err(|r| QnError::invalid(r.message).with_detail(r.code))?;
    let answer_layout = layout(sim.layout());
    let answer_snapshot = snapshot(&sim);
    let mut table = sessions().lock().unwrap_or_else(|e| e.into_inner());
    table.next += 1;
    let session = table.next;
    table.open.insert(session, sim);
    while table.open.len() > MAX_SESSIONS {
        table.open.pop_first();
    }
    Ok(AnimateStart { session, seed, layout: answer_layout, snapshot: answer_snapshot })
}

fn with<T>(session: u32, f: impl FnOnce(&mut Simulator) -> T) -> Result<T, QnError> {
    let mut table = sessions().lock().unwrap_or_else(|e| e.into_inner());
    table.open.get_mut(&session).map(f).ok_or_else(gone)
}

fn sane(until: f64) -> Result<f64, QnError> {
    if until.is_nan() {
        return Err(QnError::invalid("The time to animate to is not a number."));
    }
    Ok(until)
}

pub fn next(session: u32, max_steps: u32, until: f64) -> Result<AnimateChunk, QnError> {
    let until = sane(until)?;
    with(session, |sim| {
        let events = sim.advance((max_steps as usize).clamp(1, MAX_STEPS), until);
        AnimateChunk { time: sim.time(), events: columns(&events), stats: stats(sim.stats()), snapshot: None, stopped: stopped(sim) }
    })
}

pub fn skip(session: u32, until: f64) -> Result<AnimateChunk, QnError> {
    let until = sane(until)?;
    with(session, |sim| {
        sim.skip(MAX_SKIP_STEPS, until);
        AnimateChunk { time: sim.time(), events: AnimateEvents::default(), stats: stats(sim.stats()), snapshot: Some(snapshot(sim)), stopped: stopped(sim) }
    })
}

#[tauri::command(async)]
pub fn animate_start(document: Value, seed: u32) -> Result<AnimateStart, QnError> {
    start(&document, seed)
}

#[tauri::command(async)]
pub fn animate_next(session: u32, max_steps: u32, until: f64) -> Result<AnimateChunk, QnError> {
    next(session, max_steps, until)
}

#[tauri::command(async)]
pub fn animate_skip(session: u32, until: f64) -> Result<AnimateChunk, QnError> {
    skip(session, until)
}

#[tauri::command(async)]
pub fn animate_stop(session: u32) {
    sessions().lock().unwrap_or_else(|e| e.into_inner()).open.remove(&session);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// The tests share the one table of runs, and one of them fills it: they take turns.
    fn turn() -> std::sync::MutexGuard<'static, ()> {
        static TURN: Mutex<()> = Mutex::new(());
        TURN.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn example(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(format!("{name}.bnet"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn fixture_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/animate/fixtures/jackson-feedback.json")
    }

    /// What the interface's tests replay (src/animate/fixtures/jackson-feedback.json): the start
    /// of the Jackson example from seed 7 and its first two chunks, exactly as the commands answer.
    fn fixture() -> Value {
        let started = start(&example("OpenJackson.d2.feedback.p30.inf"), 7).unwrap();
        let first = next(started.session, 150, 1e9).unwrap();
        let second = next(started.session, 20_000, first.time + 40.0).unwrap();
        animate_stop(started.session);
        let mut start_json = serde_json::to_value(&started).unwrap();
        // The session number depends on what else has run in this process.
        start_json["session"] = Value::from(1);
        serde_json::json!({ "start": start_json, "chunks": [first, second] })
    }

    /// The recorded fixture is what the commands answer today. Regenerate it with
    /// `QNET_WRITE_FIXTURES=1 cargo test -p qnet animate` after a deliberate change.
    #[test]
    fn the_interface_fixture_is_what_the_commands_answer() {
        let _turn = turn();
        let now = fixture();
        if std::env::var_os("QNET_WRITE_FIXTURES").is_some() {
            std::fs::create_dir_all(fixture_path().parent().unwrap()).unwrap();
            std::fs::write(fixture_path(), serde_json::to_string(&now).unwrap() + "\n").unwrap();
        }
        let recorded: Value = serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("src/animate/fixtures/jackson-feedback.json")).unwrap();
        assert_eq!(recorded, now);
    }

    /// Ledger WF-508: an unstable network skipped ahead. Its queue grows without limit; what
    /// crosses to the interface stays small, and the run stops at a stated size with a sentence.
    #[test]
    fn an_unstable_network_skipped_ahead_sends_the_head_of_each_queue_and_stops_at_a_million() {
        let _turn = turn();
        let mut doc = example("OpenJackson.d2.feedback.p30.inf");
        for n in doc["nodes"].as_array_mut().unwrap() {
            if n["kind"] == "source" {
                n["distributionParameters"] = Value::from("lambda=40.0");
            }
        }
        let started = start(&doc, 5).unwrap();
        assert_eq!(serde_json::to_value(&started).unwrap()["snapshot"]["waiting"], serde_json::json!([0, 0]));
        // A first skip: tens of thousands waiting, a few hundred named.
        let chunk = skip(started.session, 2_000.0).unwrap();
        let snap = chunk.snapshot.clone().unwrap();
        assert!(chunk.stopped.is_none());
        assert!(snap.waiting[0] > 50_000, "{:?}", snap.waiting);
        assert_eq!(snap.queues[0].len(), SNAPSHOT_HEAD);
        assert!(snap.queues.iter().zip(&snap.waiting).all(|(q, n)| q.len() as u64 == (*n).min(SNAPSHOT_HEAD as u64)));
        assert!(serde_json::to_string(&chunk).unwrap().len() < 40_000, "the answer stays small");
        // The head is the queue's head: the next customers to start are the ones named.
        let played = next(started.session, 1, f64::INFINITY).unwrap();
        if let Some(i) = played.events.k.iter().position(|k| *k == 1) {
            let station = played.events.s[i] as usize;
            assert_eq!(played.events.c[i], snap.queues[station][0].0);
        }
        // Skipped again and again, it stops for good once a million wait, and says so.
        let mut last = chunk;
        for _ in 0..40 {
            last = skip(started.session, last.time + 20_000.0).unwrap();
            if last.stopped.is_some() {
                break;
            }
        }
        assert_eq!(last.stopped.as_deref(), Some("The queue at S1 has passed 1,000,000 customers; the animation has stopped. The network is overloaded there: its queue grows without limit."));
        let snap = last.snapshot.clone().unwrap();
        let total: u64 = snap.waiting.iter().sum();
        assert!((1_000_000..1_000_010).contains(&total), "{total}");
        assert!(serde_json::to_string(&last).unwrap().len() < 40_000);
        // Nothing more happens: no events, no time, the same sentence.
        let after = next(started.session, 1000, f64::INFINITY).unwrap();
        assert_eq!((after.events.t.len(), after.time, after.stopped.clone()), (0, last.time, last.stopped.clone()));
        assert_eq!(skip(started.session, last.time + 1e6).unwrap().time, last.time);
        animate_stop(started.session);
        assert_eq!(grouped(1_000_000), "1,000,000");
        assert_eq!((grouped(999), grouped(1000), grouped(12_345_678)), ("999".into(), "1,000".into(), "12,345,678".into()));
    }

    #[test]
    fn a_run_is_started_played_in_chunks_skipped_and_stopped() {
        let _turn = turn();
        let started = start(&example("OpenJackson.d2.feedback.p30.inf"), 3).unwrap();
        let json = serde_json::to_value(&started).unwrap();
        assert_eq!(json["layout"]["stations"][0]["name"], "S1");
        assert!((json["layout"]["stations"][0]["exactNumber"].as_f64().unwrap() - 7.0 / 3.0).abs() < 1e-9);
        assert!(json["layout"]["stations"][0]["bufferId"].as_str().is_some_and(|s| !s.is_empty()));
        assert_eq!(json["layout"]["population"], Value::Null);
        assert_eq!(json["snapshot"]["queues"], serde_json::json!([[], []]));
        assert_eq!(json["snapshot"]["servers"], serde_json::json!([[null], [null]]));

        let chunk = next(started.session, 100, 50.0).unwrap();
        let n = chunk.events.t.len();
        assert!(n > 0 && [chunk.events.k.len(), chunk.events.c.len(), chunk.events.cls.len(), chunk.events.s.len(), chunk.events.srv.len(), chunk.events.o.len()].iter().all(|l| *l == n));
        assert!(chunk.events.t.windows(2).all(|w| w[0] <= w[1]) && *chunk.events.t.last().unwrap() <= chunk.time);
        assert_eq!(chunk.stats.time, chunk.time);
        assert!(chunk.snapshot.is_none());
        let json = serde_json::to_value(&chunk).unwrap();
        assert!(json.get("snapshot").is_none() && json["stats"]["areaNumber"].is_array());

        // The same seed in a second session gives the same events, whatever the chunking.
        let again = start(&example("OpenJackson.d2.feedback.p30.inf"), 3).unwrap();
        assert_ne!(again.session, started.session);
        let mut t = Vec::new();
        while t.len() < n {
            t.extend(next(again.session, 7, chunk.time).unwrap().events.t);
        }
        assert_eq!(t[..n], chunk.events.t[..]);

        let skipped = skip(started.session, chunk.time + 500.0).unwrap();
        assert_eq!(skipped.time, chunk.time + 500.0);
        assert!(skipped.events.t.is_empty());
        let snap = skipped.snapshot.unwrap();
        assert_eq!((snap.time, snap.queues.len()), (skipped.time, 2));
        assert!(skipped.stats.created > chunk.stats.created);

        animate_stop(started.session);
        animate_stop(again.session);
        assert_eq!(next(started.session, 10, 1e9).unwrap_err().message, "This animation has ended. Restart it.");
        assert!(next(again.session, 10, f64::NAN).is_err());
    }

    #[test]
    fn a_network_that_cannot_be_animated_says_why() {
        let _turn = turn();
        let e = start(&example("MM1K.d1.c1.fin"), 1).unwrap_err();
        assert_eq!(e.message, qnet_core::sim::FINITE_SENTENCE);
        assert_eq!(e.detail.as_deref(), Some("finiteBuffers"));
        let e = start(&serde_json::json!({"nodes": 3}), 1).unwrap_err();
        assert_eq!(e.message, "Qnet couldn't animate the network: it isn't complete.");
        // The refusal names the way forward, by the menu's own words (a new, empty network
        // starts with finite buffers), and the browser preview says the same sentence.
        let sentence = qnet_core::sim::FINITE_SENTENCE;
        assert!(sentence.ends_with("To animate this network, choose Network ▸ Buffer Model ▸ Infinite buffers (a new, empty network starts with finite buffers). To keep finite buffers, use Run ▸ Solve instead."), "{sentence}");
        let read = |file: &str| std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(file)).unwrap();
        let menu = read("src/lib/menuSpec.ts");
        assert!(menu.contains(r#"submenu: "Buffer Model", items: [C("network:finite-buffers", "Finite buffers — capacity and blocking apply"), C("network:infinite-buffers", "Infinite buffers — queues are unbounded")]"#));
        assert!(menu.contains(r#"I("run:solve", "Solve""#));
        assert!(read("src/dev/mock/animate.ts").contains(sentence), "src/dev/mock/animate.ts says another sentence");
    }

    /// Welcome's "Start with a Tandem Line" (src/welcome/starts.ts TANDEM) is a network the
    /// animation plays: infinite buffers, stable.
    #[test]
    fn the_welcome_tandem_line_animates() {
        let _turn = turn();
        let request = crate::archetypes::ArchetypeRequest { kind: "tandemLine".into(), stations: 2, servers: 1, target_rho: 0.8, feedback_probability: 0.3, infinite_buffers: true, buffer_capacity: 10, arrival_rate: 1.0 };
        let built = crate::archetypes::build_with(&request, &mut qnet_core::generate::CountingIds::new()).unwrap();
        let started = start(&serde_json::from_str(&built.text).unwrap(), 1).unwrap();
        assert_eq!(started.layout.stations.len(), 2);
        assert!(started.layout.unstable.is_empty());
        let chunk = next(started.session, 200, f64::INFINITY).unwrap();
        assert!(chunk.events.t.len() >= 200 && chunk.stopped.is_none());
        animate_stop(started.session);
    }

    #[test]
    fn old_runs_are_dropped_when_too_many_are_open() {
        let _turn = turn();
        let doc = example("OpenJackson.d2.feedback.p30.inf");
        let first = start(&doc, 1).unwrap().session;
        let later: Vec<u32> = (0..MAX_SESSIONS + 2).map(|_| start(&doc, 1).unwrap().session).collect();
        assert!(next(first, 1, 1.0).is_err(), "the oldest run was dropped");
        assert!(next(*later.last().unwrap(), 1, 1.0).is_ok());
        assert!(sessions().lock().unwrap().open.len() <= MAX_SESSIONS);
        later.into_iter().for_each(animate_stop);
    }
}
