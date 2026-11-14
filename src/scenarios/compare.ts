// Compare Scenarios as numbers (new in 2.1, ROADMAP E1): one row per measure, one column per
// variant (the baseline first). Pure: the panel hands in, for each variant, its plain network, its
// best current run and its live answer; nothing here runs or computes a queue.
//
// A cell is read from the variant's run when it has one that reports the measure
// (`readMeasure`, the reading Sensitivity uses: src/sensitivity/model.ts); failing that, from the
// live closed form when that is exact (Rust's `live_results`). Every cell says which, by tier, and
// a row whose cells are not all of one tier says so: a difference between an exact value and an
// approximation may be the method's, not the scenario's.
import type { BarRow, BarSeries } from "../charts";
import { displayFixed } from "../editor/numbers";
import { inExportOrder } from "../editor/naming";
import type { BnetDocument } from "../lib/bnet";
import type { LiveResults } from "../live/model";
import type { ResultRecord } from "../panes/results/model";
import { tierOf, type Tier } from "../results/insight";
import { readMeasure, totalArrivals, type MeasureChoice } from "../sensitivity/model";
import { discoverParameters } from "../sweeps/model";
import { scenarioWords as w } from "./words";

export type MeasureKind = "networkNumber" | "networkDelay" | "throughput" | "utilisation" | "queue";

export interface Variant {
  /** Null for the baseline. */
  id: string | null;
  name: string;
  /** The variant as one plain network (./model.ts `scenarioDocument`). */
  doc: BnetDocument;
  /** How many values it changes; null for the baseline. */
  overrides: number | null;
  /** Its best current run (src/results/insight.ts `bestRun` of `currentRuns`), if any. */
  run: ResultRecord | null;
  /** Its live answer, if asked and given. */
  live: LiveResults | null;
}

export interface Cell {
  value: number | null;
  tier: Tier | null;
  /** Where the value is from: a recorded run, or the closed formula computed now. */
  source: "run" | "live" | null;
  /** The run's method, by its short name. */
  method: string | null;
  /** value − baseline's, and that over |baseline's|; null for the baseline's own cell or where either is missing. */
  diff: number | null;
  pct: number | null;
}

export interface Row {
  key: string;
  kind: MeasureKind;
  stationId: string | null;
  /** "Network" or the station's name. */
  group: string;
  label: string;
  unit: "customers" | "time" | "rate" | "ratio";
  cells: Cell[];
  /** The tiers present, when more than one: the row mixes kinds of method. */
  mixed: Tier[] | null;
}

export interface CompareTable {
  variants: Variant[];
  rows: Row[];
  mixedRows: number;
}

const UNIT: Record<MeasureKind, Row["unit"]> = { networkNumber: "customers", networkDelay: "time", throughput: "rate", utilisation: "ratio", queue: "customers" };
const up = (s: string) => s.toUpperCase();

const choice = (kind: MeasureChoice["kind"], stationId: string | null): MeasureChoice => ({ key: kind, kind, stationId, label: "", noun: "", unit: "", time: false });

/** The measure in a variant's run, or null when the run does not give it. */
function fromRun(kind: MeasureKind, stationId: string | null, v: Variant): number | null {
  const run = v.run;
  if (!run) return null;
  switch (kind) {
    case "networkNumber": return readMeasure(run, choice("networkNumber", null), v.doc);
    case "networkDelay": return readMeasure(run, choice("networkSojourn", null), v.doc);
    case "throughput": {
      // What flows through an open network in steady state is what arrives (nothing is lost with
      // infinite buffers), so it is offered wherever the run gives the delay that rests on it.
      if (readMeasure(run, choice("networkSojourn", null), v.doc) === null) return null;
      return totalArrivals(v.doc, discoverParameters(v.doc));
    }
    case "utilisation": return readMeasure(run, choice("stationUtilisation", stationId), v.doc);
    case "queue": return readMeasure(run, choice("stationQueue", stationId), v.doc);
  }
}

