//! A network from a JSON description, and back (new in 2.1: `qnet-cli build` and `describe`, which
//! the Python package `qnet` is written over).
//!
//! The description names what a person names — nodes by kind and name, links by the names of
//! their ends, distribution parameters as numbers — and leaves out what a drawing program adds:
//! ids and positions. `from_spec` fills those in (ids derived from the names, so the same
//! description always gives the same file and the same fingerprint; positions in columns by
//! distance from a source) and hands back a `Network`, which `bnet::write` saves as the app does.
//! `to_spec` is the other direction and keeps ids, positions and the parameter text, so a file
//! that is described and built again is the same file (tests/build_roundtrip.rs, all examples).
//!
//! ```json
//! { "schema": 1, "buffers": "infinite", "population": null,
//!   "nodes": [ { "kind": "source",  "name": "Src1", "distribution": "poisson", "parameters": { "lambda": 0.8 } },
//!              { "kind": "buffer",  "name": "B1", "size": 10 },
//!              { "kind": "station", "name": "S1", "distribution": "exponential", "parameters": { "rate": 1 }, "servers": 1 },
//!              { "kind": "sink",    "name": "Out" } ],
//!   "links": [ { "from": "Src1", "to": "B1" }, { "from": "B1", "to": "S1" }, { "from": "S1", "to": "Out", "probability": 1 } ] }
//! ```
//!
//! New in 2.1 (ledger SCI-1030): a station may carry `"serviceDiscipline"` with `"priorityOrder"`,
//! and a source `"batchSize"` and `"rateProfile"`, each exactly as the `.bnet` file holds it
//! (`bnet.rs`): the description adds no second spelling. A batch law or profile that is not valid
//! is refused here with the sentence Problems would show.
//!
//! Nothing here writes a `Network` field by field: it starts from a document `bnet::read` gave
//! (the empty one, or the file a description was read from) and replaces the nodes, the links, the
//! buffer regime and the population. So whatever else a `Network` holds is carried through. What a
//! file holds beside its `Network` (2.1's scenarios, `bnet::read_scenarios`) is not: a built file
//! is the network as described, with no scenarios.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::dist;
use crate::json::Json;
use crate::model::{Distribution, Link, Network, Node, NodeKind, ServiceConfig, StationPicture};
use crate::results::sha256;

/// The description format's version.
pub const SCHEMA: i64 = 1;

/// Column and row spacing of the automatic layout, in canvas points (the examples' own spacing).
const DX: f64 = 88.0;
const DY: f64 = 90.0;
const ORIGIN: (f64, f64) = (170.0, 200.0);

/// The parameter names a family takes, in the order the app writes them.
pub fn parameter_keys(d: Distribution) -> Vec<&'static str> {
    d.default_parameters().split(',').filter_map(|p| p.split('=').next()).collect()
}

/// The law a new node of this kind starts with (0.90.34's defaults; a new source is Poisson).
fn default_law(kind: NodeKind) -> Distribution {
    if kind == NodeKind::Source {
        Distribution::Poisson
    } else {
        Distribution::Exponential
    }
}

/// A parameter value as the app's parameter text holds it: "1.0", "0.25", "2" for Erlang's k.
fn parameter_number(key: &str, v: f64) -> String {
    if key == "k" && v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v:?}")
    }
}

/// An id derived from `what`: the same description always builds the same file. In the form of a
/// UUID (version 5's bits), upper case as `.bnet` files hold them.
pub fn derived_id(what: &str) -> String {
    let mut b = [0u8; 16];
    b.copy_from_slice(&sha256::digest(format!("qnet-build/{what}").as_bytes())[..16]);
    b[6] = (b[6] & 0x0F) | 0x50;
    b[8] = (b[8] & 0x3F) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5 && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The empty document, as `bnet::read` gives it.
fn empty() -> Network {
    crate::bnet::read(r#"{"nodes":[],"links":[],"infiniteBuffers":true}"#).expect("the empty document reads")
}

type Obj = BTreeMap<String, Json>;

fn object<'a>(v: &'a Json, what: &str) -> Result<&'a Obj, String> {
    v.as_object().ok_or_else(|| format!("{what} must be an object ({{ … }})."))
}

