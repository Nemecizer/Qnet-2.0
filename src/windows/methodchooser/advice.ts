// The Method Chooser's rows (0.90.34 MethodChooserView.swift `MethodAdvisor.recommendations`,
// `infiniteRows`, `finiteRows`, `pythonRuntimeReason`; ledger ANA-200…225, INV-033).
//
// Two answers come in from Rust and stay separate (INV-033): the network's side, `MethodDomain`
// (src-tauri/src/analysis_windows/advice.rs — the class count, the Markov and class tests, the
// tractability match, the Product Form and QBD exporters' verdicts), and the installation's side,
// `RuntimeAvailability` per solver (the runner's resolver). This file is 0.90.34's rules that
// combine them into a row per method, in 0.90.34's order of cases; the words are ./words.ts.
import type { MethodDomain, RuntimeAvailability, RuntimeKey } from "../../lib/types";
import { methodChooserWords as w } from "./words";

export type Layer = keyof typeof w.layers;
export type Suitability = keyof typeof w.suitability;

/** `MethodSuitability.rank`. */
export const RANK: Record<Suitability, number> = { recommended: 0, applicable: 1, caution: 2, experimental: 3, unavailable: 4 };

/** The Help topic each row's "Open Method Reference" opens (`HelpTopic`). */
export type HelpTopic =
  | "analyticalTractability" | "simulationInfinite" | "simulationFinite" | "regenerativeSimulation" | "qna" | "adaptiveTruncatedCTMC" | "adaptiveLowRankBAR"
  | "barMomentBounds" | "rqna" | "sbd" | "spectralInfinite" | "spectralFinite" | "exactSimulation" | "linearProgramInfinite" | "multiClassSRBM" | "ctmc"
  | "finiteDecomposition" | "finiteElement" | "finiteLP" | "closedNetworks" | "replicatedSimulation" | "priorityQueues" | "batchArrivals";

export interface MethodAdvice {
  /** `MethodAdvice.id` ("qna", "open-product-form"), what Run Method dispatches on. */
  id: string;
  name: string;
  implementation: string;
  layer: Layer;
  suitability: Suitability;
  summary: string;
  assumptions: string;
  cost: string;
  outputs: string;
  helpTopic: HelpTopic;
}

export type Availability = Partial<Record<RuntimeKey, RuntimeAvailability>>;

const ready = (a: Availability, k: RuntimeKey) => a[k]?.available === true;

/** `pythonRuntimeReason`: the resolver's reason, else 0.90.34's last-resort sentence. */
function runtimeReason(a: Availability, k: RuntimeKey): string {
  return a[k]?.reason || w.runtimeFallback;
}

type Fixed = { name: string; implementation: string; assumptions: string; cost: string; outputs: string };
const row = (id: string, t: Fixed, layer: Layer, suitability: Suitability, summary: string, helpTopic: HelpTopic, extra: Partial<MethodAdvice> = {}): MethodAdvice => ({
  id,
  name: t.name,
  implementation: t.implementation,
  layer,
  suitability,
  summary,
  assumptions: t.assumptions,
  cost: t.cost,
  outputs: t.outputs,
  helpTopic,
  ...extra,
});

/**
 * Replicated Simulation's row (new in 2.1): applicable wherever core's `simstat::plan` accepts
 * the network, and never ahead of a method that was recommended before it existed.
 */
function replicatedRow(d: MethodDomain, closed: boolean): MethodAdvice {
  const refusal = d.replicatedSimulationRefusal ?? null;
  return row("simulation-inprocess", w.replicated, "queueSimulation", refusal === null ? "applicable" : "unavailable", refusal ?? (closed ? w.replicated.readyClosed : w.replicated.ready), "replicatedSimulation");
}

