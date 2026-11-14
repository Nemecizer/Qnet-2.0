// What the Agreement view draws, as plain data (new in 2.1, ROADMAP B3): the verdict banner's
// sentences and, per quantity, each method's place on the shared deviation axis. Everything is
// read from `agreement()` (src/results/insight.ts); nothing here decides a verdict.
import { displayFixed } from "../../../editor/numbers";
import { AGREE, CLOSE, type Agreement, type MethodValue, type QuantityAgreement, type Verdict } from "../../../results/insight";
import { standardCompare } from "../model";
import { HEADLINE_METRICS } from "./plan";
import { agreementWords as w, pct, signedPct } from "./words";

/** The axis runs from −AXIS to +AXIS; a mark beyond it is clipped to an arrow at the edge. */
export const AXIS = 0.1;
/** Where the axis sits in its cell, in per cent of the width (the margins hold the arrows). */
export const AXIS_LEFT = 8;
export const AXIS_RIGHT = 92;
export const ARROW_LEFT = 3;
export const ARROW_RIGHT = 97;

/** The headline metrics, in the order a row group lists them; the rest follow by name. */
export { HEADLINE_METRICS };

/** A deviation's place on the axis in per cent of the cell's width, and whether it was clipped. */
export function axisPosition(deviation: number): { x: number; clipped: -1 | 0 | 1 } {
  if (deviation > AXIS) return { x: ARROW_RIGHT, clipped: 1 };
  if (deviation < -AXIS) return { x: ARROW_LEFT, clipped: -1 };
  return { x: AXIS_LEFT + ((deviation + AXIS) / (2 * AXIS)) * (AXIS_RIGHT - AXIS_LEFT), clipped: 0 };
}

export interface Mark {
  value: MethodValue;
  /** From the reference, or from the methods' mean when the quantity has no reference. ±∞ when `unscaled`. */
  deviation: number;
  /** The centre is zero and this value is not: there is no relative scale, so no figure is shown. */
  unscaled: boolean;
  x: number;
  clipped: -1 | 0 | 1;
  /** A vertical step that keeps marks at the same place apart: 0, −1, +1, −2… */
  lane: number;
  /** The method's own interval on the axis (per cent), when it gives one. */
  whisker: { x1: number; x2: number } | null;
}

export interface Row {
  q: QuantityAgreement;
  /** What the marks are measured from: the reference's estimate, else the mean of the methods that are scored. */
  centre: number;
  marks: Mark[];
  /** The reference simulation's interval on the axis (per cent), when it has one. */
  band: { x1: number; x2: number } | null;
  /** The scored mark farthest from the centre (a bound is never it). */
  worst: Mark | null;
  /** More than one method gives an estimate (bounds do not count), as `Agreement.compared` counts. */
  compared: boolean;
  /** With no reference and at most one estimate: the value the reference column shows instead. */
  lone: MethodValue | null;
  /** Why the reference cannot settle this row: a simulation whose interval is too wide, or that gives none. */
  uncertain: "wide" | "none" | null;
}

