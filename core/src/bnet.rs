//! Reading and writing `.bnet` files exactly as Qnet 0.90.34 did.
//!
//! Reading follows the `Decodable` code in 0.90.34's `Models.swift`: a node needs `id`, `kind`,
//! `name`, `position`, `bufferSize`, `distribution` and `distributionParameters`, and may leave out
//! `numberOfServers` (1), `serviceDistributions` (none) and `picture` (none); a link needs `id`,
//! `fromNodeID`, `toNodeID` and `routingProbability`, and may leave out `customerClass` (0) and
//! `toCustomerClass`; the document needs `nodes` and `links`, and may leave out `infiniteBuffers`
//! (false), `canvasScale` (1) and `canvasPanOffset` ([0, 0]). A key that is present but `null` counts
//! as left out for the optional fields. Unknown keys are ignored. An unknown `kind`,
//! `distribution` or `picture` makes the file unreadable.
//!
//! Writing follows `TabDocumentWriter.write`: every field (`toCustomerClass` only when there is one),
//! the pan offset always [0, 0], through `json::to_pretty`. A file 0.90.34 wrote reads and writes
//! back byte for byte (tests/golden_bnet.rs checks all 50 examples).
//!
//! New in 2.1: the optional top-level `closedPopulation` (a whole number), the number of customers
//! of a closed network (`closed.rs`). It is read when present and written only when set, so a file
//! without it is unchanged; 0.90.34 and 2.0 ignore the key (unknown keys are ignored) and then see
//! a network with no source.
//!
//! New in 2.1 (ledger SCI-1001, SCI-1010, SCI-1020): three optional node keys, each read when
//! present and written only when the node uses the feature, so every older file re-saves byte for
//! byte; 0.90.34 and 2.0 ignore them (and then see plain FCFS stations and plain sources):
//!
//! ```json
//! "serviceDiscipline" : "priorityNonPreemptive" | "priorityPreemptiveResume",   // a station
//! "priorityOrder" : [ 1, 0 ],                      // class indices, highest priority first
//! "batchSize" : { "kind" : "constant", "size" : 2 }                              // a source
//!             | { "kind" : "geometric", "mean" : 2.5 }
//!             | { "kind" : "pmf", "probabilities" : [ 0.5, 0.3, 0.2 ] },         // sizes 1, 2, 3
//! "rateProfile" : { "periodic" : true, "segments" : [ { "multiplier" : 2, "until" : 8 }, … ] }
//! ```
//!
//! `"serviceDiscipline" : "fcfs"` is read as the key left out (and `priorityOrder` is then
//! dropped). A key of the wrong shape makes the file unreadable, with its path; a value that is
//! well-formed but wrong (probabilities that do not sum to 1, a segment with no length) is read
//! and reported in Problems (`extended::problems`).
//!
//! New in 2.1 (ledger WF-101): the optional top-level `scenarios`, named sets of parameter
//! overrides on this one network (the interface's src/scenarios/). `nodes` and `links` always hold
//! the network as it was last shown — the active scenario's values — so every reader, old or new,
//! solves what the person saw; `scenarios` holds the other variants as overrides of the baseline,
//! and, while a scenario is active, the baseline's own values for the fields it overrides:
//!
//! ```json
//! "scenarios" : {
//!   "active" : "<scenario id>",                 // absent while the baseline is shown
//!   "baseline" : [ <override>, … ],             // with `active`: the baseline's values there
//!   "items" : [ { "id" : "<id>", "name" : "Peak hour", "overrides" : [ <override>, … ] } ]
//! }
//! ```
//!
//! An override is `{ "field", "value" }` with `"node" : <id>` (fields `bufferSize`,
//! `numberOfServers`: whole numbers; `distribution`: `{distribution, distributionParameters}`;
//! `serviceDistributions`: the per-class table), `"link" : <id>` (`routingProbability`: a number)
//! or neither (`closedPopulation`: a whole number, or null for none). The key is carried beside
//! the `Network` (`read_scenarios`, `write_with_scenarios`), which is unchanged, and is written
//! only when there is at least one scenario: a file without scenarios is written exactly as
//! before. 0.90.34 and 2.0 ignore the key, open the network as it was last shown, and drop the
//! scenarios when they save. An override naming a node or link the file does not have is kept as
//! read (the interface drops it); anything malformed makes the file unreadable, with its path.

use std::collections::BTreeMap;

use crate::json::{self, Json};
use crate::model::{BatchSize, Discipline, Distribution, Link, Network, Node, NodeKind, RateProfile, RateSegment, ServiceConfig, StationPicture};

/// Why a file isn't a network, with the path to the field that's wrong ("nodes[3].kind").
#[derive(Clone, Debug, PartialEq)]
pub struct ReadError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

fn fail<T>(path: &str, message: impl Into<String>) -> Result<T, ReadError> {
    Err(ReadError { path: path.to_string(), message: message.into() })
}

