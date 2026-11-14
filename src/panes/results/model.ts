// What the Results workspace derives from the records, as 0.90.34's ResultsWorkspace.swift did
// (dc066f0): the filter, the run sort, the measurement sort, the previous comparable run and the
// cross-run change, the evidence cell and its tooltip, the failure card's diagnosis, and the
// comparison table. Pure functions over results-v1.json's record objects (core/src/results/model.rs
// is the schema); the numbers they show go through `displayFixed` at `output.decimals`.
import { sameNetwork } from "../../results/current";
import { cFixed, displayFixed } from "../../editor/numbers";
import type { RunRecord } from "../../lib/types";
import { resultsWords as w } from "./words";

export interface Uncertainty {
  standardError?: number;
  lowerBound?: number;
  upperBound?: number;
  confidenceLevel?: number;
  sampleSize?: number;
}
export interface NumericalEvidence {
  residual?: number;
  discretization?: string;
  refinementDelta?: number;
  convergenceNote?: string;
}
export interface Measurement {
  id: string;
  stationID?: string;
  stationName: string;
  customerClass?: number;
  metric: string;
  estimate: number;
  unit: string;
  uncertainty?: Uncertainty;
  numericalEvidence?: NumericalEvidence;
  note?: string;
}
export interface MethodMetadata {
  identifier: string;
  displayName: string;
  shortName: string;
  layer: string;
  fidelity: string;
  implementation?: string;
}
export interface Provenance {
  tabID: string;
  networkTitle: string;
  sourceFileURL?: string;
  networkFingerprint: string;
  bufferRegime: string;
  parameters: Record<string, string>;
  seed?: number;
  [k: string]: unknown;
}
/** A record as results-v1.json holds it (`ResultRunRecord`). */
export interface ResultRecord {
  id: string;
  method: MethodMetadata;
  provenance: Provenance;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  elapsedSeconds?: number;
  measurements: Measurement[];
  runEvidence?: NumericalEvidence;
  warnings: string[];
  failureMessage?: string;
  rawOutput?: string;
}

export const asResult = (r: RunRecord) => r as unknown as ResultRecord;

// ── Layers, sorts, comparisons ────────────────────────────────────────────────────────────────

/** `ResultModelLayer` raw values. */
export const LAYER = {
  queue: "Queueing process",
  approximation: "Queue approximation",
  srbm: "SRBM diffusion",
  bound: "Certified bound",
  mixed: "Mixed model layers",
} as const;

/** `ResultModelLayer.shortName`. */
export function layerShortName(layer: string): string {
  switch (layer) {
    case LAYER.queue: return "Queue";
    case LAYER.approximation: return "Approximation";
    case LAYER.srbm: return "SRBM";
    case LAYER.bound: return "Bound";
    case LAYER.mixed: return "Mixed";
    default: return layer;
  }
}

export type LayerFilter = keyof typeof w.layers;
export const LAYER_FILTERS = Object.keys(w.layers) as LayerFilter[];
export type RunSort = keyof typeof w.sorts;
export const RUN_SORTS = Object.keys(w.sorts) as RunSort[];
export type MeasurementSort = "station" | "customerClass" | "metric" | "estimate" | "uncertainty" | "unit";

/** `LayerFilter.includes`. */
export function layerIncludes(filter: LayerFilter, layer: string): boolean {
  return filter === "all" || LAYER[filter] === layer;
}

/** `localizedStandardCompare`: Finder's order (numbers by value, in the user's locale). */
const collator = new Intl.Collator(undefined, { numeric: true });
export const standardCompare = (a: string, b: string) => Math.sign(collator.compare(a, b));

/** `localizedCaseInsensitiveContains`. */
export const containsCI = (text: string, q: string) => text.toLocaleLowerCase().includes(q.toLocaleLowerCase());

const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const time = (iso: string) => Date.parse(iso);

