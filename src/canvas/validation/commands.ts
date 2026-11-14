// The problems' commands (new in 2.1, ROADMAP C4; ids as src/lib/menuSpec.ts names them): the
// View menu's "Show Problems on Canvas", Next Problem and Previous Problem, and the list. The
// status bar's count and the list's rows run the same functions.
import { useEffect } from "react";
import { activeEditor } from "../../editor";
import type { Editor } from "../../editor/editor";
import { announce } from "../../lib/announce";
import { registerCommands, type Command } from "../../lib/commands";
import { toDisplay } from "../geometry/transform";
import { targetKey, targetOf, type Diagnostic } from "./model";
import { diagnosticsOf, openProblemOf, problemsShown, setOpenProblem, setProblemsListOpen, setProblemsShown } from "./store";
import { validationWords as w } from "./words";

export const TOGGLE_COMMAND = "view:problems-on-canvas";
export const NEXT_COMMAND = "view:next-problem";
export const PREVIOUS_COMMAND = "view:previous-problem";
export const LIST_COMMAND = "view:problems-list";

/** How close to the viewport's edge a node may be before the canvas is panned to show it. */
const REVEAL_MARGIN = 72;

/** Pans, without zooming, so the world point is in view; nothing moves when it already is. */
function reveal(editor: Editor, world: { x: number; y: number }) {
  const t = editor.canvasTransform;
  const { width, height } = t.viewportSize;
  if (!(width > 2 * REVEAL_MARGIN && height > 2 * REVEAL_MARGIN)) return;
  const p = toDisplay(t, world);
  if (p.x >= REVEAL_MARGIN && p.x <= width - REVEAL_MARGIN && p.y >= REVEAL_MARGIN && p.y <= height - REVEAL_MARGIN) return;
  editor.pan({ width: width / 2 - p.x, height: height / 2 - p.y });
}

/**
 * Selects and reveals the node or link a problem is on, and opens its explanation there. Returns
 * false for a problem of the whole network, which has no place on the canvas.
 */
export function goToProblem(editor: Editor, d: Diagnostic, focus = true): boolean {
  const target = targetOf(d);
  if (!target) return false;
  if (target.kind === "node") {
    const node = editor.node(target.id);
    if (!node) return false;
    editor.setView({ selectedNodeID: node.id, selectedNodeIDs: new Set([node.id]), selectedLinkID: null });
    reveal(editor, { x: node.position[0], y: node.position[1] });
  } else {
    const link = editor.link(target.id);
    const from = link && editor.node(link.fromNodeID);
    const to = link && editor.node(link.toNodeID);
    if (!link || !from || !to) return false;
    editor.setView({ selectedNodeID: null, selectedNodeIDs: new Set(), selectedLinkID: link.id });
    reveal(editor, { x: (from.position[0] + to.position[0]) / 2, y: (from.position[1] + to.position[1]) / 2 });
  }
  setOpenProblem(editor.tabId, targetKey(target), focus);
  return true;
}

/** The problems that have a place on the canvas, one per node or link, in the list's order. */
export function visitable(ds: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return ds.filter((d) => {
    const key = targetKey(targetOf(d));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Next Problem / Previous Problem: from the open one, else the first (or last). */
export function stepProblem(editor: Editor, by: 1 | -1): Diagnostic | null {
  const all = diagnosticsOf(editor.tabId);
  const stops = visitable(all).filter((d) => {
    const t = targetOf(d)!;
    return t.kind === "node" ? !!editor.node(t.id) : !!editor.link(t.id);
  });
  if (!stops.length) {
    // Only problems of the whole network (or none): the list is where they are.
    if (all.some((d) => d.severity !== "info")) setProblemsListOpen(true);
    else announce(w.noneToVisit);
    return null;
  }
  const current = openProblemOf(editor.tabId)?.target;
  const at = stops.findIndex((d) => targetKey(targetOf(d)) === current);
  const next = at < 0 ? (by > 0 ? 0 : stops.length - 1) : (at + by + stops.length) % stops.length;
  const d = stops[next];
  goToProblem(editor, d);
  announce(`${w.position(next + 1, stops.length)} ${w.severity[d.severity]}: ${w.sentence(d)}`);
  return d;
}

export function validationCommands(): Command[] {
  const keywords = ["problems", "errors", "warnings", "validation", "diagnostics", "issues"];
  return [
    { id: TOGGLE_COMMAND, title: w.toggle, group: "View", keywords: [...keywords, "badges", "canvas"], subtitle: w.toggleHelp, checked: () => problemsShown(), run: () => setProblemsShown(!problemsShown()) },
    { id: NEXT_COMMAND, title: w.next, group: "View", keywords, subtitle: w.nextHelp, run: () => void stepProblem(activeEditor(), 1) },
    { id: PREVIOUS_COMMAND, title: w.previous, group: "View", keywords, subtitle: w.nextHelp, run: () => void stepProblem(activeEditor(), -1) },
    { id: LIST_COMMAND, title: w.showList, group: "View", keywords: [...keywords, "list"], subtitle: w.showListHelp, run: () => setProblemsListOpen(true) },
  ];
}

/** Registers the commands while the canvas is mounted. */
export function useValidationCommands() {
  useEffect(() => registerCommands(validationCommands()), []);
}