const relative = (x: number, centre: number) => (centre !== 0 ? (x - centre) / Math.abs(centre) : x === 0 ? 0 : x > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
const clampX = (deviation: number) => axisPosition(Math.max(-AXIS, Math.min(AXIS, deviation))).x;
const scoredOf = (q: QuantityAgreement) => q.values.filter((v) => !v.isBound);
/** More than one method gives an estimate for `q` (the model's own rule for `compared`). */
export const isCompared = (q: QuantityAgreement) => scoredOf(q).length > 1;

/** Why `q`'s simulation reference settles nothing, when it does not (a zero reference says so itself). */
export function uncertainty(q: QuantityAgreement): "wide" | "none" | null {
  if (!q.referenceUncertain || q.referenceZero || !isCompared(q)) return null;
  return q.reference?.interval ? "wide" : "none";
}

export function rowFor(q: QuantityAgreement): Row {
  const scored = scoredOf(q);
  const lone = !q.reference && scored.length <= 1 ? (scored[0] ?? q.values[0] ?? null) : null;
  const basis = scored.length ? scored : q.values;
  const centre = q.reference ? q.reference.estimate : basis.reduce((s, v) => s + v.estimate, 0) / basis.length;
  const span = (i: { low: number; high: number }) => ({ x1: clampX(relative(i.low, centre)), x2: clampX(relative(i.high, centre)) });
  const placed: number[] = [];
  const marks: Mark[] = q.values.filter((v) => v !== q.reference && v !== lone).map((value) => {
    const deviation = value.deviation ?? relative(value.estimate, centre);
    const { x, clipped } = axisPosition(deviation);
    const near = placed.filter((p) => Math.abs(p - x) < 2.5).length;
    placed.push(x);
    const lane = near === 0 ? 0 : (near % 2 ? -1 : 1) * Math.ceil(near / 2);
    return { value, deviation, unscaled: !Number.isFinite(deviation), x, clipped, lane, whisker: value.interval ? span(value.interval) : null };
  });
  const worst = marks.filter((m) => !m.value.isBound).reduce<Mark | null>((a, b) => (!a || Math.abs(b.deviation) > Math.abs(a.deviation) ? b : a), null);
  return { q, centre, marks, band: q.reference?.tier === "simulation" && q.reference.interval ? span(q.reference.interval) : null, worst, compared: scored.length > 1, lone, uncertain: uncertainty(q) };
}

/** A mark's deviation as words: none for a bound (it is not scored) or where there is no relative scale. */
export const deviationText = (m: Mark): string | null => (m.value.isBound || m.unscaled ? null : signedPct(m.deviation));

/** The plain labels a mark carries beside its value: "partial", "bound", "reference is zero". */
export function markNotes(m: Mark, q: QuantityAgreement): string[] {
  return [...(m.value.partial ? [w.partial] : []), ...(m.value.isBound ? [w.bound] : []), ...(m.unscaled && !m.value.isBound ? [q.reference ? w.referenceZero : w.meanZero] : [])];
}

export type RowSort = "station" | "disagreement";

const metricRank = (metric: string) => {
  const i = HEADLINE_METRICS.indexOf(metric);
  return i < 0 ? HEADLINE_METRICS.length : i;
};

export interface RowFilter {
  station: string | null;
  metric: string | null;
  /** Also the quantities only one method reports. */
  uncompared: boolean;
  sort: RowSort;
}

/** The rows to show, filtered and in order: by station with the headline metrics first, or the largest disagreement first. */
export function rowsFor(a: Agreement, f: RowFilter): Row[] {
  const anyCompared = a.quantities.some(isCompared);
  const rows = a.quantities
    .filter((q) => (f.station === null || q.stationName === f.station) && (f.metric === null || q.metric === f.metric))
    .filter((q) => f.uncompared || !anyCompared || isCompared(q))
    .map(rowFor);
  const byStation = (x: Row, y: Row) =>
    standardCompare(x.q.stationName, y.q.stationName) || metricRank(x.q.metric) - metricRank(y.q.metric) || standardCompare(x.q.metric, y.q.metric) || standardCompare(x.q.classLabel, y.q.classLabel);
  if (f.sort === "station") return rows.sort(byStation);
  const size = (r: Row) => (r.compared ? (r.q.worst ?? 0) : -1);
  return rows.sort((x, y) => size(y) - size(x) || byStation(x, y));
}

/** Rows in runs of one station, for the grouped table. */
export function groupByStation(rows: Row[]): { station: string; rows: Row[] }[] {
  const out: { station: string; rows: Row[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.station === r.q.stationName) last.rows.push(r);
    else out.push({ station: r.q.stationName, rows: [r] });
  }
  return out;
}

// ── The banner ────────────────────────────────────────────────────────────────────────────────

export type BannerKind = Verdict | "incomparable";

export interface Banner {
  kind: BannerKind;
  title: string;
  /** The evidence behind the title, one sentence each. */
  detail: string[];
  /** The quantity and method the evidence names, for a likely reason. */
  worst: { q: QuantityAgreement; value: MethodValue } | null;
  /** True when a reference (an exact result or a simulation) is missing and one should be run. */
  wantsReference: boolean;
}

const whereOf = (q: QuantityAgreement) => w.where(q.stationName || w.network, q.classLabel, q.metric);

/** The quantity with the largest gap among those more than one method reports, and the method farthest out. */
export function worstOf(a: Agreement, only: (q: QuantityAgreement) => boolean = () => true): { q: QuantityAgreement; value: MethodValue; deviation: number } | null {
  let best: { q: QuantityAgreement; value: MethodValue; deviation: number } | null = null;
  for (const q of a.quantities) {
    if (!isCompared(q) || !only(q)) continue;
    const row = rowFor(q);
    if (!row.worst) continue;
    // A value inside the simulation's interval is agreement, however large its relative gap.
    if (row.worst.value.withinInterval && q.verdict === "agree") continue;
    if (!best || Math.abs(row.worst.deviation) > Math.abs(best.deviation)) best = { q, value: row.worst.value, deviation: row.worst.deviation };
  }
  return best;
}

type Worst = { q: QuantityAgreement; value: MethodValue; deviation: number };
const valueText = (x: Worst, decimals: number) => `${displayFixed(x.value.estimate, decimals)}${x.q.unit ? ` ${x.q.unit}` : ""}`;

/** The record identifier of Exact Closed Product Form (core/src/results/model.rs), the one method of a closed network. */
const CLOSED_METHOD = "queue.closed-product-form";

/** The verdict in plain words, with the evidence behind it. */
export function bannerFor(a: Agreement, decimals: number): Banner | null {
  if (!a.methods.length) return null;
  const compared = a.quantities.filter(isCompared);
  const worst = worstOf(a);
  const others = (qs: QuantityAgreement[]) => new Set(qs.flatMap((q) => q.values.filter((v) => !v.isReference && !v.isBound).map((v) => v.method)));
  // A simulation reference too loose to settle a headline quantity is said once, up here.
  const tooWide = compared.some((q) => HEADLINE_METRICS.includes(q.metric) && uncertainty(q) === "wide") ? [w.referenceTooWide] : [];
  // A complete exact run (a partial one is never "exact": `hasExact` is the model's).
  const exactRun = a.hasExact ? a.quantities.flatMap((q) => q.values).find((v) => v.tier === "exact" && !v.partial) : undefined;
  const exactName = exactRun?.shortName ?? a.methods.find((m) => m.tier === "exact")?.shortName ?? "";
  let exactAside: string[] = [];
  if (a.hasExact) {
    if (a.methods.length === 1) return { kind: "exact", title: w.exactTitle(exactName), detail: [a.methods[0].method === CLOSED_METHOD ? w.exactAloneClosed : w.exactAlone], worst: null, wantsReference: false };
    // Exact, yet it shares no quantity with any other run: nothing was compared, so neither the
    // Exact title nor its styling is earned.
    if (a.compared === 0) return { kind: "incomparable", title: w.exactNothingShared(exactName), detail: [], worst: null, wantsReference: false };
    if (a.comparedWithExact > 0) {
      // The exact result is the answer on the quantities it reports; how the others do against it
      // there is the evidence line.
      const againstExact = (q: QuantityAgreement) => q.reference?.tier === "exact";
      const far = worstOf(a, againstExact);
      const gap = far ? Math.abs(far.deviation) : 0;
      const detail =
        far && !Number.isFinite(gap) ? [w.zeroDetail(far.value.shortName, valueText(far, decimals), whereOf(far.q))]
        : far && gap > CLOSE ? [w.exactOthersDiffer(far.value.shortName, pct(far.deviation), whereOf(far.q))]
        : far && gap > AGREE ? [w.exactOthersClose(far.value.shortName, pct(far.deviation), whereOf(far.q))]
        : [w.exactOthersAgree(others(compared.filter(againstExact)).size)];
      return { kind: "exact", title: w.exactTitle(exactName), detail, worst: far && gap > AGREE ? far : null, wantsReference: false };
    }
    // The others were compared among themselves and none with the exact run: their verdict
    // follows, with that said beside it.
    exactAside = [w.exactNotCompared(exactName)];
  }
  if (a.methods.length === 1) {
    const m = a.methods[0];
    return { kind: "single", title: w.singleTitle, detail: [w.singleDetail(m.shortName, w.tierShort[m.tier])], worst: null, wantsReference: false };
  }
  if (!compared.length) return { kind: "incomparable", title: w.nothingSharedTitle, detail: [], worst: null, wantsReference: false };
  const referenced = compared.filter((q) => q.reference);
  const hasReference = referenced.length > 0;
  const reference = w.theSimulation;
  const wantsReference = !hasReference && !a.hasExact;
  const tail = [...(wantsReference ? [w.noReferenceDetail] : []), ...tooWide, ...exactAside];
  const gapDetail = (x: Worst, worded: string) => (Number.isFinite(x.deviation) ? worded : w.zeroDetail(x.value.shortName, valueText(x, decimals), whereOf(x.q)));
  switch (a.verdict) {
    case "agree": {
      if (!hasReference) return { kind: "agree", title: w.agreeNoReference(others(compared).size), detail: tail, worst: null, wantsReference };
      const byInterval = referenced.some((q) => q.values.some((v) => !v.isReference && v.withinInterval && Math.abs(v.deviation ?? 0) > AGREE));
      return { kind: "agree", title: w.agreeTitle(others(referenced).size, reference, byInterval), detail: tail, worst: null, wantsReference };
    }
    case "close":
      return {
        kind: "close",
        title: hasReference ? w.closeTitle(reference) : w.closeNoReference,
        detail: [...(worst ? [gapDetail(worst, w.closeDetail(worst.value.shortName, pct(worst.deviation), whereOf(worst.q)))] : []), ...tail],
        worst,
        wantsReference,
      };
    case "disagree": {
      if (!worst) return { kind: "disagree", title: w.nothingSharedTitle, detail: tail, worst: null, wantsReference };
      const xs = worst.q.values.filter((v) => !v.isBound).map((v) => v.estimate);
      const title = w.disagreeTitle(whereOf(worst.q), displayFixed(Math.min(...xs), decimals), displayFixed(Math.max(...xs), decimals), worst.q.unit);
      const detail = worst.q.reference ? [gapDetail(worst, w.disagreeDetail(worst.value.shortName, signedPct(worst.deviation), `${reference} (${worst.q.reference.shortName})`))] : [];
      return { kind: "disagree", title, detail: [...detail, ...tail], worst, wantsReference };
    }
    default:
      return { kind: "incomparable", title: w.nothingSharedTitle, detail: tail, worst: null, wantsReference };
  }
}