function infiniteRows(d: MethodDomain, a: Availability, suffix: string): MethodAdvice[] {
  const diffusion: Suitability = d.warningCount > 0 ? "caution" : "applicable";
  const truncatedApplicable = d.classCount === 1 && d.sourcesArePoisson && d.servicesAreExponential;
  const regenerativeApplicable = d.sourcesArePoisson && d.servicesAreExponential && !d.classTransitions && d.classIndependentService;
  const pfApplicable = d.productFormRefusal === null;
  const qbdApplicable = d.qbdRefusal === null;
  const n = d.stationCount;
  const multiclassReady = d.classCount > 1 && ready(a, "multiclass");
  return [
    row(
      "open-product-form", w.productForm, "exactQueue",
      pfApplicable && ready(a, "productForm") ? "recommended" : "unavailable",
      !pfApplicable ? d.productFormRefusal! : !ready(a, "productForm") ? w.qualifiesBut(runtimeReason(a, "productForm")) : w.productForm.ready,
      "analyticalTractability",
    ),
    row(
      "qbd", w.qbd, "exactQueue",
      qbdApplicable && ready(a, "qbd") ? "recommended" : "unavailable",
      !qbdApplicable ? d.qbdRefusal! : !ready(a, "qbd") ? w.qualifiesBut(runtimeReason(a, "qbd")) : w.qbd.ready,
      "analyticalTractability",
    ),
    row("simulation-infinite", w.simulationInfinite, "queueSimulation", "recommended", w.simulationInfinite.summary, "simulationInfinite"),
    replicatedRow(d, false),
    row(
      "regenerative-mc", w.regenerativeInfinite, "queueSimulation",
      regenerativeApplicable && ready(a, "regenerative") ? (d.heavyJackson ? "caution" : "applicable") : "unavailable",
      !regenerativeApplicable ? w.regenerativeInfinite.outOfDomain : !ready(a, "regenerative") ? runtimeReason(a, "regenerative") : w.regenerativeInfinite.ready,
      "regenerativeSimulation",
    ),
    row("qna", { ...w.qna, assumptions: w.qna.assumptions + suffix }, "queueApproximation", d.hasFeedback ? "caution" : "recommended", d.hasFeedback ? w.qna.feedbackSummary : w.qna.summary, "qna"),
    row(
      "truncated-ctmc", w.truncatedCtmc, "queueApproximation",
      truncatedApplicable && ready(a, "truncatedCtmc") ? (d.heavyJackson ? "caution" : "applicable") : "unavailable",
      !truncatedApplicable ? w.truncatedCtmc.outOfDomain : !ready(a, "truncatedCtmc") ? runtimeReason(a, "truncatedCtmc") : w.truncatedCtmc.ready,
      "adaptiveTruncatedCTMC",
    ),
    row(
      "adaptive-low-rank-bar", w.adaptiveBar, "srbmNumerical",
      n <= 32 && ready(a, "adaptiveBar") ? "experimental" : "unavailable",
      n > 32 ? w.adaptiveBar.tooMany : !ready(a, "adaptiveBar") ? runtimeReason(a, "adaptiveBar") : w.adaptiveBar.ready,
      "adaptiveLowRankBAR",
    ),
    row(
      "bar-moment-bounds", { ...w.barBounds, cost: n > 4 ? w.barBounds.costHigh : w.barBounds.costLow }, "srbmNumerical",
      !ready(a, "barBounds") ? "unavailable" : n <= 4 ? "experimental" : "caution",
      !ready(a, "barBounds") ? runtimeReason(a, "barBounds") : n === 1 ? w.barBounds.oneStation : w.barBounds.general,
      "barMomentBounds",
    ),
    row("rqna", { ...w.rqna, assumptions: w.rqna.assumptions + suffix }, "queueApproximation", d.hasFeedback ? "recommended" : "applicable", w.rqna.summary, "rqna"),
    row("sbd", { ...w.sbd, assumptions: w.sbd.assumptions + suffix }, "srbmNumerical", diffusion, w.sbd.summary, "sbd"),
    row(
      "spectral-infinite", { ...w.spectralInfinite, assumptions: w.spectralInfinite.assumptions + suffix, cost: n > 8 ? w.highAt(n) : w.spectralInfinite.cost }, "srbmNumerical",
      n > 8 ? "caution" : diffusion, w.spectralInfinite.summary, "spectralInfinite",
    ),
    row("mlmc", { ...w.mlmc, assumptions: w.mlmc.assumptions + suffix }, "srbmNumerical", diffusion, w.mlmc.summary, "exactSimulation"),
    row(
      "lp-infinite", { ...w.lpInfinite, assumptions: w.lpInfinite.assumptions + suffix }, "srbmNumerical",
      n > 15 ? "unavailable" : n > 8 ? "caution" : diffusion, w.lpInfinite.summary, "linearProgramInfinite",
    ),
    row(
      "multiclass-srbm", w.multiclass, "srbmNumerical",
      multiclassReady ? "experimental" : "unavailable",
      multiclassReady ? w.multiclass.ready : d.classCount <= 1 ? w.multiclass.oneClass : w.multiclass.notBuilt,
      "multiClassSRBM",
    ),
  ];
}

