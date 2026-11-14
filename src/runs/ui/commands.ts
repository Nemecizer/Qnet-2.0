// The Run and Test menus (0.90.34 QnetCommands.swift `runMenu`, `testMenu`, `runAdvisedMethod`;
// QnetGUIApp.swift `commandActions` and each `run…()` action's sheet and gating; ledger §1.7,
// §1.8, §7.1, §7.2, METH-117, RUN-017, RUN-046): one command per menu item, by menuSpec's ids.
//
// Gating, as 0.90.34 had it: every Run item needs a network on the canvas and no sheet or modal
// panel up; the infinite items need an infinite-buffer network and the finite ones a finite one;
// Run Comparison either. A run already in progress does not dim them: the run is refused at launch
// with 0.90.34's sentence (and a sheet before it opens, METH-014). Stop needs a run; it is live
// from the click that started one. The Test items don't need a network; they wait while a sheet is
// up and, in 2.0, until a running sweep has finished (TEST-020, Changed).
//
// Each item runs 0.90.34's run label for the active tab through `startRun` (src/runs/state.ts),
// first asking with its parameter sheet when 0.90.34 did. A run that is refused before it starts
// opens a hidden Status pane, where the runner's sentences went (RUN-017).
//
// Run ▸ Choose a Method… is the analysis area's (src/analysis, src/windows/methodchooser): its
// window runs these commands by id (`runCommand("run:qna")`), so the sheets and gates are these.
import { useCommands, type Command } from "../../lib/commands";
import { getSetting, setSettings } from "../../lib/kv";
import { MODAL_REASON, modalOpen } from "../../lib/overlays";
import { api } from "../../lib/api";
import type { KvValues } from "../../lib/types";
import { editorFeedback } from "../../editor/editor";
import { activeTab, addStatus, tabById } from "../../workspace/store";
import { reveal } from "../../workspace/panes/commands";
import { onRunFinished, startRun, stopRun } from "../state";
import { invalidateMenu } from "../../lib/menu";
import { useEffect } from "react";
import { closePanel, openPanel } from "./panels";
import { comparisonBlocking, finiteElement, linearProgram, monteCarloFinite, monteCarloInfinite, multiClass, overridesFor, regenerative, replicatedSimulation, spectralFinite, spectralInfinite, type SheetSpec, type SheetValues } from "./specs";
import { spectralConvergenceDefaults, testSetDefaults } from "./testsets";
import { liveRun } from "./live";
import { sweepBusy } from "./sweeps";
import { displayLabel, runWords as w } from "./words";
import { drawnAs, looksClosed as closedShape } from "../../closed/shape";
import { usesAnyFeature, usesFeature } from "../../extended/shape";
import { extendedWords as xw } from "../../extended/words";

/** Which buffer mode an item belongs to: infinite only, finite only, or either (Run Comparison). */
type Mode = "infinite" | "finite" | "either" | "closed" | "inprocess" | "priority" | "batch";

interface RunItem {
  id: string;
  mode: Mode;
  /** 0.90.34's run label for the active network. */
  label: (infinite: boolean) => string;
  /** The sheet asked first, or null to launch straight away. */
  sheet?: (tabId: string, infinite: boolean) => SheetSpec | null;
}

const stations = (tabId: string) => tabById(tabId)?.document.nodes.filter((n) => n.kind === "station").length ?? 0;
const L = (label: string) => () => label;

