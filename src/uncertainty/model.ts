// Results ▸ Uncertainty (new in 2.1, ROADMAP D7): which rates can be uncertain, how the fields
// are read into what Rust is asked, and how its answer is put into words. Pure functions. The
// sampling, the delta method and the variance shares are Rust's (core/src/uncertainty.rs), never
// recomputed here.
import type { BnetDocument } from "../lib/bnet";
import { discoverParameters, type SweepParameter } from "../sweeps/model";
import type { MeasureChoice, MeasureKind } from "../sensitivity/model";
import { pctText, uncertaintyWords as w } from "./words";

// ── What Rust is asked and answers (src-tauri/src/uncertainty.rs) ───────────────────────────────

export type Spread =
  | { kind: "relativeSd" | "relativeRange"; value: number }
  | { kind: "interval95" | "intervalRange"; low: number; high: number };

export interface UncertaintyInput {
  id: string;
  kind: string;
  nodeId?: string;
  customerClass?: number | null;
  spread: Spread;
}

export interface UncertaintyRequest {
  document: unknown;
  measure: { kind: MeasureKind; stationId: string | null };
  inputs: UncertaintyInput[];
  arrivalsTogether: boolean;
  samples?: number;
  seed?: number;
}

export interface LinearRequest {
  value: number;
  inputs: { id: string; kind: string; current: number; derivative: number; spread: Spread }[];
  arrivalsTogether: boolean;
}

export interface Estimate {
  value: number;
  /** One Monte Carlo standard error. */
  se: number;
}

export interface InputRow {
  id: string;
  law: "lognormal" | "uniform" | "fixed";
  mean: number;
  sd: number;
  /** The law's 2.5 % and 97.5 % quantiles. */
  low: number;
  high: number;
  derivative: number;
}

export interface ShareRow {
  /** The inputs of this factor: one, or the arrival rates moving together. */
  ids: string[];
  linear: number;
  first: Estimate | null;
  total: Estimate | null;
}

export interface Sampling {
  samples: number;
  seed: number;
  unstable: number;
  pUnstable: Estimate;
  /** False when the laws let a station the measure depends on reach overload: the mean over the stable cases is infinite, and `mean`, `sd` and the sampled shares are null. */
  meanExists: boolean;
  mean: Estimate | null;
  sd: number | null;
  median: Estimate | null;
  q025: Estimate | null;
  q975: Estimate | null;
  min: number | null;
  max: number | null;
  histogram: { low: number; high: number; counts: number[]; above: number } | null;
  shareRows: number;
  evaluations: number;
}

export interface UncertaintyAnalysis {
  available: boolean;
  reason: "network" | "unstable" | "notJackson" | "closed" | "closedNoPopulation" | null;
  sentence: string | null;
  value: number | null;
  unit: string | null;
  inputs: InputRow[];
  shares: ShareRow[];
  linear: { sd: number; low: number; high: number } | null;
  sampling: Sampling | null;
  /** How far the linear approximation is from the sample, as a fraction; compared with `threshold`. */
  disagreement: number | null;
  threshold: number;
}

export interface UncertaintyProgress {
  done: number;
  total: number;
}

// ── The fields ──────────────────────────────────────────────────────────────────────────────────

/** The rates that can be uncertain: every source's arrival rate and every service rate. */
export function uncertainParameters(doc: BnetDocument): SweepParameter[] {
  return discoverParameters(doc).filter((p) => (p.kind === "arrival" || p.kind === "service") && !p.integer);
}

export type How = "default" | "percent" | "interval" | "exact";

export interface Override {
  how: How;
  /** As typed. */
  percent: string;
  low: string;
  high: string;
}

export interface UncertaintySettings {
  measureKey: string | null;
  mode: "chart" | "table";
  /** "All rates ± x %", as typed. */
  percent: string;
  /** ± read as a standard deviation (lognormal) or as a range (uniform). */
  reading: "sd" | "range";
  together: boolean;
  overrides: Record<string, Override>;
}

export const DEFAULT_SETTINGS: UncertaintySettings = { measureKey: null, mode: "chart", percent: "10", reading: "sd", together: false, overrides: {} };
export const BLANK_OVERRIDE: Override = { how: "default", percent: "", low: "", high: "" };

const number = (text: string): number | null => {
  const t = text.trim().replace(",", ".").replace(/\s*%$/, "");
  const x = Number(t);
  return t !== "" && Number.isFinite(x) ? x : null;
};

/** A typed percentage as a fraction; a sentence when it is not one, or too wide for a range. */
export function percentOf(text: string, reading: "sd" | "range"): number | string {
  const x = number(text);
  if (x === null || x < 0 || x > 300) return w.bad.percent;
  if (reading === "range" && x >= 100) return w.bad.range;
  return x / 100;
}

