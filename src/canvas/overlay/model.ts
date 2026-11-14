// What the canvas shows of a tab's runs (new in 2.1, ROADMAP B2): one value per station for the
// chosen metric, from one run, with how strongly to paint it, which station is the bottleneck
// and whether the network has changed since. Pure; every number comes from src/results/insight.ts
// so the overlay, the charts and the agreement view cannot disagree.
import { displayFixed } from "../../editor/numbers";
import { bestRun, bottlenecks, currentRuns, STATION_METRICS, stationValues, tierOf, type StationMetric, type StationValue, type Tier } from "../../results/insight";
import { isStale, type ResultRecord } from "../../panes/results/model";
import { overlayWords as w } from "./words";

export const DEFAULT_METRIC: StationMetric = "Utilization";
/** The badge never prints more fraction digits than this, whatever `output.decimals` says; the tooltip prints them all. */
export const BADGE_MAX_DECIMALS = 3;

export const isStationMetric = (m: unknown): m is StationMetric => (STATION_METRICS as readonly unknown[]).includes(m);

export interface OverlayItem {
  stationID: string;
  stationName: string;
  value: number;
  interval: { low: number; high: number } | null;
  /** "90.1 %", "9.000 customers": the number with its unit. */
  text: string;
  /** The badge's parts: "9.350", then "± 0.461" when the method gives an interval, then "customers". */
  number: string;
  plusMinus: string | null;
  unit: string;
  /** 0…1 along the metric's scale: utilisation as it is (clamped), anything else against the largest station. */
  intensity: number;
  /** The most loaded station, or one of several that tie for it (`tied`). */
  bottleneck: boolean;
  /** One of several stations at the highest utilisation: "equally loaded", not "the bottleneck". */
  tied: boolean;
  /** Per-class values when the run reports them ("Class 1: 4.500000 customers"). */
  classes: string[];
  /** The tooltip and the spoken description, lines top to bottom. */
  lines: string[];
  label: string;
}

export interface OverlayModel {
  run: ResultRecord;
  metric: StationMetric;
  unit: string;
  tier: Tier;
  /** "Product Form". */
  method: string;
  /** "Mean number in system · Product Form · Exact". */
  caption: string;
  /** The network's fingerprint is no longer the run's. */
  stale: boolean;
  /** The run was picked in the Results pane rather than chosen as the best current one. */
  pinned: boolean;
  /** Uppercased station id → what to draw. Empty when the run reports nothing for the metric. */
  items: ReadonlyMap<string, OverlayItem>;
  /** The largest value on the canvas (the top of a relative scale). */
  max: number;
  /** True for utilisation: a fixed 0–1 scale that changes character near 1. */
  fixedScale: boolean;
  /** The metrics some candidate run reports per station, in menu order. */
  available: StationMetric[];
}

const usable = (r: ResultRecord) => (r.status === "completed" || r.status === "partial") && r.measurements.length > 0;
const reports = (r: ResultRecord, metric: string) => stationValues(r, metric).length > 0;

/**
 * The run the canvas shows: the one picked in the Results pane when it can be shown; otherwise the
 * best current run that reports `metric` (else the best current run); and when the network has
 * changed since every run, the best run of the newest network that was run, to be shown as stale.
 */
export function chooseRun(records: readonly ResultRecord[], fingerprint: string | null, metric: string, selectedRunId: string | null): { run: ResultRecord; candidates: ResultRecord[]; pinned: boolean } | null {
  let candidates = currentRuns(records, fingerprint);
  if (!candidates.length && fingerprint !== null) {
    const done = records.filter((r) => usable(r) && tierOf(r) !== "mixed");
    const newest = done.reduce<ResultRecord | null>((a, b) => (!a || (b.completedAt ?? b.startedAt) > (a.completedAt ?? a.startedAt) ? b : a), null);
    if (newest) candidates = currentRuns(records, newest.provenance.networkFingerprint);
  }
  const picked = selectedRunId ? records.find((r) => r.id === selectedRunId && usable(r) && r.measurements.some((m) => m.stationID)) : undefined;
  if (picked) return { run: picked, candidates: candidates.some((r) => r.id === picked.id) ? candidates : [picked, ...candidates], pinned: true };
  const run = bestRun(candidates.filter((r) => reports(r, metric))) ?? bestRun(candidates);
  return run ? { run, candidates, pinned: false } : null;
}

/** A number with its unit: a ratio as a percentage, anything else followed by the unit's words. */
export function formatValue(value: number, unit: string, decimals: number): string {
  if (unit === "ratio") return `${displayFixed(value * 100, Math.max(0, decimals - 2))} %`;
  const words = w.unit[unit] ?? unit;
  return words ? `${displayFixed(value, decimals)} ${words}` : displayFixed(value, decimals);
}