fn present<'a>(m: &'a Obj, key: &str) -> Option<&'a Json> {
    m.get(key).filter(|v| **v != Json::Null)
}

fn text<'a>(m: &'a Obj, key: &str, what: &str) -> Result<Option<&'a str>, String> {
    match present(m, key) {
        None => Ok(None),
        Some(v) => v.as_str().map(Some).ok_or_else(|| format!("{what}: “{key}” must be text.")),
    }
}

fn whole(m: &Obj, key: &str, what: &str) -> Result<Option<i64>, String> {
    match present(m, key) {
        None => Ok(None),
        Some(v) => v.as_i64().map(Some).ok_or_else(|| format!("{what}: “{key}” must be a whole number.")),
    }
}

fn real(m: &Obj, key: &str, what: &str) -> Result<Option<f64>, String> {
    match present(m, key) {
        None => Ok(None),
        Some(v) => v.as_f64().filter(|x| x.is_finite()).map(Some).ok_or_else(|| format!("{what}: “{key}” must be a number.")),
    }
}

/// The distribution and its parameter text from an object holding `distribution`, `parameters`
/// (numbers by name, or the text itself) and optionally `parameterText` (kept when it says the
/// same as `parameters`, so an unedited description writes the file's own text back).
fn law(m: &Obj, kind: NodeKind, what: &str) -> Result<(Distribution, String), String> {
    let d = match text(m, "distribution", what)? {
        None => default_law(kind),
        Some(s) => Distribution::from_raw(s).ok_or_else(|| {
            let known: Vec<&str> = Distribution::ALL.iter().map(|d| d.raw()).collect();
            format!("{what}: there is no distribution called “{s}”. Qnet knows {}.", known.join(", "))
        })?,
    };
    if kind == NodeKind::Station && !d.is_available_for_stations() {
        return Err(format!("{what}: a station's service time cannot be Poisson (that is an arrival process). Use exponential."));
    }
    let keys = parameter_keys(d);
    let parameters = match present(m, "parameters") {
        None => match text(m, "parameterText", what)? {
            Some(t) => t.to_string(),
            None => d.default_parameters().to_string(),
        },
        Some(Json::String(s)) => s.clone(),
        Some(v) => {
            let given = object(v, &format!("{what}: “parameters”"))?;
            let mut values: BTreeMap<String, f64> = dist::parse_params(d.default_parameters());
            for (k, x) in given {
                if !keys.contains(&k.as_str()) {
                    return Err(format!("{what}: {} takes {}, not “{k}”.", article(d.raw()), keys.join(" and ")));
                }
                let x = x.as_f64().filter(|x| x.is_finite()).ok_or_else(|| format!("{what}: the parameter “{k}” must be a number."))?;
                values.insert(k.clone(), x);
            }
            match text(m, "parameterText", what)? {
                Some(t) if dist::parse_params(t) == values => t.to_string(),
                _ => keys.iter().map(|k| format!("{k}={}", parameter_number(k, values[*k]))).collect::<Vec<_>>().join(","),
            }
        }
    };
    Ok((d, parameters))
}

fn article(name: &str) -> String {
    let an = name.starts_with(['a', 'e', 'i', 'o', 'u']);
    format!("{} {name} distribution", if an { "an" } else { "a" })
}

