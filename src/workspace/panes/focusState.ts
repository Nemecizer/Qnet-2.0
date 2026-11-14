// Which pane has the keyboard, as a store the pane headers' focus rule and the commands read
// (FocusRouter.refresh, ledger WS-013, WS-098). focus.ts answers the question; this follows it in
// the main window and in every detached pane's window (`focusin` / `focusout` on each `win`).
import { useSyncExternalStore } from "react";
import { focusedPane, type PaneId } from "../focus";
import { invalidateMenu } from "../../lib/menu";

let current: PaneId | null = null;
const listeners = new Set<() => void>();

/** Re-reads focus; called after every focus change in any of the app's windows. */
export function refreshFocus() {
  const p = focusedPane();
  if (p === current) return;
  current = p;
  listeners.forEach((l) => l());
  invalidateMenu();
}

export function currentFocusedPane(): PaneId | null {
  return current;
}

export function useFocusedPane(): PaneId | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Follows focus in `win` (the main window, or a detached pane's); returns a function that stops. */
export function trackFocusIn(win: Window): () => void {
  // focusout fires before focus lands: read again once it has.
  const later = () => queueMicrotask(refreshFocus);
  win.addEventListener("focusin", refreshFocus, true);
  win.addEventListener("focusout", later, true);
  win.addEventListener("focus", later);
  return () => {
    win.removeEventListener("focusin", refreshFocus, true);
    win.removeEventListener("focusout", later, true);
    win.removeEventListener("focus", later);
  };
}

/** For tests. */
export function resetFocusState() {
  current = null;
}
