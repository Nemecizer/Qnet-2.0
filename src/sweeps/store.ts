// A tab's saved sweep (new in 2.1, ROADMAP B4): one per tab, the last one run. It holds every
// measurement of every point, so the Sweep view changes measure and station without running
// anything again. Kept in memory for the tab's lifetime and in state.json under
// `sweeps.result.<tab id>` (dropped when the tab closes), so a restored session shows it again;
// a sweep too large for the state file (over `PERSIST_LIMIT` characters of JSON) stays in memory
// only.
import { useSyncExternalStore } from "react";
import { getStateValue, setStateValues } from "../lib/kv";
import type { Tier } from "../results/insight";
import { api } from "../lib/api";
import { sameNetwork } from "../results/current";
import { onSessionReady, sessionReady } from "../workspace/tabs/session";
import { getWorkspace, onWorkspaceChange } from "../workspace/store";
import type { SweepParameter } from "./model";

/** One measurement of one run, as small as it can be kept. */
export interface SweepMeasurement {
  /** Station id, or null for a network-wide measure. */
  s: string | null;
  /** Station name. */
  n: string;
  /** Customer class (0-based), or null for all classes. */
  c: number | null;
  /** Metric and unit. */
  k: string;
  u: string;
  /** Estimate, and its interval when the method gives one. */
  v: number;
  lo?: number;
  hi?: number;
}

export type GapReason = "unstable" | "refused" | "failed" | "skipped" | "stopped";

/** One method at one point: its measurements, or why there are none. */
export type SweepCell = { ok: true; m: SweepMeasurement[] } | { ok: false; reason: GapReason; sentence: string };

export interface SweepMethod {
  /** 0.90.34's run label ("qna"). */
  label: string;
  /** The Method Chooser's name, and the record's short name once a point has run. */
  name: string;
  shortName: string;
  tier: Tier;
}

export interface SweepResult {
  id: string;
  tabId: string;
  /** The tab's title when the sweep ran. */
  title: string;
  createdAt: string;
  parameter: SweepParameter;
  from: number;
  to: number;
  values: number[];
  methods: SweepMethod[];
  /** `cells[method][point]`. */
  cells: SweepCell[][];
  /** Where the network becomes overloaded inside the swept range, and on which side of it. */
  limits: { x: number; unstable: "above" | "below" }[];
  /** Stop was pressed: later points were not run. */
  stopped: boolean;
  elapsedSeconds: number;
  /** The network's fingerprint when the sweep ran (null when it wasn't known). */
  fingerprint: string | null;
  /** The network the sweep ran on (nodes, links, buffer mode), so a change of layout alone doesn't read as a change. Absent in a sweep saved before 2.1's layout rule. */
  network?: { nodes: unknown; links: unknown; infiniteBuffers: unknown } | null;
  /** What the panel asked the chart to open on. */
  metric: string;
  stationId: string | null;
}

/** What the Sweep view is showing of a result; kept with it so a remount doesn't lose it. */
export interface SweepSelection {
  metricKey: string | null;
  stationKey: string | null;
  mode: "chart" | "table";
}

export const PERSIST_LIMIT = 400_000;
export const stateKey = (tabId: string) => `sweeps.result.${tabId.toUpperCase()}`;

const results = new Map<string, SweepResult | null>();
const selections = new Map<string, SweepSelection>();
const listeners = new Set<() => void>();
let version = 0;
let watching = false;

function notify() {
  version++;
  listeners.forEach((l) => l());
}

function isResult(v: unknown): v is SweepResult {
  const r = v as SweepResult | null;
  return !!r && typeof r === "object" && Array.isArray(r.values) && Array.isArray(r.methods) && Array.isArray(r.cells) && !!r.parameter && typeof r.parameter.id === "string";
}

/** Drops a closed tab's sweep from memory and from the state file. */
function watch() {
  if (watching) return;
  watching = true;
  onWorkspaceChange((ws, prev) => {
    const open = new Set(ws.tabs.map((t) => t.id.toUpperCase()));
    const gone = prev.tabs.map((t) => t.id.toUpperCase()).filter((id) => !open.has(id));
    for (const id of gone) {
      const had = results.get(id) ?? (isResult(getStateValue<unknown>(stateKey(id), null)) ? true : null);
      results.delete(id);
      selections.delete(id);
      if (had) void setStateValues({ [stateKey(id)]: null }).catch(() => {});
    }
    if (gone.length) notify();
  });
}

const asRuns = new WeakMap<SweepResult, { provenance: { networkFingerprint: string; networkSnapshot?: unknown } }>();