/// Reads a `.bnet` document.
pub fn read(text: &str) -> Result<Network, ReadError> {
    let v = json::parse(text).map_err(|e| ReadError { path: String::new(), message: format!("The file isn't valid JSON: {e}.") })?;
    let top = object(&v, "")?;
    let nodes = required(top, "nodes", "")?
        .as_array()
        .ok_or_else(|| ReadError { path: "nodes".into(), message: "Expected a list of nodes.".into() })?
        .iter()
        .enumerate()
        .map(|(i, n)| read_node(n, &format!("nodes[{i}]")))
        .collect::<Result<Vec<_>, _>>()?;
    let links = required(top, "links", "")?
        .as_array()
        .ok_or_else(|| ReadError { path: "links".into(), message: "Expected a list of links.".into() })?
        .iter()
        .enumerate()
        .map(|(i, l)| read_link(l, &format!("links[{i}]")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Network {
        nodes,
        links,
        infinite_buffers: match optional(top, "infiniteBuffers") {
            Some(b) => b.as_bool().ok_or_else(|| ReadError { path: "infiniteBuffers".into(), message: "Expected true or false.".into() })?,
            None => false,
        },
        canvas_scale: match optional(top, "canvasScale") {
            Some(x) => number(x, "canvasScale")?,
            None => 1.0,
        },
        canvas_pan_offset: match optional(top, "canvasPanOffset") {
            Some(p) => pair(p, "canvasPanOffset")?,
            None => (0.0, 0.0),
        },
        population: match optional(top, "closedPopulation") {
            Some(n) => Some(integer(n, "closedPopulation")?),
            None => None,
        },
    })
}

fn object<'a>(v: &'a Json, path: &str) -> Result<&'a BTreeMap<String, Json>, ReadError> {
    v.as_object().ok_or_else(|| ReadError { path: path.to_string(), message: "Expected an object.".into() })
}

fn at(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// A key `decode` requires: absent or null is an error.
fn required<'a>(m: &'a BTreeMap<String, Json>, key: &str, path: &str) -> Result<&'a Json, ReadError> {
    match m.get(key) {
        Some(Json::Null) => fail(&at(path, key), "A value is required, not null."),
        Some(v) => Ok(v),
        None => fail(&at(path, key), "This field is missing."),
    }
}

/// A key `decodeIfPresent` reads: absent or null is none.
fn optional<'a>(m: &'a BTreeMap<String, Json>, key: &str) -> Option<&'a Json> {
    m.get(key).filter(|v| **v != Json::Null)
}

fn number(v: &Json, path: &str) -> Result<f64, ReadError> {
    v.as_f64().ok_or_else(|| ReadError { path: path.to_string(), message: "Expected a number.".into() })
}

fn integer(v: &Json, path: &str) -> Result<i64, ReadError> {
    v.as_i64().ok_or_else(|| ReadError { path: path.to_string(), message: "Expected a whole number.".into() })
}

fn string<'a>(v: &'a Json, path: &str) -> Result<&'a str, ReadError> {
    v.as_str().ok_or_else(|| ReadError { path: path.to_string(), message: "Expected text.".into() })
}

/// A CGPoint or CGSize: an array whose first two entries are numbers (more are ignored).
fn pair(v: &Json, path: &str) -> Result<(f64, f64), ReadError> {
    let a = v.as_array().ok_or_else(|| ReadError { path: path.to_string(), message: "Expected [x, y].".into() })?;
    if a.len() < 2 {
        return fail(path, "Expected [x, y].");
    }
    Ok((number(&a[0], &format!("{path}[0]"))?, number(&a[1], &format!("{path}[1]"))?))
}

/// A UUID as `UUID(uuidString:)` takes one (8-4-4-4-12 hex digits, either case), in upper case.
fn uuid(v: &Json, path: &str) -> Result<String, ReadError> {
    let s = string(v, path)?;
    let groups: Vec<&str> = s.split('-').collect();
    let ok = groups.len() == 5 && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()));
    if !ok {
        return fail(path, format!("“{s}” is not a UUID."));
    }
    Ok(s.to_ascii_uppercase())
}

fn distribution(v: &Json, path: &str) -> Result<Distribution, ReadError> {
    let s = string(v, path)?;
    Distribution::from_raw(s).ok_or_else(|| ReadError { path: path.to_string(), message: format!("“{s}” is not a distribution Qnet knows.") })
}

