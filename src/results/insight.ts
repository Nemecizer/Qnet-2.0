// What a tab's runs say when read together (new in 2.1, ROADMAP Phase B): which run is the best
// evidence for each quantity, how far the other methods are from it, and a plain verdict. Pure
// functions over the records the Results pane already holds; the charts, the canvas overlay and
// the agreement view all read from here, so they can never disagree with each other.
//
// Only like is compared with like: two measurements are the same quantity when station, class,
// metric and unit match (`comparisonKey`). An SRBM method's "Mean workload" is never set against a
// queueing method's "Mean number in system".
import { sameNetwork } from "./current";
import { classLabel, comparisonKey, standardCompare, type Measurement, type ResultRecord } from "../panes/results/model";

/** How much a method's number is worth as evidence, best first. */
export type Tier = "exact" | "simulation" | "approximation" | "diffusion" | "bound" | "mixed";
export const TIER_ORDER: Tier[] = ["exact", "simulation", "approximation", "diffusion", "bound", "mixed"];

/** A record's tier, from the fidelity its method declares (`ResultFidelity`'s raw values). */
export function tierOf(run: ResultRecord): Tier {
  switch (run.method.fidelity) {
    case "Exact queueing result": return "exact";
    case "Queue simulation": return "simulation";
    case "Queueing approximation": return "approximation";
    case "SRBM numerical result":
    case "SRBM simulation": return "diffusion";
    case "SRBM bound relaxation": return "bound";
    default: return "mixed";
  }
}

/**
 * The runs worth reading for the network as it is now: completed (or partial), made from this
 * fingerprint, one per method — the newest. Sweeps and the mixed comparison record are left out:
 * their measurements belong to several methods at once.
 */
export function currentRuns(records: readonly ResultRecord[], fingerprint: string | null): ResultRecord[] {
  const newest = new Map<string, ResultRecord>();
  for (const r of records) {
    if (r.status !== "completed" && r.status !== "partial") continue;
    if (fingerprint !== null && !sameNetwork(r, fingerprint)) continue;
    if (tierOf(r) === "mixed" || !r.measurements.length) continue;
    const held = newest.get(r.method.identifier);
    if (!held || (r.completedAt ?? r.startedAt) > (held.completedAt ?? held.startedAt)) newest.set(r.method.identifier, r);
  }
  return [...newest.values()].sort((a, b) => TIER_ORDER.indexOf(tierOf(a)) - TIER_ORDER.indexOf(tierOf(b)) || standardCompare(a.method.shortName, b.method.shortName));
}

/**
 * The 95 % (or stated) interval of a measurement, when its method gives one: the stated bounds,
 * else the estimate ± z standard errors for the levels whose z is tabled below. A standard error
 * stated with any other level gives no interval (ledger WF-509): ±1.96 standard errors would be
 * a 95 % interval shown under another level. cli/src/api.rs `interval` is the same rule.
 */
export function interval(m: Measurement): { low: number; high: number } | null {
  const u = m.uncertainty;
  if (!u) return null;
  if (typeof u.lowerBound === "number" && typeof u.upperBound === "number") return { low: u.lowerBound, high: u.upperBound };
  if (typeof u.standardError === "number") {
    const z = zFor(u.confidenceLevel);
    return z === null ? null : { low: m.estimate - z * u.standardError, high: m.estimate + z * u.standardError };
  }
  return null;
}

/** The normal quantile for a two-sided level (0.95 when none is stated); null for a level not tabled. */
export function zFor(level: number | null | undefined): number | null {
  if (level === undefined || level === null) return 1.96;
  for (const [l, z] of [[0.9, 1.645], [0.95, 1.96], [0.99, 2.576]]) if (Math.abs(level - l) < 1e-9) return z;
  return null;
}

/** Two values this close are the same number (a reference of exactly zero has no relative scale). */
export const ZERO = 1e-9;

export type Verdict = "exact" | "agree" | "close" | "disagree" | "single";
/** Worst first, for taking the worst of several. */
const VERDICT_RANK: Verdict[] = ["disagree", "close", "agree", "exact", "single"];

