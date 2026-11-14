// Quiet runs in the browser preview and the tests (src-tauri/src/quiet_runs.rs; Run ▸ What-If
// Sweep…). No solver runs here, and a sweep's documents are not the corpus's, so nothing can be
// replayed: a quiet run is answered by a small stand-in model instead — the traffic equations of
// the document (per-class flows through its links, class changes included) and, per station, the
// M/M/c mean (M/M/1/K in a finite-buffer network), nudged a little per method so that an exact
// method, an approximation and a simulation (with an interval) draw three lines that nearly agree.
// The numbers are a preview's, never Qnet's.
//
// The run slot is the runs mock's: `withQuietRuns` wraps its `run_start`, `run_stop` and
// `run_active`, so a held sweep refuses a Run-menu run with the registry's sentence, shows as
// "What-If Sweep" and is stopped by Run ▸ Stop, as in the app.
import type { BnetDocument, BnetNode } from "../../lib/bnet";
import type { ActiveRunInfo, QuietOutcome, QuietProbe, QuietRunRequest, RunMessage, RunRecord, RunStartRequest } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";
import { channelSend } from "../../test/tauri";
import { openOnly } from "../../closed/shape";
import { mockDisplayLabel } from "./runs";

/** What the preview's quiet runs do; tests change it (each handler table starts from these defaults). */
const defaults = () => ({
  /** How long one quiet run takes. */
  pointMs: 60,
  /** A sentence per run label: that method refuses every network. */
  refuse: {} as Record<string, string>,
  /** A sentence per run label: that method fails at every point. */
  fail: {} as Record<string, string>,
  /** Every quiet run asked for, in order. */
  runs: [] as QuietRunRequest[],
  begun: 0,
  ended: 0,
});
export const mockQuiet = defaults();

const SWEEP = "What-If Sweep";
const SENSITIVITY = "Sensitivity";

/** identifier, display name, short name, layer, fidelity (core/src/results/model.rs `catalogue`) and buffer mode, per run label. */
const METHODS: Record<string, [string, string, string, string, string, "infinite" | "finite" | "either"]> = {
  qna: ["queue-approx.qna", "Whitt QNA", "QNA", "Queue approximation", "Queueing approximation", "infinite"],
  rqna: ["queue-approx.rqna", "Whitt–You RQNA", "RQNA", "Queue approximation", "Queueing approximation", "infinite"],
  sbd: ["queue-approx.sbd", "Sequential Bottleneck Decomposition", "SBD", "Queue approximation", "Queueing approximation", "infinite"],
  product_form: ["queue.open-bcmp-product-form", "Exact Open Product Form", "Product Form", "Queueing process", "Exact queueing result", "infinite"],
  qbd: ["queue.matrix-analytic-qbd", "Exact Matrix-Analytic QBD", "QBD", "Queueing process", "Exact queueing result", "infinite"],
  truncated_ctmc: ["queue.infinite-truncated-ctmc", "Adaptive Truncated CTMC", "Truncated CTMC", "Queueing process", "Queueing approximation", "infinite"],
  inf_sm: ["srbm.spectral", "Spectral Method", "Spectral", "SRBM diffusion", "SRBM numerical result", "infinite"],
  sm: ["srbm.spectral", "Spectral Method", "Spectral", "SRBM diffusion", "SRBM numerical result", "finite"],
  fm: ["srbm.fem", "Finite Element Method", "FEM", "SRBM diffusion", "SRBM numerical result", "finite"],
  lp: ["srbm.lp", "BAR Linear Program", "LP", "SRBM diffusion", "SRBM numerical result", "infinite"],
  flp: ["srbm.lp", "BAR Linear Program", "LP", "SRBM diffusion", "SRBM numerical result", "finite"],
  mlmc: ["srbm.mlmc", "SRBM MLMC", "MLMC", "SRBM diffusion", "SRBM simulation", "infinite"],
  inf_sim: ["queue.des", "Monte Carlo", "Monte Carlo", "Queueing process", "Queue simulation", "infinite"],
  sim: ["queue.des", "Monte Carlo", "Monte Carlo", "Queueing process", "Queue simulation", "finite"],
  regenerative_mc: ["queue.regenerative-mc", "Regenerative Monte Carlo", "Regen MC", "Queueing process", "Queue simulation", "either"],
  generic_ctmc: ["queue.finite-ctmc", "Exact Sparse CTMC", "CTMC", "Queueing process", "Exact queueing result", "finite"],
  fb_decomp: ["queue-approx.finite-decomposition", "Finite-Buffer Decomposition", "FB Decomp", "Queue approximation", "Queueing approximation", "finite"],
};

// ── The stand-in model ──────────────────────────────────────────────────────────────────────────

