// The Agreement view's words (new in 2.1, ROADMAP B3 and C3): plain words for students. The
// sentences about a method (what it is, when to trust it, why it may differ) are the Method
// Chooser's own (src/windows/methodchooser/words.ts); only the frames around them live here.
import type { Tier, Verdict } from "../../../results/insight";

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
/** "2 %", "6.2 %", "0.4 %": one decimal below ten, none for a whole number. */
export const pct = (fraction: number) => {
  // No relative scale (a zero reference): callers word that case themselves; this is the last guard.
  if (!Number.isFinite(fraction)) return REFERENCE_ZERO;
  const v = Math.abs(fraction) * 100;
  const text = v >= 100 || Number.isInteger(Number(v.toFixed(1))) ? v.toFixed(0) : v.toFixed(1);
  return `${text} %`;
};
/** A signed deviation: "+3.2 %", "−0.4 %", "0 %". */
export const signedPct = (fraction: number) => {
  const text = pct(fraction);
  if (!Number.isFinite(fraction)) return text;
  if (/^0(\.0)? %$/.test(text)) return "0 %";
  return `${fraction < 0 ? "−" : "+"}${text}`;
};

/** What stands where a percentage would, when the reference is zero and there is nothing to divide by. */
export const REFERENCE_ZERO = "reference is zero";

