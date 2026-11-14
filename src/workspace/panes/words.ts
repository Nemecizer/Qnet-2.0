// The words of the pane layout: View ▸ Panes, Window ▸ Focus, the top bar's Workspace menu and
// pane toggles, the pane headers' window control, the corner grips and detached windows. Quoted
// from 0.90.34 (WorkspaceCommands.swift, ContentView.swift, PaneChrome.swift,
// CornerResizeOverlay.swift, PaneDetachment.swift, QnetCommands.swift) where the ledger quotes them.
import type { PaneId } from "../focus";

/** FocusRouter.Pane `displayName`. */
export const PANE_NAME: Record<PaneId, string> = {
  tools: "Tools",
  canvas: "Canvas",
  status: "Status",
  results: "Results",
  shell: "Shell",
  ai: "AI Assistant",
  inspector: "Inspector",
};

/** "45 %": a fraction as the tooltips print it, with a narrow no-break space. */
export const percent = (fraction: number) => `${Math.round(fraction * 100)} %`;

export const paneWords = {
  // View ▸ Panes toggles (MENU-066…071), the tooltip says what a click would do.
  paneToggleHelp: (pane: string, visible: boolean) => (visible ? `Hide the ${pane} pane` : `Show the ${pane} pane`),
  presetsHelp: "Apply a saved pane arrangement for a common workflow",
  separateWindowsHelp: "Give a pane a window of its own — it leaves the main window's layout and keeps its own size and position",
  separateWindowsToolbarHelp: "Give a pane a window of its own, or bring one back",

  // Presets (WS-073…078).
  presetBuild: "Build Network",
  presetBuildHelp: "Show the drawing tools, inspector and status log",
  presetAnalyze: "Analyze Results",
  presetAnalyzeHelp: (f: number) => `Give the structured Results workspace ${percent(f)} of the window, with the inspector and status log for context`,
  presetRun: "Run and Diagnose",
  presetRunHelp: "Show results, solver output and the status log together",
  presetShell: "Shell",
  presetShellHelp: (f: number) => `Make the interactive shell the second half of the window — it takes ${percent(f)} of the window's height, with the network above and the status log for context`,
  presetCanvas: "Canvas Only",
  presetCanvasHelp: "Hide every pane without changing the network",

  // Maximize (WS-082).
  maximize: "Maximize Pane",
  restore: "Restore Pane Layout",
  maximizeHelp: (pane: string) => `Give the ${pane} pane the whole window; nothing is hidden and every divider comes back where it is now`,
  restoreHelp: (pane: string) => `Put every pane back exactly where it was before the ${pane} pane was maximized`,

  // Show All Panes (WS-060).
  showAll: "Show All Panes",
  showAllHome: "Every pane is already showing in this window",
  showAllHelp: "Show the Tools, Status, Shell, AI Assistant, Inspector and Results panes, and bring any pane that has a window of its own back into this one",

  // Separate Windows (WS-087).
  returnAll: "Return All Panes to the Main Window",
  returnAllHelp: "Close every pane window and put its pane back into the main window's layout",
  returnAllNone: "Every pane is already in the main window",
  detachHelp: (pane: string, detached: boolean) =>
    detached
      ? `Put the ${pane} pane back into the main window, where it was before`
      : `Show the ${pane} pane in a window of its own, with its own size and position — it leaves the main window's layout, and the layout closes over it`,

  // Pane text size (WS-014).
  textSizeNoTarget: (verb: string) => `${verb} the text size of the focused pane — click in the Status, Shell or AI Assistant pane first (the canvas uses ⌘= / ⌘−)`,
  textSizeLimit: (pane: string, bigger: boolean) => `The ${pane} pane is already at its ${bigger ? "largest" : "smallest"} text size`,
  textSizeHelp: (verb: string, pane: string) => `${verb} the ${pane} pane's text size`,

  // Window ▸ Focus (MENU-146…152).
  focusHelp: {
    canvas: "Move keyboard focus to the drawing canvas, restoring the pane layout first if another pane has the whole window",
    tools: "Show the Tools pane if hidden and move keyboard focus to it (arrow keys and Space then pick a tool)",
    status: "Show the Status pane if hidden and move keyboard focus to it",
    shell: "Show the Shell pane if hidden and move keyboard focus to it (⌃` does the same)",
    ai: "Show the AI Assistant pane if hidden and put the caret in its composer",
    inspector: "Show the Inspector pane if hidden and put the caret in the selected node's first field",
    results: "Show the Results workspace if hidden and move keyboard focus to its filter",
  } as Record<PaneId, string>,

  // Edit ▸ Find routing (QnetCommands.swift findTitle / findHelp / findStepHelp).
  findNode: "Find Node…",
  findHelp: {
    canvas: "Select a node by name and scroll it into view",
    shell: "Search the Shell scrollback (the Shell has keyboard focus)",
    status: "Move the keyboard focus to the Status pane's search field",
    results: "Move the keyboard focus to the Results workspace filter",
    ai: "Search the AI Assistant transcript",
    settings: "Move the keyboard focus to the Settings search field",
    help: "Move the keyboard focus to the Help window's search field",
  } as Record<string, string>,
  findStepHelp: {
    shell: [
      "Scroll to the next match in the Shell scrollback",
      "Search the Shell first (⌘F); Find Next then steps through the matches",
    ],
    status: [
      "Select the next entry that matches the Status pane's search",
      "Search the Status log first (⌘F); Find Next then steps through the matching entries",
    ],
    ai: [
      "Scroll to the next message that matches the conversation search",
      "Search the conversation first (⌘F); Find Next then steps through the matching messages",
    ],
  } as Record<string, [string, string]>,
  findStepDefault: "Walk the matches of the focused pane's search, or of the Qnet Help window when it is in front",
  noFindHere: "Nothing here can be searched",
  noStepHere: "Search first (⌘F); Find Next then steps through the matches",

  // The top bar (WS-010, WS-011, TB-005…012).
  workspace: "Workspace",
  workspaceHelp: "Apply a pane arrangement, or give one pane the whole window (View ▸ Panes)",
  workspaceMaximizedHelp: (pane: string) => `The ${pane} pane has the whole window — choose Restore Pane Layout to bring the others back (View ▸ Panes)`,
  workspaceLabel: "Workspace arrangement",
  workspaceMaximizedLabel: (pane: string) => `Workspace arrangement, ${pane} pane maximized`,
  toggleHelp: (pane: string, shortcut: string | undefined) => `Show or hide the ${pane} pane${shortcut ? ` (${shortcut})` : ""}`,
  resultsToggleHelp: (shortcut: string | undefined) => `Show or hide the structured Results workspace${shortcut ? ` (${shortcut})` : ""}`,
  toggleLabel: (pane: string) => (pane === "Results" ? "Results workspace" : `${pane} pane`),
  toolbarLabel: "Panes",

  // The pane header's window control (WS-061, WS-085, WS-097).
  soloMaximize: (pane: string) => `Maximize ${pane} Pane`,
  soloRestore: "Restore Pane Layout",
  soloReturn: (pane: string) => `Return ${pane} to the Main Window`,
  soloMaximizeHelp: (pane: string, key: string) => `Give the ${pane} pane the whole window; the other panes come back exactly as they are now (View ▸ Panes ▸ Maximize Pane, ${key})`,
  soloRestoreHelp: (key: string) => `Put the other panes back exactly where they were (View ▸ Panes ▸ Restore Pane Layout, ${key})`,
  soloReturnHelp: (pane: string) => `Put the ${pane} pane back into the main window, where it was before (closing this window does the same)`,

  // Corner grips (WS-070, WS-071).
  gripHelp: "Drag to resize both panes",
  gripLabel: "Pane corner resize handle",
  gripHint: "Drag to move the horizontal and vertical dividers together",
  dividerLabel: "Pane divider",

  // Detached windows (WS-090, SH-013).
  windowTitle: (network: string, pane: string) => (network.trim() ? `${network.trim()} — ${pane}` : pane),

  // Placeholder bodies for the panes later phases fill.
  placeholder: {
    tools: "The drawing tools arrive with the canvas, in a later build of Qnet.",
    inspector: "Node and link parameters arrive with the canvas, in a later build of Qnet.",
    results: "Run results arrive with the solver interface, in a later build of Qnet.",
    shell: "The interactive shell arrives in a later build of Qnet.",
    ai: "The AI Assistant arrives in a later build of Qnet.",
  } as Record<string, string>,
} as const;
