// Priorities, batch arrivals and rate profiles in the browser preview and the tests (new in
// 2.1). The preview can't run core, so this is a stand-in with the same shapes as Rust's answers
// for a network that uses one of the features (the one rule, src/extended/shape.ts):
// `analysis_run`, `live_results`, `network_diagnostics`, `method_domain`, `inspector_stability`,
// `quiet_probe`, and a run of `priority_exact`, `batch_exact` or `sim_inproc` (`run_start`,
// `quiet_run`); every other method is refused in core's sentence. Every other network passes
// through to the handlers it wraps.
//
// It is NOT the app's arithmetic: that is core/src/priority.rs, batch.rs and extended.rs, with
// the exact checks in their tests. The stand-in knows the single-server formulas for the laws a
// preview draws (exponential, Erlang, deterministic, uniform, gamma), and says so in its text.
import type { Diagnostic } from "../../canvas/validation/model";
import { featuresOf, refusal, usesAnyFeature, usesFeature } from "../../extended/shape";
import { batchIsValid, batchMean, profileMean, profileProblem } from "../../extended/model";
import type { BnetDocument, BnetLink, BnetNode } from "../../lib/bnet";
import type { MethodDomain, QuietOutcome, QuietRunRequest, RunMessage, RunRecord, RunStartRequest, SilentAnalysis } from "../../lib/types";
import type { LiveResults } from "../../live/model";
import { channelSend, type MockHandlers } from "../../test/tauri";
import { mockRuns } from "./runs";
import { mockTraffic } from "./sweeps2";

const PRIORITY_READY = "Exact for this station: the closed-form mean values of a priority queue with Poisson arrivals (Cobham's formula and its relatives), for the station and for each class.";
const BATCH_READY = "Exact for this station: the mean-value formula of the single-server queue with batch Poisson arrivals (M^X/G/1).";
export const TIME_VARYING = "This network has a time-varying arrival rate, so it has no single steady state for a long-run average to estimate. The Transient view computes how the mean numbers move in time, and Run ▸ Animate shows it.";
const PRIORITY_SCOPE = "The exact priority formulas cover a single station fed directly by Poisson sources, with infinite buffers and no feedback; for any other network with priorities use Replicated Simulation.";
const BATCH_SCOPE = "The exact batch-arrival formula covers one Poisson source feeding one single-server station, with infinite buffers and no feedback; for any other network with batch arrivals use Replicated Simulation.";