export const agreementWords = {
  title: "Agreement",
  tiers: {
    exact: "Exact",
    simulation: "Simulation (95 % interval)",
    approximation: "Approximation",
    diffusion: "Diffusion model",
    bound: "Bound",
    mixed: "Mixed",
  } as Record<Tier, string>,
  tierShort: { exact: "Exact", simulation: "Simulation", approximation: "Approximation", diffusion: "Diffusion model", bound: "Bound", mixed: "Mixed" } as Record<Tier, string>,
  verdicts: { exact: "Exact", agree: "Agree", close: "Close", disagree: "Disagree", single: "One method" } as Record<Verdict, string>,
  verdictHelp: {
    exact: "An exact method gives this value",
    agree: "Every method is within 2 % of the reference, or inside the simulation's interval",
    close: "Every method is within 10 % of the reference",
    disagree: "At least one method is more than 10 % from the reference",
    single: "Only one method reports this quantity",
  } as Record<Verdict, string>,

  // The banner.
  bannerLabel: "Verdict",
  exactTitle: (method: string) => `Exact result available — ${method} solves this network exactly.`,
  exactAlone: "No other method is needed to trust it; run one to see how an approximation does here.",
  /** A closed network: the second opinion is a simulation (Replicated Simulation, new in 2.1), not an approximation. */
  exactAloneClosed: "No other method is needed to trust it; Check with Another Method simulates the network and shows the exact values inside the simulation's intervals.",
  exactOthersAgree: (n: number) => `The other ${n} ${plural(n, "method agrees", "methods agree")} with it (within 2 %).`,
  exactOthersClose: (method: string, gap: string, where: string) => `The other methods are within 10 % of it; the largest gap is ${method} at ${gap} on ${where}.`,
  exactOthersDiffer: (method: string, gap: string, where: string) => `${method} differs from it by ${gap} on ${where}: trust the exact result.`,
  agreeTitle: (n: number, reference: string, byInterval: boolean) =>
    `The methods agree: ${n} ${plural(n, "method is", "methods are")} within 2 % of ${reference}${byInterval ? " or inside its interval" : ""}.`,
  agreeNoReference: (n: number) => `The methods agree: ${n} methods are within 2 % of each other.`,
  closeTitle: (reference: string) => `The methods are close: every method is within 10 % of ${reference}.`,
  closeNoReference: "The methods are close: they are within 10 % of each other.",
  closeDetail: (method: string, gap: string, where: string) => `The largest gap is ${method} at ${gap} on ${where}.`,
  disagreeTitle: (where: string, low: string, high: string, unit: string) => `The methods disagree on ${where} ranges from ${low} to ${high}${unit ? ` ${unit}` : ""}.`,
  disagreeDetail: (method: string, gap: string, reference: string) => `${method} is ${gap} from ${reference}.`,
  noReferenceDetail: "None of these methods is exact or a simulation, so nothing arbitrates between them: run one to check them.",
  singleTitle: "Only one method has run: run another to see how sure to be.",
  singleDetail: (method: string, tier: string) => `${method} (${tier}) is the only evidence so far.`,
  /** An exact run exists but shares no quantity with any other run. */
  exactNothingShared: (method: string) => `${method} is exact, but reports different quantities from the other methods, so nothing could be compared.`,
  /** An exact run exists, the others were compared among themselves, and none with it. */
  exactNotCompared: (method: string) => `${method} is exact, but reports different quantities from the other methods, so none of them was compared with it.`,
  referenceTooWide: "The simulation's interval is too wide to judge; run it longer.",
  referenceNoInterval: "The simulation gives no interval for this quantity, so only the relative difference is judged.",
  referenceZero: REFERENCE_ZERO,
  meanZero: "the methods' mean is zero",
  zeroDetail: (method: string, value: string, where: string) => `${method} gives ${value} on ${where}, where the reference is zero.`,
  partial: "partial",
  partialHelp: "This run ended early: its values are shown, but are never the reference",
  bound: "bound",
  boundHelp: "A bound, not an estimate: shown, but not scored against the reference",
  nothingSharedTitle: "These methods report different quantities, so they cannot be compared: run another to see how sure to be.",
  theSimulation: "the simulation",
  theExact: "the exact result",
  where: (station: string, cls: string, metric: string) => `${station}${cls !== "All" ? ` (${cls})` : ""}: ${metric}`,
  likelyReason: "A likely reason:",

  // Actions.
  solve: "Solve",
  solveWith: (method: string) => `Solve with ${method}`,
  solveHelp: (method: string, why: string, summary: string) => `Runs ${method}: ${why} ${summary}`,
  solveHelpIdle: "Runs the single best method for this network, by the Method Chooser's ranking, and shows how sure to be",
  solveAlready: (method: string) => `${method} has already run for this network; its result is in the Agreement view.`,
  whyExact: "an exact method applies to this network.",
  whySimulation: "no exact method applies, so a simulation is the reference.",
  whyApproximation: "it is the best-ranked method that can run here.",
  check: "Check with Another Method",
  checkWith: (method: string) => `Check with ${method}`,
  checkHelp: (method: string, why: string) => `Runs ${method}, the most informative method that has not run for this network: ${why}`,
  checkHelpIdle: "Runs the most informative method that has not run for this network, by the Method Chooser's ranking",
  checkWhyExact: "it is exact here.",
  checkWhySimulation: "no simulation has run, and a simulation arbitrates between the others.",
  checkWhyApproximation: "it is the best-ranked method left.",
  checkNone: "Every method that applies to this network has already run.",
  recommended: "Run Recommended Methods",
  recommendedHelp: "Runs, one after another, the exact method if one applies, one simulation and the two best-ranked approximations that report the headline quantities",
  recommendedNone: "The recommended methods have all run for this network.",
  rerun: "Run Them Again",
  rerunHelp: "Runs the same methods again for the network as it is now",
  chooserLink: "Choose a Method…",
  chooserHelp: "Open the Method Chooser to see the reasoning for every method",
  noAdvice: "The Method Chooser has no advice for this network yet.",
  busy: "Another run is in progress.",

  // The sequential runner.
  progressLabel: "Running methods",
  progress: (i: number, n: number, method: string) => (n === 1 ? `Running ${method}…` : `Running ${i} of ${n}: ${method}…`),
  stop: "Stop",
  stopHelp: "Stop this run and leave the rest unrun",
  dismiss: "Dismiss",
  stepStates: { pending: "waiting", running: "running", done: "done", failed: "failed", refused: "refused", stopped: "stopped", skipped: "not run", unknown: "ended" },
  /** Why a sequence ended before its last method: its tab went away or is no longer in front. */
  endedTabClosed: "The network's tab was closed, so the remaining methods were not run.",
  endedTabNotFront: "The network's tab is no longer the one in front, so the remaining methods were not run.",
  finished: (done: number, n: number) => `Ran ${done} of ${n} ${plural(n, "method")}.`,
  finishedStopped: (done: number, n: number) => `Stopped after ${done} of ${n} ${plural(n, "method")}.`,
  stepNote: (method: string, state: string, reason?: string) => `${method} ${state === "refused" ? "was refused" : state === "failed" ? "failed" : state === "stopped" ? "was stopped" : state === "unknown" ? "ended without reporting how" : "was not run"}${reason ? ` (${reason})` : ""}.`,

  // Empty, single and stale states.
  noNetworkTitle: "No Network Yet",
  noNetworkMessage: "Draw or open a network, then press Solve.",
  emptyTitle: "No Results Yet",
  emptyMessage: (key: string | undefined) => `Press Solve${key ? ` (${key})` : ""} to run the best method for this network. A second method then shows how sure to be.`,
  staleTitle: "The network changed since these runs",
  staleMessage: (n: number) => `${n} earlier ${plural(n, "run belongs", "runs belong")} to the network as it was. Run ${plural(n, "it", "them")} again to compare the methods on the network as it is now.`,
  notComparableTitle: "Nothing to Compare Yet",
  notComparableMessage: "The runs for this network did not produce measurements. Run another method.",

  // The table.
  tableLabel: "Agreement between methods, one row per quantity",
  caption: (methods: number, quantities: number, compared: number) =>
    `${methods} ${plural(methods, "method")}, ${quantities} ${plural(quantities, "quantity", "quantities")}, ${compared} reported by more than one method.`,
  columns: { quantity: "Quantity", reference: "Reference", deviation: "Other methods, as a deviation from the reference", gap: "Largest gap", verdict: "Verdict" },
  axisLow: "−10 %",
  axisMid: "0",
  axisHigh: "+10 %",
  axisLabel: (where: string) => `Each method's deviation for ${where}; arrow keys move between methods`,
  noReference: "No exact result or simulation",
  meanOfMethods: "mean of the methods",
  onlyMethod: (method: string) => `Only ${method} reports this`,
  insideInterval: "inside the simulation's interval",
  allInside: "All inside the simulation's interval",
  beyondAxis: "beyond the axis",
  interval: (low: string, high: string) => `${low} to ${high}`,
  /** `deviation` is a signed percentage, or null when none is given; `notes` are plain labels ("partial", "bound", "reference is zero"). */
  markLabel: (method: string, tier: string, value: string, unit: string, deviation: string | null, from: string, inside: boolean, clipped: boolean, notes: readonly string[] = []) =>
    `${method} (${tier}): ${value}${unit ? ` ${unit}` : ""}${deviation !== null ? `, ${deviation} from ${from}` : ""}${notes.map((n) => `, ${n}`).join("")}${inside ? `, inside the simulation's interval` : ""}${clipped ? ", beyond the axis" : ""}`,
  readout: (method: string, value: string, unit: string, deviation: string | null, inside: boolean, notes: readonly string[] = []) =>
    `${method}: ${value}${unit ? ` ${unit}` : ""}${deviation !== null ? ` (${deviation})` : ""}${notes.map((n) => ` · ${n}`).join("")}${inside ? " · inside the simulation's interval" : ""}`,
  gap: (deviation: string, method: string) => `${deviation} · ${method}`,
  sortLabel: "Sort quantities",
  sorts: { station: "By station", disagreement: "Largest disagreement first" },
  stationFilter: "Station",
  metricFilter: "Metric",
  allStations: "All stations",
  allMetrics: "All metrics",
  showUncompared: "Quantities only one method reports",
  noRows: "No quantity matches the station and metric chosen.",
  network: "Network",

  // Methods and their explanations.
  methodsLabel: "Methods read",
  methodHelp: (method: string) => `What ${method} is and when it can be trusted`,
  isReference: "the reference",
  whatItIs: "What it is",
  trustWhen: "Trust it when",
  mayDiffer: "Why it may differ here",
  notInChooser: "The Method Chooser has no entry for this method on this network.",
  ruledOut: (summary: string) => `The Method Chooser rules this method out for this network: ${summary}`,
  warnings: (n: number) => `Review the ${n} current network ${plural(n, "warning")}.`,
  /** No threshold is claimed: the Chooser gives the assumption in words only (plan.ts `LIGHT_LOAD_DISPLAY`). */
  heavyTraffic: (method: string, assumption: string, station: string, rho: string) =>
    `${method} is a heavy-traffic model (${assumption}); ${station} runs at a utilization of ${rho}, and such a model is generally less accurate the further a station is from full load.`,
} as const;
