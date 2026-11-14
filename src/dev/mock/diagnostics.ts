// `network_diagnostics` in the browser preview and the tests (src-tauri/src/diagnostics.rs). The
// preview can't run core, so this is a stand-in with the same shape and the same rules, over the
// preview's own traffic model (./sweeps2 `mockTraffic`): the structure checks, the link rules and
// each station's load, and the two routing-row problems (a row over 1, and a row over 1 only once
// its sink link is counted) with the numbers their fixes apply. The row-over-1 scaling is offered
// without Rust's check that the scaled network is stable; a class that never leaves is not in
// the preview. Tests set `mockDiagnostics.run` to answer
// exactly what a case needs, and read `calls`.
import type { Diagnostic, DiagnosticValues } from "../../canvas/validation/model";
import type { BnetDocument, BnetNode } from "../../lib/bnet";
import type { MockHandlers } from "../../test/tauri";
import { mockTraffic } from "./sweeps2";

const TARGET_RHO = 0.8;

/** Two significant figures, rounded up ("1.3"). */
function roundUp2(v: number): number | null {
  if (!(Number.isFinite(v) && v > 0)) return null;
  const unit = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Number((Math.ceil(v / unit - 1e-9) * unit).toPrecision(2));
}

function reach(starts: string[], next: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(next.get(id) ?? []));
  }
  return seen;
}

const rateOf = (params: string): number => {
  const m = /(?:rate|lambda)\s*=\s*([^,]+)/.exec(params);
  return m ? Number(m[1]) : 1;
};

