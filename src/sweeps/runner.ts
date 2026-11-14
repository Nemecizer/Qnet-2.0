// Running a what-if sweep (new in 2.1, ROADMAP B4): for each point a copy of the tab's document
// with the parameter set, run quietly by each chosen method (src-tauri/src/quiet_runs.rs — no
// record is filed, nothing reaches the Shell pane), and every measurement kept.
//
// To the rest of the app a sweep is one run: `quiet_begin` claims the single run slot for its
// whole length, `followRun` (src/runs/state.ts) shows it in the status bar's run segment with its
// progress, and Run ▸ Stop cancels it — the point in flight is interrupted and the points that
// finished are kept and shown.
//
// What is not an error: an overloaded point (an infinite-buffer network with a station at
// utilisation ≥ 1) is left out as a gap, without starting a method for it; a method that refuses
// the network is left out of the rest of the sweep after its first refusal; a point that fails is
// a gap with the solver's sentence.
import { api } from "../lib/api";
import { allSettings } from "../lib/kv";
import type { BnetDocument } from "../lib/bnet";
import type { QuietOutcome, QuietProbe, RunMessage, RunRecord } from "../lib/types";
import { asResult } from "../panes/results/model";
import { adviceFor } from "../panes/results/agreement/chooser";
import { candidates, type Candidate } from "../panes/results/agreement/plan";
import { fingerprintNow } from "../panes/results/fingerprint";
import { interval, tierOf, type Tier } from "../results/insight";
import { followRun } from "../runs/state";
import { reveal } from "../workspace/panes/commands";
import { tabById, type Tab } from "../workspace/store";
import { parameterById, substitute, sweepValues, tidy, valueText, type SweepParameter } from "./model";
import { setSweepResult, showSweepView, type SweepCell, type SweepMeasurement, type SweepMethod, type SweepResult } from "./store";
import { MEASURED_SECONDS } from "./pointSeconds";
import { list, sweepWords as w } from "./words";

/** The run label the sweep shows under ("What-If Sweep"; src-tauri/src/quiet_runs.rs `SWEEP_LABEL`). */
export const SWEEP_METHOD = "what-if_sweep";

// ── The methods a sweep offers ──────────────────────────────────────────────────────────────────

/**
 * The methods quick enough to sweep (the experimental ones, whose cost has no useful bound, are
 * not offered). How long a point takes each is not guessed: it is the median of the recorded runs
 * (`MEASURED_SECONDS`, made from golden/runs by ./measure-point-seconds.mjs and checked against the
 * corpus by a test), used only for the panel's "about 3 seconds".
 */
export const SWEEPABLE = ["qna", "rqna", "product_form", "qbd", "fb_decomp", "sbd", "generic_ctmc", "truncated_ctmc", "inf_sm", "sm", "fm", "lp", "flp", "regenerative_mc", "inf_sim", "sim", "mlmc"] as const;

/** For a sweepable method with no recorded run (none completed in the corpus): the median of the others' medians. */
export const UNMEASURED_SECONDS = (() => {
  const known = SWEEPABLE.map((l) => MEASURED_SECONDS[l]?.seconds).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  const mid = known.length >> 1;
  return known.length % 2 ? known[mid] : (known[mid - 1] + known[mid]) / 2;
})();

/** Seconds a point takes each sweepable method, roughly: its measured median, else `UNMEASURED_SECONDS`. */
export const POINT_SECONDS: Record<string, number> = Object.fromEntries(SWEEPABLE.map((l) => [l, MEASURED_SECONDS[l]?.seconds ?? UNMEASURED_SECONDS]));
// New in 2.1: Exact Closed Product Form is computed inside Qnet, with no solver process to start
// (runner/src/methods/closed.rs); a point is a few milliseconds. Not in `SWEEPABLE`, which is the
// list of 0.90.34's methods timed from the recorded corpus.
POINT_SECONDS.closed_pf = 0.01;
// New in 2.1: Replicated Simulation, also inside Qnet. At its defaults (20 replications of
// 200,000 completions) a point is about a second on the bundled closed example.
POINT_SECONDS.sim_inproc = 1;
// New in 2.1: the exact single-station formulas of priorities and batch arrivals, inside Qnet.
POINT_SECONDS.priority_exact = 0.01;
POINT_SECONDS.batch_exact = 0.01;

