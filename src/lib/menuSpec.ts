// The menu bar's layout: 0.90.34's QnetCommands.swift and WorkspaceCommands.swift as data (ledger
// section 1). Each item names a command in the one command list (src/lib/commands.ts) by id; the
// label and shortcut here are the item's own, and a command may override the label while it runs
// (`dynamicTitle`: "Restore Pane Layout", "Search Status Log…", "Stop Monte Carlo"). An item
// whose command isn't registered yet (a later phase's) shows dimmed. src/lib/menu.ts turns this
// into the native menu bar and, in a plain browser, into key handling.
//
// Shortcuts use Tauri's accelerator syntax ("CmdOrCtrl+Shift+O"). Keys that no menu can carry are
// left out here and handled by the page: ⌘? (Shift-/ types "?", which AppKit won't match), ⌃`
// and ⌃⇥ (ledger KEY-001, KEY-002), and the bare keys of the canvas and Tools menu (P5).

export type PredefinedRole =
  | "services" | "hide" | "hideOthers" | "showAll" | "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll"
  | "minimize" | "zoom" | "fullscreen" | "bringAllToFront";

export type SpecEntry =
  /** A command. `check` makes it a check-mark item; its command's `checked()` sets the mark. */
  | { id: string; label: string; accel?: string; check?: true }
  | { submenu: string; items: SpecEntry[]; role?: "window" | "help" }
  | { header: string }
  | { predefined: PredefinedRole }
  /** Items supplied at run time by a provider (src/lib/menu.ts `registerMenuProvider`). */
  | { dynamic: string }
  | "-";

const I = (id: string, label: string, accel?: string): SpecEntry => (accel ? { id, label, accel } : { id, label });
const C = (id: string, label: string, accel?: string): SpecEntry => (accel ? { id, label, accel, check: true } : { id, label, check: true });

/** Help ▸ Method Reference (ledger MENU-164 to MENU-192), in 0.90.34's order. */
export const METHOD_REFERENCE: { section: string; topics: [string, string][] }[] = [
  { section: "Concepts", topics: [["srbmOrthant", "SRBM in an Orthant"], ["srbmHypercube", "SRBM in a Hypercube"], ["analyticalTractability", "Analytical Tractability"], ["feedbackNetworks", "Feedback Networks"]] },
  {
    section: "Infinite-Buffer Methods",
    topics: [
      ["spectralInfinite", "Spectral Method"], ["qna", "QNA"], ["rqna", "RQNA"], ["sbd", "SBD"], ["simulationInfinite", "Simulation"],
      ["regenerativeSimulation", "Regenerative Monte Carlo"], ["exactSimulation", "SRBM MLMC"], ["linearProgramInfinite", "Linear Program"],
      ["adaptiveTruncatedCTMC", "Adaptive Truncated CTMC"], ["adaptiveLowRankBAR", "Adaptive Low-Rank BAR"], ["barMomentBounds", "BAR Moment Bounds"],
      ["multiClassSRBM", "Multi-Class SRBM"],
    ],
  },
  {
    section: "Finite-Buffer Methods",
    topics: [["spectralFinite", "Spectral Method"], ["finiteElement", "Finite Element"], ["finiteLP", "Finite-Buffer LP"], ["ctmc", "CTMC"], ["finiteDecomposition", "Finite-Buffer Decomposition"], ["simulationFinite", "Simulation"]],
  },
  { section: "Workflows", topics: [["keyboardShortcuts", "Keyboard Shortcuts"], ["inspector", "Editing Parameters"], ["solverInputs", "Solver Input Files"], ["testSets", "Test Sets"], ["general", "General"], ["interactiveShell", "Shell"]] },
];

export const AI_PROVIDER_TOPICS: [string, string][] = [["connectAnthropic", "Anthropic"], ["connectOpenAI", "OpenAI"], ["connectLMStudio", "LM Studio"], ["connectOllama", "Ollama"]];

/** The panes with a View ▸ Panes toggle, in menu order, with their ⌥⌘ digit (ledger MENU-066…071). */
export const PANE_TOGGLES: [string, string, string][] = [
  ["tools", "Tools", "1"], ["status", "Status", "2"], ["shell", "Shell", "3"], ["ai", "AI Assistant", "4"], ["inspector", "Inspector", "5"], ["results", "Results", "6"],
];

