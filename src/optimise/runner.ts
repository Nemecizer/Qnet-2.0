// The route over solver runs of Results ▸ Capacity (new in 2.1, ROADMAP D5), for a network with
// no closed formula: the same greedy search Rust runs on closed forms (./model.ts `greedySearch`),
// each allocation solved by one quiet run of one method. Experimental, and labelled so: the plan
// is good, not proven best, and as trustworthy as the method.
//
// It runs on the What-If Sweep's machinery as Results ▸ Sensitivity's numerical route does, under
// its own name ("Capacity" in the status bar, Run ▸ Stop, the busy line and the cannot-close
// warning): `quiet_begin` claims the app's one run slot, each solve is a `quiet_run` of that
// session (nothing is filed, nothing reaches the Shell pane), `followRun` shows progress and Run ▸
// Stop ends it — the best plan reached by then is kept. The method is the one Solve would choose,
// unless that is a simulation: allocations that differ by one server are compared, and a
// simulation's noise exceeds that difference (src/sensitivity/runner.ts `differentiable`).
import { api } from "../lib/api";
import type { BnetDocument } from "../lib/bnet";
import { allSettings } from "../lib/kv";
import type { QuietOutcome, RunMessage } from "../lib/types";
import { fingerprintNow } from "../panes/results/fingerprint";
import { asResult, type ResultRecord } from "../panes/results/model";
import { followRun } from "../runs/state";
import { differentiable } from "../sensitivity/runner";
import { methodsFor, type MethodChoice } from "../sweeps/runner";
import { tabById, type Tab } from "../workspace/store";
import { evaluationOf, fewestServers, greedySearch, MAX_RUNS, planFromSearch, problemKey, stationsOf, unavailable, UNIT_OF, type CapacityPlan, type CapacityRequest, type CapacityResult, type Evaluation, type LoadedStation, type SearchStation } from "./model";
import { setCapacityPlan } from "./store";
import { capacityWords as w } from "./words";

/** The run label the search shows under ("Capacity": src-tauri/src/quiet_runs.rs `CAPACITY_LABEL`). */
export const CAPACITY_METHOD = "capacity";

export interface SearchRoute {
  /** The method searched with; null when none can be. */
  method: MethodChoice | null;
  /** Only simulations apply. */
  simulationOnly: boolean;
  runs: number;
  seconds: number | null;
}

export async function searchRoute(tab: Pick<Tab, "id" | "document">): Promise<SearchRoute> {
  const offered = await methodsFor(tab).catch(() => [] as MethodChoice[]);
  const method = differentiable(offered);
  return { method, simulationOnly: !method && offered.length > 0, runs: MAX_RUNS, seconds: method ? MAX_RUNS * method.seconds : null };
}