export interface MethodChoice {
  /** 0.90.34's run label. */
  label: string;
  name: string;
  tier: Tier;
  /** Seconds a point takes, roughly: the median of the method's recorded runs. */
  seconds: number;
  /** False when no recorded run stands behind `seconds`. */
  measured?: boolean;
  /** A simulation: every point is simulated afresh, and its time is its run length's (a setting), not the recorded median. */
  slow: boolean;
  /** Ticked when the panel opens. */
  preferred: boolean;
}

/** The tier each method's record declares (core/src/results/model.rs `MethodMetadata::catalogue`), so the panel's mark is the chart's. */
const TIER: Record<string, Tier> = {
  product_form: "exact", closed_pf: "exact", priority_exact: "exact", batch_exact: "exact", qbd: "exact", generic_ctmc: "exact", inf_sim: "simulation", sim: "simulation", regenerative_mc: "simulation", sim_inproc: "simulation",
  qna: "approximation", rqna: "approximation", sbd: "approximation", fb_decomp: "approximation", truncated_ctmc: "approximation",
  inf_sm: "diffusion", sm: "diffusion", fm: "diffusion", lp: "diffusion", flp: "diffusion", mlmc: "diffusion",
};

const tierOfCandidate = (c: Candidate): Tier => TIER[c.label] ?? (c.kind === "exact" ? "exact" : c.kind === "simulation" ? "simulation" : c.advice.layer === "queueApproximation" ? "approximation" : "diffusion");

/** The Method Chooser's applicable methods that are quick enough to sweep, in its order, with the best exact one and the best approximation ticked. */
export function offeredMethods(cands: readonly Candidate[]): MethodChoice[] {
  const seen = new Set<string>();
  const offered = cands.filter((c) => POINT_SECONDS[c.label] !== undefined && c.advice.suitability !== "experimental" && !seen.has(c.label) && !!seen.add(c.label));
  const exact = offered.find((c) => c.kind === "exact");
  const approximation = offered.find((c) => c.kind === "approximation");
  const preferred = new Set([exact?.label, approximation?.label].filter(Boolean));
  if (!preferred.size && offered[0]) preferred.add(offered[0].label);
  return offered.map((c) => {
    const tier = tierOfCandidate(c);
    return { label: c.label, name: c.advice.name, tier, seconds: POINT_SECONDS[c.label], measured: MEASURED_SECONDS[c.label] !== undefined, slow: c.kind === "simulation" || c.label === "mlmc", preferred: preferred.has(c.label) };
  });
}

/** The methods a sweep of `tab` may use; empty for an empty canvas or when the Chooser can't answer. */
export async function methodsFor(tab: Pick<Tab, "id" | "document">): Promise<MethodChoice[]> {
  const advice = await adviceFor(tab);
  return advice ? offeredMethods(candidates(advice.rows, advice.infinite)) : [];
}

/** About how long a sweep takes: every point by every method (an estimate; the caller leaves simulations out and names them). */
export const estimateSeconds = (points: number, methods: readonly Pick<MethodChoice, "seconds">[]) => points * methods.reduce((s, m) => s + m.seconds, 0);

// ── A range that stays stable ───────────────────────────────────────────────────────────────────

/** The utilisation a default range stops at: close enough to 1 to show the curve turning up, far enough to compute. */
export const TARGET_UTILISATION = 0.95;

const worst = (p: QuietProbe) => p.loads.reduce((m, l) => Math.max(m, l.utilisation), 0);

