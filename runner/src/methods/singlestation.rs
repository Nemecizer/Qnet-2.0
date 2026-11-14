//! Exact Priority Queue (`priority_exact`) and Exact Batch-Arrival Queue (`batch_exact`): the two
//! exact methods for the model features new in 2.1 (ledger SCI-1006, SCI-1013).
//!
//! Like Exact Closed Product Form they start no solver process: the answer is
//! `qnet_core::priority` (Cobham; Kleinrock; Kella & Yechiali; Buzen & Bondi) or
//! `qnet_core::batch` (the M^X/G/1 mean-value formula), computed in the run's own job, so it goes
//! through the same registry, Shell text, archive and result parser as any run. Each is offered
//! only where it is exact — one station fed directly by Poisson sources — and says in a sentence
//! why any other network is not for it. 0.90.34 had neither feature.
//!
//! This file also words the refusal of every method that reads a network the classical way on a
//! network that uses one of the new features (the sentence is core's, `extended::refusal`).

use qnet_core::batch::{self, BatchModel};
use qnet_core::cfmt;
use qnet_core::extended;
use qnet_core::model::{BatchSize, Discipline};
use qnet_core::priority::{self, PriorityModel};
use qnet_core::traffic::class_label;

use crate::supervisor::Job;

use super::{Method, Prepared, PreparedRun, RunContext, StatusLine};

/// What a method that models none of the new features says of a network that uses one, or None.
pub(crate) fn refuse_classical_method(method: Method, ctx: &RunContext) -> Option<Prepared> {
    let name = crate::supervisor::display_label(method.label());
    extended::refusal(&ctx.network, &name).map(|sentence| Prepared::Refused(vec![StatusLine::warning(format!("{name} not started: {sentence}"))]))
}

fn g(x: f64) -> String {
    cfmt::f("%.12g", x)
}

fn launch(method: Method, parameters: Vec<(&str, String)>, accepted: &str, text: String) -> Prepared {
    let mut parameters: Vec<(&str, String)> = parameters;
    parameters.push(("runtime", "in process (qnet-core)".to_string()));
    Prepared::Launch(PreparedRun {
        method,
        parameters: parameters.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        seed: None,
        replication_seeds: Vec::new(),
        before: Vec::new(),
        accepted: vec![StatusLine::info(accepted)],
        temps: crate::supervisor::TempFiles::new(),
        body: Box::new(move |job: &mut Job| {
            job.emit_str(&text);
            job.emit_elapsed_footer();
            0
        }),
    })
}

pub(crate) fn prepare_priority(ctx: &RunContext) -> Prepared {
    let model = match priority::from_network(&ctx.network) {
        Ok(m) => m,
        Err(e) => return Prepared::Refused(vec![StatusLine::warning(format!("Exact Priority Queue not started: {e}"))]),
    };
    let text = match priority_report(&ctx.title, &model) {
        Ok(t) => t,
        Err(e) => return Prepared::Refused(vec![StatusLine::warning(format!("Exact Priority Queue not started: {e}"))]),
    };
    let order: Vec<String> = model.classes.iter().map(|c| class_label(c.class as i64)).collect();
    launch(
        Method::PriorityExact,
        vec![("model", "single station with priority service, Poisson arrivals".to_string()), ("discipline", model.discipline.display_name().to_string()), ("servers", model.servers.to_string()), ("priority order", order.join(" > "))],
        "Running exact priority queue (closed-form mean values).",
        text,
    )
}

/// The run's text. The "Exact station" row is what the result parser reads
/// (core/src/results/parser.rs `closed_station_row`); the class table is for the reader.
pub fn priority_report(title: &str, model: &PriorityModel) -> Result<String, String> {
    let s = priority::solve(model)?;
    let mut out = String::new();
    out.push_str("Exact priority queue (single station, Poisson arrivals)\n");
    out.push_str(&format!("Model: {title}\n"));
    out.push_str(&format!("Station: {}  servers: {}  discipline: {}\n", model.station_name, model.servers, model.discipline.display_name().to_lowercase()));
    out.push_str(&format!("Formula: {}\n", s.formula));
    out.push_str(&format!("Priority order (highest first): {}\n", model.classes.iter().map(|c| class_label(c.class as i64)).collect::<Vec<_>>().join(" > ")));
    out.push_str(&format!("Exact station s1 ({}): visits=1  X={}  E[N]={}  E[Q]={}  util={}  W={}  T={}\n", model.station_name, g(s.throughput), g(s.number), g(s.queue), g(s.utilisation), g(s.wait), g(s.sojourn)));
    let waits = if model.discipline == Discipline::PreemptiveResume { "time not in service (waiting and interrupted)" } else { "wait before service" };
    out.push_str(&format!("\nPer class, in priority order (W = {waits}, T = time at the station)\n"));
    let head = ["Class", "Arrival rate", "Load", "W", "T", "Mean number", "Mean not in service"];
    let rows: Vec<[String; 7]> = s.classes.iter().map(|c| [class_label(c.class as i64), cfmt::f("%.6f", c.lambda), cfmt::f("%.6f", c.load), cfmt::f("%.6f", c.wait), cfmt::f("%.6f", c.sojourn), cfmt::f("%.6f", c.number), cfmt::f("%.6f", c.queue)]).collect();
    out.push_str(&table(&head, &rows));
    for c in &s.classes {
        out.push_str(&format!("QNET_CLASS_V1 node_id=s1 class={} arrival_rate={} wait={} sojourn={} mean_number={} mean_queue={}\n", c.class + 1, g(c.lambda), g(c.wait), g(c.sojourn), g(c.number), g(c.queue)));
    }
    out.push_str("\nScope: exact for this one station. The departures of a priority queue are not Poisson class by class, so these formulas say nothing about a station downstream.\n");
    Ok(out)
}

