// The run-parameter sheets as data (0.90.34 RunParameterSpecs.swift, RunParameterSheet.swift;
// ledger METH-009…012, METH-020…026, METH-043…050, METH-054, METH-080…086, METH-094, METH-098…101,
// METH-109, METH-112, METH-117, METH-118): one description per sheet — its title, subtitle, Help
// topic, size band, sections and fields with their ranges, labels and help, its starting values
// read from the settings as the `run…()` action read them, and what "Set as Default" writes.
//
// What a sheet answers becomes the run's `overrides` (src/runs/state.ts `startRun`), keyed by the
// settings the runner reads. Only a field the user changed goes into them, so a sheet confirmed
// unchanged starts exactly the run the golden corpus recorded (it pressed Run at once) with the
// same settings the run has without the sheet.
import { getSetting } from "../../lib/kv";
import type { PanelBand } from "../../lib/panel";
import type { KvValues } from "../../lib/types";
import { METHOD_REFERENCE } from "../../lib/menuSpec";
import { formatSig } from "../../editor/numbers";
import { parseNumber } from "../../workspace/files/generate";
import { parseCount } from "../../components/CountField";
import { glossary as g, runWords as w } from "./words";

export type FieldKind =
  /** Whole number with a stepper; `emptyFor` is shown blank (0 = "auto") and read back when blank. */
  | { type: "integer"; min: number; max: number; step?: number; emptyFor?: number }
  | { type: "decimal"; min: number; max: number; step: number }
  /** Menu picker; the value is the selected index. */
  | { type: "choice"; options: readonly string[] }
  | { type: "flag" };

export interface SheetField {
  /** `RunKey`: the field's key in the sheet. */
  key: string;
  title: string;
  kind: FieldKind;
  help?: string;
  glossary?: string;
  unit?: string;
  /** The setting the runner reads this answer from; absent when the runner has none for it. */
  setting?: string;
}

export interface SheetSection {
  title: string;
  footer?: string;
  /** Something the sheet changed for the user, shown in red under the rows ("Degree changed…"). */
  notice?: string;
  fields: SheetField[];
}

export type SheetValue = number | boolean;
export type SheetValues = Record<string, SheetValue>;

export type SheetKind = "mc-infinite" | "mc-finite" | "regenerative" | "replicated" | "spectral-infinite" | "spectral-finite" | "finite-element" | "multiclass" | "lp" | "comparison";

export interface SheetSpec {
  kind: SheetKind;
  title: string;
  subtitle: string;
  /** Method Reference topic id (menuSpec `METHOD_REFERENCE`): the footer's "?" opens it. */
  helpTopic: string;
  tint: "info" | "warning";
  confirmHelp: string;
  size: PanelBand;
  sections: SheetSection[];
  /** The starting values, by field key. */
  values: SheetValues;
  /** What the settings hold for a field the sheet opened on something else; the run is told the difference. */
  stored?: SheetValues;
  /** The settings "Set as Default" writes; absent when the sheet has no Set as Default. */
  defaults?: (v: SheetValues) => KvValues;
  /** The Status line Cancel writes (warning). */
  cancelLine: string;
}

/** The three finite-buffer blocking regimes (`RunParameterSpec.blockingRegimes`). */
export const BLOCKING_REGIMES = ["Loss network (jobs discarded when full)", "BAS blocking (server blocks, external held)", "BAS + external loss (matches SRBM)"] as const;

const RUN_LENGTH_FOOTER = "Statistics are collected after the warm-up period. The half-widths printed beside each result are 95 % confidence intervals.";
const SEED_FOOTER = "When the switch is off, Qnet generates a fresh base seed and still stores the seed used with the result.";
const INT32_MAX = 2_147_483_647;

