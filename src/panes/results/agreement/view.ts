// Which of the Results pane's views is asked for from outside it (Run ▸ Solve shows Agreement).
// The pane keeps the view itself; this only carries a request to it, or holds one until it mounts.
export type ResultsView = "table" | "agreement";

let pending: ResultsView | null = null;
const listeners = new Set<(v: ResultsView) => void>();

/** Asks the Results pane to show `view` (now if it is mounted, else when it next mounts). */
export function showResultsView(view: ResultsView) {
  if (listeners.size) listeners.forEach((l) => l(view));
  else pending = view;
}

/** The view asked for while no pane was mounted, once. */
export function takeRequestedView(): ResultsView | null {
  const v = pending;
  pending = null;
  return v;
}

export function onResultsViewRequest(l: (v: ResultsView) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
