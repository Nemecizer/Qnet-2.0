// Which run panel is up (0.90.34 QnetGUIApp.swift `runParameterRequest`, `showTestSetSheet`,
// `showSpectralConvergenceSheet` and their `sync…Panel` functions): the run-parameter sheet
// ("run-parameters"), the test-set panel ("test-set") or the spectral-convergence panel
// ("spectral-convergence"). `RunPanelsHost` (RunPanels.tsx) renders whatever is here.
import { useSyncExternalStore } from "react";
import type { SheetSpec, SheetValues } from "./specs";
import type { SpectralConvergenceForm, TestSetForm } from "./testsets";

export type PanelRequest =
  | {
      kind: "run";
      spec: SheetSpec;
      /** The tab the run is for; Cancel's line goes to it. */
      tabId: string;
      onRun: (values: SheetValues) => unknown;
    }
  | { kind: "test-set"; infinite: boolean; form: TestSetForm; tabId: string }
  | { kind: "spectral-convergence"; form: SpectralConvergenceForm; tabId: string };

let current: PanelRequest | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function openPanel(r: PanelRequest) {
  current = r;
  notify();
}

/** Clears the request (Run and Cancel both do, so the cancel line can't follow a Run, METH-013). */
export function closePanel() {
  if (!current) return;
  current = null;
  notify();
}

export function currentPanel(): PanelRequest | null {
  return current;
}

export function usePanelRequest(): PanelRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** For tests. */
export function resetPanels() {
  current = null;
  notify();
}