const clock = (s: number) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`);

let running: Promise<unknown> | null = null;
export const capacityRunning = () => running !== null;

/** `doc` with the stations' numbers of servers set to `allocation` (stations in export order). */
export function withServers(doc: BnetDocument, ids: readonly string[], allocation: readonly number[]): BnetDocument {
  return { ...doc, nodes: doc.nodes.map((n) => {
    const i = ids.indexOf(n.id);
    return i >= 0 && Math.max(1, n.numberOfServers ?? 1) !== allocation[i] ? { ...n, numberOfServers: allocation[i] } : n;
  }) };
}

/**
 * Searches for a plan for the tab's network and `request` over quiet runs of `method`, and saves
 * it as the tab's (also when Stop cut it short, or the runs ran out: the best reached). Null when
 * it could not start or the starting allocation could not be solved.
 */
export function runCapacitySearch(tabId: string, request: CapacityRequest, method: MethodChoice): Promise<CapacityResult | null> {
  const tab = tabById(tabId);
  if (!tab || running) return Promise.resolve(null);
  const doc = tab.document;
  const title = tab.title;
  const settings = allSettings();
  let finish: (v: CapacityResult | null) => void = () => {};
  const done = new Promise<CapacityResult | null>((resolve) => (finish = resolve));
  const work = (async () => {
    const started = await followRun(tabId, CAPACITY_METHOD, async (onMessage: (m: RunMessage) => void) => {
      let begun: { started: boolean; sentence: string | null; sweepId?: string | null };
      try {
        begun = await api.quietBegin(tabId, title, CAPACITY_METHOD);
      } catch (e) {
        begun = { started: false, sentence: String(e) };
      }
      if (!begun.started) {
        onMessage({ kind: "status", text: w.couldNotStart(begun.sentence ?? ""), severity: "warning" });
        return { started: false };
      }
      const sweepId = begun.sweepId ?? null;
      const t0 = Date.now();
      const elapsed = () => (Date.now() - t0) / 1000;
      let ran = 0;
      let problem: string | null = null;
      const status = (text: string, severity: "info" | "warning" | "error" | "success") => onMessage({ kind: "status", text, severity });
      const progress = () => onMessage({ kind: "progress", fraction: Math.min(1, ran / MAX_RUNS), elapsedSeconds: elapsed(), text: w.progress(Math.min(MAX_RUNS, ran + 1), MAX_RUNS, clock(elapsed())) });
      const solve = async (d: BnetDocument): Promise<ResultRecord | null | "stopped"> => {
        problem = null;
        let outcome: QuietOutcome;
        try {
          outcome = await api.quietRun({ tabId, title, document: d, method: method.label, settings, sweepId });
        } catch (e) {
          outcome = { kind: "failed", sentence: String(e) };
        }
        ran++;
        progress();
        if (outcome.kind === "stopped") return "stopped";
        if (outcome.kind !== "record") {
          problem = outcome.sentence;
          return null;
        }
        return asResult(outcome.record);
      };

      const body = async (): Promise<{ value: CapacityResult | null; ok: boolean; stopped: boolean }> => {
        const fail = (text: string) => {
          status(text, "error");
          return { value: null, ok: false, stopped: false };
        };
        const probe = await api.quietProbe(doc).catch(() => null);
        if (!probe || probe.error) return fail(w.couldNotStart(probe?.error ?? ""));
        const drawn = stationsOf(doc);
        const stations: LoadedStation[] = drawn.map((s) => ({ id: s.id, name: s.name, serversNow: s.servers, load: (probe.loads.find((l) => l.station === s.name)?.utilisation ?? 0) * s.servers }));
        const u = request.constraints.filter((c) => c.kind === "utilisation").reduce<number | null>((m, c) => (m === null ? c.target : Math.min(m, c.target)), null);
        const fingerprint = await fingerprintNow(doc).catch(() => null);
        const save = (plan: CapacityPlan, ended: CapacityResult["ended"]): CapacityResult => {
          const result: CapacityResult = { route: "runs", tier: method.tier, method: { label: method.label, name: method.name }, plan, ended, runs: ran, key: problemKey(request), fingerprint, network: { nodes: doc.nodes, links: doc.links, infiniteBuffers: doc.infiniteBuffers } };
          setCapacityPlan(tabId, result);
          return result;
        };
        const search: SearchStation[] = [];
        for (const [i, s] of stations.entries()) {
          const asked = request.stations.find((x) => x.id === s.id);
          const free = asked?.free ?? true;
          const start = free ? Math.max(asked?.lower ?? 1, fewestServers(s.load, u)) : s.serversNow;
          const upper = free ? (asked?.upper ?? null) : s.serversNow;
          // A station that cannot have the servers it needs: said as the exact route says it, with no run made.
          if (start > (upper ?? Infinity) || (!free && s.load / s.serversNow >= 1)) {
            const why = !free ? (s.load / s.serversNow >= 1 ? "fixedOverloaded" : "stationLimit") : fewestServers(s.load, null) > (upper ?? Infinity) ? "limitOverloaded" : "stationLimit";
            const plan: CapacityPlan = { ...unavailable(null, ""), available: true, sentence: null, infeasible: { why, constraint: why === "stationLimit" ? request.constraints.findIndex((c) => c.kind === "utilisation") : null, stationId: s.id, value: why === "limitOverloaded" ? fewestServers(s.load, null) : s.load / (upper ?? s.serversNow) }, stations: stations.map((x) => ({ id: x.id, name: x.name, free: true, load: x.load, serversNow: x.serversNow, servers: x.serversNow, rateNow: 0, rate: 0, unitCost: 1, costNow: x.serversNow, cost: x.serversNow, utilisationNow: null, utilisation: x.load / x.serversNow })), constraints: request.constraints.map((c) => ({ ...c, unit: UNIT_OF[c.kind], now: null, proposed: null })) };
            const value = save(plan, "limits");
            return { value, ok: true, stopped: false };
          }
          search[i] = { id: s.id, free, cost: asked?.cost ?? 1, start, upper };
        }
        const ids = stations.map((s) => s.id);
        const evaluate = async (allocation: number[]): Promise<Evaluation | null | "stopped"> => {
          const record = await solve(withServers(doc, ids, allocation));
          return record === "stopped" || record === null ? record : evaluationOf(record, withServers(doc, ids, allocation), request.constraints, stations, allocation);
        };
        // The network as drawn, for "now": one run, unless it is overloaded or is the start itself.
        const nowAllocation = stations.map((s) => s.serversNow);
        const startIsNow = search.every((s, i) => s.start === nowAllocation[i]);
        let now: Evaluation | null = null;
        if (!startIsNow && stations.every((s) => s.load / s.serversNow < 1)) {
          const e = await evaluate(nowAllocation);
          if (e === "stopped") return { value: null, ok: false, stopped: true };
          now = e;
        }
        const outcome = await greedySearch(search, request.constraints.map((c) => c.target), evaluate, MAX_RUNS - ran);
        if (!outcome.path.length) return outcome.ended === "stopped" ? { value: null, ok: false, stopped: true } : fail(w.baseFailed(method.name, problem ?? ""));
        const missing = outcome.path[0].evaluation.values.findIndex((v) => v === null);
        if (missing >= 0) return fail(w.noMeasure(method.name, w.constraintName(request.constraints[missing].kind, stations.find((s) => s.id === request.constraints[missing].stationId)?.name ?? null)));
        if (startIsNow) now = outcome.path[0].evaluation;
        const plan = planFromSearch(request, stations, search, outcome, now, (k) => UNIT_OF[k]);
        const result = save(plan, outcome.ended);
        status(w.doneLine(outcome.ended === "met", ran), outcome.ended === "met" ? "success" : "warning");
        return { value: result, ok: true, stopped: outcome.ended === "stopped" };
      };

      status(w.started(method.name, MAX_RUNS), "info");
      progress();
      void body()
        .then(
          (r) => r,
          (e) => {
            status(w.couldNotStart(String(e)), "error");
            return null;
          },
        )
        .then(async (r) => {
          await api.quietEnd(sweepId).catch(() => {});
          const time = clock(elapsed());
          const summary = !r ? w.failed(time) : r.stopped ? w.cancelled(time) : r.ok ? w.finished(time) : w.failed(time);
          onMessage({ kind: "finished", summary, statusBar: summary, exitCode: !r || !r.ok ? 1 : r.stopped ? 130 : 0, userStopped: !!r?.stopped, succeeded: !!r && r.ok && !r.stopped, recordId: null, filed: null, filedReason: null });
          finish(r ? r.value : null);
        });
      return { started: true };
    });
    return started ? done : null;
  })();
  running = work;
  return work.finally(() => {
    running = null;
  });
}

/** For tests. */
export function resetCapacityRunner() {
  running = null;
}
