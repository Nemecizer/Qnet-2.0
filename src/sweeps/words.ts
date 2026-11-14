// Every word Run ▸ What-If Sweep… shows (new in 2.1, ROADMAP B4): the panel, the status bar and
// Status lines, the Results pane's Sweep view, its table and its CSV.
import type { Tier } from "../results/insight";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "about 3 seconds", "about 2 minutes", "under a second". */
export function aboutTime(seconds: number): string {
  if (seconds < 1) return "under a second";
  if (seconds < 90) return `about ${plural(Math.round(seconds), "second")}`;
  if (seconds < 5400) return `about ${plural(Math.round(seconds / 60), "minute")}`;
  return `about ${plural(Math.round(seconds / 3600), "hour")}`;
}

export const sweepWords = {
  menuTitle: "What-If Sweep…",
  commandHelp: "Vary one parameter over a range and plot how a measure responds, by one method or several",
  noNetwork: "Add a network first",
  busy: "A run is in progress; stop it or wait for it first",
  nothingToVary: "This network has no parameter a sweep can vary yet: it needs a source and a station",
  runLabel: "What-If Sweep",

  // ── Parameters ───────────────────────────────────────────────────────────────────────────────
  groups: { load: "Whole network", population: "Closed network", arrival: "Arrival rates", service: "Service rates", servers: "Servers", buffer: "Buffer sizes", routing: "Routing probabilities" },
  loadLabel: "Load factor (every arrival rate × this)",
  loadAxis: "Load factor",
  populationLabel: "Population (customers circulating)",
  populationAxis: "Population N",
  populationUnit: "customers",
  arrivalLabel: (source: string) => `${source} arrival rate`,
  arrivalAxis: (source: string) => `Arrival rate at ${source}`,
  serviceLabel: (station: string) => `${station} service rate`,
  serviceAxis: (station: string) => `Service rate at ${station}`,
  serviceClassLabel: (station: string, cls: number) => `${station} service rate, Class ${cls}`,
  serviceClassAxis: (station: string, cls: number) => `Service rate at ${station}, Class ${cls}`,
  serversLabel: (station: string) => `${station} number of servers`,
  serversAxis: (station: string) => `Servers at ${station}`,
  bufferLabel: (buffer: string) => `${buffer} size`,
  bufferAxis: (buffer: string) => `Size of ${buffer}`,
  routingLabel: (from: string, to: string, rest: string, cls: number | null) => `${from} → ${to} probability${cls === null ? "" : `, Class ${cls}`} (${from} → ${rest} takes the rest)`,
  routingAxis: (from: string, to: string) => `Probability ${from} → ${to}`,
  rateUnit: "per time unit",
  serversUnit: "servers",
  bufferUnit: "customers",

  // ── The panel ────────────────────────────────────────────────────────────────────────────────
  panelTitle: "What-If Sweep",
  panelSubtitle: (network: string) => `How one measure of “${network}” changes as one parameter varies`,
  sectionQuestion: "What to vary",
  sectionMethods: "Methods",
  sectionMeasure: "What to plot first",
  parameter: "Parameter",
  parameterHelp: "The one value the sweep changes; everything else stays as it is",
  from: "From",
  to: "To",
  rangeHelp: (now: string) => `The parameter's first and last value. It is ${now} now.`,
  nowIs: (now: string, unit: string) => `Now ${now}${unit ? ` ${unit}` : ""}`,
  stableUpTo: (edge: string) => `The network is overloaded beyond ${edge}; points there are left out.`,
  stableFrom: (edge: string) => `The network is overloaded below ${edge}; points there are left out.`,
  points: "Points",
  pointsHelp: (max: number) => `How many values between From and To (2 to ${max})`,
  measure: "Measure",
  measureHelp: "Every measure is kept; this is the one the chart opens on",
  station: "Station",
  stationHelp: "Every station is kept; this is the one the chart opens on",
  methodsFinding: "Asking which methods apply…",
  methodsNone: "No method that applies to this network runs quickly enough for a sweep.",
  methodHelp: (name: string, tier: string, seconds: string) => `${name} — ${tier}. A point takes ${seconds}: an estimate, the median of recorded runs of the example networks.`,
  methodHelpUnmeasured: (name: string, tier: string) => `${name} — ${tier}. No recorded run to estimate a point's time from.`,
  methodHelpSimulation: (name: string, tier: string) => `${name} — ${tier}. A point's time is set almost entirely by the run length in Settings, not by the network.`,
  slowWarning: (names: string) => `${names} simulate${names.includes(" and ") || names.includes(",") ? "" : "s"} every point afresh: the time is set by the run length in Settings and can be minutes. Stop is live throughout.`,
  /** `time` is null when nothing ticked has a measured time; `simulation` when a simulation is ticked. */
  summary: (points: number, methods: number, time: string | null, simulation = false) =>
    `${plural(points, "point")} × ${plural(methods, "method")}; ${time === null ? (simulation ? "the time is set by the simulation's run length" : "no estimate of the time") : simulation ? `${time}, plus the simulation (set by its run length)` : time}.`,
  run: "Run Sweep",
  runHelp: "Run every point with every ticked method, then show the chart in Results",
  runBlocked: "Fix the problem shown before running",
  cancel: "Cancel",
  cancelHelp: "Close without running",
  problems: {
    noParameter: "Choose a parameter",
    badFrom: "From isn't a number",
    badTo: "To isn't a number",
    sameEnds: "From and To must differ",
    belowMin: (min: string, strict: boolean) => (strict ? `Values must be above ${min}` : `Values can't be below ${min}`),
    aboveMax: (max: string) => `Values can't be above ${max}`,
    whole: "This parameter takes whole numbers",
    badPoints: (max: number) => `Points must be between 2 and ${max}`,
    noMethod: "Tick at least one method",
  },

  // ── Running ──────────────────────────────────────────────────────────────────────────────────
  progress: (done: number, total: number, time: string) => `Point ${done} of ${total} · ${time}`,
  started: (parameter: string, from: string, to: string, points: number, methods: string) => `What-If Sweep: ${parameter} from ${from} to ${to}, ${plural(points, "point")}, by ${methods}.`,
  finished: (time: string) => `What-If Sweep finished in ${time}`,
  cancelled: (time: string) => `What-If Sweep cancelled after ${time}`,
  failed: (time: string) => `What-If Sweep failed after ${time}`,
  cancelledLine: (done: number, total: number) => `What-If Sweep cancelled. ${done} of ${plural(total, "run")} had finished; the chart shows those.`,
  cancelledNothing: "What-If Sweep cancelled before its first point finished.",
  doneLine: (ok: number, total: number, gaps: number) => `What-If Sweep finished: ${ok} of ${plural(total, "run")} gave a result${gaps ? `; ${plural(gaps, "point")} left out (see the Sweep view)` : ""}.`,
  nothingLine: "What-If Sweep finished without a single result; the Sweep view says why for each method.",
  couldNotStart: (why: string) => `What-If Sweep couldn't start: ${why}`,
  methodRefused: (method: string, why: string) => `${method} was left out of the sweep: ${why}`,
  skippedAfterRefusal: "Left out: the method refused this network",
  notRun: "Not run: the sweep was stopped",

  // ── The Sweep view ───────────────────────────────────────────────────────────────────────────
  view: "Sweep",
  viewHelp: "The last what-if sweep of this tab: one measure against one parameter, a line per method",
  emptyTitle: "No sweep yet",
  emptyMessage: "A what-if sweep varies one parameter — an arrival rate, a service rate, a buffer size — and plots how a measure responds, by as many methods as you like.",
  emptyAction: "What-If Sweep…",
  noValuesTitle: "Nothing to plot",
  noValuesMessage: "No point of this sweep gave a result. The table below says why for each method.",
  measureLabel: "Measure",
  stationLabel: "Station",
  modeLabel: "Show as",
  modes: { chart: "Chart", table: "Table" },
  modeHelp: { chart: "A line per method", table: "The same numbers, a row per point" },
  again: "Sweep Again…",
  againHelp: "Open the sweep panel with this sweep's choices",
  exportChart: "Export Chart…",
  exportChartHelp: "Save the chart as a PDF, PNG or SVG figure",
  exportData: "Export Data…",
  exportDataHelp: "Save every point of the measure shown as CSV",
  exportAllHelp: "Save every measurement of every point as CSV",
  apply: (parameter: string, value: string) => `Apply ${parameter} = ${value}`,
  applyIdle: "Apply This Value",
  applyHelp: (parameter: string, value: string) => `Set ${parameter} to ${value} in the network (one undo step)`,
  applyIdleHelp: "Point at a value on the chart, or move to it with the arrow keys, then apply it to the network",
  applyRow: "Apply",
  applied: (parameter: string, value: string) => `Set ${parameter} to ${value} from the sweep.`,
  applyGone: (parameter: string) => `The network no longer has “${parameter}”, so the value wasn't applied.`,
  applyOutOfRange: (parameter: string, value: string, why: string) => `${parameter} can't be set to ${value} in the network as it is now (${why.charAt(0).toLowerCase()}${why.slice(1)}), so nothing was applied.`,
  applySame: (parameter: string, value: string) => `${parameter} is already ${value}.`,
  undoName: "Apply Sweep Value",
  staleNote: "The network has changed since this sweep ran.",
  stoppedNote: "This sweep was stopped early: the points that finished are shown.",
  rules: { current: "now", limit: "overloaded beyond", limitBelow: "overloaded below" },
  tiers: { exact: "Exact", simulation: "Simulation (95 % interval)", approximation: "Approximation", diffusion: "Diffusion model", bound: "Bound", mixed: "Mixed" } as Record<Tier, string>,
  tierShort: { exact: "exact", simulation: "simulation", approximation: "approximation", diffusion: "diffusion model", bound: "bound", mixed: "mixed" } as Record<Tier, string>,
  interval: "95 % interval",
  title: (measure: string, station: string, parameter: string) => `${measure} at ${station} against ${parameter.charAt(0).toLowerCase()}${parameter.slice(1)}`,
  subtitle: (network: string, methods: number, points: number) => `${network} · ${plural(methods, "method")} · ${plural(points, "point")}`,
  axisWithUnit: (name: string, unit: string) => (unit ? `${name} (${unit})` : name),
  stationWithClass: (station: string, cls: number) => `${station}, Class ${cls}`,
  wholeNetwork: "Whole network",
  caption: (measure: string, station: string, parameter: string, from: string, to: string, methods: string[], trend: string | null, gaps: number, limit: string | null) =>
    `${measure} at ${station} as ${parameter.charAt(0).toLowerCase()}${parameter.slice(1)} goes from ${from} to ${to}, according to ${list(methods)}.` +
    (trend ? ` ${trend}` : "") +
    (limit ? ` ${limit}` : "") +
    (gaps ? ` ${plural(gaps, "value")} could not be computed and ${gaps === 1 ? "is" : "are"} left as ${gaps === 1 ? "a gap" : "gaps"}.` : ""),
  trend: (method: string, first: string, last: string, rises: boolean) => `By ${method} it ${rises ? "rises" : "falls"} from ${first} to ${last}.`,
  trendFlat: (method: string, value: string) => `By ${method} it stays at ${value}.`,
  limitSentence: (edge: string, above: boolean) => `The network is overloaded ${above ? "beyond" : "below"} about ${edge}, where the measure grows without bound.`,
  tableCaption: (measure: string, station: string) => `${measure} at ${station}, a row per point`,
  gapReasons: { unstable: "Overloaded", refused: "Refused", failed: "Failed", skipped: "Left out", stopped: "Not run", missing: "Not reported" },
  missingSentence: (method: string, measure: string, station: string) => `${method} doesn't report ${measure} at ${station}.`,
  methodNotes: "Left out",
  csvFileName: (stem: string | null) => `${stem ?? "Untitled"} Sweep.csv`,
  csvFilter: "Comma-Separated Values",
  csvSaveTitle: "Export Sweep Data",
  csvSaved: (name: string) => `Saved the sweep's data as ${name}.`,
  csvFailed: (name: string, why: string) => `Couldn't save ${name}: ${why}`,
  csvHead: { method: "Method", tier: "Tier", station: "Station", cls: "Class", measure: "Measure", unit: "Unit", estimate: "Estimate", low: "Interval low", high: "Interval high", note: "Note" },
};

/** "QNA", "QNA and RQNA", "QNA, RQNA and Simulation". */
export function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export { plural };