fn read_node(v: &Json, path: &str) -> Result<Node, ReadError> {
    let m = object(v, path)?;
    let kind_text = string(required(m, "kind", path)?, &at(path, "kind"))?;
    let kind = NodeKind::from_raw(kind_text).ok_or_else(|| ReadError { path: at(path, "kind"), message: format!("“{kind_text}” is not a kind of node.") })?;
    let mut service_by_class = BTreeMap::new();
    if let Some(sd) = optional(m, "serviceDistributions") {
        let sp = at(path, "serviceDistributions");
        for (key, cfg) in object(sd, &sp)? {
            let kp = format!("{sp}.{key}");
            // [Int: …] is keyed by Int(String): "1", "01" and "+1" are all class 1.
            let class: i64 = key.parse().map_err(|_| ReadError { path: kp.clone(), message: "A class index must be a whole number.".into() })?;
            let c = object(cfg, &kp)?;
            let config = ServiceConfig {
                distribution: distribution(required(c, "distribution", &kp)?, &at(&kp, "distribution"))?,
                parameters: string(required(c, "distributionParameters", &kp)?, &at(&kp, "distributionParameters"))?.to_string(),
            };
            service_by_class.entry(class).or_insert(config);
        }
    }
    let picture = match optional(m, "picture") {
        Some(p) => {
            let s = string(p, &at(path, "picture"))?;
            StationPicture::from_raw(s).ok_or_else(|| ReadError { path: at(path, "picture"), message: format!("“{s}” is not a station picture Qnet knows.") })?
        }
        None => StationPicture::None,
    };
    let (discipline, priority_order, batch, rate_profile) = read_extended(m, path)?;
    Ok(Node {
        id: uuid(required(m, "id", path)?, &at(path, "id"))?,
        kind,
        name: string(required(m, "name", path)?, &at(path, "name"))?.to_string(),
        position: pair(required(m, "position", path)?, &at(path, "position"))?,
        buffer_size: integer(required(m, "bufferSize", path)?, &at(path, "bufferSize"))?,
        distribution: distribution(required(m, "distribution", path)?, &at(path, "distribution"))?,
        parameters: string(required(m, "distributionParameters", path)?, &at(path, "distributionParameters"))?.to_string(),
        servers: match optional(m, "numberOfServers") {
            Some(s) => integer(s, &at(path, "numberOfServers"))?,
            None => 1,
        },
        service_by_class,
        picture,
        discipline,
        priority_order,
        batch,
        rate_profile,
    })
}

/// The four keys new in 2.1 of a node object `m` (module text); also what a build description
/// holds under the same names (`build.rs`).
pub(crate) fn read_extended(m: &BTreeMap<String, Json>, path: &str) -> Result<(Discipline, Vec<i64>, Option<BatchSize>, Option<RateProfile>), ReadError> {
    let discipline = match optional(m, "serviceDiscipline") {
        Some(d) => {
            let s = string(d, &at(path, "serviceDiscipline"))?;
            Discipline::from_raw(s).ok_or_else(|| ReadError { path: at(path, "serviceDiscipline"), message: format!("“{s}” is not a service discipline Qnet knows.") })?
        }
        None => Discipline::Fcfs,
    };
    let priority_order = match optional(m, "priorityOrder").filter(|_| discipline != Discipline::Fcfs) {
        Some(o) => {
            let op = at(path, "priorityOrder");
            let list = o.as_array().ok_or_else(|| ReadError { path: op.clone(), message: "Expected a list of class indices.".into() })?;
            list.iter().enumerate().map(|(i, x)| integer(x, &format!("{op}[{i}]"))).collect::<Result<Vec<_>, _>>()?
        }
        None => Vec::new(),
    };
    let batch = match optional(m, "batchSize") {
        Some(b) => Some(read_batch(b, &at(path, "batchSize"))?),
        None => None,
    };
    let rate_profile = match optional(m, "rateProfile") {
        Some(r) => Some(read_profile(r, &at(path, "rateProfile"))?),
        None => None,
    };
    Ok((discipline, priority_order, batch, rate_profile))
}

fn read_batch(v: &Json, path: &str) -> Result<BatchSize, ReadError> {
    let m = object(v, path)?;
    let kind = string(required(m, "kind", path)?, &at(path, "kind"))?;
    match kind {
        "constant" => Ok(BatchSize::Constant(integer(required(m, "size", path)?, &at(path, "size"))?)),
        "geometric" => Ok(BatchSize::Geometric { mean: number(required(m, "mean", path)?, &at(path, "mean"))? }),
        "pmf" => {
            let pp = at(path, "probabilities");
            let list = required(m, "probabilities", path)?.as_array().ok_or_else(|| ReadError { path: pp.clone(), message: "Expected a list of probabilities.".into() })?;
            Ok(BatchSize::Pmf(list.iter().enumerate().map(|(i, x)| number(x, &format!("{pp}[{i}]"))).collect::<Result<_, _>>()?))
        }
        other => fail(&at(path, "kind"), format!("“{other}” is not a batch-size law Qnet knows (constant, geometric or pmf).")),
    }
}

fn read_profile(v: &Json, path: &str) -> Result<RateProfile, ReadError> {
    let m = object(v, path)?;
    let sp = at(path, "segments");
    let list = required(m, "segments", path)?.as_array().ok_or_else(|| ReadError { path: sp.clone(), message: "Expected a list of segments.".into() })?;
    let mut segments = Vec::with_capacity(list.len());
    for (i, item) in list.iter().enumerate() {
        let ip = format!("{sp}[{i}]");
        let o = object(item, &ip)?;
        segments.push(RateSegment { until: number(required(o, "until", &ip)?, &at(&ip, "until"))?, multiplier: number(required(o, "multiplier", &ip)?, &at(&ip, "multiplier"))? });
    }
    let periodic = match optional(m, "periodic") {
        Some(b) => b.as_bool().ok_or_else(|| ReadError { path: at(path, "periodic"), message: "Expected true or false.".into() })?,
        None => false,
    };
    Ok(RateProfile { periodic, segments })
}

