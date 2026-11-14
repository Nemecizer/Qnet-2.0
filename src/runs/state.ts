// Runs on the page side (PLAN.md §7 P6): starting a Run-menu method for a tab through
// src-tauri/src/runs.rs, and following it to its end. Rust owns the single-flight slot, the
// solvers and the results store; this module routes what a run sends:
//
// - Status lines go to the tab that started the run, even after a tab switch (SH-089).
// - Output bytes go to whoever shows them (the Shell pane: `onRunOutput`). Bytes that arrive while
//   nothing listens are kept (up to OUTPUT_BACKLOG bytes) and handed to the first listener.
// - Progress and the end feed the status bar's run segment and the Run menu (`useRunState`).
// - The Results workspace follows `results://changed` through `useResults(tabId)`.
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../lib/api";
import { allSettings } from "../lib/kv";
import { invalidateMenu } from "../lib/menu";
import type { KvValues, RunMessage, RunRecord } from "../lib/types";
import { addStatus, tabById } from "../workspace/store";
import { noteFailureReport } from "./reports/state";
import { problemsPointer } from "../canvas/validation/store";

/** The run the status bar shows: the live one, else how the last one ended. */
export interface RunState {
  /** The run in progress (from its start until `finished`), or null. */
  active: {
    method: string;
    tabId: string;
    tabTitle: string;
    startedAt: number;
    fraction: number | null;
    elapsedSeconds: number;
    text: string;
    stopRequested: boolean;
    /** Which follower owns it: only that run's own messages change or clear it (0 = adopted at launch). */
    token: number;
  } | null;
  /** The last run's end: "<summary> · <tab>" with its kind, or null before any run. */
  last: { statusBar: string; summary: string; tabId: string; tabTitle: string; kind: "success" | "warning" | "failure"; recordId: string | null } | null;
}

let state: RunState = { active: null, last: null };
const listeners = new Set<() => void>();

function set(next: RunState) {
  state = next;
  listeners.forEach((l) => l());
  invalidateMenu();
}

export function getRunState(): RunState {
  return state;
}

export function useRunState(): RunState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// ── Output ────────────────────────────────────────────────────────────────────────────────────

export const OUTPUT_BACKLOG = 1 << 20;
type OutputListener = (bytes: Uint8Array, meta: { tabId: string; method: string }) => void;
const outputListeners = new Set<OutputListener>();
let backlog: { bytes: Uint8Array; meta: { tabId: string; method: string } }[] = [];
let backlogSize = 0;

/** Follows every run's Shell-pane bytes; the first listener also gets what arrived before it. */
export function onRunOutput(l: OutputListener): () => void {
  outputListeners.add(l);
  if (backlog.length) {
    const held = backlog;
    const resync = backlogTrimmed;
    backlog = [];
    backlogSize = 0;
    backlogTrimmed = false;
    // What was trimmed may have ended mid-character or mid-escape: start at the next line.
    if (resync) {
      const first = held[0].bytes;
      const nl = first.indexOf(0x0a);
      held[0] = { ...held[0], bytes: nl < 0 ? new Uint8Array(0) : first.subarray(nl + 1) };
    }
    for (const b of held) if (b.bytes.length) l(b.bytes, b.meta);
  }
  return () => outputListeners.delete(l);
}

let backlogTrimmed = false;

function deliver(bytes: Uint8Array, meta: { tabId: string; method: string }) {
  if (outputListeners.size) {
    outputListeners.forEach((l) => l(bytes, meta));
    return;
  }
  backlog.push({ bytes, meta });
  backlogSize += bytes.length;
  while (backlogSize > OUTPUT_BACKLOG && backlog.length > 1) {
    backlogSize -= backlog.shift()!.bytes.length;
    backlogTrimmed = true;
  }
}

export function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Starting and stopping ─────────────────────────────────────────────────────────────────────

/** Finished-run listeners (the Results workspace's auto-reveal, the tests). */
type FinishedListener = (m: Extract<RunMessage, { kind: "finished" }>, meta: { tabId: string; method: string }) => void;
const finishedListeners = new Set<FinishedListener>();

export function onRunFinished(l: FinishedListener): () => void {
  finishedListeners.add(l);
  return () => finishedListeners.delete(l);
}

/**
 * Starts 0.90.34's run `method` ("qna", "inf_cmp") for tab `tabId`, with the current settings and
 * a parameter sheet's `overrides`. Resolves to whether it started: a method that refuses has
 * already written its Status lines to the tab, as has a refusal because another run is active.
 */
export async function startRun(tabId: string, method: string, overrides: KvValues = {}): Promise<boolean> {
  const tab = tabById(tabId);
  if (!tab) return false;
  return followRun(tabId, method, (onMessage) =>
    api.runStart({ tabId, title: tab.title, document: tab.document, method, settings: allSettings(), overrides, sourcePath: tab.path }, onMessage),
  );
}

/**
 * Follows a run that `launch` starts and that reports on the same RunMessage channel as Run-menu
 * runs (Analyze Network and Show Network Primitives, the Test menu's runs): its Status lines go to
 * the tab, its bytes to `onRunOutput`, its progress and end to the run state.
 */
