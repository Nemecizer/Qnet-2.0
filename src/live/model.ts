// Live results as the canvas reads them (new in 2.1, ROADMAP Phase D). The numbers are Rust's
// (core/src/jackson.rs through `live_results`); nothing here computes a queue. This turns one
// answer into the shape the results overlay already draws — a record with a method called "Live"
// — so the badges, rings, bottleneck marker and metric menu are the overlay's own, and marks the
// model as live so the legend can never pass it off as a run.
//
// Precedence (`recordedIsCurrent`): a recorded run of the network as it is now always wins, and
// so does a run the person picked in the Results pane. Live values show when the tab has no run,
// or only runs of an earlier version of the network.
import { overlayModel, type OverlayModel } from "../canvas/overlay/model";
import { displayFixed } from "../editor/numbers";
import type { Measurement, ResultRecord } from "../panes/results/model";
import { structureKey } from "../results/current";
import type { StationMetric } from "../results/insight";
import { liveWords as w } from "./words";

export type LiveTier = "exact" | "utilisation" | "none";
export type LiveReason = "unstable" | "finiteBuffers" | "noTraffic" | "sharedStation" | "notExponential" | "notCertified" | "noModel" | "closed" | "closedNoPopulation" | "extended";

/** src-tauri/src/live.rs `LiveStation`. Customers, time units, customers per time unit. */
export interface LiveStation {
  stationId: string;
  stationName: string;
  servers: number;
  throughput: number;
  serviceRate: number;
  utilisation: number | null;
  meanInSystem: number | null;
  meanWaiting: number | null;
  meanSojourn: number | null;
  meanWait: number | null;
}

/** src-tauri/src/live.rs `LiveResults`. */
export interface LiveResults {
  tier: LiveTier;
  perStation: LiveStation[];
  network: { throughput: number; meanNumber: number; meanDelay: number } | null;
  reasonIfPartial: LiveReason | null;
  reasonDetail: string;
  /** ρ is the long-run utilisation (true) or only the offered load (finite buffers, unstable). */
  utilisationExact: boolean;
  /** The station(s) at the highest ρ: several when they tie (core `jackson::TIE_TOLERANCE`). */
  bottlenecks: string[];
  /**
   * Present for a closed network (new in 2.1; core/src/closed.rs): then `network.throughput` is
   * the rate of passes through the reference station, `meanNumber` the population and `meanDelay`
   * the mean cycle time N/X.
   */
  closed?: { population: number; referenceStation: string };
  /** Present when the exact tier is a single-station formula of a feature new in 2.1 (core/src/priority.rs, batch.rs), not Jackson's. */
  formula?: "priority" | "batch";
}

export const LIVE_METHOD = "live.closed-form";

/** What marks an overlay model as live rather than a run's. */
export interface LiveMark {
  tier: LiveTier;
  /** "Live · exact". */
  chip: string;
  /** Why it stops at utilisation, or what "exact" rests on. */
  help: string;
  unstable: boolean;
}

export type LiveOverlayModel = OverlayModel & { live: LiveMark };

export function chipFor(r: LiveResults): string {
  if (r.reasonIfPartial === "unstable") return w.chipUnstable;
  if (r.tier === "utilisation" && !r.utilisationExact) return w.chipOffered;
  return w.chip[r.tier];
}

export function markFor(r: LiveResults): LiveMark {
  return { tier: r.tier, chip: chipFor(r), help: r.tier === "exact" ? (r.closed ? w.closedExactHelp(r.closed.population, r.closed.referenceStation) : r.formula ? w.formulaHelp[r.formula] : w.exactHelp) : w.reason(r.reasonIfPartial, r.reasonDetail), unstable: r.reasonIfPartial === "unstable" };
}

/**
 * The answer as a record the overlay can read. Its fidelity is what the numbers are: exact for a
 * Jackson network and for ρ with infinite buffers; an approximation where ρ is only the offered
 * load. An unstable network's record holds ρ and nothing else.
 */
export function liveRecord(r: LiveResults, tabId: string): ResultRecord {
  const measurements: Measurement[] = [];
  const add = (s: LiveStation, metric: string, estimate: number | null, unit: string) => {
    if (estimate === null || !Number.isFinite(estimate)) return;
    measurements.push({ id: `live-${s.stationId}-${metric}`, stationID: s.stationId, stationName: s.stationName, metric, estimate, unit });
  };
  const exact = r.tier === "exact";
  for (const s of r.perStation) {
    add(s, "Utilization", s.utilisation, "ratio");
    if (!exact) continue;
    add(s, "Mean number in system", s.meanInSystem, "customers");
    add(s, "Mean sojourn time", s.meanSojourn, "time");
    add(s, "Mean queue length", s.meanWaiting, "customers");
    add(s, "Throughput", s.throughput, "customers / time");
  }
  return {
    id: `live:${tabId}`,
    method: { identifier: LIVE_METHOD, displayName: w.methodLong, shortName: w.method, layer: "Queueing process", fidelity: exact || r.utilisationExact ? "Exact queueing result" : "Queueing approximation" },
    provenance: { tabID: tabId, networkTitle: "", networkFingerprint: "live", bufferRegime: "", parameters: {} } as ResultRecord["provenance"],
    status: "completed",
    startedAt: "",
    completedAt: "",
    warnings: [],
    measurements,
  };
}

