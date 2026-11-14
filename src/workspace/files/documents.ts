// New, Open, Open Example and Save (ledger 5.9, FILE-013…016): 0.90.34's `newNetwork`,
// `loadNetwork`, `loadExample`, `loadNetworkFile`, `saveNetwork`, `saveNetworkAs`,
// `writeNetwork` and `saveTab` (QnetGUIApp.swift), and `TabDocumentWriter` (TabClosing.swift).
// The document is read and written by Rust (core's reader and byte-exact writer).
import { api, CommandError } from "../../lib/api";
import { parseDocument } from "../../lib/bnet";
import { getCommand, runCommand } from "../../lib/commands";
import { report } from "../../lib/dialogs";
import { activeTab, addStatus, addTab, getWorkspace, isBlankTab, markSaved, tabById, updateTab } from "../store";
import { BNET_FILTER, chooseNetwork, chooseSaveTarget } from "./panels";
import { baseName, dirName, inFolder } from "./paths";
import { noteRecent } from "./recents";
import { fileWords as w } from "./words";

/** A command's sentence, and its detail for the alert's Details. */
export function reasonOf(e: unknown): { message: string; detail?: string } {
  if (e instanceof CommandError) return { message: e.message, detail: e.detail };
  if (e instanceof Error) return { message: e.message };
  return { message: String(e) };
}

/** File ▸ New Network: an empty Untitled tab, appended and selected (WS-108, MENU-009). */
export function newNetwork(): string {
  return addTab();
}

/**
 * Opens a .bnet file (0.90.34 `loadNetworkFile`): into the active tab when it is a blank Untitled
 * network, otherwise into a new selected tab titled with the file name (FILE-015). Resolves false
 * when the file couldn't be read, after the "Load Failed" alert (FILE-016).
 */
export async function openPath(path: string): Promise<boolean> {
  let opened;
  try {
    opened = await api.documentRead(path);
  } catch (e) {
    const r = reasonOf(e);
    addStatus(w.loadFailed(r.message), "error");
    await report({ title: w.loadFailedTitle, message: r.message, details: r.detail });
    return false;
  }
  const document = parseDocument(opened.text);
  const active = activeTab();
  let id: string;
  if (isBlankTab(active)) {
    id = active.id;
    // A load is a fresh start: clean, whatever the tab's count of edits.
    const revision = active.revision + 1;
    updateTab(id, { document, path: opened.path, title: opened.name, revision, savedRevision: revision });
  } else {
    id = addTab({ title: opened.name, path: opened.path, document });
  }
  // NetworkEditorModel.loadNetwork logs its counts first, then loadNetworkFile the file name.
  addStatus(w.loadedCounts(document.nodes.length, document.links.length), "success", id);
  addStatus(w.loaded(opened.name), "success", id);
  void noteRecent(opened.path);
  // WS-111: the Network Primitives report runs after every open (the analysis is P6's command).
  if (getCommand("network:primitives")) void runCommand("network:primitives");
  return true;
}

/** File ▸ Open… (WS-109, MENU-010). */
export async function openNetwork(): Promise<boolean> {
  const path = await chooseNetwork(w.openPanelTitle);
  return path ? openPath(path) : false;
}

/** File ▸ Open Example… (WS-113…115, EX-052…054): the panel starts in the bundled examples. */
export async function openExample(): Promise<boolean> {
  let folder: string | null = null;
  try {
    const lookup = await api.examplesLocate();
    folder = lookup.path ?? lookup.home ?? null;
    if (!lookup.path) {
      addStatus(w.noExamples(lookup.trail), "warning");
      // The panel can't carry a message (src/workspace/files/panels.ts): the log says it.
      addStatus(w.noExamplesPanel, "info");
    }
  } catch {
    folder = null;
  }
  const path = await chooseNetwork(w.examplePanelTitle, folder);
  return path ? openPath(path) : false;
}

/** File ▸ Save is enabled (0.90.34 `canSave`, MENU-019): `true`, or the tooltip that says why not. */
export function canSave(id = getWorkspace().activeId): true | string {
  const t = tabById(id);
  if (!t) return w.saveNothing;
  if (t.path === null) return t.document.nodes.length > 0 || t.document.links.length > 0 ? true : w.saveNothing;
  return t.revision !== t.savedRevision ? true : w.saveNoChanges;
}

/** File ▸ Save As… is enabled when there is a network or a file (WS-118). */
export function canSaveAs(id = getWorkspace().activeId): true | string {
  const t = tabById(id);
  return t && (t.document.nodes.length > 0 || t.path !== null) ? true : w.saveNothing;
}

/**
 * Saves a tab: to its file, or through the Save panel ("Save Network As") when it has none or
 * `saveAs` is set. Resolves true when the file was written, false when the panel was cancelled or
 * the save failed (the failure is already reported). The close guard and Quit call this.
 */
export async function saveTab(id: string, opts: { saveAs?: boolean } = {}): Promise<boolean> {
  const tab = tabById(id);
  if (!tab) return false;
  let path = opts.saveAs ? null : tab.path;
  if (!path) {
    // Save As offers the file's own name in its folder, else "<tab title>.bnet" (FILE-014).
    const base = tab.title.endsWith(".bnet") ? tab.title.slice(0, -5) : tab.title;
    const name = tab.path ? baseName(tab.path) : `${base}.bnet`;
    path = await chooseSaveTarget(w.savePanelTitle, inFolder(tab.path ? dirName(tab.path) : null, name), [BNET_FILTER]);
    if (!path) return false;
  }
  // What is written is the document as it is now; edits made while the write runs stay unsaved.
  const now = tabById(id) ?? tab;
  try {
    const written = await api.documentWrite(path, now.document);
    if (!tabById(id)) return true;
    markSaved(id, written.path, written.name, now.revision);
    addStatus(w.saved(written.name), "success", id);
    void noteRecent(written.path);
    return true;
  } catch (e) {
    const r = reasonOf(e);
    addStatus(w.saveFailed(r.message), "error", id);
    await report({ title: w.saveFailedTitle, message: r.message, details: r.detail });
    return false;
  }
}
