// The numerical route of Results ▸ Sensitivity (new in 2.1, ROADMAP D1), for a network with no
// closed formula: each continuous parameter's derivative is a central difference over two quiet
// runs of one method (./model.ts `stepPlan`), a whole-number parameter's effect is one run with
// one more, and "what would it take" is a bounded search (`findValue`).
//
// It runs on the What-If Sweep's machinery and nothing else, under its own name ("Sensitivity" in
// the status bar, Run ▸ Stop, the busy line and the cannot-close warning): `quiet_begin` claims the app's one
// run slot, each solve is a `quiet_run` of that sweep (nothing is filed, nothing reaches the
// Shell pane), `followRun` shows progress in the status bar and Run ▸ Stop ends it — what was
// finished by then is kept. The method is the one Solve would choose, unless that is a
// simulation: a simulation is never differentiated (its noise exceeds the difference between two
// nearby runs), and the next method that is not one is used; with none, the route is refused.
import { api } from "../lib/api";
import type { BnetDocument } from "../lib/bnet";
import { allSettings } from "../lib/kv";
import type { QuietOutcome, RunMessage } from "../lib/types";
import { fingerprintNow } from "../panes/results/fingerprint";
import { asResult } from "../panes/results/model";
import { followRun } from "../runs/state";
import { allowed, discoverParameters, substitute, type SweepParameter } from "../sweeps/model";
import { methodsFor, type MethodChoice } from "../sweeps/runner";
import { tabById, type Tab } from "../workspace/store";
import { bottlenecks, difference, elasticityOf, FIND_EVALUATIONS, findValue, measureOptions, pickMeasure, ranked, readMeasure, stepPlan, type MeasureChoice, type SensitivityResult, type SensitivityRow } from "./model";
import { sensitivityEstimate, setSensitivityEstimate } from "./store";
import { sensitivityWords as w } from "./words";

/** The run label the estimate shows under ("Sensitivity": src/runs/ui/words.ts `displayLabel`; src-tauri/src/quiet_runs.rs `SENSITIVITY_LABEL`). */
export const SENSITIVITY_METHOD = "sensitivity";

/** The most parameters differentiated in one go (two runs each, at most). */
export const MAX_PARAMETERS = 16;
/** "What would it take" searches the most influential parameters only. */
export const MAX_OPTIONS = 5;

const ORDER: SweepParameter["kind"][] = ["service", "arrival", "servers", "buffer", "routing", "load"];

/** The parameters analysed: every one a sweep offers; with one source the load factor is that source's rate again, and is left out. */
export function analysable(doc: BnetDocument): SweepParameter[] {
  const all = discoverParameters(doc);
  return all.filter((p) => p.kind === "arrival").length <= 1 ? all.filter((p) => p.kind !== "load") : all;
}

/** The parameters the numerical route takes, most useful kinds first, and how many it leaves out. */
export function chosenParameters(doc: BnetDocument): { parameters: SweepParameter[]; leftOut: number } {
  const all = analysable(doc);
  const sorted = [...all].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return { parameters: sorted.slice(0, MAX_PARAMETERS), leftOut: Math.max(0, sorted.length - MAX_PARAMETERS) };
}

/** How many solver runs the estimate takes: the network as it is, then one or two per parameter. */
export function runCount(parameters: readonly SweepParameter[]): number {
  return 1 + parameters.reduce((n, p) => n + (p.integer ? 1 : (stepPlan(p)?.oneSided ? 1 : stepPlan(p) ? 2 : 0)), 0);
}

export interface NumericPlan {
  /** The method to differentiate; null when none can be. */
  method: MethodChoice | null;
  /** Only simulations apply. */
  simulationOnly: boolean;
  parameters: SweepParameter[];
  leftOut: number;
  runs: number;
  seconds: number | null;
}

/** The method the numerical route would use: Solve's order, simulations passed over. */
export function differentiable(offered: readonly MethodChoice[]): MethodChoice | null {
  const steady = offered.filter((m) => m.tier !== "simulation" && !m.slow);
  return steady.find((m) => m.tier === "exact") ?? steady[0] ?? null;
}

export async function numericPlan(tab: Pick<Tab, "id" | "document">): Promise<NumericPlan> {
  const offered = await methodsFor(tab).catch(() => [] as MethodChoice[]);
  const method = differentiable(offered);
  const { parameters, leftOut } = chosenParameters(tab.document);
  const runs = runCount(parameters);
  return { method, simulationOnly: !method && offered.length > 0, parameters, leftOut, runs, seconds: method ? runs * method.seconds : null };
}

