//! The generators build what Qnet 0.90.34 built (golden/generators/, written by 0.90.34's own
//! `TabDocumentWriter.write` from `Qnet --golden-generators`).
//!
//! Each golden file's name holds the parameters it was made with; the same network is built here
//! and saved with `bnet::write`. Node and link ids are UUIDs that 0.90.34 drew at random, so both
//! texts have their ids replaced by "ID-1", "ID-2", … in order of first appearance; everything else
//! must be byte-identical. That holds for the random networks too: a seed reproduces 0.90.34's
//! network exactly. The one expected difference is ledger GEN-022 (decision D5): a one-station
//! general P-matrix network now routes 1 to the sink, where 0.90.34 routed the sink probability
//! alone, so for those files the golden station → sink probabilities are set to 1 before comparing.

use std::collections::HashMap;
use std::path::PathBuf;

use qnet_core::bnet;
use qnet_core::generate::{self, rng::SplitMix64, Archetype, ArchetypeParameters, CountingIds, Parameters, Topology};
use qnet_core::model::NodeKind;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../golden/generators")
}

fn files() -> Vec<String> {
    let mut v: Vec<String> =
        std::fs::read_dir(dir()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn read(name: &str) -> String {
    std::fs::read_to_string(dir().join(name)).unwrap()
}

/// Replaces every UUID by "ID-n", numbered in order of first appearance.
fn without_ids(text: &str) -> String {
    let is_uuid = |s: &[u8]| {
        s.len() == 36
            && s.iter().enumerate().all(|(i, &c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_digit() || (b'A'..=b'F').contains(&c)
                }
            })
    };
    let bytes = text.as_bytes();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 36 <= bytes.len() && is_uuid(&bytes[i..i + 36]) {
            let id = &text[i..i + 36];
            let n = seen.len() + 1;
            let n = *seen.entry(id).or_insert(n);
            out.push_str(&format!("ID-{n}"));
            i += 36;
        } else {
            let c = text[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// The value after `key` in `rest`, up to the first of `ends` (or the end), and what follows it.
fn field<'a>(rest: &'a str, key: &str, ends: &[&str]) -> (&'a str, &'a str) {
    let body = rest.strip_prefix(key).unwrap_or_else(|| panic!("expected {key} in {rest}"));
    // Skip the value's own leading sign before looking for the separator.
    let at = ends.iter().filter_map(|e| body[1..].find(e).map(|i| i + 1)).min().unwrap_or(body.len());
    (&body[..at], body[at..].strip_prefix('-').unwrap_or(&body[at..]))
}

/// "d5-c3-rho0.75-p0.45-finite25-lambda2.5" → the parameters.
fn archetype_parameters(tag: &str) -> ArchetypeParameters {
    let (d, rest) = field(tag, "d", &["-c"]);
    let (c, rest) = field(rest, "c", &["-rho"]);
    let (rho, rest) = field(rest, "rho", &["-p"]);
    let (p, rest) = field(rest, "p", &["-inf", "-finite"]);
    let (buffers, rest) = rest.split_once('-').unwrap();
    let (lambda, _) = field(rest, "lambda", &[]);
    let mut a = ArchetypeParameters {
        stations: d.parse().unwrap(),
        servers: c.parse().unwrap(),
        target_rho: rho.parse().unwrap(),
        feedback_probability: p.parse().unwrap(),
        infinite_buffers: buffers == "inf",
        arrival_rate: lambda.parse().unwrap(),
        ..ArchetypeParameters::default()
    };
    if let Some(cap) = buffers.strip_prefix("finite") {
        a.buffer_capacity = cap.parse().unwrap();
    }
    a
}

/// "archetype-<id>-<setting>-<tag>.bnet" or "built-<id>-default-<tag>.bnet".
fn archetype_case(name: &str) -> (bool, Archetype, ArchetypeParameters) {
    let stem = name.strip_suffix(".bnet").unwrap();
    let (kind, rest) = stem.split_once('-').unwrap();
    let (id, rest) = rest.split_once('-').unwrap();
    let (_setting, tag) = rest.split_once('-').unwrap();
    (kind == "archetype", Archetype::from_raw(id).unwrap(), archetype_parameters(tag))
}

/// "random-<ff|jfb|gp|reent>-d<d>-k<K>-rho<ρ>-seed<seed>-<inf|finite>.bnet".
fn random_case(name: &str) -> Parameters {
    let t: Vec<&str> = name.strip_suffix(".bnet").unwrap().split('-').collect();
    assert_eq!((t.len(), t[0]), (7, "random"), "{name}");
    Parameters {
        topology: Topology::from_cli_tag(t[1]).unwrap(),
        stations: t[2].strip_prefix('d').unwrap().parse().unwrap(),
        classes: t[3].strip_prefix('k').unwrap().parse().unwrap(),
        target_rho: t[4].strip_prefix("rho").unwrap().parse().unwrap(),
        seed: Some(t[5].strip_prefix("seed").unwrap().parse().unwrap()),
        infinite_buffers: t[6] == "inf",
    }
}

#[test]
fn every_archetype_at_every_setting_is_built_exactly_as_0_90_34_built_it() {
    let mut checked = 0;
    let mut differ = Vec::new();
    for name in
        files().into_iter().filter(|f| f.ends_with(".bnet") && (f.starts_with("archetype-") || f.starts_with("built-")))
    {
        let (inserted, kind, params) = archetype_case(&name);
        let mut ids = CountingIds::new();
        let net = if inserted {
            generate::archetype_as_inserted(kind, &params, &mut ids)
        } else {
            generate::archetype(kind, &params, &mut ids)
        };
        if without_ids(&bnet::write(&net)) != without_ids(&read(&name)) {
            differ.push(name);
        }
        checked += 1;
    }
    assert_eq!(checked, 5 * 8 + 5, "five archetypes at eight settings, and the five built at the defaults");
    assert!(differ.is_empty(), "differs from 0.90.34: {differ:#?}");
}

#[test]
fn every_seeded_random_network_is_the_one_0_90_34_generated() {
    let mut checked = 0;
    let mut differ = Vec::new();
    let mut topologies = std::collections::BTreeSet::new();
    for name in files().into_iter().filter(|f| f.starts_with("random-")) {
        let params = random_case(&name);
        topologies.insert(params.topology.cli_tag());
        let mine = bnet::write(&generate::generate(&params, &mut CountingIds::new()));
        let mut want = read(&name);
        if params.topology == Topology::GeneralPMatrix && params.stations == 1 {
            // GEN-022 (D5): the lone station routes 1 to the sink instead of its sink probability.
            let mut golden = bnet::read(&want).unwrap();
            let sink = golden.nodes_of(NodeKind::Sink).next().unwrap().id.clone();
            let changed = golden.links.iter_mut().filter(|l| l.to == sink).map(|l| l.probability = 1.0).count();
            assert!(changed > 0, "{name}");
            want = bnet::write(&golden);
        }
        if without_ids(&mine) != without_ids(&want) {
            differ.push(name);
        }
        checked += 1;
    }
    assert_eq!(checked, 40, "ten shapes for each of the four topologies");
    assert_eq!(topologies.len(), 4);
    assert!(differ.is_empty(), "differs from 0.90.34: {differ:#?}");
}

#[test]
fn the_gallery_summaries_are_0_90_34s() {
    let text = read("archetype-summaries.txt");
    let mut n = 0;
    for line in text.lines() {
        let (file, want) = line.split_once('\t').unwrap();
        let (_, kind, params) = archetype_case(file);
        assert_eq!(generate::summary(kind, &params), want, "{file}");
        n += 1;
    }
    assert_eq!(n, 40);
}

#[test]
fn the_catalogue_is_0_90_34s() {
    let mut mine = format!("groups: {}\n", generate::groups().join(" | "));
    for b in &generate::BLUEPRINTS {
        let knobs: Vec<&str> = b.knobs.iter().map(|k| k.raw()).collect();
        mine += &format!("{} | {} | {} | {} | {}\n", b.id.raw(), b.group, b.title, b.subtitle, knobs.join(","));
    }
    assert_eq!(mine, read("archetype-catalogue.txt"));
}

#[test]
fn the_seeded_generator_and_swifts_random_draws_are_reproduced_bit_for_bit() {
    let text = read("swift-random.txt");
    let mut g = SplitMix64::new(20260904);
    let mut draws = 0;
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        match t[0] {
            "next" => {
                let seed: u64 = t[1].strip_prefix("seed=").unwrap().strip_suffix(':').unwrap().parse().unwrap();
                let mut raw = SplitMix64::new(seed);
                for w in &t[2..] {
                    assert_eq!(raw.next_u64(), w.parse::<u64>().unwrap(), "{line}");
                }
            }
            "double" => {
                let (lo, hi): (f64, f64) = (t[1].parse().unwrap(), t[2].parse().unwrap());
                let want = u64::from_str_radix(t[3], 16).unwrap();
                assert_eq!(g.double_in_closed(lo, hi).to_bits(), want, "{line}");
                draws += 1;
            }
            "int" => {
                let want: i64 = t[2].parse().unwrap();
                let got = if let Some((lo, hi)) = t[1].split_once("...") {
                    g.int_in_closed(lo.parse().unwrap(), hi.parse().unwrap())
                } else {
                    let (lo, hi) = t[1].split_once("..<").unwrap();
                    g.int_in_range(lo.parse().unwrap(), hi.parse().unwrap())
                };
                assert_eq!(got, want, "{line}");
                draws += 1;
            }
            other => panic!("unknown line kind {other}"),
        }
    }
    assert_eq!(draws, 4000);
}

#[test]
fn every_golden_generator_file_is_checked() {
    for name in files() {
        let known = name.starts_with("archetype-")
            || name.starts_with("built-")
            || name.starts_with("random-")
            || ["archetype-summaries.txt", "archetype-catalogue.txt", "swift-random.txt"].contains(&name.as_str());
        assert!(known, "no test reads {name}");
    }
}

#[test]
fn ids_are_numbered_in_order_of_first_appearance() {
    let a = "\"x\" : \"0A1B2C3D-0000-4000-8000-00000000000F\", \"y\" : \"FFFFFFFF-0000-4000-8000-000000000000\", \"z\" : \"0A1B2C3D-0000-4000-8000-00000000000F\"";
    assert_eq!(without_ids(a), "\"x\" : \"ID-1\", \"y\" : \"ID-2\", \"z\" : \"ID-1\"");
    assert_eq!(without_ids("λ = 1"), "λ = 1");
}