fn read_link(v: &Json, path: &str) -> Result<Link, ReadError> {
    let m = object(v, path)?;
    Ok(Link {
        id: uuid(required(m, "id", path)?, &at(path, "id"))?,
        from: uuid(required(m, "fromNodeID", path)?, &at(path, "fromNodeID"))?,
        to: uuid(required(m, "toNodeID", path)?, &at(path, "toNodeID"))?,
        probability: number(required(m, "routingProbability", path)?, &at(path, "routingProbability"))?,
        class: match optional(m, "customerClass") {
            Some(c) => integer(c, &at(path, "customerClass"))?,
            None => 0,
        },
        to_class: match optional(m, "toCustomerClass") {
            Some(c) => Some(integer(c, &at(path, "toCustomerClass"))?),
            None => None,
        },
    })
}

/// The document's `scenarios` in the one form it is written in, or None when the file has none
/// (the key absent, null, or with no items). `read` ignores the key; a caller that saves the
/// document again reads it with this and hands it to `write_with_scenarios`.
pub fn read_scenarios(text: &str) -> Result<Option<Json>, ReadError> {
    let v = json::parse(text).map_err(|e| ReadError { path: String::new(), message: format!("The file isn't valid JSON: {e}.") })?;
    let top = object(&v, "")?;
    let Some(s) = optional(top, "scenarios") else { return Ok(None) };
    let m = object(s, "scenarios")?;
    let mut ids = Vec::new();
    let mut items = Vec::new();
    let list = required(m, "items", "scenarios")?.as_array().ok_or_else(|| ReadError { path: "scenarios.items".into(), message: "Expected a list of scenarios.".into() })?;
    for (i, item) in list.iter().enumerate() {
        let path = format!("scenarios.items[{i}]");
        let o = object(item, &path)?;
        let id = string(required(o, "id", &path)?, &at(&path, "id"))?.to_string();
        if id.is_empty() || ids.contains(&id) {
            return fail(&at(&path, "id"), "Every scenario needs an id of its own.");
        }
        let name = string(required(o, "name", &path)?, &at(&path, "name"))?;
        let mut out = BTreeMap::new();
        out.insert("id".to_string(), Json::str(id.clone()));
        out.insert("name".to_string(), Json::str(name));
        out.insert("overrides".to_string(), read_overrides(required(o, "overrides", &path)?, &at(&path, "overrides"))?);
        ids.push(id);
        items.push(Json::Object(out));
    }
    if items.is_empty() {
        return Ok(None);
    }
    let mut out = BTreeMap::new();
    if let Some(a) = optional(m, "active") {
        let id = string(a, "scenarios.active")?;
        if !ids.iter().any(|x| x == id) {
            return fail("scenarios.active", format!("“{id}” is not one of the scenarios."));
        }
        out.insert("active".to_string(), Json::str(id));
        out.insert(
            "baseline".to_string(),
            match optional(m, "baseline") {
                Some(b) => read_overrides(b, "scenarios.baseline")?,
                None => Json::Array(Vec::new()),
            },
        );
    }
    out.insert("items".to_string(), Json::Array(items));
    Ok(Some(Json::Object(out)))
}

fn read_overrides(v: &Json, path: &str) -> Result<Json, ReadError> {
    let list = v.as_array().ok_or_else(|| ReadError { path: path.to_string(), message: "Expected a list of overrides.".into() })?;
    let mut out = Vec::new();
    for (i, item) in list.iter().enumerate() {
        let p = format!("{path}[{i}]");
        let o = object(item, &p)?;
        let field = string(required(o, "field", &p)?, &at(&p, "field"))?;
        let vp = at(&p, "value");
        let mut m = BTreeMap::new();
        m.insert("field".to_string(), Json::str(field));
        let value = match field {
            "closedPopulation" => match o.get("value") {
                None | Some(Json::Null) => Json::Null,
                Some(n) => Json::int(integer(n, &vp)?),
            },
            "routingProbability" => {
                m.insert("link".to_string(), Json::str(uuid(required(o, "link", &p)?, &at(&p, "link"))?));
                Json::num(number(required(o, "value", &p)?, &vp)?)
            }
            "bufferSize" | "numberOfServers" | "distribution" | "serviceDistributions" => {
                m.insert("node".to_string(), Json::str(uuid(required(o, "node", &p)?, &at(&p, "node"))?));
                let value = required(o, "value", &p)?;
                match field {
                    "distribution" => law_json(value, &vp)?,
                    "serviceDistributions" => {
                        let mut classes = BTreeMap::new();
                        for (key, cfg) in object(value, &vp)? {
                            let kp = format!("{vp}.{key}");
                            let class: i64 = key.parse().map_err(|_| ReadError { path: kp.clone(), message: "A class index must be a whole number.".into() })?;
                            classes.entry(class.to_string()).or_insert(law_json(cfg, &kp)?);
                        }
                        Json::Object(classes)
                    }
                    _ => Json::int(integer(value, &vp)?),
                }
            }
            other => return fail(&at(&p, "field"), format!("“{other}” is not a field a scenario can override.")),
        };
        m.insert("value".to_string(), value);
        out.push(Json::Object(m));
    }
    Ok(Json::Array(out))
}

