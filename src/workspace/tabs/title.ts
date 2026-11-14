// The window's title and subtitle (0.90.34 ContentView.swift `windowTitle`, `windowSubtitle`,
// `WindowDocumentState`; ledger WS-003, WS-004, TB-014). macOS draws no title text in Qnet 2.0's
// overlay title bar, so the top bar shows them (WindowTitle); the native title is still set, so the
// Window menu and Mission Control name the window, and so are its represented file and edited dot.
import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
import { api } from "../../lib/api";
import { activeTab, getWorkspace, isDirty, onWorkspaceChange, type Tab } from "../store";
import { tabWords } from "./words";

let home: string | null = null;
const homeListeners = new Set<() => void>();

/** Learns the home folder once, for the "~" abbreviation. */
export async function loadHome(): Promise<void> {
  let h: unknown = null;
  try {
    h = await homeDir();
  } catch {
    h = null;
  }
  setHome(typeof h === "string" && h ? h.replace(/\/+$/, "") : null);
}

export function setHome(h: string | null) {
  if (h === home) return;
  home = h;
  homeListeners.forEach((l) => l());
}

/** The home folder (re-renders once it is known). */
export function useHome(): string | null {
  return useSyncExternalStore(
    (l) => {
      homeListeners.add(l);
      return () => homeListeners.delete(l);
    },
    () => home,
  );
}

/** NSString `abbreviatingWithTildeInPath`: the home folder, or a path inside it, starts with "~". */
export function abbreviateWithTilde(path: string, homeDir: string | null = home): string {
  if (!homeDir) return path;
  if (path === homeDir) return "~";
  return path.startsWith(homeDir + "/") ? "~" + path.slice(homeDir.length) : path;
}

/** The folder a file is in ("/" for a file at the root). */
export function folderOf(path: string): string {
  const at = path.replace(/\/+$/, "").lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

export function windowTitle(tab: Tab | undefined): string {
  return tab?.title || tabWords.untitled;
}

export function windowSubtitle(tab: Tab | undefined, homeDir: string | null = home): string {
  return tab?.path ? abbreviateWithTilde(folderOf(tab.path), homeDir) : tabWords.unsavedNetwork;
}

/** Keeps the native title, represented file and edited dot on the active tab; returns a function that stops. */
export function startTitleSync(): () => void {
  let last = "";
  const sync = () => {
    const tab = activeTab(getWorkspace());
    const title = windowTitle(tab);
    const path = tab?.path ?? null;
    const edited = !!tab && isDirty(tab);
    const key = JSON.stringify([title, path, edited]);
    if (key === last) return;
    const titleChanged = !last || JSON.parse(last)[0] !== title;
    last = key;
    if (titleChanged) {
      document.title = title;
      getCurrentWindow().setTitle(title).catch(() => {});
    }
    api.windowDocumentState(path, edited).catch(() => {});
  };
  sync();
  return onWorkspaceChange(sync);
}
