// Run ▸ Transient… (new in 2.1, ROADMAP D4): the shapes `transient_prepare` and
// `transient_analyze` answer with (src-tauri/src/transient.rs; the arithmetic and its exact
// checks are core/src/transient.rs), the set-up as the view holds it, and what is read off an
// answer: peaks, the table, and the one-sentence reading. No queueing arithmetic is done here.
import type { TableAlternative } from "../charts";
import { about, pct, transientWords as w, type InitialKind } from "./words";

export interface TransientStation {
  id: string;
  name: string;
  servers: number;
  /** ρ. */
  utilisation: number | null;
  /** The long-run mean number L (customers), exact. */
  stationary: number | null;
  /** 1/(√(cμ) − √λ)², time units. */
  relaxation: number | null;
}

export interface TransientPrepare {
  exactReason: string | null;
  fluidReason: string | null;
  stations: TransientStation[];
  suggestedHorizon: number | null;
  /** The document's stored rate profiles (new in 2.1), when a source has one: the analysis follows them and takes no surge. */
  profile?: { sources: string[]; periodic: boolean; span: number } | null;
}

export interface ExactAnswer {
  /** `[station][time]`: lower bounds on the true means. */
  mean: number[][];
  /** Per station: the most the true mean exceeds the computed one at any time (a proven bound, customers), or null when none holds. */
  shortfall: (number | null)[];
  /** Per station: a settling time could not be certified (then `settling` is null). */
  uncertified: boolean[];
  empty: number[][];
  distance: number[];
  settling: (number | null)[];
  settleFrom: number;
  levels: number[];
  states: number;
  uniformisationRate: number;
  products: number;
  poissonBound: number;
  missingMass: number;
  stationaryTail: number;
}

export interface FluidAnswer {
  level: number[][];
  emptied: { station: number; time: number }[];
}

export interface TransientAnalysis {
  times: number[];
  stations: TransientStation[];
  exact: ExactAnswer | null;
  exactReason: string | null;
  fluid: FluidAnswer | null;
  fluidReason: string | null;
  stopped: boolean;
  /**
   * The pointwise stationary approximation (new in 2.1; core `transient::psa`), when the rates
   * change in time and the network is a Jackson network: `[station][time]`, null where the
   * network frozen at that time is overloaded. An approximation, never shown as exact.
   */
  psa?: (number | null)[][] | null;
  /** The times at which a stored rate profile changes, within the horizon. */
  profileBreaks?: number[];
  /** The stored profile repeats: the means cycle and never settle. */
  profilePeriodic?: boolean;
}

export interface SurgeRequest {
  factor: number;
  from: number;
  until: number;
}

export interface TransientRequest {
  id: string;
  document: unknown;
  horizon: number;
  intervals?: number;
  initial: { kind: InitialKind; numbers?: number[] };
  surge?: SurgeRequest | null;
  settleFraction: number;
}

export interface TransientProgress {
  fraction: number;
}

/** The set-up, as typed. */
export interface TransientSettings {
  initial: InitialKind;
  /** Station id → the number typed for "given". */
  numbers: Record<string, string>;
  /** Empty: the suggested horizon. */
  horizon: string;
  surge: boolean;
  factor: string;
  from: string;
  until: string;
  /** Percent. */
  band: string;
  mode: "chart" | "table";
  /** A station id, or null for all. */
  station: string | null;
}

export const DEFAULT_SETTINGS: TransientSettings = { initial: "empty", numbers: {}, horizon: "", surge: false, factor: "2", from: "", until: "", band: "5", mode: "chart", station: null };

const num = (text: string) => (text.trim() === "" ? NaN : Number(text.trim().replace(",", ".")));

