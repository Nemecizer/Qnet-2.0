// The commands of View ▸ Panes, Window ▸ Focus and the routed Edit ▸ Find items (ledger MENU-044…053,
// MENU-066…084, MENU-146…153, WS-014, WS-060, WS-062, KEY-001). The menu bar, the palette, the top
// bar's Workspace menu and toggles, and the keys all run these by id. Tooltips (0.90.34's `.help`)
// are each command's `subtitle`, a getter where the words follow state (MENU-203).
import { useEffect } from "react";
import { registerCommands, runCommand, getCommand, type Command } from "../../lib/commands";
import { setSettings } from "../../lib/kv";
import type { KvValues } from "../../lib/types";
import { MODAL_REASON, modalOpen } from "../../lib/overlays";
import { raiseAuxWindow } from "../../lib/auxWindow";
import { focusTarget, focusedPane, handlersFor, type PaneHandlers, type PaneId } from "../focus";
import { splitHandle } from "../layout/live";
import { refreshFocus } from "./focusState";
import { placedHost } from "./hosts";
import {
  applyPreset, DETACHABLE, detachedPanes, everyPaneIsHome, isDetached, isPaneEnabled, maximizeTarget, PRESETS, RESULTS_ROW_FRACTION,
  SHELL_ROW_FRACTION, showAllPatch, SOLO_KEY, soloedPane, setDetached, SWITCHABLE, toggleMaximizePatch, togglePane, visibilityPatch,
  type PresetId, type WindowMetrics,
} from "./model";
import { PANE_NAME, paneWords } from "./words";

const G = "View";
const notModal = () => (modalOpen() ? MODAL_REASON : true);