/** `filteredRuns`: the tab's runs in the layer, matching the filter, in the chosen order. */
export function filterRuns(records: ResultRecord[], search: string, layer: LayerFilter, sort: RunSort): ResultRecord[] {
  const q = search.trim();
  const runs = records.filter((run) => {
    if (!layerIncludes(layer, run.method.layer)) return false;
    if (!q) return true;
    return (
      containsCI(run.method.displayName, q) ||
      containsCI(run.provenance.networkTitle, q) ||
      containsCI(run.method.fidelity, q) ||
      run.warnings.some((x) => containsCI(x, q)) ||
      run.measurements.some((m) => containsCI(m.stationName, q) || containsCI(m.metric, q) || containsCI(m.unit, q))
    );
  });
  switch (sort) {
    case "newest":
      return runs.sort((a, b) => time(b.startedAt) - time(a.startedAt));
    case "method":
      return runs.sort((a, b) => standardCompare(a.method.displayName, b.method.displayName));
    case "network":
      return runs.sort((a, b) => standardCompare(a.provenance.networkTitle, b.provenance.networkTitle));
  }
}

/** `sortedMeasurements`: the run's measurements matching the filter, sorted; ties by id. */
export function sortMeasurements(run: ResultRecord, search: string, by: MeasurementSort, ascending: boolean): Measurement[] {
  const q = search.trim();
  const values = run.measurements.filter((m) => !q || containsCI(m.stationName, q) || containsCI(m.metric, q) || containsCI(m.unit, q));
  const order = (a: Measurement, b: Measurement): number => {
    switch (by) {
      case "station": return standardCompare(a.stationName, b.stationName);
      case "customerClass": return cmp(a.customerClass ?? -1, b.customerClass ?? -1);
      case "metric": return standardCompare(a.metric, b.metric);
      case "estimate": return cmp(a.estimate, b.estimate);
      // How wide the uncertainty is, whichever spelling gave it; none sorts last ascending.
      case "uncertainty": return cmp(spread(a.uncertainty) ?? Infinity, spread(b.uncertainty) ?? Infinity);
      case "unit": return standardCompare(a.unit, b.unit);
    }
  };
  return values.sort((a, b) => {
    const c = order(a, b);
    if (c === 0) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return ascending ? c : -c;
  });
}

/** `ResultUncertainty.halfWidth`. */
export function halfWidth(u: Uncertainty | undefined): number | undefined {
  return u && typeof u.lowerBound === "number" && typeof u.upperBound === "number" ? (u.upperBound - u.lowerBound) / 2 : undefined;
}
/** `ResultUncertainty.spread`: the half-width, else the standard error. */
export function spread(u: Uncertainty | undefined): number | undefined {
  return halfWidth(u) ?? u?.standardError;
}

export const isStale = (run: ResultRecord, current: string | null) => current !== null && !sameNetwork(run, current);

/** `previousComparableRun(for:)`: the latest older completed run of the same method and network snapshot. */
export function previousComparableRun(tabRecords: ResultRecord[], run: ResultRecord): ResultRecord | null {
  let best: ResultRecord | null = null;
  for (const r of tabRecords) {
    if (
      r.id !== run.id &&
      r.status === "completed" &&
      r.method.identifier === run.method.identifier &&
      r.provenance.networkFingerprint === run.provenance.networkFingerprint &&
      time(r.startedAt) < time(run.startedAt) &&
      (!best || time(best.startedAt) < time(r.startedAt))
    )
      best = r;
  }
  return best;
}

/** `ResultsComparisonKey`: station id, station name, class, metric, unit. */
export function comparisonKey(m: Measurement): string {
  return JSON.stringify([m.stationID ?? null, m.stationName, m.customerClass ?? null, m.metric, m.unit]);
}
export const classLabel = (c: number | undefined | null) => (typeof c === "number" ? `C${c + 1}` : "All");

export interface CrossRunDelta {
  count: number;
  maximumAbsolute: number;
  maximumRelative: number;
  changedParameters: string[];
}

/** `crossRunDelta`: the change from the previous comparable run over the measurements both have. */
export function crossRunDelta(run: ResultRecord, previous: ResultRecord | null): CrossRunDelta | null {
  if (!previous) return null;
  // 0.90.34 built this with Dictionary(uniqueKeysWithValues:), which traps on a repeated key; the
  // first estimate of a key is used here.
  const older = new Map<string, number>();
  for (const m of previous.measurements) if (!older.has(comparisonKey(m))) older.set(comparisonKey(m), m.estimate);
  const absolute: number[] = [];
  const relative: number[] = [];
  for (const m of run.measurements) {
    const o = older.get(comparisonKey(m));
    if (!Number.isFinite(m.estimate) || o === undefined || !Number.isFinite(o)) continue;
    const d = Math.abs(m.estimate - o);
    absolute.push(d);
    relative.push(d / Math.max(Math.abs(o), Number.MIN_VALUE));
  }
  if (!absolute.length) return null;
  const a = run.provenance.parameters ?? {};
  const b = previous.provenance.parameters ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [...keys].filter((k) => a[k] !== b[k]).sort();
  return { count: absolute.length, maximumAbsolute: Math.max(...absolute), maximumRelative: Math.max(...relative), changedParameters: changed };
}