/** The panes that can move to a window of their own (ledger MENU-079), in menu order. */
export const DETACHABLE_PANES: [string, string][] = [["status", "Status"], ["results", "Results"], ["shell", "Shell"], ["ai", "AI Assistant"], ["inspector", "Inspector"]];

/** The Window menu's Focus items (ledger MENU-146…152), with their ⌃⌘ digit. */
export const FOCUS_ITEMS: [string, string, string][] = [
  ["canvas", "Focus Canvas", "0"], ["tools", "Focus Tools", "1"], ["status", "Focus Status", "2"], ["shell", "Focus Shell", "3"],
  ["ai", "Focus AI Input", "4"], ["inspector", "Focus Inspector", "5"], ["results", "Focus Results", "6"],
];

export const MENU_SPEC: SpecEntry[] = [
  {
    submenu: "Qnet",
    items: [
      I("app:about", "About Qnet"),
      I("app:check-updates", "Check for Updates…"),
      "-",
      I("app:settings", "Settings…", "CmdOrCtrl+,"),
      "-",
      { predefined: "services" },
      "-",
      { predefined: "hide" },
      { predefined: "hideOthers" },
      { predefined: "showAll" },
      "-",
      // Qnet's own, so the quit prompt and close guards run first (ledger MENU-007).
      I("app:quit", "Quit Qnet", "CmdOrCtrl+Q"),
    ],
  },
  {
    submenu: "File",
    items: [
      I("file:new", "New Network", "CmdOrCtrl+N"),
      I("file:open", "Open…", "CmdOrCtrl+O"),
      { submenu: "Open Recent", items: [{ dynamic: "file:recent" }, I("file:clear-recent", "Clear Menu")] },
      I("file:open-example", "Open Example…", "CmdOrCtrl+Shift+O"),
      I("file:new-from-archetype", "New from Archetype…", "CmdOrCtrl+Alt+N"),
      "-",
      I("file:close-tab", "Close Tab", "CmdOrCtrl+W"),
      I("file:close-all-tabs", "Close All Tabs", "CmdOrCtrl+Alt+W"),
      I("file:close-window", "Close Window", "CmdOrCtrl+Shift+W"),
      "-",
      I("file:save", "Save", "CmdOrCtrl+S"),
      I("file:save-as", "Save As…", "CmdOrCtrl+Shift+S"),
      "-",
      {
        submenu: "Export",
        items: [
          I("file:export-pdf", "Diagram as PDF…"),
          I("file:export-png", "Diagram as PNG…"),
          "-",
          I("file:export-fbnasim", "Finite Simulator Input (fBNAsim)…"),
          I("file:export-srbm", "SRBM Solver Input (.in)…"),
          I("file:export-qna", "QNA Input (.qna)…"),
          "-",
          I("file:export-all", "All Solver Inputs to Folder…", "CmdOrCtrl+E"),
          "-",
          I("file:export-status-log", "Status Log…"),
        ],
      },
      I("file:page-setup", "Page Setup…"),
      I("file:print", "Print Diagram…", "CmdOrCtrl+P"),
    ],
  },
  {
    submenu: "Edit",
    items: [
      // Qnet's own (src/editor/commands.ts): a focused text field gets the action through AppKit's
      // responder chain first, as 0.90.34's did, and the canvas's document gets it otherwise.
      I("edit:undo", "Undo", "CmdOrCtrl+Z"),
      I("edit:redo", "Redo", "CmdOrCtrl+Shift+Z"),
      "-",
      I("edit:cut", "Cut", "CmdOrCtrl+X"),
      I("edit:copy", "Copy", "CmdOrCtrl+C"),
      I("edit:copy-as-image", "Copy as Image", "CmdOrCtrl+Alt+C"),
      I("edit:paste", "Paste", "CmdOrCtrl+V"),
      I("edit:duplicate", "Duplicate", "CmdOrCtrl+D"),
      I("edit:delete", "Delete"),
      I("edit:delete-link", "Delete Selected Link"),
      "-",
      I("edit:select-all", "Select All", "CmdOrCtrl+A"),
      I("edit:deselect-all", "Deselect All", "CmdOrCtrl+Alt+A"),
      "-",
      I("edit:find", "Find…", "CmdOrCtrl+F"),
      I("edit:find-next", "Find Next", "CmdOrCtrl+G"),
      I("edit:find-previous", "Find Previous", "CmdOrCtrl+Shift+G"),
      "-",
      I("edit:parameters", "Edit Parameters…", "CmdOrCtrl+I"),
      "-",
      I("edit:clear-canvas", "Clear Canvas…"),
      I("edit:clear-status-log", "Clear Status Log"),
    ],
  },
  {
    submenu: "View",
    items: [
      I("view:zoom-in", "Zoom In", "CmdOrCtrl+="),
      I("view:zoom-out", "Zoom Out", "CmdOrCtrl+-"),
      I("view:actual-size", "Actual Size", "CmdOrCtrl+0"),
      I("view:zoom-to-fit", "Zoom to Fit", "CmdOrCtrl+Shift+0"),
      I("view:zoom-to-selection", "Zoom to Selection", "CmdOrCtrl+Alt+Shift+0"),
      "-",
      C("view:snap-to-grid", "Snap to Grid", "CmdOrCtrl+Alt+G"),
      "-",
      // Qnet 2.1 (ROADMAP B2): a run's value beside each station (src/canvas/overlay/commands.ts).
      {
        submenu: "Results on Canvas",
        items: [
          I("view:results-on-canvas", "Show Results on Canvas", "CmdOrCtrl+Alt+R"),
          "-",
          C("view:results-metric-utilization", "Utilization"),
          C("view:results-metric-mean-number-in-system", "Mean number in system"),
          C("view:results-metric-mean-sojourn-time", "Mean sojourn time"),
          C("view:results-metric-mean-queue-length", "Mean queue length"),
          C("view:results-metric-throughput", "Throughput"),
          "-",
          C("view:results-color", "Color Stations"),
        ],
      },
      // Qnet 2.1 (ROADMAP Phase D): closed-form results while drawing (src/live/commands.ts).
      C("view:live-results", "Live Results"),
      // Qnet 2.1 (ROADMAP Phase E): one random run played on the canvas (src/animate/commands.ts).
      C("view:animate", "Animate"),
      // Qnet 2.1 (ROADMAP C4): problems marked on the canvas (src/canvas/validation/commands.ts).
      C("view:problems-on-canvas", "Show Problems on Canvas"),
      I("view:next-problem", "Next Problem", "CmdOrCtrl+Alt+]"),
      I("view:previous-problem", "Previous Problem", "CmdOrCtrl+Alt+["),
      // Qnet 2.1 (ROADMAP E6): the network as a list, for the keyboard and VoiceOver (src/canvas/outline).
      C("view:canvas-outline", "Canvas Outline", "CmdOrCtrl+Alt+O"),
      // Qnet 2.1 (ROADMAP E6): the appearance settings src/lib/theme.ts keeps (src/lib/appearanceCommands.ts).
      {
        submenu: "Appearance",
        items: [
          C("view:appearance-system", "Match System"),
          C("view:appearance-light", "Light"),
          C("view:appearance-dark", "Dark"),
          "-",
          C("view:increase-contrast", "Increase Contrast"),
          C("view:reduce-motion", "Reduce Motion"),
          "-",
          C("view:text-size-92", "Small Text"),
          C("view:text-size-100", "Default Text Size"),
          C("view:text-size-112", "Large Text"),
          C("view:text-size-125", "Larger Text"),
          C("view:text-size-150", "Largest Text"),
        ],
      },
      {
        submenu: "Panes",
        items: [
          ...PANE_TOGGLES.map(([p, label, d]) => C(`view:pane-${p}`, label, `CmdOrCtrl+Alt+${d}`)),
          "-",
          {
            submenu: "Workspace Presets",
            items: [
              I("view:preset-build", "Build Network"),
              I("view:preset-analyze", "Analyze Results"),
              I("view:preset-run", "Run and Diagnose"),
              I("view:preset-shell", "Shell"),
              I("view:preset-canvas", "Canvas Only"),
            ],
          },
          {
            submenu: "Separate Windows",
            items: [...DETACHABLE_PANES.map(([p, label]) => C(`view:detach-${p}`, label)), "-", I("view:reattach-all", "Return All Panes to the Main Window")],
          },
          "-",
          I("view:maximize-pane", "Maximize Pane", "Ctrl+CmdOrCtrl+Enter"),
          "-",
          I("view:show-all-panes", "Show All Panes"),
          "-",
          I("view:pane-text-bigger", "Increase Pane Text Size", "CmdOrCtrl+Alt+="),
          I("view:pane-text-smaller", "Decrease Pane Text Size", "CmdOrCtrl+Alt+-"),
        ],
      },
      // Qnet 2.0's addition (D2): every command, searchable.
      I("view:command-palette", "Command Palette…", "CmdOrCtrl+Shift+K"),
      "-",
      { predefined: "fullscreen" },
    ],
  },
  {
    submenu: "Network",
    items: [
      { submenu: "Buffer Model", items: [C("network:finite-buffers", "Finite buffers — capacity and blocking apply"), C("network:infinite-buffers", "Infinite buffers — queues are unbounded")] },
      "-",
      I("network:model", "Network Model…"),
      I("network:analyze", "Analyze Network", "CmdOrCtrl+Shift+A"),
      I("network:primitives", "Show Network Primitives", "CmdOrCtrl+Shift+P"),
      "-",
      I("network:straighten", "Straighten Network"),
      I("network:straighten-fit", "Straighten and Fit to Window"),
      "-",
      {
        submenu: "Arrange",
        items: [
          I("network:align-left", "Align Left"),
          I("network:align-hcentre", "Align Horizontal Centres"),
          I("network:align-right", "Align Right"),
          "-",
          I("network:align-top", "Align Top"),
          I("network:align-vcentre", "Align Vertical Centres"),
          I("network:align-bottom", "Align Bottom"),
          "-",
          I("network:distribute-h", "Distribute Horizontally"),
          I("network:distribute-v", "Distribute Vertically"),
        ],
      },
      "-",
      I("network:random", "Generate Random Network…", "CmdOrCtrl+Shift+R"),
      I("network:insert-archetype", "Insert Archetype…"),
      "-",
      I("network:new-closed-cycle", "New Closed Cycle"),
      I("network:make-closed", "Make Closed Network"),
    ],
  },
  {
    submenu: "Tools",
    items: [
      C("tool:select", "Pointer Tool"),
      C("tool:multi-select", "Multi-Select Tool"),
      C("tool:pan", "Pan Tool"),
      "-",
      C("tool:source", "Source Tool"),
      C("tool:station", "Station Tool"),
      C("tool:buffer", "Buffer Tool"),
      C("tool:sink", "Sink Tool"),
      "-",
      C("tool:link", "Link Tool"),
    ],
  },
  {
    submenu: "Run",
    items: [
      I("run:solve", "Solve", "CmdOrCtrl+Enter"), I("run:check-another", "Check with Another Method"), I("run:recommended", "Run Recommended Methods"),
      I("run:choose-method", "Choose a Method…"),
      I("run:what-if-sweep", "What-If Sweep…"),
      I("run:sensitivity", "Sensitivity…"),
      I("run:plan-capacity", "Plan Capacity…"),
      I("run:uncertainty", "Uncertainty…"),
      I("run:transient", "Transient…"),
      I("scenario:new", "New Scenario from Current Values…"), I("scenario:compare", "Compare Scenarios…"),
      "-",
      I("run:comparison", "Run Comparison", "CmdOrCtrl+R"),
      "-",
      { header: "Infinite-Buffer Methods" },
      I("run:monte-carlo-infinite", "Run Monte Carlo…", "CmdOrCtrl+Alt+M"),
      I("run:product-form", "Run Exact Open Product Form"),
      I("run:qbd", "Run Exact Matrix-Analytic QBD"),
      I("run:truncated-ctmc", "Run Adaptive Truncated CTMC"),
      I("run:regenerative-infinite", "Run Regenerative Monte Carlo…"),
      I("run:spectral-infinite", "Run Spectral Method…", "CmdOrCtrl+Alt+S"),
      I("run:qna", "Run Whitt QNA", "CmdOrCtrl+Alt+Q"),
      I("run:rqna", "Run Whitt–You RQNA"),
      I("run:sbd", "Run SBD", "CmdOrCtrl+Alt+B"),
      I("run:mlmc", "Run SRBM MLMC", "CmdOrCtrl+Alt+E"),
      I("run:lp", "Run Linear Program", "CmdOrCtrl+Alt+L"),
      I("run:low-rank-bar", "Run Adaptive Low-Rank BAR"),
      I("run:bar-bounds", "Run BAR Moment Bounds"),
      { header: "Finite-Buffer Methods" },
      // One key per buffer-mode pair (ledger MENU-114): src/lib/menu.ts gives the key to whichever
      // of the pair is enabled, so the finite items carry the same accelerator in `pairedAccel`.
      I("run:monte-carlo-finite", "Run Monte Carlo…"),
      I("run:regenerative-finite", "Run Regenerative Monte Carlo…"),
      I("run:generic-ctmc", "Run Exact Sparse CTMC"),
      I("run:decomposition", "Run Finite-Buffer Decomposition"),
      I("run:spectral-finite", "Run Spectral Method…"),
      I("run:finite-element", "Run Finite Element…", "CmdOrCtrl+Alt+F"),
      I("run:finite-lp", "Run Finite-Buffer LP"),
      { header: "Closed Networks" },
      I("run:closed-product-form", "Run Exact Closed Product Form"),
      { header: "Priorities and Batch Arrivals" },
      I("run:priority-exact", "Run Exact Priority Queue"),
      I("run:batch-exact", "Run Exact Batch-Arrival Queue"),
      { header: "Closed and Infinite-Buffer Networks" },
      I("run:replicated-simulation", "Run Replicated Simulation…"),
      { header: "Experimental" },
      I("run:multiclass", "Run Multi-Class SRBM…"),
      "-",
      I("run:stop", "Stop Run", "CmdOrCtrl+."),
    ],
  },
  {
    submenu: "Test",
    items: [I("test:infinite", "Run Infinite Test Set…"), I("test:finite", "Run Finite Test Set…"), "-", I("test:spectral-convergence", "Run Infinite Spectral Convergence…")],
  },
  {
    submenu: "Window",
    role: "window",
    items: [
      { predefined: "minimize" },
      { predefined: "zoom" },
      "-",
      I("window:next-tab", "Show Next Tab", "CmdOrCtrl+Shift+]"),
      I("window:previous-tab", "Show Previous Tab", "CmdOrCtrl+Shift+["),
      "-",
      { dynamic: "window:tabs" },
      I("window:reopen-tab", "Reopen Closed Tab", "CmdOrCtrl+Shift+T"),
      "-",
      ...FOCUS_ITEMS.map(([p, label, d]) => I(`window:focus-${p}`, label, `Ctrl+CmdOrCtrl+${d}`)),
      {
        submenu: "Shell",
        items: [I("shell:clear", "Clear Shell", "CmdOrCtrl+K"), I("shell:find", "Find in Shell…"), "-", I("shell:restart", "Restart Shell…")],
      },
      "-",
      I("window:welcome", "Welcome to Qnet"),
      { predefined: "bringAllToFront" },
    ],
  },
  {
    submenu: "Help",
    role: "help",
    items: [
      I("help:open", "Qnet Help"),
      I("tour:start", "Guided Tour"),
      I("help:welcome", "Welcome to Qnet"),
      "-",
      I("help:topic:keyboardShortcuts", "Keyboard Shortcuts"),
      I("help:topic:exactSimulation", "SRBM MLMC Guide"),
      I("help:topic:scriptingPython", "Scripting with Python"),
      I("help:release-notes", "Release Notes"),
      I("help:check-dependencies", "Check Dependencies…"),
      I("help:failure-reports", "Show Failure Reports…"),
      "-",
      {
        submenu: "Method Reference",
        items: METHOD_REFERENCE.flatMap(({ section, topics }, i) => [
          ...(i ? ["-" as const] : []),
          { header: section },
          ...topics.map(([id, label]) => I(`help:ref:${id}`, label)),
        ]),
      },
      { submenu: "Connect an AI Provider", items: AI_PROVIDER_TOPICS.map(([id, label]) => I(`help:topic:${id}`, label)) },
    ],
  },
];

/**
 * Buffer-mode pairs that share one key (ledger MENU-114): the key goes to whichever item of the
 * pair is enabled. The first of each pair carries the key in MENU_SPEC.
 */
export const PAIRED_ACCELS: [string, string][] = [
  ["run:monte-carlo-infinite", "run:monte-carlo-finite"],
  ["run:spectral-infinite", "run:spectral-finite"],
  ["run:lp", "run:finite-lp"],
];

/** Every command id the menu names, in menu order. */
export function specCommandIds(entries: SpecEntry[] = MENU_SPEC): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e === "-") continue;
    if ("id" in e) out.push(e.id);
    else if ("submenu" in e) out.push(...specCommandIds(e.items));
  }
  return out;
}

/** The spec entry for a command id. */
export function specItem(id: string, entries: SpecEntry[] = MENU_SPEC): { id: string; label: string; accel?: string; check?: true } | undefined {
  for (const e of entries) {
    if (e === "-") continue;
    if ("id" in e && e.id === id) return e;
    if ("submenu" in e) {
      const f = specItem(id, e.items);
      if (f) return f;
    }
  }
  return undefined;
}
