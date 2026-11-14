// `capacity_plan` in the browser preview and the tests (src-tauri/src/optimise.rs). The preview
// can't run core, so this is a stand-in with the same shape: for a single-class exponential
// network with infinite buffers it runs the interface's own greedy search (src/optimise/model.ts
// `greedySearch`, the one the route over solver runs uses) on the preview's stand-in model
// (./sweeps2: traffic by substitution, M/M/c by a one-line form that is exact for one server),
// and for service rates it applies the square-root rule to that model's arrival rates; anything
// else is answered "no closed formula", as the app answers it. It does no exact search, so with
// unequal costs it says "not proven". The numbers are a preview's, never Qnet's: the app's are
// core/src/optimise.rs, which has the exact checks. Tests set `mockCapacity.run` to answer
// exactly what a case needs, and read `calls`.
import type { BnetDocument } from "../../lib/bnet";
import { openOnly } from "../../closed/shape";
import { asResult } from "../../panes/results/model";
import { evaluationOf, fewestServers, greedySearch, planFromSearch, unavailable, UNIT_OF, type CapacityInfeasible, type CapacityPlan, type CapacityRequest, type Evaluation, type LoadedStation, type SearchStation } from "../../optimise/model";
import { withServers } from "../../optimise/runner";
import { totalArrivals } from "../../sensitivity/model";
import { discoverParameters } from "../../sweeps/model";
import type { MockHandlers } from "../../test/tauri";
import { NOT_JACKSON } from "./sensitivity";
import { mockQuietRecord, mockTraffic } from "./sweeps2";

export const mockCapacity = {
  /** Answers instead of the stand-in, when set. */
  run: null as null | ((request: CapacityRequest) => CapacityPlan | Promise<CapacityPlan>),
  calls: [] as CapacityRequest[],
};

export const CLOSED = "This is a closed network: a fixed number of customers circulates and nothing arrives from outside. Capacity planning covers open networks.";