/** What one rate's fields ask for: a spread, null when it is known exactly, or a sentence when the fields can't be read. */
export function spreadOf(settings: UncertaintySettings, id: string): Spread | null | string {
  const o = settings.overrides[id] ?? BLANK_OVERRIDE;
  if (o.how === "exact") return null;
  if (o.how === "interval") {
    const [low, high] = [number(o.low), number(o.high)];
    if (low === null || high === null || !(low > 0) || !(high > low)) return w.bad.interval;
    return { kind: settings.reading === "sd" ? "interval95" : "intervalRange", low, high };
  }
  const fraction = percentOf(o.how === "percent" ? o.percent : settings.percent, settings.reading);
  if (typeof fraction === "string") return fraction;
  return fraction === 0 ? null : { kind: settings.reading === "sd" ? "relativeSd" : "relativeRange", value: fraction };
}

export interface Plan {
  /** The uncertain rates and their spreads. */
  inputs: { parameter: SweepParameter; spread: Spread }[];
  /** Per rate, why its fields can't be read. */
  problems: Record<string, string>;
  /** Why nothing can be asked: a field in error, or nothing uncertain. */
  blocked: string | null;
}

export function planOf(parameters: readonly SweepParameter[], settings: UncertaintySettings): Plan {
  const inputs: Plan["inputs"] = [];
  const problems: Record<string, string> = {};
  for (const p of parameters) {
    const s = spreadOf(settings, p.id);
    if (typeof s === "string") problems[p.id] = s;
    else if (s) inputs.push({ parameter: p, spread: s });
  }
  const first = Object.values(problems)[0];
  return { inputs, problems, blocked: first ?? (inputs.length ? null : w.bad.nothing) };
}

export const requestFor = (doc: BnetDocument, measure: MeasureChoice, plan: Plan, together: boolean): UncertaintyRequest => ({
  document: doc,
  measure: { kind: measure.kind, stationId: measure.stationId },
  inputs: plan.inputs.map(({ parameter: p, spread }) => ({ id: p.id, kind: p.kind, nodeId: p.nodeId, customerClass: p.customerClass ?? null, spread })),
  arrivalsTogether: together,
});

/** A key that changes when the question does (the network aside). */
export const planKey = (measure: MeasureChoice, plan: Plan, together: boolean) => JSON.stringify([measure.key, together, plan.inputs.map((i) => [i.parameter.id, i.spread])]);

// ── The answer in words ─────────────────────────────────────────────────────────────────────────

/** "λ at Src1" for one input; "Arrival rates (together)" for the group. */
export function shareLabel(row: ShareRow, parameters: readonly SweepParameter[]): string {
  if (row.ids.length > 1) return w.arrivalsTogether;
  const p = parameters.find((x) => x.id === row.ids[0]);
  return p ? p.label.replace(/ \(.*\)$/, "") : row.ids[0];
}

/** The share the view ranks by: the sampled first-order index where there is one, else the linear share. */
export const shareValue = (row: ShareRow) => row.first?.value ?? row.linear;

/** The shares, the largest first. */
export function rankedShares(shares: readonly ShareRow[]): ShareRow[] {
  return [...shares].sort((a, b) => shareValue(b) - shareValue(a));
}

/**
 * "Measure the S1 service rate better: it explains 72 % of the uncertainty in the average delay…" —
 * null when no input stands out (under 5 %). Once sampled cases overload, the measure's variance
 * is dominated by a few near-overload cases and its sampled shares do not settle: the sentence is
 * then the linear approximation's, and says so.
 */
export function recommendation(a: Pick<UncertaintyAnalysis, "shares" | "sampling">, parameters: readonly SweepParameter[], noun: string): string | null {
  const local = !a.sampling || a.sampling.unstable > 0 || !a.sampling.meanExists;
  const of = (r: ShareRow) => (local ? r.linear : shareValue(r));
  const top = [...a.shares].sort((x, y) => of(y) - of(x))[0];
  if (!top || !(of(top) >= 0.05)) return null;
  const name = top.ids.length > 1 ? "the arrival rates" : `the ${shareLabel(top, parameters)}`;
  const pct = pctText(Math.min(1, of(top)) * 100);
  return local ? w.recommendLocal(name, pct, noun) : w.recommend(name, pct, noun);
}

/** Whether the linear approximation is far enough from the sample to say so. */
export const linearIsOff = (a: Pick<UncertaintyAnalysis, "disagreement" | "threshold" | "sampling">) =>
  (a.sampling?.unstable ?? 0) > 0 || a.sampling?.meanExists === false || (a.disagreement !== null && a.disagreement > a.threshold);