/**
 * The overlay model for a live answer, or null when it has nothing per station. A metric the
 * answer cannot give (queue lengths at the utilisation tier) falls back to utilisation rather
 * than leaving the canvas blank: the chip says why.
 */
export function liveOverlayModel(r: LiveResults | null, tabId: string, metric: StationMetric, decimals: number): LiveOverlayModel | null {
  if (!r || r.tier === "none" || !r.perStation.length) return null;
  const record = liveRecord(r, tabId);
  if (!record.measurements.length) return null;
  const has = record.measurements.some((m) => m.metric === metric);
  const model = overlayModel({ records: [record], fingerprint: null, metric: has ? metric : "Utilization", decimals });
  if (!model) return null;
  const live = markFor(r);
  return { ...model, caption: model.metric, live };
}

const snapshotKeys = new WeakMap<object, string | null>();

/**
 * True when what the overlay would show from the tab's records must be kept: a run of the
 * network as it is now, or one the person picked. `docKey` is `structureKey` of the document, so
 * the answer does not wait for a fingerprint; a record without a snapshot is judged by `stale`.
 */
export function recordedIsCurrent(recorded: OverlayModel | null, docKey: string | null): boolean {
  if (!recorded) return false;
  if (recorded.pinned) return true;
  const run = recorded.run;
  let then = snapshotKeys.get(run);
  if (then === undefined) {
    then = structureKey(run.provenance.networkSnapshot as Parameters<typeof structureKey>[0]);
    snapshotKeys.set(run, then);
  }
  if (then !== null && docKey !== null) return then === docKey;
  return !recorded.stale;
}

/** What the canvas shows: the recorded model while it is current, else the live one, else the recorded (stale) one. */
export function chooseModel(recorded: OverlayModel | null, live: LiveOverlayModel | null, docKey: string | null): OverlayModel | null {
  if (recordedIsCurrent(recorded, docKey)) return recorded;
  return live ?? recorded;
}

export const isLiveModel = (m: OverlayModel | null | undefined): m is LiveOverlayModel => !!m && "live" in m && !!(m as LiveOverlayModel).live;

export interface Readout {
  station: string;
  /** "ρ 80.0 %", "L 4.000 customers", "W 5.000 time units": label, number, unit, help. */
  parts: { key: "rho" | "l" | "w"; label: string; number: string; unit: string; help: string }[];
  /** "exact", "utilisation only". */
  tier: string;
  note: string | null;
  help: string;
  spoken: string;
}

/** The status bar's read-out for one station of a live answer, or null when it has none. */
export function readoutFor(r: LiveResults | null, stationId: string, decimals: number): Readout | null {
  if (!r || r.tier === "none") return null;
  const s = r.perStation.find((x) => x.stationId.toUpperCase() === stationId.toUpperCase());
  if (!s || s.utilisation === null) return null;
  const d = Math.min(decimals, 3);
  const parts: Readout["parts"] = [{ key: "rho", label: w.readout.rho, number: displayFixed(s.utilisation * 100, Math.max(0, d - 2)), unit: "%", help: r.utilisationExact ? w.readout.rhoHelp : w.readout.rhoOfferedHelp }];
  if (r.tier === "exact" && s.meanInSystem !== null && s.meanSojourn !== null) {
    parts.push({ key: "l", label: w.readout.l, number: displayFixed(s.meanInSystem, d), unit: w.readout.lUnit, help: w.readout.lHelp });
    parts.push({ key: "w", label: w.readout.w, number: displayFixed(s.meanSojourn, d), unit: w.readout.wUnit, help: w.readout.wHelp });
  }
  const unstable = r.reasonIfPartial === "unstable";
  // Unstable: the tier already reads "Live · no steady state", and Solve would not help.
  const note = r.tier === "exact" || unstable ? null : w.pressSolve;
  const mark = markFor(r);
  const net = !r.network
    ? ""
    : r.closed
      ? ` ${w.readout.closedNetwork(r.closed.population, displayFixed(r.network.meanDelay, d), displayFixed(r.network.throughput, d), r.closed.referenceStation)}.`
      : ` ${w.readout.network(displayFixed(r.network.meanNumber, d), displayFixed(r.network.meanDelay, d), displayFixed(r.network.throughput, d))}.`;
  return {
    station: s.stationName,
    parts,
    tier: mark.chip,
    note,
    help: `${mark.help}${net}`,
    spoken: w.readout.spoken(s.stationName, [...parts.map((p) => `${p.label} ${p.number} ${p.unit}`), ...(note ? [note] : [])], mark.chip),
  };
}
