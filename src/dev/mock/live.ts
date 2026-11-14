// `live_results` in the browser preview and the tests (src-tauri/src/live.rs). The preview can't
// run core, so this is a stand-in with the same shape and the same tiers, over the preview's own
// traffic model (./sweeps2 `mockTraffic`): a single-class exponential network with infinite
// buffers answers with M/M/c values, anything else with utilisation and the reason. It is not
// the app's arithmetic (that is core/src/jackson.rs, which has the exact checks). Tests set
// `mockLive.run` to answer exactly what a case needs, and read `calls`.
import type { BnetDocument } from "../../lib/bnet";
import type { LiveReason, LiveResults, LiveStation } from "../../live/model";
import { mostLoaded } from "../../results/insight";
import type { MockHandlers } from "../../test/tauri";
import { mockTraffic } from "./sweeps2";

const none = (detail: string): LiveResults => ({ tier: "none", perStation: [], network: null, reasonIfPartial: "noModel", reasonDetail: detail, utilisationExact: false, bottlenecks: [] });

/** Erlang C's mean number in system at utilisation ρ with c servers. */
function mmc(rho: number, c: number): number {
  if (c === 1) return rho / (1 - rho);
  const a = rho * c;
  let sum = 0;
  let term = 1;
  for (let n = 0; n < c; n++) {
    if (n > 0) term *= a / n;
    sum += term;
  }
  const tail = (term * a) / c / (1 - rho);
  return ((tail / (sum + tail)) * rho) / (1 - rho) + a;
}

export function standInLive(doc: BnetDocument): LiveResults {
  const nodes = doc.nodes ?? [];
  const count = (k: string) => nodes.filter((n) => n.kind === k).length;
  if (!count("station")) return none("The network has no stations.");
  if (!count("source")) return none("The network has no source node.");
  if (!count("sink")) return none("The network has no sink node.");
  const traffic = mockTraffic(doc);
  let reason: LiveReason | null = null;
  const names = (pick: (s: (typeof traffic)[number]) => boolean) => traffic.filter(pick).map((s) => s.name).join(", ");
  let detail = "";
  const exponential = (d: string) => d === "exponential" || d === "poisson";
  const odd = [...nodes.filter((n) => n.kind === "source" && !exponential(n.distribution)), ...nodes.filter((n) => n.kind === "station" && n.distribution !== "exponential")].map((n) => n.name);
  // Finite buffers first, as core/src/jackson.rs `could_be_jackson`: such a network has a steady
  // state at any offered load, so ρ ≥ 1 there is not "unstable".
  if (!doc.infiniteBuffers) reason = "finiteBuffers";
  else if (traffic.some((s) => s.utilisation >= 1)) [reason, detail] = ["unstable", names((s) => s.utilisation >= 1)];
  else if (traffic.some((s) => !(s.utilisation > 0))) [reason, detail] = ["noTraffic", names((s) => !(s.utilisation > 0))];
  else if (traffic.some((s) => s.flows.size > 1)) [reason, detail] = ["sharedStation", names((s) => s.flows.size > 1)];
  else if (odd.length) [reason, detail] = ["notExponential", odd.join(", ")];
  const exact = reason === null;
  const perStation: LiveStation[] = traffic.map((s) => {
    const l = exact ? mmc(s.utilisation, s.servers) : null;
    const lq = l === null ? null : Math.max(0, l - s.utilisation * s.servers);
    return {
      stationId: s.id,
      stationName: s.name,
      servers: s.servers,
      throughput: s.arrival,
      serviceRate: s.utilisation > 0 ? s.arrival / (s.utilisation * s.servers) : 0,
      utilisation: Number.isFinite(s.utilisation) ? s.utilisation : null,
      meanInSystem: l,
      meanWaiting: lq,
      meanSojourn: l === null ? null : l / s.arrival,
      meanWait: lq === null ? null : lq / s.arrival,
    };
  });
  // External arrivals: what the sources send.
  const lambda = nodes.filter((n) => n.kind === "source").reduce((sum, n) => sum + Number(/(?:rate|lambda)\s*=\s*([^,]+)/.exec(n.distributionParameters)?.[1] ?? 1), 0);
  const total = perStation.reduce((sum, s) => sum + (s.meanInSystem ?? 0), 0);
  return {
    tier: exact ? "exact" : "utilisation",
    perStation,
    network: exact && lambda > 0 ? { throughput: lambda, meanNumber: total, meanDelay: total / lambda } : null,
    reasonIfPartial: reason,
    reasonDetail: detail,
    utilisationExact: doc.infiniteBuffers && reason !== "unstable",
    bottlenecks: mostLoaded(perStation.filter((s) => s.utilisation !== null), (s) => s.utilisation!).map((s) => s.stationId),
  };
}

/** What `live_results` answers; tests set `run` (it may return a promise, or throw). */
export const mockLive: { run: (doc: BnetDocument) => LiveResults | Promise<LiveResults>; calls: number } = { run: standInLive, calls: 0 };

export function liveHandlers(): MockHandlers {
  mockLive.run = standInLive;
  mockLive.calls = 0;
  return {
    live_results: ({ document }: { document: BnetDocument }) => {
      mockLive.calls++;
      return mockLive.run(document);
    },
  };
}
