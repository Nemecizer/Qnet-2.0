// Closed networks in the browser preview and the tests (new in 2.1, ROADMAP D3). The preview
// can't run core, so this is a stand-in with the same shapes as Rust's answers for a network
// drawn without a source and a sink: `live_results`, `network_diagnostics`, `method_domain`,
// `results_fingerprint`, and a run of `closed_pf` or `sim_inproc` (`run_start`, `quiet_run`). Everything else, and
// every open network, passes through to the handlers it wraps.
//
// It is NOT the app's arithmetic: that is core/src/closed.rs (Buzen's convolution and exact MVA,
// with the exact checks in its tests). The stand-in is a plain, unscaled convolution, right for
// the small networks a preview draws.
import { drawnAs, looksClosed as closedShape } from "../../closed/shape";
import type { Diagnostic } from "../../canvas/validation/model";
import type { BnetDocument, BnetNode } from "../../lib/bnet";
import type { MethodDomain, QuietOutcome, QuietRunRequest, RunMessage, RunRecord, RunStartRequest } from "../../lib/types";
import type { LiveResults } from "../../live/model";
import { mostLoaded } from "../../results/insight";
import { channelSend, type MockHandlers } from "../../test/tauri";
import { mockRuns } from "./runs";

const number = (name: string) => {
  const m = /\d+$/.exec(name);
  return m ? Number(m[0]) : Number.MAX_VALUE;
};
const rateOf = (n: BnetNode) => Number(/rate\s*=\s*([^,]+)/.exec(n.distributionParameters)?.[1] ?? 1);

export const looksClosed = (doc: BnetDocument | null | undefined) => closedShape(doc?.nodes ?? []);

export interface ClosedStation {
  id: string;
  name: string;
  servers: number;
  rate: number;
  visits: number;
  throughput: number;
  utilisation: number;
  number: number;
  queue: number;
  residence: number;
}

export type ClosedAnswer = { ok: true; population: number; throughput: number; stations: ClosedStation[] } | { ok: false; code: string; sentence: string; names: string[] };

const refuse = (code: string, sentence: string, names: string[] = []): ClosedAnswer => ({ ok: false, code, sentence, names });

