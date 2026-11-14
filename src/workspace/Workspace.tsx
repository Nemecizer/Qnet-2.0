// The main window's panes (decision D2: Qnet's own layout), ContentView.swift's one stable split
// tree: a top row of Tools | Canvas | (Inspector over Status), a full-width Results row, and a bottom
// row of Shell | AI Assistant, with splitters, corner grips, presets, maximise and detached panes
// (ledger 5.4–5.8, View ▸ Panes, Window ▸ Focus). The rules live in src/workspace/panes/ (which pane
// is where) and src/workspace/layout/ (sizes and dividers); this file puts them together.
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasPane } from "../canvas/CanvasPane";
import { StatusPane } from "../panes/status";
import { inTauri } from "../lib/api";
import { getStateValue, loadKv, setSettings, setStateValues, useSetting, useStateValue } from "../lib/kv";
import type { PaneId } from "./focus";
import { CornerGrip } from "./layout/CornerGrip";
import { liveState, splitHandle, useLiveVersion } from "./layout/live";
import { aiPaneWidth, contentMinHeight, extentOf, L, legacyKey, migrationPatch, mirrorPatch, paneKey, SPLITS, type Extent, type Shown, type SplitName } from "./layout/sizes";
import { Split, type SplitItem } from "./layout/Split";
import { usePaneCommandsImpl } from "./panes/commands";
import { refreshFocus, trackFocusIn } from "./panes/focusState";
import { DetachedPaneWindow, markLayoutSettled, PanePortals, PaneSlot } from "./panes/hosts";
import { ALL_CASES, arrangement, detachedWindows, hasStoredSolo, isPaneEnabled, SOLO_KEY, soloedPane, SWITCHABLE } from "./panes/model";
import { AIPane, InspectorPane, ResultsPane, ShellPane, ToolsPane } from "./panes/Placeholders";
import { WorkspaceToolbarImpl } from "./panes/Toolbar";
import "./panes/panes.css";

const SIZE_KEYS = Object.values(SPLITS).flatMap((d) => [...d.canonical.map((p) => paneKey(d.name, p)), legacyKey(d.name)]);

/** The extents of every pane of `split` (DS.Layout, with the two state-dependent ideals). */
function extents(split: SplitName, shown: Shown, aiWidth: number): Record<string, Extent> {
  return Object.fromEntries(SPLITS[split].canonical.map((p) => [p, extentOf(split, p, shown, aiWidth)]));
}

/** The coupled widths (WS-067): the right column and the AI pane follow each other. */
function follower(source: "TopHSplit" | "BottomHSplit", top: string[], bottom: string[]) {
  return (panes: string[], sizes: number[]) => {
    const other = splitHandle(source === "TopHSplit" ? "BottomHSplit" : "TopHSplit");
    if (!other) return null;
    const os = other.sizes();
    return mirrorPatch(source, sizes[panes.length - 1], top, bottom, os[os.length - 1] ?? 0, other.total());
  };
}