/** The Run menu in menu order (QnetCommands.swift runMenu), with each item's run label. */
export const RUN_ITEMS: RunItem[] = [
  { id: "run:comparison", mode: "either", label: (inf) => (inf ? "inf_cmp" : "cmp"), sheet: (_t, inf) => (inf || getSetting<boolean>("runCompare.remember", false) ? null : comparisonBlocking()) },
  { id: "run:monte-carlo-infinite", mode: "infinite", label: L("inf_sim"), sheet: () => monteCarloInfinite() },
  { id: "run:product-form", mode: "infinite", label: L("product_form") },
  { id: "run:qbd", mode: "infinite", label: L("qbd") },
  { id: "run:truncated-ctmc", mode: "infinite", label: L("truncated_ctmc") },
  { id: "run:regenerative-infinite", mode: "infinite", label: L("regenerative_mc"), sheet: () => regenerative(true) },
  { id: "run:spectral-infinite", mode: "infinite", label: L("inf_sm"), sheet: (t) => spectralInfinite(stations(t)) },
  { id: "run:qna", mode: "infinite", label: L("qna") },
  { id: "run:rqna", mode: "infinite", label: L("rqna") },
  { id: "run:sbd", mode: "infinite", label: L("sbd") },
  { id: "run:mlmc", mode: "infinite", label: L("mlmc") },
  { id: "run:lp", mode: "infinite", label: L("lp"), sheet: (t) => (getSetting<boolean>("lp.askBeforeRun", false) ? linearProgram(stations(t)) : null) },
  { id: "run:low-rank-bar", mode: "infinite", label: L("adaptive_bar") },
  { id: "run:bar-bounds", mode: "infinite", label: L("bar_bounds") },
  { id: "run:monte-carlo-finite", mode: "finite", label: L("sim"), sheet: () => monteCarloFinite() },
  { id: "run:regenerative-finite", mode: "finite", label: L("regenerative_mc"), sheet: () => regenerative(false) },
  { id: "run:generic-ctmc", mode: "finite", label: L("generic_ctmc") },
  { id: "run:decomposition", mode: "finite", label: L("fb_decomp") },
  { id: "run:spectral-finite", mode: "finite", label: L("sm"), sheet: () => spectralFinite() },
  { id: "run:finite-element", mode: "finite", label: L("fm"), sheet: (t) => finiteElement(stations(t)) },
  { id: "run:finite-lp", mode: "finite", label: L("flp") },
  { id: "run:multiclass", mode: "infinite", label: L("mc"), sheet: () => multiClass() },
  // New in 2.1: the one method of a closed network (no source, no sink), whatever its buffer mode.
  { id: "run:closed-product-form", mode: "closed", label: L("closed_pf") },
  // New in 2.1: a simulation computed inside Qnet, for a closed network and for an open one with
  // infinite buffers ("inprocess": either of those).
  // New in 2.1: the exact single-station methods of priority service and of batch arrivals.
  { id: "run:priority-exact", mode: "priority", label: L("priority_exact") },
  { id: "run:batch-exact", mode: "batch", label: L("batch_exact") },
  { id: "run:replicated-simulation", mode: "inprocess", label: L("sim_inproc"), sheet: (t) => replicatedSimulation(looksClosed(tabById(t)?.document ?? { nodes: [] })) },
];

export const runItem = (id: string) => RUN_ITEMS.find((i) => i.id === id);

// ── Multi-Class SRBM's solver (MENU-135, METH-006) ────────────────────────────────────────────

let mcLookup: { available: boolean; diagnostic: string } | null = null;

/** Looks `mc_solver` up again (on mount, after every run, and before the item runs). */
export async function refreshMultiClassLookup(): Promise<void> {
  try {
    mcLookup = await api.solverLookup("mc_solver", "BNAmd");
  } catch {
    mcLookup = null;
  }
  invalidateMenu();
}

const mcMissing = () => mcLookup !== null && !mcLookup.available;

// ── Gating ────────────────────────────────────────────────────────────────────────────────────

const hasNetwork = () => activeTab().document.nodes.length > 0;
const infiniteNow = () => activeTab().document.infiniteBuffers;
/** Drawn as a closed network: stations, no source and no sink (the one rule, src/closed/shape.ts). */
export const looksClosed = (doc: { nodes: readonly { kind: string }[] }) => closedShape(doc.nodes);
const closedShapeNow = () => looksClosed(activeTab().document);
/** A closed network: that shape, and a population. Without one it is a network still being drawn. */
const closedNow = () => drawnAs(activeTab().document) === "closed";

/** Why item `id` is dimmed now, or true when it can run (the palette shows the reason). */
export function runWhen(id: string): true | string {
  const item = runItem(id);
  if (!item) return true;
  if (modalOpen()) return MODAL_REASON;
  if (!hasNetwork()) return w.noNetwork;
  if (item.mode === "closed") return closedShapeNow() ? true : w.notClosed;
  if (item.mode === "inprocess") return closedShapeNow() || infiniteNow() ? true : w.replicatedNeedsInfinite;
  // The exact methods of the features new in 2.1 need their feature; every older method needs
  // a network without any of them (the one rule, src/extended/shape.ts), or it would answer
  // for a different network.
  if (item.mode === "priority") return usesFeature(activeTab().document, "priorities") ? true : xw.needsPriorities;
  if (item.mode === "batch") return usesFeature(activeTab().document, "batchArrivals") ? true : xw.needsBatches;
  if (closedNow()) return w.isClosed;
  if (usesAnyFeature(activeTab().document)) return xw.usesFeature;
  if (item.mode === "infinite" && !infiniteNow()) return w.hasFiniteBuffers;
  if (item.mode === "finite" && infiniteNow()) return w.hasInfiniteBuffers;
  if (id === "run:multiclass" && mcMissing()) return mcLookup!.diagnostic;
  return true;
}

