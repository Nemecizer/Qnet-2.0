// Every word Fit from Data… shows (new in 2.1, ROADMAP D2). The sentences that depend on the
// numbers (why a family does not apply, the recommendation's reason, the warnings) are written
// where the numbers are, in src-tauri/src/fit.rs.
import { MIN_POINTS } from "./model";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export const fitWords = {
  button: "Fit from Data…",
  buttonHelp: "Choose this distribution from measured times: paste or load the data, compare the families, and use the one that fits",
  panelTitle: "Fit a Distribution from Data",
  panelSubtitle: (target: string) => `Measured times for ${target}`,
  targetService: (station: string) => `the service time at ${station}`,
  targetServiceClass: (station: string, cls: string) => `the ${cls} service time at ${station}`,
  targetArrival: (source: string) => `the time between arrivals from ${source}`,

  // ── Data ─────────────────────────────────────────────────────────────────────────────────────
  sectionData: "Data",
  dataLabel: "Measured times",
  dataPlaceholder: "Paste numbers here: one per line, or separated by commas, tabs or spaces. A table copied from a spreadsheet works too.",
  dataHelp: "The times you measured, in any one unit. You can also drop a CSV or text file here.",
  chooseFile: "Choose File…",
  chooseFileHelp: "Read the numbers from a CSV or plain-text file",
  chooseFileTitle: "Choose a Data File",
  fileFilter: "Data (CSV or text)",
  example: "Use Example Data",
  exampleHelp: "Fill in 60 made-up service times, to see how fitting works",
  clear: "Clear",
  clearHelp: "Remove the data",
  fromFile: (name: string) => `From ${name}.`,
  fileFailed: (why: string) => `Qnet couldn't read the file. ${why}`,
  dropHere: "Drop the file to read its numbers",
  column: "Column",
  columnHelp: "The data have several columns: choose the one that holds the times",
  columnName: (index: number, header: string | null, count: number) => `${header ?? `Column ${index + 1}`} (${plural(count, "number")})`,
  eventTimes: "These are event times: use the gaps between them",
  eventTimesHelp: "Switch on when the numbers are the clock times at which things happened (arrivals, departures) rather than durations. Qnet sorts them and fits the gaps: n times give n − 1 gaps.",
  decimalComma: "Commas are decimal marks (1,5 means 1.5)",
  decimalCommaHelp: "How to read a comma: as the decimal mark, or as the separator between two numbers",
  dropZeros: (n: number) => `Leave out the ${plural(n, "zero")}`,
  dropZerosHelp: "A zero is usually a missing measurement or two events with the same time stamp. Most families cannot produce an exact zero.",

  read: (n: number) => `${plural(n, "number")} read.`,
  gaps: (times: number, gaps: number, sorted: boolean) => `${plural(times, "event time")}${sorted ? ", sorted into time order," : ""} give ${plural(gaps, "gap")}.`,
  skipped: (cells: string[]) => {
    const shown = cells.slice(0, 3).map((c) => `“${c.length > 16 ? `${c.slice(0, 15)}…` : c}”`);
    return `${plural(cells.length, "cell")} that ${cells.length === 1 ? "is" : "are"} not ${cells.length === 1 ? "a number" : "numbers"} ${cells.length === 1 ? "was" : "were"} left out (${shown.join(", ")}${cells.length > 3 ? ", …" : ""}).`;
  },
  ambiguousComma: "Every value has one comma, so Qnet cannot tell 1,5 (one and a half) from 1 and 5. It read the commas as separators; tick “Commas are decimal marks” if they are not.",

  problems: {
    empty: "Paste or load at least 10 measured times.",
    noNumbers: "Qnet found no numbers in the data.",
    tooFew: (n: number, eventTimes: boolean) =>
      `Qnet needs at least ${MIN_POINTS} ${eventTimes ? "gaps (11 event times)" : "observations"} to fit a distribution, and there ${n === 1 ? "is" : "are"} ${n}. With so few, even the mean is uncertain by a large factor.`,
    negatives: (n: number) =>
      `${plural(n, "value")} ${n === 1 ? "is" : "are"} negative. A service or inter-arrival time cannot be negative: remove ${n === 1 ? "it" : "them"}, or if these are event times, tick “These are event times”.`,
    allZero: "Every value is zero, so there is no time to fit.",
  },
  fitting: "Fitting…",
  failed: (why: string) => `The fit failed. ${why}`,

  // ── Summary ──────────────────────────────────────────────────────────────────────────────────
  sectionSummary: "The sample",
  n: "Observations",
  mean: "Mean",
  scv: "SCV",
  scvHelp: "Squared coefficient of variation: variance ÷ mean². 0 is constant, 1 is exponential, above 1 is burstier.",
  sd: "Standard deviation",
  rate: "Rate (1 ÷ mean)",
  range: "Min · median · max",
  quartiles: "Quartiles",
  interval: (lo: string, hi: string) => `95 % interval ${lo} to ${hi}`,
  intervalBootstrap: (resamples: number) => `Intervals: percentile bootstrap, ${resamples.toLocaleString("en-US")} resamples (the same data always give the same interval).`,
  intervalAsymptotic: "Intervals: large-sample (normal) approximation.",
  timeUnit: "time units",
  rateUnit: "per time unit",
  unitNote: "Qnet has no time units of its own: every time above is in the unit of your data, and every rate is per that unit. Use the same unit for every source and station in the network.",

  // ── Candidates ───────────────────────────────────────────────────────────────────────────────
  sectionCandidates: "Candidate distributions",
  fitBy: "Fit by",
  methods: { mle: "Maximum likelihood", moments: "Mean and SCV" } as const,
  fitByHelp: "Maximum likelihood finds the parameters under which the data are most probable. Mean and SCV makes the distribution's first two moments equal the sample's.",
  mleNote: "Maximum likelihood uses the whole shape of the data. It is the right choice for simulation and for the exact Markov-chain methods, which use the whole distribution.",
  momentsNote: "QNA, RQNA, the diffusion (SRBM) methods and the bounds read only the mean and the SCV of a distribution. Matching those two numbers gives these methods exactly what the data say, whatever the family.",
  table: "Candidate distributions, best first",
  colChoose: "Use",
  colFamily: "Distribution",
  colParameters: "Parameters",
  colMean: "Mean",
  colScv: "SCV",
  colLogLik: "Log-likelihood",
  colAic: "AIC",
  colKs: "KS distance",
  colKsP: "KS p-value",
  aicHelp: "Akaike's information criterion: 2 × parameters − 2 × log-likelihood. Lower is better; a difference under 2 is not worth acting on.",
  ksHelp: "Kolmogorov–Smirnov distance: the largest gap between the data's distribution function and the fitted one. Smaller is better.",
  ksPHelp: "Approximate. The p-value assumes the distribution was fixed before the data were seen; here its parameters were fitted to these data, so it is optimistic (too large). A small value is still strong evidence against the family.",
  ksCaveat: "KS p-values are approximate, and optimistic because the parameters were fitted to these same data. Use them to rule a family out, not to prove one right.",
  recommended: "Recommended",
  recommendedLine: (name: string, reason: string) => `Recommended: ${name}. ${reason}`,
  notApplicable: "Does not apply",
  choose: (name: string) => `Use ${name}`,
  none: "—",
  noCandidate: "No family can be used with these data.",
  meanOnly: "mean only",

  // ── Charts ───────────────────────────────────────────────────────────────────────────────────
  densityTitle: "Histogram and fitted density",
  densitySubtitle: (name: string) => `Bars: the data. Line: ${name}.`,
  densityCaption: (n: number, bins: number, name: string) =>
    `${plural(n, "observation")} in ${plural(bins, "bin")}, drawn as a density so the bars and the fitted curve share one scale. Where the ${name} curve runs through the tops of the bars, the family describes the data.`,
  cdfTitle: "Distribution function",
  cdfSubtitle: (name: string) => `Steps: the data. Line: ${name}.`,
  cdfCaption: (name: string, ks: string | null) =>
    `The fraction of observations at or below each time (steps) against the fitted ${name} distribution function.${ks ? ` The largest vertical gap between them is the KS distance, ${ks}.` : ""}`,
  axisTime: "Time (units of the data)",
  axisDensity: "Density",
  axisFraction: "Fraction at or below",
  legendData: "Data",
  bin: (lo: string, hi: string) => `${lo} to ${hi}`,
  binCount: (n: number) => plural(n, "observation"),
  binExpected: (name: string, expected: string) => `${name} expects ${expected}`,
  cdfAt: (x: string) => `Time ${x}`,
  cdfObserved: (f: string) => `Observed ${f}`,
  cdfFitted: (name: string, f: string) => `${name} ${f}`,
  tableInterval: "Interval",
  tableCount: "Observations",
  tableExpected: (name: string) => `Expected under ${name}`,
  tableTime: "Time",
  tableObserved: "Observed fraction",
  tableFitted: (name: string) => `${name} fraction`,

  // ── Footer ───────────────────────────────────────────────────────────────────────────────────
  use: "Use This Distribution",
  useHelp: (law: string, target: string) => `Set ${target} to ${law}. One step of Undo takes it back.`,
  useBlocked: "Fit some data and choose a distribution first",
  cancel: "Cancel",
  cancelHelp: "Close without changing the network",
  applied: (law: string) => `Fitted from data: ${law}.`,
};

export { plural };