const param = (text: string, key: string, fallback: number) => {
  const m = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*([^,]+)`).exec(text);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

/** A law's mean and squared coefficient of variation, for the families a preview draws; null for the others. */
export function moments(distribution: string, parameters: string): { mean: number; scv: number } | null {
  switch (distribution) {
    case "exponential":
      return { mean: 1 / param(parameters, "rate", 1), scv: 1 };
    case "poisson":
      return { mean: 1 / param(parameters, "lambda", 1), scv: 1 };
    case "constant":
      return { mean: param(parameters, "value", 1), scv: 0 };
    case "erlang":
      return { mean: param(parameters, "k", 2) / param(parameters, "rate", 1), scv: 1 / param(parameters, "k", 2) };
    case "gamma":
      return { mean: param(parameters, "shape", 2) * param(parameters, "scale", 1), scv: 1 / param(parameters, "shape", 2) };
    case "uniform": {
      const [a, b] = [param(parameters, "min", 0.5), param(parameters, "max", 1.5)];
      return { mean: (a + b) / 2, scv: ((b - a) * (b - a)) / (3 * (a + b) * (a + b)) };
    }
    default:
      return null;
  }
}

/** The source's long-run customer rate over its own: mean batch size × the profile's average (core `extended::rate_factor`). */
function rateFactor(n: BnetNode): number {
  if (n.kind !== "source") return 1;
  const batch = n.batchSize && batchIsValid(n.batchSize) ? batchMean(n.batchSize) : 1;
  const profile = n.rateProfile && !profileProblem(n.rateProfile) ? profileMean(n.rateProfile) : 1;
  return batch * profile;
}

/** The document as the classical handlers should read it: Poisson and exponential sources at their long-run customer rate, the feature keys gone. */
export function trafficView<T extends { nodes: BnetNode[] }>(doc: T): T {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      const { serviceDiscipline: _d, priorityOrder: _o, batchSize: _b, rateProfile: _r, ...rest } = n;
      const f = rateFactor(n);
      if (f === 1 || !(f > 0)) return rest;
      const key = n.distribution === "poisson" ? "lambda" : "rate";
      return { ...rest, distributionParameters: `${key}=${param(n.distributionParameters, key, 1) * f}` };
    }),
  };
}

/** What cannot be modelled as written, in core's sentences (core `extended::problems`, the cases a preview meets). */
export function featureProblems(doc: BnetDocument): { node: BnetNode; sentence: string }[] {
  const out: { node: BnetNode; sentence: string }[] = [];
  const sources = doc.nodes.filter((n) => n.kind === "source").length;
  const classes = Math.max(sources, ...doc.links.map((l) => Math.max(l.customerClass, l.toCustomerClass ?? -1) + 1), 1);
  const traffic = usesFeature(doc, "priorities") ? mockTraffic(trafficView(doc)) : [];
  for (const n of doc.nodes) {
    if (n.kind === "station" && n.serviceDiscipline && n.serviceDiscipline !== "fcfs") {
      const order = n.priorityOrder ?? [];
      const bad = order.find((c) => c < 0 || c >= classes);
      const twice = order.find((c, i) => order.indexOf(c) !== i);
      if (bad !== undefined) out.push({ node: n, sentence: `${n.name}'s priority order names Class ${bad + 1}, which is not a class of this network.` });
      else if (twice !== undefined) out.push({ node: n, sentence: `${n.name}'s priority order names Class ${twice + 1} twice.` });
      else {
        const served = [...(traffic.find((s) => s.id === n.id)?.flows.keys() ?? [])].sort((a, b) => a - b);
        const missing = served.filter((c) => !order.includes(c)).map((c) => `Class ${c + 1}`);
        if (missing.length) out.push({ node: n, sentence: `${n.name}'s priority order is missing ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} served there. Give every class served at the station a place in the order.` });
      }
    }
    if (n.kind === "source" && n.batchSize && !batchIsValid(n.batchSize)) {
      const b = n.batchSize;
      const sum = b.kind === "pmf" ? b.probabilities.reduce((s, p) => s + p, 0) : 0;
      out.push({ node: n, sentence: `${n.name}: ${b.kind === "constant" ? "The batch size must be a whole number, 1 or more." : b.kind === "geometric" ? "The mean batch size must be a number, 1 or more." : `The batch-size probabilities sum to ${Number(sum.toPrecision(6))}, not 1.`}` });
    }
    if (n.kind === "source" && n.rateProfile) {
      const p = profileProblem(n.rateProfile);
      if (!n.rateProfile.segments.length) out.push({ node: n, sentence: `${n.name}: The rate profile has no segments.` });
      else if (p) out.push({ node: n, sentence: `${n.name}: ${p.what === "length" ? `Segment ${p.segment} of the rate profile has no length: each segment must end later than the one before it (the first later than time 0).` : `Segment ${p.segment} of the rate profile needs a multiplier that is 0 or more.`}` });
      if (n.distribution !== "poisson" && n.distribution !== "exponential") out.push({ node: n, sentence: `${n.name} has a rate profile but is not a Poisson source. A time-varying rate is defined for Poisson arrivals (a non-homogeneous Poisson process); set the source's law to Poisson or remove the profile.` });
    }
  }
  return out;
}

export interface StandInClass {
  cls: number;
  lambda: number;
  wait: number;
  sojourn: number;
  number: number;
  queue: number;
}
export type StandIn = { ok: true; station: BnetNode; throughput: number; utilisation: number; number: number; queue: number; wait: number; sojourn: number; classes: StandInClass[]; formula: string } | { ok: false; sentence: string };