/** The measure in a variant's live answer, only when that answer is exact. */
function fromLive(kind: MeasureKind, stationId: string | null, v: Variant): number | null {
  const r = v.live;
  if (!r || r.tier !== "exact") return null;
  const finite = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  if (stationId === null) {
    if (!r.network) return null;
    return finite(kind === "networkNumber" ? r.network.meanNumber : kind === "networkDelay" ? r.network.meanDelay : r.network.throughput);
  }
  const s = r.perStation.find((x) => up(x.stationId) === up(stationId));
  return s ? finite(kind === "utilisation" ? s.utilisation : s.meanWaiting) : null;
}

function cellFor(kind: MeasureKind, stationId: string | null, v: Variant): Cell {
  const ran = fromRun(kind, stationId, v);
  if (ran !== null && v.run) return { value: ran, tier: tierOf(v.run), source: "run", method: v.run.method.shortName, diff: null, pct: null };
  const live = fromLive(kind, stationId, v);
  if (live !== null) return { value: live, tier: "exact", source: "live", method: null, diff: null, pct: null };
  return { value: null, tier: null, source: null, method: null, diff: null, pct: null };
}

/** The table: the network's three measures, then each station's utilisation and queue length, in export order. */
export function compareTable(variants: readonly Variant[]): CompareTable {
  const base = variants[0]?.doc;
  if (!base) return { variants: [], rows: [], mixedRows: 0 };
  const stations = inExportOrder(base.nodes.filter((n) => n.kind === "station"), (n) => n.name);
  const specs: { kind: MeasureKind; stationId: string | null; group: string; label: string }[] = [
    { kind: "networkNumber", stationId: null, group: w.groupNetwork, label: w.measures.networkNumber },
    { kind: "networkDelay", stationId: null, group: w.groupNetwork, label: w.measures.networkDelay },
    { kind: "throughput", stationId: null, group: w.groupNetwork, label: w.measures.throughput },
    ...stations.flatMap((s) => [
      { kind: "utilisation" as const, stationId: s.id, group: s.name, label: w.measures.utilisation },
      { kind: "queue" as const, stationId: s.id, group: s.name, label: w.measures.queue },
    ]),
  ];
  const rows = specs.map((spec): Row => {
    const cells = variants.map((v) => cellFor(spec.kind, spec.stationId, v));
    const ref = cells[0]?.value ?? null;
    cells.forEach((c, i) => {
      if (i === 0 || c.value === null || ref === null) return;
      // Two routes to one number differ in the last bits: that is no difference.
      const d = c.value - ref;
      c.diff = Math.abs(d) <= 1e-9 * Math.max(1, Math.abs(ref)) ? 0 : d;
      c.pct = Math.abs(ref) > 1e-12 ? c.diff / Math.abs(ref) : null;
    });
    const tiers = [...new Set(cells.map((c) => c.tier).filter((t): t is Tier => t !== null))];
    return { key: spec.stationId === null ? spec.kind : `${spec.kind}:${spec.stationId}`, ...spec, unit: UNIT[spec.kind], cells, mixed: tiers.length > 1 ? tiers : null };
  });
  return { variants: [...variants], rows, mixedRows: rows.filter((r) => r.mixed).length };
}

// ── As text ─────────────────────────────────────────────────────────────────────────────────────

/** "4.667", or "70.0" for a ratio (shown as a percentage). */
export function valueText(value: number, unit: Row["unit"], decimals: number): string {
  const d = Math.min(Math.max(decimals, 0), 6);
  return unit === "ratio" ? displayFixed(value * 100, Math.max(1, d - 2)) : displayFixed(value, d);
}

export const unitLabel = (unit: Row["unit"]) => w.units[unit];

const sign = (x: number, text: string) => `${x < 0 ? "−" : "+"}${text.replace(/^-/, "")}`;

