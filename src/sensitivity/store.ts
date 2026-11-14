// What the Sensitivity view remembers per tab (new in 2.1, ROADMAP D1): the choices (measure,
// chart or table, the target) and — for a network with no closed formula — the last numerical
// estimate, which took solver runs to make. The exact route keeps nothing: it is recomputed, at
// once, for the network as it is.
import { useSyncExternalStore } from "react";
import { sameNetwork } from "../results/current";
import type { SensitivityResult } from "./model";
import type { Direction } from "./words";

export interface SensitivitySelection {
  measureKey: string | null;
  mode: "chart" | "table";
  direction: Direction;
  /** The target's percentage, as typed. */
  percent: string;
}

const DEFAULT: SensitivitySelection = { measureKey: null, mode: "chart", direction: "cut", percent: "10" };
const selections = new Map<string, SensitivitySelection>();
const estimates = new Map<string, SensitivityResult>();
const listeners = new Set<() => void>();
const viewListeners = new Set<() => void>();
let pendingView = false;

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const sensitivitySelection = (tabId: string) => selections.get(tabId) ?? DEFAULT;
export function setSensitivitySelection(tabId: string, patch: Partial<SensitivitySelection>) {
  selections.set(tabId, { ...sensitivitySelection(tabId), ...patch });
  notify();
}
export const useSensitivitySelection = (tabId: string) => useSyncExternalStore(subscribe, () => sensitivitySelection(tabId));

/** The tab's numerical estimate, when one has been made. */
export const sensitivityEstimate = (tabId: string) => estimates.get(tabId) ?? null;
export function setSensitivityEstimate(tabId: string, result: SensitivityResult | null) {
  if (result) estimates.set(tabId, result);
  else estimates.delete(tabId);
  notify();
}
export const useSensitivityEstimate = (tabId: string) => useSyncExternalStore(subscribe, () => sensitivityEstimate(tabId));

/** Whether the network has changed (in more than its layout) since the estimate was made. */
export function estimateIsStale(result: SensitivityResult, fingerprint: string | null): boolean {
  if (!result.fingerprint || fingerprint === null) return false;
  let run = asRuns.get(result);
  if (!run) {
    run = { provenance: { networkFingerprint: result.fingerprint, networkSnapshot: result.network ?? undefined } } as RunLike;
    asRuns.set(result, run);
  }
  return !sameNetwork(run, fingerprint);
}
type RunLike = Parameters<typeof sameNetwork>[0];
const asRuns = new WeakMap<SensitivityResult, RunLike>();

/** Asks the Results pane to show the Sensitivity view (now, or when it next mounts). */
export function showSensitivityView() {
  if (viewListeners.size) viewListeners.forEach((l) => l());
  else pendingView = true;
}
export function takeSensitivityViewRequest(): boolean {
  const v = pendingView;
  pendingView = false;
  return v;
}
export function onSensitivityViewRequest(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

/** For tests. */
export function resetSensitivityStore() {
  selections.clear();
  estimates.clear();
  pendingView = false;
  notify();
}
