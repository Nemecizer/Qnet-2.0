// Capacity planning (new in 2.1, ROADMAP D5): the problem as the student states it (targets,
// costs, what may change), the plan as Rust answers it, how a plan is read in a sentence and drawn
// as a trade-off curve — and, for a network with no closed formula, the greedy search over
// evaluations that the runner feeds with quiet solver runs. Pure functions; the allocation of a
// Jackson network is Rust's (core/src/optimise.rs: marginal allocation, the exact search, the
// square-root rule), never recomputed here.
import type { LineChartProps, LineRule, LineSeries } from "../charts";
import { TIER_STYLE } from "../charts";
import { inExportOrder } from "../editor/naming";
import { formatSig } from "../editor/numbers";
import type { BnetDocument } from "../lib/bnet";
import { parseNumber } from "../panes/inspector/distributions/numbers";
import type { ResultRecord } from "../panes/results/model";
import { stationValues, type Tier } from "../results/insight";
import { measureOptions, readMeasure } from "../sensitivity/model";
import { capacityWords as w, type Decision, type TargetKind } from "./words";

export const TARGET_KINDS: TargetKind[] = ["networkSojourn", "networkNumber", "utilisation", "stationWait"];

// ── What Rust answers (src-tauri/src/optimise.rs) ───────────────────────────────────────────────

export interface CapacityConstraintRequest {
  kind: TargetKind;
  stationId: string | null;
  target: number;
}
export interface CapacityStationRequest {
  id: string;
  free: boolean;
  cost: number;
  rateCost: number;
  lower: number | null;
  upper: number | null;
}
export interface CapacityRequest {
  document: unknown;
  decision: Decision;
  constraints: CapacityConstraintRequest[];
  stations: CapacityStationRequest[];
}

export interface CapacityStation {
  id: string;
  name: string;
  free: boolean;
  /** Offered load: the mean number of busy servers. */
  load: number;
  serversNow: number;
  servers: number;
  rateNow: number;
  rate: number;
  unitCost: number;
  costNow: number;
  cost: number;
  /** Null where the station is overloaded as drawn. */
  utilisationNow: number | null;
  utilisation: number;
}
export interface CapacityConstraint {
  kind: TargetKind;
  stationId: string | null;
  target: number;
  unit: string;
  now: number | null;
  proposed: number | null;
}
export interface CapacityPoint {
  cost: number;
  number: number | null;
  delay: number | null;
  added: string | null;
  feasible: boolean;
}
export type InfeasibleWhy = "badTarget" | "badStation" | "fixedOverloaded" | "limitOverloaded" | "stationLimit" | "floor" | "serviceFloor" | "tooMany" | "ratesTarget" | "severalServers" | "nothingFree" | "fixedTooFull";
export interface CapacityInfeasible {
  why: InfeasibleWhy;
  constraint: number | null;
  stationId: string | null;
  value: number | null;
}
export type Proof = "marginal" | "search" | "closedForm" | "none";

export interface CapacityPlan {
  available: boolean;
  reason: "network" | "noTraffic" | "notJackson" | "closed" | "closedNoPopulation" | null;
  sentence: string | null;
  decision: Decision;
  infeasible: CapacityInfeasible | null;
  stations: CapacityStation[];
  constraints: CapacityConstraint[];
  costNow: number;
  cost: number | null;
  proof: Proof | null;
  searched: boolean;
  searchNodes: number;
  searchLimit: number;
  improved: boolean;
  path: CapacityPoint[];
  delayNow: number | null;
  delay: number | null;
  numberNow: number | null;
  number: number | null;
  delayFloor: number | null;
  totalArrivals: number | null;
}

export const unavailable = (reason: CapacityPlan["reason"], sentence: string): CapacityPlan => ({
  available: false, reason, sentence, decision: "servers", infeasible: null, stations: [], constraints: [], costNow: 0, cost: null, proof: null,
  searched: false, searchNodes: 0, searchLimit: 0, improved: false, path: [], delayNow: null, delay: null, numberNow: null, number: null, delayFloor: null, totalArrivals: null,
});

// ── The form ────────────────────────────────────────────────────────────────────────────────────