/** `AppSettings` defaults of the keys the sheets read (runner/src/methods/settings.rs). */
const DEFAULTS: KvValues = {
  "sim.replications": 50, "sim.warmup": 1_000_000, "sim.time": 5_000_000, "sim.parallel": 0, "sim.blocking": 2, "sim.seedFixed": false, "sim.seed": 12_345,
  "sm.degree": 8, "sm.legendre": false, "fem.solver": 0, "fem.meshSize": 10,
  "lp.gridN": 0, "lp.basisM": 0, "lp.solver": 0, "lp.gridType": 0, "lp.smoothness": 0, "lp.basisNormalize": false, "lp.multiLevel": false, "lp.askBeforeRun": false,
  "runCompare.remember": false,
};

const num = (key: string) => Number(getSetting<unknown>(key, DEFAULTS[key]));
const flag = (key: string) => Boolean(getSetting<unknown>(key, DEFAULTS[key]));

function replicationFields(): SheetField[] {
  return [
    { key: "replications", title: "Replications", kind: { type: "integer", min: 1, max: 100_000 }, help: "Independent runs averaged into the reported estimate; more replications narrow the confidence interval", glossary: g.replications, setting: "sim.replications" },
    { key: "warmup", title: "Warm-up period", kind: { type: "integer", min: 0, max: 1_000_000_000, step: 100_000 }, help: "Simulated model time discarded before statistics are collected, so the estimate is not biased by the empty initial state", glossary: g.warmup, unit: "time units", setting: "sim.warmup" },
    { key: "simTime", title: "Simulation time", kind: { type: "integer", min: 1, max: 1_000_000_000, step: 1_000_000 }, help: "Simulated time per replication", unit: "time units", setting: "sim.time" },
  ];
}

function reproducibilityFields(): SheetField[] {
  return [
    { key: "seedFixed", title: "Use fixed seed", kind: { type: "flag" }, help: "Use the entered base seed so this simulation can be reproduced exactly", setting: "sim.seedFixed" },
    { key: "seed", title: "Base random seed", kind: { type: "integer", min: 0, max: INT32_MAX }, help: "The simulator derives each replication's stream deterministically from this base seed", setting: "sim.seed" },
  ];
}

const simValues = (): SheetValues => ({
  replications: num("sim.replications"),
  warmup: num("sim.warmup"),
  simTime: num("sim.time"),
  seedFixed: flag("sim.seedFixed"),
  seed: num("sim.seed"),
});

const int = (v: SheetValues, k: string) => Number(v[k]);
const bool = (v: SheetValues, k: string) => Boolean(v[k]);

/** `RunParameterSpec.monteCarloInfinite`; Set as Default as `runSimulationInfinite` wrote it. */
export function monteCarloInfinite(): SheetSpec {
  return {
    kind: "mc-infinite",
    title: "Run Monte Carlo",
    subtitle: "Discrete-event simulation of the infinite-buffer network (jackson_sim). No blocking regime applies — buffers are unbounded.",
    helpTopic: "simulationInfinite",
    tint: "info",
    confirmHelp: w.confirmHelp,
    size: "compact",
    sections: [
      { title: "Run Length", footer: RUN_LENGTH_FOOTER, fields: replicationFields() },
      { title: "Reproducibility", footer: SEED_FOOTER, fields: reproducibilityFields() },
    ],
    values: simValues(),
    defaults: (v) => ({
      "sim.replications": Math.max(1, int(v, "replications")),
      "sim.warmup": Math.max(0, int(v, "warmup")),
      "sim.time": Math.max(1, int(v, "simTime")),
      "sim.seedFixed": bool(v, "seedFixed"),
      "sim.seed": Math.max(0, int(v, "seed")),
    }),
    cancelLine: "Simulation (infinite) cancelled.",
  };
}