pub(crate) fn prepare_batch(ctx: &RunContext) -> Prepared {
    let model = match batch::from_network(&ctx.network) {
        Ok(m) => m,
        Err(e) => return Prepared::Refused(vec![StatusLine::warning(format!("Exact Batch-Arrival Queue not started: {e}"))]),
    };
    let text = match batch_report(&ctx.title, &model) {
        Ok(t) => t,
        Err(e) => return Prepared::Refused(vec![StatusLine::warning(format!("Exact Batch-Arrival Queue not started: {e}"))]),
    };
    launch(
        Method::BatchExact,
        vec![("model", "M^X/G/1: batch Poisson arrivals, one server".to_string()), ("batch size", batch_words(&model.batch)), ("mean batch size", g(model.batch.mean()))],
        "Running exact batch-arrival queue (closed-form mean values).",
        text,
    )
}

fn batch_words(b: &BatchSize) -> String {
    match b {
        BatchSize::Constant(k) => format!("constant {k}"),
        BatchSize::Geometric { mean } => format!("geometric, mean {}", g(*mean)),
        BatchSize::Pmf(p) => format!("given probabilities for sizes 1 to {}", p.len()),
    }
}

/// The run's text; the "Exact station" row is what the result parser reads.
pub fn batch_report(title: &str, model: &BatchModel) -> Result<String, String> {
    let s = batch::solve(model)?;
    let mut out = String::new();
    out.push_str("Exact batch-arrival queue (M^X/G/1, mean values)\n");
    out.push_str(&format!("Model: {title}\n"));
    out.push_str(&format!("Station: {}  source: {}\n", model.station_name, model.source_name));
    out.push_str(&format!("Batches: rate={} per time unit  size: {}  E[X]={}  E[X^2]={}\n", g(model.batch_rate), batch_words(&model.batch), g(model.batch.mean()), g(model.batch.second_moment())));
    out.push_str(&format!("Service: E[S]={}  E[S^2]={}\n", g(model.mean), g(model.second)));
    out.push_str("Formula: Wq = lambda E[X] E[S^2] / (2(1-rho)) + E[X(X-1)] E[S] / (2 E[X] (1-rho)), rho = lambda E[X] E[S] (Chaudhry & Templeton 1983; Gross et al., Fundamentals of Queueing Theory, ch. 3)\n");
    out.push_str(&format!("Exact station s1 ({}): visits=1  X={}  E[N]={}  E[Q]={}  util={}  W={}  T={}\n", model.station_name, g(s.throughput), g(s.number), g(s.queue), g(s.utilisation), g(s.wait), g(s.sojourn)));
    out.push_str(&format!("Of the wait before service: until the customer's batch reaches the server={}  behind others of its own batch={}\n", g(s.wait_for_batch), g(s.wait_within_batch)));
    out.push_str("\nScope: exact for this one single-server station. Batches that leave a station are not a batch Poisson process, so the formula says nothing about a station downstream.\n");
    Ok(out)
}

fn table<const N: usize>(head: &[&str; N], rows: &[[String; N]]) -> String {
    let width: Vec<usize> = (0..N).map(|c| rows.iter().map(|r| r[c].chars().count()).chain([head[c].len()]).max().unwrap_or(0)).collect();
    let line = |cells: &[String]| -> String {
        let padded: Vec<String> = cells.iter().enumerate().map(|(c, t)| format!("{t}{}", " ".repeat(width[c] - t.chars().count()))).collect();
        format!("  {}\n", padded.join("  ").trim_end())
    };
    let mut out = line(&head.map(String::from));
    for r in rows {
        out.push_str(&line(r));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example(name: &str) -> qnet_core::model::Network {
        let text = std::fs::read_to_string(format!("{}/../examples/extended/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
        qnet_core::bnet::read(&text).unwrap()
    }

    /// The bundled examples run, and each report carries the one row the parser reads
    /// (core/src/results/harness.rs `an_exact_station_row…` reads such a row back) with the
    /// solution's numbers to twelve digits.
    #[test]
    fn the_bundled_examples_report_their_exact_station_row() {
        let net = example("PriorityHelpDesk.mg1.2class.bnet");
        let model = priority::from_network(&net).unwrap();
        let exact = priority::solve(&model).unwrap();
        let text = priority_report("t", &model).unwrap();
        assert!(text.contains("Formula: M/G/1 preemptive-resume priority"), "{text}");
        assert_eq!(text.lines().filter(|l| l.starts_with("QNET_CLASS_V1 ")).count(), 2);
        assert!(text.contains(&format!("Exact station s1 ({}): visits=1  X={}  E[N]={}  E[Q]={}", model.station_name, g(exact.throughput), g(exact.number), g(exact.queue))), "{text}");

        let net = example("BatchArrivals.mx-m-1.geometric.bnet");
        let model = batch::from_network(&net).unwrap();
        let exact = batch::solve(&model).unwrap();
        let text = batch_report("t", &model).unwrap();
        assert!(text.contains(&format!("  util={}  W={}  T={}\n", g(exact.utilisation), g(exact.wait), g(exact.sojourn))), "{text}");
    }

    /// The time-varying example is refused by both, each in its own sentence.
    #[test]
    fn a_network_outside_the_scope_is_refused_in_a_sentence() {
        let net = example("RushHour.mt-m-2.daily.bnet");
        assert!(priority::from_network(&net).unwrap_err().starts_with("No station of this network has priority service"));
        assert!(batch::from_network(&net).unwrap_err().starts_with("No source of this network has batch arrivals"));
    }
}