/// A service or inter-arrival law as a node holds it: `{distribution, distributionParameters}`.
fn law_json(v: &Json, path: &str) -> Result<Json, ReadError> {
    let c = object(v, path)?;
    let mut m = BTreeMap::new();
    m.insert("distribution".to_string(), Json::str(distribution(required(c, "distribution", path)?, &at(path, "distribution"))?.raw()));
    m.insert("distributionParameters".to_string(), Json::str(string(required(c, "distributionParameters", path)?, &at(path, "distributionParameters"))?));
    Ok(Json::Object(m))
}

/// Writes a document as 0.90.34's Save wrote it.
pub fn write(net: &Network) -> String {
    write_with_scenarios(net, None)
}

/// `write`, with the document's scenarios (as `read_scenarios` gave them) when it has any.
pub fn write_with_scenarios(net: &Network, scenarios: Option<&Json>) -> String {
    let mut top = BTreeMap::new();
    if let Some(s) = scenarios {
        top.insert("scenarios".into(), s.clone());
    }
    top.insert("canvasPanOffset".into(), Json::Array(vec![Json::num(0.0), Json::num(0.0)]));
    top.insert("canvasScale".into(), Json::num(net.canvas_scale));
    // New in 2.1: written only for a closed network, so every older file re-saves byte for byte.
    if let Some(n) = net.population {
        top.insert("closedPopulation".into(), Json::int(n));
    }
    top.insert("infiniteBuffers".into(), Json::Bool(net.infinite_buffers));
    top.insert("links".into(), Json::Array(net.links.iter().map(link_json).collect()));
    top.insert("nodes".into(), Json::Array(net.nodes.iter().map(node_json).collect()));
    json::to_pretty(&Json::Object(top))
}

fn node_json(n: &Node) -> Json {
    let mut m = BTreeMap::new();
    m.insert("bufferSize".into(), Json::int(n.buffer_size));
    m.insert("distribution".into(), Json::str(n.distribution.raw()));
    m.insert("distributionParameters".into(), Json::str(n.parameters.clone()));
    m.insert("id".into(), Json::str(n.id.clone()));
    m.insert("kind".into(), Json::str(n.kind.raw()));
    m.insert("name".into(), Json::str(n.name.clone()));
    m.insert("numberOfServers".into(), Json::int(n.servers));
    m.insert("picture".into(), Json::str(n.picture.raw()));
    m.insert("position".into(), Json::Array(vec![Json::num(n.position.0), Json::num(n.position.1)]));
    let mut sd = BTreeMap::new();
    for (class, c) in &n.service_by_class {
        let mut cm = BTreeMap::new();
        cm.insert("distribution".into(), Json::str(c.distribution.raw()));
        cm.insert("distributionParameters".into(), Json::str(c.parameters.clone()));
        sd.insert(class.to_string(), Json::Object(cm));
    }
    m.insert("serviceDistributions".into(), Json::Object(sd));
    write_extended(n, &mut m);
    Json::Object(m)
}

/// The keys new in 2.1, each written only when the node uses the feature.
pub(crate) fn write_extended(n: &Node, m: &mut BTreeMap<String, Json>) {
    if n.discipline != Discipline::Fcfs {
        m.insert("serviceDiscipline".into(), Json::str(n.discipline.raw()));
        m.insert("priorityOrder".into(), Json::Array(n.priority_order.iter().map(|c| Json::int(*c)).collect()));
    }
    if let Some(b) = &n.batch {
        let mut bm = BTreeMap::new();
        match b {
            BatchSize::Constant(k) => {
                bm.insert("kind".into(), Json::str("constant"));
                bm.insert("size".into(), Json::int(*k));
            }
            BatchSize::Geometric { mean } => {
                bm.insert("kind".into(), Json::str("geometric"));
                bm.insert("mean".into(), Json::num(*mean));
            }
            BatchSize::Pmf(p) => {
                bm.insert("kind".into(), Json::str("pmf"));
                bm.insert("probabilities".into(), Json::Array(p.iter().map(|x| Json::num(*x)).collect()));
            }
        }
        m.insert("batchSize".into(), Json::Object(bm));
    }
    if let Some(r) = &n.rate_profile {
        let mut rm = BTreeMap::new();
        rm.insert("periodic".into(), Json::Bool(r.periodic));
        rm.insert(
            "segments".into(),
            Json::Array(
                r.segments
                    .iter()
                    .map(|s| {
                        let mut sm = BTreeMap::new();
                        sm.insert("multiplier".into(), Json::num(s.multiplier));
                        sm.insert("until".into(), Json::num(s.until));
                        Json::Object(sm)
                    })
                    .collect(),
            ),
        );
        m.insert("rateProfile".into(), Json::Object(rm));
    }
}

