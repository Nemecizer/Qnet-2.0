//! `qnet-cli`: Qnet without a window. It replaces 0.90.34's headless flags (`Qnet --dump-rho`, the
//! `--export-*` family, `--export-cmp`, `--gen-random`) with subcommands that call the same core
//! the app uses, so a network's analysis and solver inputs can be produced and checked from a shell
//! or a script. `run` (new in 2.0, `run.rs`) runs a Run-menu method's solvers as the app does.
//!
//! Output goes to stdout unless a file or folder is named; a network the analysis or an exporter
//! refuses prints 0.90.34's sentence to stderr and exits 1; a usage error exits 2.

mod api;
mod load;
mod methods;
mod run;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use qnet_core::export::{all, fbnasim, finite_markov, jackson_sim, product_form, qbd, qna, regenerative, srbm_box, srbm_orthant};
use qnet_core::generate::{self, Parameters, Topology};
use qnet_core::model::Network;
use qnet_core::extended::{self, ReportModel};
use qnet_core::{bnet, dump, report};

const USAGE_TEMPLATE: &str = "Usage:
  qnet-cli dump-rho <file.bnet>              the station model, SRBM verdict and tractability (0.90.34 --dump-rho)
  qnet-cli analyze <file.bnet>               Network › Analyze Network
  qnet-cli primitives <file.bnet>            Network › Show Network Primitives
  qnet-cli resave <file.bnet> [out]          open and save, as Qnet saves (to stdout without [out])
  qnet-cli export <format> <file.bnet> [out] [--seed N] [--stream N]
                                             one solver input (to stdout without [out]); formats:
      fbnasm fbnafm fbnalp fbnasim            finite buffers: spectral (degree 8), finite element (mesh 10), LP, simulator
      bnasm bnamc bnalp adaptive-bar bar-bounds   infinite buffers: spectral (degree 8), MLMC, LP, BAR
      qna jackson-sim                         QNA / RQNA / SBD, and the infinite simulator
      regenerative product-form qbd           Markovian JSON documents
      generic-ctmc decomp-loss decomp-bas decomp-bas-extloss truncated-ctmc   finite and truncated Markov
  qnet-cli export-all <file.bnet> <folder> [--loss-fix|--bas-fix]
                                             File › Export › All Solver Inputs (0.90.34 --export-cmp)
  qnet-cli gen-random <d> <K> <rho> <ff|jfb|gp|reent> <seed> <folder>
                                             a random infinite-buffer network's case.qna, case.smin, case.sim
{RUN}
{API}
  --scenario <name|baseline>                 with any command that reads a file: read that scenario of it, or the
                                             network's own values (without it: the variant the file was saved showing)
  qnet-cli --version";

/// The usage text, with `run`'s lines in their place.
fn usage_text() -> String {
    USAGE_TEMPLATE.replace("{RUN}", run::USAGE).replace("{API}", api::USAGE)
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // `--scenario <name|baseline>`: which variant of the file every command reads (load.rs).
    if let Err((code, message)) = load::take_choice(&mut args) {
        eprintln!("{message}");
        return ExitCode::from(code);
    }
    if args.first().is_some_and(|a| a == "run") {
        return run::main(&args[1..]);
    }
    // `solve`: `run` with the method Solve would choose (new in 2.1).
    if args.first().is_some_and(|a| a == "solve") {
        return run::solve(&args[1..]);
    }
    // The machine interface (new in 2.1, api.rs): one JSON document on stdout.
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    if let Some(answer) = api::run(&words) {
        return match answer {
            Ok(text) => {
                print!("{text}");
                ExitCode::SUCCESS
            }
            Err((code, message)) => {
                eprintln!("{message}");
                ExitCode::from(code)
            }
        };
    }
    match run(&args) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err((code, message)) => {
            eprintln!("{message}");
            ExitCode::from(code)
        }
    }
}

type Failure = (u8, String);

/// The file's network: the variant `--scenario` names, else the one it was saved showing (with a
/// note on stderr when that is a scenario).
fn read(path: &str) -> Result<Network, Failure> {
    load::read_saying(path)
}

/// `resave`: the file as Qnet saves it, scenarios and all. With `--scenario`, saved showing that
/// variant (the others are kept beside it, as the app keeps them).
fn resave(path: &str) -> Result<String, Failure> {
    let loaded = load::load_as(path, None)?;
    let Some(block) = &loaded.scenarios else {
        // No scenarios: `--scenario baseline` is this network; any other name is refused by load.
        return Ok(bnet::write(&load::load(path)?.net));
    };
    match load::choice() {
        None => Ok(bnet::write_with_scenarios(&loaded.net, Some(block))),
        Some(which) => {
            let (net, block) = qnet_core::scenarios::switch(&loaded.as_saved, block, &which).map_err(|m| (1, m))?;
            Ok(bnet::write_with_scenarios(&net, Some(&block)))
        }
    }
}