/** What the Quality Evidence panel shows (`ResultsEvidenceDashboard`), or null when it is hidden. */
export interface EvidenceItem {
  label: string;
  value: string;
  help?: string;
}
export function evidenceItems(run: ResultRecord, previous: ResultRecord | null, decimals: number): EvidenceItem[] | null {
  const statistical = run.measurements.filter((m) => m.uncertainty != null).length;
  const maxOf = (xs: (number | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === "number");
    return v.length ? v.reduce((m, x) => (m < x ? x : m)) : undefined;
  };
  const residual = run.runEvidence?.residual ?? maxOf(run.measurements.map((m) => m.numericalEvidence?.residual));
  const refinement = run.runEvidence?.refinementDelta ?? maxOf(run.measurements.map((m) => m.numericalEvidence?.refinementDelta));
  const delta = crossRunDelta(run, previous);
  const simulation = run.method.fidelity === "Queue simulation";
  if (!(statistical > 0 || residual !== undefined || refinement !== undefined || delta || simulation)) return null;
  const items: EvidenceItem[] = [];
  if (statistical > 0) items.push({ label: w.statistical, value: w.statisticalValue(statistical, run.measurements.length) });
  else if (simulation) items.push({ label: w.uncertaintyMissing, value: w.uncertaintyMissingValue });
  if (residual !== undefined) items.push({ label: w.residual, value: displayFixed(residual, decimals) });
  if (refinement !== undefined) items.push({ label: w.refinement, value: displayFixed(refinement, decimals) });
  if (delta)
    items.push({
      label: w.crossRun,
      value: w.crossRunValue(displayFixed(delta.maximumAbsolute, decimals), percent(delta.maximumRelative)),
      help: w.crossRunHelp(delta.count, delta.changedParameters),
    });
  return items;
}

/** `.percent.precision(.fractionLength(0...3))`. */
export function percent(v: number): string {
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 3, roundingMode: "halfEven" } as Intl.NumberFormatOptions).format(v);
}

/** `ResultsMeasurementRow.evidenceLabel`. */
export function evidenceLabel(m: Measurement, decimals: number): string {
  const f = (x: number) => displayFixed(x, decimals);
  const u = m.uncertainty;
  if (u) {
    if (typeof u.lowerBound === "number" && typeof u.upperBound === "number") {
      const level = typeof u.confidenceLevel === "number" ? `${cFixed(u.confidenceLevel * 100, 0)}% ` : "";
      return `${level}[${f(u.lowerBound)}, ${f(u.upperBound)}]`;
    }
    if (typeof u.standardError === "number") return `SE ${f(u.standardError)}`;
  }
  const e = m.numericalEvidence;
  if (e) {
    if (typeof e.residual === "number") return `residual ${f(e.residual)}`;
    if (typeof e.refinementDelta === "number") return `Δ ${f(e.refinementDelta)}`;
    if (typeof e.discretization === "string") return e.discretization;
  }
  return "—";
}

/** The row's tooltip: the note, else `evidenceHelp`. */
export function measurementHelp(m: Measurement, decimals: number): string {
  if (m.note != null) return m.note;
  const f = (x: number) => displayFixed(x, decimals);
  const parts: string[] = [];
  const u = m.uncertainty;
  if (u) {
    if (typeof u.lowerBound === "number" && typeof u.upperBound === "number") {
      const level = typeof u.confidenceLevel === "number" ? w.confidenceInterval(cFixed(u.confidenceLevel * 100, 0)) : w.interval;
      parts.push(`${level}: [${f(u.lowerBound)}, ${f(u.upperBound)}]`);
    }
    if (typeof u.standardError === "number") parts.push(`${w.standardError}: ${f(u.standardError)}`);
    if (typeof u.sampleSize === "number") parts.push(`${w.sampleSize}: ${u.sampleSize}`);
  }
  const e = m.numericalEvidence;
  if (e) {
    if (typeof e.residual === "number") parts.push(`${w.residualHelp}: ${f(e.residual)}`);
    if (typeof e.convergenceNote === "string") parts.push(e.convergenceNote);
  }
  return parts.length ? parts.join(" · ") : w.noEvidence;
}