/** The shape both formulas need: one station fed directly by Poisson sources, nothing coming back. */
function single(doc: BnetDocument, scope: string): { station: BnetNode; flows: Map<number, number> } | string {
  if (!doc.infiniteBuffers) return `The network has finite buffers. ${scope}`;
  const stations = doc.nodes.filter((n) => n.kind === "station");
  if (stations.length !== 1) return `The network has ${stations.length} stations. ${scope}`;
  const station = stations[0];
  const kind = (id: string) => doc.nodes.find((n) => n.id === id)?.kind;
  if (doc.links.some((l: BnetLink) => l.fromNodeID === station.id && (kind(l.toNodeID) === "buffer" || kind(l.toNodeID) === "station"))) return `Customers return to ${station.name} after service (feedback). ${scope}`;
  const odd = doc.nodes.find((n) => n.kind === "source" && n.distribution !== "poisson" && n.distribution !== "exponential");
  if (odd) return `${odd.name} is not a Poisson source. ${scope}`;
  const traffic = mockTraffic(trafficView(doc));
  return { station, flows: traffic[0]?.flows ?? new Map() };
}

/** The stand-in for core's `priority::from_network` and `solve`: one server only. */
export function standInPriority(doc: BnetDocument): StandIn {
  if (!usesFeature(doc, "priorities")) return { ok: false, sentence: "No station of this network has priority service, so there is nothing for the priority formulas to compute." };
  const problem = featureProblems(doc)[0];
  if (problem) return { ok: false, sentence: problem.sentence };
  if (usesFeature(doc, "batchArrivals") || usesFeature(doc, "timeVaryingRates")) return { ok: false, sentence: "The exact priority formulas assume single Poisson arrivals at a constant rate; this network also has batch arrivals or a rate profile. Use Replicated Simulation." };
  const shape = single(doc, PRIORITY_SCOPE);
  if (typeof shape === "string") return { ok: false, sentence: shape };
  const { station, flows } = shape;
  if (station.numberOfServers !== 1) return { ok: false, sentence: `The browser preview's stand-in computes the priority formulas for one server only; ${station.name} has ${station.numberOfServers}. Qnet itself also covers several servers with equal exponential rates.` };
  const preemptive = station.serviceDiscipline === "priorityPreemptiveResume";
  const order = (station.priorityOrder ?? []).filter((c) => (flows.get(c) ?? 0) > 0);
  const inputs = order.map((c) => {
    const law = station.serviceDistributions?.[String(c)] ?? { distribution: station.distribution, distributionParameters: station.distributionParameters };
    return { cls: c, lambda: flows.get(c)!, m: moments(law.distribution, law.distributionParameters) };
  });
  if (inputs.some((k) => k.m === null)) return { ok: false, sentence: "The browser preview's stand-in does not know this service law's second moment. Qnet itself does." };
  const rho = inputs.reduce((s, k) => s + k.lambda * k.m!.mean, 0);
  if (!(rho < 1)) return { ok: false, sentence: "No steady state exists for the station as a whole: the classes together offer more work than it can do (utilisation 1 or more). The exact formula is not offered when the total load is 1 or more." };
  const second = (k: (typeof inputs)[number]) => k.m!.mean * k.m!.mean * (1 + k.m!.scv);
  const w0 = inputs.reduce((s, k) => s + (k.lambda * second(k)) / 2, 0);
  let before = 0;
  let residual = 0;
  const classes = inputs.map((k): StandInClass => {
    const sigma = before + k.lambda * k.m!.mean;
    residual += (k.lambda * second(k)) / 2;
    const sojourn = preemptive ? k.m!.mean / (1 - before) + residual / ((1 - before) * (1 - sigma)) : w0 / ((1 - before) * (1 - sigma)) + k.m!.mean;
    before = sigma;
    return { cls: k.cls, lambda: k.lambda, wait: sojourn - k.m!.mean, sojourn, number: k.lambda * sojourn, queue: k.lambda * (sojourn - k.m!.mean) };
  });
  const throughput = classes.reduce((s, k) => s + k.lambda, 0);
  const number = classes.reduce((s, k) => s + k.number, 0);
  const queue = classes.reduce((s, k) => s + k.queue, 0);
  return { ok: true, station, throughput, utilisation: rho, number, queue, wait: queue / throughput, sojourn: number / throughput, classes, formula: preemptive ? "M/G/1 preemptive-resume priority" : "M/G/1 non-preemptive priority (Cobham 1954)" };
}