/** `RunParameterSpec.monteCarloFinite`; Set as Default as `runSimulation` wrote it. */
export function monteCarloFinite(): SheetSpec {
  return {
    kind: "mc-finite",
    title: "Run Monte Carlo",
    subtitle: "Discrete-event simulation of the finite-buffer network (fBNAsim). The blocking regime decides what happens to a job that finishes while the next buffer is full.",
    helpTopic: "simulationFinite",
    tint: "info",
    confirmHelp: w.confirmHelp,
    size: "regular",
    sections: [
      { title: "Model", fields: [{ key: "blocking", title: "Blocking", kind: { type: "choice", options: BLOCKING_REGIMES }, help: "Which finite-buffer convention the simulator enforces", glossary: g.bas, setting: "sim.blocking" }] },
      { title: "Run Length", footer: RUN_LENGTH_FOOTER, fields: replicationFields() },
      { title: "Reproducibility", footer: SEED_FOOTER, fields: reproducibilityFields() },
      { title: "Performance", fields: [{ key: "parallel", title: "Parallelism", kind: { type: "choice", options: ["Apple GCD (recommended)", "OpenMP", "Sequential"] }, help: "How replications are spread across CPU cores", setting: "sim.parallel" }] },
    ],
    values: { blocking: num("sim.blocking"), parallel: num("sim.parallel"), ...simValues() },
    defaults: (v) => ({
      "sim.parallel": int(v, "parallel"),
      "sim.blocking": int(v, "blocking"),
      "sim.replications": Math.max(1, int(v, "replications")),
      "sim.warmup": Math.max(0, int(v, "warmup")),
      "sim.time": Math.max(1, int(v, "simTime")),
      "sim.seedFixed": bool(v, "seedFixed"),
      "sim.seed": Math.max(0, int(v, "seed")),
    }),
    cancelLine: "Simulation cancelled.",
  };
}

/**
 * `RunParameterSpec.regenerativeMonteCarlo`: no Set as Default; the precision values start from
 * the same constants every time. The runner reads the seed pair from `sim.*`; the precision,
 * safeguard and stream answers travel under `regenerative.*` keys it does not read yet (report).
 */
export function regenerative(infinite: boolean): SheetSpec {
  return {
    kind: "regenerative",
    title: "Run Regenerative Monte Carlo",
    subtitle: infinite ? "Cycle-level sequential simulation of the infinite-buffer Markovian queueing process." : "Cycle-level sequential simulation of the finite loss-on-full Markovian queueing process.",
    helpTopic: "regenerativeSimulation",
    tint: "info",
    confirmHelp: w.confirmHelp,
    size: "regular",
    sections: [
      {
        title: "Precision",
        footer: "Stopping is checked only after complete empty-to-empty cycles. The wider of the absolute and relative targets is used.",
        fields: [
          { key: "confidence", title: "Confidence level", kind: { type: "decimal", min: 0.8, max: 0.999, step: 0.01 }, help: "Nominal confidence for regenerative-ratio intervals", setting: "regenerative.confidence" },
          { key: "absoluteHalfWidth", title: "Absolute half-width", kind: { type: "decimal", min: 0, max: 1000, step: 0.01 }, help: "Smallest absolute interval target; 0 disables this component", setting: "regenerative.absoluteHalfWidth" },
          { key: "relativeHalfWidth", title: "Relative half-width", kind: { type: "decimal", min: 0, max: 1, step: 0.01 }, help: "Target half-width as a fraction of the current estimate", setting: "regenerative.relativeHalfWidth" },
        ],
      },
      {
        title: "Cycle Safeguards",
        fields: [
          { key: "minimumCycles", title: "Minimum cycles", kind: { type: "integer", min: 30, max: 1_000_000, step: 100 }, help: "Complete cycles required before precision can stop the run", setting: "regenerative.minimumCycles" },
          { key: "maximumCycles", title: "Maximum cycles", kind: { type: "integer", min: 30, max: 10_000_000, step: 1000 }, help: "Hard complete-cycle limit", setting: "regenerative.maximumCycles" },
          { key: "maximumWallSeconds", title: "Maximum wall time", kind: { type: "integer", min: 1, max: 86_400, step: 10 }, help: "Stop cleanly at the next safe point after this elapsed time", unit: "seconds", setting: "regenerative.maximumWallSeconds" },
        ],
      },
      {
        title: "Reproducibility",
        footer: "A separate stream value gives a deterministic replication stream. The effective component seeds are retained in structured output.",
        fields: [...reproducibilityFields(), { key: "stream", title: "Stream", kind: { type: "integer", min: 0, max: INT32_MAX }, help: "Deterministic stream identifier mixed with the base seed", setting: "regenerative.stream" }],
      },
    ],
    values: {
      confidence: 0.95,
      absoluteHalfWidth: 0.05,
      relativeHalfWidth: 0.1,
      minimumCycles: 500,
      maximumCycles: 20_000,
      maximumWallSeconds: 30,
      seedFixed: flag("sim.seedFixed"),
      seed: num("sim.seed"),
      stream: 0,
    },
    cancelLine: "Regenerative Monte Carlo cancelled.",
  };
}

