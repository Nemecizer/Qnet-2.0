//! Exact Closed Product Form (`closed_pf`; new in 2.1, ROADMAP D3, ledger SCI-506): the one method
//! for a closed network (no source, no sink, a fixed population).
//!
//! Unlike every other method this one starts no solver process: the answer is
//! `qnet_core::closed` (Buzen's convolution, cross-checked against exact MVA where MVA applies),
//! computed in the run's own job, so it goes through the same registry, Shell text, archive and
//! result parser as any run and its record appears in Results like the others. 0.90.34 had no
//! closed networks; nothing here reproduces it.
//!
//! This file also words the refusal of every other method on a closed network, and of this one on
//! an open network.

use qnet_core::cfmt;
use qnet_core::closed::{self, ClosedModel, ClosedSolution};

use crate::supervisor::Job;

use super::{Method, Prepared, PreparedRun, RunContext, StatusLine};

/// What every other method says of a closed network.
pub(crate) fn refuse_open_method(method: Method) -> Prepared {
    Prepared::Refused(vec![StatusLine::warning(format!(
        "{} not started: this is a closed network (no source and no sink), and this method needs arrivals from a source. Use Exact Closed Product Form, which is exact for it, or Replicated Simulation for a second opinion.",
        crate::supervisor::display_label(method.label())
    ))])
}

pub(crate) fn prepare(ctx: &RunContext) -> Prepared {
    if let Some(p) = qnet_core::extended::problems(&ctx.network).into_iter().next() {
        return Prepared::Refused(vec![StatusLine::warning(format!("Exact closed product form not started: {}", p.message))]);
    }
    let model = match closed::from_network(&ctx.network) {
        Ok(m) => m,
        Err(e) => return Prepared::Refused(vec![StatusLine::warning(format!("Exact closed product form not started: {}", e.message()))]),
    };
    let title = ctx.title.clone();
    let parameters = [
        ("model", "exact closed Gordon–Newell network".to_string()),
        ("local queues", "M/M/c".to_string()),
        ("population", model.population.to_string()),
        ("reference station", model.names[0].clone()),
        ("algorithm", if closed::mva_applies(&model) { "Buzen convolution, cross-checked by exact MVA" } else { "Buzen convolution" }.to_string()),
        ("runtime", "in process (qnet-core)".to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    Prepared::Launch(PreparedRun {
        method: Method::ClosedProductForm,
        parameters,
        seed: None,
        replication_seeds: Vec::new(),
        before: Vec::new(),
        accepted: vec![StatusLine::info("Running exact closed product form (Buzen's convolution algorithm).")],
        temps: crate::supervisor::TempFiles::new(),
        body: Box::new(move |job: &mut Job| {
            let code = match closed::solve(&model) {
                Ok((solution, gap)) => {
                    job.emit_str(&report(&title, &model, &solution, gap));
                    0
                }
                Err(e) => {
                    job.emit_str(&format!("error: {}\n", e.message()));
                    2
                }
            };
            job.emit_elapsed_footer();
            code
        }),
    })
}

fn g(x: f64) -> String {
    cfmt::f("%.12g", x)
}

/// How many values of each marginal distribution are printed.
const MARGINAL_COLUMNS: usize = 21;

/// The run's text. The "Closed station" rows are what the result parser reads
/// (core/src/results/parser.rs `closed_station_row`); the rest is for the reader.
pub fn report(title: &str, model: &ClosedModel, s: &ClosedSolution, mva_gap: Option<f64>) -> String {
    let n = model.population;
    let mut out = String::new();
    out.push_str("Exact closed product-form analysis (Gordon-Newell)\n");
    out.push_str(&format!("Model: {title}\n"));
    out.push_str(&format!("Population: N={n}  reference station: {} (visit ratio 1)\n", model.names[0]));
    match mva_gap {
        Some(gap) => out.push_str(&format!("Method: Buzen convolution; exact MVA agrees to {}\n", cfmt::f("%.3e", gap))),
        None => out.push_str("Method: Buzen convolution (exact MVA is not used: a station has several servers)\n"),
    }
    out.push_str(&format!("Normalising constant: ln G(N)={}\n", g(s.ln_g)));
    out.push_str(&format!("Network: throughput at {r} (visits per time unit)={}  cycle time between visits to {r} (N/X)={}\n", g(s.throughput), g(s.cycle_time(n)), r = model.names[0]));
    for i in 0..model.names.len() {
        out.push_str(&format!(
            "Closed station s{} ({}): visits={}  X={}  E[N]={}  E[Q]={}  util={}  W={}  T={}\n",
            i + 1,
            model.names[i],
            g(s.visits[i]),
            g(s.station_throughput[i]),
            g(s.number[i]),
            g(s.queue[i]),
            g(s.utilisation[i].unwrap_or(0.0)),
            g(s.queue[i] / s.station_throughput[i]),
            g(s.residence[i]),
        ));
    }
    if !s.marginals.is_empty() {
        let shown = (n + 1).min(MARGINAL_COLUMNS);
        out.push_str(&format!("Marginal distributions P(n customers at the station), n = 0..{}{}\n", shown - 1, if shown <= n { " (the rest not shown)" } else { "" }));
        for i in 0..model.names.len() {
            let row: Vec<String> = s.marginals[i][..shown].iter().map(|p| cfmt::f("%.6f", *p)).collect();
            out.push_str(&format!("  {} | {}\n", model.names[i], row.join(" ")));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bundled central-server example has a self-loop at the reference station (p11 = 0.1):
    /// X counts every pass through S1 and N/X is the time between a customer's successive visits
    /// to it. The run's text says exactly that, and never calls N/X a delay or a response time.
    #[test]
    fn the_report_names_the_throughput_and_the_cycle_time_for_what_they_are() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../examples/closed/ClosedCentralServer.d3.N8.bnet")).unwrap();
        let model = closed::from_network(&qnet_core::bnet::read(&text).unwrap()).unwrap();
        assert!(model.p[0][0] > 0.0, "the example's self-loop");
        let s = closed::convolution(&model).unwrap();
        let out = report("t", &model, &s, None);
        let line = out.lines().find(|l| l.starts_with("Network:")).unwrap();
        assert!(line.starts_with("Network: throughput at S1 (visits per time unit)=") && line.contains("  cycle time between visits to S1 (N/X)="), "{line}");
        assert!(!out.to_lowercase().contains("delay") && !out.to_lowercase().contains("response"));
    }
}
