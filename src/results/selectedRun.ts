// The run a person picked in a tab's Results pane (new in 2.1, ROADMAP Phase B), where views
// outside the pane can read it: the canvas overlay shows that run's values instead of the best
// current one. Only an explicit pick is published (a click or an arrow key in the run history);
// the pane's own "first row when nothing is picked" is not. A pick lasts until the tab's next run
// finishes, when the newest evidence is what a reader expects to see again.
import { useSyncExternalStore } from "react";
import { onRunFinished } from "../runs/state";

const picked = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function publish() {
  version++;
  listeners.forEach((l) => l());
}

const key = (tabId: string) => tabId.toUpperCase();

/** Records the run picked for `tabId`; null forgets it (back to the best current run). */
export function setSelectedRun(tabId: string, runId: string | null): void {
  const k = key(tabId);
  if ((picked.get(k) ?? null) === runId) return;
  if (runId === null) picked.delete(k);
  else picked.set(k, runId);
  publish();
}

export function selectedRunFor(tabId: string): string | null {
  return picked.get(key(tabId)) ?? null;
}

export function useSelectedRun(tabId: string): string | null {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return selectedRunFor(tabId);
}

onRunFinished((_m, meta) => setSelectedRun(meta.tabId, null));

/** For tests. */
export function resetSelectedRuns(): void {
  picked.clear();
  publish();
}