/// Builds the network a description names. `base` is the document the description was read from,
/// when there is one: everything the description does not hold is taken from it.
pub fn from_spec(spec: &Json, base: Option<&Network>) -> Result<Network, String> {
    let top = object(spec, "The description")?;
    if let Some(s) = whole(top, "schema", "The description")? {
        if s != SCHEMA {
            return Err(format!("This description is written for schema {s}; this Qnet reads schema {SCHEMA}."));
        }
    }
    let mut net = base.cloned().unwrap_or_else(empty);
    net.infinite_buffers = match text(top, "buffers", "The description")? {
        None | Some("infinite") => true,
        Some("finite") => false,
        Some(other) => return Err(format!("“buffers” must be \"infinite\" or \"finite\", not “{other}”.")),
    };
    net.population = whole(top, "population", "The description")?;
    if let Some(n) = net.population {
        if n < 1 {
            return Err("“population” must be at least 1.".into());
        }
    }
    if let Some(s) = real(top, "canvasScale", "The description")? {
        net.canvas_scale = s;
    }

    let listed = |key: &str| -> Result<&[Json], String> {
        match present(top, key) {
            None => Ok(&[]),
            Some(v) => v.as_array().ok_or_else(|| format!("“{key}” must be a list.")),
        }
    };
    let mut nodes: Vec<Node> = Vec::new();
    let mut placed: Vec<bool> = Vec::new();
    let mut names = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for (i, v) in listed("nodes")?.iter().enumerate() {
        let m = object(v, &format!("Node {}", i + 1))?;
        let name = text(m, "name", &format!("Node {}", i + 1))?.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| format!("Node {} has no name.", i + 1))?;
        let what = format!("Node “{name}”");
        let kind_text = text(m, "kind", &what)?.ok_or_else(|| format!("{what} has no kind (source, buffer, station or sink)."))?;
        let kind = NodeKind::from_raw(kind_text).ok_or_else(|| format!("{what}: “{kind_text}” is not a kind of node. The kinds are source, buffer, station and sink."))?;
        let id = match text(m, "id", &what)? {
            Some(s) if is_uuid(s) => s.to_ascii_uppercase(),
            Some(s) => return Err(format!("{what}: “{s}” is not an id (a UUID). Leave “id” out and Qnet makes one.")),
            None => derived_id(&format!("node/{name}")),
        };
        if !ids.insert(id.clone()) {
            return Err(format!("Two nodes are called “{name}”. Give each node its own name."));
        }
        names.insert(name.to_string());
        let mut node = Node::new(id, kind, name, ORIGIN);
        (node.distribution, node.parameters) = law(m, kind, &what)?;
        if let Some(c) = whole(m, "servers", &what)? {
            if c < 1 {
                return Err(format!("{what}: “servers” must be at least 1."));
            }
            node.servers = c;
        }
        if let Some(k) = whole(m, "size", &what)? {
            if k < 0 {
                return Err(format!("{what}: “size” cannot be negative."));
            }
            node.buffer_size = k;
        }
        if let Some(p) = text(m, "picture", &what)? {
            node.picture = StationPicture::from_raw(p).ok_or_else(|| format!("{what}: “{p}” is not a station picture Qnet knows."))?;
        }
        if let Some(by_class) = present(m, "serviceByClass") {
            for (key, cfg) in object(by_class, &format!("{what}: “serviceByClass”"))? {
                let class: i64 = key.parse().ok().filter(|c| *c >= 0).ok_or_else(|| format!("{what}: “{key}” is not a class index (0 is the first class)."))?;
                let (distribution, parameters) = law(object(cfg, &format!("{what}, class {key}"))?, NodeKind::Station, &format!("{what}, class {key}"))?;
                node.service_by_class.insert(class, ServiceConfig { distribution, parameters });
            }
        }
        // The model features new in 2.1, under the file's own keys and in its own shapes.
        (node.discipline, node.priority_order, node.batch, node.rate_profile) = crate::bnet::read_extended(m, "").map_err(|e| format!("{what}: “{}”: {}", e.path, e.message))?;
        if node.discipline != crate::model::Discipline::Fcfs && kind != NodeKind::Station {
            return Err(format!("{what}: only a station has a “serviceDiscipline”."));
        }
        if (node.batch.is_some() || node.rate_profile.is_some()) && kind != NodeKind::Source {
            return Err(format!("{what}: only a source has a “batchSize” or a “rateProfile”."));
        }
        if let Some(p) = node.batch.as_ref().and_then(|b| b.problem()).or_else(|| node.rate_profile.as_ref().and_then(|r| r.problem())) {
            return Err(format!("{what}: {p}"));
        }
        match present(m, "position") {
            None => placed.push(false),
            Some(p) => {
                let xy: Vec<f64> = p.as_array().map(|a| a.iter().filter_map(Json::as_f64).collect()).unwrap_or_default();
                if xy.len() < 2 {
                    return Err(format!("{what}: “position” must be [x, y]."));
                }
                node.position = (xy[0], xy[1]);
                placed.push(true);
            }
        }
        nodes.push(node);
    }

    // A link's end is a node's name, or its id.
    let find = |end: &str, what: &str| -> Result<String, String> {
        if let Some(n) = nodes.iter().find(|n| n.id.eq_ignore_ascii_case(end)) {
            return Ok(n.id.clone());
        }
        let named: Vec<&Node> = nodes.iter().filter(|n| n.name == end).collect();
        match named.as_slice() {
            [one] => Ok(one.id.clone()),
            [] => Err(format!("{what}: there is no node called “{end}”.")),
            _ => Err(format!("{what}: more than one node is called “{end}”.")),
        }
    };
    let mut links: Vec<Link> = Vec::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for (i, v) in listed("links")?.iter().enumerate() {
        let what = format!("Link {}", i + 1);
        let m = object(v, &what)?;
        let end = |key: &str| text(m, key, &what)?.ok_or_else(|| format!("{what} has no “{key}”."));
        let (from_name, to_name) = (end("from")?, end("to")?);
        let what = format!("The link from “{from_name}” to “{to_name}”");
        let (from, to) = (find(from_name, &what)?, find(to_name, &what)?);
        let probability = real(m, "probability", &what)?.unwrap_or(1.0);
        if !(0.0..=1.0).contains(&probability) {
            return Err(format!("{what}: a routing probability lies between 0 and 1, and this one is {probability}."));
        }
        let class = whole(m, "class", &what)?.unwrap_or(0);
        let to_class = whole(m, "toClass", &what)?;
        if class < 0 || to_class.is_some_and(|c| c < 0) {
            return Err(format!("{what}: a class index cannot be negative (0 is the first class)."));
        }
        let id = match text(m, "id", &what)? {
            Some(s) if is_uuid(s) => s.to_ascii_uppercase(),
            Some(s) => return Err(format!("{what}: “{s}” is not an id (a UUID). Leave “id” out and Qnet makes one.")),
            None => {
                let key = format!("link/{from}/{to}/{class}");
                let n = seen.entry(key.clone()).or_insert(0);
                *n += 1;
                derived_id(&format!("{key}/{n}"))
            }
        };
        if !ids.insert(id.clone()) {
            return Err(format!("{what}: its id is already used."));
        }
        links.push(Link { id, from, to, probability, class, to_class });
    }

    layout(&mut nodes, &links, &placed);
    net.nodes = nodes;
    net.links = links;
    Ok(net)
}