/** Relative differences up to this are "agree", up to `CLOSE` "close", beyond it "disagree". */
export const AGREE = 0.02;
export const CLOSE = 0.1;

export interface MethodValue {
  runId: string;
  method: string;
  shortName: string;
  tier: Tier;
  estimate: number;
  interval: { low: number; high: number } | null;
  /** (estimate − reference) / |reference|; null for the reference itself or when there is none. */
  deviation: number | null;
  /** Inside the reference's interval (when the reference is a simulation with one). */
  withinInterval: boolean;
  isReference: boolean;
  /** From a run that ended early: shown, but never the reference and never "exact". */
  partial: boolean;
  /** A bound, not an estimate: listed, but not scored against the reference. */
  isBound: boolean;
}

export interface QuantityAgreement {
  key: string;
  stationID: string | null;
  stationName: string;
  classLabel: string;
  metric: string;
  unit: string;
  /** What the others are measured against: an exact result, else the tightest simulation, else none. */
  reference: MethodValue | null;
  values: MethodValue[];
  /** The largest |deviation| among non-reference values; with no reference, the spread over the mean. */
  worst: number | null;
  verdict: Verdict;
  /** The reference is a simulation whose interval is too wide to settle anything (half-width over `CLOSE`). */
  referenceUncertain: boolean;
  /** The reference is zero: differences are judged absolutely, and `deviation` is null. */
  referenceZero: boolean;
}

export interface Agreement {
  quantities: QuantityAgreement[];
  /** The worst verdict over the quantities that more than one method reports. */
  verdict: Verdict;
  /** The methods read, best tier first. */
  methods: { runId: string; method: string; shortName: string; tier: Tier }[];
  /** True when some complete run gives an exact result for this network. */
  hasExact: boolean;
  /** How many quantities have an exact reference AND at least one other method to hold against it. */
  comparedWithExact: number;
  /** How many quantities more than one method reports. Zero: nothing was compared, whatever ran. */
  compared: number;
}

function verdictFor(worst: number | null, scored: MethodValue[], reference: MethodValue | null): Verdict {
  const others = scored.filter((v) => !v.isReference);
  if (!others.length || (!reference && scored.length < 2)) return reference?.tier === "exact" ? "exact" : "single";
  // Inside a simulation's interval is agreement whatever the relative difference (a small mean
  // would otherwise read as disagreement) — `withinInterval` is only ever set when that interval
  // is tight enough to mean something.
  if (reference && others.every((v) => v.withinInterval || (v.deviation !== null && Math.abs(v.deviation) <= AGREE))) return "agree";
  if (worst === null) return "single";
  return worst <= AGREE ? "agree" : worst <= CLOSE ? "close" : "disagree";
}