export interface StationForm {
  free: boolean;
  cost: string;
  rateCost: string;
  lower: string;
  upper: string;
}
export interface CapacityForm {
  decision: Decision;
  targets: Record<TargetKind, { on: boolean; text: string }>;
  /** The station of the wait target; null: the first one. */
  waitStationId: string | null;
  stations: Record<string, StationForm>;
  /** False until the student changes something: the view may then suggest a first target. */
  touched: boolean;
}

export const DEFAULT_STATION: StationForm = { free: true, cost: "1", rateCost: "1", lower: "1", upper: "" };
export const DEFAULT_FORM: CapacityForm = {
  decision: "servers",
  targets: { networkSojourn: { on: false, text: "" }, networkNumber: { on: false, text: "" }, utilisation: { on: false, text: "" }, stationWait: { on: false, text: "" } },
  waitStationId: null,
  stations: {},
  touched: false,
};

/** The network's stations in export order (the order every table here uses). */
export function stationsOf(doc: BnetDocument): { id: string; name: string; servers: number }[] {
  return inExportOrder(doc.nodes.filter((n) => n.kind === "station"), (n) => n.name).map((n) => ({ id: n.id, name: n.name, servers: Math.max(1, n.numberOfServers ?? 1) }));
}

export interface FormReading {
  /** What to ask Rust: always there for a network with stations — with no targets it still answers the values now. */
  request: CapacityRequest;
  /** The first thing wrong with the form, or null when it states a whole problem. */
  problem: string | null;
}

/** The form as a request, and what is still wrong with it. A target that cannot be read is left out of the request. */
export function readForm(doc: BnetDocument, form: CapacityForm): FormReading {
  const stations = stationsOf(doc);
  let problem: string | null = null;
  const note = (p: string) => (problem ??= p);
  const constraints: CapacityConstraintRequest[] = [];
  for (const kind of TARGET_KINDS) {
    const t = form.targets[kind];
    if (!t.on) continue;
    // Rates are planned against the network's targets only.
    const x = parseNumber(t.text.replace(/\s*%$/, ""));
    if (kind === "utilisation") {
      if (x === null || !(x > 0) || x > 100) note(w.problems.badUtilisation);
      else constraints.push({ kind, stationId: null, target: x / 100 });
      continue;
    }
    if (x === null || !(x > 0)) {
      note(w.problems.badTarget(w.targets[kind].replace(/ at$/, "")));
      continue;
    }
    const stationId = kind === "stationWait" ? (stations.find((s) => s.id === form.waitStationId) ?? stations[0])?.id ?? null : null;
    constraints.push({ kind, stationId, target: x });
  }
  if (!TARGET_KINDS.some((k) => form.targets[k].on)) note(w.problems.noTarget);
  const rows: CapacityStationRequest[] = stations.map((s) => {
    const f = form.stations[s.id] ?? DEFAULT_STATION;
    const cost = parseNumber(form.decision === "rates" ? f.rateCost : f.cost);
    const lower = f.lower.trim() ? parseNumber(f.lower) : 1;
    const upper = f.upper.trim() ? parseNumber(f.upper) : null;
    const whole = (x: number | null) => x !== null && Number.isInteger(x) && x >= 1;
    if (f.free && (cost === null || !(cost > 0))) note(w.problems.badCost(s.name));
    const limitsOk = form.decision === "rates" || !f.free || (whole(lower) && (upper === null || (whole(upper) && upper >= lower!)));
    if (!limitsOk) note(w.problems.badLimit(s.name));
    const k = cost !== null && cost > 0 ? cost : 1;
    return { id: s.id, free: f.free, cost: form.decision === "rates" ? 1 : k, rateCost: form.decision === "rates" ? k : 1, lower: limitsOk && lower !== null ? lower : 1, upper: limitsOk ? upper : null };
  });
  return { request: { document: doc, decision: form.decision, constraints, stations: rows }, problem };
}

/** What identifies a stated problem (not the network): a plan made for one is not shown under another. */
export const problemKey = (r: CapacityRequest) => JSON.stringify([r.decision, r.constraints, r.stations]);

/**
 * A first delay target for an untouched form: a fifth off the delay now — or, if that is at or
 * under the floor, half-way from the floor to now. Three significant digits, rounded so that the
 * target still lies above the floor.
 */
export function suggestedDelay(delayNow: number, floor: number | null): string {
  let t = 0.8 * delayNow;
  if (floor !== null && t <= floor * 1.02) t = (floor + delayNow) / 2;
  return String(Number(t.toPrecision(3)));
}

