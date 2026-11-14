// A network as the interface holds it: the `.bnet` JSON object itself, with 0.90.34's field
// names, so opening is `JSON.parse` of what Rust read (src-tauri/src/documents.rs) and saving
// sends it back for core's writer. The fields are those of core/src/bnet.rs; the canvas (P5)
// edits them, and nothing here computes with them (Rust owns the arithmetic, PLAN.md §3).

export type NodeKind = "source" | "buffer" | "station" | "sink";

export interface ServiceConfig {
  distribution: string;
  distributionParameters: string;
}

export interface BnetNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** The node's centre in canvas points, [x, y]. */
  position: [number, number];
  bufferSize: number;
  distribution: string;
  /** "key=value,key=value", e.g. "rate=1.0". */
  distributionParameters: string;
  numberOfServers: number;
  /** Per-class service laws, keyed by the class index as text ("0", "1"…). */
  serviceDistributions: Record<string, ServiceConfig>;
  /** An SF Symbol name, or "" for none (the picture table is P5's). */
  picture: string;
  /** A station's order of service (new in 2.1; core/src/bnet.rs). Absent for first come, first served. */
  serviceDiscipline?: ServiceDiscipline;
  /** With a priority discipline: the class indices, the highest priority first. */
  priorityOrder?: number[];
  /** A source's batch-size law (new in 2.1). Absent when customers arrive one at a time. */
  batchSize?: BatchSize;
  /** A source's piecewise-constant rate profile (new in 2.1). Absent for a constant rate. */
  rateProfile?: RateProfile;
}

/** core/src/model.rs `Discipline` (its raw values). */
export type ServiceDiscipline = "fcfs" | "priorityNonPreemptive" | "priorityPreemptiveResume";

/** core/src/model.rs `BatchSize`, as the file holds it. `probabilities[i]` is P(size = i + 1). */
export type BatchSize = { kind: "constant"; size: number } | { kind: "geometric"; mean: number } | { kind: "pmf"; probabilities: number[] };

/** core/src/model.rs `RateProfile`: the rate is `multiplier` × the source's own until `until`. */
export interface RateProfile {
  periodic: boolean;
  segments: { until: number; multiplier: number }[];
}

export interface BnetLink {
  id: string;
  fromNodeID: string;
  toNodeID: string;
  routingProbability: number;
  customerClass: number;
  toCustomerClass?: number;
}

export interface BnetDocument {
  nodes: BnetNode[];
  links: BnetLink[];
  infiniteBuffers: boolean;
  canvasScale: number;
  /** Always [0, 0] when 0.90.34 saved (ledger FILE rows); kept for reading. */
  canvasPanOffset: [number, number];
  /** A closed network's number of circulating customers (new in 2.1; core/src/closed.rs). Absent for an open network. */
  closedPopulation?: number;
  /**
   * Named variants of this network (new in 2.1; src/scenarios/model.ts, core/src/bnet.rs). Absent
   * when there are none. `nodes` and `links` always hold the values of the scenario being shown.
   */
  scenarios?: import("../scenarios/model").ScenarioSet;
}

/** A new tab's empty network (0.90.34 `NetworkEditorModel`: finite buffers, scale 1). */
export function emptyDocument(): BnetDocument {
  return { nodes: [], links: [], infiniteBuffers: false, canvasScale: 1, canvasPanOffset: [0, 0] };
}

/** No nodes and no links: a blank canvas (ledger WS-045's "blank Untitled tab"). */
export function isBlank(doc: BnetDocument): boolean {
  return doc.nodes.length === 0 && doc.links.length === 0;
}

/** A document read from Rust's text (src/lib/types.ts `OpenedDocument.text`). */
export function parseDocument(text: string): BnetDocument {
  return JSON.parse(text) as BnetDocument;
}

/** A new upper-case UUID, the form 0.90.34's `UUID().uuidString` wrote. */
export function newId(): string {
  return crypto.randomUUID().toUpperCase();
}
