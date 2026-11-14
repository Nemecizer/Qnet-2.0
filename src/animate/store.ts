// Which tabs are in animation mode (new in 2.1, ROADMAP Phase E). Kept in memory only: the mode
// is a way of looking at a network for a while, not a property of the document and not a
// preference, so it is never saved, never exported and off when the app starts.
import { useSyncExternalStore } from "react";
import type { AnimationEngine } from "./engine";

const on = new Set<string>();
const engines = new Map<string, AnimationEngine>();
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const animateOn = (tabId: string): boolean => on.has(tabId);
export const useAnimateOn = (tabId: string): boolean => useSyncExternalStore(subscribe, () => on.has(tabId));

export function setAnimate(tabId: string, value: boolean) {
  if (on.has(tabId) === value) return;
  if (value) on.add(tabId);
  else on.delete(tabId);
  publish();
}

export const toggleAnimate = (tabId: string) => setAnimate(tabId, !on.has(tabId));

/** The run a tab's canvas is showing, while its layer is mounted (the Space key finds it here). */
export function registerEngine(tabId: string, engine: AnimationEngine): () => void {
  engines.set(tabId, engine);
  return () => {
    if (engines.get(tabId) === engine) engines.delete(tabId);
  };
}

export const engineFor = (tabId: string): AnimationEngine | undefined => engines.get(tabId);

/**
 * Space on the canvas while its animation is on: play or pause. Returns true when the key was
 * taken (the canvas then does not start a Space-pan).
 */
export function animateKey(tabId: string, ev: { key: string; repeat?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; preventDefault: () => void }): boolean {
  if (ev.key !== " " || ev.metaKey || ev.ctrlKey || ev.altKey || !on.has(tabId)) return false;
  const engine = engines.get(tabId);
  if (!engine) return false;
  ev.preventDefault();
  if (!ev.repeat) engine.toggle();
  return true;
}

/** Tests. */
export function resetAnimate() {
  on.clear();
  engines.clear();
  publish();
}