/** The stand-in solution of a closed network, or why it has none (the codes are src-tauri/src/diagnostics.rs's). */
export function standInClosed(doc: BnetDocument): ClosedAnswer {
  const stations = doc.nodes.filter((n) => n.kind === "station").sort((a, b) => number(a.name) - number(b.name));
  const population = doc.closedPopulation;
  if (population === undefined) return refuse("closedNoPopulation", "The network has no source and no sink, but no number of customers is set. Set the population to make it a closed network.");
  if (!(population >= 1 && population <= 10000)) return refuse("closedPopulationRange", `A closed network needs between 1 and 10000 customers (the population is ${population}).`);
  if (doc.links.some((l) => l.customerClass !== 0 || (l.toCustomerClass ?? 0) !== 0)) return refuse("closedMultiClass", "The closed-network solution is for one customer class: every link must carry Class 1 and none may change class.");
  const odd = stations.filter((s) => s.distribution !== "exponential").map((s) => s.name);
  if (odd.length) return refuse("closedNotExponential", `The closed product form needs exponential service times; ${odd.join(", ")} ${odd.length === 1 ? "has" : "have"} another distribution.`, odd);
  const d = stations.length;
  const index = new Map(stations.map((s, i) => [s.id, i]));
  const target = (id: string): number | undefined => {
    if (index.has(id)) return index.get(id);
    const onward = doc.links.find((l) => l.fromNodeID === id && index.has(l.toNodeID));
    return onward ? index.get(onward.toNodeID) : undefined;
  };
  const p = stations.map(() => new Array<number>(d).fill(0));
  for (const l of doc.links) {
    const from = index.get(l.fromNodeID);
    const to = target(l.toNodeID);
    if (from !== undefined && to !== undefined) p[from][to] += l.routingProbability;
  }
  for (let i = 0; i < d; i++) {
    const sum = p[i].reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) return refuse(sum > 1 ? "routingOverOne" : "closedRoutingLeaks", `Routing probabilities from ${stations[i].name} sum to ${sum.toFixed(4)}; in a closed network they must sum to 1.`, [stations[i].name]);
  }
  // Every station must reach every other (one closed group).
  const reach = (from: number, forward: boolean) => {
    const seen = new Set<number>([from]);
    const queue = [from];
    while (queue.length) {
      const i = queue.pop()!;
      for (let j = 0; j < d; j++) if ((forward ? p[i][j] : p[j][i]) > 0 && !seen.has(j)) queue.push(j), seen.add(j);
    }
    return seen;
  };
  const [out, back] = [reach(0, true), reach(0, false)];
  const apart = stations.filter((_, i) => !(out.has(i) && back.has(i))).map((s) => s.name);
  if (apart.length) return refuse("closedUnreachable", `Customers do not keep circulating through ${apart.join(", ")}: every station must lead to every other.`, apart);

  // Visit ratios v = vP, v₁ = 1 (power iteration on the lazy chain, which is aperiodic).
  let v = new Array<number>(d).fill(1);
  for (let pass = 0; pass < 20000; pass++) {
    const next = v.map((x, j) => 0.5 * x + 0.5 * v.reduce((s, vi, i) => s + vi * p[i][j], 0));
    const moved = next.reduce((m, x, j) => Math.max(m, Math.abs(x - v[j])), 0);
    v = next;
    if (moved < 1e-15) break;
  }
  v = v.map((x) => x / v[0]);
  const mu = stations.map(rateOf);
  const c = stations.map((s) => Math.max(1, s.numberOfServers));
  const factor = (i: number) => {
    const f = [1];
    for (let n = 1; n <= population; n++) f.push((f[n - 1] * v[i]) / mu[i] / Math.min(n, c[i]));
    return f;
  };
  const convolve = (a: number[], b: number[]) => a.map((_, n) => a.slice(0, n + 1).reduce((s, x, k) => s + x * b[n - k], 0));
  const unit = [1, ...new Array<number>(population).fill(0)];
  const factors = stations.map((_, i) => factor(i));
  const g = factors.reduce(convolve, unit);
  const throughput = g[population - 1] / g[population];
  const solved = stations.map((s, i): ClosedStation => {
    const rest = factors.filter((_, j) => j !== i).reduce(convolve, unit);
    let mean = 0;
    for (let n = 1; n <= population; n++) mean += (n * factors[i][n] * rest[population - n]) / g[population];
    const x = v[i] * throughput;
    return { id: s.id, name: s.name, servers: c[i], rate: mu[i], visits: v[i], throughput: x, utilisation: x / (c[i] * mu[i]), number: mean, queue: Math.max(0, mean - x / mu[i]), residence: mean / x };
  });
  return { ok: true, population, throughput, stations: solved };
}

export function closedLive(doc: BnetDocument): LiveResults {
  const a = standInClosed(doc);
  if (!a.ok) return { tier: "none", perStation: [], network: null, reasonIfPartial: a.code === "closedNoPopulation" ? "closedNoPopulation" : "closed", reasonDetail: a.sentence, utilisationExact: false, bottlenecks: [] };
  return {
    tier: "exact",
    perStation: a.stations.map((s) => ({ stationId: s.id, stationName: s.name, servers: s.servers, throughput: s.throughput, serviceRate: s.rate, utilisation: s.utilisation, meanInSystem: s.number, meanWaiting: s.queue, meanSojourn: s.residence, meanWait: s.queue / s.throughput })),
    network: { throughput: a.throughput, meanNumber: a.population, meanDelay: a.population / a.throughput },
    reasonIfPartial: null,
    reasonDetail: "",
    utilisationExact: true,
    bottlenecks: mostLoaded(a.stations, (s) => s.utilisation).map((s) => s.id),
    closed: { population: a.population, referenceStation: a.stations[0].name },
  };
}

const suggested = (doc: BnetDocument) => Math.max(2, 2 * doc.nodes.filter((n) => n.kind === "station").length);

/** What the open-network stand-in said, with the closed network's own problems in place of "no source" and "no sink". */
export function closedDiagnostics(doc: BnetDocument, base: Diagnostic[]): Diagnostic[] {
  const whole = (severity: Diagnostic["severity"], code: string, values: Diagnostic["values"] = {}): Diagnostic => ({ severity, code, nodeIds: [], linkIds: [], values });
  if (doc.closedPopulation === undefined) {
    const routed = doc.links.some((l) => doc.nodes.find((n) => n.id === l.fromNodeID)?.kind === "station");
    return routed ? [...base, whole("info", "closedCandidate", { population: suggested(doc) })] : base;
  }
  const kept = base.filter((d) => d.code !== "noSource" && d.code !== "noSink");
  const a = standInClosed(doc);
  if (a.ok) return kept;
  const at = a.names.map((name) => doc.nodes.find((n) => n.kind === "station" && n.name === name)).filter((n): n is BnetNode => !!n);
  if (!at.length) return [whole("error", a.code, { detail: a.sentence, population: doc.closedPopulation }), ...kept];
  return [...at.map((n): Diagnostic => ({ severity: "error", code: a.code, nodeIds: [n.id], linkIds: [], values: { name: n.name, detail: a.sentence } })), ...kept];
}

