// The run the interface shows: a Run-menu method followed by src/runs/state.ts, or a Test-menu
// sweep followed by ./sweeps.ts. One live run at a time (the registry's single flight), so the
// two merge into one: the status-bar run segment, Run ▸ Stop and the tab close guard read this.
import { getRunState, useRunState, type RunState } from "../state";
import { editorFeedback } from "../../editor/editor";
import { addStatus, tabById } from "../../workspace/store";
import { getSweepState, useSweepState, type SweepState } from "./sweeps";
import { displayLabel, runWords as w } from "./words";

export interface LiveRun {
  /** 0.90.34's run label ("qna", "testset"). */
  method: string;
  tabId: string;
  tabTitle: string;
  startedAt: number;
  fraction: number | null;
  stopRequested: boolean;
}

export interface LastRun {
  statusBar: string;
  tabId: string;
  tabTitle: string;
  kind: "success" | "warning" | "failure";
}

function merge(run: RunState, sweep: SweepState): { live: LiveRun | null; last: LastRun | null } {
  const live: LiveRun | null = run.active
    ? { method: run.active.method, tabId: run.active.tabId, tabTitle: run.active.tabTitle, startedAt: run.active.startedAt, fraction: run.active.fraction, stopRequested: run.active.stopRequested }
    : sweep.active
      ? { method: sweep.active.method, tabId: sweep.active.tabId, tabTitle: sweep.active.tabTitle, startedAt: sweep.active.startedAt, fraction: sweep.active.fraction, stopRequested: false }
      : null;
  // A sweep's end is the latest unless a method has finished since (its `last` moved on).
  const sweepLatest = sweep.last && run.last === sweep.last.after;
  const last = sweepLatest ? sweep.last : run.last;
  return { live, last: last ? { statusBar: last.statusBar, tabId: last.tabId, tabTitle: last.tabTitle, kind: last.kind } : null };
}

/** The run in progress, if any. */
export function liveRun(): LiveRun | null {
  return merge(getRunState(), getSweepState()).live;
}

export function lastRun(): LastRun | null {
  return merge(getRunState(), getSweepState()).last;
}

export function useLiveRuns(): { live: LiveRun | null; last: LastRun | null } {
  const run = useRunState();
  const sweep = useSweepState();
  return merge(run, sweep);
}

// ── A tab with a run can't be closed (WS-043) ───────────────────────────────────────────────────

/** Whether the run in progress belongs to `tabId`. */
export function runOwnsTab(tabId: string): boolean {
  return liveRun()?.tabId.toUpperCase() === tabId.toUpperCase();
}

/** The sentence a refused close writes in the owning tab. */
export const cannotCloseSentence = (title: string, runLabel: string) => w.cannotClose(title, displayLabel(runLabel));

/**
 * `closeTabs(ids:)`'s first check: when the running run's tab is among `ids`, beeps, writes
 * "“<title>” cannot be closed while <run> is running. Stop or wait for the run first." as a
 * warning in that tab and returns true (the close is refused). Returns false otherwise.
 */
export function refuseClosingRunOwner(ids: Iterable<string>): boolean {
  const live = liveRun();
  if (!live) return false;
  const want = live.tabId.toUpperCase();
  for (const id of ids) {
    if (id.toUpperCase() !== want) continue;
    const tab = tabById(live.tabId);
    if (!tab) return false;
    editorFeedback.beep();
    addStatus(cannotCloseSentence(tab.title, live.method), "warning", tab.id);
    return true;
  }
  return false;
}
