// Which Fit from Data… panel is up, and for what (new in 2.1, ROADMAP D2). The inspector opens it
// with the law it is editing; "Use This Distribution" hands the family and parameters back through
// `apply`, so the change goes through the inspector's own draft and commit — one undo step, the
// same as choosing the family and typing the numbers by hand.
import { useSyncExternalStore } from "react";

export interface FitTarget {
  /** Inter-arrival times (a source: the exponential fit is a Poisson process) or service times. */
  kind: "station" | "source";
  /** "the service time at S1": completes "Measured times for …" and "Set … to …". */
  target: string;
  /** Takes the chosen law: a family name and its "key=value,…" parameters. */
  apply: (distribution: string, parameters: string) => void;
}

let request: FitTarget | null = null;
const listeners = new Set<() => void>();
/** How many `FitHost`s are mounted; with none, the first open makes one. */
export const fitHosts = { mounted: 0, fallback: null as null | (() => void) };

const notify = () => listeners.forEach((l) => l());

export function openFitPanel(target: FitTarget) {
  request = target;
  if (!fitHosts.mounted) fitHosts.fallback?.();
  notify();
}

export function closeFitPanel() {
  if (!request) return;
  request = null;
  notify();
}

export const currentFitPanel = () => request;

export function useFitRequest(): FitTarget | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => request,
  );
}
