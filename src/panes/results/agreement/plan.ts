// Which method to run next (new in 2.1, ROADMAP B3 and C3): the Method Chooser's own rows
// (src/windows/methodchooser/advice.ts `recommendations`, in its order: suitability, then name)
// read as a plan. It walks the Chooser's list in three passes — an exact method if one applies,
// otherwise a simulation if none has run, otherwise the best-ranked approximation — and words a
// method's explanation from the Chooser's own sentences. One thing is added to the Chooser's
// order, for Run Recommended Methods only: an approximation that reports none of the headline
// quantities (`REPORTS`) cannot be held against the others, so it comes after those that do.
import { RUN_ITEMS } from "../../../runs/ui/commands";
import { commandFor, type MethodAdvice } from "../../../windows/methodchooser/advice";
import type { MethodDomain } from "../../../lib/types";
import type { ResultRecord } from "../model";
import { sameNetwork } from "../../../results/current";
import { tierOf, type MethodValue, type QuantityAgreement } from "../../../results/insight";
import { agreementWords as w } from "./words";

/** The results store's method identifier for each run label (core/src/results/model.rs). */
export const IDENTIFIER: Record<string, string> = {
  inf_sim: "queue.des", sim: "queue.des", product_form: "queue.open-bcmp-product-form", qbd: "queue.matrix-analytic-qbd",
  truncated_ctmc: "queue.infinite-truncated-ctmc", regenerative_mc: "queue.regenerative-mc", inf_sm: "srbm.spectral", sm: "srbm.spectral",
  qna: "queue-approx.qna", rqna: "queue-approx.rqna", sbd: "queue-approx.sbd", mlmc: "srbm.mlmc", lp: "srbm.lp", flp: "srbm.lp",
  adaptive_bar: "srbm.adaptive-low-rank-bar", bar_bounds: "srbm.bar-moment-bounds", generic_ctmc: "queue.finite-ctmc",
  fb_decomp: "queue-approx.finite-decomposition", fm: "srbm.fem", mc: "srbm.multiclass-station",
  closed_pf: "queue.closed-product-form",
  sim_inproc: "queue.des-replications",
  priority_exact: "queue.priority-exact",
  batch_exact: "queue.batch-arrival-exact",
};

export type Kind = "exact" | "simulation" | "approximation";

/** A Chooser row that can be run from here: its Run-menu command, run label and record identifier. */
export interface Candidate {
  advice: MethodAdvice;
  command: string;
  label: string;
  identifier: string;
  kind: Kind;
}

const kindOf = (a: MethodAdvice): Kind => (a.layer === "exactQueue" ? "exact" : a.layer === "queueSimulation" ? "simulation" : "approximation");

/** How a Chooser row runs, whatever its suitability; null for a row with no run of its own (Analytical solution). */
export function runnable(advice: MethodAdvice, infinite: boolean): Candidate | null {
  const command = commandFor(advice.id, infinite);
  const item = command ? RUN_ITEMS.find((i) => i.id === command) : undefined;
  if (!command || !item) return null;
  const label = item.label(infinite);
  const identifier = IDENTIFIER[label];
  return identifier ? { advice, command, label, identifier, kind: kindOf(advice) } : null;
}

/** The rows the Chooser would let run ("Run Method" shows), in its order. */
export function candidates(rows: readonly MethodAdvice[], infinite: boolean): Candidate[] {
  return rows.filter((r) => r.suitability !== "unavailable").map((r) => runnable(r, infinite)).filter((c): c is Candidate => c !== null);
}

export interface Choice {
  candidate: Candidate;
  /** Which pass chose it. */
  why: Kind;
}

/**
 * The most informative method not yet tried: an exact one if one applies; otherwise a simulation
 * if none has run; otherwise the best-ranked approximation; a second simulation last.
 * `attempted` holds record identifiers (a failed or refused try counts: it is not offered twice).
 */
export function pickNext(cands: readonly Candidate[], attempted: ReadonlySet<string>, hasSimulation: boolean): Choice | null {
  const open = cands.filter((c) => !attempted.has(c.identifier));
  const first = (kind: Kind) => open.find((c) => c.kind === kind);
  const exact = first("exact");
  if (exact) return { candidate: exact, why: "exact" };
  const simulation = first("simulation");
  if (simulation && !hasSimulation) return { candidate: simulation, why: "simulation" };
  const approximation = first("approximation");
  if (approximation) return { candidate: approximation, why: "approximation" };
  return simulation ? { candidate: simulation, why: "simulation" } : null;
}

