// Running several methods one after another (new in 2.1, ROADMAP B3): the run slot is single
// flight, so each method is started through the Run menu's own path (`startMethod`, with the
// settings' defaults where the menu item would have asked with a sheet) and the next waits for
// that run's own end. A method that is refused, or fails, is noted and the rest go on; Stop —
// here or anywhere else that stops the run — ends the sequence, as does its tab being closed or
// no longer in front when a method is about to start.
import { useSyncExternalStore } from "react";
import { MODAL_REASON } from "../../../lib/overlays";
import type { RunMessage } from "../../../lib/types";
import { getRunState, onRunFinished, stopRun } from "../../../runs/state";
import { runWhen, startMethod } from "../../../runs/ui/commands";
import { runWords } from "../../../runs/ui/words";
import { activeTab, tabById } from "../../../workspace/store";

export type StepState = "pending" | "running" | "done" | "failed" | "refused" | "stopped" | "skipped" | "unknown";

export interface Step {
  /** 0.90.34's run label ("qna", "inf_sim"). */
  label: string;
  /** The Run-menu command whose gate applies, when there is one. */
  command: string | null;
  /** The method's name as the Method Chooser writes it. */
  name: string;
  state: StepState;
  /** Why it was refused, when the gate said. */
  reason?: string;
  /**
   * A refusal that will be the same next time for this network: the method does not apply to it
   * or its solver is not installed. False for one that passes (a dialog open, another run busy,
   * the launch failing).
   */
  permanent?: boolean;
}

export interface Sequence {
  tabId: string;
  steps: Step[];
  /** The step in progress; `steps.length` once over. */
  index: number;
  stopping: boolean;
  finished: boolean;
  /** Why it ended before its last method, when its tab went away: closed, or no longer in front. */
  ended?: "tab-closed" | "tab-not-front";
}

let state: Sequence | null = null;
const listeners = new Set<() => void>();

function set(next: Sequence | null) {
  state = next;
  listeners.forEach((l) => l());
}

export const getSequence = () => state;
export const sequenceRunning = () => state !== null && !state.finished;

export function useSequence(): Sequence | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const patch = (i: number, p: Partial<Step>) => {
  if (!state) return;
  set({ ...state, steps: state.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
};

type Finished = Extract<RunMessage, { kind: "finished" }>;
type End = Pick<Step, "state" | "reason" | "permanent">;

/** How often the wait looks at the run state, for a run whose `finished` never reaches the page. */
export const POLL_MS = 250;

const SINGLE_FLIGHT = /was not started because .* is already running for/;
const LAUNCH_FAILED = /^Couldn't start the run:/;

/**
 * Whether the Status lines a refused launch wrote say something that stays true for this network:
 * the run path's own refusal (the method does not apply, its solver is not installed — the
 * runner's sentences, src-tauri/src/runs.rs `Prepared::Refused`). The single-flight sentence, a
 * launch that threw, and a refusal with no line at all (the tab was closed) are passing.
 */
export function permanentRefusal(lines: readonly string[]): boolean {
  return lines.length > 0 && !lines.some((l) => SINGLE_FLIGHT.test(l) || LAUNCH_FAILED.test(l));
}

/** A closed Run-menu gate that will open by itself: a dialog is up, or the canvas is empty for now. */
const passingGate = (reason: string) => reason === MODAL_REASON || reason === runWords.noNetwork;

/**
 * Starts one method and resolves when that run — the one this call launched — has ended: how it
 * ended, or that it never started.
 *
 * The step is tied to its own launch by the run state's follower token (src/runs/state.ts): once
 * `startRun` has resolved "started", the active run is this one unless it has already finished.
 * A `finished` for the same tab and method that leaves this run's token active is some earlier
 * run's, arriving late, and is ignored; and when the state shows this run no longer active with
 * no `finished` seen (a run followed by polling after a reload sends none), the wait ends too.
 */
async function runOne(tabId: string, step: Step): Promise<End> {
  if (step.command) {
    // `runWhen` reads the tab in front; the caller has just checked that it is this sequence's.
    const gate = runWhen(step.command);
    if (gate !== true) return { state: "refused", reason: gate, permanent: !passingGate(gate) };
  }
  const seen: { m: Finished; activeAfter: number | null }[] = [];
  let wake = () => {};
  const off = onRunFinished((m, meta) => {
    if (meta.tabId !== tabId || meta.method !== step.label) return;
    // The follower has already cleared its own run from the state when listeners are told.
    seen.push({ m, activeAfter: getRunState().active?.token ?? null });
    wake();
  });
  const outcome = (m: Finished): End => ({ state: m.succeeded ? "done" : m.userStopped ? "stopped" : "failed" });
  try {
    const logged = tabById(tabId)?.log.length ?? 0;
    const started = await startMethod(tabId, step.label);
    if (!started) return { state: "refused", permanent: permanentRefusal((tabById(tabId)?.log ?? []).slice(logged).map((l) => l.text)) };
    // Stop pressed while the launch was on its way: there was no run to interrupt then.
    if (state?.stopping) await stopRun();
    const active = getRunState().active;
    if (!active || active.tabId !== tabId || active.method !== step.label) {
      // Already over: its `finished` came before the launch resolved (the last one seen is its).
      const last = seen[seen.length - 1];
      return last ? outcome(last.m) : { state: "unknown" };
    }
    const token = active.token;
    // Anything seen so far left this run active: an earlier run's end, not this one's.
    seen.length = 0;
    for (;;) {
      const mine = seen.find((e) => e.activeAfter !== token);
      if (mine) return outcome(mine.m);
      if (getRunState().active?.token !== token) return { state: "unknown" };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    off();
  }
}

/**
 * Runs `steps` for `tabId` in order. Resolves to the finished sequence, or null when one is
 * already running (nothing starts then).
 */
export async function runSequence(tabId: string, steps: Pick<Step, "label" | "command" | "name">[]): Promise<Sequence | null> {
  if (sequenceRunning() || !steps.length) return null;
  set({ tabId, steps: steps.map((s) => ({ ...s, state: "pending" })), index: 0, stopping: false, finished: false });
  let ended: Sequence["ended"];
  for (let i = 0; i < steps.length; i++) {
    if (!state || state.stopping) break;
    // The sequence is its tab's: the gates and the run path act on the tab in front, so nothing
    // more starts once that is another tab, or this one is gone.
    if (!tabById(tabId)) ended = "tab-closed";
    else if (activeTab().id !== tabId) ended = "tab-not-front";
    if (ended) break;
    set({ ...state, index: i });
    patch(i, { state: "running" });
    const end = await runOne(tabId, state.steps[i]);
    if (!state) return null;
    patch(i, end);
    if (end.state === "stopped") set({ ...state, stopping: true });
  }
  if (!state) return null;
  set({ ...state, index: state.steps.length, finished: true, ...(ended ? { ended } : {}), steps: state.steps.map((s) => (s.state === "pending" || s.state === "running" ? { ...s, state: "skipped" } : s)) });
  return state;
}

/** Stop: no further method starts, and the one in progress is interrupted. */
export async function stopSequence(): Promise<void> {
  if (!state || state.finished) return;
  set({ ...state, stopping: true });
  await stopRun();
}

/** Clears a finished sequence's summary line. */
export function dismissSequence() {
  if (state?.finished) set(null);
}

/** For tests. */
export function resetSequence() {
  set(null);
}
