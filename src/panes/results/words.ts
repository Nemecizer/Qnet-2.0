// The Results workspace's words, as 0.90.34 wrote them (ResultsWorkspace.swift, dc066f0; ledger
// §11.5, §11.6). Re-exported from src/lib/vocabulary.ts.

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export const resultsWords = {
  title: "Results",
  badgeHelp: (n: number) => `${n} persisted run ${plural(n, "record")} for this tab`,

  // The view switch (2.1).
  viewLabel: "Results view",
  views: { table: "Table", agreement: "Agreement", charts: "Charts" },
  viewHelp: { table: "Every run and its measurements", agreement: "How far the methods agree on this network, and how sure to be", charts: "The results as charts: one method's values by station, or every method side by side" },
  chartsNotYet: "Charts are offered once a run on this tab has completed",

  // The Charts view (2.1, ROADMAP B1 and B5).
  charts: {
    scopeLabel: "What the chart shows",
    scopes: { run: "One Method", methods: "All Methods" },
    scopeHelp: { run: "One run's values, station by station", methods: "Every method's value and interval for each station, on one axis" },
    runLabel: "Run to chart",
    runOption: (method: string, time: string, stale: boolean) => `${method} · ${time}${stale ? " · network changed" : ""}`,
    metricLabel: "Quantity to chart",
    metricOption: (metric: string, unit: string) => (unit ? `${metric} (${unit})` : metric),
    station: "Station",
    quantity: "Station",
    tiers: { exact: "Exact", simulation: "Simulation (95 % interval)", approximation: "Approximation", diffusion: "Diffusion model", bound: "Bound", mixed: "Mixed" } as Record<string, string>,
    reference: "reference",
    referenceLegend: "Reference: the value the others are measured against",
    interval: "Interval",
    classSeries: (label: string) => (label === "All" ? "All classes" : `Class ${label.replace(/^C/, "")}`),
    rowWithClass: (station: string, cls: string) => (cls === "All" ? station : `${station} · class ${cls.replace(/^C/, "")}`),
    runTitle: (metric: string) => `${metric} by station`,
    runSubtitle: (method: string, tier: string, stale: boolean) => `${method} · ${tier}${stale ? " · network changed since this run" : ""}`,
    runCaption: (metric: string, stations: number, method: string, top: string | null, intervals: boolean, classes: number, stale: boolean) =>
      `${metric} at ${stations} ${plural(stations, "station")}, from ${method}${classes > 1 ? `, one bar per customer class (${classes} classes)` : ""}.${top ? ` Highest: ${top}.` : ""}${
        intervals ? " The whiskers are each value's interval." : ""
      }${stale ? " The network has changed since this run." : ""}`,
    classesCut: (shown: number, all: number) => `The first ${shown} of ${all} classes are drawn; the table has them all.`,
    methodsTitle: (metric: string) => `${metric}: every method`,
    methodsSubtitle: (methods: number, reference: string | null) => `${methods} ${plural(methods, "method")}${reference ? ` · reference: ${reference}` : " · no exact result or simulation to measure against"}`,
    methodsCaption: (metric: string, methods: number, rows: number, verdict: string | null) =>
      `${metric} from ${methods} ${plural(methods, "method")} at ${rows} ${plural(rows, "station")}, each with its interval where the method gives one.${verdict ? ` ${verdict}` : ""}`,
    verdicts: {
      agree: "The methods agree (within 2 %).",
      close: "The methods are close (within 10 %).",
      disagree: "The methods disagree (by more than 10 %).",
    } as Record<string, string>,
    deviation: (pct: string, above: boolean) => `${pct} ${above ? "above" : "below"} the reference`,
    sameAsReference: "The same as the reference",
    insideInterval: "Inside the reference's interval",
    staleChip: "Network changed",
    staleLeftOut: (n: number) => `${n} earlier ${plural(n, "run is", "runs are")} left out: the network has changed since.`,
    oneMethodTitle: "Only one method has run on this network.",
    oneMethodMessage: "A second method would show how sure to be.",
    runAnother: "Check with Another Method",
    runAnotherHelp: "Run the most informative method that has not run on this network yet",
    noRunsTitle: "No Chart Yet",
    noRunsMessage: "Run a method on this network to chart its results.",
    allStaleTitle: "The Network Changed",
    allStaleMessage: (n: number) => `${n} earlier ${plural(n, "run belongs", "runs belong")} to the network as it was. Run a method again to chart the network as it is now.`,
    runMethod: "Solve",
    runMethodHelp: "Run the best method for this network",
    noMeasurementsTitle: "Nothing to Chart",
    noMeasurementsMessage: "This run did not produce per-station measurements. Choose another run, or see its transcript in the Table view.",
    exportChart: "Export Chart…",
    exportChartHelp: "Save the chart as a PDF, PNG or SVG figure, in the light appearance on white",
    copyChart: "Copy Chart",
    copyChartHelp: "Copy the chart to the clipboard as an image (PDF and TIFF)",
    savePanelTitle: "Export Chart",
    fileName: (document: string | null) => `${document ?? "Network"} Chart`,
    pdfFilter: "PDF",
    pngFilter: "PNG image",
    svgFilter: "SVG image",
    exported: (file: string) => `Exported chart to ${file}.`,
    copied: "Copied the chart to the clipboard as PDF and TIFF.",
    renderFailed: "!! Could not render the chart for export.",
    writeFailed: (file: string, reason: string) => `!! Could not write ${file}: ${reason}`,
    copyFailed: "!! Could not render the chart for the clipboard.",
    noChart: "Show a chart in the Results pane first",
  },

  // Header controls.
  compareLabel: "Compare results",
  compareHelp: "Select two or more runs and compare matching measurements",
  exportLabel: "Export results",
  exportHelp: "Copy or export the selected structured result",
  deleteLabel: "Delete Result",
  deleteHelp: "Delete the selected run record",

  // Filter bar.
  filterPlaceholder: "Filter methods, stations, metrics, or warnings",
  filterLabel: "Filter results",
  clearFilter: "Clear Filter",
  clearFilterHelp: "Clear the results filter",
  layerLabel: "Model layer filter",
  sortLabel: "Sort runs",
  layers: { all: "All layers", queue: "Queue", approximation: "Approximation", srbm: "SRBM", bound: "Bound", mixed: "Mixed" },
  sorts: { newest: "Newest", method: "Method", network: "Network" },
  /** Edit ▸ Find's title while Results has focus (QnetCommands.swift findTitle, MENU-048). */
  findTitle: "Filter Results…",

  // Run history.
  historyLabel: "Run history",
  splitLabel: "Resize the run history",
  noResultsTitle: "No Results Yet",
  noResultsMessage: "Run a method to create a reproducible record for this network.",
  noMatchTitle: "No Matching Results",
  noMatchMessage: "Change the filter to show this tab's other runs.",
  measurementCount: (n: number) => `${n} ${plural(n, "measurement")}`,
  rowHelp: (displayName: string, fidelity: string, stale: boolean) => `${displayName} · ${fidelity}${stale ? " · Network changed since this run" : ""}`,
  staleLabel: "Stale result",
  status: { running: "Running", completed: "Completed", partial: "Partial", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>,

  // Summary.
  networkChanged: "Network changed",
  networkChangedHelp: "This result remains valid for its saved network snapshot, but the current canvas no longer matches it.",
  summary: { network: "Network", capacity: "Capacity", started: "Started", elapsed: "Elapsed", fingerprint: "Fingerprint" },
  parametersHelp: "Complete parameters are retained in JSON exports",

  // Quality evidence.
  evidenceTitle: "Quality Evidence",
  statistical: "Statistical uncertainty",
  statisticalValue: (k: number, n: number) => `Reported for ${k} of ${n} measurements`,
  uncertaintyMissing: "Uncertainty missing",
  uncertaintyMissingValue: "Treat point estimates cautiously; no interval or standard error was parsed.",
  residual: "Numerical residual",
  refinement: "Reported refinement Δ",
  crossRun: "Change from prior matching run",
  crossRunValue: (abs: string, rel: string) => `max |Δ| ${abs} · max relative ${rel}`,
  crossRunHelp: (count: number, changed: string[]) =>
    `Compared ${count} matching measurements with the most recent older run of the same method and network snapshot. ${
      changed.length ? `Changed parameters: ${changed.join(", ")}.` : "The recorded solver parameters are unchanged."
    }`,
  evidenceFootnote: "Residuals and cross-run changes are numerical evidence, not statistical confidence intervals or queue-model error bounds.",

  // Measurements.
  columns: { station: "Station", customerClass: "Class", metric: "Metric", estimate: "Estimate", uncertainty: "Uncertainty / evidence", unit: "Unit" },
  sortBy: (title: string) => `Sort by ${title}`,
  measurementsLabel: (displayName: string) => `Measurements for ${displayName}`,
  waiting: "Waiting for structured measurements…",
  noMeasurements: "This run did not produce structured measurements.",
  noEvidence: "No uncertainty or numerical evidence was reported",
  interval: "Interval",
  confidenceInterval: (pct: string) => `${pct}% confidence interval`,
  standardError: "Standard error",
  sampleSize: "Sample size",
  residualHelp: "Residual",
  selectStation: "Select Station",

  // Failure card, warnings, transcript.
  runFailed: "Run Failed",
  partialResult: "Partial Result",
  nextStep: (action: string) => `Next step: ${action}`,
  /** `ResultsFailureCard.guidance`: [diagnosis, action]; a null diagnosis is the run's own message. */
  guidance: {
    partial: [null, "Use the retained estimates as provisional evidence only. Review the convergence or fallback note, then increase the relevant safeguard or choose the recommended scalable method."],
    notFound: ["The selected solver executable could not be located.", "Build the algorithm from its folder, then run it again. If it was moved, restore the Qnet folder layout."],
    permission: ["macOS refused to launch or read a required solver file.", "Check that the executable and its input folder are readable and executable, then retry."],
    unstable: [
      "The supplied network does not satisfy this method's steady-state stability condition.",
      "Use Analyze Network to inspect station load, then reduce offered load or increase service capacity before rerunning.",
    ],
    singular: ["The numerical system became singular or non-finite.", "Check the network warnings and method assumptions. Then retry with a coarser, well-scaled discretization before refining."],
    infeasible: ["The optimization model did not yield a bounded feasible solution.", "Check SRBM stability and boundary conventions, then increase the grid or basis gradually and rerun."],
    killed: [
      "The process was likely stopped because the selected resolution exceeded available resources.",
      "Reduce degree, mesh, grid, basis size, or parallel workers, then refine one setting at a time.",
    ],
    timeout: ["The solver did not finish within its allowed time.", "Lower the run length or discretization for a diagnostic run, then increase it gradually."],
    other: [null, "Open the Solver Transcript below, start with its last error line, and verify the active network's warnings and method assumptions before rerunning."],
  } as Record<string, [string | null, string]>,
  warningsTitle: "Warnings",
  transcript: "Solver Transcript",
  transcriptCaption: "Verbatim standard output retained for audit and diagnostics.",
  copyTranscript: "Copy Transcript",

  // Delete.
  deleteTitle: "Delete this result?",
  deleteMessage: "The persisted run record and its measurements will be removed. The network is not changed.",
  deleteConfirm: "Delete Result",

  noRunTitle: "No Run Selected",
  noRunMessage: "Select a run to inspect its measurements.",

  // Compare.
  noVisibleRuns: "No visible runs",
  showComparison: "Show Comparison",
  clearComparison: "Clear Comparison",
  comparisonTitle: "Run Comparison",
  runsBadge: (n: number) => `${n} runs`,
  crossesLayers: "These runs cross model layers. Agreement between SRBM methods checks SRBM numerics; it does not independently validate the queueing-process approximation.",
  differentSnapshots: "The selected runs used different network snapshots; differences may reflect changed inputs as well as methods.",
  noComparableTitle: "No Comparable Measurements",
  noComparableMessage: "The selected runs have no structured measurements yet. Their solver transcripts remain available in each run.",
  range: "Range",
  comparisonLabel: (n: number) => `Comparison of ${n} result runs`,

  // Export.
  copyCsv: "Copy Selected Run as CSV",
  saveCsv: "Save Selected Run as CSV…",
  saveJson: "Save Selected Run as JSON…",
  saveVisibleCsv: "Save Visible Runs as CSV…",
  saveVisibleJson: "Save Visible Runs as JSON…",
  csvFilter: "Comma-separated values",
  jsonFilter: "JSON",
  fileName: (format: "csv" | "json", count: number) => `${count === 1 ? "qnet-result" : "qnet-results"}.${format}`,
} as const;