function meanOf(distribution: string, parameters: string): number {
  const p: Record<string, number> = {};
  for (const pair of parameters.split(",")) {
    const [k, v] = pair.split("=");
    if (k && v !== undefined) p[k.trim()] = Number(v);
  }
  switch (distribution) {
    case "exponential": return 1 / p.rate;
    case "poisson": return 1 / p.lambda;
    case "gamma": return p.shape * p.scale;
    case "uniform": return (p.min + p.max) / 2;
    case "constant": return p.value;
    case "erlang": return p.k / p.rate;
    case "lognormal": return Math.exp(p.mu + (p.sigma * p.sigma) / 2);
    case "pareto": return (p.shape * p.scale) / (p.shape - 1);
    default: return p.scale ?? 1;
  }
}

const number = (name: string) => {
  const m = /\d+$/.exec(name);
  return m ? Number(m[0]) : Number.MAX_VALUE;
};
const ordered = (nodes: BnetNode[]) => [...nodes].sort((a, b) => number(a.name) - number(b.name));

export interface MockStation {
  id: string;
  name: string;
  /** Arrival rate per class, and in total. */
  flows: Map<number, number>;
  arrival: number;
  /** Offered work per server: Σ λ_c / μ_c / servers. */
  utilisation: number;
  servers: number;
  /** Places in the station, queue included (finite buffers). */
  capacity: number;
}

/** The document's traffic: each station's per-class arrival rate and utilisation (ignoring losses). */
export function mockTraffic(doc: BnetDocument): MockStation[] {
  const sources = ordered(doc.nodes.filter((n) => n.kind === "source"));
  const flow = new Map<string, number>();
  const key = (node: string, cls: number) => `${node}|${cls}`;
  // Flows by repeated substitution: an open network's routing converges geometrically.
  for (let pass = 0; pass < 400; pass++) {
    const next = new Map<string, number>();
    sources.forEach((s, k) => next.set(key(s.id, k), 1 / meanOf(s.distribution, s.distributionParameters)));
    for (const l of doc.links) {
      const from = doc.nodes.find((n) => n.id === l.fromNodeID);
      if (!from) continue;
      const carried = (from.kind === "source" ? next.get(key(from.id, l.customerClass)) : flow.get(key(from.id, l.customerClass))) ?? 0;
      const to = key(l.toNodeID, l.toCustomerClass ?? l.customerClass);
      next.set(to, (next.get(to) ?? 0) + carried * l.routingProbability);
    }
    let moved = 0;
    for (const [k, v] of next) moved = Math.max(moved, Math.abs(v - (flow.get(k) ?? 0)));
    flow.clear();
    next.forEach((v, k) => flow.set(k, v));
    if (moved < 1e-13) break;
  }
  return ordered(doc.nodes.filter((n) => n.kind === "station")).map((s) => {
    const flows = new Map<number, number>();
    for (const [k, v] of flow) {
      const [node, cls] = k.split("|");
      if (node === s.id && v > 0) flows.set(Number(cls), v);
    }
    let work = 0;
    let arrival = 0;
    for (const [cls, rate] of flows) {
      const law = s.serviceDistributions?.[String(cls)] ?? { distribution: s.distribution, distributionParameters: s.distributionParameters };
      work += rate * meanOf(law.distribution, law.distributionParameters);
      arrival += rate;
    }
    const servers = Math.max(1, s.numberOfServers);
    const upstream = doc.nodes.filter((n) => n.kind === "buffer" && doc.links.some((l) => l.fromNodeID === n.id && l.toNodeID === s.id));
    const capacity = servers + upstream.reduce((sum, b) => sum + Math.max(1, b.bufferSize), 0);
    return { id: s.id, name: s.name, flows, arrival, utilisation: work / servers, servers, capacity };
  });
}

/** Mean number in system and the fraction of arrivals lost, for one station. */
function stationMeans(s: MockStation, infinite: boolean): { number: number; lost: number } {
  const rho = s.utilisation;
  if (infinite) {
    // M/M/c by the Allen–Cunneen form; exact for one server.
    const wait = Math.pow(rho, Math.sqrt(2 * (s.servers + 1))) / (1 - rho);
    return { number: wait + s.servers * rho, lost: 0 };
  }
  const a = rho * s.servers > 0 ? rho : 1e-12;
  const K = s.capacity;
  if (Math.abs(a - 1) < 1e-9) return { number: K / 2, lost: 1 / (K + 1) };
  const lost = ((1 - a) * Math.pow(a, K)) / (1 - Math.pow(a, K + 1));
  return { number: a / (1 - a) - ((K + 1) * Math.pow(a, K + 1)) / (1 - Math.pow(a, K + 1)), lost };
}