/// Positions for the nodes that have none: columns by distance from a source (or from the first
/// node, where there is no source), rows centred on the first row.
fn layout(nodes: &mut [Node], links: &[Link], placed: &[bool]) {
    if placed.iter().all(|p| *p) {
        return;
    }
    let index: BTreeMap<&str, usize> = nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    let mut depth: Vec<Option<usize>> = vec![None; nodes.len()];
    let mut queue = VecDeque::new();
    let mut roots: Vec<usize> = (0..nodes.len()).filter(|i| nodes[*i].kind == NodeKind::Source).collect();
    if roots.is_empty() && !nodes.is_empty() {
        roots.push(0);
    }
    for r in roots {
        depth[r] = Some(0);
        queue.push_back(r);
    }
    let mut last = 0;
    loop {
        while let Some(i) = queue.pop_front() {
            let d = depth[i].unwrap_or(0);
            last = last.max(d);
            for l in links.iter().filter(|l| l.from == nodes[i].id) {
                if let Some(&j) = index.get(l.to.as_str()) {
                    if depth[j].is_none() {
                        depth[j] = Some(d + 1);
                        queue.push_back(j);
                    }
                }
            }
        }
        // What no source reaches goes in the columns after the last.
        match depth.iter().position(Option::is_none) {
            Some(i) => {
                depth[i] = Some(last + 1);
                queue.push_back(i);
            }
            None => break,
        }
    }
    let mut columns: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (i, d) in depth.iter().enumerate() {
        columns.entry(d.unwrap_or(0)).or_default().push(i);
    }
    for (d, members) in columns {
        let n = members.len() as f64;
        for (row, i) in members.into_iter().enumerate() {
            if !placed[i] {
                nodes[i].position = (ORIGIN.0 + DX * d as f64, ORIGIN.1 + DY * (row as f64 - (n - 1.0) / 2.0));
            }
        }
    }
}