// ── A result, whichever route made it ───────────────────────────────────────────────────────────

export type Ended = "met" | "outOfRuns" | "noProgress" | "limits" | "stopped";

export interface CapacityResult {
  /** "formula": exact, from Rust's closed forms. "runs": the greedy search over quiet runs. */
  route: "formula" | "runs";
  tier: Tier;
  method: { label: string; name: string } | null;
  plan: CapacityPlan;
  /** How the search over runs ended ("met" for the formula route). */
  ended: Ended;
  runs: number;
  /** `problemKey` of the request it answers. */
  key: string;
  fingerprint?: string | null;
  network?: Pick<BnetDocument, "nodes" | "links" | "infiniteBuffers">;
}

export const param = (x: number) => formatSig(x, 5);
/** A cost: whole numbers stay whole, anything else to five significant digits. */
export const costText = (x: number) => formatSig(x, 6);
export const unitText = (unit: string) => w.units[unit] ?? unit;

/** A constraint's value as shown: a utilisation as a percentage. */
export function constraintText(c: Pick<CapacityConstraint, "kind">, x: number, format: (x: number) => string): string {
  return c.kind === "utilisation" ? `${formatSig(x * 100, 4)} %` : format(x);
}

export const isMet = (c: CapacityConstraint, value: number | null) => value !== null && value <= c.target;

/** The stations a plan changes, largest change first. */
export function changes(plan: CapacityPlan): CapacityStation[] {
  const delta = (s: CapacityStation) => (plan.decision === "rates" ? Math.abs(s.rate - s.rateNow) / s.rateNow : Math.abs(s.servers - s.serversNow));
  return plan.stations.filter((s) => (plan.decision === "rates" ? Math.abs(s.rate - s.rateNow) > 1e-9 * s.rateNow : s.servers !== s.serversNow)).sort((a, b) => delta(b) - delta(a));
}

/** The plan in one sentence. Null when there is no plan. */
export function reading(plan: CapacityPlan, format: (x: number) => string): string | null {
  if (plan.cost === null || plan.infeasible) return null;
  const changed = changes(plan);
  const r = w.reading;
  const delay = plan.delay !== null ? r.delay(plan.delayNow !== null ? format(plan.delayNow) : null, format(plan.delay), w.units.time) : "";
  if (!changed.length) return r.same(costText(plan.cost));
  const parts = changed.map((s) =>
    plan.decision === "rates"
      ? s.rate > s.rateNow
        ? r.faster(s.name, param(s.rateNow), param(s.rate))
        : r.slower(s.name, param(s.rateNow), param(s.rate))
      : s.servers > s.serversNow
        ? r.more(s.name, s.servers - s.serversNow)
        : r.fewer(s.name, s.serversNow - s.servers),
  );
  const [now, then] = [costText(plan.costNow), costText(plan.cost)];
  const head = now === then ? r.move(parts, then) : plan.cost > plan.costNow ? r.add(parts, now, then) : r.save(parts, now, then);
  return `${head}${delay}`;
}

/** Why no plan meets the targets, in a sentence. */
export function infeasibleSentence(plan: CapacityPlan, format: (x: number) => string): string {
  const x = plan.infeasible;
  const i = w.infeasible;
  if (!x) return "";
  const station = plan.stations.find((s) => s.id === x.stationId)?.name ?? "A station";
  const c = x.constraint !== null ? plan.constraints[x.constraint] : null;
  const name = c ? w.constraintName(c.kind, plan.stations.find((s) => s.id === c.stationId)?.name ?? null) : "The target";
  const value = (v: number | null) => (v === null ? "—" : c ? `${constraintText(c, v, format)}${c.kind !== "utilisation" && unitText(c.unit) ? ` ${unitText(c.unit)}` : ""}` : format(v));
  switch (x.why) {
    case "badTarget": return i.badTarget;
    case "badStation": return i.badStation(station);
    case "fixedOverloaded": return i.fixedOverloaded(station);
    case "limitOverloaded": return i.limitOverloaded(station, x.value !== null ? String(x.value) : "more");
    case "stationLimit": return i.stationLimit(name, station, value(x.value));
    case "serviceFloor": return i.serviceFloor(name, value(x.value));
    case "floor": return i.floor(name, value(x.value));
    case "tooMany": return i.tooMany;
    case "ratesTarget": return i.ratesTarget;
    case "severalServers": return i.severalServers(station);
    case "nothingFree": return i.nothingFree;
    case "fixedTooFull": return i.fixedTooFull(value(x.value));
    default: return i.unknown;
  }
}

