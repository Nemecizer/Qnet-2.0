// Sensitivity and bottleneck analysis (new in 2.1, ROADMAP D1): the measures offered, the rows a
// result holds, how they are ranked and read in plain words — and, for a network with no closed
// formula, the numerical route's small arithmetic: the step of a central difference and the
// bounded search for the parameter value that reaches a target. Pure functions; the derivatives
// of a Jackson network are Rust's (core/src/sensitivity.rs), never recomputed here.
import type { BnetDocument } from "../lib/bnet";
import { inExportOrder } from "../editor/naming";
import type { ResultRecord } from "../panes/results/model";
import { mostLoaded, stationValues, type Tier } from "../results/insight";
import { allowed, discoverParameters, tidy, type SweepParameter } from "../sweeps/model";
import { pctText, sensitivityWords as w } from "./words";

// ── Measures ────────────────────────────────────────────────────────────────────────────────────

export type MeasureKind = "networkNumber" | "networkSojourn" | "stationNumber" | "stationQueue" | "stationSojourn" | "stationUtilisation";

export interface MeasureChoice {
  /** "networkNumber", "stationQueue:<station id>". */
  key: string;
  kind: MeasureKind;
  stationId: string | null;
  label: string;
  /** The measure inside a sentence ("the average delay through the network"). */
  noun: string;
  /** The unit as result records name it: "customers", "time", "ratio". */
  unit: string;
  /** A time: "shortens" and "lengthens" rather than "lowers" and "raises". */
  time: boolean;
}

const UNIT: Record<MeasureKind, string> = { networkNumber: "customers", networkSojourn: "time", stationNumber: "customers", stationQueue: "customers", stationSojourn: "time", stationUtilisation: "ratio" };
/** The record metric each station measure is read from (src/results/insight.ts `STATION_METRICS`). */
export const METRIC: Record<Exclude<MeasureKind, "networkNumber" | "networkSojourn">, string> = {
  stationNumber: "Mean number in system",
  stationQueue: "Mean queue length",
  stationSojourn: "Mean sojourn time",
  stationUtilisation: "Utilization",
};
const STATION_KINDS = ["stationNumber", "stationQueue", "stationSojourn", "stationUtilisation"] as const;

/** The measures a network offers: the two network-wide ones, then four per station in export order. */
export function measureOptions(doc: BnetDocument): MeasureChoice[] {
  const stations = inExportOrder(doc.nodes.filter((n) => n.kind === "station"), (n) => n.name);
  if (!stations.length) return [];
  const out: MeasureChoice[] = [
    { key: "networkNumber", kind: "networkNumber", stationId: null, label: w.measures.networkNumber, noun: w.nouns.networkNumber, unit: UNIT.networkNumber, time: false },
    { key: "networkSojourn", kind: "networkSojourn", stationId: null, label: w.measures.networkSojourn, noun: w.nouns.networkSojourn, unit: UNIT.networkSojourn, time: true },
  ];
  for (const s of stations) {
    for (const kind of STATION_KINDS) out.push({ key: `${kind}:${s.id}`, kind, stationId: s.id, label: w.measures[kind](s.name), noun: w.nouns[kind](s.name), unit: UNIT[kind], time: kind === "stationSojourn" });
  }
  return out;
}

/** The measure `key` names, or the delay through the network (the question most often asked). */
export function pickMeasure(options: readonly MeasureChoice[], key: string | null): MeasureChoice | null {
  return options.find((m) => m.key === key) ?? options.find((m) => m.kind === "networkSojourn") ?? options[0] ?? null;
}

/** The unit as shown ("time units"; nothing for a ratio). */
export const unitText = (unit: string) => w.units[unit] ?? unit;

// ── What Rust answers (src-tauri/src/sensitivity.rs) ────────────────────────────────────────────