fn link_json(l: &Link) -> Json {
    let mut m = BTreeMap::new();
    m.insert("customerClass".into(), Json::int(l.class));
    m.insert("fromNodeID".into(), Json::str(l.from.clone()));
    m.insert("id".into(), Json::str(l.id.clone()));
    m.insert("routingProbability".into(), Json::num(l.probability));
    if let Some(t) = l.to_class {
        m.insert("toCustomerClass".into(), Json::int(t));
    }
    m.insert("toNodeID".into(), Json::str(l.to.clone()));
    Json::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL: &str = r#"{"nodes": [
        {"id": "a422afe9-5494-5ebd-bf95-ff3746bbfced", "kind": "source", "name": "Src1", "position": [1, 2.5, 9],
         "bufferSize": 1.0, "distribution": "poisson", "distributionParameters": "lambda=1.0", "numberOfServers": null,
         "serviceDistributions": {"01": {"distribution": "erlang", "distributionParameters": "k=2,rate=1.0"}}, "extra": true}],
      "links": [{"id": "C3778356-2EE7-5F82-8863-B95180B13572", "fromNodeID": "A422AFE9-5494-5EBD-BF95-FF3746BBFCED",
         "toNodeID": "A422AFE9-5494-5EBD-BF95-FF3746BBFCED", "routingProbability": 1}]}"#;

    #[test]
    fn a_minimal_document_takes_the_same_defaults_as_0_90_34() {
        let net = read(SMALL).unwrap();
        let n = &net.nodes[0];
        assert_eq!(n.id, "A422AFE9-5494-5EBD-BF95-FF3746BBFCED", "UUIDs are kept upper case, as JSONEncoder writes them");
        assert_eq!((n.position, n.buffer_size, n.servers, n.picture), ((1.0, 2.5), 1, 1, StationPicture::None));
        assert_eq!(n.service_by_class[&1].distribution, Distribution::Erlang, "\"01\" is class 1");
        assert_eq!((net.links[0].class, net.links[0].to_class), (0, None));
        assert_eq!((net.infinite_buffers, net.canvas_scale, net.canvas_pan_offset), (false, 1.0, (0.0, 0.0)));
    }

    #[test]
    fn what_0_90_34_refused_is_refused_with_the_field_named() {
        let bad = |from: &str, to: &str| read(&SMALL.replacen(from, to, 1)).unwrap_err();
        assert_eq!(bad("\"kind\": \"source\"", "\"kind\": \"router\"").path, "nodes[0].kind");
        assert_eq!(bad("\"poisson\"", "\"hyperexp\"").path, "nodes[0].distribution");
        assert_eq!(bad("\"numberOfServers\": null", "\"picture\": \"star.fill\"").path, "nodes[0].picture");
        assert_eq!(bad("\"bufferSize\": 1.0", "\"bufferSize\": 1.5").path, "nodes[0].bufferSize");
        assert_eq!(bad("\"bufferSize\": 1.0", "\"bufferSize\": null").message, "A value is required, not null.");
        assert_eq!(bad("\"routingProbability\": 1", "\"routingProbability\": \"1\"").path, "links[0].routingProbability");
        assert_eq!(bad("a422afe9-5494", "a422afe9_5494").path, "nodes[0].id");
        assert_eq!(bad("[1, 2.5, 9]", "{\"x\": 1, \"y\": 2}").path, "nodes[0].position");
        assert_eq!(bad("\"01\"", "\"one\"").path, "nodes[0].serviceDistributions.one");
        assert!(read("[]").is_err() && read("{\"nodes\": []}").unwrap_err().path == "links");
    }

    #[test]
    fn writing_adds_the_defaults_and_always_saves_the_pan_offset_as_zero() {
        let mut net = read(SMALL).unwrap();
        net.canvas_pan_offset = (40.0, -12.0);
        let out = write(&net);
        assert!(out.starts_with("{\n  \"canvasPanOffset\" : [\n    0,\n    0\n  ],\n  \"canvasScale\" : 1,\n  \"infiniteBuffers\" : false,"), "{out}");
        assert!(out.contains("\"numberOfServers\" : 1,\n      \"picture\" : \"\",\n      \"position\" : [\n        1,\n        2.5\n      ],"));
        assert!(out.contains("\"serviceDistributions\" : {\n        \"1\" : {\n          \"distribution\" : \"erlang\","));
        assert!(!out.contains("toCustomerClass"), "absent unless the link changes class");
        assert_eq!(read(&out).unwrap().nodes, net.nodes, "what is written reads back the same");
    }

    /// New in 2.1 (ledger SCI-501): a closed network's population.
    #[test]
    fn the_population_is_optional_and_a_file_without_it_is_written_without_it() {
        let open = read(SMALL).unwrap();
        assert_eq!(open.population, None);
        assert!(!write(&open).contains("closedPopulation"), "an open network's file is 0.90.34's, key for key");
        let mut closed = open.clone();
        closed.population = Some(8);
        let out = write(&closed);
        assert!(out.starts_with("{\n  \"canvasPanOffset\" : [\n    0,\n    0\n  ],\n  \"canvasScale\" : 1,\n  \"closedPopulation\" : 8,\n  \"infiniteBuffers\" : false,"), "{out}");
        assert_eq!(read(&out).unwrap(), Network { canvas_pan_offset: (0.0, 0.0), ..closed.clone() });
        assert_eq!(write(&read(&out).unwrap()), out, "and re-saves byte for byte");
        // null counts as left out, like the other optional keys; anything but a whole number is refused.
        assert_eq!(read(&out.replace("\"closedPopulation\" : 8", "\"closedPopulation\" : null")).unwrap().population, None);
        assert_eq!(read(&out.replace("\"closedPopulation\" : 8", "\"closedPopulation\" : 2.5")).unwrap_err().path, "closedPopulation");
    }

    /// New in 2.1 (ledger SCI-1001, SCI-1010, SCI-1020): the three optional node keys.
    #[test]
    fn disciplines_batches_and_rate_profiles_are_optional_and_round_trip() {
        let plain = read(SMALL).unwrap();
        let out0 = write(&plain);
        for key in ["serviceDiscipline", "priorityOrder", "batchSize", "rateProfile"] {
            assert!(!out0.contains(key), "{key} is written only when used");
        }
        let with = |extra: &str| SMALL.replacen("\"extra\": true", extra, 1);
        let text = with(r#""serviceDiscipline": "priorityPreemptiveResume", "priorityOrder": [1, 0.0], "batchSize": {"kind": "pmf", "probabilities": [0.5, 0.25, 0.25]}, "rateProfile": {"periodic": true, "segments": [{"until": 8, "multiplier": 0.5}, {"until": 24, "multiplier": 2}]}"#);
        let net = read(&text).unwrap();
        let n = &net.nodes[0];
        assert_eq!((n.discipline, n.priority_order.clone()), (Discipline::PreemptiveResume, vec![1, 0]));
        assert_eq!(n.batch, Some(BatchSize::Pmf(vec![0.5, 0.25, 0.25])));
        assert_eq!(n.rate_profile, Some(RateProfile { periodic: true, segments: vec![RateSegment { until: 8.0, multiplier: 0.5 }, RateSegment { until: 24.0, multiplier: 2.0 }] }));
        let out = write(&net);
        assert!(out.contains("\"priorityOrder\" : [\n        1,\n        0\n      ],") && out.contains("\"serviceDiscipline\" : \"priorityPreemptiveResume\""), "{out}");
        assert!(out.contains("\"batchSize\" : {\n        \"kind\" : \"pmf\",\n        \"probabilities\" : ["), "{out}");
        assert!(out.contains("\"rateProfile\" : {\n        \"periodic\" : true,\n        \"segments\" : [\n          {\n            \"multiplier\" : 0.5,\n            \"until\" : 8\n          },"), "{out}");
        assert_eq!(read(&out).unwrap().nodes, net.nodes);
        assert_eq!(write(&read(&out).unwrap()), out, "and re-saves byte for byte");
        // The other two batch laws; fcfs written out is the key left out, and drops the order.
        for (json, law) in [(r#"{"kind": "constant", "size": 2}"#, BatchSize::Constant(2)), (r#"{"kind": "geometric", "mean": 2.5}"#, BatchSize::Geometric { mean: 2.5 })] {
            let net = read(&with(&format!("\"batchSize\": {json}"))).unwrap();
            assert_eq!(net.nodes[0].batch, Some(law));
            assert_eq!(read(&write(&net)).unwrap().nodes, net.nodes);
        }
        let fcfs = read(&with(r#""serviceDiscipline": "fcfs", "priorityOrder": [1, 0], "batchSize": null"#)).unwrap();
        assert_eq!(write(&fcfs), out0);
        // Wrong shapes are refused with the field named; wrong values are read (Problems reports them).
        let bad = |extra: &str| read(&with(extra)).unwrap_err().path;
        assert_eq!(bad(r#""serviceDiscipline": "lifo""#), "nodes[0].serviceDiscipline");
        assert_eq!(bad(r#""serviceDiscipline": "priorityNonPreemptive", "priorityOrder": [0.5]"#), "nodes[0].priorityOrder[0]");
        assert_eq!(bad(r#""batchSize": {"kind": "poisson"}"#), "nodes[0].batchSize.kind");
        assert_eq!(bad(r#""batchSize": {"kind": "constant", "size": 1.5}"#), "nodes[0].batchSize.size");
        assert_eq!(bad(r#""batchSize": {"kind": "pmf", "probabilities": [0.5, "x"]}"#), "nodes[0].batchSize.probabilities[1]");
        assert_eq!(bad(r#""rateProfile": {"segments": [{"until": 1}]}"#), "nodes[0].rateProfile.segments[0].multiplier");
        assert_eq!(bad(r#""rateProfile": {"periodic": 1, "segments": []}"#), "nodes[0].rateProfile.periodic");
        assert!(read(&with(r#""batchSize": {"kind": "pmf", "probabilities": [0.5, 0.2]}"#)).unwrap().nodes[0].batch.as_ref().unwrap().problem().is_some());
    }

    const NODE: &str = "A422AFE9-5494-5EBD-BF95-FF3746BBFCED";
    const LINK: &str = "C3778356-2EE7-5F82-8863-B95180B13572";

    fn with_scenarios(scenarios: &str) -> String {
        SMALL.replacen("{\"nodes\"", &format!("{{\"scenarios\": {scenarios}, \"nodes\""), 1)
    }

    fn resave(text: &str) -> String {
        write_with_scenarios(&read(text).unwrap(), read_scenarios(text).unwrap().as_ref())
    }

    /// New in 2.1 (ledger WF-101): scenarios ride beside the network, and only when there are some.
    #[test]
    fn scenarios_are_optional_and_a_file_without_them_is_written_without_them() {
        assert_eq!(read_scenarios(SMALL).unwrap(), None);
        assert_eq!(resave(SMALL), write(&read(SMALL).unwrap()), "no scenarios: the file is 0.90.34's, key for key");
        for empty in ["null", "{\"items\": []}"] {
            let text = with_scenarios(empty);
            assert_eq!(read_scenarios(&text).unwrap(), None, "{empty}");
            assert_eq!(resave(&text), write(&read(SMALL).unwrap()), "{empty}: nothing is written for no scenarios");
        }
    }

    #[test]
    fn scenarios_round_trip_byte_for_byte_and_leave_the_network_alone() {
        let text = with_scenarios(&format!(
            r#"{{"active": "S-1", "extra": 1,
                "baseline": [{{"node": "{n}", "field": "numberOfServers", "value": 1.0}}],
                "items": [{{"id": "S-1", "name": "Add a server", "overrides": [
                    {{"node": "{n}", "field": "numberOfServers", "value": 2, "note": "dropped"}},
                    {{"node": "{n}", "field": "bufferSize", "value": 10}},
                    {{"node": "{n}", "field": "distribution", "value": {{"distribution": "erlang", "distributionParameters": "k=2,rate=3"}}}},
                    {{"node": "{n}", "field": "serviceDistributions", "value": {{"01": {{"distribution": "exponential", "distributionParameters": "rate=2"}}}}}},
                    {{"link": "{l}", "field": "routingProbability", "value": 0.25}},
                    {{"field": "closedPopulation", "value": 12}},
                    {{"field": "closedPopulation", "value": null}}]}},
                  {{"id": "S-2", "name": "Peak hour", "overrides": []}}]}}"#,
            n = NODE.to_ascii_lowercase(),
            l = LINK
        ));
        assert_eq!(read(&text).unwrap(), read(SMALL).unwrap(), "the network is read as if the key were not there");
        let out = resave(&text);
        assert!(out.starts_with("{\n  \"canvasPanOffset\" : ["), "{out}");
        assert!(out.contains("\n  \"scenarios\" : {\n    \"active\" : \"S-1\",\n    \"baseline\" : [\n      {\n        \"field\" : \"numberOfServers\",\n"), "{out}");
        assert!(out.contains(&format!("\"node\" : \"{NODE}\"")), "ids are written upper case, as the nodes' are");
        assert!(out.contains("\"1\" : {\n") && !out.contains("\"01\""), "class keys are written as the nodes' are");
        assert!(!out.contains("extra") && !out.contains("dropped"), "unknown keys are not carried");
        assert!(out.contains("\"field\" : \"closedPopulation\",\n            \"value\" : null"), "{out}");
        assert_eq!(resave(&out), out, "and re-saves byte for byte");
        let without = write(&read(&out).unwrap());
        assert_eq!(without, write(&read(SMALL).unwrap()), "a reader that does not know the key sees the plain network");
    }

    #[test]
    fn malformed_scenarios_are_refused_with_the_field_named() {
        let bad = |s: &str| read_scenarios(&with_scenarios(s)).unwrap_err().path;
        assert_eq!(bad("[]"), "scenarios");
        assert_eq!(bad("{}"), "scenarios.items");
        assert_eq!(bad(r#"{"items": [{"id": "a", "overrides": []}]}"#), "scenarios.items[0].name");
        assert_eq!(bad(r#"{"items": [{"id": "a", "name": "A", "overrides": []}, {"id": "a", "name": "B", "overrides": []}]}"#), "scenarios.items[1].id");
        assert_eq!(bad(r#"{"active": "b", "items": [{"id": "a", "name": "A", "overrides": []}]}"#), "scenarios.active");
        let item = |o: &str| format!(r#"{{"items": [{{"id": "a", "name": "A", "overrides": [{o}]}}]}}"#);
        assert_eq!(bad(&item(r#"{"field": "name", "value": "x"}"#)), "scenarios.items[0].overrides[0].field");
        assert_eq!(bad(&item(r#"{"field": "numberOfServers", "value": 2}"#)), "scenarios.items[0].overrides[0].node");
        assert_eq!(bad(&item(&format!(r#"{{"node": "{NODE}", "field": "numberOfServers", "value": 2.5}}"#))), "scenarios.items[0].overrides[0].value");
        assert_eq!(bad(&item(&format!(r#"{{"node": "{NODE}", "field": "distribution", "value": {{"distribution": "hyperexp", "distributionParameters": ""}}}}"#))), "scenarios.items[0].overrides[0].value.distribution");
        assert_eq!(bad(&item(r#"{"link": "x", "field": "routingProbability", "value": 1}"#)), "scenarios.items[0].overrides[0].link");
        // With a scenario active, a missing `baseline` is an empty one.
        let s = read_scenarios(&with_scenarios(r#"{"active": "a", "items": [{"id": "a", "name": "A", "overrides": []}]}"#)).unwrap().unwrap();
        assert_eq!(s.as_object().unwrap()["baseline"], Json::Array(Vec::new()));
    }
}
