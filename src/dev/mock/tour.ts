// The guided tour's network in the browser preview and the tests (new in 2.1, ledger UX-201…).
//
// The preview has no solver: a run replays what 0.90.34 recorded for an example (./runs.ts), and a
// network drawn by hand has no recording. The tour draws one by hand — a source, two stations each
// behind its buffer, a sink, in a line, infinite buffers, exponential laws — so that one shape gets
// a stand-in: the recorded runs of the three-station tandem (golden/runs/3dtandem.inf), cut to the
// first two stations, re-keyed to the stations as drawn, and rescaled from the recorded rates
// (λ = 1, μ = 1.1111111) to the drawn ones by the M/M/1 formulas, which are exact for this shape.
// The Method Chooser's verdict is the tandem's too. Any other network goes to the handlers given.
import type { BnetDocument, BnetNode } from "../../lib/bnet";
import type { ActiveRunInfo, RunMessage, RunRecord, RunStartRequest } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";
import { channelSend } from "../../test/tauri";
import { mockFingerprint } from "./results";
import { mockDisplayLabel, mockRuns } from "./runs";

const raw = (g: Record<string, unknown>) => g as Record<string, () => Promise<string>>;
const recorded = raw(import.meta.glob("../../../golden/runs/3dtandem.inf/*/{status.txt,summary.txt,record.json}", { query: "?raw", import: "default" }));
const resave = raw(import.meta.glob("../../../golden/3dtandem.inf/resave.bnet", { query: "?raw", import: "default" }));
const file = (method: string, name: string) => recorded[`../../../golden/runs/3dtandem.inf/${method}/${name}`];

const RECORDED = { lambda: 1, mu: 1.1111111 };

function rate(parameters: string): number | null {
  for (const pair of parameters.split(",")) {
    const [k, v] = pair.split("=").map((x) => x.trim());
    if ((k === "rate" || k === "lambda") && v) return Number(v);
  }
  return null;
}

export interface DrawnLine {
  lambda: number;
  stations: { node: BnetNode; mu: number }[];
}

/** The tour's shape, when `doc` is exactly it and every station can keep up; null otherwise. */
export function drawnLine(doc: BnetDocument | null | undefined): DrawnLine | null {
  if (!doc?.infiniteBuffers || !Array.isArray(doc.nodes) || doc.nodes.length !== 6 || doc.links?.length !== 5) return null;
  const source = doc.nodes.filter((n) => n.kind === "source");
  if (source.length !== 1 || !["poisson", "exponential"].includes(source[0].distribution)) return null;
  const lambda = rate(source[0].distributionParameters);
  const order = ["buffer", "station", "buffer", "station", "sink"];
  const stations: DrawnLine["stations"] = [];
  let at = source[0];
  for (const kind of order) {
    const out = doc.links.filter((l) => l.fromNodeID === at.id);
    const next = out.length === 1 && out[0].routingProbability === 1 ? doc.nodes.find((n) => n.id === out[0].toNodeID) : undefined;
    if (!next || next.kind !== kind) return null;
    if (kind === "station") {
      const law = next.serviceDistributions?.["0"] ?? next;
      const mu = law.distribution === "exponential" ? rate(law.distributionParameters) : null;
      if (next.numberOfServers !== 1 || mu === null || !Number.isFinite(mu)) return null;
      stations.push({ node: next, mu });
    }
    at = next;
  }
  if (lambda === null || !(lambda > 0) || stations.some((s) => !(s.mu > lambda))) return null;
  return { lambda, stations };
}

/** The M/M/1 value of a recorded metric, or null for one this stand-in does not rescale. */
function formula(metric: string, lambda: number, mu: number): number | null {
  const rho = lambda / mu;
  if (/utilization$/i.test(metric)) return rho;
  if (metric === "Stability margin") return 1 - rho;
  if (metric === "Mean number in system" || metric === "Mean reported occupancy") return rho / (1 - rho);
  if (metric === "Mean queue length") return (rho * rho) / (1 - rho);
  if (metric === "Mean sojourn time") return 1 / (mu - lambda);
  if (metric === "Mean waiting time") return rho / (mu - lambda);
  if (metric === "Throughput" || /rate$/i.test(metric)) return lambda;
  return null;
}