export interface SensitivityRequest {
  document: unknown;
  measure: { kind: MeasureKind; stationId: string | null };
  parameters: { id: string; kind: string; nodeId?: string; customerClass?: number | null; linkId?: string; complementId?: string }[];
  /** −0.1: cut the measure by 10 %; null: no "what would it take". */
  targetChange: number | null;
}

export type Why = "noEffect" | "rangeEnds" | "levels" | "overload" | "notFound";
export type InversionAnswer = { kind: "achieved"; value: number; measure: number } | { kind: "infeasible"; why: Why; limitValue: number | null; limitMeasure: number | null };

export interface AnalysisRow {
  id: string;
  current: number | null;
  integer: boolean;
  derivative: number | null;
  elasticity: number | null;
  oneMore: number | null;
  inversion: InversionAnswer | null;
  note: string | null;
}

export interface SensitivityAnalysis {
  available: boolean;
  reason: "network" | "unstable" | "notJackson" | "closed" | "closedNoPopulation" | null;
  sentence: string | null;
  value: number | null;
  unit: string | null;
  target: number | null;
  stations: { id: string; name: string; utilisation: number }[];
  /** The station(s) at the highest utilisation: several when they tie. */
  bottlenecks: string[];
  rows: AnalysisRow[];
}

export const requestFor = (doc: BnetDocument, measure: MeasureChoice, parameters: readonly SweepParameter[], targetChange: number | null): SensitivityRequest => ({
  document: doc,
  measure: { kind: measure.kind, stationId: measure.stationId },
  parameters: parameters.map((p) => ({ id: p.id, kind: p.kind, nodeId: p.nodeId, customerClass: p.customerClass ?? null, linkId: p.linkId, complementId: p.complementId })),
  targetChange,
});

// ── A result, whichever route made it ───────────────────────────────────────────────────────────

export interface SensitivityRow {
  parameter: SweepParameter;
  derivative: number | null;
  elasticity: number | null;
  /** A whole-number parameter: the measure with one more. */
  oneMore: number | null;
  inversion: InversionAnswer | null;
  note: string | null;
  /** A difference taken on one side only (the value sits at the end of its range). */
  oneSided?: boolean;
}

export interface SensitivityResult {
  /** "formula": exact, from Rust's closed forms. "difference": central differences over quiet runs. */
  route: "formula" | "difference";
  tier: Tier;
  /** The method differentiated (difference route). */
  method: { label: string; name: string } | null;
  measureKey: string;
  value: number;
  /** The target of "what would it take", when one was asked for. */
  target: number | null;
  targetChange: number | null;
  stations: { id: string; name: string; utilisation: number }[];
  /** The station(s) at the highest utilisation: several when they tie. */
  bottlenecks: string[];
  rows: SensitivityRow[];
  /** Parameters not analysed, to bound the number of runs. */
  leftOut: number;
  stopped?: boolean;
  fingerprint?: string | null;
  network?: Pick<BnetDocument, "nodes" | "links" | "infiniteBuffers">;
}

/** Rust's answer as a result: its rows joined to the parameters they are about. */
export function fromAnalysis(a: SensitivityAnalysis, measure: MeasureChoice, parameters: readonly SweepParameter[], targetChange: number | null): SensitivityResult | null {
  if (!a.available || a.value === null) return null;
  const rows: SensitivityRow[] = [];
  for (const r of a.rows) {
    const parameter = parameters.find((p) => p.id === r.id);
    if (!parameter) continue;
    rows.push({ parameter: r.current === null ? parameter : { ...parameter, current: r.current }, derivative: r.derivative, elasticity: r.elasticity, oneMore: r.oneMore, inversion: r.inversion, note: r.note });
  }
  return { route: "formula", tier: "exact", method: null, measureKey: measure.key, value: a.value, target: a.target, targetChange, stations: a.stations, bottlenecks: a.bottlenecks, rows, leftOut: 0 };
}

