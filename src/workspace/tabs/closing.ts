// Closing document tabs (0.90.34 TabClosing.swift, QnetGUIApp.swift `closeTabs(ids:)`; ledger 5.3).
//
// There is one owner of "close these tabs": `closeTabs(ids)`. Every close goes through it (the ✕
// button, a middle click, the context menu's three items, ⌘W, ⌥⌘W), so the Save / Don't Save /
// Cancel guard can't be skipped and every closed tab is remembered for Reopen Closed Tab.
import { refuseClosingRunOwner } from "../../runs/ui/live";
import { useSyncExternalStore } from "react";
import { saveChanges } from "../../lib/dialogs";
import { invalidateMenu } from "../../lib/menu";
import type { BnetDocument } from "../../lib/bnet";
import { addStatus, addTab, getWorkspace, isBlankTab, isDirty, removeTabs, selectTab, tabById, type StatusEntry, type Tab } from "../store";
import { saveTab } from "../files";
import { tabWords } from "./words";

/** What it takes to bring a closed tab back (0.90.34 `ClosedTab`). */
export interface ClosedTab {
  /** The tab's own id: 2.0 reopens under it, so its Results come back too (WS-048, Changed). */
  id: string;
  title: string;
  document: BnetDocument;
  path: string | null;
  log: StatusEntry[];
  wasClean: boolean;
  closedAt: number;
}

/** 0.90.34 `ClosedTabHistory.capacity`. */
export const CLOSED_TAB_CAPACITY = 10;

let stack: ClosedTab[] = [];
const listeners = new Set<() => void>();

function changed() {
  listeners.forEach((l) => l());
  invalidateMenu();
}

/** Pushes the tab if there is anything to bring back: a blank Untitled tab is not kept (WS-045). */
export function remember(tab: Tab) {
  if (isBlankTab(tab)) return;
  stack = [...stack, { id: tab.id, title: tab.title, document: tab.document, path: tab.path, log: tab.log, wasClean: !isDirty(tab), closedAt: Date.now() }];
  if (stack.length > CLOSED_TAB_CAPACITY) stack = stack.slice(stack.length - CLOSED_TAB_CAPACITY);
  changed();
}

export function closedTabs(): readonly ClosedTab[] {
  return stack;
}

/** The title ⇧⌘T would bring back, for its tooltip; null when nothing has been closed. */
export function mostRecentClosedTitle(): string | null {
  return stack.length ? stack[stack.length - 1].title : null;
}

export function useClosedTabs(): readonly ClosedTab[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => stack,
  );
}

/**
 * Window ▸ Reopen Closed Tab (WS-046, WS-047): pops the most recent, appends it at the end of the
 * bar and selects it, with its document, file and log, dirty if it was closed with Don't Save, and
 * a log line saying so. Returns its id, or null when there was nothing to reopen.
 */
export function reopenClosedTab(): string | null {
  const closed = stack[stack.length - 1];
  if (!closed) return null;
  stack = stack.slice(0, -1);
  changed();
  // The id is free again unless something reused it meanwhile; then the tab gets a new one.
  const id = tabById(closed.id) ? undefined : closed.id;
  const newId = addTab({
    ...(id ? { id } : {}),
    title: closed.title,
    path: closed.path,
    document: closed.document,
    log: closed.log,
    revision: 1,
    savedRevision: closed.wasClean ? 1 : 0,
  });
  addStatus(tabWords.reopened(closed.title, closed.wasClean), "info", newId);
  return newId;
}

/**
 * The review loop (0.90.34 `TabClosing.confirmClose`): every dirty tab among `tabs`, in tab-bar
 * order, asks Save / Don't Save / Cancel. Save saves it (the Save panel for an untitled network) and
 * a cancelled or failed save cancels the whole close; Cancel anywhere cancels it; Don't Save moves on.
 */
export async function confirmClose(tabs: Tab[]): Promise<boolean> {
  for (const t of tabs) {
    const tab = tabById(t.id) ?? t;
    if (!isDirty(tab)) continue;
    const choice = await saveChanges(tab.title, tab.path !== null);
    if (choice === "cancel") return false;
    if (choice === "save" && !(await saveTab(tab.id))) return false;
  }
  return true;
}

let busy = false;

/**
 * Closes `ids` with the guard (WS-036, WS-039): asks about each dirty one, remembers each closed tab
 * for Reopen Closed Tab, then removes them (WS-044's next-active rule; the last close leaves a new
 * Untitled tab). Resolves true when they closed. A second close while one is asking waits its turn
 * by doing nothing (0.90.34's alert was modal).
 */
export async function closeTabs(ids: Iterable<string>): Promise<boolean> {
  const set = new Set(ids);
  // A tab whose solver run is still going can't be closed (ledger WS-043).
  if (refuseClosingRunOwner(set)) return false;
  const closing = getWorkspace().tabs.filter((t) => set.has(t.id));
  if (!closing.length || busy) return false;
  busy = true;
  try {
    if (!(await confirmClose(closing))) return false;
    // Re-read: a Save renamed the tab and made it clean, and that is what Reopen should bring back.
    const now = closing.map((t) => tabById(t.id)).filter((t): t is Tab => !!t);
    for (const t of now) remember(t);
    removeTabs(now.map((t) => t.id));
    return true;
  } finally {
    busy = false;
  }
}

/** Close Other Tabs: every tab but `id`; nothing when there are none (WS-038). */
export function closeOtherTabs(id: string): Promise<boolean> {
  const others = getWorkspace().tabs.filter((t) => t.id !== id).map((t) => t.id);
  return others.length ? closeTabs(others) : Promise.resolve(false);
}

/** Close Tabs to the Right of `id`; nothing when it is the last (WS-038). */
export function closeTabsToTheRight(id: string): Promise<boolean> {
  const tabs = getWorkspace().tabs;
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0 || at === tabs.length - 1) return Promise.resolve(false);
  return closeTabs(tabs.slice(at + 1).map((t) => t.id));
}

export function closeAllTabs(): Promise<boolean> {
  return closeTabs(getWorkspace().tabs.map((t) => t.id));
}

/** Show Next / Previous Tab (WS-028): steps through the tabs, wrapping round; nothing with one tab. */
export function showAdjacentTab(offset: 1 | -1) {
  const { tabs, activeId } = getWorkspace();
  const at = tabs.findIndex((t) => t.id === activeId);
  if (tabs.length < 2 || at < 0) return;
  selectTab(tabs[(at + offset + tabs.length) % tabs.length].id);
}

/** For tests: forget the closed tabs. */
export function resetClosedTabs() {
  stack = [];
  busy = false;
  changed();
}
