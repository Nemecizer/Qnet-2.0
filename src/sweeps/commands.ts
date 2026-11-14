// Run ▸ What-If Sweep… (new in 2.1, ROADMAP B4): the command, which panel is up, the panel's
// checks and its plain-words summary, "Apply this value" and Export Data.
//
// The command is registered once per page (`startSweepCommands`, started by the Results pane's
// module as it starts the agreement commands). The panel is drawn by `SweepHost`
// (./SweepPanel.tsx): mounted in App.tsx beside the other hosts, or — until it is — in a root of
// its own made on first use, so the command works either way.
import { useSyncExternalStore } from "react";
import { editorFor } from "../editor";
import { api } from "../lib/api";
import type { BnetDocument } from "../lib/bnet";
import { registerCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { parseNumber } from "../panes/inspector/distributions/numbers";
import { liveRun } from "../runs/ui/live";
import { chooseSaveTarget } from "../workspace/files/panels";
import { baseName, stem } from "../workspace/files/paths";
import { activeTab, tabById } from "../workspace/store";
import { allowed, DEFAULT_POINTS, discoverParameters, MAX_POINTS, parameterById, substitute, sweepValues, valueText, type SweepParameter } from "./model";
import { endAbandonedSweep, estimateSeconds, sweepRunning, type MethodChoice, type SweepSpec } from "./runner";
import { startSweepStore, type SweepResult } from "./store";
import { aboutTime, sweepWords as w } from "./words";

// ── Which panel is up ───────────────────────────────────────────────────────────────────────────

export interface SweepPanelRequest {
  tabId: string;
  /** A sweep whose choices the panel opens with ("Sweep Again…"). */
  from?: Pick<SweepResult, "parameter" | "from" | "to" | "values" | "methods" | "metric" | "stationId">;
}

let request: SweepPanelRequest | null = null;
const listeners = new Set<() => void>();
/** How many `SweepHost`s are mounted; with none, the first open makes one. */
export const sweepHosts = { mounted: 0, fallback: null as null | (() => void) };

function notify() {
  listeners.forEach((l) => l());
}

export function openSweepPanel(r: SweepPanelRequest) {
  request = r;
  if (!sweepHosts.mounted) sweepHosts.fallback?.();
  notify();
}

export function closeSweepPanel() {
  if (!request) return;
  request = null;
  notify();
}

export function useSweepPanelRequest(): SweepPanelRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => request,
  );
}

export const currentSweepPanel = () => request;

// ── The form ────────────────────────────────────────────────────────────────────────────────────

export interface SweepForm {
  parameterId: string;
  from: string;
  to: string;
  points: string;
  /** Run labels ticked. */
  methods: string[];
  metric: string;
  stationId: string | null;
}

/** The first thing that stops the sweep from running, or null. */
export function sweepProblem(form: SweepForm, parameter: SweepParameter | null): string | null {
  const p = w.problems;
  if (!parameter) return p.noParameter;
  const from = parseNumber(form.from);
  const to = parseNumber(form.to);
  if (from === null) return p.badFrom;
  if (to === null) return p.badTo;
  if (from === to) return p.sameEnds;
  for (const x of [from, to]) {
    if (parameter.integer && !Number.isInteger(x)) return p.whole;
    if (!allowed(parameter, x)) {
      if (parameter.max !== null && x > parameter.max) return p.aboveMax(valueText(parameter.max));
      return p.belowMin(valueText(parameter.min), parameter.kind === "arrival" || parameter.kind === "service" || parameter.kind === "load");
    }
  }
  const n = parseNumber(form.points);
  if (n === null || !Number.isInteger(n) || n < 2 || n > MAX_POINTS) return p.badPoints(MAX_POINTS);
  if (!form.methods.length) return p.noMethod;
  return null;
}

/** How many points the form asks for (a count's range may hold fewer whole numbers than Points). */
export function pointCount(form: SweepForm, parameter: SweepParameter | null): number {
  const from = parseNumber(form.from);
  const to = parseNumber(form.to);
  const n = parseNumber(form.points);
  if (!parameter || from === null || to === null || n === null) return 0;
  return sweepValues(parameter, from, to, n).length;
}

/** "12 points × 2 methods; about 3 seconds." */
export function summaryLine(form: SweepForm, parameter: SweepParameter | null, offered: readonly MethodChoice[]): string {
  const chosen = offered.filter((m) => form.methods.includes(m.label));
  const points = pointCount(form, parameter);
  // An estimate, from the medians of recorded runs; a simulation's time is its run length's, so
  // it is named rather than guessed.
  const timed = chosen.filter((m) => !m.slow);
  return w.summary(points, chosen.length, timed.length ? aboutTime(estimateSeconds(points, timed)) : null, timed.length < chosen.length);
}

/** The form as the runner takes it; null while something is wrong. */
export function specOf(form: SweepForm, parameter: SweepParameter | null, offered: readonly MethodChoice[]): SweepSpec | null {
  if (sweepProblem(form, parameter) !== null || !parameter) return null;
  return {
    parameterId: parameter.id,
    from: parseNumber(form.from)!,
    to: parseNumber(form.to)!,
    points: parseNumber(form.points)!,
    methods: offered.filter((m) => form.methods.includes(m.label)).map((m) => ({ label: m.label, name: m.name, tier: m.tier })),
    metric: form.metric,
    stationId: form.stationId,
  };
}