/** Reduce Motion: Qnet's own setting on <html>, else the system's (DS.Motion.standardSettleDelay). */
export function reduceMotion(): boolean {
  const m = document.documentElement.getAttribute("data-motion");
  if (m) return m === "reduce";
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** WorkspaceCommands `afterLayout`: the show animation's settle delay plus 0.05 s. */
export const afterLayoutDelay = () => (reduceMotion() ? 0 : 250) + 50;

/** Puts the caret where Window ▸ Focus <pane> should: the pane's own handler, else its default field. */
export function focusPane(p: PaneId) {
  if (isDetached(p)) raiseAuxWindow(`pane-${p}`);
  const h = handlersFor(p);
  if (h?.focus) h.focus();
  else {
    const root = placedHost(p);
    const el =
      root?.querySelector<HTMLElement>("[data-focus-default]") ??
      root?.querySelector<HTMLElement>("[data-pane][tabindex]") ??
      root?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    el?.focus();
  }
  refreshFocus();
}

/**
 * WorkspaceCommands `reveal(_:)` (WS-062, MENU-153): make the pane really visible (its toggle on,
 * another pane's maximize ended, or its window brought forward), then run `action`: after the layout
 * settles when something moved, on the next turn when nothing did. A detached pane's window coming
 * forward does not end a maximize in the main window.
 */
export async function reveal(p: PaneId, action: () => void = () => focusPane(p)): Promise<void> {
  if (isDetached(p)) {
    if (isPaneEnabled(p)) {
      setTimeout(action, 0);
      return;
    }
    await setSettings(visibilityPatch({ [p]: true }));
    setTimeout(action, afterLayoutDelay());
    return;
  }
  const solo = soloedPane();
  const enabled = isPaneEnabled(p);
  if (enabled && !(solo && solo !== p)) {
    setTimeout(action, 0);
    return;
  }
  const patch: KvValues = enabled ? {} : visibilityPatch({ [p]: true });
  if (solo && solo !== p) patch[SOLO_KEY] = "";
  await setSettings(patch);
  setTimeout(action, afterLayoutDelay());
}

/** What the window and the outer split measure now, for the presets that size a row. */
function windowMetrics(): WindowMetrics | null {
  const outer = splitHandle("OuterVSplit");
  const workspaceHeight = outer?.total() ?? 0;
  return workspaceHeight > 1 ? { windowHeight: window.innerHeight, workspaceHeight } : null;
}

// --- Find routing (QnetCommands.swift findTarget)

const FIND_PANES: PaneId[] = ["shell", "status", "results", "ai"];

/** Which handlers ⌘F, ⌘G and ⇧⌘G reach now, and under what name. */
export function findRoute(): { id: string; h: PaneHandlers | undefined } {
  const t = focusTarget();
  if (t?.kind === "window") {
    const pane = /^pane-(.+)$/.exec(t.name)?.[1] as PaneId | undefined;
    if (pane && FIND_PANES.includes(pane)) return { id: pane, h: handlersFor(pane) };
    return { id: t.name, h: handlersFor(`window:${t.name}`) };
  }
  if (t?.kind === "pane" && FIND_PANES.includes(t.id)) {
    const h = handlersFor(t.id);
    if (h?.find) return { id: t.id, h };
  }
  return { id: "canvas", h: handlersFor("canvas") };
}

function findTitle(): string {
  const { id, h } = findRoute();
  return h?.findTitle ?? (id === "canvas" ? paneWords.findNode : "Find…");
}

function canStep(h: PaneHandlers | undefined): boolean {
  return !!h?.stepFind && (h.canStepFind?.() ?? true);
}

function stepHelp(): string {
  const { id, h } = findRoute();
  const pair = paneWords.findStepHelp[id];
  if (pair) return canStep(h) ? pair[0] : pair[1];
  return paneWords.findStepDefault;
}

// --- Pane text size (FocusRouter.zoom / canZoom / zoomTargetName)

function zoomTarget(): { pane: PaneId; h: PaneHandlers } | null {
  const t = focusTarget();
  if (t?.kind !== "pane") return null;
  const h = handlersFor(t.id);
  return h?.zoom ? { pane: t.id, h } : null;
}

function canZoom(d: 1 | -1): boolean {
  const z = zoomTarget();
  return !!z && (z.h.canZoom?.(d) ?? true);
}

function textSizeHelp(d: 1 | -1): string {
  const verb = d > 0 ? "Increase" : "Decrease";
  const z = zoomTarget();
  if (!z) return paneWords.textSizeNoTarget(verb);
  if (!canZoom(d)) return paneWords.textSizeLimit(PANE_NAME[z.pane], d > 0);
  return paneWords.textSizeHelp(verb, PANE_NAME[z.pane]);
}

const PRESET_TITLE: Record<PresetId, string> = {
  build: paneWords.presetBuild,
  analyze: paneWords.presetAnalyze,
  run: paneWords.presetRun,
  shell: paneWords.presetShell,
  canvas: paneWords.presetCanvas,
};
const PRESET_HELP: Record<PresetId, string> = {
  build: paneWords.presetBuildHelp,
  analyze: paneWords.presetAnalyzeHelp(RESULTS_ROW_FRACTION),
  run: paneWords.presetRunHelp,
  shell: paneWords.presetShellHelp(SHELL_ROW_FRACTION),
  canvas: paneWords.presetCanvasHelp,
};

/** Every command of the pane layout. */
export function paneCommands(): Command[] {
  const cmds: Command[] = [];
  for (const p of SWITCHABLE) {
    cmds.push({
      id: `view:pane-${p}`,
      title: PANE_NAME[p],
      group: G,
      keywords: ["pane", "show", "hide", "toggle"],
      checked: () => isPaneEnabled(p),
      get subtitle() {
        return paneWords.paneToggleHelp(PANE_NAME[p], isPaneEnabled(p));
      },
      run: () => togglePane(p),
    });
  }
  for (const preset of PRESETS) {
    cmds.push({
      id: `view:preset-${preset.id}`,
      title: PRESET_TITLE[preset.id],
      group: G,
      keywords: ["workspace", "preset", "layout", "arrangement"],
      subtitle: PRESET_HELP[preset.id],
      run: () => applyPreset(preset.id, windowMetrics()),
    });
  }
  for (const p of DETACHABLE) {
    cmds.push({
      id: `view:detach-${p}`,
      title: PANE_NAME[p],
      group: G,
      keywords: ["separate window", "detach", "window", "pop out"],
      checked: () => isDetached(p),
      get subtitle() {
        return paneWords.detachHelp(PANE_NAME[p], isDetached(p));
      },
      run: () => setDetached(p, !isDetached(p)),
    });
  }
  cmds.push(
    {
      id: "view:reattach-all",
      title: paneWords.returnAll,
      group: G,
      keywords: ["separate windows", "reattach", "dock"],
      when: () => (detachedPanes().size ? true : paneWords.returnAllNone),
      get subtitle() {
        return detachedPanes().size ? paneWords.returnAllHelp : paneWords.returnAllNone;
      },
      run: () => setSettings({ "panes.detached": "" }),
    },
    {
      id: "view:maximize-pane",
      title: paneWords.maximize,
      group: G,
      keywords: ["solo", "zoom pane", "full window"],
      dynamicTitle: () => (soloedPane() ? paneWords.restore : paneWords.maximize),
      when: notModal,
      get subtitle() {
        const solo = soloedPane();
        return solo ? paneWords.restoreHelp(PANE_NAME[solo]) : paneWords.maximizeHelp(PANE_NAME[maximizeTarget(focusedPane())]);
      },
      run: () => {
        const patch = toggleMaximizePatch(focusedPane());
        return patch ? setSettings(patch) : undefined;
      },
    },
    {
      id: "view:show-all-panes",
      title: paneWords.showAll,
      group: G,
      keywords: ["panes", "reset layout"],
      when: () => (everyPaneIsHome() ? paneWords.showAllHome : true),
      get subtitle() {
        return everyPaneIsHome() ? paneWords.showAllHome : paneWords.showAllHelp;
      },
      run: () => setSettings(showAllPatch()),
    },
    {
      id: "view:pane-text-bigger",
      title: "Increase Pane Text Size",
      group: G,
      when: () => (canZoom(1) ? true : textSizeHelp(1)),
      get subtitle() {
        return textSizeHelp(1);
      },
      run: () => zoomTarget()?.h.zoom?.(1),
    },
    {
      id: "view:pane-text-smaller",
      title: "Decrease Pane Text Size",
      group: G,
      when: () => (canZoom(-1) ? true : textSizeHelp(-1)),
      get subtitle() {
        return textSizeHelp(-1);
      },
      run: () => zoomTarget()?.h.zoom?.(-1),
    },
  );
  const FOCUS: [PaneId, string][] = [
    ["canvas", "Focus Canvas"], ["tools", "Focus Tools"], ["status", "Focus Status"], ["shell", "Focus Shell"],
    ["ai", "Focus AI Input"], ["inspector", "Focus Inspector"], ["results", "Focus Results"],
  ];
  for (const [p, title] of FOCUS) {
    cmds.push({ id: `window:focus-${p}`, title, group: "Window", keywords: ["focus", "pane"], when: notModal, subtitle: paneWords.focusHelp[p], run: () => reveal(p) });
  }
  cmds.push(
    {
      id: "edit:find",
      title: "Find…",
      group: "Edit",
      keywords: ["search"],
      dynamicTitle: findTitle,
      when: () => (findRoute().h?.find ? true : paneWords.noFindHere),
      get subtitle() {
        return paneWords.findHelp[findRoute().id] ?? paneWords.findHelp.canvas;
      },
      run: () => findRoute().h?.find?.(),
    },
    {
      id: "edit:find-next",
      title: "Find Next",
      group: "Edit",
      when: () => (canStep(findRoute().h) ? true : stepHelp()),
      get subtitle() {
        return stepHelp();
      },
      run: () => findRoute().h?.stepFind?.(1),
    },
    {
      id: "edit:find-previous",
      title: "Find Previous",
      group: "Edit",
      when: () => (canStep(findRoute().h) ? true : stepHelp()),
      get subtitle() {
        return stepHelp();
      },
      run: () => findRoute().h?.stepFind?.(-1),
    },
  );
  return cmds;
}

/** ⌃` focuses the Shell (MenuKeyAliases, KEY-001): Control only, the backtick key, main window. */
export function isShellAlias(e: Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.key === "`");
}

/** Registers the commands and the ⌃` alias for as long as the app is mounted. */
export function usePaneCommandsImpl() {
  useEffect(() => registerCommands(paneCommands()), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isShellAlias(e) || !getCommand("window:focus-shell")) return;
      e.preventDefault();
      void runCommand("window:focus-shell");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