/** The item's 0.90.34 tooltip (`runHelp`), with the reason a dimmed item gives (MENU-112). */
export function runHelp(id: string): string {
  if (id === "run:multiclass" && mcMissing()) return mcLookup!.diagnostic;
  const item = runItem(id);
  let text = w.help[id] ?? "";
  if (!hasNetwork()) text += w.noNetworkSuffix;
  else if (item?.mode === "closed") text += closedShapeNow() ? "" : w.notClosedSuffix;
  else if (item?.mode === "inprocess") text += closedShapeNow() || infiniteNow() ? "" : w.finiteSuffix;
  else if (item?.mode === "priority") text += usesFeature(activeTab().document, "priorities") ? "" : w.needsPrioritiesSuffix;
  else if (item?.mode === "batch") text += usesFeature(activeTab().document, "batchArrivals") ? "" : w.needsBatchesSuffix;
  else if (closedNow()) text += w.closedSuffix;
  else if (usesAnyFeature(activeTab().document)) text += w.newFeatureSuffix;
  else if (item?.mode === "infinite" && !infiniteNow()) text += w.finiteSuffix;
  else if (item?.mode === "finite" && infiniteNow()) text += w.infiniteSuffix;
  if (id === "run:comparison") text += w.comparisonSuffix;
  return text;
}

// ── Running ───────────────────────────────────────────────────────────────────────────────────

const SINGLE_FLIGHT = /was not started because .* is already running for/;

/**
 * Starts `label` for `tabId` with a sheet's overrides. A run refused before it starts has written
 * its lines to the tab's Status log; a hidden Status pane is opened for them (`reportBlocked`),
 * except for the single-flight refusal, which 0.90.34 wrote without opening the pane.
 */
export async function startMethod(tabId: string, label: string, overrides: KvValues = {}): Promise<boolean> {
  const before = tabById(tabId)?.log.length ?? 0;
  const started = await startRun(tabId, label, overrides);
  if (!started) {
    const added = (tabById(tabId)?.log ?? []).slice(before);
    if (added.length && !added.some((l) => SINGLE_FLIGHT.test(l.text))) await revealStatus();
  }
  return started;
}

/** WorkspaceCommands `reveal(.status)` without moving focus. */
export function revealStatus(): Promise<void> {
  return reveal("status", () => {}).catch(() => {});
}

/**
 * `presentRunParameters`: refused while a run owns the Shell (METH-014) or another dialog is up,
 * each with a beep and a warning in the active tab; otherwise shows the sheet. Cancel (or closing
 * the panel any other way) writes the sheet's cancel line; Run closes it and calls `onRun`.
 */
export function presentSheet(spec: SheetSpec, tabId: string, onRun: (v: SheetValues) => unknown): boolean {
  const live = liveRun();
  if (live) {
    editorFeedback.beep();
    addStatus(w.sheetBusy(spec.title, displayLabel(live.method), live.tabTitle || w.anotherTab), "warning", tabId);
    return false;
  }
  if (modalOpen()) {
    editorFeedback.beep();
    addStatus(w.sheetModal(spec.title), "warning", tabId);
    return false;
  }
  openPanel({ kind: "run", spec, tabId, onRun });
  return true;
}

/**
 * Runs Run-menu item `id` for the active tab, asking with its sheet first when it has one. A caller
 * that means one particular tab (the assistant's run tool) names it in `forTab`: nothing starts
 * unless that tab is the one in front, also after the wait for the multiclass solver lookup.
 */
export async function runMenuItemFor(id: string, forTab?: string): Promise<void> {
  const item = runItem(id);
  if (!item) return;
  const tab = activeTab();
  if (forTab !== undefined && tab.id !== forTab) return;
  const infinite = tab.document.infiniteBuffers;
  const label = item.label(infinite);
  if (id === "run:multiclass") {
    await refreshMultiClassLookup();
    if (mcMissing()) return;
    if (activeTab().id !== tab.id) return;
  }
  const spec = item.sheet?.(tab.id, infinite) ?? null;
  if (!spec) {
    await startMethod(tab.id, label);
    return;
  }
  presentSheet(spec, tab.id, async (values) => {
    if (spec.kind === "comparison" && values.remember) {
      // "Skip this dialog from now on": only now does the regime become the default (METH-117).
      try {
        await setSettings({ "runCompare.remember": true, "sim.blocking": values.blocking });
      } catch (e) {
        addStatus(w.couldNotSaveDefaults(String(e)), "warning", tab.id);
      }
    }
    await startMethod(tab.id, label, overridesFor(spec, values));
  });
}

// ── The commands ──────────────────────────────────────────────────────────────────────────────