/** The confidence levels Replicated Simulation offers; the answer is the index (runner `siminproc::options`). */
export const REPLICATED_LEVELS = ["90 %", "95 %", "99 %"] as const;
export const REPLICATED_WARMUP = ["MSER on 200 batch means (automatic)", "Fixed fraction"] as const;

/**
 * Replicated Simulation's sheet (new in 2.1; runner/src/methods/siminproc.rs, core/src/simstat.rs):
 * no Set as Default; it opens on the estimator's defaults every time, like Regenerative Monte
 * Carlo's. The answers travel under `siminproc.*`; the seed pair is the simulators' own.
 */
export function replicatedSimulation(closed: boolean): SheetSpec {
  return {
    kind: "replicated",
    title: "Run Replicated Simulation",
    subtitle: closed
      ? "Steady-state simulation of the closed network inside Qnet: a second, independent opinion to hold against the exact solution."
      : "Steady-state simulation of the infinite-buffer network inside Qnet, with a confidence interval on every estimate.",
    helpTopic: "replicatedSimulation",
    tint: "info",
    confirmHelp: w.confirmHelp,
    size: "regular",
    sections: [
      {
        title: "Run Length",
        footer: "Each replication is an independent run of the same length. The interval comes from the spread between replications (Student's t), so more replications narrow it and longer ones make it more trustworthy.",
        fields: [
          { key: "replications", title: "Replications", kind: { type: "integer", min: 2, max: 10_000 }, help: "Independent runs averaged into the reported estimate; more replications narrow the confidence interval", glossary: g.replications, setting: "siminproc.replications" },
          { key: "completions", title: "Run length", kind: { type: "integer", min: 1_000, max: 100_000_000, step: 100_000 }, help: "Service completions per replication, over the whole network. Qnet turns it into model time with the network's throughputs", unit: "completions", setting: "siminproc.completions" },
        ],
      },
      {
        title: "Warm-up",
        footer: "The start of every replication is deleted, so the estimate is not biased by where the run began. MSER on 200 batch means finds how much from the runs themselves; if they are too short for it, half is deleted and the result says so.",
        fields: [
          { key: "warmup", title: "Warm-up rule", kind: { type: "choice", options: REPLICATED_WARMUP }, help: "How the length of the deleted start is chosen", glossary: g.warmup, setting: "siminproc.warmup" },
          { key: "warmupFraction", title: "Fixed fraction", kind: { type: "decimal", min: 0, max: 0.9, step: 0.05 }, help: "The share of each replication deleted when the rule is Fixed fraction", setting: "siminproc.warmupFraction" },
        ],
      },
      {
        title: "Precision",
        footer: "With a target, replications are added until every station's mean number is known to within that fraction of its value, or a safeguard stops the run. 0 runs exactly the replications asked for.",
        fields: [
          { key: "confidence", title: "Confidence level", kind: { type: "choice", options: REPLICATED_LEVELS }, help: "The level of the Student-t intervals", setting: "siminproc.confidence" },
          { key: "precision", title: "Target relative half-width", kind: { type: "decimal", min: 0, max: 0.5, step: 0.01 }, help: "0.02 asks for ±2 % on every station's mean number; 0 sets no target", setting: "siminproc.precision" },
          { key: "maximumReplications", title: "Maximum replications", kind: { type: "integer", min: 2, max: 10_000, step: 100 }, help: "Hard limit on replications when a target is set", setting: "siminproc.maximumReplications" },
          { key: "maximumWallSeconds", title: "Maximum wall time", kind: { type: "integer", min: 1, max: 86_400, step: 10 }, help: "Stop adding replications after this elapsed time", unit: "seconds", setting: "siminproc.maximumWallSeconds" },
        ],
      },
      { title: "Reproducibility", footer: SEED_FOOTER, fields: reproducibilityFields() },
    ],
    values: { replications: 20, completions: 200_000, warmup: 0, warmupFraction: 0.1, confidence: 1, precision: 0, maximumReplications: 1_000, maximumWallSeconds: 60, seedFixed: flag("sim.seedFixed"), seed: num("sim.seed") },
    cancelLine: "Replicated Simulation cancelled.",
  };
}

