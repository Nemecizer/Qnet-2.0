// Tabs: the tab bar, closing with save guards, Reopen Closed Tab, the window title, the Window
// menu's tab items, and session restore with the quit prompt (ledger 5.1–5.3, 5.10). The pieces:
// closing.ts (the one guarded close, the closed-tab stack), session.ts (the snapshot, restore,
// quit), title.ts (title, subtitle, edited dot), frame.ts (the window frame), TabBar.tsx.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../../lib/api";
import { focusedAuxWindow } from "../../lib/auxWindow";
import { openPath } from "../files/documents";
import { useCommands, type Command } from "../../lib/commands";
import { registerMenuProvider, type DynamicItem } from "../../lib/menu";
import { MODAL_REASON, modalOpen } from "../../lib/overlays";
import { addStatus, getWorkspace, onWorkspaceChange, selectTab, useActiveTab } from "../store";
import { closeAllTabs, closeTabs, mostRecentClosedTitle, reopenClosedTab, showAdjacentTab, useClosedTabs } from "./closing";
import { restoreFrame, saveFrame, trackFrame } from "./frame";
import { quit, restoreSession, startAutosave } from "./session";
import { loadHome, startTitleSync, useHome, windowSubtitle, windowTitle } from "./title";
import { tabWords } from "./words";

export { TabBar } from "./TabBar";

/** The window's title and subtitle, in the top bar (WS-003, TB-014). */
export function WindowTitle() {
  const tab = useActiveTab();
  const home = useHome();
  return (
    <span className="topbar-title window-title" data-tauri-drag-region>
      <span className="window-title-main" data-tauri-drag-region>{windowTitle(tab)}</span>
      <span className="window-title-sub" data-tauri-drag-region>{windowSubtitle(tab, home)}</span>
    </span>
  );
}

// --- The main window closed with its close button or ⇧⌘W (WS-049): no unsaved-changes check, and
// the app keeps running. 2.0 hides the window rather than destroying it, because its page holds the
// tabs (0.90.34 kept them in the App and showed them again in a new window).

let hidden = false;

export async function hideMainWindow(): Promise<void> {
  await saveFrame();
  hidden = true;
  await getCurrentWindow().hide().catch(() => {});
}

/** Brings the main window back when it was closed (Quit's prompt and the Window menu need it). */
export async function showMainWindow(): Promise<void> {
  if (!hidden) return;
  hidden = false;
  const w = getCurrentWindow();
  await w.show().catch(() => {});
  await w.setFocus().catch(() => {});
}

// A command that changes the tabs while the main window is closed (File ▸ New or Open from the
// menu bar, which stays live) shows the window again, so nothing happens out of sight.
onWorkspaceChange(() => {
  if (hidden) void showMainWindow();
});

const unlessModal = () => (modalOpen() ? MODAL_REASON : true);

function tabSwitchWhen(): true | string {
  if (getWorkspace().tabs.length < 2) return tabWords.fewerThanTwoTabs;
  return unlessModal();
}

/** ⌘W (WS-037): the front auxiliary window when one has the keyboard, else the active tab. */
export async function closeTabOrKeyWindow(): Promise<void> {
  const aux = focusedAuxWindow();
  if (aux) {
    aux.close();
    return;
  }
  // Its save guard must be seen: a closed main window comes back first.
  await showMainWindow();
  await closeTabs([getWorkspace().activeId]);
}

/** ⇧⌘W (WS-049): the front auxiliary window, or the main window itself. */
export async function closeKeyWindow(): Promise<void> {
  const aux = focusedAuxWindow();
  if (aux) {
    aux.close();
    return;
  }
  await hideMainWindow();
}

export function quitQnet(): Promise<void> {
  return quit({ beforeAsk: showMainWindow });
}

/** Window ▸ the first nine tabs, ⌘1–⌘9, the active one checked (MENU-144, WS-029). */
export function tabMenuItems(): DynamicItem[] {
  const { tabs, activeId } = getWorkspace();
  const enabled = !modalOpen();
  const items: DynamicItem[] = tabs.slice(0, 9).map((t, i) => ({
    id: `window:tab-${i + 1}`,
    label: t.title,
    accel: `CmdOrCtrl+${i + 1}`,
    checked: t.id === activeId,
    enabled,
    run: () => {
      void showMainWindow();
      selectTab(t.id);
    },
  }));
  return items;
}

