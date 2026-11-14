// What the Results pane's charts draw (new in 2.1, ROADMAP B1): a run's values station by station
// for one quantity (bars, with an interval whisker where the method gives one and a bar per
// customer class when there is more than one), and every current method's value for a quantity
// side by side (a dot and its interval per method, on one axis, the reference marked). Pure
// functions over the records and the shared model (src/results/insight.ts): the chart, its
// caption and its table are built from one list, so they cannot disagree.
import type { BarChartProps, BarRow, BarSeries, DotIntervalProps, DotRow, DotSeries, LegendItem } from "../../../charts";
import { seriesToken, SERIES_COUNT, TIER_STYLE } from "../../../charts";
import { interval, tierOf, TIER_ORDER, type Agreement, type QuantityAgreement, type Tier, type Verdict } from "../../../results/insight";
import { classLabel, type Measurement, type ResultRecord } from "../model";
import { resultsWords } from "../words";

const w = resultsWords.charts;

export interface MetricOption {
  key: string;
  metric: string;
  unit: string;
}

/** The quantity the charts open on (ROADMAP B1). */
export const DEFAULT_METRIC = "Mean number in system";

const metricKey = (metric: string, unit: string) => `${metric}|${unit}`;

function options(items: Iterable<{ metric: string; unit: string }>): MetricOption[] {
  const out = new Map<string, MetricOption>();
  for (const m of items) {
    const key = metricKey(m.metric, m.unit);
    if (!out.has(key)) out.set(key, { key, metric: m.metric, unit: m.unit });
  }
  return [...out.values()];
}

/** The option to show: the one asked for when the list has it, else "Mean number in system", else the first. */
export function pickMetric(list: readonly MetricOption[], asked: string | null): MetricOption | null {
  return list.find((o) => o.key === asked) ?? list.find((o) => o.metric === DEFAULT_METRIC) ?? list[0] ?? null;
}

const chartable = (m: Measurement) => Number.isFinite(m.estimate) && !!m.stationID;

/** The quantities a run reports per station, in the run's own order. */
export function runMetrics(run: ResultRecord): MetricOption[] {
  return options(run.measurements.filter(chartable));
}

/** True when a record can be charted at all: finished, with per-station numbers. */
export function chartableRun(run: ResultRecord): boolean {
  return (run.status === "completed" || run.status === "partial") && run.measurements.some(chartable);
}

export type RunChart = Omit<BarChartProps, "width" | "fontScale">;

/** One run's `option`, station by station; null when the run has no such values. */
export function runChart(run: ResultRecord, option: MetricOption, format: (v: number) => string, stale: boolean): RunChart | null {
  const ms = run.measurements.filter((m) => chartable(m) && m.metric === option.metric && m.unit === option.unit);
  if (!ms.length) return null;
  const tier = tierOf(run);
  const classes = [...new Set(ms.filter((m) => typeof m.customerClass === "number").map((m) => m.customerClass as number))].sort((a, b) => a - b);
  const byClass = classes.length > 1;
  const drawn = byClass ? classes.slice(0, SERIES_COUNT) : [];
  const series: BarSeries[] = byClass
    ? drawn.map((c, i) => ({ key: `class-${c}`, label: w.classSeries(classLabel(c)), color: seriesToken(i)!, hatched: i % 2 === 1 }))
    : [{ key: "value", label: run.method.shortName, color: TIER_STYLE[tier].color }];
  const rows = new Map<string, BarRow>();
  for (const m of ms) {
    const id = m.stationID as string;
    const row = rows.get(id) ?? { key: id, label: m.stationName, values: series.map(() => null) };
    rows.set(id, row);
    const whole = typeof m.customerClass !== "number";
    // One series: the all-classes value, or the only class's when the method gives no total.
    const at = byClass ? (whole ? -1 : drawn.indexOf(m.customerClass as number)) : whole || !row.values[0] ? 0 : -1;
    if (at >= 0 && (whole || byClass || !row.values[0])) row.values[at] = { value: m.estimate, interval: interval(m) };
  }
  const list = [...rows.values()].filter((r) => r.values.some((d) => d));
  if (!list.length) return null;
  let top: { label: string; value: number } | null = null;
  let intervals = false;
  for (const r of list) {
    for (const [j, d] of r.values.entries()) {
      if (!d) continue;
      if (d.interval) intervals = true;
      if (!top || d.value > top.value) top = { label: byClass ? `${r.label}, ${series[j].label}` : r.label, value: d.value };
    }
  }
  const drawnValues = list.flatMap((r) => r.values.filter((d) => d).map((d) => d!.value));
  const distinct = drawnValues.filter((x) => x === top?.value).length === 1 && drawnValues.length > 1;
  const unit = option.unit;
  const withUnit = (t: string) => (unit ? `${t} ${unit}` : t);
  const tierWord = w.tiers[tier];
  const caption =
    w.runCaption(option.metric, list.length, `${run.method.displayName} (${tierWord})`, top && distinct ? `${top.label} with ${withUnit(format(top.value))}` : null, intervals, byClass ? classes.length : 1, stale) +
    (byClass && classes.length > drawn.length ? ` ${w.classesCut(drawn.length, classes.length)}` : "");
  return {
    rows: list,
    series,
    title: w.runTitle(option.metric),
    subtitle: w.runSubtitle(run.method.displayName, tierWord, stale),
    axisLabel: w.metricOption(option.metric, unit),
    unit,
    rowTitle: w.station,
    format,
    caption,
  };
}

