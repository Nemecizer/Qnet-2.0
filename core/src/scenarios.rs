//! Scenarios read as networks (new in 2.1; ledger WF-503): the interface's override rules
//! (`src/scenarios/model.ts`) for the readers that have no interface, `qnet-cli` and through it
//! the Python package.
//!
//! A file's `nodes`, `links` and `closedPopulation` hold the values of the variant that was shown
//! when it was saved; `scenarios` (`bnet::read_scenarios`) holds each scenario's overrides of the
//! baseline and, while a scenario is active, the baseline's own values for the fields that
//! scenario overrides. The functions here mirror the interface's, one for one:
//!
//! | here              | src/scenarios/model.ts |
//! |-------------------|------------------------|
//! | `read_field`      | `readField`            |
//! | `write_field`     | `writeField`           |
//! | `network_for`     | `scenarioDocument`     |
//! | `switch`          | `switchScenario`       |
//! | `reconcile`       | `reconcile` (values only: a change of the network itself is refused) |
//!
//! `core/tests/scenarios_fixture.rs` and `src/scenarios/fixture.test.ts` read the same file and
//! the same expected networks (`core/tests/fixtures/scenarios/`), so the two cannot drift apart.

use std::collections::BTreeMap;

use crate::json::Json;
use crate::model::{Distribution, Link, Network, Node, ServiceConfig};

/// The name the baseline is asked for by (`--scenario baseline`). The interface never lets a
/// scenario take it (`uniqueName`).
pub const BASELINE: &str = "baseline";

const NODE_FIELDS: [&str; 4] = ["bufferSize", "numberOfServers", "distribution", "serviceDistributions"];

fn items(scenarios: &Json) -> &[Json] {
    scenarios.as_object().and_then(|m| m.get("items")).and_then(Json::as_array).unwrap_or(&[])
}

fn text<'a>(v: &'a Json, key: &str) -> Option<&'a str> {
    v.as_object().and_then(|m| m.get(key)).and_then(Json::as_str)
}

fn list<'a>(v: &'a Json, key: &str) -> &'a [Json] {
    v.as_object().and_then(|m| m.get(key)).and_then(Json::as_array).unwrap_or(&[])
}

/// The scenarios' names, in the file's order.
pub fn names(scenarios: &Json) -> Vec<String> {
    items(scenarios).iter().filter_map(|s| text(s, "name").map(str::to_string)).collect()
}

fn active_id(scenarios: &Json) -> Option<&str> {
    text(scenarios, "active")
}

fn by_id<'a>(scenarios: &'a Json, id: &str) -> Option<&'a Json> {
    items(scenarios).iter().find(|s| text(s, "id") == Some(id))
}

/// The name of the scenario the file was saved showing; None for the baseline.
pub fn active_name(scenarios: &Json) -> Option<String> {
    active_id(scenarios).and_then(|id| by_id(scenarios, id)).and_then(|s| text(s, "name")).map(str::to_string)
}

/// The name of the scenario with this id.
pub fn name_of(scenarios: &Json, id: &str) -> Option<String> {
    by_id(scenarios, id).and_then(|s| text(s, "name")).map(str::to_string)
}

/// The id of the scenario asked for by name (or by id); `Ok(None)` for the baseline.
pub fn find(scenarios: &Json, which: &str) -> Result<Option<String>, String> {
    let wanted = which.trim();
    if wanted.eq_ignore_ascii_case(BASELINE) {
        return Ok(None);
    }
    let all = items(scenarios);
    let hit = all.iter().find(|s| text(s, "name") == Some(wanted)).or_else(|| all.iter().find(|s| text(s, "id").is_some_and(|id| id.eq_ignore_ascii_case(wanted)))).or_else(|| {
        // A name typed in another case, when only one scenario answers to it.
        let loose: Vec<&Json> = all.iter().filter(|s| text(s, "name").is_some_and(|n| n.trim().to_lowercase() == wanted.to_lowercase())).collect();
        (loose.len() == 1).then(|| loose[0])
    });
    match hit.and_then(|s| text(s, "id")) {
        Some(id) => Ok(Some(id.to_string())),
        None => {
            let known = names(scenarios).iter().map(|n| format!("“{n}”")).collect::<Vec<_>>().join(", ");
            Err(format!("There is no scenario called “{wanted}” in this file. Its scenarios are {known}; “{BASELINE}” is the network's own values."))
        }
    }
}