const clock = (s: number) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`);

interface Session {
  /** The measure for `doc`, null where it cannot be solved (with the sentence in `lastProblem`), or "stopped". */
  solve: (doc: BnetDocument) => Promise<number | null | "stopped">;
  lastProblem: () => string | null;
  status: (text: string, severity: "info" | "warning" | "error" | "success") => void;
  setTotal: (n: number) => void;
}

let running: Promise<unknown> | null = null;
export const sensitivityRunning = () => running !== null;

/** Holds the run slot while `body` solves; resolves to what it returned, or null when it could not start. */
async function session<T>(tabId: string, method: MethodChoice, measure: MeasureChoice, total: number, startLine: string, body: (s: Session) => Promise<{ value: T; ok: boolean; stopped: boolean }>): Promise<T | null> {
  const tab = tabById(tabId);
  if (!tab || running) return null;
  const title = tab.title;
  const settings = allSettings();
  let finish: (v: T | null) => void = () => {};
  const done = new Promise<T | null>((resolve) => (finish = resolve));
  const work = (async () => {
    const started = await followRun(tabId, SENSITIVITY_METHOD, async (onMessage: (m: RunMessage) => void) => {
      let begun: { started: boolean; sentence: string | null; sweepId?: string | null };
      try {
        begun = await api.quietBegin(tabId, title, SENSITIVITY_METHOD);
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
      let count = total;
      let problem: string | null = null;
      const progress = () => onMessage({ kind: "progress", fraction: Math.min(1, ran / Math.max(1, count)), elapsedSeconds: elapsed(), text: w.progress(Math.min(count, ran + 1), count, clock(elapsed())) });
      const s: Session = {
        lastProblem: () => problem,
        status: (text, severity) => onMessage({ kind: "status", text, severity }),
        setTotal: (n) => {
          count = n;
          progress();
        },
        solve: async (doc) => {
          problem = null;
          if (doc.infiniteBuffers) {
            // An overloaded network is not sent to a solver.
            const probe = await api.quietProbe(doc).catch(() => null);
            if (probe && !probe.error && !probe.stable) {
              problem = w.rowUnstable;
              return null;
            }
          }
          let outcome: QuietOutcome;
          try {
            outcome = await api.quietRun({ tabId, title, document: doc, method: method.label, settings, sweepId });
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
          // `doc` is the network this run solved: a mean delay divides by its own arrival rate.
          const value = readMeasure(asResult(outcome.record), measure, doc);
          if (value === null) problem = w.noMeasure(method.name, measure.label);
          return value;
        },
      };
      onMessage({ kind: "status", text: startLine, severity: "info" });
      progress();
      void body(s)
        .then(
          (r) => r,
          (e) => {
            onMessage({ kind: "status", text: w.couldNotStart(String(e)), severity: "error" });
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
  try {
    return await work;
  } finally {
    running = null;
  }
}

/**
 * Estimates the sensitivities of the tab's network for `measureKey` by differences over quiet
 * runs of `method`, and saves the estimate as the tab's (also when Stop cut it short). Null when
 * it could not start or the network as it is could not be solved.
 */
export function runDifferences(tabId: string, measureKey: string | null, method: MethodChoice): Promise<SensitivityResult | null> {
  const tab = tabById(tabId);
  if (!tab) return Promise.resolve(null);
  const doc = tab.document;
  const measure = pickMeasure(measureOptions(doc), measureKey);
  if (!measure) return Promise.resolve(null);
  const { parameters, leftOut } = chosenParameters(doc);
  const total = runCount(parameters);
  return session<SensitivityResult | null>(tabId, method, measure, total, w.started(method.name, parameters.length, total), async (s) => {
    const base = await s.solve(doc);
    if (base === "stopped") return { value: null, ok: false, stopped: true };
    if (base === null) {
      s.status(s.lastProblem() === w.noMeasure(method.name, measure.label) ? s.lastProblem()! : w.baseFailed(method.name, s.lastProblem() ?? ""), "error");
      return { value: null, ok: false, stopped: false };
    }
    const rows: SensitivityRow[] = [];
    let stopped = false;
    const at = async (p: SweepParameter, x: number) => {
      const moved = substitute(doc, p, x);
      return moved ? s.solve(moved) : null;
    };
    for (const p of parameters) {
      const blank: SensitivityRow = { parameter: p, derivative: null, elasticity: null, oneMore: null, inversion: null, note: null };
      if (p.integer) {
        const more = await at(p, p.current + 1);
        if (more === "stopped") {
          stopped = true;
          break;
        }
        rows.push(more === null ? { ...blank, note: s.lastProblem() ?? w.rowFailed } : { ...blank, oneMore: more });
        continue;
      }
      const plan = stepPlan(p);
      if (!plan) {
        rows.push({ ...blank, note: w.rowFailed });
        continue;
      }
      const low = plan.low === p.current ? base : await at(p, plan.low);
      if (low === "stopped") {
        stopped = true;
        break;
      }
      const high = low === null ? null : plan.high === p.current ? base : await at(p, plan.high);
      if (high === "stopped") {
        stopped = true;
        break;
      }
      if (low === null || high === null) {
        rows.push({ ...blank, note: s.lastProblem() ?? w.rowFailed });
        continue;
      }
      const derivative = difference(plan, low, high);
      rows.push({ ...blank, derivative, elasticity: elasticityOf(derivative, p.current, base), oneSided: plan.oneSided || undefined });
    }
    const probe = await api.quietProbe(doc).catch(() => null);
    const stations = (probe?.loads ?? []).map((l) => ({ id: doc.nodes.find((n) => n.kind === "station" && n.name === l.station)?.id ?? l.station, name: l.station, utilisation: l.utilisation }));
    const result: SensitivityResult = {
      route: "difference",
      tier: method.tier,
      method: { label: method.label, name: method.name },
      measureKey: measure.key,
      value: base,
      target: null,
      targetChange: null,
      stations,
      bottlenecks: bottlenecks({ stations }).map((x) => x.id),
      rows,
      leftOut,
      stopped: stopped || undefined,
      fingerprint: await fingerprintNow(doc).catch(() => null),
      network: { nodes: doc.nodes, links: doc.links, infiniteBuffers: doc.infiniteBuffers },
    };
    setSensitivityEstimate(tabId, result);
    s.status(w.doneLine(rows.filter((r) => r.note === null).length, parameters.length), stopped ? "warning" : "success");
    return { value: result, ok: rows.length > 0, stopped };
  });
}

/**
 * "What would it take" for the tab's estimate: searches the `MAX_OPTIONS` most influential
 * continuous parameters (and the server counts, one step each) for the value that moves the
 * measure by `targetChange`, at most `FIND_EVALUATIONS` runs each, and saves the answers on the
 * estimate. The network solved is the one the estimate was made for.
 */
export function runOptions(tabId: string, targetChange: number, method: MethodChoice): Promise<SensitivityResult | null> {
  const estimate = sensitivityEstimate(tabId);
  const tab = tabById(tabId);
  if (!estimate || !tab || !estimate.network) return Promise.resolve(null);
  const doc: BnetDocument = { ...tab.document, ...estimate.network };
  const measure = pickMeasure(measureOptions(doc), estimate.measureKey);
  if (!measure) return Promise.resolve(null);
  const target = estimate.value * (1 + targetChange);
  const searched = ranked(estimate.rows).filter((r) => r.parameter.kind !== "load").slice(0, MAX_OPTIONS);
  const total = searched.length * FIND_EVALUATIONS;
  return session<SensitivityResult | null>(tabId, method, measure, total, w.started(method.name, searched.length, total), async (s) => {
    const answers = new Map<string, SensitivityRow["inversion"]>();
    let stopped = false;
    let left = total;
    for (const row of searched) {
      const p = row.parameter;
      let used = 0;
      const answer = await findValue(
        { current: p.current, value: estimate.value, derivative: row.derivative ?? 0, target, allowed: (x) => allowed(p, x), min: p.kind === "routing" ? p.min : null, max: p.max },
        async (x) => {
          used++;
          const moved = substitute(doc, p, x);
          return moved ? s.solve(moved) : null;
        },
      );
      left -= FIND_EVALUATIONS - used;
      s.setTotal(left);
      if (answer === "stopped") {
        stopped = true;
        break;
      }
      answers.set(p.id, answer);
    }
    const result: SensitivityResult = { ...estimate, target, targetChange, rows: estimate.rows.map((r) => ({ ...r, inversion: answers.get(r.parameter.id) ?? null })) };
    if (answers.size) setSensitivityEstimate(tabId, result);
    return { value: answers.size ? result : null, ok: answers.size > 0, stopped };
  });
}

/** For tests. */
export function resetSensitivityRunner() {
  running = null;
}
