// What the Sweep view draws from a saved sweep (new in 2.1, ROADMAP B4): the measures and
// stations it can show, the line chart of one of each (a line per method, coloured by tier, with
// an interval band where the method gives one, a gap where a point has no value, a rule at the
// parameter's current value and a dashed one where the network becomes overloaded), the table of
// the same numbers, and the CSV. Pure functions over the result: the chart, its caption, the
// table and the CSV are built from one list (`sweepSeries`), so they cannot disagree.
import type { LineChartProps, LineRule, LineSeries } from "../charts";
import { SERIES_SHAPES, TIER_STYLE, type MarkShape } from "../charts";
import { standardCompare } from "../panes/results/model";
import { STATION_METRICS } from "../results/insight";
import { valueText } from "./model";
import type { GapReason, SweepCell, SweepMeasurement, SweepResult } from "./store";
import { sweepWords as w } from "./words";

export interface MetricOption {
  key: string;
  metric: string;
  unit: string;
}
export interface StationOption {
  key: string;
  label: string;
  stationId: string | null;
  customerClass: number | null;
}

const metricKey = (m: Pick<SweepMeasurement, "k" | "u">) => `${m.k}|${m.u}`;
const stationKey = (m: Pick<SweepMeasurement, "s" | "n" | "c">) => `${m.s ?? `name:${m.n}`}|${m.c ?? ""}`;

function* measurements(result: SweepResult): Generator<SweepMeasurement> {
  for (const row of result.cells) for (const cell of row) if (cell.ok) yield* cell.m;
}

/** The measures some point of the sweep reports, the usual per-station ones first. */
export function metricOptions(result: SweepResult): MetricOption[] {
  const out = new Map<string, MetricOption>();
  for (const m of measurements(result)) if (!out.has(metricKey(m))) out.set(metricKey(m), { key: metricKey(m), metric: m.k, unit: m.u });
  const rank = (o: MetricOption) => {
    const i = (STATION_METRICS as readonly string[]).indexOf(o.metric);
    return i < 0 ? STATION_METRICS.length : i;
  };
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || standardCompare(a.metric, b.metric));
}

/** The stations (and classes) that report `metric`, in name order, a station's all-classes value first. */
export function stationOptions(result: SweepResult, metric: MetricOption | null): StationOption[] {
  const out = new Map<string, StationOption>();
  for (const m of measurements(result)) {
    if (metric && metricKey(m) !== metric.key) continue;
    const key = stationKey(m);
    if (!out.has(key)) out.set(key, { key, label: m.c === null ? m.n || w.wholeNetwork : w.stationWithClass(m.n, m.c + 1), stationId: m.s, customerClass: m.c });
  }
  return [...out.values()].sort((a, b) => standardCompare(a.label, b.label));
}

/** The measure to show: the one asked for, else the sweep's own, else "Mean number in system", else the first. */
export function pickMetric(result: SweepResult, asked: string | null): MetricOption | null {
  const list = metricOptions(result);
  return list.find((o) => o.key === asked) ?? list.find((o) => o.metric === result.metric) ?? list.find((o) => o.metric === "Mean number in system") ?? list[0] ?? null;
}

/** The station to show: the one asked for, else the sweep's own (all classes), else the first. */
export function pickStation(result: SweepResult, metric: MetricOption | null, asked: string | null): StationOption | null {
  const list = stationOptions(result, metric);
  return list.find((o) => o.key === asked) ?? list.find((o) => o.stationId === result.stationId && o.customerClass === null) ?? list.find((o) => o.stationId === result.stationId) ?? list[0] ?? null;
}

export interface SweepPoint {
  x: number;
  /** The value, or null where there is none (`reason` says why). */
  y: number | null;
  low: number | null;
  high: number | null;
  reason: GapReason | "missing" | null;
  sentence: string | null;
}
export interface SweepSeries {
  key: string;
  label: string;
  name: string;
  tier: SweepResult["methods"][number]["tier"];
  points: SweepPoint[];
}