const DEGREE: SheetField = {
  key: "degree",
  title: "Polynomial degree",
  kind: { type: "integer", min: 2, max: 40 },
  help: "Order of the polynomial basis (2–40). Cost grows quickly with degree and with the number of stations",
  glossary: g.polynomialDegree,
  setting: "sm.degree",
};

/** The spectral run's memory budget for its dense basis matrix (runner `SPECTRAL_BYTE_LIMIT`, METH-052). */
const SPECTRAL_BYTE_LIMIT = 2 * 1024 ** 3;

/** C(d + p, p)² doubles: what the infinite spectral solver's dense matrix needs for d stations at degree p. */
export function spectralBytes(stations: number, degree: number): number {
  let basis = 1;
  for (let k = 1; k <= degree; k++) basis *= (stations + k) / k;
  return basis * basis * 8;
}

/** The largest degree from 2 to `degree` whose matrix fits the budget, or null when not even 2 does. */
export function largestSpectralDegree(stations: number, degree: number): number | null {
  let fit: number | null = null;
  for (let p = 2; p <= degree; p++) if (spectralBytes(stations, p) <= SPECTRAL_BYTE_LIMIT) fit = p;
  return fit;
}

/**
 * `RunParameterSpec.spectralInfinite`. New in 2.0 (ledger METH-052, Changed): when the stored degree
 * would be refused by the 2 GB guard for this network, the sheet opens on the largest degree that
 * fits and says so in red, instead of offering a degree the run would refuse.
 */
export function spectralInfinite(stations = 0): SheetSpec {
  const stored = Math.max(2, num("sm.degree"));
  const fit = spectralBytes(stations, stored) <= SPECTRAL_BYTE_LIMIT ? stored : largestSpectralDegree(stations, stored);
  const degree = fit ?? stored;
  const notice = fit !== null && fit !== stored ? w.degreeChanged(stored, fit, stations) : undefined;
  return {
    kind: "spectral-infinite",
    title: "Run Spectral Method",
    subtitle: "Polynomial Galerkin solution of the SRBM in the orthant (BNAsm). Higher degrees are more accurate and cost more memory.",
    helpTopic: "spectralInfinite",
    tint: "info",
    confirmHelp: w.confirmHelp,
    size: "compact",
    sections: [{ title: "Basis", footer: "Degree 8–12 is enough for most networks; raise it if the reported residual is large.", notice, fields: [DEGREE] }],
    values: { degree: notice ? degree : num("sm.degree") },
    // The run reads the stored degree unless told otherwise: the changed one must reach it.
    ...(notice ? { stored: { degree: num("sm.degree") } } : {}),
    defaults: (v) => ({ "sm.degree": Math.max(2, int(v, "degree")) }),
    cancelLine: "Spectral method (infinite) cancelled.",
  };
}