/** Three significant digits, rounded towards `towards` so the value stays on the safe side. */
function roundTowards(x: number, towards: number): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const scale = Math.pow(10, 2 - Math.floor(Math.log10(Math.abs(x))));
  return tidy((x > towards ? Math.floor(x * scale) : Math.ceil(x * scale)) / scale);
}

export interface DefaultRange {
  from: number;
  to: number;
  /** Where the network becomes overloaded just outside the range, when it does. */
  edge: { x: number; unstable: "above" | "below" } | null;
}

/**
 * A range round the parameter's current value: half to one and a half times it (0 to the row's sum
 * for a probability, a few steps either way for a count), drawn in where an infinite-buffer
 * network would pass utilisation `TARGET_UTILISATION` — found by asking `probe` for a few
 * candidate values. A network that can't be probed gets the plain range.
 */
export async function defaultRange(doc: BnetDocument, p: SweepParameter, probe: (d: BnetDocument) => Promise<QuietProbe> = api.quietProbe): Promise<DefaultRange> {
  const v = p.current;
  let from: number;
  let to: number;
  if (p.kind === "routing") [from, to] = [0, p.max ?? 1];
  else if (p.kind === "servers") [from, to] = [Math.max(1, v - 2), v + 3];
  else if (p.kind === "buffer") [from, to] = [1, Math.max(10, 2 * v)];
  // From one customer (no queueing at all) to well past the knee, where the bottleneck saturates.
  else if (p.kind === "population") return { from: 1, to: Math.min(p.max ?? Infinity, Math.max(10, 2 * v)), edge: null };
  else [from, to] = [tidy(0.5 * v), tidy(1.5 * v)];
  if (!doc.infiniteBuffers) return { from, to, edge: null };

  const load = async (x: number): Promise<number | null> => {
    const d = substitute(doc, p, x);
    if (!d) return null;
    try {
      const r = await probe(d);
      return r.error ? null : worst(r);
    } catch {
      return null;
    }
  };
  const here = await load(v);
  if (here === null) return { from, to, edge: null };
  // Already beyond the target: only stay clear of 1 itself.
  const target = here < TARGET_UTILISATION ? TARGET_UTILISATION : here < 1 ? (1 + here) / 2 : Number.POSITIVE_INFINITY;
  let edge: DefaultRange["edge"] = null;

  /** The value between `good` (within the target) and `bad` (beyond it) where the target is met, and where utilisation reaches 1. */
  const drawIn = async (good: number, bad: number): Promise<{ end: number; one: number | null }> => {
    let [g, b] = [good, bad];
    let [g1, b1] = [good, bad];
    const badLoad = await load(bad);
    const overloaded = badLoad === null || badLoad >= 1;
    if (p.integer) {
      let end = good;
      let one: number | null = null;
      const step = bad > good ? 1 : -1;
      for (let x = good + step; step > 0 ? x <= bad : x >= bad; x += step) {
        const rho = await load(x);
        if (rho !== null && rho <= target) end = x;
        else if (rho === null || rho >= 1) {
          one ??= x - step / 2;
          break;
        } else end = x; // Past the target but still stable: a count can't be drawn in any finer.
      }
      return { end, one };
    }
    for (let i = 0; i < 16; i++) {
      const mid = (g + b) / 2;
      const rho = await load(mid);
      if (rho !== null && rho <= target) g = mid;
      else b = mid;
      if (overloaded) {
        const mid1 = (g1 + b1) / 2;
        const rho1 = mid1 === mid ? rho : await load(mid1);
        if (rho1 !== null && rho1 < 1) g1 = mid1;
        else b1 = mid1;
      }
    }
    return { end: roundTowards(g, good), one: overloaded ? tidy((g1 + b1) / 2) : null };
  };

  const high = await load(to);
  if (high === null || high > target) {
    const r = await drawIn(v, to);
    to = r.end;
    if (r.one !== null) edge = { x: r.one, unstable: "above" };
  }
  const low = await load(from);
  if (low === null || low > target) {
    const r = await drawIn(v, from);
    from = r.end;
    if (r.one !== null) edge = { x: r.one, unstable: "below" };
  }
  // A range drawn in to nothing (the network sits on its limit): keep the plain one.
  if (from === to) return { from: p.integer ? Math.max(p.min, v - 2) : tidy(0.5 * v), to: p.integer ? v + 3 : tidy(1.5 * v), edge };
  return { from, to, edge };
}

