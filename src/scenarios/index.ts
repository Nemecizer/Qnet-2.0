// Scenarios (new in 2.1, ROADMAP E1): named variants of one network, compared in one table and
// one chart. What the rest of the app uses:
//
// - `<ScenarioSwitcher />` in the toolbar (src/workspace/panes/Toolbar.tsx) and `<ScenarioHost />`
//   beside the other hosts in App.tsx (until it is mounted there, the first request makes one);
// - `<OverrideMark />` under an inspector field;
// - `saveAsScenario(tabId, name, apply)` for a view's second "Apply" button (Capacity, Sensitivity);
// - `scenarioEdit` (./edits.ts) in the editor's `write`.
export { ScenarioSwitcher } from "./Switcher";
export { ScenarioHost } from "./Host";
export { OverrideMark } from "./OverrideMark";
export { SaveAsScenarioButton } from "./SaveAs";
export { saveAsScenario, showScenario, createScenario, removeScenario, renameScenarioTo, resetToBaseline, openCompare, startScenarioCommands, scenarioCommands, COMPARE_COMMAND, NEW_COMMAND } from "./commands";
export { solveAllScenarios, stopSolveAll, solveAllRunning } from "./solveAll";
export { activeScenario, activeId, scenariosOf, scenarioDocument, baselineDocument, type Scenario, type ScenarioSet, type Override, type OverrideField } from "./model";
export { scenarioWords } from "./words";
