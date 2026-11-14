//! Network ▸ Insert Archetype… and File ▸ New from Archetype…: the archetype the gallery asks for,
//! built by core's port of 0.90.34's `NetworkArchetypeBuilder` (core/src/generate/archetypes.rs,
//! golden/generators). The interface inserts it with `editor.insertSubnetwork` (one undo step),
//! which renames, re-classes and places it, as 0.90.34's `syncArchetypePanel` did.

use serde::{Deserialize, Serialize};

use qnet_core::generate::{self, Archetype, ArchetypeParameters, CANVAS_ORIGIN};

use crate::errors::QnError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchetypeRequest {
    /// 0.90.34's raw value: "mmcStation", "tandemLine", "forkStyleSplit", "openJacksonFeedback",
    /// "reentrantTwoStation".
    pub kind: String,
    pub stations: i64,
    pub servers: i64,
    pub target_rho: f64,
    pub feedback_probability: f64,
    pub infinite_buffers: bool,
    pub buffer_capacity: i64,
    pub arrival_rate: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltArchetype {
    /// The network as a .bnet document (core's writer), placed at the builder's canvas origin.
    pub text: String,
    /// "3 stations, 8 nodes, 7 links, λ = 1.000, ρ = 0.900 at every station".
    pub summary: String,
    /// Where `insertSubnetwork` puts the block's top-left corner on an empty canvas.
    pub origin: (f64, f64),
}

/// An upper-case version-4 UUID, as 0.90.34's `UUID()` gave every node and link.
fn random_uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn parameters(r: &ArchetypeRequest) -> ArchetypeParameters {
    ArchetypeParameters {
        stations: r.stations,
        servers: r.servers,
        target_rho: r.target_rho,
        feedback_probability: r.feedback_probability,
        infinite_buffers: r.infinite_buffers,
        buffer_capacity: r.buffer_capacity,
        arrival_rate: r.arrival_rate,
    }
}

pub fn build_with(request: &ArchetypeRequest, ids: &mut impl generate::IdSource) -> Result<BuiltArchetype, QnError> {
    let kind = Archetype::from_raw(&request.kind).ok_or_else(|| QnError::invalid(format!("“{}” isn't an archetype Qnet knows.", request.kind)))?;
    let p = parameters(request);
    let net = generate::archetype(kind, &p, ids);
    Ok(BuiltArchetype { text: qnet_core::bnet::write(&net), summary: generate::summary(kind, &p), origin: CANVAS_ORIGIN })
}

#[tauri::command]
pub fn network_archetype(request: ArchetypeRequest) -> Result<BuiltArchetype, QnError> {
    build_with(&request, &mut random_uuid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use qnet_core::generate::CountingIds;

    fn request(kind: &str) -> ArchetypeRequest {
        ArchetypeRequest { kind: kind.into(), stations: 3, servers: 1, target_rho: 0.9, feedback_probability: 0.3, infinite_buffers: true, buffer_capacity: 10, arrival_rate: 1.0 }
    }

    #[test]
    fn the_command_builds_what_core_builds_at_the_catalogue_defaults() {
        for kind in ["mmcStation", "tandemLine", "forkStyleSplit", "openJacksonFeedback", "reentrantTwoStation"] {
            let built = build_with(&request(kind), &mut CountingIds::new()).unwrap();
            let want = qnet_core::bnet::write(&generate::archetype(Archetype::from_raw(kind).unwrap(), &ArchetypeParameters::default(), &mut CountingIds::new()));
            assert_eq!(built.text, want, "{kind}");
            assert_eq!(built.origin, (80.0, 220.0));
        }
        let tandem = build_with(&request("tandemLine"), &mut CountingIds::new()).unwrap();
        assert_eq!(tandem.summary, "3 stations, 8 nodes, 7 links, λ = 1.000, ρ = 0.900 at every station");
        let one = build_with(&request("mmcStation"), &mut CountingIds::new()).unwrap();
        assert_eq!(one.summary, "1 station, 4 nodes, 3 links, λ = 1.000, ρ = 0.900 at every station");
    }

    #[test]
    fn an_unknown_archetype_is_refused() {
        assert!(build_with(&request("ring"), &mut CountingIds::new()).is_err());
    }
}