/** Solve's method: the same walk with nothing tried yet. */
export const solveChoice = (cands: readonly Candidate[]): Choice | null => pickNext(cands, new Set(), false);

/** The quantities the Agreement view leads with (./rows.ts lists a station's rows in this order). */
export const HEADLINE_METRICS = ["Mean number in system", "Mean sojourn time", "Utilization", "Throughput"];

/**
 * The metric names each run label's record carries, as 0.90.34's solvers write them. Read off
 * the recorded runs in golden/runs/, and held to them by a test (agreement.test.tsx "what each
 * method reports"), so a solver that starts or stops reporting a quantity fails there. The
 * corpus holds no record of `qbd` with measurements (an exact method: this table does not rank it).
 */
export const REPORTS: Record<string, readonly string[]> = {
  inf_sim: ["Mean number in system", "Mean sojourn time", "Throughput", "Utilization"],
  inf_sm: ["Mean number in system", "Mean sojourn time", "Throughput", "Utilization"],
  qna: ["Mean number in system", "Mean sojourn time", "Throughput", "Utilization"],
  rqna: ["Mean number in system", "Mean sojourn time", "Throughput", "Utilization"],
  sbd: ["Mean number in system", "Mean sojourn time", "Throughput", "Utilization"],
  product_form: ["Mean number in system", "Server utilization", "Stability margin", "Throughput"],
  regenerative_mc: ["Mean number in system", "Mean queue length", "Server utilization", "Service completion rate"],
  truncated_ctmc: ["External departure rate", "Mean number in system", "Server utilization"],
  lp: ["Mean reported occupancy"],
  mlmc: ["Mean queue length"],
  adaptive_bar: ["Mean queue length", "Mean workload", "Workload variance"],
  bar_bounds: ["Mean workload"],
  mc: ["Mean reported occupancy", "Mean sojourn time", "Throughput", "Utilization"],
  sim: ["Mean reported occupancy", "Mean sojourn time", "Throughput", "Utilization"],
  sm: ["Mean reported occupancy", "Mean sojourn time", "Throughput", "Utilization"],
  fm: ["Mean reported occupancy", "Mean sojourn time", "Throughput", "Utilization"],
  flp: ["Mean reported occupancy", "Mean sojourn time", "Throughput", "Utilization"],
  generic_ctmc: ["Full probability", "Mean number in system", "Mean sojourn time", "Server utilization", "Throughput"],
  fb_decomp: ["Full probability", "Mean number in system", "Mean queue length", "Mean sojourn time", "Mean waiting time", "Offered arrival rate", "Server utilization", "Throughput"],
};

/** How many of the headline quantities run `label` reports (0 for a label the table does not know). */
export const headlineOverlap = (label: string) => (REPORTS[label] ?? []).filter((m) => HEADLINE_METRICS.includes(m)).length;

/**
 * Run Recommended Methods: the exact method if any, one simulation and two approximations — the
 * Chooser's best-ranked among those that report a headline quantity, and only then the rest
 * (Linear Program reports "Mean reported occupancy" alone on an infinite-buffer network: no other
 * method shares it, so running it adds nothing to the comparison).
 */
export function recommendedPlan(cands: readonly Candidate[]): Candidate[] {
  const of = (kind: Kind, n: number) => cands.filter((c) => c.kind === kind).slice(0, n);
  const approximations = cands.filter((c) => c.kind === "approximation");
  const comparable = [...approximations.filter((c) => headlineOverlap(c.label) > 0), ...approximations.filter((c) => headlineOverlap(c.label) === 0)];
  return [...of("exact", 1), ...of("simulation", 1), ...comparable.slice(0, 2)];
}

/**
 * Whether a record was made from the network `fingerprint` names — by `currentRuns`' own rule
 * (`sameNetwork`: a change of layout alone keeps a run current), so what counts as tried and
 * what counts as current can never differ.
 */
export const ofNetwork = (r: ResultRecord, fingerprint: string | null) => fingerprint === null || sameNetwork(r, fingerprint);

/** What has been tried for the network as it is: every record of this network, whatever its end. */
export function attemptedIdentifiers(records: readonly ResultRecord[], fingerprint: string | null): Set<string> {
  return new Set(records.filter((r) => ofNetwork(r, fingerprint)).map((r) => r.method.identifier));
}