/// What an override is of: `node|field`, `link|field` or `|field`, as the interface's `keyOf`.
fn key_of(o: &Json) -> String {
    format!("{}|{}", text(o, "node").or_else(|| text(o, "link")).unwrap_or(""), text(o, "field").unwrap_or(""))
}

fn law_json(distribution: Distribution, parameters: &str) -> Json {
    let mut m = BTreeMap::new();
    m.insert("distribution".to_string(), Json::str(distribution.raw()));
    m.insert("distributionParameters".to_string(), Json::str(parameters));
    Json::Object(m)
}

fn node_value(n: &Node, field: &str) -> Option<Json> {
    Some(match field {
        "bufferSize" => Json::int(n.buffer_size),
        "numberOfServers" => Json::int(n.servers),
        "distribution" => law_json(n.distribution, &n.parameters),
        "serviceDistributions" => Json::Object(n.service_by_class.iter().map(|(class, c)| (class.to_string(), law_json(c.distribution, &c.parameters))).collect()),
        _ => return None,
    })
}

/// The field's value in `net` as it stands; None when its node or link is not there.
pub fn read_field(net: &Network, target: &Json) -> Option<Json> {
    match text(target, "field")? {
        "closedPopulation" => Some(net.population.map(Json::int).unwrap_or(Json::Null)),
        "routingProbability" => {
            let id = text(target, "link")?;
            net.links.iter().find(|l| l.id == id).map(|l| Json::num(l.probability))
        }
        field => {
            let id = text(target, "node")?;
            net.nodes.iter().find(|n| n.id == id).and_then(|n| node_value(n, field))
        }
    }
}

fn law_of(v: &Json) -> Option<(Distribution, String)> {
    Some((Distribution::from_raw(text(v, "distribution")?)?, text(v, "distributionParameters")?.to_string()))
}

/// Sets the field in `net`; nothing changes when the target is gone or the value is not one the
/// field takes.
pub fn write_field(net: &mut Network, o: &Json) {
    let Some(field) = text(o, "field") else { return };
    let value = o.as_object().and_then(|m| m.get("value")).unwrap_or(&Json::Null);
    match field {
        "closedPopulation" => match value {
            Json::Null => net.population = None,
            v => {
                if let Some(n) = v.as_i64() {
                    net.population = Some(n);
                }
            }
        },
        "routingProbability" => {
            let Some(id) = text(o, "link") else { return };
            if let (Some(l), Some(p)) = (net.links.iter_mut().find(|l| l.id == id), value.as_f64()) {
                l.probability = p;
            }
        }
        _ => {
            let Some(id) = text(o, "node") else { return };
            let Some(n) = net.nodes.iter_mut().find(|n| n.id == id) else { return };
            match field {
                "bufferSize" => {
                    if let Some(k) = value.as_i64() {
                        n.buffer_size = k;
                    }
                }
                "numberOfServers" => {
                    if let Some(c) = value.as_i64() {
                        n.servers = c;
                    }
                }
                "distribution" => {
                    if let Some((d, p)) = law_of(value) {
                        n.distribution = d;
                        n.parameters = p;
                    }
                }
                "serviceDistributions" => {
                    let Some(table) = value.as_object() else { return };
                    let mut out = BTreeMap::new();
                    for (class, cfg) in table {
                        if let (Ok(class), Some((distribution, parameters))) = (class.parse::<i64>(), law_of(cfg)) {
                            out.insert(class, ServiceConfig { distribution, parameters });
                        }
                    }
                    n.service_by_class = out;
                }
                _ => {}
            }
        }
    }
}

