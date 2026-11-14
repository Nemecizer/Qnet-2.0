// Whether the Welcome view is asked for. It is a view inside the main window, over the workspace
// of a blank Untitled tab, never a window of its own and never over a network: it shows only
// while the active tab is blank, and the first thing put on the canvas (or the first drawing tool
// picked) dismisses it until it is asked for again.
//
//   "launch"  the app has just started: shown once the session restore has finished, if the
//             setting `welcome.showAtLaunch` is on and nothing was restored;
//   "open"    asked for (Help ▸ Welcome to Qnet, `openWelcome()`);
//   "closed"  dismissed.
import { useSyncExternalStore } from "react";
import { isBlank } from "../lib/bnet";
import { getSetting } from "../lib/kv";
import { activeTab, addTab, getWorkspace, isBlankTab, selectTab } from "../workspace/store";

export const SHOW_AT_LAUNCH_KEY = "welcome.showAtLaunch";

export type WelcomeMode = "launch" | "open" | "closed";

let mode: WelcomeMode = "launch";
const listeners = new Set<() => void>();

function set(next: WelcomeMode) {
  if (next === mode) return;
  mode = next;
  listeners.forEach((l) => l());
}

export const welcomeMode = () => mode;

export function useWelcomeMode(): WelcomeMode {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => mode,
  );
}

/**
 * Shows the Welcome view. It never covers a network: when the active tab has one, a blank
 * Untitled tab is selected (an existing one, else a new one) and the view shows over that.
 */
export function openWelcome(): void {
  const ws = getWorkspace();
  if (!isBlankTab(activeTab(ws))) {
    const blank = ws.tabs.find(isBlankTab);
    if (blank) selectTab(blank.id);
    else addTab();
  }
  set("open");
}

/** The view shown at launch stays until dismissed, whatever the launch setting becomes. */
export function keepWelcome(): void {
  if (mode === "launch") set("open");
}

export function closeWelcome(): void {
  set("closed");
}

/** Whether the view is on screen now, given what has loaded (`ready`: settings and the session restore). */
export function welcomeVisible(ready: boolean, m: WelcomeMode = mode): boolean {
  if (m === "closed" || !isBlank(activeTab().document)) return false;
  if (m === "open") return isBlankTab(activeTab());
  return ready && isBlankTab(activeTab()) && getSetting<boolean>(SHOW_AT_LAUNCH_KEY, true) === true;
}

/** For tests: as at launch. */
export function resetWelcome() {
  set("launch");
}