/** The proof line of a result. */
export function proofLine(result: CapacityResult): { text: string; help: string; proven: boolean } {
  const p = result.plan;
  const count = (n: number) => n.toLocaleString("en-US");
  if (result.route === "runs") return { text: w.proof.runs, help: w.experimentalHelp, proven: false };
  switch (p.proof) {
    case "marginal": return { text: w.proof.marginal, help: w.proofHelp.marginal, proven: true };
    case "search": return { text: p.improved ? w.proof.improved(count(p.searchNodes)) : w.proof.search(count(p.searchNodes)), help: w.proofHelp.search, proven: true };
    case "closedForm": return { text: w.proof.closedForm, help: w.proofHelp.closedForm, proven: true };
    default: return { text: w.proof.none(count(p.searchLimit)), help: w.proofHelp.none, proven: false };
  }
}

// ── The trade-off curve ─────────────────────────────────────────────────────────────────────────

export type CapacityChart = Omit<LineChartProps, "width" | "fontScale">;

/**
 * Cost against congestion along the path (the teaching picture: the curve falls steeply, then
 * flattens). The measure is the mean delay, or the mean number when that is the only network
 * target (or the only one the path carries). Null when the path has fewer than two points.
 */
export function capacityChart(result: CapacityResult, format: (x: number) => string): CapacityChart | null {
  const plan = result.plan;
  const has = (k: TargetKind) => plan.constraints.some((c) => c.kind === k);
  let measure: "delay" | "number" = has("networkNumber") && !has("networkSojourn") ? "number" : "delay";
  if (!plan.path.some((p) => p[measure] !== null)) measure = measure === "delay" ? "number" : "delay";
  const points = plan.path.filter((p) => p[measure] !== null && Number.isFinite(p[measure])).map((p) => ({ x: p.cost, y: p[measure] as number }));
  if (points.length < 2) return null;
  const color = TIER_STYLE[result.tier].color;
  const series: LineSeries[] = [{ key: "path", label: w.seriesPath, color, shape: TIER_STYLE[result.tier].shape, points }];
  const now = measure === "delay" ? plan.delayNow : plan.numberNow;
  const xs = points.map((p) => p.x);
  if (now !== null) xs.push(plan.costNow);
  const target = plan.constraints.find((c) => c.kind === (measure === "delay" ? "networkSojourn" : "networkNumber"))?.target ?? null;
  if (target !== null) series.push({ key: "target", label: w.seriesTarget, color: "--muted", shape: "cross", points: [{ x: Math.min(...xs), y: target }, { x: Math.max(...xs), y: target }] });
  if (now !== null) series.push({ key: "now", label: w.seriesNow, color: "--text-2", shape: "diamond", points: [{ x: plan.costNow, y: now }] });
  const rules: LineRule[] = plan.cost !== null ? [{ x: plan.cost, label: w.ruleProposed, tone: "current" }] : [];
  const unit = measure === "delay" ? w.units.time : w.units.customers;
  const name = w.chartMeasure[measure];
  return {
    series,
    rules,
    title: w.chartTitle(name),
    subtitle: result.route === "runs" ? w.chartSubtitleRuns(result.method?.name ?? "") : plan.decision === "rates" ? w.chartSubtitleRates : w.chartSubtitleServers,
    xLabel: w.chartX,
    yLabel: w.chartY[measure],
    unit,
    formatX: costText,
    formatY: format,
    caption: w.chartCaption(name, points.length, `${format(points[0].y)} ${unit}`, `${format(points[points.length - 1].y)} ${unit}`, plan.cost !== null ? costText(plan.cost) : null, points.length >= 3),
  };
}

// ── The search over evaluations (networks with no closed formula; the preview's stand-in) ──────

/** What one solve of an allocation gives: each target's value (null: not reported), and the network's means. */
export interface Evaluation {
  values: (number | null)[];
  delay: number | null;
  number: number | null;
}

export interface SearchStation {
  id: string;
  free: boolean;
  cost: number;
  /** The allocation the search starts from, and the most servers allowed. */
  start: number;
  upper: number | null;
}

export interface SearchStep {
  allocation: number[];
  evaluation: Evaluation;
  /** The station (index) that got the server that led here. */
  added: number | null;
  feasible: boolean;
}

