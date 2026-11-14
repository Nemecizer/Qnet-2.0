// The open documents: one tab per network, each with its own document, file, unsaved state and
// Status log (0.90.34 `NetworkTab` and its `NetworkEditorModel`, ledger WS-034). The interface
// owns these (PLAN.md §3); Rust only reads and writes the files.
//
// This module holds the state and its plain changes. What the user sees as one action (closing
// tabs with their save guards, Reopen Closed Tab, Open, Save, session restore) is built on these
// in src/workspace/tabs/ and src/workspace/files/; nothing else changes the tabs directly.
import { useSyncExternalStore } from "react";
import { emptyDocument, isBlank, newId, type BnetDocument } from "../lib/bnet";
import { invalidateMenu } from "../lib/menu";
import { inferSeverity } from "../panes/status/entries";
import { canonicalScenarios } from "../scenarios/model";

/** 0.90.34 `StatusSeverity`. */
export type Severity = "info" | "success" | "warning" | "error";

/** One line of a tab's Status log (0.90.34 `StatusEntry`). */
export interface StatusEntry {
  id: string;
  /** When it was written, in ms since the epoch. */
  date: number;
  severity: Severity;
  text: string;
}

export interface Tab {
  /** An upper-case UUID; the results store files records under it (P3's runner/src/store.rs). */
  id: string;
  /** "Untitled", or the file name with its extension (ledger WS-031, WS-032). */
  title: string;
  /** The file it was opened from or saved to; null for a network never saved. */
  path: string | null;
  document: BnetDocument;
  /** Bumped by every change to `document`. */
  revision: number;
  /** The revision last opened or saved; the tab has unsaved changes when the two differ. */
  savedRevision: number;
  log: StatusEntry[];
}

export interface Workspace {
  tabs: Tab[];
  activeId: string;
}

// A new tab's log starts empty here; the Status pane writes 0.90.34's greeting into it when it
// first sees the tab (src/panes/status/index.tsx, ledger LOG-001).
function blankTab(): Tab {
  return { id: newId(), title: "Untitled", path: null, document: emptyDocument(), revision: 0, savedRevision: 0, log: [] };
}

const first = blankTab();
let state: Workspace = { tabs: [first], activeId: first.id };
const listeners = new Set<(ws: Workspace, prev: Workspace) => void>();
const reactListeners = new Set<() => void>();

// 0.90.34's edited dot compared content, not a counter (`documentSignature` over nodes, links and
// the buffer regime; zoom and pan excluded), so undoing back to the saved network makes the tab
// clean again. The content each tab had at its saved revision is remembered here.
const cleanContent = new Map<string, string>();

// Cached on the content arrays themselves, not the document object: a zoom or pan makes a new
// document around the same nodes and links, and must not cost a fresh stringify per wheel tick.
const signatures = new WeakMap<readonly unknown[], { links: readonly unknown[]; infinite: boolean; population: number | undefined; scenarios: unknown; sig: string }>();

/** The part of a document that counts as an edit: everything but the view (canvasScale, canvasPanOffset). */
export function documentSignature(d: BnetDocument): string {
  const hit = signatures.get(d.nodes);
  if (hit && hit.links === d.links && hit.infinite === d.infiniteBuffers && hit.population === d.closedPopulation && hit.scenarios === d.scenarios) return hit.sig;
  // A closed network's population is content too (new in 2.1); an open network's signature is as before.
  const content = d.closedPopulation === undefined ? [d.nodes, d.links, d.infiniteBuffers] : [d.nodes, d.links, d.infiniteBuffers, d.closedPopulation];
  // So are its scenarios (new in 2.1, src/scenarios/); a network without any signs as before.
  // Compared in one canonical form: the file's writer and the interface order an entry's keys
  // differently, and that is not an edit (canonicalScenarios, ledger WF-502).
  const sig = JSON.stringify(d.scenarios === undefined ? content : [...content, canonicalScenarios(d.scenarios)]);
  signatures.set(d.nodes, { links: d.links, infinite: d.infiniteBuffers, population: d.closedPopulation, scenarios: d.scenarios, sig });
  return sig;
}

function noteClean(next: Workspace, prev: Workspace) {
  const before = new Map(prev.tabs.map((t) => [t.id, t]));
  for (const t of next.tabs) {
    if (t.revision !== t.savedRevision) continue;
    const b = before.get(t.id);
    if (!b || b.document !== t.document || b.savedRevision !== t.savedRevision || !cleanContent.has(t.id)) cleanContent.set(t.id, documentSignature(t.document));
  }
  const ids = new Set(next.tabs.map((t) => t.id));
  for (const id of [...cleanContent.keys()]) if (!ids.has(id)) cleanContent.delete(id);
}

function set(next: Workspace) {
  const prev = state;
  noteClean(next, prev);
  state = next;
  reactListeners.forEach((l) => l());
  listeners.forEach((l) => l(next, prev));
  invalidateMenu();
}

function mapTab(id: string, f: (t: Tab) => Tab) {
  set({ ...state, tabs: state.tabs.map((t) => (t.id === id ? f(t) : t)) });
}

export function getWorkspace(): Workspace {
  return state;
}