/// The document name the JSON exporters record: the file name without its last extension.
fn document_name(path: &str) -> String {
    Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The local time in the `# Generated:` form the corpus shows (`11/10/26, 14:11:04`): 0.90.34's
/// short date and medium time style for en_US with a 24-hour clock.
fn generated_now() -> String {
    // SAFETY: time and localtime_r write only into the values passed; tm is zeroed first.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return "unknown time".into();
        }
        format!("{}/{}/{:02}, {:02}:{:02}:{:02}", tm.tm_mon + 1, tm.tm_mday, (tm.tm_year + 1900) % 100, tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

/// One solver input for `net`, or the exporter's refusal.
/// `seeds` replaces the regenerative document's base seed and stream (0.90.34 `--export-regenerative <bnet> <out> [base-seed] [stream]`).
fn export(format: &str, net: &Network, name: &str, seeds: Option<regenerative::Options>) -> Result<Result<String, String>, Failure> {
    let (n, l, inf) = (&net.nodes[..], &net.links[..], net.infinite_buffers);
    let m = |r: Result<String, String>| Ok(r);
    // No exporter writes priorities, batch sizes or a rate profile (core's one rule).
    if let Some(sentence) = extended::export_refusal(net) {
        return Ok(Err(sentence));
    }
    match format {
        "fbnasm" => m(srbm_box::export_for_spectral(n, l, inf, srbm_box::DEFAULT_SPECTRAL_DEGREE, false, false).map_err(|e| e.message())),
        "fbnafm" => m(srbm_box::export_for_finite_element(n, l, inf, srbm_box::DEFAULT_MESH_SIZE, false, false).map_err(|e| e.message())),
        "fbnalp" => m(srbm_box::export_for_finite_lp(n, l, &srbm_box::FiniteLpParams::default(), false, false).map_err(|e| e.message())),
        "fbnasim" => m(fbnasim::export(n, l, &generated_now()).map_err(|e| e.message())),
        "bnasm" => m(srbm_orthant::export_for_spectral(n, l, srbm_orthant::DEFAULT_SPECTRAL_DEGREE).map_err(|e| e.message())),
        "bnamc" => m(srbm_orthant::compute(n, l).map(|d| srbm_orthant::format_bnamc_input(&d)).map_err(|e| e.message())),
        "bnalp" => m(srbm_orthant::compute(n, l).map(|d| srbm_orthant::format_bnalp_input(&d, &srbm_orthant::BnaLpParams::default())).map_err(|e| e.message())),
        "adaptive-bar" => m(srbm_orthant::export_for_adaptive_bar(n, l, name, srbm_orthant::DEFAULT_MAX_RANK).map_err(|e| e.message())),
        "bar-bounds" => m(srbm_orthant::export_for_bar_bounds(n, l, name, srbm_orthant::DEFAULT_BAR_ORDER).map_err(|e| e.message())),
        "qna" => m(qna::export(n, l).map_err(|e| e.message())),
        "jackson-sim" => m(jackson_sim::export(n, l).map_err(|e| e.message())),
        "regenerative" => m(regenerative::export(net, name, &seeds.unwrap_or_default()).map_err(|e| e.message())),
        "product-form" => m(product_form::export(net, name, product_form::DEFAULT_MAXIMUM_SERVERS).map_err(|e| e.message())),
        "qbd" => m(qbd::export(net, name, &qbd::QbdOptions::default()).map_err(|e| e.message())),
        "generic-ctmc" => m(finite_markov::generic_ctmc(net, name, &finite_markov::GenericCtmcOptions::default()).map_err(|e| e.message())),
        "truncated-ctmc" => m(finite_markov::truncated_infinite_ctmc(net, name, &finite_markov::TruncatedCtmcOptions::default()).map_err(|e| e.message())),
        "decomp-loss" | "decomp-bas" | "decomp-bas-extloss" => {
            let blocking = match format {
                "decomp-loss" => finite_markov::Blocking::Loss,
                "decomp-bas" => finite_markov::Blocking::Bas,
                _ => finite_markov::Blocking::BasExternalLoss,
            };
            m(finite_markov::decomposition(net, name, blocking, &finite_markov::DecompositionOptions::default()).map_err(|e| e.message()))
        }
        _ => Err((2, format!("There's no export format called “{format}”.\n\n{}", usage_text()))),
    }
}

fn write_file(path: &Path, text: &str) -> Result<(), Failure> {
    std::fs::write(path, text).map_err(|e| (1, format!("Couldn't write {}: {e}.", path.display())))
}

/// Random UUIDs for generated nodes and links, from the system's random source.
fn random_uuid() -> String {
    let mut b = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn run(args: &[String]) -> Result<String, Failure> {
    let usage = || (2, usage_text());
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["--version"] => Ok(format!("Qnet {}\n", env!("CARGO_PKG_VERSION"))),
        ["dump-rho", file] => Ok(dump::dump_rho(&read(file)?)),
        // Both reports go through core's one gate (`extended::report_model`): a network with
        // priorities, batch arrivals or a rate profile is not read as a plain one.
        ["analyze", file] => {
            let net = read(file)?;
            match extended::report_model(&net, "Analyze Network").map_err(|e| (1, format!("Analyze network aborted: {e}")))? {
                ReportModel::Classical(data) => Ok(report::analysis(&data, &net.nodes, &net.links, net.infinite_buffers)),
                ReportModel::Extended { text, .. } => Ok(text),
            }
        }
        ["primitives", file] => {
            let net = read(file)?;
            match extended::report_model(&net, "Show Network Primitives").map_err(|e| (1, format!("Network primitives aborted: {e}")))? {
                ReportModel::Classical(data) => {
                    let warnings = report::primitives_warnings(&data, &net.nodes, &net.links, net.infinite_buffers);
                    Ok(report::primitives(&data, &warnings, net.infinite_buffers))
                }
                ReportModel::Extended { text, .. } => Ok(text),
            }
        }
        ["resave", file] => resave(file),
        ["resave", file, out] => {
            write_file(Path::new(out), &resave(file)?)?;
            Ok(String::new())
        }
        ["export", format, file, rest @ ..] => {
            // [out] [--seed N] [--stream N], in any order after the file.
            let (mut out, mut seed, mut stream) = (None, None, None);
            let mut it = rest.iter();
            while let Some(arg) = it.next() {
                let number = |v: Option<&&str>| v.and_then(|v| v.parse::<u64>().ok()).ok_or((1, "ERROR: base-seed and stream must be unsigned 64-bit integers".to_string()));
                match *arg {
                    "--seed" => seed = Some(number(it.next())?),
                    "--stream" => stream = Some(number(it.next())?),
                    o if out.is_none() && !o.starts_with("--") => out = Some(o),
                    _ => return Err(usage()),
                }
            }
            let seeds = (seed.is_some() || stream.is_some()).then(|| {
                let d = regenerative::Options::default();
                regenerative::Options { base_seed: seed.unwrap_or(d.base_seed), stream: stream.unwrap_or(d.stream), ..d }
            });
            let net = read(file)?;
            let text = export(format, &net, &document_name(file), seeds)?.map_err(|m| (1, m))?;
            match out {
                Some(out) => {
                    write_file(Path::new(out), &text)?;
                    Ok(format!("wrote {out}\n"))
                }
                None => Ok(text),
            }
        }
        ["export-all", file, folder, rest @ ..] => {
            let convention = match rest {
                [] => all::BlockingConvention::Manufacturing,
                ["--loss-fix"] => all::BlockingConvention::LossCorrection,
                ["--bas-fix"] => all::BlockingConvention::BasCorrection,
                _ => return Err(usage()),
            };
            let net = read(file)?;
            if let Some(sentence) = extended::export_refusal(&net) {
                return Err((1, sentence));
            }
            std::fs::create_dir_all(folder).map_err(|e| (1, format!("Couldn't create {folder}: {e}.")))?;
            let outputs = all::export_all(&net, convention, &generated_now());
            let mut said = String::new();
            for o in &outputs {
                if let Ok(text) = &o.result {
                    let path = PathBuf::from(folder).join(o.file);
                    write_file(&path, text)?;
                    said += &format!("wrote {}\n", path.display());
                }
            }
            let (ok, warn) = all::status_lines(&outputs, folder, &net, convention);
            said += &format!("{ok}\n");
            if let Some((headline, detail)) = warn {
                said += &format!("{headline}\n{detail}\n");
            }
            Ok(said)
        }
        ["gen-random", d, k, rho, topology, seed, folder] => {
            let bad = || (1, "ERROR: bad numeric arg".to_string());
            let params = Parameters {
                stations: d.parse().map_err(|_| bad())?,
                classes: k.parse().map_err(|_| bad())?,
                infinite_buffers: true,
                target_rho: rho.parse().map_err(|_| bad())?,
                topology: Topology::from_cli_tag(topology).ok_or((1, "ERROR: bad topology".to_string()))?,
                seed: Some(seed.parse().map_err(|_| bad())?),
            };
            let net = generate::generate(&params, &mut random_uuid);
            std::fs::create_dir_all(folder).map_err(|e| (1, format!("Couldn't create {folder}: {e}.")))?;
            let mut said = String::new();
            let files: [(&str, Option<String>); 3] = [
                ("case.qna", qna::export(&net.nodes, &net.links).ok()),
                ("case.smin", srbm_orthant::export_for_spectral(&net.nodes, &net.links, srbm_orthant::DEFAULT_SPECTRAL_DEGREE).ok()),
                ("case.sim", jackson_sim::export(&net.nodes, &net.links).ok()),
            ];
            for (file, text) in files {
                if let Some(text) = text {
                    let path = PathBuf::from(folder).join(file);
                    write_file(&path, &text)?;
                    said += &format!("wrote {}\n", path.display());
                }
            }
            Ok(said)
        }
        ["gen-random", ..] => Err((1, "Usage: qnet-cli gen-random <d> <K> <rho> <ff|jfb|gp|reent> <seed> <folder>".into())),
        _ => Err(usage()),
    }
}