fn law_json(m: &mut Obj, d: Distribution, parameters: &str) {
    m.insert("distribution".into(), Json::str(d.raw()));
    m.insert("parameterText".into(), Json::str(parameters));
    let keys = parameter_keys(d);
    let values: Obj = dist::parse_params(parameters).into_iter().filter(|(k, v)| keys.contains(&k.as_str()) && v.is_finite()).map(|(k, v)| (k, Json::num(v))).collect();
    m.insert("parameters".into(), Json::Object(values));
}

/// The description of a network, complete enough to build the same file again.
pub fn to_spec(net: &Network) -> Json {
    let mut count: BTreeMap<&str, usize> = BTreeMap::new();
    for n in &net.nodes {
        *count.entry(n.name.as_str()).or_insert(0) += 1;
    }
    // Ends by name where names tell the nodes apart (and are not ids themselves), else by id.
    let by_name = net.nodes.iter().all(|n| count[n.name.as_str()] == 1 && !n.name.trim().is_empty() && n.name.trim() == n.name && !is_uuid(&n.name));
    let end = |id: &str| -> Json {
        match net.node(id) {
            Some(n) if by_name => Json::str(n.name.clone()),
            _ => Json::str(id),
        }
    };
    let nodes = net
        .nodes
        .iter()
        .map(|n| {
            let mut m = Obj::new();
            m.insert("kind".into(), Json::str(n.kind.raw()));
            m.insert("name".into(), Json::str(n.name.clone()));
            m.insert("id".into(), Json::str(n.id.clone()));
            m.insert("position".into(), Json::Array(vec![Json::num(n.position.0), Json::num(n.position.1)]));
            let has_law = matches!(n.kind, NodeKind::Source | NodeKind::Station);
            if has_law || n.distribution != Distribution::Exponential || n.parameters != Distribution::Exponential.default_parameters() {
                law_json(&mut m, n.distribution, &n.parameters);
            }
            if n.kind == NodeKind::Station || n.servers != 1 {
                m.insert("servers".into(), Json::int(n.servers));
            }
            if n.kind == NodeKind::Buffer || n.buffer_size != 1 {
                m.insert("size".into(), Json::int(n.buffer_size));
            }
            if n.picture != StationPicture::None {
                m.insert("picture".into(), Json::str(n.picture.raw()));
            }
            if !n.service_by_class.is_empty() {
                let by_class: Obj = n
                    .service_by_class
                    .iter()
                    .map(|(class, c)| {
                        let mut cm = Obj::new();
                        law_json(&mut cm, c.distribution, &c.parameters);
                        (class.to_string(), Json::Object(cm))
                    })
                    .collect();
                m.insert("serviceByClass".into(), Json::Object(by_class));
            }
            crate::bnet::write_extended(n, &mut m);
            Json::Object(m)
        })
        .collect();
    let links = net
        .links
        .iter()
        .map(|l| {
            let mut m = Obj::new();
            m.insert("from".into(), end(&l.from));
            m.insert("to".into(), end(&l.to));
            m.insert("probability".into(), Json::num(l.probability));
            m.insert("class".into(), Json::int(l.class));
            if let Some(t) = l.to_class {
                m.insert("toClass".into(), Json::int(t));
            }
            m.insert("id".into(), Json::str(l.id.clone()));
            Json::Object(m)
        })
        .collect();
    let mut top = Obj::new();
    top.insert("schema".into(), Json::int(SCHEMA));
    top.insert("buffers".into(), Json::str(if net.infinite_buffers { "infinite" } else { "finite" }));
    top.insert("population".into(), net.population.map(Json::int).unwrap_or(Json::Null));
    if net.canvas_scale != 1.0 {
        top.insert("canvasScale".into(), Json::num(net.canvas_scale));
    }
    top.insert("nodes".into(), Json::Array(nodes));
    top.insert("links".into(), Json::Array(links));
    Json::Object(top)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bnet, json};

    const TANDEM: &str = r#"{ "schema": 1, "buffers": "infinite",
        "nodes": [ { "kind": "source", "name": "Src1", "parameters": { "lambda": 0.8 } },
                   { "kind": "buffer", "name": "B1", "size": 10 },
                   { "kind": "station", "name": "S1", "distribution": "erlang", "parameters": { "k": 3, "rate": 2.5 }, "servers": 2 },
                   { "kind": "sink", "name": "Out" } ],
        "links": [ { "from": "Src1", "to": "B1" }, { "from": "B1", "to": "S1" }, { "from": "S1", "to": "Out" } ] }"#;

    fn build(text: &str) -> Result<Network, String> {
        from_spec(&json::parse(text).unwrap(), None)
    }

    /// New in 2.1: the three model features travel through a description under the file's keys.
    #[test]
    fn priorities_batches_and_rate_profiles_are_described_and_built_back() {
        let text = TANDEM
            .replace(r#""name": "Src1","#, r#""name": "Src1", "batchSize": {"kind": "geometric", "mean": 2.5}, "rateProfile": {"periodic": true, "segments": [{"until": 8, "multiplier": 0.5}, {"until": 24, "multiplier": 1.25}]},"#)
            .replace(r#""servers": 2"#, r#""servers": 2, "serviceDiscipline": "priorityNonPreemptive", "priorityOrder": [0]"#);
        let net = build(&text).unwrap();
        assert_eq!(net.nodes[0].batch, Some(crate::model::BatchSize::Geometric { mean: 2.5 }));
        assert_eq!(net.nodes[0].rate_profile.as_ref().map(|r| (r.periodic, r.segments.len())), Some((true, 2)));
        assert_eq!((net.nodes[2].discipline, net.nodes[2].priority_order.clone()), (crate::model::Discipline::NonPreemptive, vec![0]));
        let spec = to_spec(&net);
        let again = from_spec(&spec, None).unwrap();
        assert_eq!(bnet::write(&again), bnet::write(&net), "described and built again, the same file");
        let plain = to_spec(&build(TANDEM).unwrap());
        let shown = json::to_pretty(&plain);
        assert!(!shown.contains("serviceDiscipline") && !shown.contains("batchSize") && !shown.contains("rateProfile"), "absent unless used");
        let bad = |from: &str, to: &str| build(&TANDEM.replace(from, to)).unwrap_err();
        assert_eq!(bad(r#""name": "B1","#, r#""name": "B1", "serviceDiscipline": "priorityNonPreemptive","#), "Node “B1”: only a station has a “serviceDiscipline”.");
        assert_eq!(bad(r#""servers": 2"#, r#""servers": 2, "batchSize": {"kind": "constant", "size": 2}"#), "Node “S1”: only a source has a “batchSize” or a “rateProfile”.");
        assert_eq!(bad(r#""name": "Src1","#, r#""name": "Src1", "batchSize": {"kind": "pmf", "probabilities": [0.5, 0.2]},"#), "Node “Src1”: The batch-size probabilities sum to 0.7, not 1.");
        assert_eq!(bad(r#""name": "Src1","#, r#""name": "Src1", "batchSize": {"kind": "poisson"},"#), "Node “Src1”: “batchSize.kind”: “poisson” is not a batch-size law Qnet knows (constant, geometric or pmf).");
    }

    #[test]
    fn a_description_builds_a_network_the_app_can_open_and_the_same_one_every_time() {
        let net = build(TANDEM).unwrap();
        assert_eq!(net.nodes.iter().map(|n| n.kind.raw()).collect::<Vec<_>>(), ["source", "buffer", "station", "sink"]);
        assert_eq!((net.nodes[0].distribution, net.nodes[0].parameters.as_str()), (Distribution::Poisson, "lambda=0.8"));
        assert_eq!((net.nodes[2].parameters.as_str(), net.nodes[2].servers, net.nodes[1].buffer_size), ("k=3,rate=2.5", 2, 10));
        assert_eq!(net.links.iter().map(|l| l.probability).collect::<Vec<_>>(), [1.0, 1.0, 1.0]);
        // Left to right, one column per step from the source.
        assert_eq!(net.nodes.iter().map(|n| n.position).collect::<Vec<_>>(), [(170.0, 200.0), (258.0, 200.0), (346.0, 200.0), (434.0, 200.0)]);
        // What is written reads back, and building twice writes the same bytes.
        let written = bnet::write(&net);
        assert_eq!(bnet::read(&written).unwrap(), net);
        assert_eq!(bnet::write(&build(TANDEM).unwrap()), written);
        // The traffic equations see the network that was described: ρ = 0.8 / (2 · 2.5/3).
        let data = crate::traffic::compute(&net.nodes, &net.links, true, false, false).unwrap();
        assert!((data.rho(0) - 0.8 / (2.0 * 2.5 / 3.0)).abs() < 1e-12, "{}", data.rho(0));
    }

    #[test]
    fn describing_and_building_again_gives_the_same_document() {
        let net = build(TANDEM).unwrap();
        let again = from_spec(&to_spec(&net), None).unwrap();
        assert_eq!(bnet::write(&again), bnet::write(&net));
        // An edited parameter is written from its number; an unedited one keeps the file's text.
        let mut spec = to_spec(&net);
        let Json::Object(top) = &mut spec else { unreachable!() };
        let Some(Json::Array(nodes)) = top.get_mut("nodes") else { unreachable!() };
        let Json::Object(source) = &mut nodes[0] else { unreachable!() };
        source.insert("parameters".into(), json::parse(r#"{"lambda": 0.5}"#).unwrap());
        let edited = from_spec(&spec, Some(&net)).unwrap();
        assert_eq!(edited.nodes[0].parameters, "lambda=0.5");
        assert_eq!(edited.nodes[2].parameters, "k=3,rate=2.5");
        assert_eq!(edited.nodes[0].id, net.nodes[0].id);
    }

    #[test]
    fn what_cannot_be_built_is_refused_in_plain_words() {
        let bad = |from: &str, to: &str| build(&TANDEM.replacen(from, to, 1)).unwrap_err();
        assert_eq!(bad("\"kind\": \"sink\"", "\"kind\": \"router\""), "Node “Out”: “router” is not a kind of node. The kinds are source, buffer, station and sink.");
        assert_eq!(bad("\"to\": \"Out\"", "\"to\": \"Exit\""), "The link from “S1” to “Exit”: there is no node called “Exit”.");
        assert_eq!(bad("\"name\": \"Out\"", "\"name\": \"S1\""), "Two nodes are called “S1”. Give each node its own name.");
        assert_eq!(bad("\"k\": 3", "\"shape\": 3"), "Node “S1”: an erlang distribution takes k and rate, not “shape”.");
        assert_eq!(bad("\"servers\": 2", "\"servers\": 0"), "Node “S1”: “servers” must be at least 1.");
        assert_eq!(bad("\"erlang\"", "\"poisson\""), "Node “S1”: a station's service time cannot be Poisson (that is an arrival process). Use exponential.");
        assert_eq!(bad("\"to\": \"Out\"", "\"to\": \"Out\", \"probability\": 1.5"), "The link from “S1” to “Out”: a routing probability lies between 0 and 1, and this one is 1.5.");
        assert_eq!(bad("\"schema\": 1", "\"schema\": 7"), "This description is written for schema 7; this Qnet reads schema 1.");
        assert_eq!(bad("\"infinite\"", "\"some\""), "“buffers” must be \"infinite\" or \"finite\", not “some”.");
    }

    #[test]
    fn a_closed_network_and_a_branch_are_laid_out_without_a_source() {
        let net = build(
            r#"{ "population": 4, "nodes": [ { "kind": "station", "name": "CPU" }, { "kind": "station", "name": "Disk" }, { "kind": "station", "name": "Tape" } ],
                 "links": [ { "from": "CPU", "to": "Disk", "probability": 0.5 }, { "from": "CPU", "to": "Tape", "probability": 0.5 },
                            { "from": "Disk", "to": "CPU" }, { "from": "Tape", "to": "CPU" } ] }"#,
        )
        .unwrap();
        assert_eq!(net.population, Some(4));
        assert!(crate::closed::is_closed(&net));
        assert_eq!(net.nodes.iter().map(|n| n.position).collect::<Vec<_>>(), [(170.0, 200.0), (258.0, 155.0), (258.0, 245.0)]);
        assert_eq!(net.nodes.iter().map(|n| n.id.len()).collect::<Vec<_>>(), [36, 36, 36]);
    }
}