/** The continuous parameters with an elasticity, the one that moves the measure most first. */
export function ranked(rows: readonly SensitivityRow[]): SensitivityRow[] {
  return rows.filter((r) => !r.parameter.integer && r.elasticity !== null && Number.isFinite(r.elasticity)).sort((a, b) => Math.abs(b.elasticity!) - Math.abs(a.elasticity!));
}

/** The whole-number parameters with a "one more" value, the largest relative change first. */
export function steps(rows: readonly SensitivityRow[], value: number): SensitivityRow[] {
  return rows.filter((r) => r.parameter.integer && r.oneMore !== null).sort((a, b) => Math.abs(b.oneMore! - value) - Math.abs(a.oneMore! - value));
}

/** The stations at the highest utilisation: several when they tie (`BOTTLENECK_TIE`, the canvas's rule and Rust's). */
export function bottlenecks(result: Pick<SensitivityResult, "stations">): { id: string; name: string; utilisation: number }[] {
  return mostLoaded(result.stations, (s) => s.utilisation);
}

const names = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function bottleneckSentence(result: Pick<SensitivityResult, "stations">): string | null {
  const top = bottlenecks(result);
  if (!top.length) return null;
  const rho = pctText(top[0].utilisation * 100);
  return top.length === 1 ? w.bottleneck(top[0].name, rho) : w.bottleneckTie(names(top.map((s) => s.name)), rho);
}

/** One sentence for a row: "Raising the S2 service rate by 1 % shortens the average delay by about 3.2 %; it is the bottleneck." */
export function reading(row: SensitivityRow, measure: MeasureChoice, result: Pick<SensitivityResult, "stations" | "value">): string | null {
  const p = row.parameter;
  const top = bottlenecks(result);
  const neck = top.length === 1 && (p.kind === "service" || p.kind === "servers") && p.nodeId === top[0].id ? `; ${w.isBottleneck}` : "";
  if (p.integer) {
    if (row.oneMore === null || result.value === 0) return null;
    const change = (row.oneMore - result.value) / result.value;
    const what = p.kind === "servers" ? w.oneMore(p.label.replace(/ number of servers$/, ""), p.current, p.current + 1) : w.oneMoreBuffer(p.label.replace(/ size$/, ""), p.current, p.current + 1);
    if (Math.abs(change) < 5e-7) return `${what} ${w.noEffect(measure.noun)}.`;
    return `${what} ${w.oneMoreExact(change > 0, measure.noun, pctText(change * 100), measure.time)}${neck}.`;
  }
  if (row.elasticity === null) return null;
  const name = p.label.replace(/ \(.*\)$/, "");
  const action = p.kind === "load" ? w.action.load() : p.kind === "arrival" ? w.action.arrival(name) : p.kind === "routing" ? w.action.routing(lower(name)) : w.action.service(name);
  if (Math.abs(row.elasticity) < 5e-5) return `${action} ${w.noEffect(measure.noun)}.`;
  return `${action} ${w.effect(row.elasticity > 0, measure.noun, pctText(row.elasticity), measure.time)}${neck}.`;
}

const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The relative change of the parameter an achieved option asks for; null from a value of zero. */
export function relativeChange(row: SensitivityRow): number | null {
  if (row.inversion?.kind !== "achieved" || row.parameter.current === 0) return null;
  return (row.inversion.value - row.parameter.current) / Math.abs(row.parameter.current);
}

/** "What would it take": the options that work, smallest relative change first, then those that don't. */
export function options(rows: readonly SensitivityRow[]): { feasible: SensitivityRow[]; infeasible: SensitivityRow[] } {
  const withAnswer = rows.filter((r) => r.inversion && r.parameter.kind !== "load");
  const feasible = withAnswer.filter((r) => r.inversion!.kind === "achieved").sort((a, b) => Math.abs(relativeChange(a) ?? Infinity) - Math.abs(relativeChange(b) ?? Infinity));
  return { feasible, infeasible: withAnswer.filter((r) => r.inversion!.kind === "infeasible") };
}