/** A stand-in fingerprint that reads the population too. */
export function closedFingerprint(doc: BnetDocument): string {
  const text = JSON.stringify([doc.nodes.map((n) => [n.id, n.kind, n.name, n.position, n.bufferSize, n.numberOfServers, n.distribution, n.distributionParameters]), doc.links, !!doc.infiniteBuffers, doc.closedPopulation ?? null]);
  let out = "";
  for (let lane = 0; lane < 8; lane++) {
    let h = 0x811c9dc5 ^ (lane + 77);
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

const upperUuid = () => crypto.randomUUID().toUpperCase();
const g12 = (x: number) => String(Number(x.toPrecision(12)));

/** The Shell text of a run, in the shape runner/src/methods/closed.rs `report` prints. */
export function closedReport(title: string, a: Extract<ClosedAnswer, { ok: true }>): string {
  const rows = a.stations.map(
    (s, i) => `Closed station s${i + 1} (${s.name}): visits=${g12(s.visits)}  X=${g12(s.throughput)}  E[N]=${g12(s.number)}  E[Q]=${g12(s.queue)}  util=${g12(s.utilisation)}  W=${g12(s.queue / s.throughput)}  T=${g12(s.residence)}`,
  );
  return [
    "Exact closed product-form analysis (Gordon-Newell)",
    `Model: ${title}`,
    `Population: N=${a.population}  reference station: ${a.stations[0].name} (visit ratio 1)`,
    "Method: Buzen convolution (the browser preview's stand-in)",
    `Network: throughput at ${a.stations[0].name} (visits per time unit)=${g12(a.throughput)}  cycle time between visits to ${a.stations[0].name} (N/X)=${g12(a.population / a.throughput)}`,
    ...rows,
    "Elapsed time: 0.001s",
    "",
  ].join("\n");
}

/** The record Exact Closed Product Form files (the six measures core's parser reads per station). */
export function closedRecord(request: Pick<RunStartRequest, "tabId" | "title">, doc: BnetDocument, a: Extract<ClosedAnswer, { ok: true }>): RunRecord {
  const measurements: unknown[] = [];
  for (const s of a.stations) {
    const add = (metric: string, unit: string, estimate: number) => measurements.push({ id: upperUuid(), stationID: s.id, stationName: s.name, metric, unit, estimate });
    add("Throughput", "customers / time", s.throughput);
    add("Mean number in system", "customers", s.number);
    add("Mean queue length", "customers", s.queue);
    add("Server utilization", "ratio", s.utilisation);
    add("Mean waiting time", "time", s.queue / s.throughput);
    add("Mean sojourn time", "time", s.residence);
  }
  const now = new Date().toISOString();
  return {
    id: upperUuid(),
    method: { identifier: "queue.closed-product-form", displayName: "Exact Closed Product Form", shortName: "Closed PF", layer: "Queueing process", fidelity: "Exact queueing result", implementation: "qnet-core/closed (convolution, MVA)" },
    provenance: {
      tabID: request.tabId.toUpperCase(),
      networkTitle: request.title,
      networkFingerprint: closedFingerprint(doc),
      networkSnapshot: { nodes: doc.nodes, links: doc.links, infiniteBuffers: doc.infiniteBuffers, closedPopulation: doc.closedPopulation },
      bufferRegime: doc.infiniteBuffers ? "Infinite capacity" : "Finite capacity",
      parameters: { model: "exact closed Gordon–Newell network", population: String(a.population), "reference station": a.stations[0].name },
    },
    status: "completed",
    startedAt: now,
    completedAt: now,
    elapsedSeconds: 0.001,
    measurements,
    warnings: [],
  } as unknown as RunRecord;
}

const OTHER_METHODS = "not started: this is a closed network (no source and no sink), and this method needs arrivals from a source. Use Exact Closed Product Form, which is exact for it, or Replicated Simulation for a second opinion.";

// ── Replicated Simulation's stand-in (PREVIEW ONLY) ──────────────────────────────────────────
// The browser has no simulator. What stands in for a run of `sim_inproc` on a closed network is
// the stand-in exact value moved by a small seeded amount (at most 0.4 %), with an interval of
// ±1 % drawn round it — so the preview shows the shapes (a simulation tier, intervals, the exact
// value inside them) and nothing else. It is not a simulation and its text says so. The app's
// numbers are core/src/simstat.rs, whose coverage is measured in its tests.
const STAND_IN_NOTE = "PREVIEW STAND-IN: not a simulation. Each value is the exact one moved by a small fixed amount, with ±1 % drawn round it.";

/** A fixed number in [−1, 1] for a station's metric. */
function wobble(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

const REPLICATED_METRICS: [string, string, string, (s: ClosedStation) => number][] = [
  ["throughput", "Throughput", "customers / time", (s) => s.throughput],
  ["mean_number", "Mean number in system", "customers", (s) => s.number],
  ["mean_queue", "Mean queue length", "customers", (s) => s.queue],
  ["utilization", "Server utilization", "ratio", (s) => s.utilisation],
  ["mean_waiting_time", "Mean waiting time", "time", (s) => s.queue / s.throughput],
  ["mean_sojourn_time", "Mean sojourn time", "time", (s) => s.residence],
];

const standInReading = (s: ClosedStation, key: string, exact: number) => {
  const estimate = exact * (1 + 0.004 * wobble(`${s.name}|${key}`));
  const half = 0.01 * Math.abs(exact);
  return { estimate, low: estimate - half, high: estimate + half, se: half / 2.093 };
};

/** The Shell text of the stand-in, in the shape runner/src/methods/siminproc.rs `report` prints. */
export function replicatedReport(title: string, a: Extract<ClosedAnswer, { ok: true }>): string {
  const rows = a.stations.flatMap((s, i) =>
    REPLICATED_METRICS.map(([key, , , of]) => {
      const r = standInReading(s, key, of(s));
      return `QNET_SIM_METRIC_V1 node_id=s${i + 1} metric=${key} estimate=${g12(r.estimate)} standard_error=${g12(r.se)} ci_confidence=0.95 ci_low=${g12(r.low)} ci_high=${g12(r.high)} replications=20`;
    }),
  );
  return ["Replicated simulation (independent replications, in process)", STAND_IN_NOTE, `Model: ${title}`, `Network: closed, N=${a.population}, ${a.stations.length} stations`, "QNET_SIM_STATUS_V1 replications=20 target_met=na warmup_inconclusive=no", ...rows, "Elapsed time: 0.001s", ""].join("\n");
}

/** The record the stand-in files: the six measures per station, each with its interval (runner `siminproc.rs`, core's parser). */
export function replicatedRecord(request: Pick<RunStartRequest, "tabId" | "title">, doc: BnetDocument, a: Extract<ClosedAnswer, { ok: true }>): RunRecord {
  const measurements: unknown[] = [];
  for (const s of a.stations) {
    for (const [key, metric, unit, of] of REPLICATED_METRICS) {
      const r = standInReading(s, key, of(s));
      measurements.push({ id: upperUuid(), stationID: s.id, stationName: s.name, metric, unit, estimate: r.estimate, uncertainty: { standardError: r.se, lowerBound: r.low, upperBound: r.high, confidenceLevel: 0.95, sampleSize: 20 } });
    }
  }
  const now = new Date().toISOString();
  return {
    id: upperUuid(),
    method: { identifier: "queue.des-replications", displayName: "Replicated Simulation", shortName: "Replicated Sim", layer: "Queueing process", fidelity: "Queue simulation", implementation: "qnet-core/simstat (independent replications)" },
    provenance: {
      tabID: request.tabId.toUpperCase(),
      networkTitle: request.title,
      networkFingerprint: closedFingerprint(doc),
      networkSnapshot: { nodes: doc.nodes, links: doc.links, infiniteBuffers: doc.infiniteBuffers, closedPopulation: doc.closedPopulation },
      bufferRegime: doc.infiniteBuffers ? "Infinite capacity" : "Finite capacity",
      parameters: { model: "closed queueing network, simulated", estimator: "independent replications, Student t interval", replications: "20", "preview stand-in": "yes: not a simulation" },
    },
    status: "completed",
    startedAt: now,
    completedAt: now,
    elapsedSeconds: 0.001,
    measurements,
    warnings: [STAND_IN_NOTE],
  } as unknown as RunRecord;
}

/** `table` with the closed-network answers in front of it. */
export function withClosed(table: MockHandlers): MockHandlers {
  const closed = (doc: unknown): doc is BnetDocument => looksClosed(doc as BnetDocument);
  return {
    ...table,
    live_results: (args: { document: BnetDocument }) => (drawnAs(args.document) !== "open" ? closedLive(args.document) : table.live_results?.(args)),
    network_diagnostics: async (args: { document: BnetDocument }) => {
      const base = (await table.network_diagnostics?.(args)) as Diagnostic[];
      return closed(args.document) ? closedDiagnostics(args.document, base) : base;
    },
    method_domain: async (args: { document: BnetDocument }) => {
      const base = (await table.method_domain?.(args)) as MethodDomain;
      if (!closed(args.document)) return base;
      const a = standInClosed(args.document);
      return { ...base, analytical: args.document.closedPopulation === undefined ? base.analytical : null, replicatedSimulationRefusal: a.ok ? null : a.sentence, closed: { population: args.document.closedPopulation ?? null, refusal: a.ok ? null : a.sentence } };
    },
    // Also for the same network with its population removed: it is no longer the network a closed run solved.
    results_fingerprint: (args: { document: BnetDocument }) => (closed(args.document) && (args.document.closedPopulation !== undefined || mockRuns.records.some((r) => ["queue.closed-product-form", "queue.des-replications"].includes((r.method as unknown as { identifier?: string })?.identifier ?? ""))) ? closedFingerprint(args.document) : table.results_fingerprint?.(args)),
    run_start: async (args: { request: RunStartRequest; channel: unknown }) => {
      const doc = args.request.document as BnetDocument;
      // Only a closed network (the shape and a population) or its own method is answered here.
      const own = args.request.method === "closed_pf" || args.request.method === "sim_inproc";
      if (!closed(doc) || (doc.closedPopulation === undefined && !own)) return table.run_start?.(args);
      const send = (m: RunMessage) => channelSend(args.channel, m);
      mockRuns.starts.push(args.request);
      if ((await table.run_active?.({})) != null) return table.run_start?.(args);
      if (!own) {
        send({ kind: "status", text: `${args.request.method} ${OTHER_METHODS}`, severity: "warning" });
        return { started: false };
      }
      const replicated = args.request.method === "sim_inproc";
      const a = standInClosed(doc);
      if (!a.ok) {
        send({ kind: "status", text: `${replicated ? "Replicated Simulation" : "Exact closed product form"} not started: ${a.sentence}`, severity: "warning" });
        return { started: false };
      }
      send({ kind: "status", text: replicated ? "Running replicated simulation (the browser preview's stand-in: not a simulation)." : "Running exact closed product form (Buzen's convolution algorithm).", severity: "info" });
      const record = replicated ? replicatedRecord(args.request, doc, a) : closedRecord(args.request, doc, a);
      const bytes = new TextEncoder().encode(replicated ? replicatedReport(args.request.title, a) : closedReport(args.request.title, a));
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      setTimeout(() => {
        mockRuns.records.push(record);
        send({ kind: "output", data: btoa(bin) });
        const summary = `${replicated ? "Replicated Simulation" : "Closed Product Form"} finished in 0.0 s`;
        send({ kind: "finished", summary, statusBar: summary, exitCode: 0, userStopped: false, succeeded: true, recordId: record.id, filed: "completed", filedReason: null });
      }, 0);
      return { started: true };
    },
    quiet_run: async (args: { request: QuietRunRequest }): Promise<QuietOutcome> => {
      const doc = args.request.document as BnetDocument;
      const own = args.request.method === "closed_pf" || args.request.method === "sim_inproc";
      if (!closed(doc) || (doc.closedPopulation === undefined && !own)) return (await table.quiet_run?.(args)) as QuietOutcome;
      if (!own) return { kind: "refused", sentence: `${args.request.method} ${OTHER_METHODS}` };
      const a = standInClosed(doc);
      if (!a.ok) return { kind: "refused", sentence: `${args.request.method === "sim_inproc" ? "Replicated Simulation" : "Exact closed product form"} not started: ${a.sentence}` };
      return { kind: "record", record: args.request.method === "sim_inproc" ? replicatedRecord(args.request, doc, a) : closedRecord(args.request, doc, a), elapsedSeconds: 0.001 };
    },
  };
}
