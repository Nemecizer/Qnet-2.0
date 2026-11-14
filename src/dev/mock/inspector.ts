// The inspector's load readout in the browser preview and the tests (src-tauri/src/inspector.rs
// answers in the app, from core's traffic equations). This is a small stand-in: per-class traffic
// equations solved by fixed-point iteration, service capacity c / (the arrival-weighted mean
// service time). It agrees with core on open networks with infinite buffers, which is what the
// tests use; finite-buffer loss and blocking corrections are core's alone.
import type { BnetLink, BnetNode } from "../../lib/bnet";
import type { StabilityReadout } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";
import { sortIndex } from "../../editor/naming";
import { asDistribution, meanOfString } from "../../panes/inspector/distributions/families";

export function mockStability(stationId: string, nodes: BnetNode[], links: BnetLink[]): StabilityReadout | null {
  const station = nodes.find((n) => n.id === stationId && n.kind === "station");
  const sources = nodes.filter((n) => n.kind === "source").sort((a, b) => sortIndex(a.name) - sortIndex(b.name));
  if (!station || !sources.length) return null;
  const classOf = (l: BnetLink) => l.customerClass ?? 0;
  const exitOf = (l: BnetLink) => l.toCustomerClass ?? classOf(l);
  let k = sources.length;
  for (const l of links) k = Math.max(k, classOf(l) + 1, exitOf(l) + 1);
  const ext = new Map<string, number[]>();
  sources.forEach((s, c) => {
    const v = new Array(k).fill(0);
    const m = meanOfString(asDistribution(s.distribution), s.distributionParameters);
    v[c] = m && m > 0 ? 1 / m : 0;
    ext.set(s.id, v);
  });
  let flow = new Map<string, number[]>(nodes.map((n) => [n.id, ext.get(n.id) ?? new Array(k).fill(0)]));
  for (let it = 0; it < 5000; it++) {
    const next = new Map<string, number[]>(nodes.map((n) => [n.id, [...(ext.get(n.id) ?? new Array(k).fill(0))]]));
    for (const l of links) {
      const from = flow.get(l.fromNodeID);
      const to = next.get(l.toNodeID);
      if (!from || !to) continue;
      to[exitOf(l)] += from[classOf(l)] * l.routingProbability;
    }
    let delta = 0;
    for (const [id, v] of next) v.forEach((x, c) => (delta = Math.max(delta, Math.abs(x - flow.get(id)![c]))));
    flow = next;
    if (delta < 1e-13) break;
  }
  const perClass = flow.get(station.id)!;
  const arrival = perClass.reduce((s, x) => s + x, 0);
  const meanFor = (c: number) => {
    const cfg = station.serviceDistributions?.[String(c)];
    return cfg ? meanOfString(asDistribution(cfg.distribution), cfg.distributionParameters) : meanOfString(asDistribution(station.distribution), station.distributionParameters);
  };
  let weighted = 0;
  perClass.forEach((x, c) => {
    if (x > 0) weighted += x * (meanFor(c) ?? NaN);
  });
  const meanService = arrival > 0 ? weighted / arrival : (meanOfString(asDistribution(station.distribution), station.distributionParameters) ?? NaN);
  const capacity = station.numberOfServers / meanService;
  if (!Number.isFinite(arrival) || !Number.isFinite(capacity)) return null;
  return {
    arrivalRate: arrival,
    capacity,
    servers: station.numberOfServers,
    arrivalRatePerClass: perClass.map((x, c) => [c, x] as [number, number]).filter(([, x]) => Number.isFinite(x) && x > 0),
  };
}

/** Tests may replace `run`; `calls` counts the requests (the readout is debounced). */
export const mockInspector: { run: typeof mockStability; calls: number } = { run: mockStability, calls: 0 };

export function inspectorHandlers(): MockHandlers {
  mockInspector.run = mockStability;
  mockInspector.calls = 0;
  return {
    inspector_stability: ({ stationId, nodes, links }: { stationId: string; nodes: BnetNode[]; links: BnetLink[]; infiniteBuffers: boolean }) => {
      mockInspector.calls++;
      return mockInspector.run(stationId, nodes, links);
    },
  };
}