/** `RunParameterSpec.spectralFinite`: the basis applies to this run only unless Set as Default. */
export function spectralFinite(): SheetSpec {
  return {
    kind: "spectral-finite",
    title: "Run Spectral Method",
    subtitle: "Polynomial Galerkin solution of the SRBM on the hypercube (fBNAsm). Higher degrees are more accurate and cost more memory.",
    helpTopic: "spectralFinite",
    tint: "info",
    confirmHelp: w.confirmHelp,
    size: "compact",
    sections: [
      {
        title: "Basis",
        footer: "The Legendre basis is better conditioned above degree 10; the monomial basis is faster below it.",
        fields: [DEGREE, { key: "legendre", title: "Use Legendre basis", kind: { type: "flag" }, help: "Recommended above degree 10, where the monomial basis becomes ill-conditioned", setting: "sm.legendre" }],
      },
    ],
    values: { degree: num("sm.degree"), legendre: flag("sm.legendre") },
    defaults: (v) => ({ "sm.degree": Math.max(2, int(v, "degree")), "sm.legendre": bool(v, "legendre") }),
    cancelLine: "Spectral method run cancelled.",
  };
}

/** `runFiniteElement()`'s mesh cap by station count d. */
export function meshCap(stations: number): number {
  if (stations < 4) return 20;
  if (stations === 4) return 8;
  if (stations === 5) return 6;
  return 4;
}

/** `RunParameterSpec.finiteElement`, opening at `min(fem.meshSize, cap)`. */
export function finiteElement(stations: number): SheetSpec {
  const cap = meshCap(stations);
  const footer = stations >= 4 ? `The mesh is capped at ${cap} for d = ${stations}: the finite-element cost grows as n^2d, so larger meshes run much longer.` : "Cost grows as n^2d in the mesh size n and the number of stations d.";
  return {
    kind: "finite-element",
    title: "Run Finite Element",
    subtitle: "Hermite finite-element solution of the SRBM density on a hypercube (fBNAfm).",
    helpTopic: "finiteElement",
    tint: "info",
    confirmHelp: w.confirmHelp,
    size: "compact",
    sections: [
      {
        title: "Discretisation",
        footer,
        fields: [
          { key: "quadrature", title: "Quadrature", kind: { type: "choice", options: ["Gauss–Legendre (recommended)", "Component-by-component quasi-Monte Carlo"] }, help: "How the element integrals are evaluated", setting: "fem.solver" },
          { key: "mesh", title: "Mesh size per dimension", kind: { type: "integer", min: 2, max: 40 }, help: "Number of elements along each axis (2–40)", glossary: g.meshSize, unit: "cells", setting: "fem.meshSize" },
        ],
      },
    ],
    values: { quadrature: num("fem.solver"), mesh: Math.min(num("fem.meshSize"), cap) },
    defaults: (v) => ({ "fem.solver": int(v, "quadrature"), "fem.meshSize": Math.max(2, int(v, "mesh")) }),
    cancelLine: "Finite element run cancelled.",
  };
}

/** `RunParameterSpec.multiClassSRBM`: research formulation, automatic mesh; no Set as Default. */
export function multiClass(): SheetSpec {
  return {
    kind: "multiclass",
    title: "Run Multi-Class SRBM",
    subtitle: "Class-aware workload diffusion: per-class traffic, compound service moments and routing covariance on infinite-buffer networks.",
    helpTopic: "multiClassSRBM",
    tint: "warning",
    confirmHelp: w.confirmHelp,
    size: "compact",
    sections: [
      {
        title: "Formulation",
        footer: "Leave the mesh at 0 to let the solver pick a dimension-aware value.",
        fields: [
          { key: "formulation", title: "Formulation", kind: { type: "choice", options: ["Research (compound service + routing variance)", "Legacy (matches production SRBM export)"] }, help: "Which set of drift and covariance formulas the solver uses", setting: "mc.formulation" },
          { key: "mesh", title: "Mesh size per dimension", kind: { type: "integer", min: 0, max: 40, emptyFor: 0 }, help: "Elements along each axis; leave blank for the automatic, dimension-aware cap", glossary: g.meshSize, unit: "cells", setting: "mc.meshSize" },
        ],
      },
    ],
    values: { formulation: 0, mesh: 0 },
    cancelLine: "Multi-class SRBM run cancelled.",
  };
}