fn apply(net: &mut Network, overrides: &[Json]) {
    for o in overrides {
        write_field(net, o);
    }
}

/// The baseline as one plain network.
pub fn baseline(net: &Network, scenarios: &Json) -> Network {
    let mut base = net.clone();
    if active_id(scenarios).is_some() {
        apply(&mut base, list(scenarios, "baseline"));
    }
    base
}

/// Scenario `which` (its name or id; "baseline" for the network's own values) as one plain
/// network: what an analysis reads for it. `net` is the file's network, the variant it was saved
/// showing.
pub fn network_for(net: &Network, scenarios: &Json, which: &str) -> Result<Network, String> {
    let id = find(scenarios, which)?;
    if id.as_deref() == active_id(scenarios) {
        return Ok(net.clone());
    }
    let mut out = baseline(net, scenarios);
    if let Some(s) = id.as_deref().and_then(|id| by_id(scenarios, id)) {
        apply(&mut out, list(s, "overrides"));
    }
    Ok(out)
}

fn target(o: &Json) -> BTreeMap<String, Json> {
    let mut m = BTreeMap::new();
    for key in ["node", "link", "field"] {
        if let Some(v) = text(o, key) {
            m.insert(key.to_string(), Json::str(v));
        }
    }
    m
}

fn with_value(o: &Json, value: Json) -> Json {
    let mut m = target(o);
    m.insert("value".to_string(), value);
    Json::Object(m)
}

/// Shows scenario `which`: the network with its values, and the scenarios block with it active
/// and the baseline's values kept beside (the block as it would be saved).
pub fn switch(net: &Network, scenarios: &Json, which: &str) -> Result<(Network, Json), String> {
    let id = find(scenarios, which)?;
    if id.as_deref() == active_id(scenarios) {
        return Ok((net.clone(), scenarios.clone()));
    }
    let base = baseline(net, scenarios);
    let mut all: Vec<Json> = items(scenarios).to_vec();
    let mut out = BTreeMap::new();
    let Some(id) = id else {
        out.insert("items".to_string(), Json::Array(all));
        return Ok((base, Json::Object(out)));
    };
    // Only what the baseline still has can be overridden; the rest is dropped here, quietly.
    let at = all.iter().position(|s| text(s, "id") == Some(id.as_str())).ok_or_else(|| "The scenario is not in this file.".to_string())?;
    let live: Vec<Json> = list(&all[at], "overrides").iter().filter(|o| read_field(&base, o).is_some()).cloned().collect();
    let kept: Vec<Json> = live.iter().map(|o| with_value(o, read_field(&base, o).unwrap_or(Json::Null))).collect();
    let mut shown = base;
    apply(&mut shown, &live);
    if let Json::Object(m) = &mut all[at] {
        m.insert("overrides".to_string(), Json::Array(live));
    }
    out.insert("active".to_string(), Json::str(id));
    out.insert("baseline".to_string(), Json::Array(kept));
    out.insert("items".to_string(), Json::Array(all));
    Ok((shown, Json::Object(out)))
}

/// Two override values are the same value (1 and 1.0, a table whatever its key order).
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(_), Json::Number(_)) => a.as_f64() == b.as_f64(),
        (Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Json::Object(x), Json::Object(y)) => x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| same(p, q))),
        _ => a == b,
    }
}

/// A station's per-class table without the entries that only repeat its own law.
fn own_laws(n: &Node) -> BTreeMap<i64, ServiceConfig> {
    n.service_by_class.iter().filter(|(_, c)| c.distribution != n.distribution || c.parameters != n.parameters).map(|(k, c)| (*k, c.clone())).collect()
}

fn same_link_shape(a: &Link, b: &Link) -> bool {
    a.from == b.from && a.to == b.to && a.class == b.class && a.to_class == b.to_class
}