/** The stand-in for core's `batch::from_network` and `solve`. */
export function standInBatch(doc: BnetDocument): StandIn {
  if (!usesFeature(doc, "batchArrivals")) return { ok: false, sentence: "No source of this network has batch arrivals, so there is nothing for the batch formula to compute." };
  const problem = featureProblems(doc)[0];
  if (problem) return { ok: false, sentence: problem.sentence };
  if (usesFeature(doc, "priorities") || usesFeature(doc, "timeVaryingRates")) return { ok: false, sentence: "The exact batch-arrival formula assumes first-come-first-served service and a constant batch rate; this network also has priorities or a rate profile. Use Replicated Simulation." };
  const sources = doc.nodes.filter((n) => n.kind === "source");
  if (sources.length !== 1) return { ok: false, sentence: `The network has ${sources.length} sources. ${BATCH_SCOPE}` };
  const shape = single(doc, BATCH_SCOPE);
  if (typeof shape === "string") return { ok: false, sentence: shape };
  const { station } = shape;
  if (station.numberOfServers !== 1) return { ok: false, sentence: `${station.name} has ${station.numberOfServers} servers. With several servers the batch-arrival queue has no closed form. ${BATCH_SCOPE}` };
  const b = sources[0].batchSize!;
  const ex = batchMean(b);
  const ex2 = b.kind === "constant" ? b.size * b.size : b.kind === "geometric" ? b.mean * (2 * b.mean - 1) : b.probabilities.reduce((s, p, i) => s + (i + 1) * (i + 1) * p, 0);
  const m = moments(station.distribution, station.distributionParameters);
  const arrival = moments(sources[0].distribution, sources[0].distributionParameters);
  if (!m || !arrival) return { ok: false, sentence: "The browser preview's stand-in does not know this law's second moment. Qnet itself does." };
  const throughput = ex / arrival.mean;
  const rho = throughput * m.mean;
  if (!(rho < 1)) return { ok: false, sentence: "No steady state exists: customers arrive (batch rate × mean batch size) faster than the server can serve them." };
  const wait = (throughput * m.mean * m.mean * (1 + m.scv)) / (2 * (1 - rho)) + ((ex2 - ex) * m.mean) / (2 * ex * (1 - rho));
  const sojourn = wait + m.mean;
  return { ok: true, station, throughput, utilisation: rho, number: throughput * sojourn, queue: throughput * wait, wait, sojourn, classes: [], formula: "M^X/G/1 mean values" };
}

const upperUuid = () => crypto.randomUUID().toUpperCase();
const g12 = (x: number) => String(Number(x.toPrecision(12)));
const NAMES: Record<string, { identifier: string; displayName: string; shortName: string; implementation: string; fidelity: string }> = {
  priority_exact: { identifier: "queue.priority-exact", displayName: "Exact Priority Queue", shortName: "Priority", implementation: "qnet-core/priority (Cobham; Kleinrock; Kella–Yechiali; Buzen–Bondi)", fidelity: "Exact queueing result" },
  batch_exact: { identifier: "queue.batch-arrival-exact", displayName: "Exact Batch-Arrival Queue", shortName: "Batch", implementation: "qnet-core/batch (M^X/G/1 mean values)", fidelity: "Exact queueing result" },
  sim_inproc: { identifier: "queue.des-replications", displayName: "Replicated Simulation", shortName: "Replicated Sim", implementation: "qnet-core/simstat (independent replications)", fidelity: "Queue simulation" },
};
export const STAND_IN_NOTE = "The browser preview has no simulator: these numbers are the exact formula's with a made-up interval around them, not a simulation. Qnet itself simulates.";

