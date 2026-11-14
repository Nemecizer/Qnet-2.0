//! `closed.rs` against Qnet's own Python product-form solver (solvers/infinite/BNApf, unchanged
//! from 0.90.34: `bcmp.py` enumerates every state, `mva.py` is Reiser–Lavenberg MVA with the
//! multi-server marginal recursion), run on the same inputs. Ledger SCI-503.
//!
//! An independent implementation in another language: agreement to 1e-9 relative in the
//! throughput and every mean number (the Python tests hold its own two routes to 1e-9).
//! Skipped with a note when no `python3` is found (the staged one, then PATH).

use std::path::PathBuf;
use std::process::Command;

use qnet_core::closed::{convolution, ClosedModel};
use qnet_core::json::{self, Json};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn python() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let staged = PathBuf::from(format!("{home}/Library/Caches/qnet/python/stage/Resources/python/bin/python3"));
    let candidates = [staged, PathBuf::from("/usr/bin/python3"), PathBuf::from("/opt/homebrew/bin/python3"), PathBuf::from("python3")];
    candidates.into_iter().find(|p| Command::new(p).arg("--version").output().is_ok_and(|o| o.status.success()))
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64) as usize
    }
}

fn random_model(rng: &mut Lcg, multi: bool) -> ClosedModel {
    let d = 2 + rng.below(4);
    let p: Vec<Vec<f64>> = (0..d)
        .map(|i| {
            let raw: Vec<f64> = (0..d).map(|_| if rng.next() < 0.6 { 0.1 + rng.next() } else { 0.0 }).collect();
            let total: f64 = raw.iter().sum();
            let w = if total > 0.0 { 0.5 } else { 1.0 };
            (0..d).map(|j| if j == (i + 1) % d { w } else { 0.0 } + if total > 0.0 { (1.0 - w) * raw[j] / total } else { 0.0 }).collect()
        })
        .collect();
    ClosedModel {
        ids: (0..d).map(|i| format!("id{i}")).collect(),
        names: (0..d).map(|i| format!("s{}", i + 1)).collect(),
        p,
        mu: (0..d).map(|_| 0.25 + 3.0 * rng.next()).collect(),
        servers: (0..d).map(|_| if multi { 1 + rng.below(3) as i64 } else { 1 }).collect(),
        delay: (0..d).map(|_| rng.next() < 0.2).collect(),
        population: 1 + rng.below(if multi { 12 } else { 60 }),
    }
}

/// The model as BNApf's schema-version-1 `closed_bcmp` document. Numbers are written with 17
/// significant digits, so Python reads the same doubles.
fn document(m: &ClosedModel) -> String {
    let stations: Vec<String> = (0..m.names.len())
        .map(|i| {
            let kind = if m.delay[i] { "\"type\": \"infinite_server\"".to_string() } else { format!("\"type\": \"fcfs\", \"servers\": {}", m.servers[i]) };
            format!("{{\"id\": \"{}\", {kind}, \"service_times\": {{\"job\": {:e}}}}}", m.names[i], 1.0 / m.mu[i])
        })
        .collect();
    let routing: Vec<String> = (0..m.names.len())
        .map(|i| {
            let dest: Vec<String> = (0..m.names.len()).filter(|&j| m.p[i][j] > 0.0).map(|j| format!("{{\"station\": \"{}\", \"probability\": {:e}}}", m.names[j], m.p[i][j])).collect();
            format!("{{\"from_station\": \"{}\", \"destinations\": [{}]}}", m.names[i], dest.join(", "))
        })
        .collect();
    format!(
        "{{\"schema_version\": 1, \"model_type\": \"closed_bcmp\", \"name\": \"t\", \"stations\": [{}], \"classes\": [{{\"id\": \"job\", \"population\": {}, \"reference_station\": \"{}\", \"routing\": [{}]}}]}}",
        stations.join(", "),
        m.population,
        m.names[0],
        routing.join(", ")
    )
}

fn field<'a>(v: &'a Json, key: &str) -> &'a Json {
    v.as_object().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("no {key}"))
}

#[test]
fn convolution_agrees_with_the_python_product_form_solver() {
    let Some(python) = python() else {
        println!("skipped: no python3 found");
        return;
    };
    let solver = root().join("solvers/infinite/BNApf/solver.py");
    let dir = std::env::temp_dir().join(format!("qnet-closed-python-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut rng = Lcg(503);
    let (mut by_mva, mut by_enumeration) = (0, 0);
    for case in 0..40 {
        let m = random_model(&mut rng, case % 2 == 1);
        // Python renormalises a row that is 1 only to rounding; ours must already be 1 to 1e-9.
        let ours = convolution(&m).unwrap();
        let input = dir.join(format!("case{case}.json"));
        std::fs::write(&input, document(&m)).unwrap();
        let out = Command::new(&python).arg("-B").arg(&solver).arg(&input).arg("--json").output().unwrap();
        assert!(out.status.success(), "case {case}: {}", String::from_utf8_lossy(&out.stderr));
        let result = json::parse(&String::from_utf8_lossy(&out.stdout)).unwrap();
        let method = field(field(&result, "solver"), "method").as_str().unwrap_or("").to_string();
        if method.to_lowercase().contains("mean value") || method.to_lowercase().contains("mva") {
            by_mva += 1;
        } else {
            by_enumeration += 1;
        }
        let measures = field(&result, "measures");
        let x = field(&field(measures, "classes").as_array().unwrap()[0], "reference_throughput").as_f64().unwrap();
        assert!((x - ours.throughput).abs() <= 1e-9 * x, "case {case} ({method}): X {x} against {}", ours.throughput);
        for (i, st) in field(measures, "stations").as_array().unwrap().iter().enumerate() {
            let l = field(st, "mean_number").as_f64().unwrap();
            assert!((l - ours.number[i]).abs() <= 1e-9 * m.population as f64, "case {case} ({method}): L_{i} {l} against {}", ours.number[i]);
            let xi = field(st, "throughput").as_f64().unwrap();
            assert!((xi - ours.station_throughput[i]).abs() <= 1e-9 * xi, "case {case}: X_{i}");
            if let (Some(u), Some(mine)) = (field(st, "server_utilization").as_f64(), ours.utilisation[i]) {
                assert!((u - mine).abs() <= 1e-9, "case {case}: U_{i} {u} against {mine}");
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    println!("agreed on 40 networks: {by_mva} solved by Python's MVA, {by_enumeration} by its enumeration");
}
