// The browser preview's archetype builder: a TypeScript copy of core's port of 0.90.34's
// `NetworkArchetypeBuilder` (core/src/generate/archetypes.rs), so the mock's `network_archetype`
// answers with 0.90.34's exact network and summary for any parameters, and Vitest can replay
// golden/edits/archetype-insert. The app itself builds in Rust; src/windows/archetypes/
// builder.test.ts checks this copy against all 45 networks and 40 summaries in
// golden/generators, ids aside.
import type { BnetDocument, BnetLink, BnetNode, NodeKind } from "../../lib/bnet";
import type { ArchetypeRequest, BuiltArchetype } from "../../lib/types";
import { cExp, cFixed, displayFixed } from "../../editor/numbers";

// RandomNetworkGenerator.Layout and NetworkArchetypeBuilder's constants.
const Y_ROW = 220;
const X_SOURCE_COLUMN = 80;
const X_ROW_START = 200;
const X_STEP = 130;
const SINK_GAP = 40;
const BRANCH_OFFSET = 90;
export const CANVAS_ORIGIN: [number, number] = [X_SOURCE_COLUMN, Y_ROW];

/** Swift's `max`/`min` on Doubles (`y >= x ? y : x`), NaN behaviour kept. */
const swiftMax = (x: number, y: number) => (y >= x ? y : x);
const swiftMin = (x: number, y: number) => (y < x ? y : x);
const clampF = (x: number, lo: number, hi: number) => swiftMin(swiftMax(x, lo), hi);
const clampI = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** `ArchetypeParameters.clamped()`. */
export function clampedParameters(r: ArchetypeRequest): ArchetypeRequest {
  return {
    ...r,
    stations: clampI(r.stations, 1, 12),
    servers: clampI(r.servers, 1, 16),
    targetRho: clampF(r.targetRho, 0.05, 0.99),
    feedbackProbability: clampF(r.feedbackProbability, 0.0, 0.9),
    bufferCapacity: clampI(r.bufferCapacity, 1, 500),
    arrivalRate: clampF(r.arrivalRate, 0.001, 1000.0),
  };
}

/** C's `%.<p>g`. */
export function cG(value: number, p: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf";
  const exp = cExp(value, p - 1);
  const e = Number(exp.slice(exp.indexOf("e") + 1));
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (e < -4 || e >= p) {
    const [m, x] = exp.split("e");
    return `${strip(m)}e${x}`;
  }
  return strip(cFixed(value, p - 1 - e));
}

/** `rateLiteral`: `%.8g` with ".0" when there is no point or exponent. */
export function rateLiteral(value: number): string {
  const t = cG(value, 8);
  return t.includes(".") || t.includes("e") ? t : `${t}.0`;
}

const serviceRate = (alpha: number, p: ArchetypeRequest) => alpha / (p.targetRho * p.servers);

class Assembly {
  nodes: BnetNode[] = [];
  links: BnetLink[] = [];
  constructor(
    private p: ArchetypeRequest,
    private nextId: () => string,
  ) {}

  private point(x: number, row: number): [number, number] {
    return [x, Y_ROW + row * BRANCH_OFFSET];
  }

  private node(kind: NodeKind, name: string, position: [number, number]): BnetNode {
    return { id: this.nextId(), kind, name, position, bufferSize: 1, distribution: "exponential", distributionParameters: "rate=1.0", numberOfServers: 1, serviceDistributions: {}, picture: "" };
  }

  addSource(rate: number): number {
    const n = this.node("source", "Src1", this.point(X_SOURCE_COLUMN, 0));
    n.distribution = "poisson";
    n.distributionParameters = `lambda=${rateLiteral(rate)}`;
    this.nodes.push(n);
    return this.nodes.length - 1;
  }

  addStage(index: number, column: number, row: number, mu: number): { buffer: number; station: number } {
    const xB = X_ROW_START + column * X_STEP;
    const buffer = this.node("buffer", `B${index}`, this.point(xB, row));
    buffer.bufferSize = this.p.infiniteBuffers ? 1 : this.p.bufferCapacity;
    const station = this.node("station", `S${index}`, this.point(xB + X_STEP / 2, row));
    station.numberOfServers = this.p.servers;
    station.distributionParameters = `rate=${rateLiteral(mu)}`;
    this.nodes.push(buffer, station);
    const stage = { buffer: this.nodes.length - 2, station: this.nodes.length - 1 };
    this.link(stage.buffer, stage.station, 1.0);
    return stage;
  }

  addSink(column: number): number {
    this.nodes.push(this.node("sink", "Sink1", this.point(X_ROW_START + column * X_STEP + SINK_GAP, 0)));
    return this.nodes.length - 1;
  }

