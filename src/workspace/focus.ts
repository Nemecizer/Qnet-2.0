// Which pane has the keyboard, and what Find, Find Next and the pane text size commands do there:
// 0.90.34's `FocusRouter` (ledger WS-013, WS-014, MENU-044…053, MENU-083/084).
//
// A pane marks its root element with `data-pane="<id>"`; the pane that holds focus is the one
// whose element contains `document.activeElement` (or, for a detached pane, the focused auxiliary
// window's). Panes register what they do with Find and text size; an auxiliary window with its own
// search (Settings) registers under its window name. The commands that route through here
// (edit:find, edit:find-next, edit:find-previous, view:pane-text-bigger/smaller) are registered by
// the pane layout (src/workspace/), which owns focus.
import { useEffect } from "react";
import { focusedAuxWindow } from "../lib/auxWindow";
import { invalidateMenu } from "../lib/menu";

/** The main window's panes (ledger WS-050). */
export type PaneId = "canvas" | "tools" | "status" | "results" | "shell" | "ai" | "inspector";

export interface PaneHandlers {
  /** ⌘F: the menu item's title while this has focus ("Search Status Log…"), and what it does. */
  findTitle?: string;
  find?: () => void;
  /** ⌘G / ⇧⌘G: +1 or −1. */
  stepFind?: (delta: 1 | -1) => void;
  canStepFind?: () => boolean;
  /** ⌥⌘= / ⌥⌘−; `canZoom(delta)` false dims the item. */
  zoom?: (delta: 1 | -1) => void;
  canZoom?: (delta: 1 | -1) => boolean;
  /** Puts the caret where Window ▸ Focus <pane> should (its search field, the composer). */
  focus?: () => void;
}

const panes = new Map<string, PaneHandlers>();
let lastPane: PaneId | null = null;

/** Registers a pane's (or an auxiliary window's) handlers; returns a function that removes them. */
export function registerFocusTarget(id: PaneId | `window:${string}`, h: PaneHandlers): () => void {
  panes.set(id, h);
  invalidateMenu();
  return () => {
    if (panes.get(id) === h) panes.delete(id);
    invalidateMenu();
  };
}

export function useFocusTarget(id: PaneId | `window:${string}`, h: PaneHandlers, deps: unknown[] = []) {
  useEffect(() => registerFocusTarget(id, h), [id, ...deps]);
}

function paneOf(el: Element | null): PaneId | null {
  const p = el?.closest?.("[data-pane]")?.getAttribute("data-pane");
  return (p as PaneId | null) ?? null;
}

/** The pane or window that has the keyboard now. */
export function focusTarget(): { kind: "pane"; id: PaneId } | { kind: "window"; name: string } | null {
  const aux = focusedAuxWindow();
  if (aux) {
    const p = paneOf(aux.win.document.activeElement);
    if (p) return { kind: "pane", id: p };
    return { kind: "window", name: aux.name };
  }
  const p = paneOf(document.activeElement);
  return p ? { kind: "pane", id: p } : null;
}

/** The focused pane's id, or the last one that had focus when focus is nowhere in particular. */
export function focusedPane(): PaneId | null {
  const t = focusTarget();
  return t?.kind === "pane" ? t.id : null;
}

/** The handlers for whatever has the keyboard. */
export function focusedHandlers(): PaneHandlers | undefined {
  const t = focusTarget();
  if (!t) return undefined;
  return panes.get(t.kind === "pane" ? t.id : `window:${t.name}`);
}

export function handlersFor(id: PaneId | `window:${string}`): PaneHandlers | undefined {
  return panes.get(id);
}

/** Follows focus so the menu's titles ("Search Status Log…") and the 2-pt rule follow it. */
export function startFocusTracking(onChange: (p: PaneId | null) => void): () => void {
  const update = () => {
    const p = focusedPane();
    if (p !== lastPane) {
      lastPane = p;
      onChange(p);
      invalidateMenu();
    }
  };
  window.addEventListener("focusin", update, true);
  window.addEventListener("focusout", update, true);
  return () => {
    window.removeEventListener("focusin", update, true);
    window.removeEventListener("focusout", update, true);
  };
}
