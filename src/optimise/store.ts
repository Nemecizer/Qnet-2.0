// What the Capacity view remembers per tab (new in 2.1, ROADMAP D5): the problem as stated
// (targets, costs, what may change) and — for a network with no closed formula — the last plan
// found over solver runs, which took runs to make. The exact route keeps nothing: it is
// recomputed, at once, for the network and the problem as they are.
import { useSyncExternalStore } from "react";
import { sameNetwork } from "../results/current";
import { DEFAULT_FORM, type CapacityForm, type CapacityResult } from "./model";

const forms = new Map<string, CapacityForm>();
const plans = new Map<string, CapacityResult>();
const listeners = new Set<() => void>();
const viewListeners = new Set<() => void>();
let pendingView = false;

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const capacityForm = (tabId: string) => forms.get(tabId) ?? DEFAULT_FORM;
/** Changes the tab's form. A change the student made marks it touched; a suggestion (`touched: false`) does not. */
export function setCapacityForm(tabId: string, patch: Partial<CapacityForm>) {
  forms.set(tabId, { ...capacityForm(tabId), touched: true, ...patch });
  notify();
}
export const useCapacityForm = (tabId: string) => useSyncExternalStore(subscribe, () => capacityForm(tabId));

/** The tab's plan found over solver runs, when one has been made. */
export const capacityPlanOf = (tabId: string) => plans.get(tabId) ?? null;
export function setCapacityPlan(tabId: string, result: CapacityResult | null) {
  if (result) plans.set(tabId, result);
  else plans.delete(tabId);
  notify();
}
export const useCapacityPlan = (tabId: string) => useSyncExternalStore(subscribe, () => capacityPlanOf(tabId));

/** Whether the network has changed (in more than its layout) since the plan was made. */
export function planIsStale(result: CapacityResult, fingerprint: string | null): boolean {
  if (!result.fingerprint || fingerprint === null) return false;
  let run = asRuns.get(result);
  if (!run) {
    run = { provenance: { networkFingerprint: result.fingerprint, networkSnapshot: result.network ?? undefined } } as RunLike;
    asRuns.set(result, run);
  }
  return !sameNetwork(run, fingerprint);
}
type RunLike = Parameters<typeof sameNetwork>[0];
const asRuns = new WeakMap<CapacityResult, RunLike>();

/** Asks the Results pane to show the Capacity view (now, or when it next mounts). */
export function showCapacityView() {
  if (viewListeners.size) viewListeners.forEach((l) => l());
  else pendingView = true;
}
export function takeCapacityViewRequest(): boolean {
  const v = pendingView;
  pendingView = false;
  return v;
}
export function onCapacityViewRequest(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

/** For tests. */
export function resetCapacityStore() {
  forms.clear();
  plans.clear();
  pendingView = false;
  notify();
}
