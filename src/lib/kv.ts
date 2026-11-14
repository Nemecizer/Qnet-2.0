// The interface's copy of settings.json and state.json (src-tauri/src/kv.rs), under 0.90.34's
// key names. `loadKv()` reads both once at launch; after that every change, from this window or
// another, arrives as `kv://changed` and updates the copy, so `useSetting` re-renders whoever reads
// a key. Writes go to Rust first and land here when it answers (a refused setting changes nothing).
//
// Settings (`useSetting`, `setSettings`): the AppSettings keys, with defaults filled in by Rust.
// State (`useStateValue`, `setStateValues`): everything else 0.90.34 kept in UserDefaults (split
// sizes, Open Recent, one-time flags); no defaults, so each reader passes its own.
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { KvValues } from "./types";
import { invalidateMenu } from "./menu";

type Store = "settings" | "state";

const values: Record<Store, KvValues> = { settings: {}, state: {} };
const listeners = new Set<() => void>();
let version = 0;
let loaded: Promise<void> | null = null;

function publish() {
  version++;
  listeners.forEach((l) => l());
  invalidateMenu();
}

function apply(store: Store, patch: KvValues) {
  const next = { ...values[store] };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  values[store] = next;
}

/** Reads both files once and starts following changes; later calls return the same promise. */
export function loadKv(): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    const [s, st] = await Promise.all([api.settingsGet(), api.stateGet()]).catch((e: unknown) => {
      // A failed first read is tried again by the next caller, rather than kept as the answer.
      loaded = null;
      throw e;
    });
    values.settings = s;
    values.state = st;
    publish();
    await listen<{ store: Store; patch: KvValues }>("kv://changed", (e) => {
      if (e.payload.store === "settings") {
        // Rust sends the patch; a reset key (null) falls back to its default, so re-read those.
        if (Object.values(e.payload.patch).some((v) => v === null)) {
          void api.settingsGet().then((all) => {
            values.settings = all;
            publish();
          });
          return;
        }
      }
      apply(e.payload.store, e.payload.patch);
      publish();
    });
  })();
  return loaded;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A setting's current value (`fallback` until loaded or when the key is unknown). */
export function getSetting<T>(key: string, fallback: T): T {
  return (key in values.settings ? values.settings[key] : fallback) as T;
}

export function useSetting<T>(key: string, fallback: T): T {
  useSyncExternalStore(subscribe, () => version);
  return getSetting(key, fallback);
}

/** Every setting, as Rust last reported them. */
export function allSettings(): KvValues {
  return values.settings;
}

export function useAllSettings(): KvValues {
  useSyncExternalStore(subscribe, () => version);
  return values.settings;
}

/** Changes settings; resolves to every setting after the change, or rejects with Rust's sentence. */
export async function setSettings(patch: KvValues): Promise<KvValues> {
  const all = await api.settingsPatch(patch);
  values.settings = all;
  publish();
  return all;
}

export function getStateValue<T>(key: string, fallback: T): T {
  return (key in values.state ? values.state[key] : fallback) as T;
}

export function useStateValue<T>(key: string, fallback: T): T {
  useSyncExternalStore(subscribe, () => version);
  return getStateValue(key, fallback);
}

export async function setStateValues(patch: KvValues): Promise<void> {
  apply("state", patch);
  publish();
  await api.statePatch(patch);
}

/** For tests: forget everything and load again on the next `loadKv()`. */
export function resetKv() {
  values.settings = {};
  values.state = {};
  loaded = null;
  publish();
}