type Row = { stationID?: string; stationName: string; metric: string; estimate: number; uncertainty?: Record<string, number> };

function standIn(record: RunRecord, request: RunStartRequest, line: DrawnLine): RunRecord {
  const asRecorded = line.lambda === RECORDED.lambda && line.stations.every((s) => s.mu === RECORDED.mu);
  const measurements: Row[] = [];
  for (const m of record.measurements as Row[]) {
    const at = /^S(\d+)$/.exec(m.stationName);
    const station = at && m.stationID ? line.stations[Number(at[1]) - 1] : undefined;
    if (!station) continue;
    const was = formula(m.metric, RECORDED.lambda, RECORDED.mu);
    const now = formula(m.metric, line.lambda, station.mu);
    if ((was === null || now === null || was === 0) && !asRecorded) continue;
    const k = asRecorded || was === null || now === null ? 1 : now / was;
    const uncertainty = m.uncertainty && Object.fromEntries(Object.entries(m.uncertainty).map(([key, v]) => [key, key === "confidenceLevel" || key === "sampleSize" ? v : v * k]));
    measurements.push({ ...m, stationID: station.node.id, stationName: station.node.name, estimate: m.estimate * k, ...(uncertainty ? { uncertainty } : {}) });
  }
  const document = request.document as BnetDocument;
  const now = new Date().toISOString();
  return {
    ...record,
    id: crypto.randomUUID().toUpperCase(),
    startedAt: now,
    completedAt: now,
    measurements,
    provenance: {
      ...record.provenance,
      tabID: request.tabId.toUpperCase(),
      networkTitle: request.title,
      networkFingerprint: mockFingerprint(document as unknown as Parameters<typeof mockFingerprint>[0]),
      networkSnapshot: { nodes: document.nodes, links: document.links, infiniteBuffers: document.infiniteBuffers },
      exportStationIDs: line.stations.map((s) => s.node.id),
      sourceFileURL: null,
    },
  };
}

/** `table` with the stand-in for the tour's network. */
export function withTourRuns(table: MockHandlers): MockHandlers {
  let active: ActiveRunInfo | null = null;
  return {
    ...table,
    method_domain: async (args: { document: BnetDocument }) => {
      const load = resave["../../../golden/3dtandem.inf/resave.bnet"] as (() => Promise<string>) | undefined;
      const line = drawnLine(args.document);
      if (!line || !load) return table.method_domain(args);
      return { ...((await table.method_domain({ document: JSON.parse(await load()) })) as object), stationCount: line.stations.length };
    },
    run_active: (args: unknown) => active ?? table.run_active(args),
    run_start: async (args: { request: RunStartRequest; channel: unknown }) => {
      const { request, channel } = args;
      const line = drawnLine(request.document as BnetDocument);
      const load = file(request.method, "record.json") as (() => Promise<string>) | undefined;
      if (!line || !load || active || table.run_active({})) return table.run_start(args);
      mockRuns.starts.push(request);
      const send = (m: RunMessage) => channelSend(channel, m);
      const [recordText, status, summary] = await Promise.all([load(), file(request.method, "status.txt")?.(), file(request.method, "summary.txt")?.()]);
      for (const l of (status ?? "").split("\n").filter((x) => x.includes("\t"))) {
        const [severity, ...rest] = l.split("\t");
        send({ kind: "status", text: rest.join("\t"), severity: severity as "info" | "success" | "warning" | "error" });
      }
      const label = mockDisplayLabel(request.method);
      const text = `Running ${label} for ${request.title}…`;
      active = { id: crypto.randomUUID(), label: request.method, displayLabel: label, tabId: request.tabId, tabTitle: request.title, elapsedSeconds: 0, fraction: null, stopRequested: false, text };
      send({ kind: "progress", fraction: null, elapsedSeconds: 0, text });
      setTimeout(() => {
        active = null;
        const record = standIn(JSON.parse(recordText) as RunRecord, request, line);
        mockRuns.records.push(record);
        const done = (summary ?? "").trim() || `${label} finished in 0.1 s`;
        send({ kind: "finished", summary: done, statusBar: done, exitCode: 0, userStopped: false, succeeded: true, recordId: record.id, filed: "completed", filedReason: null });
      }, mockRuns.replayMs);
      return { started: true };
    },
  };
}
