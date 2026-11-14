// The canvas's menu commands (ids as src/lib/menuSpec.ts names them; 0.90.34 QnetCommands.swift
// `viewMenu`, `toolsMenu`, `findTarget`): View ▸ Zoom In / Zoom Out (routed to the focused pane's
// text size first, `FocusRouter.zoom`), Actual Size, Zoom to Fit, Zoom to Selection, Snap to Grid;
// the eight Tools items (checked = the current tool); and Find Node… as the canvas's ⌘F (P4's
// `edit:find` routes through `registerFocusTarget('canvas', …)`).
//
// The bare tool letters (V M H S B O X L) can't be native key equivalents without stealing them
// from every text field (src/lib/menuSpec.ts's header), which is what 0.90.34's ToolShortcutGuard
// existed to undo. So the page handles them: one keydown listener on the main window switches the
// tool unless a text field (the Shell's included) has the keyboard, a dialog is up, or a menu or
// another control already used the key. The Tools menu therefore shows no letters; the palette's
// keycaps and tooltips do (ledger MENU-101, KEY-003).
import { useEffect } from "react";
import { activeEditor, TOOLS } from "../editor";
import { activeTab, useWorkspace } from "../workspace/store";
import { focusedTextField } from "../editor/commands";
import { registerCommands, type Command } from "../lib/commands";
import { focusedAuxWindow } from "../lib/auxWindow";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { focusedPane, focusTarget, handlersFor, registerFocusTarget } from "../workspace/focus";
import { paneWords } from "../workspace/panes/words";
import { openFindNode } from "./interaction/FindNodePanel";
import { TOOL_COMMAND, toolForKey } from "./interaction/tools";
import { interactionWords as w } from "./interaction/words";


/** `FocusRouter.zoom`: the focused pane's text size when it has a zoom handler, else the canvas. */
function routedZoom(d: 1 | -1, canvas: () => void) {
  const t = focusTarget();
  const h = t?.kind === "pane" ? handlersFor(t.id) : undefined;
  if (h?.zoom) h.zoom(d);
  else canvas();
}

/** `canvasCommandsActive`: the main window is key and no sheet is up. */
function canvasActive(): true | string {
  if (modalOpen()) return MODAL_REASON;
  if (focusedAuxWindow()) return w.canvasNotKey;
  return true;
}

export function canvasCommands(): Command[] {
  const e = () => activeEditor();
  const cmds: Command[] = [
    { id: "view:zoom-in", title: "Zoom In", group: "View", keywords: ["magnify", "bigger"], subtitle: w.zoomInHelp, run: () => routedZoom(1, () => e().zoomIn()) },
    { id: "view:zoom-out", title: "Zoom Out", group: "View", keywords: ["smaller"], subtitle: w.zoomOutHelp, run: () => routedZoom(-1, () => e().zoomOut()) },
    { id: "view:actual-size", title: "Actual Size", group: "View", keywords: ["100%", "reset zoom"], subtitle: w.actualSizeHelp, run: () => e().resetZoom() },
    {
      id: "view:zoom-to-fit",
      title: "Zoom to Fit",
      group: "View",
      keywords: ["frame", "fit"],
      subtitle: w.zoomToFitHelp,
      when: () => (e().nodes.length ? true : w.noNodes),
      run: () => e().zoomToFit(),
    },
    {
      id: "view:zoom-to-selection",
      title: "Zoom to Selection",
      group: "View",
      keywords: ["frame"],
      subtitle: w.zoomToSelectionHelp,
      when: () => (e().canZoomToSelection ? true : w.noNodeSelection),
      run: () => e().zoomToFitSelection(),
    },
    { id: "view:snap-to-grid", title: "Snap to Grid", group: "View", keywords: ["grid"], subtitle: w.snapHelp, checked: () => e().view.snapToGrid, run: () => e().setSnapToGrid(!e().view.snapToGrid) },
  ];
  for (const t of TOOLS) {
    cmds.push({
      id: TOOL_COMMAND[t],
      title: w.menuTitle[t],
      group: "Tools",
      keywords: ["tool", w.paletteLabel[t]],
      subtitle: w.menuHelp(w.helpText[t]),
      checked: () => e().view.tool === t,
      when: canvasActive,
      run: () => e().setTool(t),
    });
  }
  return cmds;
}

/** Should a bare keystroke switch the tool? Not in a text field, the Shell, a dialog, a menu, or with a modifier. */
export function toolKeyTarget(ev: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "defaultPrevented" | "target">) {
  if (ev.defaultPrevented || ev.isComposing || ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  const tool = toolForKey(ev.key);
  if (!tool) return null;
  if (focusedTextField() || modalOpen() || focusedPane() === "shell") return null;
  const el = ev.target instanceof Element ? ev.target : null;
  if (el?.closest("[role=menu], [role=listbox], [role=combobox], select, [contenteditable]")) return null;
  return tool;
}

/** Registers the canvas's commands, its Find handler and the tool letters while the pane is mounted. */
export function useCanvasCommands() {
  useEffect(() => registerCommands(canvasCommands()), []);
  const hasNodes = useWorkspace((ws) => activeTab(ws).document.nodes.length > 0);
  // ⌘F is "Find Node…" whenever the canvas is the target; enabled only with nodes to find.
  useEffect(() => registerFocusTarget("canvas", { findTitle: paneWords.findNode, find: hasNodes ? openFindNode : undefined }), [hasNodes]);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tool = toolKeyTarget(ev);
      if (!tool) return;
      ev.preventDefault();
      activeEditor().setTool(tool);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
