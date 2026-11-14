// Results ▸ Capacity (new in 2.1, ROADMAP D5): the cheapest numbers of servers, or service
// rates, that meet a target. What is wired where:
// - the menu item, in src/lib/menuSpec.ts (`run:plan-capacity`);
// - `startCapacityCommands()` and the Capacity view, in src/panes/results/ResultsPane.tsx;
// - the exact route, `capacity_plan` (src-tauri/src/optimise.rs, core/src/optimise.rs).
export { CapacityView } from "./CapacityView";
export { startCapacityCommands, capacityCommands, CAPACITY_COMMAND } from "./commands";
export { showCapacityView, onCapacityViewRequest, takeCapacityViewRequest } from "./store";
export { capacityWords } from "./words";