/** The request for a set-up, or the sentence that says what is wrong with it. */
export function requestFor(settings: TransientSettings, prepare: TransientPrepare, document: unknown, id: string): { request: TransientRequest } | { problem: string } {
  const horizon = settings.horizon.trim() === "" ? (prepare.suggestedHorizon ?? NaN) : num(settings.horizon);
  if (!(horizon > 0) || !Number.isFinite(horizon)) return { problem: w.badHorizon };
  const band = num(settings.band);
  if (!(band > 0 && band < 100)) return { problem: w.badBand };
  let surge: SurgeRequest | null = null;
  // A stored rate profile is in force: a surge cannot be added on top of it (core `transient::validate`).
  if (settings.surge && !prepare.profile) {
    const [factor, from, until] = [num(settings.factor), num(settings.from), num(settings.until)];
    if (!(factor >= 0) || !Number.isFinite(factor)) return { problem: w.badFactor };
    if (!(from >= 0) || !(until > from) || !Number.isFinite(until)) return { problem: w.badSurge };
    if (from >= horizon) return { problem: w.surgeBeyond };
    surge = { factor, from, until };
  }
  let numbers: number[] | undefined;
  if (settings.initial === "given") {
    numbers = [];
    for (const s of prepare.stations) {
      const n = settings.numbers[s.id] === undefined || settings.numbers[s.id].trim() === "" ? 0 : num(settings.numbers[s.id]);
      if (!Number.isInteger(n) || n < 0 || n > 100000) return { problem: w.badNumber(s.name) };
      numbers.push(n);
    }
  }
  return { request: { id, document, horizon, intervals: 200, initial: { kind: settings.initial, numbers }, surge, settleFraction: band / 100 } };
}

/** The surge's ends suggested when the surge is switched on: from a tenth to three tenths of the horizon. */
export function suggestedSurge(horizon: number): { from: string; until: string } {
  return { from: about(horizon / 10), until: about(horizon * 0.3) };
}

/** The highest value of a curve and when (the first time it is reached). */
export function peak(times: readonly number[], values: readonly number[]): { value: number; time: number } {
  let k = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[k] * (1 + 1e-12) + 1e-300) k = i;
  return { value: values[k], time: times[k] };
}

/** The value of a curve at `t`, by linear interpolation on the grid. */
export function valueAt(times: readonly number[], values: readonly number[], t: number): number {
  if (t <= times[0]) return values[0];
  for (let k = 1; k < times.length; k++) {
    if (t <= times[k]) {
      const s = (t - times[k - 1]) / (times[k] - times[k - 1] || 1);
      return values[k - 1] + s * (values[k] - values[k - 1]);
    }
  }
  return values[values.length - 1];
}

/** The one-sentence reading of an answer. `format` writes a number of customers. */
export function reading(a: TransientAnalysis, request: TransientRequest, format: (x: number) => string): string {
  const band = pct(request.settleFraction);
  const horizon = a.times[a.times.length - 1];
  const start = w.initialPhrase[request.initial.kind];
  if (a.exact) {
    const e = a.exact;
    const rows = a.stations.map((s, i) => ({ s, i, settle: e.settling[i], l: s.stationary ?? NaN }));
    // A periodic rate profile: the mean never settles, it cycles. Say where it peaks.
    if (a.profilePeriodic) {
      const peaks = rows.map((r) => ({ r, ...peak(a.times, e.mean[r.i]) }));
      const top = peaks.reduce((x, y) => (y.value > x.value ? y : x));
      return w.profileCycles(top.r.s.name, format(top.value), about(top.time));
    }
    const unsure = rows.find((r) => e.uncertified[r.i]);
    if (unsure) return e.shortfall[unsure.i] === null ? w.uncertifiedUnbounded(unsure.s.name, band) : w.uncertifiedWide(unsure.s.name, band);
    const late = rows.find((r) => r.settle === null);
    if (late) return w.notSettledReading(late.s.name, band, format(late.l), about(horizon));
    // The slowest station tells the story.
    const slow = rows.reduce((x, y) => ((y.settle as number) > (x.settle as number) ? y : x));
    const took = (slow.settle as number) - e.settleFrom;
    const surged = request.surge && request.surge.from < horizon;
    if (surged) {
      if (!(took > 0)) return w.surgeNoMark(band);
      const p = peak(a.times, e.mean[slow.i]);
      return w.afterSurge(slow.s.name, format(p.value), about(p.time), about(took), band, format(slow.l));
    }
    if (!(took > 0)) return w.settledFromStart(start, band);
    return w.settles(start, slow.s.name, about(took), band, format(slow.l));
  }
  if (a.fluid) {
    const f = a.fluid;
    const peaks = a.stations.map((s, i) => ({ s, i, ...peak(a.times, f.level[i]) }));
    const top = peaks.reduce((x, y) => (y.value > x.value ? y : x));
    if (!(top.value > 0)) return w.fluidFlat;
    const last = f.level[top.i][a.times.length - 1];
    const stillRising = top.time >= horizon && !(request.surge && request.surge.until >= horizon && request.surge.factor > 1);
    if (stillRising && (top.s.utilisation ?? 0) >= 1) return w.fluidGrows(top.s.name, about((last - f.level[top.i][Math.max(0, a.times.length - 11)]) / (horizon - a.times[Math.max(0, a.times.length - 11)])));
    const emptied = f.emptied.filter((x) => x.station === top.i && x.time >= top.time).map((x) => x.time)[0];
    return w.fluidPeakReading(top.s.name, format(top.value), about(top.time), emptied !== undefined && last === 0 ? about(emptied) : null);
  }
  return "";
}