const testWhen = (): true | string => (modalOpen() ? MODAL_REASON : sweepBusy() ? w.testSetRunning : true);

export function runCommands(): Command[] {
  const menuTitle: Record<string, string> = {
    "run:comparison": "Run Comparison", "run:monte-carlo-infinite": "Run Monte Carlo…", "run:product-form": "Run Exact Open Product Form", "run:qbd": "Run Exact Matrix-Analytic QBD",
    "run:truncated-ctmc": "Run Adaptive Truncated CTMC", "run:regenerative-infinite": "Run Regenerative Monte Carlo…", "run:spectral-infinite": "Run Spectral Method…", "run:qna": "Run Whitt QNA",
    "run:rqna": "Run Whitt–You RQNA", "run:sbd": "Run SBD", "run:mlmc": "Run SRBM MLMC", "run:lp": "Run Linear Program", "run:low-rank-bar": "Run Adaptive Low-Rank BAR",
    "run:bar-bounds": "Run BAR Moment Bounds", "run:monte-carlo-finite": "Run Monte Carlo…", "run:regenerative-finite": "Run Regenerative Monte Carlo…", "run:generic-ctmc": "Run Exact Sparse CTMC",
    "run:decomposition": "Run Finite-Buffer Decomposition", "run:spectral-finite": "Run Spectral Method…", "run:finite-element": "Run Finite Element…", "run:finite-lp": "Run Finite-Buffer LP",
    "run:multiclass": w.multiClassTitle,
    "run:closed-product-form": "Run Exact Closed Product Form",
    "run:replicated-simulation": "Run Replicated Simulation…",
    "run:priority-exact": "Run Exact Priority Queue",
    "run:batch-exact": "Run Exact Batch-Arrival Queue",
  };
  const items: Command[] = RUN_ITEMS.map((item) => ({
    id: item.id,
    title: menuTitle[item.id],
    group: "Run",
    subtitle: w.help[item.id],
    keywords: ["run", "solve", item.mode === "either" ? "compare" : item.mode === "closed" ? "closed network population mva convolution gordon newell" : item.mode === "priority" ? "priority preemptive cobham classes exact" : item.mode === "batch" ? "batch bulk arrivals compound poisson exact" : item.mode === "inprocess" ? "simulation confidence interval replications closed network infinite buffers second opinion" : `${item.mode} buffers`],
    ...(item.id === "run:multiclass" ? { dynamicTitle: () => (mcMissing() ? w.multiClassUnavailable : w.multiClassTitle) } : {}),
    when: () => runWhen(item.id),
    run: () => runMenuItemFor(item.id),
  }));
  return [
    ...items,
    {
      id: "run:stop",
      title: "Stop Run",
      group: "Run",
      subtitle: w.stopHelp,
      keywords: ["cancel", "interrupt", "abort"],
      dynamicTitle: () => {
        const live = liveRun();
        return live ? w.stopTitle(displayLabel(live.method)) : w.stopIdle;
      },
      when: () => (liveRun() ? true : w.nothingRunning),
      run: () => stopRun(),
    },
    {
      id: "test:infinite",
      title: "Run Infinite Test Set…",
      group: "Test",
      subtitle: w.help["test:infinite"],
      keywords: ["test set", "benchmark", "sweep"],
      when: testWhen,
      run: () => openPanel({ kind: "test-set", infinite: true, form: testSetDefaults(true), tabId: activeTab().id }),
    },
    {
      id: "test:finite",
      title: "Run Finite Test Set…",
      group: "Test",
      subtitle: w.help["test:finite"],
      keywords: ["test set", "benchmark", "sweep"],
      when: testWhen,
      run: () => openPanel({ kind: "test-set", infinite: false, form: testSetDefaults(false), tabId: activeTab().id }),
    },
    {
      id: "test:spectral-convergence",
      title: "Run Infinite Spectral Convergence…",
      group: "Test",
      subtitle: w.help["test:spectral-convergence"],
      keywords: ["convergence", "rho", "sweep", "spectral"],
      when: testWhen,
      run: () => openPanel({ kind: "spectral-convergence", form: spectralConvergenceDefaults(), tabId: activeTab().id }),
    },
  ];
}

/** Registers the Run and Test menus' commands for as long as the app is mounted. */
export function useRunCommands() {
  useCommands(runCommands(), []);
  useEffect(() => {
    void refreshMultiClassLookup();
    return onRunFinished(() => void refreshMultiClassLookup());
  }, []);
}

/** For tests: forget the solver lookup and any open panel. */
export function resetRunCommands() {
  mcLookup = null;
  closePanel();
}

