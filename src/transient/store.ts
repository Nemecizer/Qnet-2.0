// What Run ▸ Transient… remembers per tab (new in 2.1, ROADMAP D4): the set-up as typed, the last
// answer with the request that made it, and the computation in flight (its progress, and the id
// `transient_stop` needs). The computation belongs to the tab, not to the view: it goes on while
// the Results pane shows something else or moves to a window of its own.
import { useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { DEFAULT_SETTINGS, type TransientAnalysis, type TransientRequest, type TransientSettings } from "./model";

export interface TransientResult {
  analysis: TransientAnalysis;
  request: TransientRequest;
  /** The network's fingerprint when it was computed (null in a context that has none). */
  fingerprint: string | null;
}

export interface TransientRun {
  id: string;
  fraction: number;
}

const settings = new Map<string, TransientSettings>();
const results = new Map<string, TransientResult>();
const runs = new Map<string, TransientRun>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
const viewListeners = new Set<() => void>();
let pendingView = false;
let seq = 0;

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const transientSettings = (tabId: string) => settings.get(tabId) ?? DEFAULT_SETTINGS;
export function setTransientSettings(tabId: string, patch: Partial<TransientSettings>) {
  settings.set(tabId, { ...transientSettings(tabId), ...patch });
  notify();
}
export const useTransientSettings = (tabId: string) => useSyncExternalStore(subscribe, () => transientSettings(tabId));

export const transientResult = (tabId: string) => results.get(tabId) ?? null;
export const useTransientResult = (tabId: string) => useSyncExternalStore(subscribe, () => transientResult(tabId));
export const transientRun = (tabId: string) => runs.get(tabId) ?? null;
export const useTransientRun = (tabId: string) => useSyncExternalStore(subscribe, () => transientRun(tabId));
export const useTransientError = (tabId: string) => useSyncExternalStore(subscribe, () => errors.get(tabId) ?? null);

export const nextTransientId = () => `transient-${++seq}-${Date.now().toString(36)}`;

/** Computes `request` for the tab; the answer lands in the store. One computation per tab: a second call while one runs is ignored. */
export async function runTransient(tabId: string, request: TransientRequest): Promise<void> {
  if (runs.has(tabId)) return;
  const run: TransientRun = { id: request.id, fraction: 0 };
  runs.set(tabId, run);
  errors.delete(tabId);
  notify();
  try {
    const fingerprintOf = api.resultsFingerprint(request.document).catch(() => null);
    const analysis = await api.transientAnalyze(request, (p) => {
      if (runs.get(tabId)?.id !== run.id) return;
      runs.set(tabId, { id: run.id, fraction: p.fraction });
      notify();
    });
    results.set(tabId, { analysis, request, fingerprint: await fingerprintOf });
  } catch (e) {
    errors.set(tabId, typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));
  } finally {
    runs.delete(tabId);
    notify();
  }
}

/** Stop: the exact calculation ends and the answer comes back without it. */
export function stopTransient(tabId: string): void {
  const run = runs.get(tabId);
  if (run) void api.transientStop(run.id).catch(() => {});
}

/** Asks the Results pane to show the Transient view (now, or when it next mounts). */
export function showTransientView() {
  if (viewListeners.size) viewListeners.forEach((l) => l());
  else pendingView = true;
}
export function takeTransientViewRequest(): boolean {
  const v = pendingView;
  pendingView = false;
  return v;
}
export function onTransientViewRequest(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

/** For tests. */
export function resetTransientStore() {
  settings.clear();
  results.clear();
  runs.clear();
  errors.clear();
  pendingView = false;
  notify();
}