/** For scale: the slowest station's relaxation time, when known. */
export function relaxationReading(a: TransientAnalysis): string | null {
  const known = a.stations.filter((s) => s.relaxation !== null);
  if (!known.length) return null;
  const slow = known.reduce((x, y) => ((y.relaxation as number) > (x.relaxation as number) ? y : x));
  return w.relaxationReading(slow.name, about(slow.relaxation as number));
}

/** The grid indices a table or a read-out shows: about `rows` of them, evenly, with the last and any `keep` times. */
export function sampleIndices(times: readonly number[], rows: number, keep: readonly number[] = []): number[] {
  const n = times.length;
  const step = Math.max(1, Math.ceil((n - 1) / rows));
  const out = new Set<number>();
  for (let k = 0; k < n; k += step) out.add(k);
  out.add(n - 1);
  for (const t of keep) {
    const k = times.findIndex((x) => Math.abs(x - t) <= 1e-9 * Math.max(1, Math.abs(t)));
    if (k >= 0) out.add(k);
  }
  return [...out].sort((a, b) => a - b);
}

/** The curves as a table: time, then each shown station's exact mean, fluid level and P(empty), then the distance. */
export function transientTable(a: TransientAnalysis, shown: readonly number[], request: TransientRequest, format: (x: number) => string, rows = 40): TableAlternative {
  const keep = request.surge ? [request.surge.from, request.surge.until] : (a.profileBreaks ?? []);
  const idx = sampleIndices(a.times, rows, keep);
  const head = [w.colTime];
  for (const i of shown) {
    const name = a.stations[i].name;
    if (a.exact) head.push(w.colExact(name));
    if (a.psa) head.push(w.colPsa(name));
    if (a.fluid) head.push(w.colFluid(name));
    if (a.exact) head.push(w.colEmpty(name));
  }
  if (a.exact) head.push(w.colDistance);
  return {
    caption: w.tableCaption,
    head,
    rows: idx.map((k) => {
      const row = [about(a.times[k])];
      for (const i of shown) {
        if (a.exact) row.push(format(a.exact.mean[i][k]));
        if (a.psa) row.push(a.psa[i][k] === null ? w.psaNone : format(a.psa[i][k] as number));
        if (a.fluid) row.push(format(a.fluid.level[i][k]));
        if (a.exact) row.push(a.exact.empty[i][k].toFixed(4));
      }
      if (a.exact) row.push(a.exact.distance[k].toFixed(4));
      return row;
    }),
  };
}