/** The record a run files: the six measures core's parser reads (with an interval each for the simulation's stand-in). */
export function extendedRecord(request: Pick<RunStartRequest, "tabId" | "title">, doc: BnetDocument, method: string, a: Extract<StandIn, { ok: true }>): RunRecord {
  const simulated = method === "sim_inproc";
  const rows: [string, string, number][] = [
    ["Throughput", "customers / time", a.throughput],
    ["Mean number in system", "customers", a.number],
    ["Mean queue length", "customers", a.queue],
    ["Server utilization", "ratio", a.utilisation],
    ["Mean waiting time", "time", a.wait],
    ["Mean sojourn time", "time", a.sojourn],
  ];
  const measurements = rows.map(([metric, unit, value], i) => {
    // The simulation's stand-in: a little off the exact value (the same way every time), inside its interval.
    const estimate = simulated ? value * (1 + 0.004 * (i % 2 === 0 ? 1 : -1)) : value;
    const se = Math.abs(value) * 0.005;
    return { id: upperUuid(), stationID: a.station.id, stationName: a.station.name, metric, unit, estimate, ...(simulated ? { uncertainty: { standardError: se, lowerBound: estimate - 2.093 * se, upperBound: estimate + 2.093 * se, confidenceLevel: 0.95, sampleSize: 20 } } : {}) };
  });
  const now = new Date().toISOString();
  const name = NAMES[method];
  return {
    id: upperUuid(),
    method: { identifier: name.identifier, displayName: name.displayName, shortName: name.shortName, layer: "Queueing process", fidelity: name.fidelity, implementation: name.implementation },
    provenance: {
      tabID: request.tabId.toUpperCase(),
      networkTitle: request.title,
      networkFingerprint: extendedFingerprint(doc),
      networkSnapshot: { nodes: doc.nodes, links: doc.links, infiniteBuffers: doc.infiniteBuffers },
      bufferRegime: "Infinite capacity",
      parameters: simulated ? { model: "open queueing network, simulated", "preview stand-in": "yes: not a simulation" } : { model: a.formula },
    },
    status: "completed",
    startedAt: now,
    completedAt: now,
    elapsedSeconds: 0.001,
    measurements,
    warnings: simulated ? [STAND_IN_NOTE] : [],
  } as unknown as RunRecord;
}

/** The Shell text, in the shape runner/src/methods/singlestation.rs prints (the row core's parser reads). */
export function extendedReport(title: string, method: string, a: Extract<StandIn, { ok: true }>): string {
  const head = method === "priority_exact" ? "Exact priority queue (single station, Poisson arrivals)" : method === "batch_exact" ? "Exact batch-arrival queue (M^X/G/1, mean values)" : "Replicated simulation (the browser preview's stand-in: not a simulation)";
  return [
    head,
    `Model: ${title}`,
    `Formula: ${a.formula} (the browser preview's stand-in)`,
    `Exact station s1 (${a.station.name}): visits=1  X=${g12(a.throughput)}  E[N]=${g12(a.number)}  E[Q]=${g12(a.queue)}  util=${g12(a.utilisation)}  W=${g12(a.wait)}  T=${g12(a.sojourn)}`,
    ...a.classes.map((c) => `QNET_CLASS_V1 node_id=s1 class=${c.cls + 1} arrival_rate=${g12(c.lambda)} wait=${g12(c.wait)} sojourn=${g12(c.sojourn)} mean_number=${g12(c.number)} mean_queue=${g12(c.queue)}`),
    "Elapsed time: 0.001s",
    "",
  ].join("\n");
}