/** "+0.667 (+16.7 %)": the difference from the baseline, absolute and relative. */
export function diffText(cell: Cell, unit: Row["unit"], decimals: number): string | null {
  if (cell.diff === null) return null;
  if (cell.diff === 0) return w.sameAsBaseline;
  const abs = sign(cell.diff, valueText(Math.abs(cell.diff), unit, decimals)) + (unit === "ratio" ? " pts" : "");
  const pct = cell.pct === null ? null : `${sign(cell.pct, displayFixed(Math.abs(cell.pct) * 100, 1))} %`;
  return w.vsBaseline(abs, pct);
}

export const tierLabel = (cell: Cell) => (cell.tier === null ? "" : cell.source === "live" ? w.liveTier : w.tiers[cell.tier]);

export const rowLabel = (row: Row) => (row.stationId === null ? row.label : w.stationMeasure(row.group, row.label));

const csvField = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The table as CSV: per scenario its value, tier, source and the difference from the baseline (absolute, and in %). Full precision. */
export function compareCsv(table: CompareTable): string {
  const h = w.csvHead;
  const head = [h.measure, h.unit, ...table.variants.flatMap((v, i) => [`${v.name} ${h.value}`, `${v.name} ${h.tier}`, `${v.name} ${h.source}`, ...(i === 0 ? [] : [`${v.name} ${h.diff}`, `${v.name} ${h.pct}`])])];
  const num = (x: number | null) => (x === null ? "" : String(Number(x.toPrecision(12))));
  const lines = table.rows.map((r) => [
    rowLabel(r),
    r.unit === "ratio" ? "ratio" : unitLabel(r.unit),
    ...r.cells.flatMap((c, i) => [num(c.value), tierLabel(c), c.source === "run" ? c.method ?? "" : c.source === "live" ? w.sourceLive : "", ...(i === 0 ? [] : [num(c.diff), num(c.pct === null ? null : c.pct * 100)])]),
  ]);
  return [head, ...lines].map((l) => l.map(csvField).join(",")).join("\n") + "\n";
}

// ── As a chart ──────────────────────────────────────────────────────────────────────────────────

export const CHART_MEASURES: MeasureKind[] = ["networkDelay", "networkNumber", "throughput", "utilisation", "queue"];

export interface CompareChart {
  rows: BarRow[];
  series: BarSeries[];
  title: string;
  axisLabel: string;
  unit: string;
  rowTitle: string;
  caption: string;
  format: (value: number) => string;
}

/** Grouped bars of one measure: a group per station (or one for the network), a bar per scenario. Null when no bar could be drawn. */
export function compareChart(table: CompareTable, kind: MeasureKind, decimals: number): CompareChart | null {
  const rows = table.rows.filter((r) => r.kind === kind);
  if (!rows.length || !rows.some((r) => r.cells.some((c) => c.value !== null))) return null;
  const unit = rows[0].unit;
  const scale = unit === "ratio" ? 100 : 1;
  const measure = w.measures[kind];
  return {
    rows: rows.map((r) => ({ key: r.key, label: r.stationId === null ? w.chartNetworkRow : r.group, values: r.cells.map((c) => (c.value === null ? null : { value: c.value * scale })) })),
    series: table.variants.map((v, i) => ({ key: v.id ?? "baseline", label: v.name, color: `--series-${(i % 8) + 1}`, hatched: i % 2 === 1 })),
    title: w.chartTitle(measure),
    axisLabel: `${measure} (${unitLabel(unit)})`,
    unit: unitLabel(unit),
    rowTitle: rows[0].stationId === null ? w.groupNetwork : w.chartRowTitle,
    caption: w.chartCaption(measure, table.variants.map((v) => v.name), rows.some((r) => r.mixed)),
    format: (x) => displayFixed(x, unit === "ratio" ? Math.max(1, Math.min(decimals, 6) - 2) : Math.min(decimals, 6)),
  };
}
