//! Replicated Simulation (`sim_inproc`; new in 2.1, ledger SIM-105): a steady-state simulation
//! with confidence intervals computed inside Qnet, by `qnet_core::simstat` on the discrete-event
//! simulator of `qnet_core::sim` (the one the canvas animation plays).
//!
//! Like Exact Closed Product Form it starts no solver process: the estimate is computed in the
//! run's own job (on the machine's cores), so it goes through the same registry, Shell text,
//! archive and result parser as any run, shows progress in the status bar and stops on Stop.
//! It is the second, independent opinion for a closed network (whose only other method is the
//! exact one), and a simulation for the open infinite-buffer networks the external simulators
//! cannot take. It refuses what the simulator would not model faithfully (finite buffers) and
//! what has no steady state (utilisation ≥ 1). 0.90.34 had nothing like it.
//!
//! What the run's parameter sheet answers arrives under `siminproc.*` keys (`RunSettings::sheet`);
//! the seed pair is the simulators' own (`sim.seedFixed`, `sim.seed`).

use std::io::Write;

use qnet_core::cfmt;
use qnet_core::simstat::{self, Estimate, Failure, Options, Outcome, Stopped, WarmUp};

use crate::supervisor::{Job, Severity, CANCELLED_EXIT_CODE};

use super::{Method, Prepared, PreparedRun, RunContext, RunSettings, StatusLine};

const NAME: &str = "Replicated Simulation";

/// The sheet's keys (src/runs/ui/specs.ts `replicatedSimulation`).
pub const KEYS: [&str; 8] = ["siminproc.replications", "siminproc.completions", "siminproc.warmup", "siminproc.warmupFraction", "siminproc.confidence", "siminproc.precision", "siminproc.maximumReplications", "siminproc.maximumWallSeconds"];

/// The estimator's options from what the sheet answered, over the defaults.
/// `siminproc.warmup` is 0 for MSER on 200 batch means and 1 for the fixed fraction `siminproc.warmupFraction`;
/// `siminproc.confidence` is a level (0.9, 0.95, 0.99) or the sheet's index of one (0, 1, 2);
/// `siminproc.precision` is the target relative half-width, 0 for a fixed number of replications.
pub(crate) fn options(s: &RunSettings, seed: u64) -> Options {
    let d = Options::default();
    let level = match s.sheet_f64("siminproc.confidence") {
        Some(x) if x == 0.0 => 0.90,
        Some(x) if x == 1.0 => 0.95,
        Some(x) if x == 2.0 => 0.99,
        Some(x) => x,
        None => d.level,
    };
    let fraction = s.sheet_f64("siminproc.warmupFraction").unwrap_or(simstat::DEFAULT_FRACTION);
    Options {
        replications: s.sheet_i64("siminproc.replications").map(|n| n.max(0) as usize).unwrap_or(d.replications),
        completions: s.sheet_i64("siminproc.completions").map(|n| n.max(0) as u64).unwrap_or(d.completions),
        warm_up: if s.sheet_i64("siminproc.warmup") == Some(1) { WarmUp::Fraction(fraction) } else { WarmUp::Mser },
        seed,
        level,
        target: s.sheet_f64("siminproc.precision").filter(|g| *g > 0.0),
        max_replications: s.sheet_i64("siminproc.maximumReplications").map(|n| n.max(2) as usize).unwrap_or(1_000),
        max_events: d.max_events,
        max_seconds: s.sheet_i64("siminproc.maximumWallSeconds").map(|n| n.max(1) as f64).unwrap_or(d.max_seconds),
        threads: 0,
    }
}

fn refused(sentence: &str) -> Prepared {
    Prepared::Refused(vec![StatusLine::warning(format!("{NAME} not started: {sentence}"))])
}