/** Follows every change (session saving, the window title); returns a function that stops. */
export function onWorkspaceChange(l: (ws: Workspace, prev: Workspace) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useWorkspace<T>(select: (ws: Workspace) => T): T {
  return useSyncExternalStore(
    (l) => {
      reactListeners.add(l);
      return () => reactListeners.delete(l);
    },
    () => select(state),
  );
}

export function activeTab(ws: Workspace = state): Tab {
  return ws.tabs.find((t) => t.id === ws.activeId) ?? ws.tabs[0];
}

export function useActiveTab(): Tab {
  return useWorkspace(activeTab);
}

export function tabById(id: string): Tab | undefined {
  return state.tabs.find((t) => t.id === id);
}

/**
 * Unsaved changes (0.90.34 `hasUnsavedChanges`): the network differs from what was last opened or
 * saved. Edits that were all undone leave the tab clean; zoom and pan never count.
 */
export function isDirty(t: Tab): boolean {
  if (t.revision === t.savedRevision) return false;
  const clean = cleanContent.get(t.id) ?? documentSignature(emptyDocument());
  return documentSignature(t.document) !== clean;
}

/** A blank Untitled tab: no file, no nodes, no links (ledger WS-045). */
export function isBlankTab(t: Tab): boolean {
  return t.path === null && isBlank(t.document);
}

/** A new tab from `init`, appended and made active unless `activate` is false; returns its id. */
export function addTab(init: Partial<Omit<Tab, "id">> & { id?: string } = {}, opts: { activate?: boolean; index?: number } = {}): string {
  const tab: Tab = { ...blankTab(), ...init };
  const tabs = [...state.tabs];
  tabs.splice(opts.index ?? tabs.length, 0, tab);
  set({ tabs, activeId: opts.activate === false ? state.activeId : tab.id });
  return tab.id;
}

export function selectTab(id: string) {
  if (id === state.activeId || !tabById(id)) return;
  set({ ...state, activeId: id });
}

/**
 * Removes tabs with no questions asked (the guarded close is src/workspace/tabs/). Closing the
 * active tab activates the nearest survivor after it, else the one before (ledger WS-044); closing
 * the last tab leaves one new Untitled tab.
 */
export function removeTabs(ids: string[]) {
  const gone = new Set(ids);
  if (!state.tabs.some((t) => gone.has(t.id))) return;
  const order = state.tabs;
  let tabs = order.filter((t) => !gone.has(t.id));
  let activeId = state.activeId;
  if (gone.has(activeId)) {
    const at = order.findIndex((t) => t.id === activeId);
    const after = order.slice(at + 1).find((t) => !gone.has(t.id));
    const before = [...order.slice(0, at)].reverse().find((t) => !gone.has(t.id));
    activeId = (after ?? before)?.id ?? "";
  }
  if (!tabs.length) {
    const t = blankTab();
    tabs = [t];
    activeId = t.id;
  }
  set({ tabs, activeId });
}

/** Moves a tab to `index` in the bar (the active tab stays active). */
export function moveTab(id: string, index: number) {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from < 0) return;
  const tabs = [...state.tabs];
  const [t] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, t);
  set({ ...state, tabs });
}

/** Replaces a tab's document: one edit, so the tab now has unsaved changes. */
export function setDocument(id: string, document: BnetDocument) {
  mapTab(id, (t) => ({ ...t, document, revision: t.revision + 1 }));
}

/**
 * Records the canvas's zoom and pan in the tab's document without counting as an edit (0.90.34
 * kept them on the editor and wrote the zoom into the file only when saving; the pan is always
 * saved as zero by core's writer, and kept here for the session).
 */
export function setDocumentView(id: string, canvasScale: number, canvasPanOffset: [number, number]) {
  const t = tabById(id);
  if (!t) return;
  const d = t.document;
  if (d.canvasScale === canvasScale && d.canvasPanOffset[0] === canvasPanOffset[0] && d.canvasPanOffset[1] === canvasPanOffset[1]) return;
  mapTab(id, (tab) => ({ ...tab, document: { ...tab.document, canvasScale, canvasPanOffset } }));
}

/** Changes a tab's fields as given (title, path, the saved revision…). */
export function updateTab(id: string, patch: Partial<Omit<Tab, "id">>) {
  mapTab(id, (t) => ({ ...t, ...patch }));
}

/** After a save to `path`: the tab takes the file's name and has no unsaved changes. */
export function markSaved(id: string, path: string, title: string, revision?: number) {
  mapTab(id, (t) => ({ ...t, path, title, savedRevision: revision ?? t.revision }));
}

/**
 * Adds a line to a tab's Status log (the active tab's when `tabId` is omitted). Without a
 * severity, the words decide it, as 0.90.34's `addStatus(_:)` did (`inferSeverity`, LOG-004).
 */
export function addStatus(text: string, severity?: Severity, tabId?: string) {
  const id = tabId ?? state.activeId;
  const entry: StatusEntry = { id: crypto.randomUUID().toUpperCase(), date: Date.now(), severity: severity ?? inferSeverity(text), text };
  mapTab(id, (t) => ({ ...t, log: [...t.log, entry] }));
}

/** Replaces a tab's whole Status log (Clear, Undo Clear, a restored session). */
export function setLog(id: string, log: StatusEntry[]) {
  mapTab(id, (t) => ({ ...t, log }));
}

/** Replaces everything (session restore, tests). At least one tab; the active one must exist. */
export function replaceWorkspace(ws: Workspace) {
  if (!ws.tabs.length) {
    const t = blankTab();
    set({ tabs: [t], activeId: t.id });
    return;
  }
  set({ tabs: ws.tabs, activeId: ws.tabs.some((t) => t.id === ws.activeId) ? ws.activeId : ws.tabs[0].id });
}

/** For tests: one blank Untitled tab. */
export function resetWorkspace() {
  const t = blankTab();
  set({ tabs: [t], activeId: t.id });
}
