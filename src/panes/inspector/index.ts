// The docked Inspector pane and what the other areas use from it: the drafts (DOM-free, also driven
// by src/editor/replay.test.ts), the distribution arithmetic and `lawDescription` for node labels
// and tooltips, and the words (re-exported by src/lib/vocabulary.ts).
export { InspectorPane, paneStateFor, SETTLE_DELAY } from "./InspectorPane";
export * from "./drafts";
export { lawDescription } from "./distributions";
export { inspectorWords, panelWords, glossary } from "./words";
export { classColor, ClassChip } from "./fields";
