//! `qnet dump-rho`: 0.90.34's `Qnet --dump-rho` report, line for line.
//!
//! It prints the station model the analysis works from: dimension, classes, each station's
//! throughput, effective service rate, capacity and load, each class's throughputs and rates, the
//! aggregated routing matrix, whether routing has cycles, the SRBM existence verdict and the
//! closed-form tractability assessment with and without the GCDG cases. Without a screen, this is
//! how a network's analysis is checked.

use crate::cfmt::f;
use crate::model::Network;
use crate::extended::ReportModel;
use crate::traffic::SrbmData;
use crate::{existence, tractability};

/// The report's first part: everything that comes from the traffic equations alone.
pub fn station_model(net: &Network, data: &SrbmData) -> String {
    let mut out = String::new();
    out.push_str(&format!("d={}, K={}, infiniteBuffers={}\n", data.d, data.k, net.infinite_buffers));
    for i in 0..data.d {
        out.push_str(&format!(
            "S{}: α={}  μ_eff={}  c={}  ρ={}\n",
            i + 1,
            f("%.6f", data.alpha[i]),
            f("%.6f", data.service_rates[i]),
            f("%.6f", data.capacity[i]),
            f("%.6f", data.rho(i))
        ));
    }
    for k in 0..data.k {
        let mut line = format!("class {}: α=[", k + 1);
        for i in 0..data.d {
            line += &f("%.4f ", data.alpha_per_class[k][i]);
        }
        line += "]  μ=[";
        for i in 0..data.d {
            line += &f("%.4f ", data.class_service_rates[k][i]);
        }
        line += &f("]  λ_ext=%.4f", data.class_external_arrivals[k]);
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(&format!("aggregatedP ({}×{}):\n", data.d, data.d));
    for i in 0..data.d {
        let mut row = format!("  S{}: ", i + 1);
        for j in 0..data.d {
            row += &f("%.4f ", data.aggregated_p[i][j]);
        }
        out.push_str(&row);
        out.push('\n');
    }
    out
}

/// The report's second part: routing cycles, the SRBM verdict and the tractability assessments.
pub fn analysis_lines(net: &Network, data: &SrbmData) -> String {
    let mut out = format!("hasRoutingCycles = {}\n", tractability::has_routing_cycles(&data.aggregated_p));
    if let Some(v) = existence::srbm_existence(data, net.infinite_buffers) {
        out += &format!("SRBM existence: {} — {}\n", v.existence.outcome.raw(), v.existence.statement);
        if let Some(r) = &v.recurrence {
            out += &format!("SRBM recurrence: {} — {}\n", r.outcome.raw(), r.statement);
        }
    }
    let with = tractability::assess(data, &net.nodes, net.infinite_buffers, true);
    out += &format!("AnalyticalTractability.assess(allowGCDG=true)  → kind={}, isTractable={}, detail='{}'\n", with.kind.case_name(), with.is_tractable(), with.detail);
    if !with.means.is_empty() {
        let m: Vec<String> = with.means.iter().enumerate().map(|(i, v)| format!("S{}={}", i + 1, f("%.4f", *v))).collect();
        out += &format!("  means({}): {}\n", with.means_label, m.join(" "));
    }
    let without = tractability::assess(data, &net.nodes, net.infinite_buffers, false);
    out += &format!("AnalyticalTractability.assess(allowGCDG=false) → kind={}, isTractable={}, detail='{}'\n", without.kind.case_name(), without.is_tractable(), without.detail);
    out
}

/// The whole report, or the one line 0.90.34 printed when the station model can't be built.
/// For a network with priorities, batch arrivals or a rate profile (new in 2.1) the station
/// model is at the long-run customer rates and the SRBM and closed-form lines, which are for
/// classical networks, are replaced by the sentence that says so (`extended::report_model`).
pub fn dump_rho(net: &Network) -> String {
    match crate::extended::report_model(net, "The SRBM and closed-form check") {
        Ok(ReportModel::Classical(data)) => station_model(net, &data) + &analysis_lines(net, &data),
        Ok(ReportModel::Extended { data, sentence, .. }) => station_model(net, &data) + &format!("hasRoutingCycles = {}\nSRBM and closed-form check skipped: {sentence}\n", tractability::has_routing_cycles(&data.aggregated_p)),
        Err(e) => format!("computeData failed: {e}\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bnet;

    fn example(name: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples").join(name)).unwrap()
    }

    /// Review finding FIX-202: a source with mean batch size 4 at batch rate 0.2 into a station
    /// of rate 1 loads it to 0.8, not 0.2, and the product-form mean is not this network's.
    #[test]
    fn a_batch_network_is_reported_at_its_customer_rate_and_not_as_a_jackson_network() {
        let text = example("extended/BatchArrivals.mx-m-1.geometric.bnet").replace("lambda=0.24", "lambda=0.2").replace("\"mean\" : 2.5", "\"mean\" : 4");
        let net = bnet::read(&text).unwrap();
        assert_eq!(crate::extended::rate_factor(net.nodes_of(crate::model::NodeKind::Source).next().unwrap()), 4.0);
        let out = dump_rho(&net);
        assert!(out.contains("S1: α=0.800000  μ_eff=1.000000  c=1.000000  ρ=0.800000\n"), "{out}");
        assert!(out.contains("SRBM and closed-form check skipped: This network uses batch arrivals at Src1."), "{out}");
        assert!(!out.contains("Jackson") && !out.contains("AnalyticalTractability") && !out.contains("SRBM existence"), "{out}");
    }

    #[test]
    fn a_priority_network_is_not_given_a_first_come_first_served_closed_form() {
        let net = bnet::read(&example("extended/PriorityHelpDesk.mg1.2class.bnet")).unwrap();
        let out = dump_rho(&net);
        assert!(out.contains("ρ=0.700000") && out.contains("check skipped: This network uses priority service at "), "{out}");
        assert!(!out.contains("AnalyticalTractability") && !out.contains("skew"), "{out}");
    }

    /// A network without the new features is reported exactly as before (the golden comparison
    /// in core/tests covers every example; this is the gate's own check).
    #[test]
    fn a_plain_network_goes_through_the_gate_unchanged() {
        let net = bnet::read(&example("OpenJackson.d2.feedback.p50.inf.bnet")).unwrap();
        let data = crate::traffic::compute(&net.nodes, &net.links, net.infinite_buffers, false, false).unwrap();
        assert_eq!(dump_rho(&net), station_model(&net, &data) + &analysis_lines(&net, &data));
        assert!(matches!(crate::extended::report_model(&net, "x"), Ok(ReportModel::Classical(_))));
    }
}
