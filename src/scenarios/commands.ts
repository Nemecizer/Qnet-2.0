// What the person does with scenarios (new in 2.1, ROADMAP E1): show one, make one from the
// values shown, rename, delete, reset one field to the baseline — each ONE undo step through the
// tab's editor (`applyScenarioState`), with a Status line — and the commands the menu, the palette
// and the toolbar's switcher run. The rules are ./model.ts's.
import { useSyncExternalStore } from "react";
import { editorFor } from "../editor";
import { newId, type BnetDocument } from "../lib/bnet";
import { registerCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { sequenceRunning } from "../panes/results/agreement/runner";
import { liveRun } from "../runs/ui/live";
import { activeTab, tabById } from "../workspace/store";
import { activeId, activeScenario, deleteScenario, MISSING, baselineValue, newScenario, renameScenario, resetOverride, scenariosOf, switchScenario, uniqueName, type OverrideTarget } from "./model";
import { solveAllRunning } from "./solveAll";
import { scenarioWords as w } from "./words";

const docOf = (tabId: string): BnetDocument | null => tabById(tabId)?.document ?? null;

/** A run reads the network as it stands: nothing about the scenarios changes under it. */
const runBusy = () => sequenceRunning() || !!liveRun() || solveAllRunning();

/** Shows scenario `id` (null: the baseline). True when what is shown changed. */
export function showScenario(tabId: string, id: string | null): boolean {
  const doc = docOf(tabId);
  if (!doc || runBusy()) return false;
  const next = switchScenario(doc, id);
  if (next === doc) return false;
  const editor = editorFor(tabId);
  editor.applyScenarioState(w.undo.switch, next);
  const name = activeScenario(next)?.name;
  editor.status(name === undefined ? w.switchedBaseline : w.switched(name), "info");
  return true;
}

/** New Scenario from Current Values; the name is made unique. Returns the new scenario's id. */
export function createScenario(tabId: string, name: string, undoName: string = w.undo.new, quiet = false): string | null {
  const doc = docOf(tabId);
  if (!doc || runBusy()) return null;
  const id = newId();
  const unique = uniqueName(doc, name, w.baseline);
  const editor = editorFor(tabId);
  editor.applyScenarioState(undoName, newScenario(doc, id, unique));
  if (!quiet) editor.status(w.created(unique), "info");
  return id;
}

export function renameScenarioTo(tabId: string, id: string, name: string): boolean {
  const doc = docOf(tabId);
  const was = scenariosOf(doc).find((s) => s.id === id);
  if (!doc || !was) return false;
  const next = renameScenario(doc, id, uniqueName(doc, name, w.baseline, id));
  if (next === doc) return false;
  const editor = editorFor(tabId);
  editor.applyScenarioState(w.undo.rename, next);
  editor.status(w.renamed(was.name, scenariosOf(next).find((s) => s.id === id)!.name), "info");
  return true;
}

export function removeScenario(tabId: string, id: string): boolean {
  const doc = docOf(tabId);
  const was = scenariosOf(doc).find((s) => s.id === id);
  if (!doc || !was || runBusy()) return false;
  const editor = editorFor(tabId);
  editor.applyScenarioState(w.undo.delete, deleteScenario(doc, id));
  editor.status(w.deleted(was.name), "info");
  return true;
}

/** Reset to baseline for one field of the scenario shown. */
export function resetToBaseline(tabId: string, target: OverrideTarget): boolean {
  const doc = docOf(tabId);
  if (!doc || baselineValue(doc, target) === MISSING || runBusy()) return false;
  const editor = editorFor(tabId);
  editor.applyScenarioState(w.undo.reset, resetOverride(doc, target));
  editor.status(w.resetDone(w.fields[target.field]), "info");
  return true;
}

/**
 * Save as Scenario, for a view that has a change to apply (Results ▸ Capacity's and Sensitivity's
 * second button): a new scenario is made from the values shown and `apply` — the view's own Apply
 * — then runs under it, so the change is that scenario's and every other variant keeps its
 * values. One ⌘Z takes both back. When `apply` changes nothing (it returns false and has said
 * why), no scenario is left behind. True when the scenario was saved.
 */
export function saveAsScenario(tabId: string, name: string, apply: () => boolean): boolean {
  const before = docOf(tabId);
  if (!before || runBusy()) return false;
  const editor = editorFor(tabId);
  const id = createScenario(tabId, name, w.undo.saveAs, true);
  if (id === null) return false;
  if (!apply()) {
    // Nothing was applied: take the empty scenario back (it is the newest undo step).
    editor.undo();
    return false;
  }
  editor.undoManager.setActionName(w.undo.saveAs);
  editor.status(w.savedAs(activeScenario(docOf(tabId))?.name ?? name), "info");
  return true;
}

// ── The name prompt and the Compare panel: which is up ──────────────────────────────────────────

export interface NameRequest {
  tabId: string;
  mode: "new" | "rename" | "duplicate";
  /** The scenario renamed. */
  id?: string;
  initial: string;
}

let nameRequest: NameRequest | null = null;
let compareTab: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** How many hosts are mounted (./Host.tsx); with none, the first request makes one. */
export const scenarioHosts = { mounted: 0, fallback: null as null | (() => void) };
const needHost = () => {
  if (!scenarioHosts.mounted) scenarioHosts.fallback?.();
};

export function askScenarioName(mode: NameRequest["mode"], tabId: string = activeTab().id) {
  const doc = docOf(tabId);
  const now = activeScenario(doc);
  if (mode === "rename" && !now) return;
  const initial = mode === "rename" ? now!.name : uniqueName(doc, mode === "duplicate" && now ? w.copyOf(now.name) : w.defaultName, w.baseline);
  nameRequest = { tabId, mode, id: now?.id, initial };
  needHost();
  notify();
}

export function closeScenarioName() {
  if (!nameRequest) return;
  nameRequest = null;
  notify();
}

/** Why `name` cannot be used for the request, or null. */
export function nameProblem(r: NameRequest, name: string): string | null {
  const text = name.trim();
  if (!text) return w.nameEmpty;
  const clash = text.toLowerCase() === w.baseline.toLowerCase() || scenariosOf(docOf(r.tabId)).some((s) => s.name.trim().toLowerCase() === text.toLowerCase() && !(r.mode === "rename" && s.id === r.id));
  return clash ? w.nameTaken(text) : null;
}

/** Confirms the prompt. True when done (the prompt closes). */
export function confirmScenarioName(r: NameRequest, name: string): boolean {
  if (nameProblem(r, name) !== null) return false;
  if (r.mode === "rename") {
    if (r.id) renameScenarioTo(r.tabId, r.id, name.trim());
  } else if (createScenario(r.tabId, name.trim()) === null) return false;
  closeScenarioName();
  return true;
}

export const useScenarioNameRequest = (): NameRequest | null => useSyncExternalStore(subscribe, () => nameRequest);

export function openCompare(tabId: string = activeTab().id) {
  compareTab = tabId;
  needHost();
  notify();
}

export function closeCompare() {
  if (compareTab === null) return;
  compareTab = null;
  notify();
}

export const useCompareTab = (): string | null => useSyncExternalStore(subscribe, () => compareTab);
export const currentCompareTab = () => compareTab;

// ── The commands ────────────────────────────────────────────────────────────────────────────────

export const COMPARE_COMMAND = "scenario:compare";
export const NEW_COMMAND = "scenario:new";

const hasNetwork = (): true | string => {
  if (modalOpen()) return MODAL_REASON;
  if (!activeTab().document.nodes.length) return w.noNetwork;
  return runBusy() ? w.busy : true;
};
const hasScenario = (): true | string => {
  const ok = hasNetwork();
  if (ok !== true) return ok;
  return activeId(activeTab().document) === null ? w.onlyForScenario : true;
};

export function scenarioCommands(): Command[] {
  return [
    { id: NEW_COMMAND, title: w.newFromCurrent, group: "Run", subtitle: w.newHelp, keywords: w.keywords, when: hasNetwork, run: () => askScenarioName("new") },
    { id: "scenario:rename", title: `${w.menuLabel}: ${w.rename}`, group: "Run", subtitle: w.renameHelp, keywords: w.keywords, when: hasScenario, run: () => askScenarioName("rename") },
    { id: "scenario:duplicate", title: `${w.menuLabel}: ${w.duplicate}`, group: "Run", subtitle: w.duplicateHelp, keywords: w.keywords, when: hasNetwork, run: () => askScenarioName("duplicate") },
    {
      id: "scenario:delete",
      title: `${w.menuLabel}: ${w.delete}`,
      group: "Run",
      subtitle: w.deleteHelp,
      keywords: w.keywords,
      when: hasScenario,
      run: () => {
        const tab = activeTab();
        const id = activeId(tab.document);
        if (id !== null) removeScenario(tab.id, id);
      },
    },
    {
      id: "scenario:baseline",
      title: `${w.menuLabel}: ${w.baseline}`,
      group: "Run",
      subtitle: w.showBaselineHelp,
      keywords: w.keywords,
      when: hasScenario,
      run: () => void showScenario(activeTab().id, null),
    },
    {
      id: COMPARE_COMMAND,
      title: w.compare,
      group: "Run",
      subtitle: w.compareHelp,
      keywords: w.keywords,
      when: () => (activeTab().document.nodes.length ? true : w.noNetwork),
      run: () => openCompare(),
    },
  ];
}

let started = false;

/** Registers the commands once per page. */
export function startScenarioCommands(): void {
  if (started) return;
  started = true;
  registerCommands(scenarioCommands());
}

/** For tests. */
export function resetScenarioCommands() {
  nameRequest = null;
  compareTab = null;
  notify();
}