export const hasSimulation = (runs: readonly ResultRecord[]) => runs.some((r) => tierOf(r) === "simulation");

/** The run label that produces `identifier` in this buffer mode (for running a stale run again). */
/** Whether a Run-menu item belongs to this buffer mode; the in-process simulation (new in 2.1) belongs to both. */
const inMode = (mode: string, infinite: boolean) => mode === "inprocess" || (mode === "infinite") === infinite;

export function labelFor(identifier: string, infinite: boolean): string | null {
  for (const item of RUN_ITEMS) {
    if (item.id === "run:comparison" || !inMode(item.mode, infinite)) continue;
    const label = item.label(infinite);
    if (IDENTIFIER[label] === identifier) return label;
  }
  return null;
}

/** The Run-menu command behind a run label in this buffer mode. */
export function commandForLabel(label: string, infinite: boolean): string | null {
  return RUN_ITEMS.find((i) => i.id !== "run:comparison" && inMode(i.mode, infinite) && i.label(infinite) === label)?.id ?? null;
}

/** The Chooser's row for a method that has run, by its record identifier. */
export function rowFor(identifier: string, rows: readonly MethodAdvice[], infinite: boolean): MethodAdvice | null {
  return rows.find((r) => runnable(r, infinite)?.identifier === identifier) ?? null;
}

export const whyWords = (why: Kind) => (why === "exact" ? w.whyExact : why === "simulation" ? w.whySimulation : w.whyApproximation);
export const checkWhyWords = (why: Kind) => (why === "exact" ? w.checkWhyExact : why === "simulation" ? w.checkWhySimulation : w.checkWhyApproximation);

// ── Why a method may differ ───────────────────────────────────────────────────────────────────

/**
 * A display heuristic, not a result. Neither the Method Chooser's rules
 * (src/windows/methodchooser/advice.ts, words.ts) nor the Rust advice
 * (src-tauri/src/analysis_windows/advice.rs) gives a utilisation at which a diffusion method
 * becomes accurate: they state the assumption in words only ("Most persuasive when important
 * stations operate in heavy traffic", "Heavy-traffic Brownian model", "Heavy-traffic SRBM"), and
 * the one number there (`heavy_jackson`: a Jackson network whose mean populations sum to more
 * than 20) is about the cost of the regenerative and truncated methods, not about diffusions.
 * So 0.8 only decides when the view mentions the assumption as a likely reason for a
 * disagreement already found; the sentence (`heavyTraffic` in ./words.ts) names the station's
 * utilisation and claims no threshold.
 */
export const LIGHT_LOAD_DISPLAY = 0.8;

const HEAVY = /heavy[- ]traffic/i;

/**
 * Likely reasons `value`'s method is off on quantity `q`, each from a rule the Method Chooser
 * already applies; empty when its rules give none (then the view says nothing).
 * `utilization` is the station's, from the best run, when known.
 */
export function disagreementReasons(q: QuantityAgreement, value: MethodValue, row: MethodAdvice | null, domain: MethodDomain, utilization: number | null, rho: (v: number) => string): string[] {
  if (!row) return [];
  const out: string[] = [];
  // The Chooser would not run it here: its summary is the refusal (non-exponential service for
  // product form, more than one class for the truncated CTMC…).
  if (row.suitability === "unavailable") return [w.ruledOut(row.summary)];
  // QNA under feedback: the Chooser's own caution sentence.
  if (row.id === "qna" && domain.hasFeedback) out.push(row.summary);
  const srbm = row.layer === "srbmNumerical" || row.layer === "srbmAnalytical" || row.id === "sbd";
  const assumption = [row.assumptions, row.summary].find((t) => HEAVY.test(t));
  if (srbm && assumption && utilization !== null && utilization < LIGHT_LOAD_DISPLAY && q.stationName) {
    out.push(w.heavyTraffic(value.shortName, firstSentence(assumption), q.stationName, rho(utilization)));
  }
  // Caution for the network's warnings (the diffusion rows) or the station count (cost).
  if (row.suitability === "caution" && row.id !== "qna") {
    if (/^High at \d+ stations$/.test(row.cost)) out.push(`${row.cost}.`);
    else if (domain.warningCount > 0) out.push(w.warnings(domain.warningCount));
  }
  return out;
}

export function firstSentence(text: string): string {
  const m = /^(.*?[.;])(\s|$)/.exec(text.trim());
  return (m ? m[1] : text.trim()).replace(/[.;]$/, "");
}
