// Which panes are on, maximized and detached: AppSettings.swift's pane flags, `soloedPane`,
// `detachedPanes`, and ContentView's `shows(_:)` (ledger WS-050…054, WS-060, WS-073…084,
// WS-086…096). The flags are settings under 0.90.34's keys; every write goes through
// `setSettings`, one patch per user action, so Rust validates it and every window sees it.
import { getSetting, setSettings, setStateValues } from "../../lib/kv";
import type { KvValues } from "../../lib/types";
import type { PaneId } from "../focus";
import { presetRowHeight, paneKey } from "../layout/sizes";

/** The six switchable panes, in View ▸ Panes order (WS-050). */
export const SWITCHABLE: PaneId[] = ["tools", "status", "shell", "ai", "inspector", "results"];

/** FocusRouter.Pane.allCases order: the order `panes.detached` is written in. */
export const ALL_CASES: PaneId[] = ["tools", "canvas", "status", "results", "shell", "ai", "inspector"];

/** The panes that can have a window of their own (WS-086), in the menu's order. */
export const DETACHABLE: PaneId[] = ["status", "results", "shell", "ai", "inspector"];

/** 0.90.34's raw names (FocusRouter.Pane rawValue): the Tools pane is "palette". */
export const RAW: Record<PaneId, string> = { tools: "palette", canvas: "canvas", status: "status", results: "results", shell: "shell", ai: "ai", inspector: "inspector" };
const FROM_RAW: Record<string, PaneId> = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [v, k as PaneId]));

/** The visibility keys (WS-052) and their fresh-install defaults (WS-051). */
export const VISIBLE_KEY: Record<Exclude<PaneId, "canvas">, string> = {
  tools: "palette.paneVisible",
  status: "status.paneVisible",
  inspector: "inspector.paneVisible",
  results: "results.paneVisible",
  shell: "shell.paneVisible",
  ai: "ai.paneVisible",
};
export const VISIBLE_DEFAULT: Record<Exclude<PaneId, "canvas">, boolean> = { tools: true, status: true, inspector: true, results: false, shell: true, ai: false };

export const SOLO_KEY = "panes.soloed";
export const DETACHED_KEY = "panes.detached";

export const canBeMaximized = (p: PaneId) => p !== "tools";
export const canBeDetached = (p: PaneId) => p !== "canvas" && p !== "tools";

/** A snapshot of the pane settings, so the rules can be tested as pure functions. */
export type Vals = (key: string, fallback: unknown) => unknown;
const live: Vals = (k, f) => getSetting(k, f);

export function isPaneEnabled(p: PaneId, v: Vals = live): boolean {
  if (p === "canvas") return true;
  return v(VISIBLE_KEY[p], VISIBLE_DEFAULT[p]) === true;
}

/** `panes.detached`: known, detachable names only (WS-096). */
export function parseDetached(raw: unknown): Set<PaneId> {
  const out = new Set<PaneId>();
  if (typeof raw !== "string") return out;
  for (const part of raw.split(",")) {
    const p = FROM_RAW[part];
    if (p && canBeDetached(p)) out.add(p);
  }
  return out;
}

/** The canonical spelling: allCases order, no duplicates, no unknown names. */
export function serializeDetached(panes: Iterable<PaneId>): string {
  const set = new Set(panes);
  return ALL_CASES.filter((p) => set.has(p) && canBeDetached(p)).map((p) => RAW[p]).join(",");
}

export function detachedPanes(v: Vals = live): Set<PaneId> {
  return parseDetached(v(DETACHED_KEY, ""));
}

export function isDetached(p: PaneId, v: Vals = live): boolean {
  return detachedPanes(v).has(p);
}

/** The maximized pane, sanitized (WS-084): unknown, Tools, switched off or detached reads as none. */
export function soloedPane(v: Vals = live): PaneId | null {
  const p = FROM_RAW[String(v(SOLO_KEY, ""))];
  if (!p || !canBeMaximized(p) || !isPaneEnabled(p, v) || isDetached(p, v)) return null;
  return p;
}