export function standInDiagnostics(doc: BnetDocument): Diagnostic[] {
  const nodes = doc.nodes ?? [];
  const links = doc.links ?? [];
  if (!nodes.length) return [{ severity: "info", code: "emptyNetwork", nodeIds: [], linkIds: [], values: {} }];
  const out: Diagnostic[] = [];
  const add = (severity: Diagnostic["severity"], code: string, node: BnetNode | null, values: DiagnosticValues = {}, linkIds: string[] = []) =>
    out.push({ severity, code, nodeIds: node ? [node.id] : [], linkIds, values: { ...(node ? { name: node.name } : {}), ...values } });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const live = links.filter((l) => byId.has(l.fromNodeID) && byId.has(l.toNodeID));
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const l of live) {
    forward.set(l.fromNodeID, [...(forward.get(l.fromNodeID) ?? []), l.toNodeID]);
    backward.set(l.toNodeID, [...(backward.get(l.toNodeID) ?? []), l.fromNodeID]);
  }
  const kind = (k: BnetNode["kind"]) => nodes.filter((n) => n.kind === k);
  const [sources, stations, sinks] = [kind("source"), kind("station"), kind("sink")];
  if (!sources.length) add("error", "noSource", null);
  if (!stations.length) add("error", "noStation", null);
  if (!sinks.length) add("error", "noSink", null);
  const fed = reach(sources.map((n) => n.id), forward);
  const drains = reach(sinks.map((n) => n.id), backward);
  const noArrivals = new Set<string>();
  let structural = !sources.length || !stations.length || !sinks.length;
  for (const n of nodes) {
    const outgoing = forward.get(n.id)?.length ?? 0;
    const unconnected = n.kind === "source" && outgoing === 0;
    if (unconnected) add("error", "sourceUnconnected", n);
    if (n.kind === "source" && n.distribution in { exponential: 1, poisson: 1 } && !(rateOf(n.distributionParameters) > 0)) add("error", "badArrivalRate", n);
    if (n.kind === "station") {
      const buffers = new Set((backward.get(n.id) ?? []).filter((f) => byId.get(f)!.kind === "buffer")).size;
      if (buffers !== 1) {
        structural = true;
        add("error", buffers ? "stationManyBuffers" : "stationNeedsBuffer", n);
      }
      if (n.distribution === "exponential" && !(rateOf(n.distributionParameters) > 0)) add("error", "badServiceRate", n);
      if (n.numberOfServers < 1) add("error", "noServers", n, { servers: n.numberOfServers });
    }
    if (n.kind === "buffer" && !doc.infiniteBuffers && n.bufferSize < 1) add("warning", "bufferSizeZero", n, { size: n.bufferSize });
    if (n.kind === "sink" && !(backward.get(n.id)?.length ?? 0)) add("info", "sinkUnused", n);
    if (sources.length && (n.kind === "station" || n.kind === "buffer") && !fed.has(n.id)) {
      noArrivals.add(n.id);
      add("warning", "noArrivals", n);
    }
    if (sinks.length && n.kind !== "sink" && !drains.has(n.id) && !unconnected) add("warning", outgoing ? "noPathToSink" : "noWayOut", n);
  }
  for (const l of live) {
    const from = byId.get(l.fromNodeID)!;
    const to = byId.get(l.toNodeID)!;
    const values = { name: from.name, other: to.name };
    if (from.kind === "sink") add("warning", "linkOutOfSink", null, values, [l.id]);
    else if (from.kind === "source" && to.kind !== "buffer") add("error", "sourceMustFeedBuffer", null, values, [l.id]);
    else if (to.kind === "sink" && from.kind !== "station" && !(from.kind === "buffer" && !doc.infiniteBuffers)) add("error", "sinkFedByBuffer", null, values, [l.id]);
    else if (!(l.routingProbability > 0)) add("warning", "linkNeverUsed", null, values, [l.id]);
  }
  // Routing rows, as src-tauri/src/diagnostics.rs: `routingOverOne` when the links that do not
  // enter a sink sum past 1 (core's refusal), `routingSinkOverOne` when only the whole row does.
  const down3 = (x: number) => Math.floor(x * 1e3 + 1e-6) / 1e3;
  const classes = [...new Set(live.map((l) => l.customerClass))].sort((a, b) => a - b);
  for (const s of stations) {
    for (const cls of classes) {
      const row = links.filter((l) => l.fromNodeID === s.id && l.customerClass === cls);
      const toSink = row.filter((l) => byId.get(l.toNodeID)?.kind === "sink" && l.routingProbability > 0);
      const onward = row.filter((l) => byId.has(l.toNodeID) && byId.get(l.toNodeID)!.kind !== "sink");
      const total = (ls: typeof row) => ls.reduce((a, l) => a + l.routingProbability, 0);
      const [exit, rest] = [total(toSink), total(onward)];
      if (rest > 1 + 1e-9) {
        structural = true;
        const values: DiagnosticValues = { sum: rest, classIndex: cls };
        const scaled = onward.map((l) => down3((l.routingProbability * (1 - exit)) / rest));
        if (exit < 1 && scaled.every((p, i) => p > 0 || onward[i].routingProbability === 0)) {
          values.suggestedProbabilities = scaled;
          if (exit > 0) values.exit = exit;
        }
        add("error", "routingOverOne", s, values, onward.map((l) => l.id));
      } else if (toSink.length && rest + exit > 1 + 1e-12) {
        const left = Math.max(0, 1 - rest);
        const values: DiagnosticValues = { sum: rest + exit, classIndex: cls, exit: left };
        const share = toSink.map((l) => down3((l.routingProbability * left) / exit));
        if (share.every((p) => p > 0) && rest + share.reduce((a, b) => a + b, 0) <= 1 + 1e-12) values.suggestedProbabilities = share;
        add("warning", "routingSinkOverOne", s, values, toSink.map((l) => l.id));
      }
    }
  }
  // A source whose links (into a buffer or a station) sum above 1: core/src/sim.rs `sources_over_one`.
  for (const s of sources) {
    const row = live.filter((l) => l.fromNodeID === s.id && byId.get(l.toNodeID)!.kind !== "sink");
    // A link straight into a station is `sourceMustFeedBuffer`, said on the link itself.
    if (row.some((l) => byId.get(l.toNodeID)!.kind !== "buffer")) continue;
    const sum = row.reduce((a, l) => a + Math.max(0, l.routingProbability), 0);
    if (sum > 1 + 1e-9) add("warning", "sourceOverOne", s, { sum }, live.filter((l) => l.fromNodeID === s.id).map((l) => l.id));
  }
  if (!structural) {
    for (const s of mockTraffic(doc)) {
      const node = byId.get(s.id)!;
      const rho = s.utilisation;
      if (!Number.isFinite(rho)) continue;
      const mu = rho > 0 ? s.arrival / (rho * s.servers) : rateOf(node.distributionParameters);
      const values: DiagnosticValues = { rho, arrivalRate: s.arrival, serviceRate: mu, servers: s.servers };
      const need = Math.ceil(s.arrival / (TARGET_RHO * mu) - 1e-9);
      if (need > s.servers) values.suggestedServers = need;
      const rate = roundUp2(s.arrival / (s.servers * TARGET_RHO));
      if (node.distribution === "exponential" && !Object.keys(node.serviceDistributions ?? {}).length && rate !== null && rate > mu) {
        values.suggestedRate = rate;
        values.suggestedParameters = `rate=${rate}`;
      }
      if (rho >= 1) add(doc.infiniteBuffers ? "error" : "warning", doc.infiniteBuffers ? "unstable" : "overloaded", node, values);
      else if (rho >= 0.95) add("warning", "nearlyUnstable", node, values);
      else if (rho <= 1e-9 && !noArrivals.has(node.id)) add("warning", "noArrivals", node);
    }
  }
  const rank = { error: 0, warning: 1, info: 2 };
  return out.map((d, i) => ({ d, i })).sort((a, b) => rank[a.d.severity] - rank[b.d.severity] || a.i - b.i).map((x) => x.d);
}

/** What `network_diagnostics` answers; tests set `run`. */
export const mockDiagnostics: { run: (doc: BnetDocument) => Diagnostic[]; calls: number } = { run: standInDiagnostics, calls: 0 };

export function diagnosticsHandlers(): MockHandlers {
  mockDiagnostics.run = standInDiagnostics;
  mockDiagnostics.calls = 0;
  return {
    network_diagnostics: ({ document }: { document: BnetDocument }) => {
      mockDiagnostics.calls++;
      return mockDiagnostics.run(document);
    },
  };
}