/** `RunParameterSpec.linearProgram` (shown only with `lp.askBeforeRun` on); `d` is the station count. */
export function linearProgram(d: number): SheetSpec {
  return {
    kind: "lp",
    title: "Run Linear Program",
    subtitle: `LP relaxation of the SRBM stationary distribution (BNAlp, Saure–Glynn–Zeevi 2008) for d = ${d}.`,
    helpTopic: "linearProgramInfinite",
    tint: "info",
    confirmHelp: w.confirmHelp,
    size: "tall",
    sections: [
      {
        title: "Discretisation",
        footer: "Leave grid size and basis size blank for values auto-scaled to the number of stations.",
        fields: [
          { key: "gridN", title: "Grid size n", kind: { type: "integer", min: 0, max: 100_000, emptyFor: 0 }, help: "Constraint points per dimension; blank = auto", glossary: g.gridN, setting: "lp.gridN" },
          { key: "basisM", title: "Basis size m", kind: { type: "integer", min: 0, max: 100_000, emptyFor: 0 }, help: "Number of monomial basis functions; blank = auto", glossary: g.basisM, setting: "lp.basisM" },
          { key: "gridType", title: "Grid type", kind: { type: "choice", options: ["Exponential", "Dyadic", "Exponential (random)"] }, help: "How constraint points are spaced along each axis", setting: "lp.gridType" },
        ],
      },
      {
        title: "Solver",
        fields: [
          { key: "solver", title: "LP backend", kind: { type: "choice", options: ["Auto", "CPLEX", "GLPK", "HiGHS"] }, help: "Which linear-programming backend solves the relaxation", setting: "lp.solver" },
          { key: "smoothness", title: "Smoothness weight", kind: { type: "decimal", min: 0, max: 100_000, step: 0.1 }, help: "Penalty on the curvature of the fitted density; 0 disables it", glossary: g.smoothness, setting: "lp.smoothness" },
          { key: "normalise", title: "Normalise monomial basis", kind: { type: "flag" }, help: "Greatly improves conditioning for d ≥ 3", setting: "lp.basisNormalize" },
          { key: "multiLevel", title: "Multi-level refinement", kind: { type: "flag" }, help: "Run a coarse preview first, then refine on the full grid", setting: "lp.multiLevel" },
        ],
      },
    ],
    values: {
      gridN: num("lp.gridN"),
      basisM: num("lp.basisM"),
      // `presentLPParams` maps the stored solver and grid type through their flags; the indices agree.
      gridType: Math.min(2, Math.max(0, num("lp.gridType"))),
      solver: Math.min(3, Math.max(0, num("lp.solver"))),
      smoothness: num("lp.smoothness"),
      normalise: flag("lp.basisNormalize"),
      multiLevel: flag("lp.multiLevel"),
    },
    defaults: (v) => ({
      "lp.gridN": Math.max(0, int(v, "gridN")),
      "lp.basisM": Math.max(0, int(v, "basisM")),
      "lp.solver": Math.min(3, Math.max(0, int(v, "solver"))),
      "lp.gridType": Math.min(2, Math.max(0, int(v, "gridType"))),
      "lp.smoothness": Math.max(0, Number(v.smoothness)),
      "lp.basisNormalize": bool(v, "normalise"),
      "lp.multiLevel": bool(v, "multiLevel"),
    }),
    cancelLine: "Linear Program cancelled by user.",
  };
}