export interface SearchOutcome {
  /** The points visited, the start first; empty when the start could not be solved. */
  path: SearchStep[];
  /** The index in `path` of the plan: the first point that meets every target, else the last. */
  chosen: number;
  ended: Ended;
  runs: number;
}

/** How far an evaluation is from the targets: Σ max(0, value/target − 1); ∞ where a value is missing. */
export function violation(e: Evaluation, targets: readonly number[]): number {
  let v = 0;
  for (const [k, t] of targets.entries()) {
    const x = e.values[k];
    if (x === null || !Number.isFinite(x)) return Infinity;
    v += Math.max(0, x / t - 1);
  }
  return v;
}

/** The most solver runs one search over runs may use. */
export const MAX_RUNS = 60;

/**
 * The greedy search Rust runs on closed forms (core/src/optimise.rs `greedy`), here over an
 * `evaluate` that solves one allocation at a time: from the start, try one more server at each
 * free station, keep the one that brings the targets closest per unit of cost — or, among those
 * that meet every target, the cheapest — and repeat until every target is met, nothing helps,
 * every station is at its limit, or `maxRuns` evaluations are spent. After the targets are met
 * the search goes on for `tail` more steps (by the fall of the mean number per unit of cost) so a
 * chart can show the curve flattening; the runner asks for none. `evaluate` answers null where
 * the allocation cannot be solved and "stopped" when Stop was pressed.
 */
export async function greedySearch(stations: readonly SearchStation[], targets: readonly number[], evaluate: (allocation: number[]) => Promise<Evaluation | null | "stopped">, maxRuns: number, tail = 0): Promise<SearchOutcome> {
  let runs = 0;
  const start = stations.map((s) => s.start);
  runs++;
  const first = await evaluate(start);
  if (first === "stopped") return { path: [], chosen: 0, ended: "stopped", runs };
  if (first === null) return { path: [], chosen: 0, ended: "noProgress", runs };
  const path: SearchStep[] = [{ allocation: start, evaluation: first, added: null, feasible: violation(first, targets) === 0 }];
  let chosen = path[0].feasible ? 0 : -1;
  let after = 0;
  const finish = (ended: Ended): SearchOutcome => ({ path, chosen: chosen < 0 ? path.length - 1 : chosen, ended: chosen >= 0 ? "met" : ended, runs });
  for (;;) {
    const base = path[path.length - 1];
    if (chosen >= 0 && after++ >= tail) return finish("met");
    const open = stations.map((_s, i) => i).filter((i) => stations[i].free && (stations[i].upper === null || base.allocation[i] < stations[i].upper!));
    if (!open.length) return finish("limits");
    if (runs + open.length > maxRuns) return finish("outOfRuns");
    const tried: { i: number; e: Evaluation; v: number }[] = [];
    for (const i of open) {
      const next = base.allocation.map((n, k) => (k === i ? n + 1 : n));
      runs++;
      const e = await evaluate(next);
      if (e === "stopped") return finish("stopped");
      if (e !== null) tried.push({ i, e, v: violation(e, targets) });
    }
    const v0 = violation(base.evaluation, targets);
    const fall = (t: (typeof tried)[number]) => ((base.evaluation.number ?? 0) - (t.e.number ?? 0)) / stations[t.i].cost;
    let best: (typeof tried)[number] | null = null;
    if (chosen >= 0) {
      for (const t of tried) if (t.v === 0 && fall(t) > 0 && (!best || fall(t) > fall(best))) best = t;
    } else {
      const reach = tried.filter((t) => t.v === 0);
      if (reach.length) {
        best = reach.reduce((a, b) => (stations[b.i].cost < stations[a.i].cost || (stations[b.i].cost === stations[a.i].cost && (b.e.number ?? 0) < (a.e.number ?? 0)) ? b : a));
      } else {
        const gain = (t: (typeof tried)[number]) => (v0 - t.v) / stations[t.i].cost;
        for (const t of tried) if (Number.isFinite(t.v) && gain(t) > 0 && (!best || gain(t) > gain(best))) best = t;
      }
    }
    if (!best) return finish("noProgress");
    const allocation = base.allocation.map((n, k) => (k === best!.i ? n + 1 : n));
    path.push({ allocation, evaluation: best.e, added: best.i, feasible: best.v === 0 });
    if (best.v === 0 && chosen < 0) chosen = path.length - 1;
  }
}

