// Typing in the app's text fields, followed so Edit ▸ Undo knows whether the focused field has
// an edit of its own to undo (src/editor/commands.ts, 0.90.34's `UndoRouting`). Installed once per
// document: the main window's and each auxiliary window's (src/lib/auxWindow.tsx).
import { invalidateMenu } from "../lib/menu";

// What the focused field could undo or redo, in WebKit's units: a run of typing is one undoable
// edit (as WebKit coalesces it), a switch between typing and deleting or a pause of a second starts
// another, and each native undo moves one onto the redo side. A field that was only clicked into has
// nothing of its own, so ⌘Z goes to the document (0.90.34's `UndoRouting`).
interface FieldStack {
  undo: number;
  redo: number;
  /** When the last edit came and what it was ("insert…" / "delete…"), to tell a run from a new one. */
  lastAt: number;
  lastKind: string;
}

const RUN_PAUSE_MS = 1000;
const fieldStacks = new WeakMap<Element, FieldStack>();

export function stackOf(el: Element): FieldStack {
  let s = fieldStacks.get(el);
  if (!s) {
    s = { undo: 0, redo: 0, lastAt: -Infinity, lastKind: "" };
    fieldStacks.set(el, s);
  }
  return s;
}

/** Follows typing in text fields (once per document: the main window and each auxiliary one). */
export function trackFieldEdits(doc: Document = document): () => void {
  const onInput = (e: Event) => {
    const ie = e as InputEvent;
    if (ie.inputType === "historyUndo" || ie.inputType === "historyRedo") return;
    const t = e.target as Element | null;
    if (!t) return;
    const s = stackOf(t);
    const kind = (ie.inputType ?? "").startsWith("delete") ? "delete" : "insert";
    const now = Date.now();
    if (s.undo === 0 || kind !== s.lastKind || now - s.lastAt > RUN_PAUSE_MS) s.undo++;
    s.lastAt = now;
    s.lastKind = kind;
    s.redo = 0;
    invalidateMenu();
  };
  const onFocus = (e: Event) => {
    const t = e.target as Element | null;
    if (t) fieldStacks.set(t, { undo: 0, redo: 0, lastAt: -Infinity, lastKind: "" });
    // Cut, Copy and Paste turn on and off with the field that has the keyboard, in any window.
    invalidateMenu();
  };
  const onBlur = () => invalidateMenu();
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("focusin", onFocus, true);
  doc.addEventListener("focusout", onBlur, true);
  return () => {
    doc.removeEventListener("input", onInput, true);
    doc.removeEventListener("focusin", onFocus, true);
    doc.removeEventListener("focusout", onBlur, true);
  };
}
