// When the silent analysis runs, and what it last found for each tab (0.90.34 QnetGUIApp.swift
// `analyzeActiveTabIfNeeded`, its `.bnetNetworkParametersDidChange` debounce and `onChange(of:
// activeTabID)`; NetworkEditorModel.swift `invalidateAnalysisIfItWouldRead`, `sameForAnalysis`;
// ledger ANA-015, ANA-020…027, LOG-032). What it computes is Rust's (src-tauri/src/analysis.rs).
//
// - At launch and whenever the active tab changes, the active tab is analysed, writing its
//   "Silent analysis ρ: …" lines to its log, unless it has been analysed since its last change.
// - 150 ms after the last change to a document that changed something the analysis reads, the
//   tab that changed is analysed quietly (no Status lines), if it is the active tab by then.
// - A tab "has been analysed" while its document still has the key it was analysed with: the
//   fields the analysis reads (buffer mode, links, node count and each node's id, kind, name,
//   bufferSize, servers, distribution and its parameters, per-class service). Moving a node or
//   changing its picture changes nothing here.
import { useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import type { BnetDocument } from "../../lib/bnet";
import type { SilentAnalysis } from "../../lib/types";
import { getWorkspace, onWorkspaceChange, tabById, type Tab } from "../../workspace/store";
import { logStatus } from "./state";

/** The debounce after an edit (0.90.34's 150 ms, the same as the utilisation badges'). */
export const ANALYSIS_DEBOUNCE_MS = 150;

// Cached on the nodes array (with the links and the regime it was made with), so a zoom or pan —
// a new document object around the same content — doesn't stringify the network again.
const keys = new WeakMap<readonly unknown[], { links: readonly unknown[]; infinite: boolean; key: string }>();

/** What of `doc` the analysis reads, as one string (`analysisWouldRead`, `sameForAnalysis`). */
export function analysisKey(doc: BnetDocument): string {
  const hit = keys.get(doc.nodes);
  // A closed network's population (new in 2.1) is read too; an open network's key is as before.
  const population = doc.closedPopulation === undefined ? "" : `|N=${doc.closedPopulation}`;
  if (hit && hit.links === doc.links && hit.infinite === doc.infiniteBuffers) return hit.key + population;
  const key = JSON.stringify([
    doc.infiniteBuffers,
    doc.links,
    doc.nodes.map((n) => [n.id, n.kind, n.name, n.bufferSize, n.numberOfServers, n.distribution, n.distributionParameters, n.serviceDistributions]),
  ]);
  keys.set(doc.nodes, { links: doc.links, infinite: doc.infiniteBuffers, key });
  return key + population;
}

interface Entry {
  /** The latest result for this tab, or null before its first analysis. */
  result: SilentAnalysis | null;
  /** The key of the document it was last analysed with (`hasBeenAnalyzed` while it matches). */
  analysedKey: string | null;
  /** The key of a run in flight, so a second request for the same document waits for it. */
  pendingKey: string | null;
  seq: number;
}

let entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let seq = 0;

function entry(id: string): Entry {
  return entries.get(id) ?? { result: null, analysedKey: null, pendingKey: null, seq: 0 };
}

function put(id: string, e: Entry) {
  entries = new Map(entries).set(id, e);
  listeners.forEach((l) => l());
}

/** The blank result an empty canvas's quiet run publishes: every flag off, no warnings. */
function emptyResult(): SilentAnalysis {
  return {
    outcome: "empty", error: null, utilisation: {}, warnings: [], isAnalyticallyTractable: false, tractabilityIsExact: false,
    tractabilityTitle: "", tractabilityDetail: "", tractabilityMeans: [], tractabilityMeansLabel: "", tractabilityExplanation: "",
    hasFeedback: false, feedbackDescription: "", feedbackQuality: "notReentrant", feedbackCriteria: [], stationNames: [],
    stationOrderIsAmbiguous: false, throughputs: null, nonExponentialStations: [], status: [],
  };
}

/** The latest analysis of a tab, or null. */
export function analysisOf(tabId: string): SilentAnalysis | null {
  return entry(tabId).result;
}

/** True when the tab has been analysed since its last change (0.90.34 `hasBeenAnalyzed`). */
export function hasBeenAnalyzed(tab: Tab): boolean {
  return entry(tab.id).analysedKey === analysisKey(tab.document);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The tab's latest analysis, following every new result. */
export function useAnalysis(tabId: string): SilentAnalysis | null {
  return useSyncExternalStore(subscribe, () => entry(tabId).result);
}

/** Whether the tab's document has been analysed as it is now. */
export function useHasBeenAnalyzed(tab: Tab): boolean {
  useSyncExternalStore(subscribe, () => entry(tab.id).analysedKey);
  return hasBeenAnalyzed(tab);
}

const NO_BADGES: Record<string, number> = {};

/** Node id → ρ for the canvas's utilisation badges (ledger ANA-015, drawn in P5). */
export function useStationUtilisation(tabId: string): Record<string, number> {
  return useSyncExternalStore(subscribe, () => entry(tabId).result?.utilisation ?? NO_BADGES);
}

/**
 * Analyses a tab unless it has been analysed since its last change (`analyzeActiveTabIfNeeded`).
 * An empty canvas: a quiet run clears the flags and marks it analysed; a non-quiet one does
 * nothing (ANA-024). A non-quiet run writes the analysis's Status lines to the tab's log (ANA-026,
 * ANA-027). Resolves when done.
 */
export async function analyseTab(tabId: string, quiet: boolean): Promise<void> {
  const tab = tabById(tabId);
  if (!tab) return;
  const key = analysisKey(tab.document);
  const e = entry(tabId);
  if (e.analysedKey === key || e.pendingKey === key) return;
  if (!tab.document.nodes.length) {
    if (quiet) put(tabId, { ...e, result: emptyResult(), analysedKey: key });
    return;
  }
  const mine = ++seq;
  put(tabId, { ...e, pendingKey: key, seq: mine });
  let result: SilentAnalysis;
  try {
    result = await api.analysisRun(tab.document);
  } catch (err) {
    // A document core can't read is reported as the analysis failing, as computeData's refusal is.
    const message = err instanceof Error ? err.message : String(err);
    result = { ...emptyResult(), outcome: "failed", error: message, status: [`Silent analysis failed: ${message}`] };
  }
  const now = entry(tabId);
  if (!tabById(tabId)) return;
  if (now.seq === mine) put(tabId, { ...now, result, analysedKey: key, pendingKey: null });
  if (!quiet) {
    for (const line of result.status) logStatus(tabId, line, result.outcome === "failed" ? "error" : undefined);
  }
}

/**
 * Publishes an analysis another command ran for the tab's current document and marks it analysed
 * (Network ▸ Show Network Primitives does, ledger ANA-173; Analyze Network does not, ANA-141).
 */
export function recordAnalysis(tabId: string, result: SilentAnalysis) {
  const tab = tabById(tabId);
  if (!tab) return;
  const e = entry(tabId);
  put(tabId, { ...e, result, analysedKey: analysisKey(tab.document), pendingKey: null, seq: ++seq });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let lastChanged: string | null = null;

/** An edit in `tabId` changed what the analysis reads: re-analyse quietly once edits settle. */
function noteChanged(tabId: string) {
  lastChanged = tabId;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const id = lastChanged;
    lastChanged = null;
    if (id && id === getWorkspace().activeId) void analyseTab(id, true);
  }, ANALYSIS_DEBOUNCE_MS);
}

/** Starts the triggers; analyses the active tab now (launch). Returns a function that stops them. */
export function startSilentAnalysis(): () => void {
  const stop = onWorkspaceChange((ws, prev) => {
    const before = new Map(prev.tabs.map((t) => [t.id, t.document]));
    for (const t of ws.tabs) {
      const was = before.get(t.id);
      if (was && was !== t.document && analysisKey(was) !== analysisKey(t.document)) noteChanged(t.id);
    }
    if (ws.tabs.length !== prev.tabs.length || ws.tabs.some((t, i) => t.id !== prev.tabs[i]?.id)) {
      const ids = new Set(ws.tabs.map((t) => t.id));
      if ([...entries.keys()].some((k) => !ids.has(k))) {
        entries = new Map([...entries].filter(([k]) => ids.has(k)));
        listeners.forEach((l) => l());
      }
    }
    if (ws.activeId !== prev.activeId) void analyseTab(ws.activeId, false);
  });
  void analyseTab(getWorkspace().activeId, false);
  return () => {
    stop();
    if (timer) clearTimeout(timer);
    timer = null;
    lastChanged = null;
  };
}

/** For tests: forget every result. */
export function resetSilentAnalysis() {
  entries = new Map();
  seq = 0;
  if (timer) clearTimeout(timer);
  timer = null;
  lastChanged = null;
  listeners.forEach((l) => l());
}