function pointOf(cell: SweepCell, x: number, method: string, metric: MetricOption, station: StationOption): SweepPoint {
  if (!cell.ok) return { x, y: null, low: null, high: null, reason: cell.reason, sentence: cell.sentence };
  const m = cell.m.find((q) => metricKey(q) === metric.key && stationKey(q) === station.key);
  if (!m) return { x, y: null, low: null, high: null, reason: "missing", sentence: w.missingSentence(method, metric.metric, station.label) };
  return { x, y: m.v, low: m.lo ?? null, high: m.hi ?? null, reason: null, sentence: null };
}

/** One series per method for the measure and station: every point of the sweep, with its value or the reason it has none. */
export function sweepSeries(result: SweepResult, metric: MetricOption, station: StationOption): SweepSeries[] {
  return result.methods.map((method, j) => ({
    key: method.label,
    label: method.shortName,
    name: method.name,
    tier: method.tier,
    points: result.values.map((x, i) => pointOf(result.cells[j][i], x, method.shortName, metric, station)),
  }));
}

export type SweepChart = Omit<LineChartProps, "width" | "fontScale">;

/**
 * The chart of `metric` at `station`; null when no method has a value for it. `current` is the
 * parameter's value in the network now (null when the network no longer has the parameter).
 */
export function sweepChart(result: SweepResult, metric: MetricOption, station: StationOption, format: (v: number) => string, current: number | null): SweepChart | null {
  const all = sweepSeries(result, metric, station);
  const drawn = all.filter((sr) => sr.points.some((p) => p.y !== null));
  if (!drawn.length) return null;
  // The first method of a tier draws the tier's own marker; another method of the same tier shares
  // its colour, so it takes a marker no tier in the chart uses.
  const reserved = drawn.map((sr) => TIER_STYLE[sr.tier].shape);
  const used: MarkShape[] = [];
  const shapes = drawn.map((sr, i) => {
    const first = drawn.findIndex((o) => o.tier === sr.tier) === i;
    const shape = first ? TIER_STYLE[sr.tier].shape : (SERIES_SHAPES.find((sh) => !reserved.includes(sh) && !used.includes(sh)) ?? "ring");
    used.push(shape);
    return shape;
  });
  const series: LineSeries[] = drawn.map((sr, i) => ({
    key: sr.key,
    label: drawn.length > 1 ? `${sr.label} · ${w.tierShort[sr.tier]}` : sr.label,
    color: TIER_STYLE[sr.tier].color,
    shape: shapes[i],
    // A point without a value breaks the line: nothing is drawn across what was not computed.
    points: sr.points.map((p) => (p.y !== null ? { x: p.x, y: p.y, low: p.low, high: p.high } : { x: p.x, y: Number.NaN, gap: true })),
  }));
  const rules: LineRule[] = [];
  if (current !== null) rules.push({ x: current, label: w.rules.current, tone: "current" });
  for (const l of result.limits) rules.push({ x: l.x, label: l.unstable === "above" ? w.rules.limit : w.rules.limitBelow, tone: "limit", side: l.unstable === "above" ? "right" : "left" });
  const best = drawn[0];
  const values = best.points.filter((p) => p.y !== null);
  const [first, last] = [values[0], values[values.length - 1]];
  const unit = metric.unit;
  const withUnit = (t: string) => (unit ? `${t} ${unit}` : t);
  const trend = !first || first === last ? null : format(first.y!) === format(last.y!) ? w.trendFlat(best.label, withUnit(format(first.y!))) : w.trend(best.label, format(first.y!), withUnit(format(last.y!)), last.y! > first.y!);
  const gaps = result.values.filter((_x, i) => drawn.some((sr) => sr.points[i].y === null)).length;
  const limit = result.limits[0] ? w.limitSentence(valueText(roundSig(result.limits[0].x, 4)), result.limits[0].unstable === "above") : null;
  const intervals = drawn.some((sr) => sr.points.some((p) => p.low !== null));
  return {
    series,
    rules,
    title: w.title(metric.metric, station.label, result.parameter.axis),
    subtitle: w.subtitle(result.title, drawn.length, result.values.length),
    xLabel: w.axisWithUnit(result.parameter.axis, result.parameter.unit),
    yLabel: w.axisWithUnit(metric.metric, unit),
    unit,
    formatX: valueText,
    formatY: format,
    intervalWord: intervals ? w.interval : undefined,
    caption: w.caption(metric.metric, station.label, result.parameter.axis, valueText(result.from), valueText(result.to), drawn.map((sr) => `${sr.name} (${w.tierShort[sr.tier]})`), trend, gaps, limit),
  };
}