/** Every quantity the runs report, each with its reference, the other methods' distance from it and a verdict. */
export function agreement(runs: readonly ResultRecord[]): Agreement {
  const byKey = new Map<string, { m: Measurement; values: MethodValue[] }>();
  for (const run of runs) {
    const tier = tierOf(run);
    for (const m of run.measurements) {
      if (!Number.isFinite(m.estimate)) continue;
      const key = comparisonKey(m);
      const slot = byKey.get(key) ?? { m, values: [] };
      // One value per method and quantity: a record never reports the same quantity twice, but a
      // defensive first-wins keeps the table honest if one ever does.
      if (!slot.values.some((v) => v.runId === run.id)) {
        slot.values.push({ runId: run.id, method: run.method.identifier, shortName: run.method.shortName, tier, estimate: m.estimate, interval: interval(m), deviation: null, withinInterval: false, isReference: false, partial: run.status === "partial", isBound: tier === "bound" });
      }
      byKey.set(key, slot);
    }
  }
  const width = (v: MethodValue) => (v.interval ? v.interval.high - v.interval.low : Number.POSITIVE_INFINITY);
  const quantities: QuantityAgreement[] = [];
  for (const [key, { m, values }] of byKey) {
// A bound is not an estimate and a partial run is not a finished one: both are listed, neither
    // is the reference, and a bound is not scored at all.
    const scored = values.filter((v) => !v.isBound);
    const exact = scored.find((v) => v.tier === "exact" && !v.partial);
    const sims = scored.filter((v) => v.tier === "simulation" && !v.partial).sort((a, b) => width(a) - width(b));
    const reference = exact ?? sims[0] ?? null;
    let worst: number | null = null;
    let referenceUncertain = false;
    let referenceZero = false;
    if (reference) {
      reference.isReference = true;
      referenceZero = Math.abs(reference.estimate) < ZERO;
      // An interval wider than ±10 % of the value cannot certify agreement: fall back to the
      // relative difference and say the reference is too uncertain.
      const tight = reference.tier === "simulation" && !!reference.interval && !referenceZero && (reference.interval.high - reference.interval.low) / 2 / Math.abs(reference.estimate) <= CLOSE;
      referenceUncertain = reference.tier === "simulation" && !tight;
      for (const v of scored) {
        if (v === reference) continue;
        if (referenceZero) {
          // No relative scale: equal when both are zero to within ZERO, otherwise as far apart as can be said.
          const same = Math.abs(v.estimate - reference.estimate) < ZERO;
          v.deviation = same ? 0 : null;
          worst = Math.max(worst ?? 0, same ? 0 : Number.POSITIVE_INFINITY);
        } else {
          v.deviation = (v.estimate - reference.estimate) / Math.abs(reference.estimate);
          worst = Math.max(worst ?? 0, Math.abs(v.deviation));
        }
        v.withinInterval = tight && v.estimate >= reference.interval!.low && v.estimate <= reference.interval!.high;
      }
    } else if (scored.length > 1) {
      const xs = scored.map((v) => v.estimate);
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      const range = Math.max(...xs) - Math.min(...xs);
      worst = range < ZERO ? 0 : Math.abs(mean) < ZERO ? Number.POSITIVE_INFINITY : range / Math.abs(mean);
    }
    quantities.push({ key, stationID: m.stationID ?? null, stationName: m.stationName, classLabel: classLabel(m.customerClass), metric: m.metric, unit: m.unit, reference, values, worst, verdict: verdictFor(worst, scored, reference), referenceUncertain, referenceZero });
  }
  quantities.sort((a, b) => standardCompare(`${a.stationName}|${a.classLabel}|${a.metric}`, `${b.stationName}|${b.classLabel}|${b.metric}`));
  const scoredCount = (q: QuantityAgreement) => q.values.filter((v) => !v.isBound).length;
  const compared = quantities.filter((q) => scoredCount(q) > 1);
  const comparedWithExact = compared.filter((q) => q.reference?.tier === "exact").length;
  const hasExact = runs.some((r) => tierOf(r) === "exact" && r.status !== "partial");
  // "Exact" overall only when an exact result was actually held against something, or stands
  // alone as the only evidence; otherwise the worst verdict among what was compared.
  const verdict: Verdict = compared.length
    ? compared.map((q) => q.verdict).sort((a, b) => VERDICT_RANK.indexOf(a) - VERDICT_RANK.indexOf(b))[0]
    : hasExact && runs.length === 1
      ? "exact"
      : "single";
  return {
    quantities,
    verdict,
    methods: runs.map((r) => ({ runId: r.id, method: r.method.identifier, shortName: r.method.shortName, tier: tierOf(r) })),
    hasExact,
    comparedWithExact,
    compared: compared.length,
  };
}

/** The run to show when only one can be shown (the canvas, a single chart): the best tier, then the newest. */
export function bestRun(runs: readonly ResultRecord[]): ResultRecord | null {
  return [...runs].sort((a, b) => TIER_ORDER.indexOf(tierOf(a)) - TIER_ORDER.indexOf(tierOf(b)) || (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt))[0] ?? null;
}

/** The metrics a canvas or chart can show per station, in the order they are offered. */
export const STATION_METRICS = ["Utilization", "Mean number in system", "Mean sojourn time", "Mean queue length", "Throughput"] as const;
export type StationMetric = (typeof STATION_METRICS)[number];

