// The split sizes while a divider or a corner grip is being dragged: kept here, frame by frame,
// and written to state.json once when the drag ends (one atomic write, not sixty a second). The
// splits register what they need for corner grips and presets: their measured sizes, and a way to
// start a drag on one of their dividers.
import { useSyncExternalStore } from "react";
import { getStateValue, setStateValues } from "../../lib/kv";
import type { KvValues } from "../../lib/types";
import type { SplitName } from "./sizes";

let overrides: Record<string, number> = {};
const listeners = new Set<() => void>();
let version = 0;

function publish() {
  version++;
  listeners.forEach((l) => l());
}

export function useLiveVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** A size key's value now: the drag in progress, else state.json. */
export function liveValue(key: string): unknown {
  return key in overrides ? overrides[key] : getStateValue<unknown>(key, undefined);
}

/** The state as the layout should read it: state.json with the drag's sizes over it. */
export function liveState(keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = liveValue(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function setOverrides(patch: Record<string, number>) {
  overrides = { ...overrides, ...patch };
  publish();
}

/** Ends a drag: what it changed goes to state.json, with anything else the caller adds. */
export async function commitOverrides(extra: KvValues = {}): Promise<void> {
  const patch: KvValues = { ...overrides, ...extra };
  if (!Object.keys(patch).length) return;
  await setStateValues(patch);
  overrides = {};
  publish();
}

// --- The registry of mounted splits.

export interface DragSession {
  move: (delta: number) => void;
  end: () => KvValues;
}

export interface SplitHandle {
  /** The panes present, in order. */
  panes: () => string[];
  /** The panes' sizes along the split's axis, measured now. */
  sizes: () => number[];
  /** The split's own size along its axis. */
  total: () => number;
  /** Starts dragging divider `i` (between panes i and i + 1). */
  begin: (i: number) => DragSession;
}

const splits = new Map<SplitName, SplitHandle>();

export function registerSplit(name: SplitName, h: SplitHandle): () => void {
  splits.set(name, h);
  return () => {
    if (splits.get(name) === h) splits.delete(name);
  };
}

export function splitHandle(name: SplitName): SplitHandle | undefined {
  return splits.get(name);
}

/** For tests. */
export function resetLive() {
  overrides = {};
  splits.clear();
  publish();
}
