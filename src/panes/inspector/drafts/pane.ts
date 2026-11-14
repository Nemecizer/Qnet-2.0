// The docked Inspector's selection and reload rules, DOM-free (0.90.34 InspectorPaneView.swift
// `syncSelection`, `reloadIfIdle`, `commitNow`, `commitIfIdle`, `revertDraft`; ledger INS-006…016).
// The pane component calls these; src/editor/replay.test.ts calls them after every scripted step,
// as the golden replay does.
import type { Editor } from "../../../editor";
import { inspectorWords as w } from "../words";
import { LinkParameterDraft } from "./link";
import { NodeParameterDraft } from "./node";

/** What the pane holds across selection changes: its two persistent drafts and what they hold. */
export interface PaneState {
  readonly node: NodeParameterDraft;
  readonly link: LinkParameterDraft;
  loadedNodeID: string | null;
  loadedLinkID: string | null;
}

export function makePaneState(): PaneState {
  return { node: new NodeParameterDraft(), link: new LinkParameterDraft(), loadedNodeID: null, loadedLinkID: null };
}

/** The node the pane follows: the selected node, or the one node of a one-node group when no link is selected. */
export function targetNodeID(editor: Editor): string | null {
  const v = editor.view;
  if (v.selectedNodeID) return v.selectedNodeID;
  if (v.selectedLinkID === null && v.selectedNodeIDs.size === 1) return [...v.selectedNodeIDs][0];
  return null;
}

/** A link is followed only when no node is. */
export function targetLinkID(editor: Editor): string | null {
  return targetNodeID(editor) === null ? editor.view.selectedLinkID : null;
}

/**
 * The selection changed: commit a dirty draft of the previous target (coalescing), logging a
 * discard when it can't be written, end the parameter run, then load the new target.
 */
export function syncSelection(editor: Editor, pane: PaneState) {
  const nodeTarget = targetNodeID(editor);
  const linkTarget = targetLinkID(editor);
  if (pane.loadedNodeID !== null && pane.loadedNodeID !== nodeTarget) {
    const previous = pane.loadedNodeID;
    if (pane.node.isDirty && !pane.node.commit(editor, { coalescing: true })) logDiscardedNodeEdit(editor, pane, previous);
    editor.endParameterRun();
  }
  if (pane.loadedLinkID !== null && pane.loadedLinkID !== linkTarget) {
    const previous = pane.loadedLinkID;
    // Only an edited draft is written (see LinkParameterDraft.isEdited).
    if (pane.link.isEdited && pane.link.isDirty(editor) && !pane.link.commit(editor, { coalescing: true })) logDiscardedLinkEdit(editor, pane, previous);
    editor.endParameterRun();
  }
  if (nodeTarget !== null && editor.node(nodeTarget)) {
    if (pane.loadedNodeID !== nodeTarget) {
      pane.node.load(editor, nodeTarget);
      pane.loadedNodeID = nodeTarget;
    }
    pane.loadedLinkID = null;
  } else if (linkTarget !== null && editor.link(linkTarget)) {
    if (pane.loadedLinkID !== linkTarget) {
      pane.link.load(editor, linkTarget);
      pane.loadedLinkID = linkTarget;
    }
    pane.loadedNodeID = null;
  } else {
    pane.loadedNodeID = null;
    pane.loadedLinkID = null;
  }
}

function logDiscardedNodeEdit(editor: Editor, pane: PaneState, nodeID: string) {
  const name = editor.node(nodeID)?.name ?? "node";
  const fields = pane.node.invalidFieldSummaries(editor);
  const what = fields.length ? fields.join(", ") : (pane.node.pendingNote(editor) ?? w.incompleteField);
  editor.status(w.discardedNode(name, what), "warning");
}

function logDiscardedLinkEdit(editor: Editor, pane: PaneState, linkID: string) {
  const link = editor.link(linkID);
  const label = link ? editor.displayLabel(link) : "link";
  const m = pane.link;
  const what = m.probabilityError !== null || m.probabilityIsPending ? `Probability ("${m.probabilityText}")` : (m.firstProblem(editor) ?? w.invalidField);
  editor.status(w.discardedLink(label, what), "warning");
}

/**
 * The document changed under the pane: refresh a clean draft no field is typing into; otherwise
 * only the load readout is rescheduled. A deleted target re-runs the selection sync. The link draft
 * is reloaded on the same rule as the node draft (Changed: see LinkParameterDraft.isEdited).
 */
export function reloadIfIdle(editor: Editor, pane: PaneState) {
  // A drag or an arrow-key run rewrites positions every frame, and position is in no field here:
  // the pane waits for the gesture to end rather than reloading (and asking Rust) per frame.
  if (editor.view.isDraggingNode || editor.mutationOpen) return;
  if (pane.loadedNodeID !== null) {
    if (!editor.node(pane.loadedNodeID)) return syncSelection(editor, pane);
    if (pane.node.fieldFocusCount === 0 && !pane.node.isDirty) pane.node.refresh(editor);
    else pane.node.scheduleStabilityRefresh(editor);
  }
  if (pane.loadedLinkID !== null) {
    if (!editor.link(pane.loadedLinkID)) return syncSelection(editor, pane);
    if (pane.link.fieldFocusCount === 0 && !pane.link.isEdited) pane.link.load(editor, pane.loadedLinkID);
  }
}

/** Blur, Return, the pane going away: write a valid dirty draft now. */
export function commitNow(editor: Editor, pane: PaneState) {
  if (pane.loadedNodeID !== null) pane.node.commit(editor, { coalescing: true });
  if (pane.loadedLinkID !== null) pane.link.commit(editor, { coalescing: true });
}

/** After the settle debounce: commit only while no text field has the keyboard. */
export function commitIfIdle(editor: Editor, pane: PaneState) {
  if (pane.loadedNodeID !== null && pane.node.fieldFocusCount === 0) pane.node.commit(editor, { coalescing: true });
  if (pane.loadedLinkID !== null && pane.link.fieldFocusCount === 0) pane.link.commit(editor, { coalescing: true });
}

/** Escape: abandon what has not been committed; a clean draft is left alone. */
export function revertDraft(editor: Editor, pane: PaneState) {
  if (pane.loadedNodeID !== null && pane.node.isDirty) {
    pane.node.revertToBaseline();
    pane.node.scheduleStabilityRefresh(editor);
  }
  if (pane.loadedLinkID !== null && pane.link.isDirty(editor)) pane.link.revertToBaseline();
}