pub(crate) fn prepare(ctx: &RunContext) -> Prepared {
    let plan = match simstat::plan(&ctx.network) {
        Ok(p) => p,
        Err(r) => return refused(&r.message),
    };
    let s = &ctx.settings;
    let seed: u64 = if s.sim_seed_fixed { s.sim_seed.max(0) as u64 } else { ctx.random_in(1, i32::MAX as u64) };
    let opts = options(s, seed);
    let warm_up = match opts.warm_up {
        WarmUp::Mser => "MSER on 200 batch means".to_string(),
        WarmUp::Fraction(f) => format!("fixed fraction {}", g(f)),
    };
    let first = if opts.target.is_some() { opts.replications.max(simstat::MIN_SEQUENTIAL_REPLICATIONS) } else { opts.replications };
    let parameters = [
        ("model", if plan.population.is_some() { "closed queueing network, simulated" } else { "open queueing network, simulated" }.to_string()),
        ("estimator", "independent replications, Student t interval".to_string()),
        ("replications", first.to_string()),
        ("completions per replication", opts.completions.to_string()),
        ("warm-up", warm_up),
        ("confidence", g(opts.level)),
        ("precision target", opts.target.map(g).unwrap_or_else(|| "none".into())),
        ("seed", seed.to_string()),
        ("runtime", "in process (qnet-core)".to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let title = ctx.title.clone();
    let network = ctx.network.clone();
    Prepared::Launch(PreparedRun {
        method: Method::InProcessSimulation,
        parameters,
        seed: Some(seed),
        replication_seeds: (0..first).map(|r| simstat::replication_seed(seed, r)).collect(),
        before: Vec::new(),
        accepted: vec![StatusLine::info(format!("Running replicated simulation ({first} independent replications, seed {seed})."))],
        temps: crate::supervisor::TempFiles::new(),
        body: Box::new(move |job: &mut Job| {
            // Progress the way the simulators report it: a total, then a dot per unit done.
            let path = job.progress_file("sim_inproc");
            let mut file = std::fs::File::create(&path).ok();
            if let Some(f) = file.as_mut() {
                let _ = f.write_all(b"100\n");
            }
            let mut dots = 0usize;
            let token = job.cancel_token().clone();
            let result = simstat::estimate(&network, &opts, &mut |fraction| {
                let want = (fraction * 100.0).floor() as usize;
                if want > dots {
                    if let Some(f) = file.as_mut() {
                        let _ = f.write_all(&vec![b'.'; want - dots]);
                        let _ = f.flush();
                    }
                    dots = want;
                }
                !token.is_cancelled()
            });
            match result {
                Ok(outcome) => {
                    if outcome.warm_up_inconclusive {
                        job.status(format!("{NAME}: the runs are too short for MSER on 200 batch means to find the end of the warm-up; half of each was deleted. Lengthen the replications."), Severity::Warning);
                    }
                    if outcome.stopped == Stopped::MaxSeconds {
                        job.status(format!("{NAME} stopped on the cap on wall time after {} replications. That count depends on this machine's speed, so the seed alone does not reproduce the result.", outcome.replications), Severity::Warning);
                    }
                    if !matches!(outcome.stopped, Stopped::Fixed | Stopped::TargetMet) {
                        job.status(format!("{NAME} stopped before the precision target was met ({}).", stopped_words(outcome.stopped)), Severity::Warning);
                    }
                    job.emit_str(&report(&title, &opts, &outcome));
                    job.emit_elapsed_footer();
                    0
                }
                Err(Failure::Stopped) => CANCELLED_EXIT_CODE,
                Err(e) => {
                    job.emit_str(&format!("error: {}\n", e.message()));
                    job.emit_elapsed_footer();
                    2
                }
            }
        }),
    })
}

/// The line the run's text carries when it stopped on the wall-time cap (the result parser
/// reads its first words, [`qnet_core::results::parser`]).
pub fn time_cap_sentence(replications: usize) -> String {
    format!("Reproducibility: not by the seed alone. The run stopped on the cap on wall time, after {replications} replications; how many replications fit in the time depends on the machine's speed. On another machine, or on this one when it is busy, the same seed can give another count and so other estimates. Each replication is still the one its seed gives.")
}

fn g(x: f64) -> String {
    cfmt::f("%.12g", x)
}

fn stopped_words(s: Stopped) -> &'static str {
    match s {
        Stopped::Fixed => "the stated number of replications",
        Stopped::TargetMet => "precision target met",
        Stopped::MaxReplications => "the cap on replications",
        Stopped::MaxEvents => "the cap on events",
        Stopped::MaxSeconds => "the cap on wall time",
    }
}

/// The run's text. The `QNET_SIM_METRIC_V1` and `QNET_SIM_STATUS_V1` rows are what the result
/// parser reads (core/src/results/parser.rs); the table is for the reader.
pub fn report(title: &str, opts: &Options, o: &Outcome) -> String {
    let mut out = String::new();
    let percent = cfmt::f("%.0f", o.level * 100.0);
    out.push_str("Replicated simulation (independent replications, in process)\n");
    out.push_str(&format!("Model: {title}\n"));
    match o.population {
        Some(n) => out.push_str(&format!("Network: closed, N={n}, {} stations\n", o.stations.len())),
        None => out.push_str(&format!("Network: open, infinite buffers, {} stations\n", o.stations.len())),
    }
    out.push_str(&format!("Replications: {}  completions per replication: {}  model time per replication: {}\n", o.replications, opts.completions, g(o.run_time)));
    let share = cfmt::f("%.1f", 100.0 * o.warm_up_time / o.run_time);
    match opts.warm_up {
        WarmUp::Mser if o.warm_up_inconclusive => out.push_str(&format!("Warm-up: MSER on 200 batch means was inconclusive (the runs are too short); deleted {share} % of each replication ({} time units)\n", g(o.warm_up_time))),
        WarmUp::Mser => out.push_str(&format!("Warm-up: MSER on 200 batch means deleted {share} % of each replication ({} time units)\n", g(o.warm_up_time))),
        WarmUp::Fraction(_) => out.push_str(&format!("Warm-up: fixed fraction, deleted {share} % of each replication ({} time units)\n", g(o.warm_up_time))),
    }
    out.push_str(&format!("Intervals: {percent} % Student t across replications ({} degrees of freedom, t={})\n", o.replications - 1, cfmt::f("%.4f", o.t)));
    out.push_str(&format!("Seed: {}  events simulated: {}\n", opts.seed, o.events));
    if let (Some(target), Some(reached)) = (opts.target, o.relative_half_width) {
        out.push_str(&format!("Precision: target relative half-width {} on every mean number; reached {} ({})\n", g(target), cfmt::f("%.4g", reached), stopped_words(o.stopped)));
    }
    // The wall-time cap ends the run after however many replications this machine finished in
    // the time, so the same seed gives another count (and another answer) on another machine.
    if o.stopped == Stopped::MaxSeconds {
        out.push_str(&format!("{}\n", time_cap_sentence(o.replications)));
    }
    let met = match o.stopped {
        Stopped::Fixed => "na",
        Stopped::TargetMet => "yes",
        _ => "no",
    };
    out.push_str(&format!("QNET_SIM_STATUS_V1 replications={} target_met={met} warmup_inconclusive={}\n", o.replications, if o.warm_up_inconclusive { "yes" } else { "no" }));
    let mut row = |index: usize, metric: &str, e: &Estimate| {
        out.push_str(&format!(
            "QNET_SIM_METRIC_V1 node_id=s{} metric={metric} estimate={} standard_error={} ci_confidence={} ci_low={} ci_high={} replications={}\n",
            index + 1,
            g(e.mean),
            g(e.standard_error),
            g(o.level),
            g(e.low),
            g(e.high),
            o.replications
        ));
    };
    for (i, s) in o.stations.iter().enumerate() {
        row(i, "throughput", &s.throughput);
        row(i, "mean_number", &s.number);
        row(i, "mean_queue", &s.queue);
        row(i, "utilization", &s.utilisation);
        if let Some(w) = &s.waiting {
            row(i, "mean_waiting_time", w);
        }
        if let Some(w) = &s.sojourn {
            row(i, "mean_sojourn_time", w);
        }
    }
    out.push_str(&format!("\nEstimate ± half-width of the {percent} % interval\n"));
    let cell = |e: &Estimate| format!("{} ± {}", cfmt::f("%.6g", e.mean), cfmt::f("%.2g", e.half_width()));
    let dash = || "—".to_string();
    let rows: Vec<[String; 7]> = o
        .stations
        .iter()
        .map(|s| [s.name.clone(), cell(&s.throughput), cell(&s.number), cell(&s.queue), cell(&s.utilisation), s.waiting.as_ref().map(cell).unwrap_or_else(dash), s.sojourn.as_ref().map(cell).unwrap_or_else(dash)])
        .collect();
    let head = ["Station", "Throughput", "Mean number", "Mean queue", "Utilisation", "Waiting time", "Sojourn time"];
    let width: Vec<usize> = (0..7).map(|c| rows.iter().map(|r| r[c].chars().count()).chain([head[c].len()]).max().unwrap_or(0)).collect();
    let line = |cells: &[String]| -> String {
        let padded: Vec<String> = cells.iter().enumerate().map(|(c, t)| format!("{t}{}", " ".repeat(width[c] - t.chars().count()))).collect();
        format!("  {}\n", padded.join("  ").trim_end())
    };
    out.push_str(&line(&head.map(String::from)));
    for r in &rows {
        out.push_str(&line(r));
    }
    // New in 2.1: where a station serves several classes (priorities), each class's own numbers.
    if o.stations.iter().any(|s| s.classes.len() > 1) {
        out.push_str(&format!("\nPer class: estimate ± half-width of the {percent} % interval\n"));
        let head = ["Station", "Class", "Throughput", "Mean number", "Time at station"];
        let rows: Vec<[String; 5]> = o.stations.iter().flat_map(|s| s.classes.iter().map(|c| [s.name.clone(), format!("Class {}", c.class + 1), cell(&c.throughput), cell(&c.number), c.sojourn.as_ref().map(cell).unwrap_or_else(dash)])).collect();
        let width: Vec<usize> = (0..5).map(|c| rows.iter().map(|r| r[c].chars().count()).chain([head[c].len()]).max().unwrap_or(0)).collect();
        let line = |cells: &[String]| -> String {
            let padded: Vec<String> = cells.iter().enumerate().map(|(c, t)| format!("{t}{}", " ".repeat(width[c] - t.chars().count()))).collect();
            format!("  {}\n", padded.join("  ").trim_end())
        };
        out.push_str(&line(&head.map(String::from)));
        for r in &rows {
            out.push_str(&line(r));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review finding FIX-205: a run that stops on the wall-time cap has a replication count
    /// that depends on the machine, so its text and its record say that the seed alone does not
    /// reproduce it; a run that ends any other way is reproducible and says nothing.
    #[test]
    fn a_run_stopped_on_the_time_cap_says_it_is_not_reproducible_by_seed_alone() {
        let net = qnet_core::bnet::read(&std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/closed/ClosedCentralServer.d3.N8.bnet")).unwrap()).unwrap();
        let base = Options { replications: 10, completions: 5_000, threads: 2, ..Options::default() };
        let capped_opts = Options { target: Some(1e-6), max_seconds: 0.0, ..base.clone() };
        let capped = simstat::estimate(&net, &capped_opts, &mut |_| true).unwrap();
        assert_eq!(capped.stopped, Stopped::MaxSeconds);
        let text = report("t", &capped_opts, &capped);
        assert!(text.contains("\nReproducibility: not by the seed alone. The run stopped on the cap on wall time, after 10 replications; "), "{text}");

        for opts in [base.clone(), Options { target: Some(1e-6), max_replications: 12, ..base }] {
            let o = simstat::estimate(&net, &opts, &mut |_| true).unwrap();
            assert_ne!(o.stopped, Stopped::MaxSeconds);
            let text = report("t", &opts, &o);
            assert!(!text.contains("Reproducibility"), "{text}");
        }
    }

    #[test]
    fn the_sheet_answers_become_the_estimators_options() {
        let mut s = RunSettings::default();
        assert_eq!(options(&s, 7), Options { seed: 7, max_replications: 1_000, ..Options::default() });
        for (k, v) in [("siminproc.replications", "12"), ("siminproc.completions", "5000"), ("siminproc.warmup", "1"), ("siminproc.warmupFraction", "0.25"), ("siminproc.confidence", "2"), ("siminproc.precision", "0.02"), ("siminproc.maximumReplications", "40"), ("siminproc.maximumWallSeconds", "9")] {
            s.set(k, v).unwrap();
        }
        let o = options(&s, 7);
        assert_eq!((o.replications, o.completions, o.warm_up, o.level, o.target, o.max_replications, o.max_seconds), (12, 5000, WarmUp::Fraction(0.25), 0.99, Some(0.02), 40, 9.0));
        s.set("siminproc.confidence", "0.9").unwrap();
        s.set("siminproc.precision", "0").unwrap();
        let o = options(&s, 7);
        assert_eq!((o.level, o.target), (0.9, None));
        assert!(s.set("siminproc.nothing", "1").is_err() && s.set("siminproc.replications", "many").is_err());
    }
}
