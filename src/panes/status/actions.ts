// Actions on Status lines (new in 2.0): a line may carry one button beside its text, such as a
// failed run's "Show Report…" (src/runs/reports). The line's text, its copy and its saved form are
// unchanged: the action is kept here by the entry's id, for this session only.
import { useSyncExternalStore } from "react";

export interface StatusAction {
  /** The button's title ("Show Report…"). */
  label: string;
  /** Its tooltip. */
  help?: string;
  run: () => void;
}

/** How many lines may carry an action at once; the oldest goes first. */
const LIMIT = 200;
const actions = new Map<string, StatusAction>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  listeners.forEach((l) => l());
}

/** Gives the Status entry `entryId` an action (or takes it away with null). */
export function setStatusAction(entryId: string, action: StatusAction | null) {
  actions.delete(entryId);
  if (action) {
    actions.set(entryId, action);
    while (actions.size > LIMIT) actions.delete(actions.keys().next().value as string);
  }
  notify();
}

export function statusAction(entryId: string): StatusAction | undefined {
  return actions.get(entryId);
}

/** Re-renders when any line's action changes. */
export function useStatusActions(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** For tests. */
export function resetStatusActions() {
  actions.clear();
  notify();
}
