// Solve All Scenarios (new in 2.1, ROADMAP E1): Run ▸ Solve for the baseline and each scenario in
// turn. Each is shown (with no undo entry: `applyScenarioState(null, …)`), solved through Solve's
// own path — the Method Chooser's pick for that scenario's values, run by the existing sequential
// runner (src/panes/results/agreement/) — and when the last has ended, or Stop is pressed, what
// was shown before is shown again. A scenario whose result is already current is not run twice
// (Solve's own rule). The runs are ordinary records: each is its scenario's because its
// fingerprint is that scenario's network.
import { useSyncExternalStore } from "react";
import { editorFor } from "../editor";
import { solve } from "../panes/results/agreement/commands";
import { getSequence, sequenceRunning, stopSequence } from "../panes/results/agreement/runner";
import { liveRun } from "../runs/ui/live";
import { activeTab, addStatus, tabById } from "../workspace/store";
import { activeId, scenariosOf, switchScenario } from "./model";
import { scenarioWords as w } from "./words";

export interface SolveAllState {
  tabId: string;
  /** The variant being solved, from 1. */
  index: number;
  total: number;
  name: string;
  stopping: boolean;
}

let state: SolveAllState | null = null;
const listeners = new Set<() => void>();
const set = (next: SolveAllState | null) => {
  state = next;
  listeners.forEach((l) => l());
};

export const solveAllRunning = () => state !== null;
export const getSolveAll = (): SolveAllState | null => state;

export function useSolveAll(): SolveAllState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

function show(tabId: string, id: string | null): boolean {
  const doc = tabById(tabId)?.document;
  if (!doc) return false;
  if (id !== null && !scenariosOf(doc).some((s) => s.id === id)) return false;
  const next = switchScenario(doc, id);
  if (next !== doc) editorFor(tabId).applyScenarioState(null, next);
  return true;
}

/** Runs Solve for every variant of the tab's network. Resolves to how many were solved (or already had their result). */
export async function solveAllScenarios(tabId: string = activeTab().id): Promise<number> {
  const tab = tabById(tabId);
  if (!tab || !tab.document.nodes.length) return 0;
  if (state || sequenceRunning() || liveRun()) {
    addStatus(w.busy, "info", tabId);
    return 0;
  }
  const origin = activeId(tab.document);
  const variants: { id: string | null; name: string }[] = [{ id: null, name: w.baseline }, ...scenariosOf(tab.document).map((s) => ({ id: s.id, name: s.name }))];
  let done = 0;
  set({ tabId, index: 0, total: variants.length, name: "", stopping: false });
  try {
    for (let i = 0; i < variants.length; i++) {
      const at = getSolveAll();
      if (!at || at.stopping) break;
      // Solve acts on the tab in front, as every run does.
      if (!tabById(tabId) || activeTab().id !== tabId) break;
      const v = variants[i];
      if (!show(tabId, v.id)) continue;
      set({ ...at, index: i + 1, name: v.name });
      const picked = await solve(tabId);
      const after = getSolveAll();
      if (!after) break;
      if (!picked) {
        addStatus(w.solveAllNothing(v.name), "warning", tabId);
        continue;
      }
      // Stopped from anywhere (the run segment's Stop too): the sequence says so.
      if (getSequence()?.steps.some((s) => s.state === "stopped")) set({ ...after, stopping: true });
      else done++;
    }
  } finally {
    const stopped = getSolveAll()?.stopping ?? false;
    if (tabById(tabId)) {
      show(tabId, origin);
      addStatus(stopped ? w.solveAllStopped(done, variants.length) : w.solveAllDone(done), "info", tabId);
    }
    set(null);
  }
  return done;
}

/** Stop: the run in progress is interrupted and no further scenario is solved. */
export async function stopSolveAll(): Promise<void> {
  if (!state) return;
  set({ ...state, stopping: true });
  await stopSequence();
}

/** For tests. */
export function resetSolveAll() {
  set(null);
}