/** `RunParameterSpec.comparisonBlocking`: the finite Run Comparison's prompt. */
export function comparisonBlocking(): SheetSpec {
  return {
    kind: "comparison",
    title: "Run Comparison",
    subtitle: "Spectral, finite-element and finite-LP all solve the SRBM under manufacturing blocking. Pick the regime the simulation column should use.",
    helpTopic: "srbmHypercube",
    tint: "info",
    confirmHelp: "Run every method and tabulate the results (Return)",
    size: "compact",
    sections: [
      {
        title: "Simulation",
        footer: "BAS + external loss matches the SRBM convention, so all four methods solve the same problem.",
        fields: [
          { key: "blocking", title: "Blocking regime", kind: { type: "choice", options: BLOCKING_REGIMES }, help: "Finite-buffer convention used by the simulation column", glossary: g.bas, setting: "sim.blocking" },
          { key: "remember", title: "Skip this dialog from now on", kind: { type: "flag" }, help: "Remember this choice and use it for every comparison; change it again in Settings ▸ General" },
        ],
      },
    ],
    values: { blocking: num("sim.blocking"), remember: false },
    cancelLine: "Comparison cancelled.",
  };
}

// ── Reading the form ──────────────────────────────────────────────────────────────────────────

/** A field's text or state as the form holds it: numbers as typed text. */
export type FormState = Record<string, string | number | boolean>;

/** How a numeric value is shown in its field: whole numbers plainly, decimals as typed. */
export function fieldText(field: SheetField, v: SheetValue): string {
  if (field.kind.type === "integer" && field.kind.emptyFor !== undefined && v === field.kind.emptyFor) return "";
  return String(v);
}

export function initialForm(spec: SheetSpec): FormState {
  const out: FormState = {};
  for (const f of allFields(spec)) {
    const v = spec.values[f.key];
    out[f.key] = f.kind.type === "integer" || f.kind.type === "decimal" ? fieldText(f, v) : v;
  }
  return out;
}

export const allFields = (spec: SheetSpec) => spec.sections.flatMap((s) => s.fields);

/** A field's value from the form, or null when its text isn't a number. */
export function fieldValue(field: SheetField, form: FormState): SheetValue | null {
  const raw = form[field.key];
  switch (field.kind.type) {
    case "integer": {
      const text = String(raw ?? "");
      if (field.kind.emptyFor !== undefined && text.trim() === "") return field.kind.emptyFor;
      return parseCount(text);
    }
    case "decimal":
      return parseNumber(String(raw ?? ""));
    case "choice":
      return Number(raw);
    case "flag":
      return Boolean(raw);
  }
}

/**
 * The sheet's first blocking problem (`RunParameterSheet.problem`): the first numeric field out of
 * its range, "<Field> must be between <lo> and <hi>.", decimals as DS.Number.format writes them.
 */
export function sheetProblem(spec: SheetSpec, form: FormState): string | null {
  for (const f of allFields(spec)) {
    const k = f.kind;
    if (k.type !== "integer" && k.type !== "decimal") continue;
    const v = fieldValue(f, form) as number | null;
    if (k.type === "integer" && v === k.emptyFor) continue;
    if (v === null || !(v >= k.min && v <= k.max)) {
      return k.type === "integer" ? w.outOfRange(f.title, String(k.min), String(k.max)) : w.outOfRange(f.title, formatSig(k.min), formatSig(k.max));
    }
  }
  return null;
}

/** Every field's value; call only when `sheetProblem` is null. */
export function sheetValues(spec: SheetSpec, form: FormState): SheetValues {
  const out: SheetValues = {};
  for (const f of allFields(spec)) out[f.key] = fieldValue(f, form) ?? spec.values[f.key];
  return out;
}

/** The run's overrides: each answer the user changed, under the setting the runner reads it from. */
export function overridesFor(spec: SheetSpec, values: SheetValues): KvValues {
  const out: KvValues = {};
  for (const f of allFields(spec)) {
    if (!f.setting) continue;
    const stored = spec.stored && f.key in spec.stored ? spec.stored[f.key] : spec.values[f.key];
    if (values[f.key] !== stored) out[f.setting] = values[f.key];
  }
  return out;
}

/** The Method Reference title of a Help topic id ("Simulation"), or the id. */
export function topicTitle(id: string): string {
  for (const s of METHOD_REFERENCE) for (const [t, label] of s.topics) if (t === id) return label;
  return id;
}
