// Every word Run ▸ Transient… shows (new in 2.1, ROADMAP D4): the command, the set-up, the two
// tiers' labels, the chart and its table, and the plain reading.

/** A time or a count in a sentence: three significant digits, no trailing zeros ("46", "12.5"). */
export function about(x: number): string {
  if (!Number.isFinite(x)) return "∞";
  const a = Math.abs(x);
  return a >= 1000 ? x.toFixed(0) : String(Number(x.toPrecision(3)));
}

/** "5 %" from 0.05. */
export const pct = (fraction: number) => `${Number((fraction * 100).toPrecision(3))} %`;

/** A small error figure in plain text: "2.1e-9". */
export function tiny(x: number): string {
  if (!(x > 0)) return "0";
  if (x < 1e-15) return "less than 1e-15";
  return x.toExponential(1).replace(/\.0e/, "e");
}

const count = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

export type InitialKind = "empty" | "steady" | "given";

export const transientWords = {
  menuTitle: "Transient…",
  commandHelp: "How the queues build up over time: how long until the network settles, and what happens after a surge of arrivals",
  keywords: ["transient", "time", "settle", "settling time", "warm-up", "surge", "rush hour", "peak", "fluid", "uniformisation", "relaxation time", "how long"],
  noNetwork: "Add a network first",
  view: "Transient",
  viewHelp: "The mean number at each station over time: how long until it settles, and what a surge does",

  // ── Set-up ───────────────────────────────────────────────────────────────────────────────────
  setupTitle: "Set-up",
  initialLabel: "Start",
  initialHelp: "The state of the network at time 0",
  initials: { empty: "Empty", steady: "In steady state", given: "Given numbers" } as Record<InitialKind, string>,
  startText: { empty: "Start: empty", steady: "Start: in steady state", given: "Start: given numbers" } as Record<InitialKind, string>,
  initialPhrase: { empty: "From empty", steady: "From its steady state", given: "From the given start" } as Record<InitialKind, string>,
  numberAt: (station: string) => `Customers at ${station} at time 0`,
  horizonLabel: "Time horizon",
  horizonHelp: "The curves are computed from time 0 to this time. Empty: the suggested horizon, twice the slowest station's relaxation time",
  timeUnits: "time units",
  suggested: (h: string) => `suggested ${h}`,
  surgeLabel: "Surge of arrivals",
  surgeHelp: "Multiply every external arrival rate by a factor between two times, then return to normal",
  surgeFactor: "Arrival rates ×",
  surgeFactorHelp: "The factor every source's arrival rate is multiplied by during the surge (2: twice as many arrivals; 0: arrivals stop)",
  surgeFrom: "from time",
  surgeUntil: "until time",
  bandLabel: "Settled within",
  bandHelp: "A station counts as settled from the time its mean number stays within this percentage of its long-run average",
  bandUnit: "% of the long-run average",
  run: "Compute",
  runAgain: "Compute Again",
  runHelp: "Compute the curves for the network as it is now",
  stop: "Stop",
  stopHelp: "Stop the exact calculation",
  running: (percent: number) => `Computing the exact curves… ${percent} %`,
  preparing: "Reading the network…",
  modeLabel: "Show as",
  modes: { chart: "Chart", table: "Table" },
  modeHelp: { chart: "The curves", table: "The same numbers as a table" },
  stationLabel: "Stations shown",
  stationHelp: "Which stations' curves are drawn",
  allStations: "All stations",
  exportChart: "Export Chart…",
  exportChartHelp: "Save the chart as a PDF, PNG or SVG file",

  // ── Problems with the set-up ─────────────────────────────────────────────────────────────────
  badHorizon: "The time horizon must be a positive number.",
  badFactor: "The surge factor must be zero or a positive number.",
  badSurge: "The surge must start at time 0 or later and end after it starts.",
  surgeBeyond: "The surge starts after the time horizon, so it would not be seen.",
  badBand: "The settling band must be a percentage between 0 and 100.",
  badNumber: (station: string) => `The number of customers at ${station} must be a whole number, 0 or more.`,

  // ── Tiers ────────────────────────────────────────────────────────────────────────────────────
  tierExact: "Exact",
  tierExactDetail: (states: number, error: string, meanBound: string | null) =>
    `the network's Markov chain on ${count(states)} states, by uniformisation; error in the distribution at most ${error}; ${meanBound === null ? "the means are lower bounds, with no bound on how far below" : `each mean is a lower bound, too low by at most ${meanBound} customers`}`,
  tierExactHelp: (levels: string, rate: string, products: number, poisson: string, tail: string) =>
    `Each station's number is cut off at ${levels}. Uniformisation rate ${rate} per time unit; ${count(products)} matrix–vector products. The error figure is the probability mass not accounted for (1 − Σp at the horizon): it bounds the whole error of the distribution, from the series cut-off (at most ${poisson} beforehand) and from the cut-off of the queue lengths (steady-state mass outside: ${tail}). The mass lost belongs to the longest queues, so it does not bound the error of a mean by itself: the bound on the means adds the steady-state mean beyond the cut-off, which the network never exceeds when it starts empty or in its steady state and is never overloaded.`,
  tierFluid: "Fluid approximation",
  tierFluidDetail: "large-scale limit; ignores randomness",
  tierFluidHelp: "The deterministic fluid model: work flows at the average rates. It shows where a backlog builds and how fast it drains; it shows no queue at a station with spare capacity, where the true queue is random.",
  noExact: "No exact curves:",
  noFluid: "No fluid curves:",
  neither: "Transient analysis does not apply to this network",
  stoppedNote: "The exact calculation was stopped: only the fluid approximation is shown.",
  staleNote: "The network or the set-up has changed since these curves were computed. Compute again to bring them up to date.",
  lostMassBounded: (mass: string, bound: string) =>
    `The exact curves lost ${mass} of the probability at the cut-off of the queue lengths. The lost part belongs to the longest queues, so the curves are lower bounds: the true means are higher, by at most ${bound} customers. A shorter or weaker surge stays inside the cut-off.`,
  meansUnbounded: (mass: string) =>
    `The surge overloads the network, so from its start the exact curves are lower bounds only: ${mass} of the probability was lost at the cut-off of the queue lengths, it belongs to the longest queues, and how much it would add to the means is not bounded. No settling time is stated.`,

  // ── Chart ────────────────────────────────────────────────────────────────────────────────────
  chartTitle: "Mean number at each station over time",
  chartSubtitle: (start: string, surge: string | null) => (surge ? `${start} · ${surge}` : start),
  surgeText: (factor: string, from: string, until: string) => `arrivals ×${factor} from time ${from} to ${until}`,
  surgeBand: (factor: string) => `Surge ×${factor}`,
  xLabel: "Time (time units)",
  yLabel: "Mean number at the station (customers)",
  unit: "customers",
  exactOf: (station: string) => `${station} · exact`,
  fluidOf: (station: string) => `${station} · fluid`,
  // The pointwise stationary approximation (new in 2.1; core `transient::psa`).
  psaOf: (station: string) => `${station} · PSA`,
  colPsa: (station: string) => `${station}: PSA (approximation)`,
  psaNone: "none",
  tierPsa: "Pointwise stationary approximation (PSA)",
  tierPsaDetail: (clipped: string | null, undefinedSomewhere: boolean) =>
    `an approximation: the steady state the network would have if each moment's rates lasted for ever${clipped ? `; it reaches ${clipped} customers, above the chart` : ""}${undefinedSomewhere ? "; not defined while the rates overload a station" : ""}`,
  tierPsaHelp:
    "A standard teaching approximation, shown so you can see where it fails. It jumps the instant a rate changes, while the true mean needs time to follow; it puts the peak congestion at the peak rate, where the true peak comes later; and it has no value at all while a segment overloads the network, however short the segment. It is good only where the rates change slowly compared with the time the queue takes to settle.",
  profileNote: (sources: string, periodic: boolean, span: string) => `Arrival rates follow the rate profile stored at ${sources}${periodic ? `, which repeats every ${span} time units` : `, which ends at time ${span}`}. Edit it in the Inspector; a surge cannot be added on top of it.`,
  profileText: "stored rate profile",
  profileCycles: (station: string, peak: string, at: string) => `The arrival rate repeats, so the mean numbers cycle and never settle. Within the time shown the mean at ${station} is highest at time ${at}: ${peak} customers.`,
  profileNeverSettles: "never: the rate repeats",
  profileNoLongRun: "With a repeating rate profile the mean number cycles; the drawn network's own steady state is not where it goes.",
  legendStationary: "long-run average (exact)",
  legendSettled: (band: string) => `settled (within ${band})`,
  atTime: (t: string) => `time ${t}`,
  caption: (reading: string, psa = false, longRun = true, breaks = false) =>
    `Solid lines: exact means. Dashed lines: fluid approximation.${psa ? " Dash-dot lines: the pointwise stationary approximation, an approximation (cut off where it leaves the chart)." : ""}${longRun ? " Dotted: each station's long-run average." : ""}${breaks ? " Faint vertical lines: where the arrival rate changes." : ""} ${reading}`,

  // ── Summary and table ────────────────────────────────────────────────────────────────────────
  summaryTitle: "By station",
  colStation: "Station",
  colUtilisation: "Utilisation",
  colStationary: "Long-run average (customers)",
  colStationaryHelp: "The exact steady-state mean number at the station (Jackson's product form)",
  colRelaxation: "Relaxation time (time units)",
  colRelaxationHelp: "1/(√(cμ) − √λ)²: the time scale on which a single queue forgets where it started. Exact for one server; a rough scale for several",
  colSettling: (band: string) => `Settled within ${band} at (time)`,
  colSettlingHelp: "The time after which the exact mean stays inside the band up to the horizon; with a surge, counted after the surge ends",
  colPeak: "Highest exact mean (customers at time)",
  colFluidPeak: "Highest fluid level (customers at time)",
  notSettled: "not within the horizon",
  notCertified: "cannot be certified",
  notCertifiedHelp: "The exact mean is a lower bound. A settling time is stated only when the mean and its error bound are both inside the band; here the error bound is wider than the band, or there is none.",
  peakAt: (value: string, time: string) => `${value} at ${time}`,
  tableCaption: "Mean number at each station over time",
  colTime: "Time (time units)",
  colExact: (station: string) => `${station}: exact mean (customers)`,
  colFluid: (station: string) => `${station}: fluid level (customers)`,
  colEmpty: (station: string) => `${station}: P(empty), exact`,
  colDistance: "Distance to steady state (total variation, 0 to 1)",

  // ── Readings ─────────────────────────────────────────────────────────────────────────────────
  settles: (start: string, station: string, time: string, band: string, mean: string) => `${start}, ${station} takes about ${time} time units to come within ${band} of its long-run average of ${mean} customers.`,
  settledFromStart: (start: string, band: string) => `${start}, every station is within ${band} of its long-run average from the first moment.`,
  afterSurge: (station: string, peak: string, peakTime: string, time: string, band: string, mean: string) =>
    `The surge lifts ${station} to a mean of ${peak} customers at time ${peakTime}; after the surge ends it takes about ${time} time units to come back within ${band} of its long-run average of ${mean} customers.`,
  surgeNoMark: (band: string) => `The surge never takes any station more than ${band} away from its long-run average.`,
  uncertifiedWide: (station: string, band: string) => `The computed mean at ${station} is a lower bound, and the bound on its error is wider than the ${band} band, so no settling time is stated: a shorter or weaker surge can be computed more precisely.`,
  uncertifiedUnbounded: (station: string, band: string) => `The surge overloads the network, so the computed mean at ${station} is a lower bound with no bound on its error, and no time to come back within ${band} is stated.`,
  notSettledReading: (station: string, band: string, mean: string, horizon: string) => `${station} has not come within ${band} of its long-run average of ${mean} customers by time ${horizon}: lengthen the time horizon to see it settle.`,
  fluidPeakReading: (station: string, peak: string, time: string, emptied: string | null) =>
    `In the fluid approximation ${station} builds up to ${peak} customers at time ${time}${emptied ? ` and is empty again at time ${emptied}` : " and has not drained by the horizon"}.`,
  fluidGrows: (station: string, rate: string) => `In the fluid approximation ${station} is overloaded: its backlog grows by about ${rate} customers per time unit and never drains.`,
  fluidFlat: "In the fluid approximation nothing accumulates: every station has spare capacity, and the fluid model does not show the random queueing that remains.",
  relaxationReading: (station: string, tau: string) => `For scale: ${station}, the slowest station, has a relaxation time of about ${tau} time units.`,

  emptyTitle: "See how the queues build up over time",
  emptyMessage: "Transient analysis shows the mean number at each station from a starting state until it settles, and what a surge of arrivals does. Draw an open network with a source, a station and a sink first.",
};
