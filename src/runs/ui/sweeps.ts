// Starting a Test-menu sweep (Test Set, Spectral Convergence) for a tab and following it to its
// end. The sweep runs in Rust (src-tauri/src/testsets.rs) through the same single-flight registry
// and the same message shape as a Run-menu method, so it should be followed exactly as
// src/runs/state.ts follows `startRun`: Status lines to the owning tab, bytes to the Shell pane,
// progress and the end to the run segment, `onRunFinished` to the Results workspace.
//
// state.ts keeps that routing private. When it exports `followRun(tabId, method, launch)` (the
// body of `startRun` with the `api.runStart` call passed in — asked of the lead in the P6 report),
// sweeps go through it. Until then they are followed here: Status lines and the end are routed,
// the tab's records are reloaded, and the run segment and Test menu read `useSweepState`; the
// Shell pane does not see a sweep's bytes.
import { useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { allSettings } from "../../lib/kv";
import { invalidateMenu } from "../../lib/menu";
import type { RunMessage, SweepParams } from "../../lib/types";
import { addStatus, tabById } from "../../workspace/store";
import * as runState from "../state";
import { runWords as w } from "./words";

type Launch = (onMessage: (m: RunMessage) => void) => Promise<{ started: boolean }>;
type Follow = (tabId: string, method: string, launch: Launch) => Promise<boolean>;

/** state.ts's `followRun`, once it exports one. */
const followRun = (): Follow | undefined => (runState as unknown as { followRun?: Follow }).followRun;

export interface SweepState {
  active: { method: string; tabId: string; tabTitle: string; startedAt: number; fraction: number | null; text: string } | null;
  last: { statusBar: string; summary: string; tabId: string; tabTitle: string; kind: "success" | "warning" | "failure"; at: number; after: runState.RunState["last"] } | null;
  /** From Run until the sweep has been handed to the registry (0.90.34's `testSetRunning` while generating). */
  preparing: boolean;
}

let state: SweepState = { active: null, last: null, preparing: false };
const listeners = new Set<() => void>();

function set(next: SweepState) {
  state = next;
  listeners.forEach((l) => l());
  invalidateMenu();
}

export function getSweepState(): SweepState {
  return state;
}

export function useSweepState(): SweepState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** The run labels of the two sweeps (`testset`, `spc`). */
export const SWEEP_LABELS = new Set(["testset", "spc"]);

/** Whether a sweep is being prepared or running: the Test menu waits until it has finished (TEST-020, Changed). */
export function sweepBusy(): boolean {
  if (state.preparing || state.active) return true;
  const a = runState.getRunState().active;
  return !!a && SWEEP_LABELS.has(a.method);
}

/** Starts a sweep for tab `tabId`; resolves to whether it started. */
export async function startSweep(tabId: string, kind: "infinite" | "finite" | "spc", params: SweepParams): Promise<boolean> {
  const tab = tabById(tabId);
  if (!tab) return false;
  const method = kind === "spc" ? "spc" : "testset";
  const launch: Launch = (onMessage) => api.sweepStart({ tabId, title: tab.title, document: tab.document, kind, settings: allSettings(), params, sourcePath: tab.path }, onMessage);
  set({ ...state, preparing: true });
  try {
    const follow = followRun();
    return follow ? await follow(tabId, method, launch) : await followHere(tabId, method, tab.title, launch);
  } finally {
    set({ ...state, preparing: false });
  }
}

/** The fallback follower (see the header). */
async function followHere(tabId: string, method: string, title: string, launch: Launch): Promise<boolean> {
  let finished = false;
  const onMessage = (m: RunMessage) => {
    switch (m.kind) {
      case "status":
        addStatus(m.text, m.severity, tabId);
        break;
      case "output":
        break;
      case "progress":
        if (state.active && !finished) set({ ...state, active: { ...state.active, fraction: m.fraction, text: m.text } });
        break;
      case "finished": {
        finished = true;
        const kind = m.succeeded ? "success" : m.userStopped ? "warning" : "failure";
        set({ ...state, active: null, last: { statusBar: m.statusBar, summary: m.summary, tabId, tabTitle: tabById(tabId)?.title ?? title, kind, at: Date.now(), after: runState.getRunState().last } });
        void runState.reloadResults(tabId);
        break;
      }
    }
  };
  set({ ...state, active: { method, tabId, tabTitle: title, startedAt: Date.now(), fraction: null, text: "" } });
  try {
    const { started } = await launch(onMessage);
    if (!started && !finished) set({ ...state, active: null });
    return started;
  } catch (e) {
    if (!finished) set({ ...state, active: null });
    addStatus(w.couldNotStart(method === "spc" ? "the convergence sweep" : "the test set", String(e)), "error", tabId);
    return false;
  }
}

/** For tests. */
export function resetSweeps() {
  state = { active: null, last: null, preparing: false };
  listeners.forEach((l) => l());
}