/**
 * Whether the network has changed since `result` ran, by the rule every result uses
 * (src/results/current.ts `sameNetwork`): another fingerprint, unless the two networks differ in
 * layout alone. `fingerprint` is the network's now; null (not known yet) is never stale.
 */
export function sweepIsStale(result: SweepResult, fingerprint: string | null): boolean {
  if (result.fingerprint === null || fingerprint === null) return false;
  let run = asRuns.get(result);
  if (!run) {
    run = { provenance: { networkFingerprint: result.fingerprint, networkSnapshot: result.network ?? undefined } };
    asRuns.set(result, run);
  }
  return !sameNetwork(run, fingerprint);
}

const PREFIX = "sweeps.result.";
let swept = false;

/**
 * Once per page: follows tabs closing (their sweeps are dropped from memory and from the state
 * file, whether or not a Sweep view ever read them), and — when the state file and the session's
 * tabs are both known — removes the saved sweeps of tabs that no longer exist. `keys` lists the
 * state file's keys; `settled` calls back once the session's tabs are in place (it never starts
 * the restore itself).
 */
export function startSweepStore(keys: () => Promise<string[]> = () => api.stateGet().then((all) => Object.keys(all)), settled: (then: () => void) => void = whenSessionReady): void {
  watch();
  if (swept) return;
  swept = true;
  settled(() => {
    void keys()
      .then((all) => {
        const open = new Set(getWorkspace().tabs.map((t) => t.id.toUpperCase()));
        const stale = all.filter((k) => k.startsWith(PREFIX) && !open.has(k.slice(PREFIX.length).toUpperCase()));
        if (!stale.length) return;
        for (const k of stale) results.delete(k.slice(PREFIX.length).toUpperCase());
        return setStateValues(Object.fromEntries(stale.map((k) => [k, null])));
      })
      .catch(() => {});
  });
}

function whenSessionReady(then: () => void) {
  if (sessionReady()) return then();
  const stop = onSessionReady(() => {
    stop();
    then();
  });
}

/** The tab's saved sweep, or null. */
export function sweepResult(tabId: string): SweepResult | null {
  watch();
  const key = tabId.toUpperCase();
  if (!results.has(key)) {
    const stored = getStateValue<unknown>(stateKey(key), null);
    // Not cached while nothing is stored: the state file may not have loaded yet.
    if (!isResult(stored)) return null;
    results.set(key, stored);
  }
  return results.get(key) ?? null;
}

/** Saves `result` as the tab's sweep (replacing the one before), or clears it with null. */
export function setSweepResult(tabId: string, result: SweepResult | null) {
  watch();
  const key = tabId.toUpperCase();
  results.set(key, result);
  selections.delete(key);
  notify();
  let stored: SweepResult | null = result;
  try {
    if (result && JSON.stringify(result).length > PERSIST_LIMIT) stored = null;
  } catch {
    stored = null;
  }
  void setStateValues({ [stateKey(key)]: stored }).catch(() => {});
}

export function sweepSelection(tabId: string): SweepSelection {
  return selections.get(tabId.toUpperCase()) ?? DEFAULT_SELECTION;
}

const DEFAULT_SELECTION: SweepSelection = { metricKey: null, stationKey: null, mode: "chart" };

export function setSweepSelection(tabId: string, patch: Partial<SweepSelection>) {
  const key = tabId.toUpperCase();
  selections.set(key, { ...sweepSelection(key), ...patch });
  notify();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSweepResult(tabId: string): SweepResult | null {
  useSyncExternalStore(subscribe, () => version);
  return sweepResult(tabId);
}

export function useSweepSelection(tabId: string): SweepSelection {
  useSyncExternalStore(subscribe, () => version);
  return sweepSelection(tabId);
}

// ── The view request (the pane keeps its view; this carries "show Sweep" to it) ─────────────────

let pendingView = false;
const viewListeners = new Set<() => void>();

/** Asks the Results pane to show the Sweep view (now if it is mounted, else when it next mounts). */
export function showSweepView() {
  if (viewListeners.size) viewListeners.forEach((l) => l());
  else pendingView = true;
}

/** Whether the Sweep view was asked for while no pane was mounted, once. */
export function takeSweepViewRequest(): boolean {
  const v = pendingView;
  pendingView = false;
  return v;
}

export function onSweepViewRequest(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

/** For tests. */
export function resetSweepStore() {
  results.clear();
  selections.clear();
  pendingView = false;
  swept = false;
  notify();
}