const roundSig = (x: number, digits: number) => Number(x.toPrecision(digits));

export interface SweepTable {
  caption: string;
  /** The parameter's column, then one per method. */
  head: string[];
  rows: { x: number; label: string; cells: { text: string; reason: string | null; sentence: string | null }[] }[];
}

/** The same numbers as the chart, a row per point, every method a column (a method with no value at all included). */
export function sweepTable(result: SweepResult, metric: MetricOption, station: StationOption, format: (v: number) => string): SweepTable {
  const series = sweepSeries(result, metric, station);
  const unit = metric.unit;
  return {
    caption: w.tableCaption(metric.metric, station.label),
    head: [w.axisWithUnit(result.parameter.axis, result.parameter.unit), ...series.map((sr) => w.axisWithUnit(sr.label, unit))],
    rows: result.values.map((x, i) => ({
      x,
      label: valueText(x),
      cells: series.map((sr) => {
        const p = sr.points[i];
        if (p.y === null) return { text: "—", reason: w.gapReasons[p.reason ?? "missing"], sentence: p.sentence };
        return { text: `${format(p.y)}${p.low !== null && p.high !== null ? ` (${format(p.low)} to ${format(p.high)})` : ""}`, reason: null, sentence: null };
      }),
    })),
  };
}

const csvField = (text: string) => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
/** A number as CSV carries it: every digit, no grouping, whatever the display precision. */
const csvNumber = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? String(x) : "");

/**
 * The sweep as CSV, one row per point, method and measurement: the parameter's value, the method
 * and its tier, the station, class, measure, unit, estimate and interval; a point without a value
 * is a row with the reason in Note. With `only`, just that measure at that station (what the chart
 * shows); without, everything the sweep kept.
 */
export function sweepCsv(result: SweepResult, only?: { metric: MetricOption; station: StationOption }): string {
  const h = w.csvHead;
  const lines = [[w.axisWithUnit(result.parameter.axis, result.parameter.unit), h.method, h.tier, h.station, h.cls, h.measure, h.unit, h.estimate, h.low, h.high, h.note]];
  for (const [i, x] of result.values.entries()) {
    for (const [j, method] of result.methods.entries()) {
      const cell = result.cells[j][i];
      const lead = [csvNumber(x), method.shortName, w.tiers[method.tier]];
      if (!cell.ok) {
        lines.push([...lead, only?.station.label ?? "", "", only?.metric.metric ?? "", only?.metric.unit ?? "", "", "", "", `${w.gapReasons[cell.reason]}: ${cell.sentence}`]);
        continue;
      }
      const ms = only ? cell.m.filter((m) => metricKey(m) === only.metric.key && stationKey(m) === only.station.key) : cell.m;
      if (only && !ms.length) lines.push([...lead, only.station.label, "", only.metric.metric, only.metric.unit, "", "", "", `${w.gapReasons.missing}: ${w.missingSentence(method.shortName, only.metric.metric, only.station.label)}`]);
      for (const m of ms) lines.push([...lead, m.n, m.c === null ? "" : String(m.c + 1), m.k, m.u, csvNumber(m.v), csvNumber(m.lo), csvNumber(m.hi), ""]);
    }
  }
  return `${lines.map((l) => l.map(csvField).join(",")).join("\n")}\n`;
}

/** The methods that gave nothing at all, each with why (the view lists them under the chart). */
export function methodNotes(result: SweepResult): { method: string; sentence: string }[] {
  return result.methods
    .map((method, j) => ({ method, row: result.cells[j] }))
    .filter(({ row }) => !row.some((c) => c.ok))
    .map(({ method, row }) => {
      const why = row.find((c) => !c.ok && (c.reason === "refused" || c.reason === "failed")) ?? row.find((c) => !c.ok);
      return { method: method.name, sentence: why && !why.ok ? why.sentence : "" };
    });
}