/** The same, in two parts: the digits and the unit's words ("90.1" and "%"). */
export function valueParts(value: number, unit: string, decimals: number): { number: string; unit: string } {
  if (unit === "ratio") return { number: displayFixed(value * 100, Math.max(0, decimals - 2)), unit: "%" };
  return { number: displayFixed(value, decimals), unit: w.unit[unit] ?? unit };
}

/** Where `value` sits on the metric's scale, 0…1. */
export function intensityOf(value: number, fixedScale: boolean, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const t = fixedScale ? value : max > 0 ? value / max : 0;
  return Math.min(1, Math.max(0, t));
}

/** The record's name for `metric` (the exact methods say "Server utilization") and its unit. */
function recorded(run: ResultRecord, metric: string, stationID: string): { name: string; unit: string } | null {
  const names = metric === "Utilization" ? ["Utilization", "Server utilization"] : [metric];
  const m = run.measurements.find((x) => names.includes(x.metric) && x.stationID === stationID);
  return m ? { name: m.metric, unit: m.unit } : null;
}

/** The per-class values of `metric` at a station, lowest class first; empty unless the run reports more than one class there. */
export function classBreakdown(run: ResultRecord, metric: string, stationID: string, decimals: number): string[] {
  const rec = recorded(run, metric, stationID);
  if (!rec) return [];
  const perClass = run.measurements
    .filter((m) => m.metric === rec.name && m.stationID === stationID && typeof m.customerClass === "number" && Number.isFinite(m.estimate))
    .sort((a, b) => a.customerClass! - b.customerClass!);
  // One class is the station's own value again, not a breakdown.
  if (perClass.length < 2) return [];
  return perClass.map((m) => `${w.className(m.customerClass!)}: ${formatValue(m.estimate, m.unit, decimals)}`);
}

export interface OverlayInput {
  records: readonly ResultRecord[];
  /** The network's fingerprint now; null while unknown (then nothing reads as stale). */
  fingerprint: string | null;
  metric: StationMetric;
  selectedRunId?: string | null;
  /** `output.decimals`. */
  decimals: number;
}

/** The overlay for a tab, or null when it has no run to show. */
export function overlayModel({ records, fingerprint, metric, selectedRunId = null, decimals }: OverlayInput): OverlayModel | null {
  const chosen = chooseRun(records, fingerprint, metric, selectedRunId);
  if (!chosen) return null;
  const { run, candidates, pinned } = chosen;
  const values: StationValue[] = stationValues(run, metric);
  const fixedScale = metric === "Utilization";
  const max = values.reduce((m, v) => Math.max(m, v.value), 0);
  const necks = bottlenecks(run);
  const stale = isStale(run, fingerprint);
  const tier = tierOf(run);
  const short = Math.min(decimals, BADGE_MAX_DECIMALS);
  const items = new Map<string, OverlayItem>();
  let unit = "";
  for (const v of values) {
    const u = recorded(run, metric, v.stationID)?.unit ?? "";
    unit ||= u;
    // The most loaded station carries the marker; stations that tie all carry it, and none is
    // called "the" bottleneck: each says which others it is level with.
    const isNeck = necks.some((n) => n.stationID === v.stationID);
    const tied = isNeck && necks.length > 1;
    const others = necks.filter((n) => n.stationID !== v.stationID).map((n) => n.stationName);
    const half = v.interval ? (v.interval.high - v.interval.low) / 2 : null;
    const classes = classBreakdown(run, metric, v.stationID, decimals);
    const full = formatValue(v.value, u, decimals);
    const range = v.interval ? ` (${w.interval(formatValue(v.interval.low, u, decimals), formatValue(v.interval.high, u, decimals))})` : "";
    const lines = [`${v.stationName} · ${metric}: ${full}${range}`];
    if (classes.length) lines.push(...classes);
    lines.push(`${run.method.shortName} · ${w.tier[tier]}`);
    if (isNeck) lines.push(tied ? w.equallyLoadedHelp(others) : w.bottleneckHelp);
    if (stale) lines.push(w.stale);
    items.set(v.stationID.toUpperCase(), {
      stationID: v.stationID,
      stationName: v.stationName,
      value: v.value,
      interval: v.interval,
      text: formatValue(v.value, u, short),
      number: valueParts(v.value, u, short).number,
      plusMinus: half !== null ? w.plusMinus(valueParts(half, u, short).number) : null,
      unit: valueParts(v.value, u, short).unit,
      intensity: intensityOf(v.value, fixedScale, max),
      bottleneck: isNeck,
      tied,
      classes,
      lines,
      label: [`${v.stationName}: ${metric} ${full}${range}`, isNeck ? (tied ? w.equallyLoaded : w.bottleneck) : null, stale ? w.stale : null].filter(Boolean).join(". "),
    });
  }
  return {
    run,
    metric,
    unit,
    tier,
    method: run.method.shortName,
    caption: `${metric} · ${run.method.shortName} · ${w.tier[tier]}`,
    stale,
    pinned,
    items,
    max,
    fixedScale,
    available: STATION_METRICS.filter((m) => candidates.some((r) => reports(r, m))),
  };
}
