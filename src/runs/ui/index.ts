// The run interface (P6): the Run and Test menus' commands, the run and test panels, the status
// bar's run segment and the tab close guard. What the lead mounts and wires:
// - `useRunCommands()` in App.tsx beside the other areas' command hooks;
// - `<RunPanelsHost />` in App.tsx beside the other hosts;
// - `<RunSegment />` as the canvas status bar's `run` (src/canvas/CanvasPane.tsx);
// - `refuseClosingRunOwner(ids)` first thing in src/workspace/tabs/closing.ts `closeTabs`.
export { useRunCommands, runCommands, RUN_ITEMS, runHelp, runWhen, startMethod } from "./commands";
export { RunPanelsHost } from "./RunPanels";
export { RunSegment } from "./RunSegment";
export { runOwnsTab, refuseClosingRunOwner, cannotCloseSentence, liveRun, lastRun } from "./live";
export { startSweep, useSweepState, getSweepState } from "./sweeps";
export { runWords, displayLabel } from "./words";
