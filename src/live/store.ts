// When live results are computed, and what each tab's latest answer is (new in 2.1, ROADMAP
// Phase D). The arithmetic is Rust's (`live_results`, in-process and off the main thread); this
// decides when to ask:
//
// - only when the network's structure changes (`structureKey`: moving a node, a picture, the zoom
//   or the pan ask nothing);
// - at most once per `LIVE_DEBOUNCE_MS`: the first change starts the clock and the newest
//   document is sent when it runs out, so a burst of keystrokes is one request, and a number
//   scrubbed for seconds still updates the canvas several times a second rather than only when
//   the hand stops;
// - an answer that a newer request has overtaken is dropped, never shown.
import { useSyncExternalStore } from "react";
import { api } from "../lib/api";
import type { BnetDocument } from "../lib/bnet";
import { structureKey } from "../results/current";
import type { LiveResults } from "./model";

export const LIVE_DEBOUNCE_MS = 120;

interface Entry {
  /** The latest answer, or null (none yet, an empty canvas, or the request failed). */
  results: LiveResults | null;
  /** The structure the answer is for. */
  key: string | null;
  /** The structure a request is waiting or in flight for. */
  wantedKey: string | null;
  wanted: BnetDocument | null;
  timer: ReturnType<typeof setTimeout> | null;
  seq: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** How many requests have been sent, and how many answers were dropped as overtaken (tests, the bench). */
export const liveStats = { sent: 0, dropped: 0 };

const blank = (): Entry => ({ results: null, key: null, wantedKey: null, wanted: null, timer: null, seq: 0 });
const publish = () => listeners.forEach((l) => l());

// Cached on the nodes array (with the links and regime it was made with): a zoom or a pan — a new
// document object around the same arrays — does not stringify the network again.
const keys = new WeakMap<readonly unknown[], { links: readonly unknown[]; infinite: boolean; population: number | undefined; key: string | null }>();

/** `structureKey` of a document, remembered for its arrays. */
export function liveKey(doc: BnetDocument | null | undefined): string | null {
  if (!doc) return null;
  const hit = keys.get(doc.nodes);
  if (hit && hit.links === doc.links && hit.infinite === doc.infiniteBuffers && hit.population === doc.closedPopulation) return hit.key;
  const key = structureKey(doc);
  keys.set(doc.nodes, { links: doc.links, infinite: doc.infiniteBuffers, population: doc.closedPopulation, key });
  return key;
}

function send(tabId: string) {
  const e = entries.get(tabId);
  if (!e) return;
  e.timer = null;
  const doc = e.wanted;
  const key = e.wantedKey;
  if (!doc || key === null) return;
  const mine = ++e.seq;
  liveStats.sent++;
  const settle = (results: LiveResults | null) => {
    const now = entries.get(tabId);
    if (now !== e || now.seq !== mine) {
      liveStats.dropped++;
      return;
    }
    e.results = results;
    e.key = key;
    if (e.wantedKey === key) {
      e.wanted = null;
      e.wantedKey = null;
    }
    publish();
  };
  api.liveResults(doc).then(settle, () => settle(null));
}

/**
 * Asks for the live results of `doc` unless they are known or already asked for. Returns the
 * document's structure key.
 */
export function requestLive(tabId: string, doc: BnetDocument | null | undefined): string | null {
  const key = liveKey(doc);
  let e = entries.get(tabId);
  if (!e) entries.set(tabId, (e = blank()));
  if (!doc || key === null || !doc.nodes.length) {
    // Nothing to compute: forget what was shown, and overtake anything in flight.
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.wanted = null;
    e.wantedKey = null;
    e.seq++;
    if (e.results !== null || e.key !== key) {
      e.results = null;
      e.key = key;
      publish();
    }
    return key;
  }
  if (key === e.wantedKey || (key === e.key && e.wantedKey === null)) return key;
  if (key === e.key) {
    // Back to the structure already answered (an undo): nothing to ask, and what is in flight is void.
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.wanted = null;
    e.wantedKey = null;
    e.seq++;
    return key;
  }
  e.wanted = doc;
  e.wantedKey = key;
  // Whatever is in flight is for an older structure now.
  e.seq++;
  if (!e.timer) e.timer = setTimeout(() => send(tabId), LIVE_DEBOUNCE_MS);
  return key;
}

/** The tab's latest answer and the structure it is for. */
export function liveOf(tabId: string): { results: LiveResults | null; key: string | null } {
  const e = entries.get(tabId);
  return { results: e?.results ?? null, key: e?.key ?? null };
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The tab's latest live answer, following every new one. Null while Live Results has nothing. */
export function useLive(tabId: string): LiveResults | null {
  return useSyncExternalStore(subscribe, () => entries.get(tabId)?.results ?? null);
}

/** Forgets a tab (closed), or everything (tests). */
export function forgetLive(tabId?: string) {
  for (const [id, e] of entries) {
    if (tabId !== undefined && id !== tabId) continue;
    if (e.timer) clearTimeout(e.timer);
    entries.delete(id);
  }
  if (tabId === undefined) {
    liveStats.sent = 0;
    liveStats.dropped = 0;
  }
  publish();
}
