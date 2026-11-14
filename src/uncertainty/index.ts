// Results ▸ Uncertainty (new in 2.1, ROADMAP D7): how sure the answer is when the arrival and
// service rates are only known roughly. What is wired where:
// - the menu item, in src/lib/menuSpec.ts (`run:uncertainty`);
// - `startUncertaintyCommands()` and the Uncertainty view, in src/panes/results/ResultsPane.tsx;
// - the arithmetic, `uncertainty_analyze` and `uncertainty_linear` (src-tauri/src/uncertainty.rs,
//   core/src/uncertainty.rs).
export { UncertaintyView } from "./UncertaintyView";
export { startUncertaintyCommands, uncertaintyCommands, UNCERTAINTY_COMMAND } from "./commands";
export { showUncertaintyView, onUncertaintyViewRequest, takeUncertaintyViewRequest } from "./store";
export { uncertaintyWords } from "./words";
