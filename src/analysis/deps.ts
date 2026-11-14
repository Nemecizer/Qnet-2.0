// The startup dependency checklist's state (0.90.34 StartupDependencyChecker.swift
// `StartupDependencyChecker`; ledger ANA-237, ANA-249, ANA-250, MENU-162).
//
// The catalog and each probe are Rust's (src-tauri/src/analysis_windows/deps.rs); this runs them
// one at a time in catalog order, each row shown as "checking" for at least 180 ms; it runs once
// per session (`runIfNeeded`), and Recheck resets every row and runs again. The sheet opens at
// launch only for a source-tree run (`!catalog.packaged`), and from Help ▸ Check Dependencies… at
// any time.
import { useSyncExternalStore } from "react";
import { api } from "../lib/api";
import type { DependencyCatalog, DependencyRequirement, DependencyResult } from "../lib/types";
import { analysisWords as w } from "./words";

export type DependencyStatus = { state: "pending" } | { state: "checking" } | DependencyResult;

export interface DependencyItem {
  requirement: DependencyRequirement;
  status: DependencyStatus;
}

export interface CheckState {
  /** The sheet is up. */
  open: boolean;
  packaged: boolean;
  items: DependencyItem[];
  currentId: string | null;
  lastCheckedId: string | null;
  running: boolean;
  hasRun: boolean;
}

/** How long a row shows as being checked, at least (0.90.34's 180 ms). */
export const checkTiming = { minimumVisibleMs: 180 };

let state: CheckState = { open: false, packaged: true, items: [], currentId: null, lastCheckedId: null, running: false, hasRun: false };
let catalogLoaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<CheckState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getCheckState(): CheckState {
  return state;
}

export function useCheckState(): CheckState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

function loadCatalog(): Promise<void> {
  catalogLoaded ??= api.dependencyCatalog().then(
    (c: DependencyCatalog) => {
      if (!state.items.length) set({ packaged: c.packaged, items: c.items.map((requirement) => ({ requirement, status: { state: "pending" } })) });
    },
    () => {
      catalogLoaded = null;
    },
  );
  return catalogLoaded;
}

// ── What the sheet shows, derived (0.90.34's computed properties) ───────────────────────────────

export const needsAttention = (s: DependencyStatus) => s.state === "missing" || s.state === "timedOut";
export const attentionCount = (st: CheckState = state) => st.items.filter((i) => needsAttention(i.status)).length;
export const availableCount = (st: CheckState = state) => st.items.filter((i) => i.status.state === "available").length;

const unique = (xs: string[]) => [...new Set(xs)];

/** `brewInstallCommand`: one de-duplicated `brew install …` line for the rows that need attention. */
export function brewInstallCommand(st: CheckState = state): string | null {
  const formulae = unique(st.items.filter((i) => needsAttention(i.status)).flatMap((i) => i.requirement.brewFormulae));
  return formulae.length ? `brew install ${formulae.join(" ")}` : null;
}

export function supplementalCommands(st: CheckState = state): string[] {
  return unique(st.items.filter((i) => needsAttention(i.status)).flatMap((i) => i.requirement.supplementalInstallCommands));
}

/** The command block's text: the brew line, then the supplemental commands. */
export function commandText(st: CheckState = state): string {
  return [brewInstallCommand(st), ...supplementalCommands(st)].filter((x): x is string => !!x).join("\n");
}

export const bundledAttention = (st: CheckState = state) => st.items.some((i) => i.requirement.scope === "Bundled" && needsAttention(i.status));

/** A row's name and summary (the words, by id). */
export function describe(r: DependencyRequirement, packaged: boolean): { name: string; summary: string } {
  if (r.id === "optional.cjson") return { name: w.cjson.name, summary: packaged ? w.cjson.packaged : w.cjson.developer };
  return w.requirements[r.id] ?? { name: r.id, summary: "" };
}

export const nameOf = (id: string | null, st: CheckState = state) => {
  const item = st.items.find((i) => i.requirement.id === id);
  return item ? describe(item.requirement, st.packaged).name : "";
};

// ── Running the checks ────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run() {
  if (state.running) return;
  set({ running: true });
  try {
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      const id = item.requirement.id;
      set({ currentId: id, items: state.items.map((x, k) => (k === i ? { ...x, status: { state: "checking" } } : x)) });
      const started = Date.now();
      let result: DependencyResult;
      try {
        result = await api.dependencyProbe(id);
      } catch (e) {
        result = { state: "missing", detail: String(e) };
      }
      const left = checkTiming.minimumVisibleMs - (Date.now() - started);
      if (left > 0) await sleep(left);
      set({ lastCheckedId: id, items: state.items.map((x, k) => (k === i ? { ...x, status: result } : x)) });
    }
  } finally {
    set({ currentId: null, running: false, hasRun: true });
  }
}

/** The sheet's `.task`: runs the checks the first time it is shown in a session. */
export async function runIfNeeded(): Promise<void> {
  await loadCatalog();
  if (state.hasRun || state.running) return;
  await run();
}

/** Recheck: every row back to pending, then the checks again. */
export async function rerun(): Promise<void> {
  if (state.running) return;
  await loadCatalog();
  set({ items: state.items.map((x) => ({ ...x, status: { state: "pending" } })), currentId: null, lastCheckedId: null, hasRun: false });
  await run();
}

/** Help ▸ Check Dependencies…: shows the checklist (it runs once per session). */
export function openDependencyCheck() {
  set({ open: true });
  void runIfNeeded();
}

/** Continue: closes the sheet (not while checks are running). */
export function closeDependencyCheck(): boolean {
  if (state.running) return false;
  set({ open: false });
  return true;
}

/**
 * The launch hook: shows the checklist when this is a source-tree run (ANA-237; a packaged app
 * never shows it at launch, and no setting suppresses it). Resolves to whether it opened.
 */
export async function startupDependencyCheck(): Promise<boolean> {
  await loadCatalog();
  if (!catalogLoaded || state.packaged) return false;
  openDependencyCheck();
  return true;
}

/** For tests. */
export function resetDependencyCheck() {
  state = { open: false, packaged: true, items: [], currentId: null, lastCheckedId: null, running: false, hasRun: false };
  catalogLoaded = null;
  listeners.forEach((l) => l());
}