/** A station as the search over runs knows it: its offered load is exact (the traffic equations), whatever the method. */
export interface LoadedStation {
  id: string;
  name: string;
  /** Offered load a = ρ·c. */
  load: number;
  serversNow: number;
}

/** The fewest servers a station needs for a steady state (⌊a⌋ + 1) and for every-station utilisation ≤ `u` (⌈a/u⌉). */
export function fewestServers(load: number, utilisation: number | null): number {
  let n = Math.floor(load) + 1;
  if (utilisation !== null) {
    n = Math.max(n, Math.ceil(load / utilisation - 1e-12));
    while (load / n > utilisation) n++;
  }
  return n;
}

/**
 * What a record says about the targets at `allocation`. The utilisation is not read from the
 * record: it is a/c with the exact offered load. A station's mean wait before service is its mean
 * sojourn time less its mean service time a/X (X the record's throughput) — an identity, not a
 * model. The network's mean number and delay are the sensitivity view's readings.
 */
export function evaluationOf(record: ResultRecord, doc: BnetDocument, constraints: readonly CapacityConstraintRequest[], stations: readonly LoadedStation[], allocation: readonly number[]): Evaluation {
  const measures = measureOptions(doc);
  const read = (kind: "networkNumber" | "networkSojourn") => {
    const m = measures.find((x) => x.kind === kind);
    return m ? readMeasure(record, m, doc) : null;
  };
  const number = read("networkNumber");
  const delay = read("networkSojourn");
  const at = (metric: string, id: string) => stationValues(record, metric).find((x) => x.stationID.toUpperCase() === id.toUpperCase())?.value ?? null;
  const values = constraints.map((c) => {
    switch (c.kind) {
      case "networkNumber": return number;
      case "networkSojourn": return delay;
      case "utilisation": return Math.max(...stations.map((s, i) => s.load / allocation[i]));
      case "stationWait": {
        const i = stations.findIndex((s) => s.id === c.stationId);
        if (i < 0) return null;
        const [sojourn, throughput] = [at("Mean sojourn time", stations[i].id), at("Throughput", stations[i].id)];
        return sojourn !== null && throughput !== null && throughput > 0 ? Math.max(0, sojourn - stations[i].load / throughput) : null;
      }
    }
  });
  return { values, delay, number };
}

/** A search's outcome as a plan the view draws; `now` is the evaluation of the network as drawn (null: overloaded, or not solved). */
export function planFromSearch(request: CapacityRequest, stations: readonly LoadedStation[], search: readonly SearchStation[], outcome: SearchOutcome, now: Evaluation | null, unitOf: (kind: TargetKind) => string): CapacityPlan {
  const step = outcome.path[outcome.chosen];
  const cost = (a: readonly number[]) => a.reduce((s, n, i) => s + n * search[i].cost, 0);
  const nowAllocation = stations.map((s) => s.serversNow);
  return {
    ...unavailable(null, ""),
    available: true,
    sentence: null,
    decision: "servers",
    stations: stations.map((s, i) => ({
      id: s.id, name: s.name, free: search[i].free, load: s.load, serversNow: s.serversNow, servers: step.allocation[i], rateNow: 0, rate: 0, unitCost: search[i].cost,
      costNow: s.serversNow * search[i].cost, cost: step.allocation[i] * search[i].cost, utilisationNow: s.load / s.serversNow < 1 ? s.load / s.serversNow : null, utilisation: s.load / step.allocation[i],
    })),
    constraints: request.constraints.map((c, k) => ({ ...c, unit: unitOf(c.kind), now: now?.values[k] ?? null, proposed: step.evaluation.values[k] ?? null })),
    costNow: cost(nowAllocation),
    cost: cost(step.allocation),
    proof: "none",
    path: outcome.path.map((p) => ({ cost: cost(p.allocation), number: p.evaluation.number, delay: p.evaluation.delay, added: p.added === null ? null : stations[p.added].id, feasible: p.feasible })),
    delayNow: now?.delay ?? null,
    delay: step.evaluation.delay,
    numberNow: now?.number ?? null,
    number: step.evaluation.number,
  };
}

export const UNIT_OF: Record<TargetKind, string> = { networkSojourn: "time", networkNumber: "customers", utilisation: "ratio", stationWait: "time" };
