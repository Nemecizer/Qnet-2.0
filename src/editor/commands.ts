// The Edit menu's document half (0.90.34 QnetCommands.swift `editMenu`, ledger section 1.3):
// Undo, Redo, Cut, Copy, Paste, Duplicate, Delete, Select All, Deselect All, Edit Parameters and
// Clear Canvas, each acting on the active tab's editor.
//
// Text fields keep their own editing. 0.90.34 offered ⌘Z, ⌘X, ⌘C, ⌘V and ⌘A to the focused text
// control first and fell back to the canvas; here the item asks whether a text field has the
// keyboard and, if so, sends the action down AppKit's responder chain (src-tauri/src/edit.rs), so
// WebKit undoes the typing and uses the real pasteboard. For ⌘Z it also asks whether the field
// has anything to undo — a field with an empty stack must not swallow "Undo Delete Selection" —
// and otherwise undoes the document and lets go of the field, as 0.90.34's
// `endStaleFieldEditing` did.
import { api, inTauri } from "../lib/api";
import { useEffect } from "react";
import { useCommands, type Command } from "../lib/commands";
import { destructive } from "../lib/dialogs";
import { stackOf, trackFieldEdits } from "./fieldEdits";
import { modalOpen, MODAL_REASON } from "../lib/overlays";
import { focusedAuxWindow } from "../lib/auxWindow";
import { focusedPane } from "../workspace/focus";
import { activeTab } from "../workspace/store";
import { activeEditor } from ".";
import { editorWords as w } from "./words";
import { copyShellSelection, pasteIntoShell, selectAllInShell, shellFocused, shellHasSelection } from "../panes/shell/commands";

/** The element that has the keyboard, in whichever of the app's windows is key. */
function focusedElement(): Element | null {
  const aux = focusedAuxWindow();
  return (aux ? aux.win.document : document).activeElement;
}

/** A focused text input, textarea or editable element: where ⌘C means "copy this text". */
export function focusedTextField(): HTMLElement | null {
  const el = focusedElement() as HTMLElement | null;
  if (!el) return null;
  // The Shell's terminal takes keys through a hidden textarea, but it is no text field: 0.90.34's
  // terminal view wasn't NSText either, so ⌘C, ⌘X and ⌘Z went past it (the Shell's own selection
  // and paste are routed by name below).
  if (el.classList.contains("xterm-helper-textarea")) return null;
  if (el.isContentEditable) return el;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return el;
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return ["text", "search", "number", "email", "url", "tel", "password"].includes(type) ? el : null;
  }
  return null;
}

interface UndoRoute {
  text: boolean;
  available: boolean;
  name: string;
}

function undoRoute(redo: boolean): UndoRoute {
  const field = focusedTextField();
  if (field) {
    const s = stackOf(field);
    if (redo ? s.redo > 0 : s.undo > 0) return { text: true, available: true, name: "" };
  }
  const um = activeEditor().undoManager;
  return { text: false, available: redo ? um.canRedo : um.canUndo, name: redo ? um.redoActionName : um.undoActionName };
}

/**
 * Undo's enablement. A text field's own undo is always live; the document's waits while a dialog
 * or panel is up (MENU-198), because undoing under an open Node Parameters panel would change the
 * network its draft was made from — 0.90.34 let it through and closed the panel, losing the draft
 * (ledger MENU-032, Changed).
 */
function undoWhen(redo: boolean): true | string {
  const r = undoRoute(redo);
  if (!r.available) return redo ? w.nothingToRedo : w.nothingToUndo;
  if (!r.text && modalOpen()) return MODAL_REASON;
  return true;
}

function performUndoRedo(redo: boolean) {
  if (undoWhen(redo) !== true) return;
  const r = undoRoute(redo);
  const field = focusedTextField();
  if (r.text && field) {
    const s = stackOf(field);
    if (redo) {
      s.redo--;
      s.undo++;
    } else {
      s.undo--;
      s.redo++;
    }
    native(redo ? "redo" : "undo", field);
    return;
  }
  // The document's stack: a field still holding the keyboard is stale; let it go so the next ⌘Z
  // isn't routed back into it.
  field?.blur();
  const e = activeEditor();
  if (redo) e.redo();
  else e.undo();
}

/** Sends an edit action to the focused field: AppKit's responder chain in the app, execCommand in a browser. */
function native(action: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll", field: HTMLElement) {
  if (inTauri) {
    void api.nativeEdit(action);
    return;
  }
  const doc = field.ownerDocument;
  if (action === "selectAll" && (field instanceof doc.defaultView!.HTMLInputElement || field instanceof doc.defaultView!.HTMLTextAreaElement)) {
    (field as HTMLInputElement).select();
    return;
  }
  doc.execCommand(action === "selectAll" ? "selectAll" : action);
}

const hasNodeSelection = () => activeEditor().selectionUnion.size > 0;

/** The Shell has the keyboard and a selection: ⌘C is its copy. */
const shellCopies = () => shellFocused() && shellHasSelection();

function notModalUnlessText(): true | string {
  return modalOpen() && !focusedTextField() ? MODAL_REASON : true;
}