  link(from: number, to: number, probability: number) {
    this.links.push({ id: this.nextId(), fromNodeID: this.nodes[from].id, toNodeID: this.nodes[to].id, routingProbability: probability, customerClass: 0 });
  }
}

function chain(a: Assembly, p: ArchetypeRequest, d: number) {
  const source = a.addSource(p.arrivalRate);
  const mu = serviceRate(p.arrivalRate, p);
  let previous = source;
  for (let i = 0; i < d; i++) {
    const stage = a.addStage(i + 1, i, 0, mu);
    a.link(previous, stage.buffer, 1.0);
    previous = stage.station;
  }
  a.link(previous, a.addSink(d), 1.0);
}

function rework(a: Assembly, p: ArchetypeRequest) {
  const forward = 1.0 - p.feedbackProbability;
  const mu = serviceRate(p.arrivalRate / swiftMax(forward, 1e-9), p);
  const source = a.addSource(p.arrivalRate);
  const stages = Array.from({ length: p.stations }, (_, i) => a.addStage(i + 1, i, 0, mu));
  const sink = a.addSink(p.stations);
  a.link(source, stages[0].buffer, 1.0);
  stages.forEach((stage, i) => {
    if (p.feedbackProbability > 0) a.link(stage.station, stage.buffer, p.feedbackProbability);
    a.link(stage.station, i + 1 < stages.length ? stages[i + 1].buffer : sink, forward);
  });
}

function reentrantPair(a: Assembly, p: ArchetypeRequest) {
  const forward = 1.0 - p.feedbackProbability;
  const mu = serviceRate(p.arrivalRate / swiftMax(forward, 1e-9), p);
  const source = a.addSource(p.arrivalRate);
  const first = a.addStage(1, 0, 0, mu);
  const second = a.addStage(2, 1, 0, mu);
  const sink = a.addSink(2);
  a.link(source, first.buffer, 1.0);
  a.link(first.station, second.buffer, 1.0);
  if (p.feedbackProbability > 0) a.link(second.station, first.buffer, p.feedbackProbability);
  a.link(second.station, sink, forward);
}

function fork(a: Assembly, p: ArchetypeRequest) {
  const half = 0.5;
  const source = a.addSource(p.arrivalRate);
  const entry = a.addStage(1, 0, 0, serviceRate(p.arrivalRate, p));
  const branch = serviceRate(p.arrivalRate * half, p);
  const upper = a.addStage(2, 1, -1, branch);
  const lower = a.addStage(3, 1, 1, branch);
  const sink = a.addSink(2);
  a.link(source, entry.buffer, 1.0);
  a.link(entry.station, upper.buffer, half);
  a.link(entry.station, lower.buffer, half);
  a.link(upper.station, sink, 1.0);
  a.link(lower.station, sink, 1.0);
}

/** `NetworkArchetypeBuilder.build(_:_:)` at the canvas origin; ids drawn in build order. */
export function buildArchetypeDocument(request: ArchetypeRequest, nextId: () => string): BnetDocument {
  const p = clampedParameters(request);
  const a = new Assembly(p, nextId);
  if (p.kind === "mmcStation") chain(a, p, 1);
  else if (p.kind === "tandemLine") chain(a, p, p.stations);
  else if (p.kind === "openJacksonFeedback") rework(a, p);
  else if (p.kind === "reentrantTwoStation") reentrantPair(a, p);
  else if (p.kind === "forkStyleSplit") fork(a, p);
  else throw { kind: "invalid", message: `“${String(p.kind)}” isn't an archetype Qnet knows.` };
  return { nodes: a.nodes, links: a.links, infiniteBuffers: p.infiniteBuffers, canvasScale: 1, canvasPanOffset: [0, 0] } as BnetDocument;
}

/** `NetworkArchetypeBuilder.summary`. */
export function archetypeSummary(request: ArchetypeRequest): string {
  const p = clampedParameters(request);
  let n = 0;
  const doc = buildArchetypeDocument(p, () => String(++n));
  const stations = doc.nodes.filter((x) => x.kind === "station").length;
  return `${stations} station${stations === 1 ? "" : "s"}, ${doc.nodes.length} nodes, ${doc.links.length} links, λ = ${displayFixed(p.arrivalRate, 3)}, ρ = ${displayFixed(p.targetRho, 3)} at every station`;
}

const uuid = () => crypto.randomUUID().toUpperCase();

/** The mock's `network_archetype`. */
export function buildArchetype(request: ArchetypeRequest, nextId: () => string = uuid): BuiltArchetype {
  const doc = buildArchetypeDocument(request, nextId);
  return { text: JSON.stringify(doc), summary: archetypeSummary(request), origin: CANVAS_ORIGIN };
}
