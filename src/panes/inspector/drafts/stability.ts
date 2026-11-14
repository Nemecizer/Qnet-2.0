// A station's load under the inspector's draft (0.90.34 `StationStabilityReadout`,
// `NetworkEditorModel.stabilityReadout`; ledger INS-031…036, INV-022). The traffic equations are
// Rust's (src-tauri/src/inspector.rs → core's editor::stability_readout); this asks and shapes.
import type { BnetLink, BnetNode } from "../../../lib/bnet";
import { api } from "../../../lib/api";

export interface Stability {
  /** λ into the station, every class. */
  arrivalRate: number;
  /** c·μ. */
  capacity: number;
  servers: number;
  /** Class index → λ, for the classes with a finite λ > 0 here. */
  arrivalRatePerClass: ReadonlyMap<number, number>;
  /** λ / (c·μ), null without capacity. */
  utilisation: number | null;
  /** ρ ≥ 1. */
  isUnstable: boolean;
  /** ρ ≥ 0.95, the heavy-traffic advisory. */
  isHeavy: boolean;
}

/** The readout for `stationId` under `nodes`, or null (no source, the equations fail, the call fails). */
export async function stabilityOf(stationId: string, nodes: readonly BnetNode[], links: readonly BnetLink[], infiniteBuffers: boolean): Promise<Stability | null> {
  try {
    const r = await api.inspectorStability(stationId, nodes, links, infiniteBuffers);
    if (!r) return null;
    const rho = r.capacity > 1e-12 && Number.isFinite(r.arrivalRate / r.capacity) ? r.arrivalRate / r.capacity : null;
    return {
      arrivalRate: r.arrivalRate,
      capacity: r.capacity,
      servers: r.servers,
      arrivalRatePerClass: new Map(r.arrivalRatePerClass),
      utilisation: rho,
      isUnstable: (rho ?? 0) >= 1,
      isHeavy: (rho ?? 0) >= 0.95,
    };
  } catch {
    return null;
  }
}