function finiteRows(d: MethodDomain, a: Availability, suffix: string): MethodAdvice[] {
  const diffusion: Suitability = d.warningCount > 0 ? "caution" : "applicable";
  const markovian = d.sourcesArePoisson && d.servicesAreExponential;
  const regenerativeApplicable = markovian && !d.classTransitions && d.classIndependentService;
  const ctmcLikely = markovian && d.stationCount <= 6;
  const n = d.stationCount;
  return [
    row("simulation-finite", w.simulationFinite, "queueSimulation", "recommended", w.simulationFinite.summary, "simulationFinite"),
    row(
      "regenerative-mc", w.regenerativeFinite, "queueSimulation",
      regenerativeApplicable && ready(a, "regenerative") ? "applicable" : "unavailable",
      !regenerativeApplicable ? w.regenerativeFinite.outOfDomain : !ready(a, "regenerative") ? runtimeReason(a, "regenerative") : w.regenerativeFinite.ready,
      "regenerativeSimulation",
    ),
    row(
      "ctmc", w.ctmc, "exactQueue",
      ctmcLikely && ready(a, "genericCtmc") ? "applicable" : "unavailable",
      !ctmcLikely ? (markovian ? w.ctmc.tooLarge : w.ctmc.notMarkovian) : !ready(a, "genericCtmc") ? runtimeReason(a, "genericCtmc") : w.ctmc.ready,
      "ctmc",
    ),
    row(
      "finite-decomposition", { ...w.decomposition, assumptions: w.decomposition.assumptions + suffix }, "queueApproximation",
      markovian && ready(a, "decomposition") ? "recommended" : "unavailable",
      !markovian ? w.decomposition.notMarkovian : !ready(a, "decomposition") ? runtimeReason(a, "decomposition") : w.decomposition.ready,
      "finiteDecomposition",
    ),
    row("spectral-finite", { ...w.spectralFinite, assumptions: w.spectralFinite.assumptions + suffix }, "srbmNumerical", diffusion, w.spectralFinite.summary, "spectralFinite"),
    row("fem-finite", { ...w.femFinite, assumptions: w.femFinite.assumptions + suffix, cost: n > 4 ? w.highAt(n) : w.femFinite.cost }, "srbmNumerical", diffusion, w.femFinite.summary, "finiteElement"),
    row("lp-finite", { ...w.lpFinite, assumptions: w.lpFinite.assumptions + suffix }, "srbmNumerical", diffusion, w.lpFinite.summary, "finiteLP"),
  ];
}

const collator = new Intl.Collator(undefined, { sensitivity: "accent" });