export function Workspace() {
  useSetting(SOLO_KEY, "");
  useStateValue(paneKey("BottomHSplit", "ai"), null);
  useLiveVersion();
  const [ready, setReady] = useState(false);
  const a = arrangement();
  const layoutRef = useRef<HTMLDivElement>(null);

  // Focus follows the keyboard in this window (the detached windows add their own).
  useEffect(() => {
    refreshFocus();
    return trackFocusIn(window);
  }, []);

  // After the stores load: the one-time split-key repairs, then fades and watchers start.
  useEffect(() => {
    let alive = true;
    loadKv()
      .catch(() => {})
      .then(async () => {
        if (!alive) return;
        const state = Object.fromEntries(
          [...SIZE_KEYS, "SplitPane.TopHSplit.status", "migration.bottomHSplit.2026-04-24"].map((k) => [k, getStateValue<unknown>(k, undefined)]).filter(([, v]) => v !== undefined),
        );
        const patch = migrationPatch(state);
        if (Object.keys(patch).length) await setStateValues(patch).catch(() => {});
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const id = requestAnimationFrame(markLayoutSettled);
    return () => cancelAnimationFrame(id);
  }, [ready]);

  // Showing or hiding any pane, from anywhere (an import, another window), ends a stored maximize
  // (MENU-072). The commands already clear it in the same write; this catches the rest.
  const signature = SWITCHABLE.map((p) => (isPaneEnabled(p) ? "1" : "0")).join("");
  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (lastSignature.current !== null && lastSignature.current !== signature && hasStoredSolo()) void setSettings({ [SOLO_KEY]: "" }).catch(() => {});
    lastSignature.current = signature;
  }, [ready, signature]);

  // The window's minimum size follows the rows shown (WS-002).
  const outerKey = a.outer.join(",");
  useEffect(() => {
    if (!inTauri) return;
    const chrome = layoutRef.current ? Math.max(0, window.innerHeight - layoutRef.current.getBoundingClientRect().height) : 0;
    const height = contentMinHeight(a.outer) + (chrome > 0 ? chrome : 62);
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow, LogicalSize }) => getCurrentWindow().setMinSize(new LogicalSize(L.mainMinWidth, height)))
      .catch(() => {});
  }, [outerKey]);

  // The canvas, and the Shell once it has been shown, stay mounted while hidden (WS-056); a pane
  // that is on stays mounted while another has the whole window (a maximize hides nothing, WS-080).
  const shellSeen = useRef(false);
  const wanted = ready ? detachedWindows() : [];
  if (a.shown.shell || wanted.includes("shell")) shellSeen.current = true;
  const solo = soloedPane();
  const mounted = ALL_CASES.filter((p) => p === "canvas" || a.shown[p] || wanted.includes(p) || (solo !== null && isPaneEnabled(p)) || (p === "shell" && shellSeen.current));

  // Windows remembered from last time reopen without taking focus from this one (WS-096).
  const atLaunch = useRef<Set<PaneId> | null>(null);
  if (ready && atLaunch.current === null) atLaunch.current = new Set(wanted);

  const bodies = useMemo(
    () => ({
      canvas: <CanvasPane />,
      tools: <ToolsPane />,
      status: <StatusPane />,
      inspector: <InspectorPane />,
      results: <ResultsPane />,
      shell: <ShellPane />,
      ai: <AIPane />,
    }),
    [],
  );

  const shown = { ...a.shown, palette: a.shown.tools } as Shown;
  const aiWidth = aiPaneWidth(liveState([paneKey("BottomHSplit", "ai"), legacyKey("BottomHSplit")]));
  const slot = (id: string, pane: PaneId): SplitItem => ({ id, node: <PaneSlot pane={pane} /> });
  const twoRows = a.outer.length >= 2;

  const right: SplitItem[] = [];
  if (a.shown.inspector) right.push(slot("inspector", "inspector"));
  if (a.shown.status) right.push(slot("status", "status"));

  const top: SplitItem[] = [];
  if (a.shown.tools) top.push(slot("palette", "tools"));
  if (a.shown.canvas) top.push(slot("canvas", "canvas"));
  if (right.length) top.push({ id: "right", node: <Split name="RightVSplit" items={right} extents={extents("RightVSplit", shown, aiWidth)} /> });

  const bottom: SplitItem[] = [];
  if (a.shown.shell) bottom.push(slot("terminal", "shell"));
  if (a.shown.ai) bottom.push(slot("ai", "ai"));

  const outer: SplitItem[] = [];
  if (top.length) {
    const grips = twoRows && top.length >= 3
      ? {
          0: <CornerGrip id="top.palette.canvas" hSplit="TopHSplit" hIndex={0} outerIndex={0} at="end" />,
          1: <CornerGrip id="top.canvas.status" hSplit="TopHSplit" hIndex={1} outerIndex={0} at="end" />,
        }
      : undefined;
    outer.push({ id: "top", node: <Split name="TopHSplit" items={top} extents={extents("TopHSplit", shown, aiWidth)} follow={follower("TopHSplit", a.top, a.bottom)} onDivider={grips} /> });
  }
  if (a.shown.results) outer.push(slot("results", "results"));
  if (bottom.length) {
    const grip = twoRows && bottom.length === 2 ? { 0: <CornerGrip id="bottom.terminal.ai" hSplit="BottomHSplit" hIndex={0} outerIndex={a.outer.length - 2} at="start" /> } : undefined;
    outer.push({ id: "bottom", node: <Split name="BottomHSplit" items={bottom} extents={extents("BottomHSplit", shown, aiWidth)} follow={follower("BottomHSplit", a.top, a.bottom)} onDivider={grip} /> });
  }

  return (
    <div ref={layoutRef} className="pane-layout" style={{ minWidth: L.mainMinWidth, minHeight: contentMinHeight(a.outer) }}>
      <Split name="OuterVSplit" items={outer} extents={extents("OuterVSplit", shown, aiWidth)} />
      <PanePortals bodies={bodies} mounted={mounted} />
      {wanted.map((p) => (
        <DetachedPaneWindow key={p} pane={p} activate={!atLaunch.current?.has(p)} />
      ))}
    </div>
  );
}

/** The top bar's Workspace menu and six pane toggles (ledger WS-009, WS-011). */
export function WorkspaceToolbar() {
  return <WorkspaceToolbarImpl />;
}

/** View ▸ Panes, Window ▸ Focus, Edit ▸ Find routing and pane text size. */
export function usePaneCommands() {
  usePaneCommandsImpl();
}