/** The File menu's close items, Quit, and the Window menu's tab items. */
export function useTabCommands() {
  const closed = useClosedTabs();
  const reopenTitle = mostRecentClosedTitle();
  useCommands(
    [
      { id: "file:close-tab", title: "Close Tab", group: "File", subtitle: tabWords.closeTabSubtitle, when: unlessModal, run: closeTabOrKeyWindow },
      { id: "file:close-all-tabs", title: "Close All Tabs", group: "File", subtitle: tabWords.closeAllTabsSubtitle, when: unlessModal, run: async () => {
        await showMainWindow();
        await closeAllTabs();
      } },
      { id: "file:close-window", title: "Close Window", group: "File", subtitle: tabWords.closeWindowSubtitle, when: unlessModal, run: closeKeyWindow },
      { id: "window:next-tab", title: "Show Next Tab", group: "Window", subtitle: tabWords.nextTabSubtitle, when: tabSwitchWhen, run: () => showAdjacentTab(1) },
      { id: "window:previous-tab", title: "Show Previous Tab", group: "Window", subtitle: tabWords.previousTabSubtitle, when: tabSwitchWhen, run: () => showAdjacentTab(-1) },
      {
        id: "window:reopen-tab",
        title: "Reopen Closed Tab",
        group: "Window",
        subtitle: tabWords.reopenSubtitle(reopenTitle),
        when: () => (closed.length === 0 ? tabWords.nothingToReopen : unlessModal()),
        run: () => {
          void showMainWindow();
          reopenClosedTab();
        },
      },
      { id: "app:quit", title: "Quit Qnet", group: "Qnet", keywords: ["exit"], run: quitQnet },
    ] satisfies Command[],
    [closed, reopenTitle],
  );
  useEffect(() => registerMenuProvider("window:tabs", tabMenuItems), []);
}

/** ⌃⇥ / ⌃⇧⇥ in the page (KEY-002, WS-028): next / previous tab, only in the main window. */
export function onTabSwitchKey(e: KeyboardEvent) {
  if (e.code !== "Tab" || !e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || modalOpen()) return;
  e.preventDefault();
  showAdjacentTab(e.shiftKey ? -1 : 1);
}

let openingFromFinder: Promise<void> = Promise.resolve();

/**
 * Opens what Finder sent (WS-124, new in 2.0): each file as File ▸ Open would, one after another;
 * a file that is already open in a tab is brought to the front instead of opened twice.
 */
export function openFilesFromFinder(): Promise<void> {
  openingFromFinder = openingFromFinder.then(async () => {
    // Not under a prompt or a parameter panel: the files wait until it is answered (MENU-198).
    while (modalOpen()) await new Promise((r) => setTimeout(r, 300));
    const paths = await api.openedFilesTake().catch(() => [] as string[]);
    for (const path of paths) {
      try {
        const open = getWorkspace().tabs.find((t) => t.path === path);
        if (open) selectTab(open.id);
        else await openPath(path);
      } catch (e) {
        // One file that can't be opened doesn't stop the others, now or later.
        addStatus(tabWords.finderOpenFailed(path, e instanceof Error ? e.message : String(e)), "error");
      }
    }
  });
  return openingFromFinder;
}

/** Launch-time restore, the quit prompt, the title, the window frame: what lives as long as the app. */
export function TabsHost() {
  useEffect(() => {
    let alive = true;
    const stops: (() => void)[] = [];
    void loadHome();
    void restoreFrame();
    stops.push(trackFrame());
    // WS-007: the main window is key at launch.
    getCurrentWindow().setFocus().catch(() => {});
    restoreSession().then(() => {
      if (!alive) return;
      stops.push(startAutosave());
      stops.push(startTitleSync());
      // A file double-clicked in Finder to launch Qnet opens after the session is back.
      void openFilesFromFinder();
    });
    const later = (p: Promise<() => void>) => p.then((u) => (alive ? stops.push(u) : u()), () => {});
    // A quit from the Dock or logging out (src-tauri/src/lib.rs) runs the same prompt as ⌘Q.
    later(listen("app://quit-requested", () => void quitQnet()));
    // A .bnet opened from Finder or dropped on the Dock icon while Qnet runs (WS-124).
    later(
      listen("app://open-files", () => void restoreSession().then(openFilesFromFinder)).then((stop) => {
        // Anything that arrived between the launch-time take and this listener being ready.
        void restoreSession().then(openFilesFromFinder);
        return stop;
      }),
    );
    try {
      later(getCurrentWindow().onCloseRequested((e) => {
        e.preventDefault();
        void hideMainWindow();
      }));
    } catch {
      // No window (a test without one).
    }
    window.addEventListener("keydown", onTabSwitchKey);
    stops.push(() => window.removeEventListener("keydown", onTabSwitchKey));
    return () => {
      alive = false;
      stops.forEach((s) => s());
    };
  }, []);
  return null;
}

/** For tests. */
export function resetTabsHost() {
  hidden = false;
}
