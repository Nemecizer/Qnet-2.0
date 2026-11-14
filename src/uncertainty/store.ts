// What the Uncertainty view remembers per tab (new in 2.1, ROADMAP D7): the measure, the
// uncertainties typed and how they are read. The answer itself is not kept: for a Jackson network
// it is recomputed (same seed, same numbers); for any other network it is built from the
// Sensitivity view's numerical estimate, which that view keeps.
import { useSyncExternalStore } from "react";
import { BLANK_OVERRIDE, DEFAULT_SETTINGS, type Override, type UncertaintySettings } from "./model";

const settings = new Map<string, UncertaintySettings>();
const listeners = new Set<() => void>();
const viewListeners = new Set<() => void>();
let pendingView = false;

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const uncertaintySettings = (tabId: string) => settings.get(tabId) ?? DEFAULT_SETTINGS;
export function setUncertaintySettings(tabId: string, patch: Partial<UncertaintySettings>) {
  settings.set(tabId, { ...uncertaintySettings(tabId), ...patch });
  notify();
}
export function setUncertaintyOverride(tabId: string, id: string, patch: Partial<Override>) {
  const s = uncertaintySettings(tabId);
  setUncertaintySettings(tabId, { overrides: { ...s.overrides, [id]: { ...(s.overrides[id] ?? BLANK_OVERRIDE), ...patch } } });
}
export const useUncertaintySettings = (tabId: string) => useSyncExternalStore(subscribe, () => uncertaintySettings(tabId));

/** Asks the Results pane to show the Uncertainty view (now, or when it next mounts). */
export function showUncertaintyView() {
  if (viewListeners.size) viewListeners.forEach((l) => l());
  else pendingView = true;
}
export function takeUncertaintyViewRequest(): boolean {
  const v = pendingView;
  pendingView = false;
  return v;
}
export function onUncertaintyViewRequest(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

/** For tests. */
export function resetUncertaintyStore() {
  settings.clear();
  pendingView = false;
  notify();
}