/** `ResultsFailureCard.guidance`: the diagnosis and the next step, by keywords in the message and transcript. */
export function failureGuidance(message: string, rawOutput: string | undefined, partial: boolean): { diagnosis: string; action: string } {
  const text = [message, rawOutput ?? ""].join("\n").toLowerCase();
  const has = (...xs: string[]) => xs.some((x) => text.includes(x));
  const key = partial
    ? "partial"
    : has("not found", "no such file")
      ? "notFound"
      : has("permission denied")
        ? "permission"
        : has("unstable", "not positive recurrent", "rho >=", "ρ ≥")
          ? "unstable"
          : has("singular", "ill-conditioned", "nan", "not finite")
            ? "singular"
            : has("infeasible", "unbounded")
              ? "infeasible"
              : has("killed", "signal 9", "status 137", "out of memory")
                ? "killed"
                : has("timeout", "timed out")
                  ? "timeout"
                  : "other";
  const [diagnosis, action] = w.guidance[key];
  return { diagnosis: diagnosis ?? message, action };
}

/** The comparison table (`ResultsComparisonView`): its rows and each run's value. */
export interface ComparisonRow {
  key: string;
  stationName: string;
  classLabel: string;
  metric: string;
  values: (number | null)[];
  range: number | null;
}
export function comparisonRows(runs: ResultRecord[]): ComparisonRow[] {
  const keys = new Map<string, Measurement>();
  for (const r of runs) for (const m of r.measurements) if (!keys.has(comparisonKey(m))) keys.set(comparisonKey(m), m);
  const sortText = (m: Measurement) => `${m.stationName}|${m.customerClass ?? -1}|${m.metric}|${m.unit}`;
  const ordered = [...keys.entries()].sort((a, b) => standardCompare(sortText(a[1]), sortText(b[1])));
  return ordered.map(([key, m]) => {
    const values = runs.map((r) => r.measurements.find((x) => comparisonKey(x) === key)?.estimate ?? null);
    const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
    const range = finite.length > 1 ? Math.max(...finite) - Math.min(...finite) : null;
    return { key, stationName: m.stationName, classLabel: classLabel(m.customerClass), metric: m.metric, values, range };
  });
}

/** The comparison chip's tint: queue success, approximation warning, others info. */
export function layerSeverity(layer: string): "success" | "warning" | "info" {
  return layer === LAYER.queue ? "success" : layer === LAYER.approximation ? "warning" : "info";
}

/** The summary chip's severity (`ResultsRunSummary.statusSeverity`). */
export function statusSeverity(status: string): "info" | "success" | "warning" | "error" {
  switch (status) {
    case "completed": return "success";
    case "partial":
    case "cancelled": return "warning";
    case "failed": return "error";
    default: return "info";
  }
}

/** The summary's parameters line: "k=v  ·  …", sorted by key. */
export function parameterLine(p: Record<string, string> | undefined): string {
  const ps = p ?? {};
  return Object.keys(ps).sort().map((k) => `${k}=${ps[k]}`).join("  ·  ");
}

// ── Dates and durations (Date.formatted) ─────────────────────────────────────────────────────

const dateAbbrev = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const timeShort = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const timeStandard = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** `.formatted(date: .abbreviated, time: .shortened)`: "Nov 11, 2026 at 4:39 AM". */
export const abbreviatedShort = (iso: string) => `${dateAbbrev.format(new Date(iso))} at ${timeShort.format(new Date(iso))}`;
/** `.formatted(date: .abbreviated, time: .standard)`. */
export const abbreviatedStandard = (iso: string) => `${dateAbbrev.format(new Date(iso))} at ${timeStandard.format(new Date(iso))}`;
/** `.formatted(date: .omitted, time: .shortened)`. */
export const shortTime = (iso: string) => timeShort.format(new Date(iso));
/** `seconds.formatted(.number.precision(.fractionLength(0...3))) + " s"`. */
export const elapsedText = (s: number) =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 3, roundingMode: "halfEven" } as Intl.NumberFormatOptions).format(s)} s`;