/** `MethodAdvisor.recommendations`: the rows, sorted by suitability, then name (case-insensitively). */
export function recommendations(d: MethodDomain, availability: RuntimeAvailability[]): MethodAdvice[] {
  const a: Availability = Object.fromEntries(availability.map((r) => [r.key, r]));
  const suffix = w.warningSuffix(d.warningCount);
  const rows: MethodAdvice[] = [];
  if (d.analytical) {
    const t = d.analytical;
    rows.push({
      id: "analytical",
      name: t.exact ? w.analytical.exactName : w.analytical.asymptoticName,
      implementation: t.detail,
      layer: t.exact ? "exactQueue" : "srbmAnalytical",
      suitability: "recommended",
      summary: t.title,
      assumptions: t.explanation || w.analytical.assumptionsFallback,
      cost: w.analytical.cost,
      outputs: w.analytical.outputs,
      helpTopic: "analyticalTractability",
    });
  }
  rows.push(...(d.infiniteBuffers ? infiniteRows(d, a, suffix) : finiteRows(d, a, suffix)));
  if (d.closed) {
    // A closed network (new in 2.1): one method solves it, exactly and in process; every other
    // method needs arrivals from a source, and says so instead of its usual summary.
    const closed = d.closed;
    // Replicated Simulation is the one other method that takes a closed network, whatever its
    // buffer mode: its row is rebuilt below, so the others' sentence does not replace its own.
    const kept = rows.filter((r) => r.id !== "simulation-inprocess");
    rows.length = 0;
    rows.push(...kept);
    // Without a population the network is not closed yet: the other rows keep their own verdicts.
    const others = closed.population === null ? [...rows] : rows.filter((r) => r.id !== "analytical").map((r) => ({ ...r, suitability: "unavailable" as Suitability, summary: w.closed.otherMethods }));
    rows.length = 0;
    rows.push(row("closed-product-form", w.closed, "exactQueue", closed.refusal === null ? "recommended" : "unavailable", closed.refusal ?? w.closed.ready(closed.population ?? 0), "closedNetworks"), replicatedRow(d, closed.population !== null), ...others);
  }
  if (!d.closed && d.extended) {
    // A network with priorities, batch arrivals or a rate profile (new in 2.1): its exact
    // single-station method where there is one, the simulator, and every other method refused
    // in core's one sentence (`extended::refusal`), since each would answer for a different network.
    const x = d.extended;
    const others = rows.filter((r) => r.id !== "simulation-inprocess" && r.id !== "analytical").map((r) => ({ ...r, suitability: "unavailable" as Suitability, summary: x.others }));
    rows.length = 0;
    for (const e of x.exact) {
      const t = e.id === "priority-exact" ? w.priority : w.batch;
      rows.push(row(e.id, { ...t, name: e.name }, "exactQueue", e.refusal === null ? "recommended" : "unavailable", e.refusal ?? e.ready, e.id === "priority-exact" ? "priorityQueues" : "batchArrivals"));
    }
    rows.push(replicatedRow(d, false), ...others);
  }
  return rows.sort((x, y) => RANK[x.suitability] - RANK[y.suitability] || collator.compare(x.name, y.name));
}

/** The search field's filter (`localizedCaseInsensitiveContains` over the row's texts). */
export function filterAdvice(rows: MethodAdvice[], search: string): MethodAdvice[] {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return rows;
  return rows.filter((r) =>
    [r.name, r.implementation, w.layers[r.layer], w.suitability[r.suitability], r.summary, r.assumptions, r.outputs].join(" ").toLocaleLowerCase().includes(needle),
  );
}

/**
 * Run Method: the Run menu command each row runs (QnetCommands.swift `runAdvisedMethod`), or
 * null for an id it doesn't know (0.90.34 beeped). Regenerative Monte Carlo is one row in each
 * buffer mode; 2.0's Run menu has an item per mode.
 */
export function commandFor(id: string, infiniteBuffers: boolean): string | null {
  const map: Record<string, string> = {
    analytical: "network:analyze",
    "simulation-infinite": "run:monte-carlo-infinite",
    "open-product-form": "run:product-form",
    "closed-product-form": "run:closed-product-form",
    "simulation-inprocess": "run:replicated-simulation",
    "priority-exact": "run:priority-exact",
    "batch-exact": "run:batch-exact",
    qbd: "run:qbd",
    "spectral-infinite": "run:spectral-infinite",
    qna: "run:qna",
    rqna: "run:rqna",
    sbd: "run:sbd",
    mlmc: "run:mlmc",
    "lp-infinite": "run:lp",
    "truncated-ctmc": "run:truncated-ctmc",
    "regenerative-mc": infiniteBuffers ? "run:regenerative-infinite" : "run:regenerative-finite",
    "adaptive-low-rank-bar": "run:low-rank-bar",
    "bar-moment-bounds": "run:bar-bounds",
    "multiclass-srbm": "run:multiclass",
    "simulation-finite": "run:monte-carlo-finite",
    ctmc: "run:generic-ctmc",
    "finite-decomposition": "run:decomposition",
    "spectral-finite": "run:spectral-finite",
    "fem-finite": "run:finite-element",
    "lp-finite": "run:finite-lp",
  };
  return map[id] ?? null;
}