/// True when `next` is the same network as `prev` but for values a scenario may override (and
/// names, places and pictures, which every scenario shares): the same nodes with their kinds, the
/// same links between the same ends, the same buffer regime.
pub fn same_structure(prev: &Network, next: &Network) -> bool {
    prev.infinite_buffers == next.infinite_buffers
        && prev.nodes.len() == next.nodes.len()
        && prev.links.len() == next.links.len()
        && next.nodes.iter().all(|n| prev.node(&n.id).is_some_and(|p| p.kind == n.kind))
        && next.links.iter().all(|l| prev.links.iter().find(|p| p.id == l.id).is_some_and(|p| same_link_shape(p, l)))
}

/// What a change of values from `prev` (the network `scenarios` was read beside) to `next` means
/// for the scenarios: a changed value becomes (or updates, or, back at the baseline's value,
/// ends) an override of the active scenario; with the baseline shown it is simply the baseline's
/// new value and the block is unchanged. None when the network itself changed (`same_structure`
/// is false): the scenarios cannot be carried over then, and the caller must say so.
pub fn reconcile(prev: &Network, next: &Network, scenarios: &Json) -> Option<Json> {
    if !same_structure(prev, next) {
        return None;
    }
    let Some(active) = active_id(scenarios).map(str::to_string) else { return Some(scenarios.clone()) };
    let mut all: Vec<Json> = items(scenarios).to_vec();
    let Some(at) = all.iter().position(|s| text(s, "id") == Some(active.as_str())) else { return Some(scenarios.clone()) };
    // Insertion-ordered maps, as the interface's Map is.
    let mut base: Vec<(String, Json)> = list(scenarios, "baseline").iter().map(|o| (key_of(o), o.clone())).collect();
    let mut mine: Vec<(String, Json)> = list(&all[at], "overrides").iter().map(|o| (key_of(o), o.clone())).collect();
    let mut touched = false;
    let mut consider = |t: Json, before: Option<Json>, after: Option<Json>| {
        let (Some(before), Some(after)) = (before, after) else { return };
        if same(&before, &after) {
            return;
        }
        let k = key_of(&t);
        let b = base.iter().position(|(key, _)| *key == k);
        let value_of = |o: &Json| o.as_object().and_then(|m| m.get("value")).cloned().unwrap_or(Json::Null);
        if b.is_some_and(|i| same(&value_of(&base[i].1), &after)) {
            base.retain(|(key, _)| *key != k);
            mine.retain(|(key, _)| *key != k);
        } else {
            if b.is_none() {
                base.push((k.clone(), with_value(&t, before)));
            }
            let entry = with_value(&t, after);
            match mine.iter().position(|(key, _)| *key == k) {
                Some(i) => mine[i].1 = entry,
                None => mine.push((k, entry)),
            }
        }
        touched = true;
    };
    let of = |pairs: &[(&str, &str)]| Json::Object(pairs.iter().map(|(k, v)| (k.to_string(), Json::str(*v))).collect());
    for n in &next.nodes {
        let Some(p) = prev.node(&n.id) else { continue };
        for field in NODE_FIELDS {
            if field == "serviceDistributions" && own_laws(p) == own_laws(n) {
                continue;
            }
            consider(of(&[("node", &n.id), ("field", field)]), node_value(p, field), node_value(n, field));
        }
    }
    for l in &next.links {
        if let Some(p) = prev.links.iter().find(|p| p.id == l.id) {
            consider(of(&[("link", &l.id), ("field", "routingProbability")]), Some(Json::num(p.probability)), Some(Json::num(l.probability)));
        }
    }
    let population = |n: &Network| Some(n.population.map(Json::int).unwrap_or(Json::Null));
    consider(of(&[("field", "closedPopulation")]), population(prev), population(next));
    if !touched {
        return Some(scenarios.clone());
    }
    if let Json::Object(m) = &mut all[at] {
        m.insert("overrides".to_string(), Json::Array(mine.into_iter().map(|(_, o)| o).collect()));
    }
    let mut out = BTreeMap::new();
    out.insert("active".to_string(), Json::str(active));
    out.insert("baseline".to_string(), Json::Array(base.into_iter().map(|(_, o)| o).collect()));
    out.insert("items".to_string(), Json::Array(all));
    Some(Json::Object(out))
}