/** The target change as a fraction, from the field's text and the direction; null for text that isn't a percentage in (0, 100). */
export function targetChangeOf(text: string, direction: "cut" | "raise"): number | null {
  const x = Number(text.trim().replace(",", ".").replace(/\s*%$/, ""));
  if (!text.trim() || !Number.isFinite(x) || x < 0.1 || x > 99) return null;
  return (direction === "cut" ? -x : x) / 100;
}

// ── The numerical route ─────────────────────────────────────────────────────────────────────────

/**
 * The relative step of a central difference: 0.5 % either side. For a queue at utilisation ρ the
 * difference's truncation error is about (h·ρ/(1 − ρ))² of the derivative — 0.2 % at ρ = 0.9 —
 * and a solver that prints six digits leaves about 10⁻⁴ of rounding: the two are of one size.
 */
export const STEP = 0.005;

export interface StepPlan {
  low: number;
  high: number;
  /** One side only, where the value is at the end of its range. */
  oneSided: boolean;
}

/** Where a continuous parameter is evaluated for its difference; null when it cannot move at all. */
export function stepPlan(p: SweepParameter): StepPlan | null {
  if (p.integer) return null;
  const h = STEP * (p.kind === "routing" ? (p.rowSum ?? 1) : Math.abs(p.current));
  if (!(h > 0)) return null;
  const [low, high] = [tidy(p.current - h), tidy(p.current + h)];
  const [okLow, okHigh] = [allowed(p, low), allowed(p, high)];
  if (okLow && okHigh) return { low, high, oneSided: false };
  if (okHigh) return { low: p.current, high, oneSided: true };
  if (okLow) return { low, high: p.current, oneSided: true };
  return null;
}

export const difference = (plan: StepPlan, atLow: number, atHigh: number) => (atHigh - atLow) / (plan.high - plan.low);
export const elasticityOf = (derivative: number, current: number, value: number) => (value !== 0 ? (derivative * current) / value : null);

/** The total external arrival rate: Σ source rates, when every source's rate can be read. */
export function totalArrivals(doc: BnetDocument, parameters: readonly SweepParameter[]): number | null {
  const sources = doc.nodes.filter((n) => n.kind === "source");
  const rates = sources.map((s) => parameters.find((p) => p.kind === "arrival" && p.nodeId === s.id)?.current);
  return sources.length && rates.every((r): r is number => typeof r === "number") ? rates.reduce((a, b) => a + b, 0) : null;
}

/**
 * The measure in a run's record; null when the method does not report it. The network's mean
 * number is the stations' summed; its mean delay is that over the total arrival rate (Little's
 * law), offered for infinite buffers only — with finite buffers some arrivals are lost and the
 * rate that enters is not the rate that arrives.
 *
 * `doc` is the network the record was solved for, and the arrival rate is read from it — never
 * from the network before a parameter was moved. Dividing a moved network's N by the base Λ
 * differentiates N/Λ₀, not W = N/Λ: for an M/M/1 queue at ρ = 0.8 that reads the elasticity of W
 * in λ as 5 (N's) where it is 4.
 */
export function readMeasure(record: ResultRecord, measure: MeasureChoice, doc: BnetDocument): number | null {
  const stations = doc.nodes.filter((n) => n.kind === "station");
  if (measure.kind === "networkNumber" || measure.kind === "networkSojourn") {
    const values = stationValues(record, "Mean number in system");
    let total = 0;
    for (const s of stations) {
      const v = values.find((x) => x.stationID.toUpperCase() === s.id.toUpperCase());
      if (!v) return null;
      total += v.value;
    }
    if (measure.kind === "networkNumber") return total;
    const arrivals = totalArrivals(doc, discoverParameters(doc));
    return doc.infiniteBuffers && arrivals !== null && arrivals > 0 ? total / arrivals : null;
  }
  const v = stationValues(record, METRIC[measure.kind]).find((x) => x.stationID.toUpperCase() === (measure.stationId ?? "").toUpperCase());
  return v && Number.isFinite(v.value) ? v.value : null;
}