export async function followRun(tabId: string, method: string, launch: (onMessage: (m: RunMessage) => void) => Promise<{ started: boolean }>): Promise<boolean> {
  const tab = tabById(tabId);
  if (!tab) return false;
  const meta = { tabId, method };
  const token = ++followers;
  let finished = false;
  const mine = () => state.active?.token === token;
  const onMessage = (m: RunMessage) => {
    switch (m.kind) {
      case "status":
        addStatus(m.text, m.severity, tabId);
        break;
      case "output":
        deliver(decodeBase64(m.data), meta);
        break;
      case "progress":
        if (mine() && !finished) set({ ...state, active: { ...state.active!, fraction: m.fraction, elapsedSeconds: m.elapsedSeconds, text: m.text } });
        break;
      case "report":
        // The failure's Status line gains "Show Report…" (src/runs/reports).
        noteFailureReport(tabId, method, m);
        break;
      case "finished": {
        finished = true;
        const kind = m.succeeded ? "success" : m.userStopped ? "warning" : "failure";
        const title = tabById(tabId)?.title ?? "";
        // Only this run's own segment goes; a run started since keeps its own.
        set({ active: mine() ? null : state.active, last: { statusBar: m.statusBar, summary: m.summary, tabId, tabTitle: title, kind, recordId: m.recordId } });
        finishedListeners.forEach((l) => l(m, meta));
        break;
      }
    }
  };
  // Optimistic: the run segment shows the run from the click, as 0.90.34's did — unless one is
  // already showing, which the launch will refuse (single flight) and must leave as it is.
  const busy = !!state.active;
  if (!state.active) set({ ...state, active: { method, tabId, tabTitle: tab.title, startedAt: Date.now(), fraction: null, elapsedSeconds: 0, text: "", stopRequested: false, token } });
  try {
    const { started } = await launch(onMessage);
    // Refused for the network itself (not because another run holds the slot): say where the
    // problems are shown. The network's errors may be why (not every error stops every method),
    // and the pointer's words say no more than that.
    if (!started && !busy) {
      const pointer = problemsPointer(tabId);
      if (pointer) addStatus(pointer, "warning", tabId);
    }
    if (!started && !finished && mine()) set({ ...state, active: null });
    // Accepted while the segment still showed a run whose end hasn't reached the page yet (Rust
    // frees the slot a moment before that run's `finished` arrives): this run takes the segment,
    // and the older run's late `finished` then leaves it alone.
    if (started && !finished && !mine()) set({ ...state, active: { method, tabId, tabTitle: tab.title, startedAt: Date.now(), fraction: null, elapsedSeconds: 0, text: "", stopRequested: false, token } });
    return started;
  } catch (e) {
    if (!finished && mine()) set({ ...state, active: null });
    addStatus(`Couldn't start the run: ${String(e)}`, "error", tabId);
    return false;
  }
}

let followers = 0;

/**
 * A page that loads while Rust still runs something (a reload, a reopened main window) learns it
 * here, and follows it by asking until it ends: its channel belonged to the old page, so no
 * `finished` will come.
 */
export async function adoptActiveRun(pollMs = 1000): Promise<void> {
  const a = await api.runActive().catch(() => null);
  if (!a || state.active) return;
  set({ ...state, active: { method: a.label, tabId: a.tabId, tabTitle: a.tabTitle, startedAt: Date.now() - a.elapsedSeconds * 1000, fraction: a.fraction, elapsedSeconds: a.elapsedSeconds, text: a.text, stopRequested: a.stopRequested, token: 0 } });
  const poll = async () => {
    if (state.active?.token !== 0) return;
    const now = await api.runActive().catch(() => null);
    if (state.active?.token !== 0) return;
    if (!now) {
      set({ ...state, active: null });
      void reloadResults(a.tabId);
      return;
    }
    set({ ...state, active: { ...state.active, fraction: now.fraction, elapsedSeconds: now.elapsedSeconds, text: now.text, stopRequested: now.stopRequested } });
    setTimeout(() => void poll(), pollMs);
  };
  setTimeout(() => void poll(), pollMs);
}

/** Run ▸ Stop and the status bar's Stop: interrupts the active run (its tab is told "<run> cancelled."). */
export async function stopRun(): Promise<string | null> {
  if (state.active) set({ ...state, active: { ...state.active, stopRequested: true } });
  return api.runStop();
}

/** Whether a run is in progress (the single-flight slot is taken). */
export const runActive = () => state.active !== null;

// ── Results ───────────────────────────────────────────────────────────────────────────────────

const results = new Map<string, RunRecord[]>();
const loading = new Map<string, Promise<void>>();
const resultListeners = new Set<() => void>();
let resultsVersion = 0;
let watching = false;

function notifyResults() {
  resultsVersion++;
  resultListeners.forEach((l) => l());
}

function watchResults() {
  if (watching || !inTauri) return;
  watching = true;
  void listen<string>("results://changed", (e) => void reloadResults(e.payload)).catch(() => {});
}

/** Reads a tab's records again (after a run files one, or a Delete). */
export async function reloadResults(tabId: string): Promise<void> {
  const key = tabId.toUpperCase();
  const p = api.resultsList(key).then(
    (list) => {
      results.set(key, list);
      notifyResults();
    },
    () => {},
  );
  loading.set(key, p);
  await p;
}

/** A tab's records, oldest first (empty until loaded). */
export function resultsFor(tabId: string): RunRecord[] {
  const key = tabId.toUpperCase();
  watchResults();
  if (!results.has(key) && !loading.has(key)) void reloadResults(key);
  return results.get(key) ?? EMPTY;
}

const EMPTY: RunRecord[] = [];

export function useResults(tabId: string): RunRecord[] {
  useSyncExternalStore(
    (l) => {
      resultListeners.add(l);
      return () => resultListeners.delete(l);
    },
    () => resultsVersion,
  );
  return resultsFor(tabId);
}

/** Every finished run also refreshes its tab's records (the preview has no results://changed). */
onRunFinished((_m, meta) => void reloadResults(meta.tabId));

/** For tests: no run, no output held, no records cached. */
export function resetRuns() {
  state = { active: null, last: null };
  followers = 0;
  backlog = [];
  backlogSize = 0;
  backlogTrimmed = false;
  results.clear();
  loading.clear();
  resultsVersion = 0;
  listeners.forEach((l) => l());
}