export function hasStoredSolo(v: Vals = live): boolean {
  return String(v(SOLO_KEY, "")) !== "";
}

/** ContentView `shows(_:)`: drawn in the main window right now. */
export function shows(p: PaneId, v: Vals = live): boolean {
  if (isDetached(p, v)) return false;
  const solo = soloedPane(v);
  if (solo) return solo === p;
  return isPaneEnabled(p, v);
}

/** The panes that should have a window of their own now: detached and switched on (WS-094). */
export function detachedWindows(v: Vals = live): PaneId[] {
  const d = detachedPanes(v);
  return DETACHABLE.filter((p) => d.has(p) && isPaneEnabled(p, v));
}

/** Every pane showing, in this window (WS-060). */
export function everyPaneIsHome(v: Vals = live): boolean {
  return SWITCHABLE.every((p) => isPaneEnabled(p, v)) && detachedPanes(v).size === 0;
}

/** The arrangement ContentView derives from `shows` (WS-053, WS-054). */
export interface Arrangement {
  shown: Record<PaneId, boolean>;
  outer: string[];
  top: string[];
  right: string[];
  bottom: string[];
}

export function arrangement(v: Vals = live): Arrangement {
  const shown = Object.fromEntries(ALL_CASES.map((p) => [p, shows(p, v)])) as Record<PaneId, boolean>;
  const rightColumn = shown.status || shown.inspector;
  const topRow = shown.tools || shown.canvas || rightColumn;
  const bottomRow = shown.shell || shown.ai;
  return {
    shown,
    outer: [topRow && "top", shown.results && "results", bottomRow && "bottom"].filter(Boolean) as string[],
    top: [shown.tools && "palette", shown.canvas && "canvas", rightColumn && "right"].filter(Boolean) as string[],
    right: [shown.inspector && "inspector", shown.status && "status"].filter(Boolean) as string[],
    bottom: [shown.shell && "terminal", shown.ai && "ai"].filter(Boolean) as string[],
  };
}

// --- The writes. Each builds one patch (pure, for the tests) and sends it.

/**
 * Showing or hiding a pane. Any change of a pane toggle ends a stored maximize (MENU-072, WS-083),
 * so the patch carries `panes.soloed = ""` whenever a flag actually changes.
 */
export function visibilityPatch(next: Partial<Record<PaneId, boolean>>, v: Vals = live): KvValues {
  const patch: KvValues = {};
  let changed = false;
  for (const [p, on] of Object.entries(next) as [PaneId, boolean][]) {
    if (p === "canvas") continue;
    patch[VISIBLE_KEY[p]] = on;
    if (isPaneEnabled(p, v) !== on) changed = true;
  }
  if (changed && hasStoredSolo(v)) patch[SOLO_KEY] = "";
  return patch;
}

export function setPaneEnabled(p: PaneId, on: boolean): Promise<unknown> {
  return setSettings(visibilityPatch({ [p]: on }));
}

export function togglePane(p: PaneId): Promise<unknown> {
  return setPaneEnabled(p, !isPaneEnabled(p));
}

/** AppSettings `toggleSolo`: maximize, or restore when it already has the window (WS-083). */
export function soloPatch(p: PaneId, v: Vals = live): KvValues | null {
  if (!canBeMaximized(p) || !isPaneEnabled(p, v) || isDetached(p, v)) return null;
  return { [SOLO_KEY]: soloedPane(v) === p ? "" : RAW[p] };
}

export function toggleSolo(p: PaneId): Promise<unknown> {
  const patch = soloPatch(p);
  return patch ? setSettings(patch) : Promise.resolve();
}

/**
 * WorkspaceCommands `maximizeTarget` (WS-081): the maximized pane, else the focused pane, else the
 * canvas; Tools and a detached pane are never the target.
 */
export function maximizeTarget(focused: PaneId | null, v: Vals = live): PaneId {
  const solo = soloedPane(v);
  if (solo) return solo;
  if (!focused || !canBeMaximized(focused) || isDetached(focused, v)) return "canvas";
  return focused;
}