/** A steady pseudo-random number in [-1, 1] for a text. */
function wobble(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

const upperUuid = () => crypto.randomUUID().toUpperCase();

/** The stand-in record for `method` on `doc`. */
export function mockQuietRecord(request: Pick<QuietRunRequest, "tabId" | "title" | "method">, doc: BnetDocument): RunRecord {
  const [identifier, displayName, shortName, layer, fidelity] = METHODS[request.method];
  const exact = fidelity === "Exact queueing result";
  const simulation = fidelity === "Queue simulation" || fidelity === "SRBM simulation";
  const measurements: unknown[] = [];
  for (const s of mockTraffic(doc)) {
    const { number, lost } = stationMeans(s, doc.infiniteBuffers);
    const rho = Math.min(s.utilisation, 1);
    // An approximation drifts with the load; a diffusion model is best in heavy traffic; a simulation scatters.
    const bias = exact ? 1 : simulation ? 1 + 0.02 * wobble(`${request.method}${s.id}${number.toPrecision(6)}`) : layer === "SRBM diffusion" ? 1 - 0.1 * (1 - rho) : 1 + (request.method === "rqna" ? 0.06 : 0.03) * rho * rho;
    const throughput = s.arrival * (1 - lost);
    const inSystem = number * bias;
    const add = (metric: string, unit: string, estimate: number, spread: number) => {
      const m: Record<string, unknown> = { id: upperUuid(), stationID: s.id, stationName: s.name, metric, unit, estimate };
      if (simulation && spread > 0) m.uncertainty = { lowerBound: estimate * (1 - spread), upperBound: estimate * (1 + spread), confidenceLevel: 0.95 };
      measurements.push(m);
    };
    add(exact ? "Server utilization" : "Utilization", "ratio", Math.min(1, s.utilisation * (1 - lost)), 0.01);
    add("Throughput", "customers / time", throughput, 0.01);
    add("Mean sojourn time", "time", throughput > 0 ? inSystem / throughput : 0, 0.05);
    add("Mean number in system", "customers", inSystem, 0.05);
  }
  const now = new Date().toISOString();
  return {
    id: upperUuid(),
    method: { identifier, displayName, shortName, layer, fidelity },
    provenance: { tabID: request.tabId.toUpperCase(), networkTitle: request.title, networkFingerprint: `preview-${wobble(JSON.stringify([doc.nodes, doc.links]))}`, bufferRegime: doc.infiniteBuffers ? "infinite" : "finite", parameters: {} },
    status: "completed",
    startedAt: now,
    completedAt: now,
    elapsedSeconds: mockQuiet.pointMs / 1000,
    measurements,
    warnings: [],
  } as unknown as RunRecord;
}

/** What the load check covers (src-tauri/src/quiet_runs.rs `PROBE_SUBJECT`). */
export const PROBE_SUBJECT = "The load check (utilisation from the traffic equations)";

/** `quiet_probe` for the stand-in model. A network drawn closed is told so, by the shared rule and sentence (src/closed/shape.ts). */
export function mockProbe(doc: BnetDocument): QuietProbe {
  const drawnClosed = openOnly(doc, PROBE_SUBJECT);
  if (drawnClosed) return { infiniteBuffers: !!doc.infiniteBuffers, loads: [], stable: true, error: drawnClosed.sentence };
  if (!doc.nodes?.some((n) => n.kind === "station") || !doc.nodes.some((n) => n.kind === "source")) {
    return { infiniteBuffers: !!doc.infiniteBuffers, loads: [], stable: true, error: "The network has no source node." };
  }
  const loads = mockTraffic(doc).map((s) => ({ station: s.name, utilisation: s.utilisation }));
  return { infiniteBuffers: doc.infiniteBuffers, loads, stable: !doc.infiniteBuffers || loads.every((l) => l.utilisation < 1), error: null };
}

/** How one quiet run ends, apart from Stop. */
export function mockQuietOutcome(request: QuietRunRequest): QuietOutcome {
  const doc = request.document as BnetDocument;
  const known = METHODS[request.method];
  if (!known) return { kind: "refused", sentence: `The browser preview has no stand-in for “${request.method}”.` };
  if (known[5] !== "either" && (known[5] === "infinite") !== doc.infiniteBuffers) {
    return { kind: "refused", sentence: `${mockDisplayLabel(request.method)} isn't offered for a network with ${doc.infiniteBuffers ? "infinite" : "finite"} buffers.` };
  }
  // A network drawn closed has no arrivals for an open-network method: refused by the one closed
  // rule, in its words (with ./closed.ts in front, as in the preview, a closed network with a
  // population is answered there with the runner's own sentence).
  const drawnClosed = openOnly(doc, mockDisplayLabel(request.method));
  if (drawnClosed) return { kind: "refused", sentence: drawnClosed.sentence };
  const probe = mockProbe(doc);
  if (!probe.stable) {
    const top = probe.loads.reduce((m, l) => (l.utilisation > m.utilisation ? l : m));
    return { kind: "unstable", sentence: `${top.station} would be overloaded (utilisation ${top.utilisation.toFixed(3)}), so the network has no steady state.`, station: top.station, utilisation: top.utilisation };
  }
  if (mockQuiet.refuse[request.method]) return { kind: "refused", sentence: mockQuiet.refuse[request.method] };
  if (mockQuiet.fail[request.method]) return { kind: "failed", sentence: mockQuiet.fail[request.method] };
  return { kind: "record", record: mockQuietRecord(request, doc), elapsedSeconds: mockQuiet.pointMs / 1000 };
}

// ── The handlers ────────────────────────────────────────────────────────────────────────────────

/** `table` with the quiet-run commands, sharing its run slot. */
export function withQuietRuns(table: MockHandlers): MockHandlers {
  Object.assign(mockQuiet, defaults());
  let held: { id: string; label: string; name: string; tabId: string; title: string; started: number; stopped: boolean; busy: boolean; wake: (() => void) | null } | null = null;
  let serial = 0;
  /** Frees the slot; `mockQuiet.ended` counts the sweeps that have let go of it. */
  const release = () => {
    if (held) mockQuiet.ended++;
    held = null;
  };
  const refusal = (label: string, by: string, title: string) => `${label} was not started because ${by} is already running for “${title}”. Stop or wait for that run first.`;

  return {
    ...table,
    quiet_begin: async ({ tabId, title, label }: { tabId: string; title: string; label?: string | null }) => {
      // src-tauri/src/quiet_runs.rs `session_label`: the sweep's name unless Sensitivity asks for its own.
      const [runLabel, name] = label === "sensitivity" ? ["sensitivity", SENSITIVITY] : label === "capacity" ? ["capacity", "Capacity"] : ["what-if_sweep", SWEEP];
      const active = (await table.run_active?.({})) as ActiveRunInfo | null | undefined;
      if (held || active) return { started: false, sentence: refusal(name, held ? held.name : active!.displayLabel, held ? held.title : active!.tabTitle) };
      held = { id: `preview-sweep-${++serial}`, label: runLabel, name, tabId, title, started: Date.now(), stopped: false, busy: false, wake: null };
      mockQuiet.begun++;
      return { started: true, sentence: null, sweepId: held.id };
    },
    quiet_run: async ({ request }: { request: QuietRunRequest }): Promise<QuietOutcome> => {
      mockQuiet.runs.push(request);
      // A sweep's point: its sweep must still be the one holding the slot. A stopped sweep's slot
      // is freed (below, as the app's watcher frees it), so its later points find no sweep of
      // theirs and answer `stopped` — never a run of their own.
      const session = request.sweepId ? held : null;
      if (request.sweepId && (!session || session.id !== request.sweepId || session.stopped)) return { kind: "stopped" };
      if (!request.sweepId && held) return { kind: "refused", sentence: refusal(mockDisplayLabel(request.method), SWEEP, held.title) };
      const outcome = mockQuietOutcome(request);
      // Only a run that starts takes time; Stop ends the wait at once.
      if (outcome.kind === "record" || outcome.kind === "failed") {
        if (session) session.busy = true;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, mockQuiet.pointMs);
          if (session) {
            session.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          }
        });
        if (session) {
          session.wake = null;
          session.busy = false;
          if (session.stopped && held === session) release();
        }
      }
      return session?.stopped ? { kind: "stopped" } : outcome;
    },
    quiet_end: (args?: { sweepId?: string | null }) => {
      if (held && args?.sweepId && held.id !== args.sweepId) return null;
      release();
      return null;
    },
    quiet_probe: ({ document }: { document: BnetDocument }) => mockProbe(document),
    run_start: (args: { request: RunStartRequest; channel: unknown }) => {
      if (held) {
        const label = mockDisplayLabel(args.request.method);
        channelSend(args.channel, { kind: "status", text: refusal(label, held.name, held.title), severity: "warning" } satisfies RunMessage);
        return { started: false };
      }
      return table.run_start?.(args);
    },
    run_stop: (args: unknown) => {
      if (!held) return table.run_stop?.(args) ?? null;
      const name = held.name;
      held.stopped = true;
      held.wake?.();
      // With no point in flight the slot is free at once (the app's watcher frees it within 100 ms).
      if (!held.busy) release();
      return name;
    },
    run_active: (args: unknown) => {
      if (!held) return table.run_active?.(args) ?? null;
      const elapsedSeconds = (Date.now() - held.started) / 1000;
      return { id: "preview-sweep", label: held.label, displayLabel: held.name, tabId: held.tabId, tabTitle: held.title, elapsedSeconds, fraction: null, stopRequested: held.stopped, text: `Running ${held.name} for ${held.title}…` } satisfies ActiveRunInfo;
    },
  };
}
