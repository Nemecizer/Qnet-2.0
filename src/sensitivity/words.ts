// Every word Results ▸ Sensitivity shows (new in 2.1, ROADMAP D1): the command, the view, its
// chart and table, the plain readings and the "what would it take" list.
import type { Tier } from "../results/insight";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3.21 %" from 3.21: three significant digits, no trailing zeros ("70 %"), whole numbers from 100. */
export function pctText(percent: number): string {
  const a = Math.abs(percent);
  const text = a >= 100 ? a.toFixed(0) : a === 0 ? "0" : String(Number(a.toPrecision(a < 0.1 ? 1 : 3)));
  return `${text} %`;
}

/** "+3.33" / "−1.67": an elasticity, sign always written (a real minus sign). */
export function signed(x: number, digits = 2): string {
  const text = Math.abs(x).toFixed(digits);
  return `${x < 0 && Number(text) !== 0 ? "−" : "+"}${text}`;
}

export type Direction = "cut" | "raise";

export const sensitivityWords = {
  menuTitle: "Sensitivity…",
  commandHelp: "Which parameter moves a measure most, where the bottleneck is, and what change would reach a target",
  keywords: ["sensitivity", "bottleneck", "elasticity", "derivative", "what should I change", "improve", "target", "what would it take"],
  noNetwork: "Add a network first",
  nothingToVary: "This network has no parameter to analyse yet: it needs a source and a station",
  view: "Sensitivity",
  viewHelp: "Which parameter moves a measure most, and what change would reach a target",

  // ── Measures ─────────────────────────────────────────────────────────────────────────────────
  measureLabel: "Measure",
  measureHelp: "The number whose sensitivity is shown",
  measures: {
    networkNumber: "Mean number in the network",
    networkSojourn: "Mean delay through the network",
    stationNumber: (s: string) => `${s}: mean number in system`,
    stationQueue: (s: string) => `${s}: mean queue length`,
    stationSojourn: (s: string) => `${s}: mean sojourn time`,
    stationUtilisation: (s: string) => `${s}: utilisation`,
  },
  /** The measure inside a sentence. */
  nouns: {
    networkNumber: "the average number of customers in the network",
    networkSojourn: "the average delay through the network",
    stationNumber: (s: string) => `the average number of customers at ${s}`,
    stationQueue: (s: string) => `the average queue at ${s}`,
    stationSojourn: (s: string) => `the average time spent at ${s}`,
    stationUtilisation: (s: string) => `the utilisation of ${s}`,
  },
  units: { customers: "customers", time: "time units", ratio: "", "customers / time": "customers per time unit" } as Record<string, string>,
  groupNetwork: "Whole network",

  // ── Tier ─────────────────────────────────────────────────────────────────────────────────────
  tierFormula: "Exact — closed formula (Jackson network)",
  tierFormulaHelp: "The network is an open Jackson network, so the derivatives come from differentiating its exact formulas. Nothing was run.",
  tierDifference: (tier: string, method: string) => `${tier} — numerical derivative of ${method}`,
  tierDifferenceHelp: (method: string, stepPct: string) =>
    `No closed formula applies, so each derivative is a central difference: ${method} solved the network with the parameter ${stepPct} lower and ${stepPct} higher. The numbers are as good as ${method} is for this network, less a little for the differencing.`,
  tiers: { exact: "Exact method", simulation: "Simulation", approximation: "Approximation", diffusion: "Diffusion model", bound: "Bound", mixed: "Mixed" } as Record<Tier, string>,
  valueNow: (measure: string, value: string, unit: string) => `${measure}: ${value}${unit ? ` ${unit}` : ""}`,

  // ── Readings ─────────────────────────────────────────────────────────────────────────────────
  action: {
    load: () => "Raising every arrival rate by 1 %",
    arrival: (name: string) => `Raising the ${name} by 1 %`,
    service: (name: string) => `Raising the ${name} by 1 %`,
    routing: (name: string) => `Raising the ${name} by 1 % of its value`,
  },
  effect: (rises: boolean, noun: string, pct: string, time: boolean) => `${rises ? (time ? "lengthens" : "raises") : time ? "shortens" : "lowers"} ${noun} by about ${pct}`,
  noEffect: (noun: string) => `does not change ${noun}`,
  isBottleneck: "it is the bottleneck",
  oneMore: (station: string, from: number, to: number) => `Adding one server at ${station} (${from} → ${to})`,
  oneMoreExact: (rises: boolean, noun: string, pct: string, time: boolean) => `${rises ? (time ? "lengthens" : "raises") : time ? "shortens" : "lowers"} ${noun} by ${pct}`,
  oneMoreBuffer: (buffer: string, from: number, to: number) => `One more place in ${buffer} (${from} → ${to})`,
  bottleneck: (station: string, rho: string) => `The bottleneck is ${station}: its utilisation, ${rho}, is the highest.`,
  bottleneckTie: (stations: string, rho: string) => `${stations} share the highest utilisation, ${rho}: the network has no single bottleneck.`,
  readingsTitle: "What matters most",

  // ── Chart and table ──────────────────────────────────────────────────────────────────────────
  chartTitle: (measure: string) => `Elasticity of ${measure.charAt(0).toLowerCase()}${measure.slice(1)}`,
  chartSubtitle: "% change in the measure per 1 % change in each parameter, largest first",
  chartAxis: "Elasticity (% per %)",
  chartCaption: (measure: string, top: string | null) => `Bars to the right raise ${measure}; hatched bars to the left lower it.${top ? ` ${top}` : ""}`,
  legendRaises: "Raises the measure",
  legendLowers: "Lowers the measure",
  rowTitle: "Parameter",
  colNow: "Value now",
  colDerivative: (unit: string) => `Derivative${unit ? ` (${unit} per unit)` : " (per unit)"}`,
  colElasticity: "Elasticity (% per %)",
  colOneMore: "With one more",
  derivativeHelp: "The change in the measure per unit change in the parameter, at the network as it is now",
  elasticityHelp: "The percentage change in the measure for a 1 % change in the parameter; a number without units, so parameters can be compared",
  tableCaption: (measure: string) => `Sensitivity of ${measure.charAt(0).toLowerCase()}${measure.slice(1)} to each parameter`,
  wholeNumber: "whole number",
  oneSided: "one-sided difference (the value is at the end of its range)",
  modes: { chart: "Chart", table: "Table" },
  modeLabel: "Show as",
  modeHelp: { chart: "A ranked bar chart of the elasticities", table: "Every number: value, derivative, elasticity" },
  leftOut: (n: number) => `${plural(n, "parameter")} left out to keep the number of runs bounded: the load factor and routing probabilities go first.`,

  // ── What would it take ───────────────────────────────────────────────────────────────────────
  targetTitle: "What would it take",
  targetDirection: "Direction",
  directions: { cut: "Cut", raise: "Raise" } as Record<Direction, string>,
  targetBy: "by",
  targetPercent: "Target change, in per cent",
  targetPercentHelp: "How far the measure should move, as a percentage of its value now (0.1 to 99)",
  targetSentence: (direction: Direction, noun: string, pct: string, from: string, to: string, unit: string) => `To ${direction === "cut" ? "cut" : "raise"} ${noun} by ${pct} (from ${from} to ${to}${unit ? ` ${unit}` : ""}), change one of:`,
  targetBad: "Type a percentage between 0.1 and 99.",
  optionSet: (name: string, from: string, to: string, unit: string) => `${name}: ${from} → ${to}${unit ? ` ${unit}` : ""}`,
  optionChange: (pct: string, up: boolean) => `${up ? "+" : "−"}${pct}`,
  optionReaches: (value: string, unit: string) => `gives ${value}${unit ? ` ${unit}` : ""}`,
  infeasible: {
    noEffect: "has no effect on this measure",
    rangeEnds: (at: string, reaches: string) => `not enough: even at ${at} the measure only reaches ${reaches}`,
    levels: (reaches: string) => `not enough: however far it is taken, the measure only approaches ${reaches}`,
    overload: "not possible: a station would be overloaded before the target is reached",
    notFound: (runs: number) => `not found within ${plural(runs, "run")}`,
    unknown: "cannot reach the target",
  },
  infeasibleLabel: "Cannot do it alone",
  apply: "Apply",
  /** The undo step Apply makes: Edit ▸ Undo Apply Sensitivity Value. */
  applyUndoName: "Apply Sensitivity Value",
  applyHelp: (name: string, to: string) => `Set the ${name} to ${to} in the network (one step; Undo brings the old value back)`,
  trySweep: "Try as What-If Sweep…",
  trySweepHelp: (name: string) => `Open What-If Sweep with the ${name} running from its value now to the proposed one`,
  verified: "Each proposed value was put back into the formulas: the measure it gives is shown.",
  verifiedRuns: (method: string) => `Each proposed value was solved again by ${method}: the measure it gives is shown.`,
  findOptions: (runs: number) => `Work Out the Options (up to ${plural(runs, "run")})`,
  findOptionsHelp: "Searches for the value of each of the most influential parameters that reaches the target, by solving the network a bounded number of times",
  noOptions: "No single parameter can do this.",

  // ── Empty and partial states ─────────────────────────────────────────────────────────────────
  emptyTitle: "No network to analyse",
  emptyMessage: "Draw a network with a source, a station and a sink; Sensitivity then shows which parameter matters most.",
  working: "Working…",
  unstableTitle: "No steady state",
  brokenTitle: "The network isn't complete",
  closedTitle: "Sensitivity is for open networks",
  seeProblems: "The Problems list says what to fix.",
  unstableHelp: "Lower an arrival rate or raise a service rate until every utilisation is below 100 %; then the sensitivities can be computed.",
  numericTitle: "No closed formula for this network",
  numericMessage: (method: string, tier: string, runs: number, time: string | null) =>
    `Qnet can estimate the sensitivities by solving the network again with each parameter a little lower and a little higher, using ${method} (${tier.toLowerCase()}): ${plural(runs, "run")}${time ? `, ${time}` : ""}.`,
  numericAction: "Estimate Sensitivities",
  numericActionHelp: "Runs the method quietly for each parameter; nothing is added to Results. Run ▸ Stop ends it.",
  simulationOnlyTitle: "Only a simulation applies to this network",
  simulationOnly:
    "A derivative is the small difference between two runs, and a simulation's run-to-run noise is larger than that difference, so Qnet does not differentiate a simulation. A What-If Sweep over a wider range shows the trend with its intervals.",
  simulationAction: "Open What-If Sweep…",
  noMethod: "No method that applies to this network can be run quietly for this analysis.",
  staleNote: "The network has changed since this estimate. Run it again for the network as it is now.",
  stoppedNote: "Stopped before every parameter was done; the rest are missing.",
  again: "Estimate Again",
  experimental: "Experimental",
  experimentalHelp: "The numerical route is checked against the exact formulas on Jackson networks only; for other networks it is as trustworthy as the method it differentiates.",

  // ── The run (status bar and Status log) ──────────────────────────────────────────────────────
  started: (method: string, parameters: number, runs: number) => `Sensitivity: estimating ${plural(parameters, "parameter")} with ${method} (${plural(runs, "run")}).`,
  progress: (done: number, total: number, time: string) => `Sensitivity: run ${done} of ${total} · ${time}`,
  finished: (time: string) => `Sensitivity finished in ${time}`,
  cancelled: (time: string) => `Sensitivity stopped after ${time}`,
  failed: (time: string) => `Sensitivity failed after ${time}`,
  couldNotStart: (why: string) => `Sensitivity was not started: ${why}`,
  baseFailed: (method: string, why: string) => `${method} could not solve the network as it is: ${why}`,
  noMeasure: (method: string, measure: string) => `${method} does not report ${measure.charAt(0).toLowerCase()}${measure.slice(1)}. Choose another measure.`,
  rowFailed: "could not be solved at the nearby values",
  rowUnstable: "too close to overload to step either way",
  doneLine: (ok: number, total: number) => `Sensitivity: ${ok} of ${plural(total, "parameter")} estimated.`,
};
