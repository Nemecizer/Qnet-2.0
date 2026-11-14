// The inspectors' drafts, DOM-free: what the docked pane, the Node and Link Parameters panels and
// the scripted edit replays (src/editor/replay.test.ts, golden/edits/) all drive.
export { NodeParameterDraft, stationServiceLaw, lawIsUnchanged, SERVERS_RANGE, BUFFER_RANGE, STABILITY_DELAY, type BulkUndo } from "./node";
export { LinkParameterDraft, SAME_AS_ENTRY } from "./link";
export { makePaneState, syncSelection, reloadIfIdle, commitNow, commitIfIdle, revertDraft, targetNodeID, targetLinkID, type PaneState } from "./pane";
export { stabilityOf, type Stability } from "./stability";
export type { DistributionDraft, EntryMode } from "../distributions";