export const defaultPoints = (parameter: SweepParameter, from: number, to: number) => (parameter.integer ? Math.min(DEFAULT_POINTS, Math.abs(Math.round(to) - Math.round(from)) + 1) : DEFAULT_POINTS);

// ── Apply this value ────────────────────────────────────────────────────────────────────────────

/**
 * Sets the sweep's parameter to `value` in the tab's network as it is now, as ONE undo step
 * ("Undo Apply Sweep Value"), through the editor's own parameter mutations — so the canvas, the
 * inspector, the analysis and the staleness of results all follow as for any edit. Says what it
 * did in the tab's Status log. True when the network changed. Another view that applies a value
 * names its own step (`undoName`: Results ▸ Sensitivity's is "Apply Sensitivity Value").
 */
export function applySweepValue(tabId: string, parameter: SweepParameter, value: number, undoName: string = w.undoName): boolean {
  const tab = tabById(tabId);
  if (!tab) return false;
  const editor = editorFor(tabId);
  const doc: BnetDocument = tab.document;
  const now = parameterById(doc, parameter.id);
  if (!now) {
    editor.status(w.applyGone(parameter.label), "warning");
    return false;
  }
  const text = valueText(value);
  // The network was edited since the sweep and can't take this value any more: nothing is
  // applied, and the line says so — never a nearby value under the old one's name.
  if (!allowed(now, value)) {
    const above = now.max !== null && value > now.max;
    editor.status(w.applyOutOfRange(now.label, text, above ? w.problems.aboveMax(valueText(now.max!)) : now.integer && !Number.isInteger(value) ? w.problems.whole : w.problems.belowMin(valueText(now.min), now.kind === "arrival" || now.kind === "service" || now.kind === "load")), "warning");
    return false;
  }
  const next = substitute(doc, now, value);
  if (!next) {
    editor.status(w.applyGone(parameter.label), "warning");
    return false;
  }
  const changed = editor.performParameterEdit(undoName, w.applied(now.label, text), () => {
    if (next.closedPopulation !== undefined && next.closedPopulation !== doc.closedPopulation) editor.setClosedPopulation(next.closedPopulation);
    for (const after of next.nodes) {
      const before = doc.nodes.find((n) => n.id === after.id);
      if (!before || before === after) continue;
      for (const [cls, law] of Object.entries(after.serviceDistributions ?? {})) {
        const was = before.serviceDistributions?.[cls];
        if (!was || was.distribution !== law.distribution || was.distributionParameters !== law.distributionParameters) editor.updateServiceDistribution(after.id, Number(cls), law.distribution, law.distributionParameters);
      }
      if (before.distribution !== after.distribution || before.distributionParameters !== after.distributionParameters) editor.updateNodeDistribution(after.id, after.distribution, after.distributionParameters);
      if (before.numberOfServers !== after.numberOfServers) editor.updateNumberOfServers(after.id, after.numberOfServers);
      if (before.bufferSize !== after.bufferSize) editor.updateBufferSize(after.id, after.bufferSize);
    }
    for (const after of next.links) {
      const before = doc.links.find((l) => l.id === after.id);
      if (before && before.routingProbability !== after.routingProbability) editor.updateLinkProbability(after.id, after.routingProbability);
    }
  });
  if (!changed) editor.status(w.applySame(now.label, text), "info");
  return changed;
}

// ── Export Data ─────────────────────────────────────────────────────────────────────────────────

/** Export Data…: asks where, then writes `csv` through the export path every text export uses. True when written. */
export async function exportSweepCsv(tabId: string, csv: string): Promise<boolean> {
  const tab = tabById(tabId);
  const path = await chooseSaveTarget(w.csvSaveTitle, w.csvFileName(tab?.path ? stem(tab.path) : tab ? tab.title.replace(/\.bnet$/i, "") : null), [{ name: w.csvFilter, extensions: ["csv"] }]);
  if (!path) return false;
  const say = (text: string, severity?: "info" | "error") => {
    if (tabById(tabId)) editorFor(tabId).status(text, severity);
  };
  try {
    say(w.csvSaved(await api.exportSave(path, csv)));
    return true;
  } catch (e) {
    say(w.csvFailed(baseName(path), e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)), "error");
    return false;
  }
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

export const SWEEP_COMMAND = "run:what-if-sweep";

/** Why the command is dimmed now, or true. */
export function sweepWhen(): true | string {
  if (modalOpen()) return MODAL_REASON;
  const doc = activeTab().document;
  if (!doc.nodes.length) return w.noNetwork;
  if (sweepRunning() || liveRun()) return w.busy;
  if (!discoverParameters(doc).length) return w.nothingToVary;
  return true;
}

export function sweepCommands(): Command[] {
  return [
    {
      id: SWEEP_COMMAND,
      title: w.menuTitle,
      group: "Run",
      subtitle: w.commandHelp,
      keywords: ["sweep", "what if", "vary", "parameter", "range", "plot", "sensitivity", "rho", "load"],
      when: sweepWhen,
      run: () => openSweepPanel({ tabId: activeTab().id }),
    },
  ];
}

let started = false;

/** Registers the command once per page. */
export function startSweepCommands(): void {
  if (started) return;
  started = true;
  registerCommands(sweepCommands());
  // A page that went away mid-sweep (a reload) left its sweep holding the run slot: end it now
  // rather than wait for the idle limit. And forget the sweeps of tabs that no longer exist.
  void endAbandonedSweep();
  startSweepStore();
}

/** For tests: no panel up. */
export function resetSweepCommands() {
  request = null;
  notify();
}
