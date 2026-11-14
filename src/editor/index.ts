// One Editor per open tab (0.90.34 gave every NetworkTab its own NetworkEditorModel), made on
// first use and dropped when the tab closes. A document the store receives from outside the
// editor (Open into a blank tab, a restored session, Reopen Closed Tab) is adopted as
// `loadNetwork` would: counters re-primed, selection cleared, the undo stack kept.
import { useSyncExternalStore } from "react";
import { activeTab, getWorkspace, onWorkspaceChange, useWorkspace } from "../workspace/store";
import { Editor, type EditorView } from "./editor";

export { Editor } from "./editor";
export type { EditorTool, EditorView, AlignGuides } from "./editor";
export { TOOLS, TOOL_NAMES, KIND_NAMES, classLabel, editorClock, editorFeedback, NO_GUIDES } from "./editor";

const editors = new Map<string, Editor>();
let watching = false;
const registryListeners = new Set<() => void>();

function watch() {
  if (watching) return;
  watching = true;
  onWorkspaceChange((ws) => {
    const ids = new Set(ws.tabs.map((t) => t.id));
    let changed = false;
    for (const [id, e] of editors) {
      if (!ids.has(id)) {
        editors.delete(id);
        changed = true;
      } else if (e.isStale) e.adoptExternalDocument();
    }
    if (changed) registryListeners.forEach((l) => l());
  });
}

/** The editor of tab `id`, made on first use. */
export function editorFor(id: string): Editor {
  watch();
  let e = editors.get(id);
  if (!e) {
    e = new Editor(id);
    editors.set(id, e);
  }
  return e;
}

/** The active tab's editor. */
export function activeEditor(): Editor {
  return editorFor(activeTab(getWorkspace()).id);
}

/** The active tab's editor, re-rendering when the active tab changes. */
export function useActiveEditor(): Editor {
  const id = useWorkspace((ws) => activeTab(ws).id);
  return editorFor(id);
}

/** An editor's view state, re-rendering on every change of it or of its undo stack. */
export function useEditorView(editor: Editor): EditorView {
  return useSyncExternalStore(editor.subscribe, () => editor.view);
}

/** A value derived from an editor, re-rendering when it changes (compared with Object.is). */
export function useEditorValue<T>(editor: Editor, read: (e: Editor) => T): T {
  return useSyncExternalStore(editor.subscribe, () => read(editor));
}

/** For tests: forget every editor. */
export function resetEditors() {
  editors.clear();
}