/** How close to the target counts as reaching it: within 2 % of the change asked for. */
export const FIND_TOLERANCE = 0.02;
/** The most solver runs one parameter's search may use. */
export const FIND_EVALUATIONS = 6;

export interface FindProblem {
  /** The parameter now, the measure now and its derivative there. */
  current: number;
  value: number;
  derivative: number;
  target: number;
  /** The values the parameter may take. */
  allowed: (x: number) => boolean;
  /** The end of a closed range in each direction, when there is one. */
  min: number | null;
  max: number | null;
}

/**
 * The parameter value at which the measure is `target`, found with at most `FIND_EVALUATIONS`
 * evaluations: a Newton step from the known derivative, then secant steps (between a bracketing
 * pair once there is one). A rate is kept within a factor of eight of its value now. The answer's
 * measure is the one evaluated at the answer — the verification is part of the search. `evaluate`
 * answers null where the network cannot be solved (overloaded) and "stopped" when Stop was pressed.
 */
export async function findValue(problem: FindProblem, evaluate: (x: number) => Promise<number | null | "stopped">): Promise<InversionAnswer | "stopped"> {
  const { current: x0, value: m0, derivative, target } = problem;
  const infeasible = (why: Why, limitValue: number | null = null, limitMeasure: number | null = null): InversionAnswer => ({ kind: "infeasible", why, limitValue, limitMeasure });
  if (!derivative || !Number.isFinite(derivative)) return infeasible("noEffect");
  const lo = problem.min ?? x0 / 8;
  const hi = problem.max ?? x0 * 8;
  const clamp = (x: number) => tidy(Math.min(hi, Math.max(lo, x)));
  const points: { x: number; m: number }[] = [{ x: x0, m: m0 }];
  const miss = (m: number) => Math.abs(m - target);
  let x = clamp(x0 + (target - m0) / derivative);
  let overloaded = false;
  for (let n = 0; n < FIND_EVALUATIONS; n++) {
    if (!problem.allowed(x) || points.some((p) => p.x === x)) break;
    const m = await evaluate(x);
    if (m === "stopped") return "stopped";
    const nearest = points.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    if (m === null) {
      // No steady state there: come half-way back towards the nearest value that has one.
      overloaded = true;
      x = tidy((x + nearest.x) / 2);
      continue;
    }
    points.push({ x, m });
    if (miss(m) <= FIND_TOLERANCE * Math.abs(target - m0)) return { kind: "achieved", value: x, measure: m };
    const below = points.filter((p) => p.m < target).sort((a, b) => miss(a.m) - miss(b.m))[0];
    const above = points.filter((p) => p.m > target).sort((a, b) => miss(a.m) - miss(b.m))[0];
    const [a, b] = below && above ? [below, above] : [nearest, { x, m }];
    if (a.m === b.m) break;
    const next = clamp(a.x + ((target - a.m) * (b.x - a.x)) / (b.m - a.m));
    // At the end of the range, and it has been tried: the range is not enough.
    if (next === x && (x === lo || x === hi)) {
      const closed = (x === lo && problem.min !== null) || (x === hi && problem.max !== null);
      return infeasible(closed ? "rangeEnds" : "levels", closed ? x : null, m);
    }
    x = next;
  }
  const best = points.slice(1).sort((a, b) => miss(a.m) - miss(b.m))[0];
  if (best && (best.x === lo || best.x === hi)) {
    const closed = (best.x === lo && problem.min !== null) || (best.x === hi && problem.max !== null);
    return infeasible(closed ? "rangeEnds" : "levels", closed ? best.x : null, best.m);
  }
  return infeasible(overloaded && !best ? "overload" : "notFound", best?.x ?? null, best?.m ?? null);
}