/** The quantities at least one current method reports per station. */
export function methodsMetrics(agreement: Agreement): MetricOption[] {
  return options(agreement.quantities.filter((q) => q.stationID));
}

const VERDICT_WORST: Verdict[] = ["disagree", "close", "agree"];

export type MethodsChart = Omit<DotIntervalProps, "width" | "fontScale">;

/** Every method's value for `option`, one row per station (and class); null when no method reports it. */
export function methodsChart(agreement: Agreement, option: MetricOption, format: (v: number) => string, percent: (fraction: number) => string): MethodsChart | null {
  const reported: QuantityAgreement[] = agreement.quantities.filter((q) => q.stationID && q.metric === option.metric && q.unit === option.unit);
  if (!reported.length) return null;
  // A class's own row earns its place when methods can be compared on it; a class value only one
  // method gives, beside the all-classes row every method gives, is left to that method's own chart.
  const perClass = reported.filter((q) => q.classLabel !== "All");
  const quantities = perClass.length < reported.length && !perClass.some((q) => q.values.length > 1) ? reported.filter((q) => q.classLabel === "All") : reported;
  const present = new Set(quantities.flatMap((q) => q.values.map((x) => x.runId)));
  const methods = agreement.methods.filter((m) => present.has(m.runId));
  const series: DotSeries[] = methods.map((m) => ({ key: m.runId, label: m.shortName, color: TIER_STYLE[m.tier].color, shape: TIER_STYLE[m.tier].shape }));
  const rows: DotRow[] = quantities.map((q) => ({
    key: q.key,
    label: w.rowWithClass(q.stationName, q.classLabel),
    values: q.values.map((x) => ({
      series: x.runId,
      value: x.estimate,
      interval: x.interval,
      reference: x.isReference,
      note: x.isReference || x.deviation === null ? undefined : x.withinInterval ? w.insideInterval : x.deviation === 0 ? w.sameAsReference : w.deviation(percent(x.deviation), x.deviation > 0),
    })),
  }));
  const tiers = TIER_ORDER.filter((t: Tier) => methods.some((m) => m.tier === t));
  const tierShort = (t: Tier) => w.tiers[t].replace(/ \(.*\)$/, "").toLowerCase();
  const references = [...new Set(quantities.map((q) => (q.reference ? `${q.reference.shortName} (${tierShort(q.reference.tier)})` : null)).filter((x): x is string => !!x))];
  const legend: LegendItem[] = [
    ...tiers.map((t): LegendItem => ({ key: t, label: w.tiers[t], color: TIER_STYLE[t].color, swatch: TIER_STYLE[t].shape })),
    ...(references.length ? [{ key: "reference", label: w.referenceLegend, color: "--text", swatch: "rule" } as LegendItem] : []),
  ];
  const compared = quantities.filter((q) => q.values.length > 1).map((q) => q.verdict);
  const verdict = VERDICT_WORST.find((x) => compared.includes(x)) ?? null;
  return {
    rows,
    series,
    legend,
    title: w.methodsTitle(option.metric),
    subtitle: w.methodsSubtitle(methods.length, references.length ? references.join(", ") : null),
    axisLabel: w.metricOption(option.metric, option.unit),
    unit: option.unit,
    rowTitle: w.quantity,
    format,
    referenceWord: w.reference,
    intervalWord: w.interval,
    caption: w.methodsCaption(option.metric, methods.length, new Set(quantities.map((q) => q.stationID)).size, verdict ? w.verdicts[verdict] : null),
  };
}
