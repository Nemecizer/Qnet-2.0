// The Method Chooser's answer for a tab, kept for the Agreement view, its commands and the Solve
// tooltip: the network's domain and the installation's solvers (two separate questions, INV-033),
// combined by the Chooser's own `recommendations`. Asked again whenever what the analysis reads of
// the document changes (`analysisKey`).
import { useEffect, useSyncExternalStore } from "react";
import { api } from "../../../lib/api";
import { invalidateMenu } from "../../../lib/menu";
import type { MethodDomain } from "../../../lib/types";
import { analysisKey } from "../../status/analysis";
import { recommendations, type MethodAdvice } from "../../../windows/methodchooser/advice";
import type { Tab } from "../../../workspace/store";

export interface Advice {
  domain: MethodDomain;
  rows: MethodAdvice[];
  infinite: boolean;
}

interface Entry {
  key: string;
  advice: Advice | null;
  pending: Promise<Advice | null> | null;
}

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

/** The Chooser's advice for `tab` as it is now (null for an empty canvas or when Rust refuses). */
export function adviceFor(tab: Pick<Tab, "id" | "document">): Promise<Advice | null> {
  const key = analysisKey(tab.document);
  const held = cache.get(tab.id);
  if (held && held.key === key) return held.pending ?? Promise.resolve(held.advice);
  if (!tab.document.nodes.length) {
    cache.set(tab.id, { key, advice: null, pending: null });
    return Promise.resolve(null);
  }
  const infinite = tab.document.infiniteBuffers;
  const pending = Promise.all([api.methodDomain(tab.document), api.methodAvailability()]).then(
    ([domain, availability]): Advice => ({ domain, rows: recommendations(domain, availability), infinite }),
    () => null,
  );
  const entry: Entry = { key, advice: held?.advice ?? null, pending };
  cache.set(tab.id, entry);
  void pending.then((advice) => {
    if (cache.get(tab.id) !== entry) return;
    cache.set(tab.id, { key, advice, pending: null });
    version++;
    listeners.forEach((l) => l());
    invalidateMenu();
  });
  return pending;
}

/** What is known now, without waiting (asks if nothing is on its way). */
export function cachedAdvice(tab: Pick<Tab, "id" | "document">): Advice | null {
  void adviceFor(tab);
  const held = cache.get(tab.id);
  return held && !held.pending ? held.advice : null;
}

export function useAdvice(tab: Pick<Tab, "id" | "document">): Advice | null {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  const key = analysisKey(tab.document);
  useEffect(() => {
    void adviceFor(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, key]);
  const held = cache.get(tab.id);
  return held && held.key === key && !held.pending ? held.advice : null;
}

/** For tests. */
export function resetAdvice() {
  cache.clear();
  version++;
  listeners.forEach((l) => l());
}