/** A stand-in fingerprint that reads the feature keys too. */
export function extendedFingerprint(doc: BnetDocument): string {
  const text = JSON.stringify([doc.nodes.map((n) => [n.id, n.kind, n.name, n.position, n.bufferSize, n.numberOfServers, n.distribution, n.distributionParameters, n.serviceDistributions, n.serviceDiscipline ?? null, n.priorityOrder ?? null, n.batchSize ?? null, n.rateProfile ?? null]), doc.links, !!doc.infiniteBuffers]);
  let out = "";
  for (let lane = 0; lane < 8; lane++) {
    let h = 0x811c9dc5 ^ (lane + 131);
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

const DISPLAY: Record<string, string> = { priority_exact: "Exact Priority Queue", batch_exact: "Exact Batch-Arrival Queue", sim_inproc: "Replicated Simulation" };

/** What a run of `method` on a network with a feature gives: the stand-in's answer, or the sentence that refuses it. */
function answer(doc: BnetDocument, method: string): StandIn {
  if (method === "priority_exact") return standInPriority(doc);
  if (method === "batch_exact") return standInBatch(doc);
  if (method === "sim_inproc") {
    if (usesFeature(doc, "timeVaryingRates")) return { ok: false, sentence: TIME_VARYING };
    const problem = featureProblems(doc)[0];
    if (problem) return { ok: false, sentence: problem.sentence };
    const a = usesFeature(doc, "priorities") ? standInPriority(doc) : standInBatch(doc);
    return a.ok ? a : { ok: false, sentence: "The browser preview has no simulator, and its stand-in covers only the single-station cases with an exact formula. Qnet itself simulates this network." };
  }
  return { ok: false, sentence: refusal(doc, DISPLAY[method] ?? method) ?? "" };
}

/** `table` with the answers for networks that use priorities, batch arrivals or a rate profile in front of it. */
export function withExtended(table: MockHandlers): MockHandlers {
  const uses = (doc: unknown): doc is BnetDocument => usesAnyFeature(doc as BnetDocument) && (doc as BnetDocument).nodes.some((n) => n.kind === "source" || n.kind === "sink");
  const live = async (doc: BnetDocument): Promise<LiveResults> => {
    const problem = featureProblems(doc)[0];
    if (problem) return { tier: "none", perStation: [], network: null, reasonIfPartial: "noModel", reasonDetail: problem.sentence, utilisationExact: false, bottlenecks: [] };
    const base = (await table.live_results?.({ document: trafficView(doc) })) as LiveResults;
    if (base.tier === "none" || base.reasonIfPartial === "unstable" || base.reasonIfPartial === "finiteBuffers") return { ...base, perStation: base.perStation.map((s) => ({ ...s, meanInSystem: null, meanWaiting: null, meanSojourn: null, meanWait: null })), network: null, tier: base.tier === "none" ? "none" : "utilisation" };
    const stripped = base.perStation.map((s) => ({ ...s, meanInSystem: null, meanWaiting: null, meanSojourn: null, meanWait: null }));
    if (usesFeature(doc, "timeVaryingRates")) {
      return { ...base, tier: "utilisation", perStation: stripped, network: null, reasonIfPartial: "extended", reasonDetail: "The arrival rate changes in time, so there is no single steady state; the utilisation shown is at the long-run average rate. The Transient view computes how the mean numbers move." };
    }
    const a = usesFeature(doc, "priorities") ? standInPriority(doc) : standInBatch(doc);
    if (!a.ok) return { ...base, tier: "utilisation", perStation: stripped, network: null, reasonIfPartial: "extended", reasonDetail: a.sentence };
    return {
      ...base,
      tier: "exact",
      reasonIfPartial: null,
      reasonDetail: "",
      perStation: stripped.map((s) => ({ ...s, utilisation: a.utilisation, throughput: a.throughput, meanInSystem: a.number, meanWaiting: a.queue, meanSojourn: a.sojourn, meanWait: a.wait })),
      network: { throughput: a.throughput, meanNumber: a.number, meanDelay: a.sojourn },
      formula: usesFeature(doc, "priorities") ? "priority" : "batch",
    };
  };
  return {
    ...table,
    live_results: (args: { document: BnetDocument }) => (uses(args.document) ? live(args.document) : table.live_results?.(args)),
    analysis_run: async (args: { document: BnetDocument }) => {
      if (!uses(args.document)) return table.analysis_run?.(args);
      const base = (await table.analysis_run?.({ document: trafficView(args.document) })) as SilentAnalysis;
      // No closed form of first-come-first-served networks is announced (src-tauri/src/analysis.rs).
      return { ...base, isAnalyticallyTractable: false, tractabilityIsExact: false, tractabilityTitle: "", tractabilityDetail: "", tractabilityMeans: [], tractabilityMeansLabel: "", tractabilityExplanation: "" };
    },
    network_diagnostics: async (args: { document: BnetDocument }) => {
      if (!uses(args.document)) return table.network_diagnostics?.(args);
      const base = (await table.network_diagnostics?.({ document: trafficView(args.document) })) as Diagnostic[];
      const own = featureProblems(args.document).map(({ node, sentence }): Diagnostic => ({ severity: "error", code: "featureSetting", nodeIds: [node.id], linkIds: [], values: { name: node.name, detail: sentence } }));
      return [...own, ...base];
    },
    inspector_stability: (args: { stationId: string; nodes: BnetNode[]; links: BnetLink[]; infiniteBuffers: boolean }) => table.inspector_stability?.(usesAnyFeature({ nodes: args.nodes }) ? { ...args, nodes: trafficView({ nodes: args.nodes }).nodes } : args),
    quiet_probe: (args: { document: BnetDocument }) => table.quiet_probe?.(uses(args.document) ? { document: trafficView(args.document) } : args),
    method_domain: async (args: { document: BnetDocument }) => {
      if (!uses(args.document)) return table.method_domain?.(args);
      const doc = args.document;
      const base = (await table.method_domain?.({ document: trafficView(doc) })) as MethodDomain;
      const exact: NonNullable<MethodDomain["extended"]>["exact"] = [];
      if (usesFeature(doc, "priorities")) {
        const a = standInPriority(doc);
        exact.push({ id: "priority-exact", name: "Exact Priority Queue", ready: PRIORITY_READY, refusal: a.ok ? null : a.sentence });
      }
      if (usesFeature(doc, "batchArrivals")) {
        const a = standInBatch(doc);
        exact.push({ id: "batch-exact", name: "Exact Batch-Arrival Queue", ready: BATCH_READY, refusal: a.ok ? null : a.sentence });
      }
      const sim = answer(doc, "sim_inproc");
      return { ...base, analytical: null, warningCount: 0, replicatedSimulationRefusal: sim.ok ? null : sim.sentence, extended: { features: featuresOf(doc).map((f) => f.feature), others: refusal(doc, "This method") ?? "", exact } };
    },
    results_fingerprint: (args: { document: BnetDocument }) => (uses(args.document) ? extendedFingerprint(args.document) : table.results_fingerprint?.(args)),
    run_start: async (args: { request: RunStartRequest; channel: unknown }) => {
      const doc = args.request.document as BnetDocument;
      const method = args.request.method;
      // Its own two methods answer for any network (they say why one is not theirs); every other
      // method only for a network that uses a feature.
      const own = method === "priority_exact" || method === "batch_exact";
      if (!own && !uses(doc)) return table.run_start?.(args);
      const send = (m: RunMessage) => channelSend(args.channel, m);
      mockRuns.starts.push(args.request);
      if ((await table.run_active?.({})) != null) return table.run_start?.(args);
      const a = answer(doc, method);
      if (!a.ok) {
        send({ kind: "status", text: `${DISPLAY[method] ?? method} not started: ${a.sentence}`, severity: "warning" });
        return { started: false };
      }
      send({ kind: "status", text: method === "sim_inproc" ? "Running replicated simulation (the browser preview's stand-in: not a simulation)." : `Running ${DISPLAY[method].toLowerCase()} (closed-form mean values).`, severity: "info" });
      const record = extendedRecord(args.request, doc, method, a);
      const bytes = new TextEncoder().encode(extendedReport(args.request.title, method, a));
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      setTimeout(() => {
        mockRuns.records.push(record);
        send({ kind: "output", data: btoa(bin) });
        const summary = `${DISPLAY[method]} finished in 0.0 s`;
        send({ kind: "finished", summary, statusBar: summary, exitCode: 0, userStopped: false, succeeded: true, recordId: record.id, filed: "completed", filedReason: null });
      }, 0);
      return { started: true };
    },
    quiet_run: async (args: { request: QuietRunRequest }): Promise<QuietOutcome> => {
      const doc = args.request.document as BnetDocument;
      const method = args.request.method;
      const own = method === "priority_exact" || method === "batch_exact";
      if (!own && !uses(doc)) return (await table.quiet_run?.(args)) as QuietOutcome;
      const a = answer(doc, method);
      if (!a.ok) return { kind: "refused", sentence: `${DISPLAY[method] ?? method} not started: ${a.sentence}` };
      return { kind: "record", record: extendedRecord(args.request, doc, method, a), elapsedSeconds: 0.001 };
    },
  };
}