export function editCommands(): Command[] {
  return [
    {
      id: "edit:undo",
      title: w.undo,
      group: "Edit",
      dynamicTitle: () => {
        const r = undoRoute(false);
        return r.available ? w.undoTitle(r.name) : w.undo;
      },
      when: () => undoWhen(false),
      run: () => performUndoRedo(false),
    },
    {
      id: "edit:redo",
      title: w.redo,
      group: "Edit",
      dynamicTitle: () => {
        const r = undoRoute(true);
        return r.available ? w.redoTitle(r.name) : w.redo;
      },
      when: () => undoWhen(true),
      run: () => performUndoRedo(true),
    },
    {
      id: "edit:cut",
      title: w.cut,
      group: "Edit",
      when: () => {
        const text = !!focusedTextField();
        if (modalOpen() && !text) return MODAL_REASON;
        return hasNodeSelection() || text ? true : w.noNodeSelection;
      },
      run: () => {
        const f = focusedTextField();
        if (f) native("cut", f);
        else activeEditor().cutSelection();
      },
    },
    {
      id: "edit:copy",
      title: w.copy,
      group: "Edit",
      subtitle: w.help.copy,
      // Copy only reads, so it stays live under a dialog (0.90.34's sheet rule). The Shell is asked
      // first, and only when it has a selection: with none, ⌘C falls through to the text field or
      // the canvas, as 0.90.34's did (MENU-036, SH-038).
      when: () => (shellCopies() || hasNodeSelection() || focusedTextField() ? true : w.noNodeSelection),
      run: () => {
        if (shellCopies()) return void copyShellSelection();
        const f = focusedTextField();
        if (f) native("copy", f);
        else activeEditor().copySelection();
      },
    },
    {
      id: "edit:paste",
      title: w.paste,
      group: "Edit",
      subtitle: w.help.paste,
      when: () => (shellFocused() ? true : notModalUnlessText()),
      run: () => {
        if (shellFocused()) return void pasteIntoShell();
        const f = focusedTextField();
        if (f) native("paste", f);
        else activeEditor().pasteSelection();
      },
    },
    {
      id: "edit:duplicate",
      title: w.duplicate,
      group: "Edit",
      subtitle: w.help.duplicate,
      when: () => {
        if (modalOpen()) return MODAL_REASON;
        if (focusedTextField()) return w.inTextField;
        return hasNodeSelection() ? true : w.noNodeSelection;
      },
      run: () => activeEditor().duplicateSelection(),
    },
    {
      id: "edit:delete",
      title: w.delete,
      group: "Edit",
      when: () => {
        if (modalOpen()) return MODAL_REASON;
        if (focusedTextField()) return w.inTextField;
        if (focusedPane() === "shell") return w.inShell;
        return activeEditor().hasAnySelection ? true : w.noSelection;
      },
      run: () => activeEditor().deleteSelection(),
    },
    {
      id: "edit:delete-link",
      title: w.deleteLink,
      group: "Edit",
      subtitle: w.help.deleteLink,
      when: () => {
        if (modalOpen()) return MODAL_REASON;
        return activeEditor().view.selectedLinkID !== null ? true : w.noLinkSelection;
      },
      run: () => {
        const e = activeEditor();
        const id = e.view.selectedLinkID;
        if (id) e.deleteLink(id);
      },
    },
    {
      id: "edit:select-all",
      title: w.selectAll,
      group: "Edit",
      run: () => {
        if (shellFocused()) return void selectAllInShell();
        const f = focusedTextField();
        if (f) native("selectAll", f);
        else activeEditor().selectAll();
      },
    },
    {
      id: "edit:deselect-all",
      title: w.deselectAll,
      group: "Edit",
      subtitle: w.help.deselectAll,
      when: () => (activeEditor().hasAnySelection ? true : w.noSelection),
      run: () => activeEditor().deselectAll(),
    },
    {
      id: "edit:parameters",
      title: w.parameters,
      group: "Edit",
      subtitle: w.help.parameters,
      keywords: ["inspector", "properties"],
      when: () => {
        if (modalOpen()) return MODAL_REASON;
        if (focusedTextField()) return w.inTextField;
        return activeEditor().canOpenParameterEditor ? true : w.nothingToOpen;
      },
      run: () => activeEditor().openParameterEditorForSelection(),
    },
    {
      id: "edit:clear-canvas",
      title: w.clearCanvas,
      group: "Edit",
      subtitle: w.help.clearCanvas,
      when: () => {
        if (modalOpen()) return MODAL_REASON;
        const e = activeEditor();
        return e.nodes.length || e.links.length ? true : w.noNetwork;
      },
      run: async () => {
        const e = activeEditor();
        if (!e.nodes.length && !e.links.length) return;
        if (!(await destructive(w.clearCanvasAlert(activeTab().title)))) return;
        e.clear();
      },
    },
  ];
}

/** Registers the Edit commands and follows typing in the main window's text fields. */
export function useEditCommands() {
  useCommands(editCommands(), []);
  useEffect(() => trackFieldEdits(document), []);
}
