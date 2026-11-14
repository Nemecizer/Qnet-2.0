// The Status pane's state beside the log itself, kept per tab (the log is `tab.log` in the
// workspace store): the severity filter, the search text and the match it last stepped to, the
// selected entries, and the entries the last Clear removed (0.90.34 `StatusPanelView`'s @State and
// `NetworkEditorModel.clearedStatusBacklog`). None of it is saved. It lives here, not in the
// component, so hiding or detaching the pane loses none of it (ledger LOG-026).
import { useSyncExternalStore } from "react";
import { destructive } from "../../lib/dialogs";
import { invalidateMenu } from "../../lib/menu";
import { getWorkspace, setLog, tabById, type Severity, type StatusEntry } from "../../workspace/store";
import { formattedLines, makeEntry } from "./entries";
import { statusWords as w } from "./words";

export type Filter = "all" | "warnings" | "errors";

export interface PaneState {
  filter: Filter;
  search: string;
  /** Index into the visible entries of the match Return / ⌘G last stepped to. */
  matchIndex: number;
  selection: ReadonlySet<string>;
  /** What the last Clear removed, until Undo Clear or the next clear. */
  backlog: StatusEntry[];
}

const EMPTY: PaneState = { filter: "all", search: "", matchIndex: 0, selection: new Set(), backlog: [] };
let states = new Map<string, PaneState>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
  invalidateMenu();
}

export function paneState(tabId: string): PaneState {
  return states.get(tabId) ?? EMPTY;
}

export function setPaneState(tabId: string, patch: Partial<PaneState>) {
  const next = { ...paneState(tabId), ...patch };
  // A new query or filter starts counting matches again (`onChange(of: searchText/filter)`).
  if (("search" in patch && patch.search !== paneState(tabId).search) || ("filter" in patch && patch.filter !== paneState(tabId).filter)) {
    if (!("matchIndex" in patch)) next.matchIndex = 0;
  }
  states = new Map(states).set(tabId, next);
  notify();
}

export function usePaneState(tabId: string): PaneState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => paneState(tabId),
  );
}

/** Drops the state of tabs that are gone. */
export function forgetClosedTabs() {
  const ids = new Set(getWorkspace().tabs.map((t) => t.id));
  if ([...states.keys()].every((k) => ids.has(k))) return;
  states = new Map([...states].filter(([k]) => ids.has(k)));
  notify();
}

/** For tests. */
export function resetPaneStates() {
  states = new Map();
  notify();
}

/** The trimmed query (`.whitespaces`: spaces and tabs). */
export function query(s: PaneState): string {
  return s.search.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
}

/** The entries the filter and the query leave (`filtered`): Warnings includes errors; the query matches case-insensitively. */
export function visibleEntries(log: StatusEntry[], s: PaneState): StatusEntry[] {
  const q = query(s).toLocaleLowerCase();
  return log.filter((e) => {
    if (s.filter === "warnings" && e.severity !== "warning" && e.severity !== "error") return false;
    if (s.filter === "errors" && e.severity !== "error") return false;
    return !q || e.text.toLocaleLowerCase().includes(q);
  });
}

export const isFiltering = (s: PaneState) => s.filter !== "all" || query(s) !== "";

/** Writes a line to a tab's log, its severity inferred from the wording when none is given. */
export function logStatus(tabId: string, text: string, severity?: Severity) {
  const t = tabById(tabId);
  if (!t) return;
  setLog(tabId, [...t.log, makeEntry(text, severity)]);
}

/** Number of entries above which Clear Status Log asks first (`clearConfirmThreshold`). */
export const CLEAR_CONFIRM_THRESHOLD = 20;

/**
 * The one Clear Status Log (header button, context menu, Edit ▸ Clear Status Log): asks first
 * once the log has more than 20 entries, empties it completely and keeps what it removed for Undo
 * Clear until the next clear (ledger LOG-025, LOG-026). Resolves true when it cleared.
 */
export async function clearStatusLog(tabId: string, target?: Document): Promise<boolean> {
  const entries = tabById(tabId)?.log ?? [];
  if (!entries.length) return false;
  if (entries.length > CLEAR_CONFIRM_THRESHOLD) {
    const ok = await destructive({ title: w.clearAskTitle, message: w.clearAskMessage(entries.length), confirmTitle: w.clearAskConfirm, target });
    if (!ok) return false;
  }
  const now = tabById(tabId);
  if (!now) return false;
  setPaneState(tabId, { backlog: now.log, selection: new Set() });
  setLog(tabId, []);
  return true;
}

/** Puts the last cleared entries back above anything logged since (`undoClearStatusLog`). */
export function undoClearStatusLog(tabId: string) {
  const s = paneState(tabId);
  const t = tabById(tabId);
  if (!s.backlog.length || !t) return;
  setPaneState(tabId, { backlog: [] });
  setLog(tabId, [...s.backlog, ...t.log]);
}

/** Puts text on the clipboard of `win` (the pane's window). */
export async function writeClipboard(text: string, win: Window = window): Promise<void> {
  try {
    await win.navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall back to a selection copy below (an older WebKit, or no user activation).
  }
  const doc = win.document;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.appendChild(area);
  area.select();
  try {
    doc.execCommand("copy");
  } finally {
    area.remove();
  }
}

/** Copy is never silent: the log says how many entries went to the clipboard (`copy`). */
export async function copyEntries(tabId: string, items: StatusEntry[], win?: Window) {
  if (!items.length) return;
  await writeClipboard(formattedLines(items), win);
  logStatus(tabId, w.copied(items.length), "success");
}
