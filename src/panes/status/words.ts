// The Status pane's and the flag bar's words, 0.90.34's to the character (StatusLog.swift,
// StatusLogExport.swift, FlagBarView.swift, NetworkEditorModel.swift, QnetCommands.swift).
// src/lib/vocabulary.ts re-exports them.

const entries = (n: number) => `${n} status entr${n === 1 ? "y" : "ies"}`;

export const statusWords = {
  // The pane (StatusLog.swift).
  title: "Status",
  greeting: "Ready. Choose a tool in the Tools pane to start building the network.",
  badgeHelp: (n: number, w: number) => `${n} entries, ${w} warnings or errors`,
  badgeHelpFiltered: (k: number, n: number, w: number) => `${k} of ${n} entries shown by the current filter · ${w} warnings or errors in total`,
  badgeLabel: (n: number) => (n === 1 ? "1 entry" : `${n} entries`),
  badgeLabelFiltered: (k: number, n: number) => (n === 1 ? `${k} of 1 entry shown` : `${k} of ${n} entries shown`),
  exportLabel: "Export status log",
  exportHelp: "Copy the visible entries, or save the status log to a text file",
  copyAll: "Copy All",
  copySelected: "Copy Selected",
  copy: "Copy",
  saveLog: "Save Status Log…",
  textSize: "Text size",
  smaller: "Decrease Text Size",
  smallerHelp: "Decrease text size (⌥⌘− or ⌘− while this pane has focus)",
  bigger: "Increase Text Size",
  biggerHelp: "Increase text size (⌥⌘= or ⌘= while this pane has focus)",
  clear: "Clear Status Log",
  clearHelp: "Clear the status log. It is not restored on the next launch, but Undo Clear in the empty log brings it back until the next clear.",
  maximize: "Maximize Status Pane",
  restoreLayout: "Restore Pane Layout",
  filterLabel: "Severity filter",
  filterHelp: "Show all entries, only warnings and errors, or only errors",
  filters: { all: "All", warnings: "Warnings", errors: "Errors" },
  searchPlaceholder: "Search status log",
  searchHint: "⌘F",
  searchHelp: "Show only the entries that contain this text. Return, ⌘G and ⇧⌘G step through the matches",
  clearSearch: "Clear search",
  matchStatus: (k: number, n: number) => `${k} of ${n}`,
  severity: { info: "Info", success: "Success", warning: "Warning", error: "Error" },
  emptyTitle: "No Status Entries",
  emptyMessage: "Solver output and warnings appear here.",
  noResults: (q: string) => (q.trim() ? `No Results for “${q.trim()}”` : "No Results"),
  noResultsMessage: "Check the spelling or try a different search.",
  clearedTitle: "Status Log Cleared",
  clearedMessage: (n: number) => `${n} entr${n === 1 ? "y was" : "ies were"} removed. Solver output and warnings appear here.`,
  undoClear: "Undo Clear",
  copied: (n: number) => `Copied ${entries(n)} to the clipboard.`,

  // Clear Status Log (NetworkEditorModel.swift `clearStatusLog`).
  clearAskTitle: "Clear the status log?",
  clearAskMessage: (n: number) =>
    `All ${n} entries will be removed and will not be restored on the next launch. Copy All keeps a copy first; Undo Clear in the empty log brings them back until the next clear.`,
  clearAskConfirm: "Clear Status Log",
  logEmpty: "The status log is empty",

  // Save Status Log… (StatusLogExport.swift).
  savePanelTitle: "Save Status Log",
  plainText: "Plain Text",
  nothingToSave: "Nothing to save — the status log is empty.",
  saved: (n: number, shown: string) => `Saved ${entries(n)} to ${shown}.`,
  couldNotSave: (reason: string) => `Could not save the status log: ${reason}`,

  // The menu bar's tooltips, as the palette's subtitles (menu tooltip → palette subtitle, MENU-203).
  clearCommandTitle: "Clear Status Log",
  clearCommandHelp: "Empty the Status pane (asks first once the log is long; Undo Clear in the empty pane brings it back)",
  exportCommandTitle: "Export Status Log…",
  exportCommandHelp: "Write the Status pane's entries, with timestamps and severities, to a text file",
  findTitle: "Search Status Log…",

  // The flag bar (FlagBarView.swift).
  flagsLabel: "Analysis flags",
  analytical: "Analytical",
  analyticalHelp: "Closed-form stationary distribution available.",
  analyticalOff: "Not analytically tractable. Click to see why.",
  analyticalHint: "Opens the tractability explanation",
  reentrant: "Re-entrant",
  reentrantOff: "Routing is feed-forward (no cycles). Click for details.",
  reentrantHint: "Opens the routing-cycle and diffusion-friendliness report",
  reentrantHelp: {
    green: "Re-entrant routing; all diffusion-friendliness criteria pass. Diffusion methods should match simulation within ~10%.",
    yellow: "Re-entrant routing; some criteria failed. Expect 10–30% under-prediction versus simulation. Click for details.",
    red: "Re-entrant routing with a Kumar–Seidman / Bramson-style pathology. Diffusion methods will under-predict; trust the simulator.",
    notReentrant: "",
  },
  warnings: "Warnings",
  warningsHelp: (n: number) => `The latest analysis produced ${n} warning${n === 1 ? "" : "s"}. Click to list them.`,
  warningsOff: "No warnings from the latest analysis.",
  warningsHint: "Opens the list of analysis warnings",
  pillLabel: (title: string, on: boolean, badge?: number) => `${title}: ${on ? "on" : "off"}${badge !== undefined ? `, ${badge}` : ""}`,

  // The Analytical popover.
  exact: "Exact",
  asymptotic: "Asymptotic",
  notTractable: "Not tractable",
  meansLabel: "Predicted mean per station",
  meansAndGamma: (label: string) => `${label} and throughput Γ`,
  station: "Station",
  mean: "Mean",
  gamma: "Γ",
  gammaGlossaryLabel: "Throughput Γ",
  gammaGlossary:
    "Γ — throughput: long-run rate of jobs leaving the station. In steady state what enters leaves, so for a stable station with unbounded buffers it equals its effective arrival rate from the traffic equations. Solvers print it as the Gamma_N line of their compact output.",
  gridHelp: (label: string, title: string) => (title ? `${label} — ${title}` : "Predicted stationary means from the matched closed-form solution"),
  ambiguousOrder: "Station names have no distinct numeric suffix, so rows are labelled by solver index (S1 … Sn) rather than by name.",
  knownClosedForm: "Network has a known closed-form stationary distribution.",
  whyEmpty: "The canvas is empty — add a source, a station and a sink to analyse the network.",
  whyNotAnalysed: "The network has not been analysed yet. Analysis runs automatically after edits; run Network ▸ Show Network Primitives for the full report.",
  whyNoMatch: "No known closed-form or asymptotic product-form stationary distribution matches this network.",
  nonExponential: "Stations with non-exponential service",
  tractableCases: "Tractable cases: Jackson (exponential service, Markovian routing), skew-symmetric SRBM, and the GCDG 2025 asymptotic regimes.",

  // The Re-entrant popover.
  reentrantHeadline: {
    green: "Diffusion-friendly",
    yellow: "Partial — accuracy degraded",
    red: "Pathological — under-prediction likely",
    notReentrant: "Feed-forward",
  },
  hasCycle: "The routing graph contains at least one directed cycle, so jobs may revisit a station.",
  emptyCanvas: "The canvas is empty — nothing to analyse yet.",
  reentrantNotAnalysed: "The network has not been analysed yet; the flag updates automatically after edits.",
  noCycle: "No directed cycle was found: no self-loop, immediate feedback (A → B → A) or longer rework loop. Every job visits each station at most once.",
  criteria: "Diffusion-friendliness criteria",
  passed: "passed",
  failed: "failed",
  implication: {
    green: "All criteria pass. Spectral / QNA / RQNA / SBD point estimates should agree with simulation within ~10%.",
    yellow: "One or two criteria failed. Expect approximations to under-predict E[Q] by 10–30% versus simulation. Cross-check with the simulator on critical stations.",
    red: "Multiple criteria fail, or a high-ρ station has heavy class-transition amplification (Kumar–Seidman / Bramson signature). Diffusion-based methods may systematically under-predict. Use queue-process simulation with confidence intervals as the reference; the LP relaxation (BNAlp / fBNAlp) supplies a complementary bound or approximation.",
    notReentrant: "Routing is feed-forward; no diffusion-friendliness concern.",
  },

  // The Warnings popover.
  issues: (n: number) => `${n} issue${n === 1 ? "" : "s"}`,
  none: "None",
  warningsNotAnalysed: "The network has not been analysed yet; warnings appear here automatically after edits.",
  noProblems: "The latest analysis found no problems: every station is stable (ρ < 1) and the routing structure is consistent.",
  listUnavailable: "The analysis flagged a problem, but the warning list is unavailable. Re-run Network ▸ Show Network Primitives to refresh.",
  primitivesHint: "Run Network ▸ Show Network Primitives for the full primitives report.",
} as const;