/** View ▸ Panes ▸ Maximize Pane / Restore Pane Layout (MENU-081). */
export function toggleMaximizePatch(focused: PaneId | null, v: Vals = live): KvValues | null {
  if (soloedPane(v)) return { [SOLO_KEY]: "" };
  return soloPatch(maximizeTarget(focused, v), v);
}

/**
 * Detaching also switches the pane on and ends its own maximize; reattaching only docks it
 * (WS-088, AppSettings `setDetached`). Switching it on counts as a pane toggle (MENU-072).
 */
export function detachPatch(p: PaneId, detached: boolean, v: Vals = live): KvValues | null {
  if (!canBeDetached(p)) return null;
  const set = detachedPanes(v);
  const patch: KvValues = detached ? visibilityPatch({ [p]: true }, v) : {};
  if (detached) set.add(p);
  else set.delete(p);
  patch[DETACHED_KEY] = serializeDetached(set);
  if (detached && String(v(SOLO_KEY, "")) === RAW[p]) patch[SOLO_KEY] = "";
  return patch;
}

export function setDetached(p: PaneId, detached: boolean): Promise<unknown> {
  const patch = detachPatch(p, detached);
  return patch ? setSettings(patch) : Promise.resolve();
}

export function reattachAll(): Promise<unknown> {
  return setSettings({ [DETACHED_KEY]: "" });
}

/** Show All Panes (WS-060): nothing hidden, nothing maximized, nothing in a window of its own. */
export function showAllPatch(): KvValues {
  const patch: KvValues = { [SOLO_KEY]: "", [DETACHED_KEY]: "" };
  for (const p of SWITCHABLE) patch[VISIBLE_KEY[p as Exclude<PaneId, "canvas">]] = true;
  return patch;
}

// --- Workspace presets (WS-073…079)

export type PresetId = "build" | "analyze" | "run" | "shell" | "canvas";

export const SHELL_ROW_FRACTION = 0.45;
export const RESULTS_ROW_FRACTION = 0.5;

export interface Preset {
  id: PresetId;
  show: Record<Exclude<PaneId, "canvas">, boolean>;
  /** A row of the outer split and its share of the window's height. */
  row?: ["results" | "bottom", number];
}

const P = (tools: boolean, status: boolean, inspector: boolean, results: boolean, shell: boolean, ai: boolean) => ({ tools, status, inspector, results, shell, ai });

export const PRESETS: Preset[] = [
  { id: "build", show: P(true, true, true, false, false, false) },
  { id: "analyze", show: P(false, true, true, true, false, false), row: ["results", RESULTS_ROW_FRACTION] },
  { id: "run", show: P(false, true, false, true, true, false) },
  { id: "shell", show: P(false, true, false, false, true, false), row: ["bottom", SHELL_ROW_FRACTION] },
  { id: "canvas", show: P(false, false, false, false, false, false) },
];

/** The settings a preset writes: every toggle, no maximize, nothing detached. */
export function presetPatch(preset: Preset): KvValues {
  const patch: KvValues = { [SOLO_KEY]: "", [DETACHED_KEY]: "" };
  for (const [p, on] of Object.entries(preset.show)) patch[VISIBLE_KEY[p as Exclude<PaneId, "canvas">]] = on;
  return patch;
}

/** What the preset needs to know about the window to size its row (measured by the layout). */
export interface WindowMetrics {
  windowHeight: number;
  workspaceHeight: number;
}

/**
 * Applies a preset (WorkspaceCommands `applyWorkspacePreset`). A preset with a proportion writes
 * its row height first, as points under `SplitPane.OuterVSplit.<row>`; the layout reads the key
 * whether or not the pane set changes, so re-applying a preset re-applies its size.
 */
export async function applyPreset(id: PresetId, metrics: WindowMetrics | null): Promise<void> {
  const preset = PRESETS.find((p) => p.id === id)!;
  if (preset.row && metrics) {
    const h = presetRowHeight(metrics.windowHeight, metrics.workspaceHeight, preset.row[1]);
    if (h !== null) await setStateValues({ [paneKey("OuterVSplit", preset.row[0])]: h });
  }
  await setSettings(presetPatch(preset));
}
