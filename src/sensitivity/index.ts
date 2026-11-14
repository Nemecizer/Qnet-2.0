// Results ▸ Sensitivity (new in 2.1, ROADMAP D1): which parameter moves a measure most, where the
// bottleneck is, and what single change would reach a target. What is wired where:
// - the menu item, in src/lib/menuSpec.ts (`run:sensitivity`);
// - `startSensitivityCommands()` and the Sensitivity view, in src/panes/results/ResultsPane.tsx;
// - the exact route, `sensitivity_analyze` (src-tauri/src/sensitivity.rs, core/src/sensitivity.rs).
export { SensitivityView } from "./SensitivityView";
export { startSensitivityCommands, sensitivityCommands, SENSITIVITY_COMMAND } from "./commands";
export { showSensitivityView, onSensitivityViewRequest, takeSensitivityViewRequest } from "./store";
export { sensitivityWords } from "./words";