export interface StationValue {
  stationID: string;
  stationName: string;
  /** Summed over classes for counts and rates; the class-free value when the method gives one. */
  value: number;
  interval: { low: number; high: number } | null;
}

/**
 * Names a method may use for the same per-station quantity, for display only: the exact and
 * regenerative methods report "Server utilization" where the others say "Utilization". The
 * agreement table never merges them (it compares like with like by the recorded name).
 */
const DISPLAY_ALIASES: Record<string, string[]> = { Utilization: ["Utilization", "Server utilization"] };

/**
 * One value per station for `metric` in `run`: the all-classes measurement when the method gives
 * one; otherwise built from the per-class rows only where that is valid — counts, rates and
 * utilisation add over classes; a sojourn time is the throughput-weighted mean of the classes'
 * (and is left out when the run gives no per-class throughput to weight by). One class's number is
 * never passed off as the station's.
 */
export function stationValues(run: ResultRecord, metric: string): StationValue[] {
  const names = DISPLAY_ALIASES[metric] ?? [metric];
  const name = names.find((n) => run.measurements.some((m) => m.metric === n)) ?? metric;
  const whole = new Map<string, StationValue>();
  const parts = new Map<string, { stationName: string; rows: Measurement[] }>();
  for (const m of run.measurements) {
    if (m.metric !== name || !m.stationID || !Number.isFinite(m.estimate)) continue;
    if (typeof m.customerClass !== "number") {
      if (!whole.has(m.stationID)) whole.set(m.stationID, { stationID: m.stationID, stationName: m.stationName, value: m.estimate, interval: interval(m) });
    } else {
      const p = parts.get(m.stationID) ?? { stationName: m.stationName, rows: [] };
      p.rows.push(m);
      parts.set(m.stationID, p);
    }
  }
  const out = [...whole.values()];
  const mean = metric === "Mean sojourn time";
  for (const [stationID, p] of parts) {
    if (whole.has(stationID)) continue;
    if (!mean) {
      out.push({ stationID, stationName: p.stationName, value: p.rows.reduce((s, m) => s + m.estimate, 0), interval: null });
      continue;
    }
    let weight = 0;
    let total = 0;
    let complete = true;
    for (const m of p.rows) {
      const rate = run.measurements.find((x) => x.metric === "Throughput" && x.stationID === stationID && x.customerClass === m.customerClass)?.estimate;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
        complete = false;
        break;
      }
      weight += rate;
      total += rate * m.estimate;
    }
    if (complete && weight > 0) out.push({ stationID, stationName: p.stationName, value: total / weight, interval: null });
  }
  return out;
}

/**
 * Utilisations closer than this tie for the bottleneck: half a unit of the fourth decimal, so two
 * stations that both read "70.00 %" are never told apart. Defined once for the interface (the
 * canvas, live results, Sensitivity); Rust's copy is core/src/jackson.rs `TIE_TOLERANCE`.
 */
export const BOTTLENECK_TIE = 5e-5;

/** Of `items`, every one within `BOTTLENECK_TIE` of the highest utilisation, in order; none when nothing is loaded. */
export function mostLoaded<T>(items: readonly T[], utilisation: (item: T) => number): T[] {
  const top = items.reduce((m, x) => (Number.isFinite(utilisation(x)) ? Math.max(m, utilisation(x)) : m), 0);
  return top > 0 ? items.filter((x) => Number.isFinite(utilisation(x)) && top - utilisation(x) < BOTTLENECK_TIE) : [];
}

/** The station(s) with the highest utilisation in `run`: several when they tie, none when it reports no utilisation. */
export function bottlenecks(run: ResultRecord): StationValue[] {
  return mostLoaded(stationValues(run, "Utilization"), (s) => s.value);
}

/** The first of `bottlenecks`, for a sentence that quotes one station. A tie is not a single bottleneck: ask `bottlenecks`. */
export function bottleneck(run: ResultRecord): StationValue | null {
  return bottlenecks(run)[0] ?? null;
}
