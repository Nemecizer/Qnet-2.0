// Run ▸ What-If Sweep… (new in 2.1, ROADMAP B4): vary one parameter over a range, run each point
// quietly by one method or several, and read the answer as a chart. What is wired where:
// - the menu item, in src/lib/menuSpec.ts (`run:what-if-sweep`);
// - `startSweepCommands()` and the Sweep view, in src/panes/results/ResultsPane.tsx;
// - `<SweepHost />` belongs in App.tsx beside the other hosts (until then the panel makes its own root).
export { SweepHost } from "./SweepPanel";
export { SweepView } from "./SweepView";
export { startSweepCommands, sweepCommands, openSweepPanel, closeSweepPanel, applySweepValue, SWEEP_COMMAND } from "./commands";
export { runSweep, sweepRunning, SWEEP_METHOD } from "./runner";
export { useSweepResult, sweepResult, setSweepResult, showSweepView, onSweepViewRequest, takeSweepViewRequest } from "./store";
export { discoverParameters, substitute, type SweepParameter } from "./model";
export { sweepWords } from "./words";
