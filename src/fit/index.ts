// Fit from Data… (new in 2.1, ROADMAP D2): measured times in, a distribution for a source or a
// station out. What is wired where:
// - the "Fit from Data…" button, in the inspector's distribution editor (src/panes/inspector/NodeSections.tsx);
// - `<FitHost />`, in App.tsx beside the other hosts (a page without one — a test, a detached window — still gets the panel: the first open makes a root of its own);
// - the arithmetic, in src-tauri/src/fit.rs (`fit_distribution`, `fit_read_file`).
export { FitHost } from "./FitPanel";
export { openFitPanel, closeFitPanel, currentFitPanel, type FitTarget } from "./store";
export { parseData, prepare, defaultColumn } from "./parse";
export { fitWords } from "./words";
export type { FitReport, FitCandidate, FitSummary, FitRequest } from "./model";
