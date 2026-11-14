// Run ▸ Transient… (new in 2.1, ROADMAP D4): the mean number at each station over time — exactly
// (uniformisation of the network's Markov chain) and by the fluid model — with the settling time
// and the effect of a surge. What is wired where:
// - the menu item, in src/lib/menuSpec.ts (`run:transient`);
// - `startTransientCommands()` and the Transient view, in src/panes/results/ResultsPane.tsx;
// - the commands `transient_prepare`, `transient_analyze`, `transient_stop`
//   (src-tauri/src/transient.rs; the arithmetic and its exact checks, core/src/transient.rs).
export { TransientView } from "./TransientView";
export { startTransientCommands, transientCommands, TRANSIENT_COMMAND } from "./commands";
export { showTransientView, onTransientViewRequest, takeTransientViewRequest } from "./store";
export { transientWords } from "./words";
