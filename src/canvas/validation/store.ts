// When the network is checked, and what was last found for each tab (new in 2.1, ROADMAP C4).
//
// The canvas of a tab asks for a check whenever its nodes, links or buffer regime change. The
// request is debounced; when it fires, the document's structure (src/results/current.ts
// `structureKey`: everything but positions and pictures) is compared with the one last checked,
// and Rust is asked only when it differs. So a drag, a nudge, an align or a zoom costs one timer
// per frame and, once it settles, one string comparison: never a check. The check itself runs in
// Rust off the main thread, and its answer replaces the list in one store update.
import { useEffect, useSyncExternalStore } from "react";
import { announce } from "../../lib/announce";
import { api } from "../../lib/api";
import type { BnetDocument } from "../../lib/bnet";
import { getStateValue, setStateValues, useStateValue } from "../../lib/kv";
import { shortcutFor } from "../../lib/menu";
import { structureKey } from "../../results/current";
import { activeTab, tabById } from "../../workspace/store";
import { countProblems, type Diagnostic } from "./model";
import { validationWords as w } from "./words";

/** How long edits must settle before the network is checked. */
export const VALIDATION_DEBOUNCE_MS = 250;

/** "Show Problems on Canvas", kept with the canvas's other switches in state.json. On by default. */
export const SHOW_PROBLEMS_KEY = "canvas.problems.show";
export const problemsShown = () => getStateValue<unknown>(SHOW_PROBLEMS_KEY, true) !== false;
export const useProblemsShown = () => useStateValue<unknown>(SHOW_PROBLEMS_KEY, true) !== false;
export const setProblemsShown = (on: boolean) => void setStateValues({ [SHOW_PROBLEMS_KEY]: on }).catch(() => {});

interface Entry {
  /** The structure last checked, or being checked. */
  key: string | null;
  /** null until the first answer. */
  diagnostics: readonly Diagnostic[] | null;
  seq: number;
}

/** A problem's popover held open (the Problems list, Next Problem, a click on its badge). */
export interface OpenProblem {
  tabId: string;
  /** `targetKey` of the node or link. */
  target: string;
  /** Move the keyboard to its badge when it appears. */
  focus: boolean;
  /** Bumped on every request, so asking for the same problem again acts again. */
  nonce: number;
}

let entries = new Map<string, Entry>();
let open: OpenProblem | null = null;
let listOpen = false;
let seq = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const NONE: readonly Diagnostic[] = [];

/** How many times Rust has been asked (tests, and the measurement in the ledger). */
export const validationStats = { checks: 0 };

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function put(tabId: string, e: Entry) {
  entries = new Map(entries).set(tabId, e);
  emit();
}

/** The tab's problems; empty before the first answer. */
export const diagnosticsOf = (tabId: string): readonly Diagnostic[] => entries.get(tabId)?.diagnostics ?? NONE;
/** …and null before the first answer (the status bar says nothing until it knows). */
export const useDiagnostics = (tabId: string): readonly Diagnostic[] | null => useSyncExternalStore(subscribe, () => entries.get(tabId)?.diagnostics ?? null);

export const useOpenProblem = (tabId: string): OpenProblem | null => {
  const o = useSyncExternalStore(subscribe, () => open);
  return o && o.tabId === tabId ? o : null;
};
export const openProblemOf = (tabId: string) => (open && open.tabId === tabId ? open : null);
export function setOpenProblem(tabId: string, target: string | null, focus = false) {
  if (target === null) {
    if (!open || open.tabId !== tabId) return;
    open = null;
  } else open = { tabId, target, focus, nonce: ++seq };
  emit();
}

export const useProblemsListOpen = () => useSyncExternalStore(subscribe, () => listOpen);
export function setProblemsListOpen(on: boolean) {
  if (listOpen === on) return;
  listOpen = on;
  emit();
}

/** Checks `tabId`'s network now, unless its structure is the one already checked. */
export async function checkNetwork(tabId: string): Promise<void> {
  const pending = timers.get(tabId);
  if (pending) clearTimeout(pending);
  timers.delete(tabId);
  const tab = tabById(tabId);
  if (!tab) return;
  const key = structureKey(tab.document);
  const e = entries.get(tabId) ?? { key: null, diagnostics: null, seq: 0 };
  if (key !== null && e.key === key) return;
  const mine = ++seq;
  // The key is claimed at once, so a second request for the same structure waits for this one.
  entries = new Map(entries).set(tabId, { ...e, key, seq: mine });
  validationStats.checks++;
  let diagnostics: readonly Diagnostic[];
  try {
    diagnostics = await api.networkDiagnostics(tab.document);
  } catch {
    // A document core can't read has nothing to mark; opening or saving it says why.
    diagnostics = NONE;
  }
  const now = entries.get(tabId);
  if (!now || now.seq !== mine || !tabById(tabId)) return;
  put(tabId, { ...now, diagnostics });
  // A screen reader hears the count when it changes, never on the first check of a network and
  // never for another tab's (docs/ACCESSIBILITY.md): "Problems: 1 error, 2 warnings".
  if (e.diagnostics !== null && activeTab().id === tabId) {
    const was = countProblems(e.diagnostics);
    const is = countProblems(diagnostics);
    if (was.errors !== is.errors || was.warnings !== is.warnings) announce(w.countChanged(is));
  }
}

/** Asks for a check once edits settle. */
export function requestCheck(tabId: string, delay = VALIDATION_DEBOUNCE_MS) {
  const pending = timers.get(tabId);
  if (pending) clearTimeout(pending);
  timers.set(tabId, setTimeout(() => void checkNetwork(tabId), delay));
}

/**
 * Keeps `tabId`'s problems current while its canvas is mounted. The effect follows the document's
 * arrays, not the document: a zoom or a pan makes a new document around the same arrays.
 */
export function useValidation(tabId: string, document: BnetDocument | undefined) {
  const nodes = document?.nodes;
  const links = document?.links;
  const infinite = document?.infiniteBuffers;
  const population = document?.closedPopulation;
  useEffect(() => {
    if (nodes) requestCheck(tabId);
  }, [tabId, nodes, links, infinite, population]);
  useEffect(
    () => () => {
      const pending = timers.get(tabId);
      if (pending) clearTimeout(pending);
      timers.delete(tabId);
    },
    [tabId],
  );
}

/**
 * What to add to the Status log when a run of `tabId` was refused: a pointer to the Problems list
 * when the network has errors, else null. (For src/runs/state.ts `followRun`.)
 */
export function problemsPointer(tabId: string): string | null {
  const { errors } = countProblems(diagnosticsOf(tabId));
  return errors ? w.refusalPointer(errors, shortcutFor("view:next-problem")) : null;
}

/** For tests: forget everything. */
export function resetValidation() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  entries = new Map();
  open = null;
  listOpen = false;
  validationStats.checks = 0;
  emit();
}

/** For tests: a tab's problems as if Rust had answered. */
export function setDiagnosticsForTest(tabId: string, diagnostics: Diagnostic[]) {
  const tab = tabById(tabId);
  put(tabId, { key: tab ? structureKey(tab.document) : null, diagnostics, seq: ++seq });
}
