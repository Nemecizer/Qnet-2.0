// Every word Results ▸ Uncertainty shows (new in 2.1, ROADMAP D7): the command, the inputs, the
// two routes' labels, the readings, the charts and the tables.
import type { Tier } from "../results/insight";
import { pctText } from "../sensitivity/words";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "20 000": thousands set apart by a narrow no-break space. */
export const count = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
const withUnit = (value: string, unit: string) => (unit ? `${value} ${unit}` : value);

export const uncertaintyWords = {
  menuTitle: "Uncertainty…",
  commandHelp: "How sure the answer is when the arrival and service rates are only known roughly",
  keywords: ["uncertainty", "error bars", "monte carlo", "confidence", "how sure", "give or take", "sobol", "variance", "robust", "overload"],
  noNetwork: "Add a network first",
  nothingToVary: "This network has no rate to be unsure of yet: it needs a source and a station",
  view: "Uncertainty",
  viewHelp: "How sure the answer is when the rates are only known roughly",

  measureLabel: "Measure",
  measureHelp: "The number whose uncertainty is shown",
  modeLabel: "Show as",
  modes: { chart: "Charts", table: "Table" },
  modeHelp: { chart: "The distribution of the measure, and which input's uncertainty matters most", table: "Every number, with its standard error" },
  exportChart: "Export figure",
  exportChartHelp: "Save the distribution chart as PDF, PNG or SVG",

  // ── Inputs ───────────────────────────────────────────────────────────────────────────────────
  inputsTitle: "What is uncertain",
  allRates: "All rates ±",
  allRatesLabel: "Uncertainty of every rate, in per cent",
  allRatesHelp: "How well every arrival and service rate is known, unless a row below says otherwise. 0 means known exactly.",
  readingLabel: "Read ± as",
  readings: { sd: "Standard deviation", range: "Range (uniform)" },
  readingHelp: {
    sd: "The rate is its value give or take this much, as a standard deviation: a lognormal law with that mean and spread (a rate is never negative).",
    range: "The rate is anywhere within this much of its value, every value equally likely: a uniform law.",
  },
  together: "Arrival rates move together",
  togetherHelp: "On: one cause (a busy day) raises or lowers every arrival rate at once — perfectly correlated. Off: each rate is uncertain on its own.",
  independent: "Inputs are taken to be independent of one another.",
  independentTogether: "The arrival rates rise and fall together; every other input is independent.",
  colInput: "Rate",
  colNow: "Value now",
  colHow: "Uncertainty",
  colAssumed: "Read as",
  how: { default: (pct: string) => `As all rates (±${pct})`, percent: "± per cent", interval: "Interval", exact: "Known exactly" },
  howLabel: (name: string) => `How ${name} is uncertain`,
  percentLabel: (name: string) => `Uncertainty of ${name}, in per cent`,
  lowLabel: (name: string) => `Lower end for ${name}`,
  highLabel: (name: string) => `Upper end for ${name}`,
  intervalTo: "to",
  intervalHelp: {
    sd: "Read as a 95 % interval: the rate lies inside it 19 times in 20 (lognormal). A Fit from Data interval for a mean time m gives the rate's interval 1/upper to 1/lower.",
    range: "Read as a range: the rate is anywhere inside it, every value equally likely.",
  },
  assumed: {
    lognormal: (mean: string, sd: string, low: string, high: string) => `lognormal, mean ${mean}, s.d. ${sd}; 95 %: ${low} to ${high}`,
    uniform: (low: string, high: string) => `uniform; 95 %: ${low} to ${high}`,
    fixed: "known exactly",
  },
  bad: {
    percent: "Type a percentage from 0 to 300.",
    range: "A range must be under ±100 %, or the rate could reach zero. Choose less, or read ± as a standard deviation.",
    interval: "An interval needs two positive numbers, the lower one first.",
    nothing: "Nothing is uncertain yet: give at least one rate an uncertainty above zero.",
  },
  fitNote: "A rate set from Fit from Data: type the fit's 95 % interval for the rate as an Interval. Qnet does not keep the fit once it is applied.",

  // ── Tier lines ───────────────────────────────────────────────────────────────────────────────
  tierSampled: (draws: string) => `Exact solutions of ${draws} sampled cases (Jackson network)`,
  tierSampledHelp: (draws: string, solved: string, seed: number) =>
    `The uncertain rates were drawn ${draws} times and the network was solved by its exact formula for every draw (${solved} exact solutions in all, shares included). The only error is the sampling error, shown as ± (one standard error). Seed ${seed}: the same question gives the same numbers.`,
  tierLinear: (tier: string, method: string) => `Linear approximation — from numerical derivatives of ${method} (${tier})`,
  tierLinearHelp: (method: string) =>
    `No closed formula applies to this network, so the uncertainty is carried through the derivatives alone (the delta method), and the derivatives are differences over runs of ${method}. This is good while the uncertainties are small and no station is near overload, and it cannot see overload at all.`,
  experimental: "Experimental",
  experimentalHelp: "The linear route for networks with no closed formula has no exact check of its own: its derivatives are as good as the method that was differentiated.",
  valueNow: (label: string, value: string, unit: string) => `${label} as drawn: ${withUnit(value, unit)}`,
  tiers: { exact: "exact method", simulation: "simulation", approximation: "approximation", diffusion: "diffusion model", bound: "bound", mixed: "mixed" } as Record<Tier, string>,
  working: "Working…",
  progress: (done: string, total: string) => `Solving case ${done} of ${total}…`,

  // ── The statements ───────────────────────────────────────────────────────────────────────────
  overload: (pct: string, se: string) => `In ${pct} of plausible cases the network is overloaded (± ${se}).`,
  overloadHelp: "The fraction of sampled cases in which some station's utilisation reaches 1: there the queue grows without bound and the measure has no value. The ± is one standard error of that fraction.",
  noOverload: (draws: string) => `None of the ${draws} sampled cases overloads the network.`,
  allOverload: "Every sampled case overloads the network: there is nothing to report but that.",
  conditional: "The numbers below are over the cases that do have a steady state.",
  reading: (noun: string, low: string, high: string, median: string, value: string, unit: string) =>
    `With these uncertainties ${noun} is between ${low} and ${withUnit(high, unit)} in 95 % of the cases (median ${median}); as drawn it is ${value}.`,
  readingLinear: (noun: string, low: string, high: string, value: string, unit: string) =>
    `To first order ${noun} is ${withUnit(value, unit)}, give or take: between about ${low} and ${high} in 95 % of the cases.`,
  negativeLow: "The lower end is below zero, which no queue can be: a sign that the linear approximation is being pushed too far here.",
  noFiniteMean: "no finite mean (the model allows overload)",
  noFiniteSd: "not defined",
  noFiniteMeanNote:
    "These uncertainties let a station reach overload, where the measure grows without bound, so the measure has no finite mean or standard deviation over the cases with a steady state: an average of sampled cases would not settle however many were drawn, and none is shown. Read the median, the 95 % interval and the chance of overload. The shares are the linear approximation's.",
  intervalAgrees: (limit: string) => `The linear approximation's 95 % interval agrees with the sampled one to within ${limit}.`,
  intervalDisagrees: (pct: string, limit: string) => `The linear approximation's 95 % interval is off by ${pct} of the sampled interval's width (more than ${limit}): trust the sampled interval.`,
  heavyTail:
    "Some cases come close to overload, where the measure grows without bound: its mean, its standard deviation and the variance shares are dominated by those few cases and do not settle. Read the median and the interval.",
  disagree: (pct: string, limit: string) =>
    `The linear approximation is off here by ${pct} (more than ${limit}). The measure bends upwards as a station nears overload, and a straight line cannot follow it: trust the sampled answer.`,
  agree: (limit: string) => `The linear approximation agrees with the sampled answer to within ${limit} here.`,
  recommend: (name: string, pct: string, noun: string) => `Measure ${name} better: it explains ${pct} of the uncertainty in ${noun}.`,
  recommendLocal: (name: string, pct: string, noun: string) => `Measure ${name} better: close to the network as drawn it carries ${pct} of the uncertainty in ${noun} (linear approximation).`,
  recommendHelp: "The first-order share of the measure's variance that is due to this input alone. Knowing it exactly would remove that much of the variance.",
  noSpread: "These uncertainties do not move this measure at all.",
  stale: "The network has changed since these derivatives were estimated. Estimate again.",

  // ── Charts ───────────────────────────────────────────────────────────────────────────────────
  histTitle: (label: string) => `${label}: how it is spread`,
  histSubtitle: (draws: string) => `${draws} sampled cases with a steady state`,
  histAxis: (label: string, unit: string) => (unit ? `${label} (${unit})` : label),
  histY: "Share of cases",
  histCaption: (noun: string, low: string, high: string, median: string, value: string, unit: string, above: string | null) =>
    `The spread of ${noun} over the sampled cases. The shaded band is the middle 95 % (${low} to ${withUnit(high, unit)}); the solid line is the median (${median}) and the dashed line the value as drawn (${value}).${above ? ` ${above}` : ""}`,
  histAbove: (pct: string, top: string) => `The top ${pct} of cases, above ${top}, are left off so that the tail does not flatten the picture.`,
  histBeyond: (high: string) => `The band's upper end (${high}) lies beyond the right edge.`,
  histBin: (low: string, high: string, unit: string) => `${low} to ${withUnit(high, unit)}`,
  histShare: (pct: string) => `${pct} of cases`,
  legendBand: "Middle 95 % of cases",
  legendMedian: "Median",
  legendNominal: "As drawn",
  legendLinear: "Linear approximation's 95 %",
  markMedian: (v: string, unit: string) => `Median: ${withUnit(v, unit)}`,
  markNominal: (v: string, unit: string) => `As drawn: ${withUnit(v, unit)}`,
  markBand: (low: string, high: string, unit: string) => `Middle 95 %: ${low} to ${withUnit(high, unit)}`,
  markLinear: (low: string, high: string, unit: string) => `Linear approximation: ${low} to ${withUnit(high, unit)}`,
  sharesTitle: (label: string) => `${label}: whose uncertainty matters`,
  sharesSubtitle: "Share of the measure's variance due to each input",
  sharesAxis: "Share of variance (%)",
  sharesRow: "Input",
  seriesSampled: "Sampled (first-order Sobol′ index)",
  seriesLinear: "Linear approximation",
  sharesCaption: (lead: string | null) => `${lead ? `${lead} ` : ""}A whisker is the sampled share give or take two standard errors.`,
  sharesCaptionLinear: (lead: string | null) => `${lead ? `${lead} ` : ""}Shares by the linear approximation only.`,
  arrivalsTogether: "Arrival rates (together)",

  // ── Tables ───────────────────────────────────────────────────────────────────────────────────
  tableCaption: (label: string) => `${label}: sampled and by linear approximation`,
  colQuantity: "Quantity",
  colSampled: "Sampled (± standard error)",
  colLinear: "Linear approximation",
  rows: { mean: "Mean", sd: "Standard deviation", median: "Median", q025: "2.5 % quantile", q975: "97.5 % quantile", overload: "Chance of overload", nominal: "As drawn (no uncertainty)" },
  notSeen: "cannot see it",
  sharesTableCaption: "Share of the variance due to each input",
  colFirst: "Alone (first-order)",
  colTotal: "With interactions (total)",
  colLinearShare: "Linear approximation",
  colDerivative: (unit: string) => `Derivative (${unit ? `${unit} ` : ""}per unit)`,
  firstHelp: "Sobol′ first-order index: the share of the variance that knowing this input exactly would remove. Estimated from the sample; ± is one standard error.",
  totalHelp: "Sobol′ total index: the share that would remain if every other input were known exactly. Above the first-order share when inputs interact.",
  linearShareHelp: "(derivative × standard deviation)², as a share of their sum: the delta method.",
  sharesNote: (rows: string) => `Shares from ${rows} rows of a pick-freeze design (Saltelli et al. 2010).`,

  // ── Where no formula applies ─────────────────────────────────────────────────────────────────
  emptyTitle: "Nothing to be unsure of yet",
  emptyMessage: "Draw a network with a source and a station. This view then shows how sure its answers are when the rates are only known roughly.",
  brokenTitle: "This network can't be analysed yet",
  seeProblems: "The Problems pane says what to fix.",
  unstableTitle: "The network is overloaded as drawn",
  unstableHelp: "Uncertainty is measured around a network that has a steady state. Lower an arrival rate, or raise a service rate or a number of servers, then come back.",
  closedTitle: "Open networks only, for now",
  /** Starts the closed-network sentence (src/closed/shape.ts `openOnly`, core `closed::open_only`). */
  subject: "Uncertainty analysis",
  closedInstead: "What-If Sweep can vary one of its parameters instead.",
  numericTitle: "No closed formula for this network",
  numericMessage: (method: string, tier: string, runs: number, time: string | null) =>
    `Qnet can still carry the uncertainty through a linear approximation: it differentiates ${method} (${tier}) numerically, with ${plural(runs, "solver run")}${time ? `, ${time}` : ""}. Sampling is not offered here: it would take thousands of solver runs.`,
  numericAction: "Estimate",
  numericActionHelp: "Differentiates the measure in every rate by solver runs (shown in the status bar as Sensitivity; Run ▸ Stop ends it), then applies the linear approximation",
  again: "Estimate Again",
  noMethod: "No method that applies to this network can be differentiated, so its uncertainty cannot be estimated here.",
  simulationOnly: "Only simulation applies to this network, and a simulation's noise is larger than the differences this needs. Use a What-If Sweep over the rate you are least sure of instead.",
  simulationAction: "Open What-If Sweep…",
  linearOnly: "This is the linear approximation alone. It is good while uncertainties are small and no station is near overload, and it cannot tell you the chance of overload.",
  missingDerivatives: (n: number) => `${plural(n, "rate")} could not be differentiated and ${n === 1 ? "is" : "are"} left out.`,
};

export { pctText };