/** The stand-in's answer. */
export async function standInCapacity(request: CapacityRequest): Promise<CapacityPlan> {
  const doc = request.document as BnetDocument;
  const stationsOf = doc.nodes.filter((n) => n.kind === "station");
  if (!stationsOf.length) return unavailable("network", "The network has no stations.");
  const refusal = openOnly(doc, "Capacity planning");
  if (refusal) return unavailable(refusal.reason, refusal.sentence);
  if (!doc.nodes.some((n) => n.kind === "source")) return unavailable("network", "The network has no source node.");
  if (!doc.nodes.some((n) => n.kind === "sink")) return unavailable("network", "The network has no sink node.");
  const traffic = mockTraffic(doc);
  const exponential = doc.nodes.every((n) => (n.kind !== "station" && n.kind !== "source") || n.distribution === "exponential" || (n.kind === "source" && n.distribution === "poisson"));
  const perClass = stationsOf.some((n) => Object.values(n.serviceDistributions ?? {}).some((l) => l.distribution !== "exponential"));
  if (!doc.infiniteBuffers || !exponential || perClass || traffic.some((s) => s.flows.size !== 1)) return unavailable("notJackson", NOT_JACKSON);

  const stations: LoadedStation[] = traffic.map((s) => ({ id: s.id, name: s.name, load: s.utilisation * s.servers, serversNow: s.servers }));
  const ids = stations.map((s) => s.id);
  const lambda = totalArrivals(doc, discoverParameters(doc)) ?? 0;
  const evaluate = (allocation: number[]): Evaluation | null => {
    if (stations.some((s, i) => s.load / allocation[i] >= 1)) return null;
    const moved = withServers(doc, ids, allocation);
    return evaluationOf(asResult(mockQuietRecord({ tabId: "preview", title: "preview", method: "product_form" }, moved)), moved, request.constraints, stations, allocation);
  };
  const nowAllocation = stations.map((s) => s.serversNow);
  const now = evaluate(nowAllocation);
  const floor = lambda > 0 ? stations.reduce((sum, s) => sum + s.load, 0) / lambda : null;
  const asked = (id: string) => request.stations.find((x) => x.id === id);
  const base = (infeasible: CapacityInfeasible | null): CapacityPlan => ({
    ...unavailable(null, ""), available: true, sentence: null, decision: request.decision, infeasible, searchLimit: 2_000_000, delayFloor: floor, totalArrivals: lambda || null,
    stations: stations.map((s, i) => ({ id: s.id, name: s.name, free: asked(s.id)?.free ?? true, load: s.load, serversNow: s.serversNow, servers: s.serversNow, rateNow: traffic[i].arrival / s.load, rate: traffic[i].arrival / s.load, unitCost: 1, costNow: s.serversNow, cost: s.serversNow, utilisationNow: s.load / s.serversNow < 1 ? s.load / s.serversNow : null, utilisation: s.load / s.serversNow })),
    constraints: request.constraints.map((c, k) => ({ ...c, unit: UNIT_OF[c.kind], now: now?.values[k] ?? null, proposed: null })),
    costNow: stations.reduce((sum, s) => sum + s.serversNow * (asked(s.id)?.cost ?? 1), 0), delayNow: now?.delay ?? null, numberNow: now?.number ?? null,
  });

  if (request.decision === "rates") {
    if (!request.constraints.length || request.constraints.some((c) => c.kind === "utilisation" || c.kind === "stationWait")) return base({ why: "ratesTarget", constraint: null, stationId: null, value: null });
    const several = stations.find((s) => (asked(s.id)?.free ?? true) && s.serversNow !== 1);
    if (several) return base({ why: "severalServers", constraint: null, stationId: several.id, value: null });
    const number = Math.min(...request.constraints.map((c) => (c.kind === "networkSojourn" ? c.target * lambda : c.target)));
    const free = traffic.map((s) => asked(s.id)?.free ?? true);
    const d = traffic.map((s) => asked(s.id)?.rateCost ?? 1);
    const mu = traffic.map((s, i) => s.arrival / stations[i].load);
    // The square-root rule (Kleinrock): μ = α + √(α/d)·Σ√(αd)/N, on what is left of N after the held stations.
    const at = (n: number) => {
      const held = traffic.reduce((sum, _s, i) => sum + (free[i] ? 0 : stations[i].load / (1 - stations[i].load)), 0);
      if (!(n > held) || !free.some(Boolean)) return null;
      const S = traffic.reduce((sum, s, i) => sum + (free[i] ? Math.sqrt(s.arrival * d[i]) : 0), 0);
      const rate = traffic.map((s, i) => (free[i] ? s.arrival + (Math.sqrt(s.arrival / d[i]) * S) / (n - held) : mu[i]));
      return { rate, cost: rate.reduce((sum, r, i) => sum + (free[i] ? r * d[i] : 0), 0) };
    };
    const best = at(number);
    const plan = base(null);
    plan.costNow = mu.reduce((sum, r, i) => sum + (free[i] ? r * d[i] : 0), 0);
    if (!best) return { ...plan, infeasible: { why: free.some(Boolean) ? "fixedTooFull" : "nothingFree", constraint: null, stationId: null, value: null } };
    plan.stations = plan.stations.map((s, i) => ({ ...s, rate: best.rate[i], unitCost: d[i], costNow: mu[i] * d[i], cost: best.rate[i] * d[i], utilisation: traffic[i].arrival / best.rate[i] }));
    plan.cost = best.cost;
    plan.proof = "closedForm";
    plan.number = number;
    plan.delay = number / lambda;
    plan.constraints = plan.constraints.map((c) => ({ ...c, proposed: c.kind === "networkSojourn" ? number / lambda : number }));
    for (let k = 0; k <= 24; k++) {
      const n = number * Math.pow(2, 1.5 - k / 8);
      const q = at(n);
      if (q) plan.path.push({ cost: q.cost, number: n, delay: n / lambda, added: null, feasible: n <= number });
    }
    return plan;
  }

  const u = request.constraints.filter((c) => c.kind === "utilisation").reduce<number | null>((m, c) => (m === null ? c.target : Math.min(m, c.target)), null);
  const search: SearchStation[] = [];
  for (const s of stations) {
    const a = asked(s.id);
    const free = a?.free ?? true;
    const start = free ? Math.max(a?.lower ?? 1, fewestServers(s.load, u)) : s.serversNow;
    const upper = free ? (a?.upper ?? null) : s.serversNow;
    if (!free && s.load / s.serversNow >= 1) return base({ why: "fixedOverloaded", constraint: null, stationId: s.id, value: null });
    if (start > (upper ?? Infinity)) {
      const stable = fewestServers(s.load, null);
      return base(stable > (upper ?? Infinity) ? { why: "limitOverloaded", constraint: null, stationId: s.id, value: stable } : { why: "stationLimit", constraint: request.constraints.findIndex((c) => c.kind === "utilisation"), stationId: s.id, value: s.load / (upper ?? s.serversNow) });
    }
    search.push({ id: s.id, free, cost: a?.cost ?? 1, start, upper });
  }
  // A network target at or under the service itself can never be met.
  for (const [k, c] of request.constraints.entries()) {
    const least = floor === null ? null : c.kind === "networkSojourn" ? floor : c.kind === "networkNumber" ? floor * lambda : null;
    if (least !== null && c.target <= least && search.every((s) => s.free && s.upper === null)) return base({ why: "serviceFloor", constraint: k, stationId: null, value: least });
  }
  const outcome = await greedySearch(search, request.constraints.map((c) => c.target), async (a) => evaluate(a), 4000, 6);
  if (!outcome.path.length) return base({ why: "tooMany", constraint: null, stationId: null, value: null });
  if (outcome.ended !== "met") {
    const k = request.constraints.findIndex((c, i) => (outcome.path[outcome.chosen].evaluation.values[i] ?? Infinity) > c.target);
    return base({ why: "floor", constraint: k < 0 ? null : k, stationId: null, value: k < 0 ? null : outcome.path[outcome.chosen].evaluation.values[k] });
  }
  const plan = planFromSearch(request, stations, search, outcome, now, (kind) => UNIT_OF[kind]);
  const costs = search.filter((s) => s.free).map((s) => s.cost);
  return { ...plan, proof: costs.every((c) => c === costs[0]) ? "marginal" : "none", searchLimit: 0, delayFloor: floor, totalArrivals: lambda || null, stations: plan.stations.map((s, i) => ({ ...s, rateNow: traffic[i].arrival / s.load, rate: traffic[i].arrival / s.load })) };
}

export function capacityHandlers(): MockHandlers {
  mockCapacity.run = null;
  mockCapacity.calls = [];
  return {
    capacity_plan: ({ request }: { request: CapacityRequest }) => {
      mockCapacity.calls.push(request);
      return (mockCapacity.run ?? standInCapacity)(request);
    },
  };
}