// ── Running ─────────────────────────────────────────────────────────────────────────────────────

export interface SweepSpec {
  parameterId: string;
  from: number;
  to: number;
  points: number;
  methods: Pick<MethodChoice, "label" | "name" | "tier">[];
  /** What the chart opens on. */
  metric: string;
  stationId: string | null;
}

/** Names a method may use for the same quantity: the exact and regenerative methods say "Server utilization". */
const METRIC_ALIASES: Record<string, string> = { "Server utilization": "Utilization" };

/** A record's measurements, as the sweep keeps them. */
export function compact(record: RunRecord): SweepMeasurement[] {
  const out: SweepMeasurement[] = [];
  for (const m of asResult(record).measurements) {
    if (!Number.isFinite(m.estimate)) continue;
    const ci = interval(m);
    const item: SweepMeasurement = { s: m.stationID ?? null, n: m.stationName, c: typeof m.customerClass === "number" ? m.customerClass : null, k: METRIC_ALIASES[m.metric] ?? m.metric, u: m.unit, v: m.estimate };
    if (ci && Number.isFinite(ci.low) && Number.isFinite(ci.high)) {
      item.lo = ci.low;
      item.hi = ci.high;
    }
    out.push(item);
  }
  return out;
}

const seconds = (s: number) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`);

/** Where utilisation reaches 1 between a stable value and an overloaded one. */
async function locateLimit(doc: BnetDocument, p: SweepParameter, stable: number, unstable: number): Promise<number> {
  if (p.integer) return (stable + unstable) / 2;
  let [g, b] = [stable, unstable];
  for (let i = 0; i < 14; i++) {
    const mid = (g + b) / 2;
    const d = substitute(doc, p, mid);
    let ok = false;
    try {
      ok = !!d && (await api.quietProbe(d)).stable;
    } catch {
      break;
    }
    if (ok) g = mid;
    else b = mid;
  }
  return tidy((g + b) / 2);
}

let running: Promise<SweepResult | null> | null = null;

/** Whether a sweep is being run from this page. */
export const sweepRunning = () => running !== null;

/**
 * Runs the sweep for tab `tabId` and saves its result as the tab's sweep (also when Stop cut it
 * short, with the points that finished). Resolves to the result, or null when it couldn't start
 * or nothing finished.
 */
export function runSweep(tabId: string, spec: SweepSpec): Promise<SweepResult | null> {
  if (running) return Promise.resolve(null);
  const p = sweep(tabId, spec).finally(() => {
    running = null;
  });
  running = p;
  return p;
}

async function sweep(tabId: string, spec: SweepSpec): Promise<SweepResult | null> {
  const tab = tabById(tabId);
  if (!tab) return null;
  // The network as it is now: the sweep runs on this copy whatever is edited meanwhile.
  const doc = tab.document;
  const found = parameterById(doc, spec.parameterId);
  if (!found || !spec.methods.length) return null;
  const parameter: SweepParameter = found;
  const values = sweepValues(parameter, spec.from, spec.to, spec.points);
  if (values.length < 2) return null;
  const settings = allSettings();
  const title = tab.title;
  const total = values.length * spec.methods.length;

  let finish: (r: SweepResult | null) => void = () => {};
  const done = new Promise<SweepResult | null>((resolve) => (finish = resolve));

  const started = await followRun(tabId, SWEEP_METHOD, async (onMessage) => {
    let begun: { started: boolean; sentence: string | null; sweepId?: string | null };
    try {
      begun = await api.quietBegin(tabId, title);
    } catch (e) {
      begun = { started: false, sentence: String(e) };
    }
    if (!begun.started) {
      onMessage({ kind: "status", text: begun.sentence ?? w.couldNotStart(w.busy), severity: "warning" });
      return { started: false };
    }
    onMessage({ kind: "status", text: w.started(parameter.label, valueText(values[0]), valueText(values[values.length - 1]), values.length, list(spec.methods.map((m) => m.name))), severity: "info" });
    // The loop runs on after the launch has been accepted, as a run's thread does. Whatever
    // happens in it, the slot is given back when it ends (not left to the idle limit).
    const sweepId = begun.sweepId ?? null;
    void loop(onMessage, sweepId)
      .finally(() => api.quietEnd(sweepId).catch(() => {}))
      .then(finish, (e) => {
        const summary = w.failed(seconds(0));
        onMessage({ kind: "status", text: w.couldNotStart(String(e)), severity: "error" });
        onMessage({ kind: "finished", summary, statusBar: summary, exitCode: 1, userStopped: false, succeeded: false, recordId: null, filed: null, filedReason: null });
        finish(null);
      });
    return { started: true };
  });
  if (!started) return null;
  return done;

  async function loop(onMessage: (m: RunMessage) => void, sweepId: string | null): Promise<SweepResult | null> {
    const t0 = Date.now();
    const elapsed = () => (Date.now() - t0) / 1000;
    const methods: SweepMethod[] = spec.methods.map((m) => ({ label: m.label, name: m.name, shortName: m.name, tier: m.tier }));
    const cells: SweepCell[][] = methods.map(() => []);
    const refusedBy: (string | null)[] = methods.map(() => null);
    const stability: (boolean | null)[] = [];
    let ran = 0;
    let ok = 0;
    let stopped = false;
    let crashed: string | null = null;
    const progress = () => onMessage({ kind: "progress", fraction: ran / total, elapsedSeconds: elapsed(), text: w.progress(Math.min(values.length, Math.floor(ran / methods.length) + 1), values.length, seconds(elapsed())) });
    progress();

    try {
      points: for (const [i, x] of values.entries()) {
        const at = substitute(doc, parameter, x);
        let unstable: string | null = null;
        if (at && doc.infiniteBuffers) {
          try {
            const probe = await api.quietProbe(at);
            stability[i] = probe.error ? null : probe.stable;
            const top = probe.loads.reduce<QuietProbe["loads"][number] | null>((m, l) => (!m || l.utilisation > m.utilisation ? l : m), null);
            if (!probe.stable && top) unstable = unstableSentence(top.station, top.utilisation);
          } catch {
            stability[i] = null;
          }
        } else stability[i] = at ? true : null;
        for (const [j, method] of methods.entries()) {
          let cell: SweepCell;
          if (!at) cell = { ok: false, reason: "failed", sentence: w.problems.aboveMax(valueText(parameter.max ?? x)) };
          else if (unstable) cell = { ok: false, reason: "unstable", sentence: unstable };
          else if (refusedBy[j] !== null) cell = { ok: false, reason: "skipped", sentence: refusedBy[j]! };
          else {
            let outcome: QuietOutcome;
            try {
              // Named as this sweep's: once Stop has ended the sweep the answer is `stopped`,
              // never a run of its own in a slot someone else may hold by then.
              outcome = await api.quietRun({ tabId, title, document: at, method: method.label, settings, sweepId });
            } catch (e) {
              outcome = { kind: "failed", sentence: String(e) };
            }
            if (outcome.kind === "stopped") {
              stopped = true;
              break points;
            }
            if (outcome.kind === "record") {
              const record = asResult(outcome.record);
              method.shortName = record.method.shortName || method.shortName;
              method.name = record.method.displayName || method.name;
              method.tier = tierOf(record);
              cell = { ok: true, m: compact(outcome.record) };
              ok++;
            } else if (outcome.kind === "unstable") {
              stability[i] = false;
              cell = { ok: false, reason: "unstable", sentence: outcome.sentence };
            } else if (outcome.kind === "refused") {
              // A method that has given nothing yet and refuses is refusing the network, not the point.
              if (!cells[j].some((c) => c.ok)) {
                refusedBy[j] = outcome.sentence;
                onMessage({ kind: "status", text: w.methodRefused(method.name, outcome.sentence), severity: "warning" });
              }
              cell = { ok: false, reason: "refused", sentence: outcome.sentence };
            } else cell = { ok: false, reason: "failed", sentence: outcome.sentence };
          }
          cells[j][i] = cell;
          ran++;
          progress();
        }
      }
    } catch (e) {
      crashed = String(e);
    }
    // The points Stop (or a failure) never reached.
    for (const row of cells) for (let i = 0; i < values.length; i++) row[i] ??= { ok: false, reason: "stopped", sentence: w.notRun };

    // Where the network tips over, between a stable point and an overloaded one beside it.
    const limits: SweepResult["limits"] = [];
    if (!stopped && !crashed) {
      for (let i = 0; i + 1 < values.length; i++) {
        const [a, b] = [stability[i], stability[i + 1]];
        if (a === null || b === null || a === undefined || b === undefined || a === b) continue;
        const [stableX, unstableX] = a ? [values[i], values[i + 1]] : [values[i + 1], values[i]];
        limits.push({ x: await locateLimit(doc, parameter, stableX, unstableX), unstable: unstableX > stableX ? "above" : "below" });
      }
    }
    await api.quietEnd(sweepId).catch(() => {});

    const time = seconds(elapsed());
    const all: SweepResult = {
      id: crypto.randomUUID().toUpperCase(),
      tabId,
      title,
      createdAt: new Date().toISOString(),
      parameter,
      from: values[0],
      to: values[values.length - 1],
      values,
      methods,
      cells,
      limits,
      stopped,
      elapsedSeconds: elapsed(),
      fingerprint: ok ? await fingerprintNow(doc) : null,
      network: { nodes: doc.nodes, links: doc.links, infiniteBuffers: doc.infiniteBuffers },
      metric: spec.metric,
      stationId: spec.stationId,
    };
    const result = ok ? all : null;
    // A sweep with nothing to draw still says why, in the view's table; one stopped before its
    // first result leaves the sweep before it in place.
    const shown = ok || !stopped ? all : null;
    if (shown) {
      setSweepResult(tabId, shown);
      showSweepView();
      void reveal("results", () => {}).catch(() => {});
    }
    const gaps = values.filter((_x, i) => cells.some((row) => !row[i].ok)).length;
    if (crashed) onMessage({ kind: "status", text: w.couldNotStart(crashed), severity: "error" });
    else if (stopped) onMessage({ kind: "status", text: ok ? w.cancelledLine(ran, total) : w.cancelledNothing, severity: "warning" });
    else onMessage({ kind: "status", text: ok ? w.doneLine(ok, total, gaps) : w.nothingLine, severity: ok ? "success" : "warning" });
    const summary = stopped ? w.cancelled(time) : ok && !crashed ? w.finished(time) : w.failed(time);
    onMessage({ kind: "finished", summary, statusBar: summary, exitCode: stopped ? 130 : ok && !crashed ? 0 : 1, userStopped: stopped, succeeded: !stopped && ok > 0 && !crashed, recordId: null, filed: null, filedReason: null });
    return result;
  }
}

const unstableSentence = (station: string, utilisation: number) => `${station} would be overloaded (utilisation ${utilisation.toFixed(3)}), so the network has no steady state.`;

/** Ends a sweep a previous page left holding the run slot (a reload mid-sweep); a no-op otherwise. */
export function endAbandonedSweep(): Promise<void> {
  if (running) return Promise.resolve();
  return api.quietEnd(null).then(
    () => {},
    () => {},
  );
}

/** For tests. */
export function resetSweepRunner() {
  running = null;
}
