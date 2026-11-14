// The top bar's workspace controls (ContentView's `.toolbar(id: "qnet.main")`, ledger WS-009…011,
// TB-005…013): the Workspace menu (the five presets, Maximize Pane / Restore Pane Layout, Separate
// Windows) and the six pane toggles, in 0.90.34's default order. Each runs the same command as its
// View ▸ Panes item, so the two can't drift. P5 adds Straighten Network and Zoom to Fit before them.
import { useRef, useState } from "react";
import { Hash, Minimize2, PanelLeft, PanelRight, SlidersHorizontal, Sparkles, SquareSplitHorizontal, Terminal, type LucideIcon } from "lucide-react";
import { Icon } from "../../components/Icon";
import { getCommand, runCommand, titleOf, unavailableReason, useCommandList } from "../../lib/commands";
import { useSetting } from "../../lib/kv";
import { shortcutFor } from "../../lib/menu";
import type { PaneId } from "../focus";
import { DETACHABLE, isPaneEnabled, PRESETS, SOLO_KEY, soloedPane } from "./model";
import { PopupMenu, type PopupItem } from "./PopupMenu";
import { PANE_NAME, paneWords } from "./words";
import { CanvasToolbarButtons } from "../../canvas/tools/ToolbarButtons";
import { SolveToolbarButton } from "../../welcome/SolveButton";
import { ScenarioHost, ScenarioSwitcher } from "../../scenarios";

/** The toggles in the toolbar's default order (TB-013) with the lucide glyph nearest each SF Symbol. */
export const TOOLBAR_TOGGLES: [Exclude<PaneId, "canvas">, LucideIcon][] = [
  ["tools", PanelLeft], // sidebar.left
  ["status", PanelRight], // sidebar.right
  ["results", Hash], // textformat.123
  ["inspector", SlidersHorizontal], // slider.horizontal.3
  ["shell", Terminal], // terminal
  ["ai", Sparkles], // sparkles
];

function item(id: string): PopupItem {
  const c = getCommand(id);
  if (!c) return { label: id, disabled: true };
  return { label: titleOf(c), help: c.subtitle, disabled: unavailableReason(c) !== null, checked: c.checked?.(), run: () => void runCommand(id) };
}

/** The Workspace menu's items, as View ▸ Panes renders them (WS-009). */
export function workspaceMenuItems(): PopupItem[] {
  return [
    ...PRESETS.map((p) => item(`view:preset-${p.id}`)),
    "-",
    item("view:maximize-pane"),
    "-",
    { label: "Separate Windows", help: paneWords.separateWindowsToolbarHelp, submenu: [...DETACHABLE.map((p) => item(`view:detach-${p}`)), "-", item("view:reattach-all")] },
  ];
}

/** The toggle's tooltip (WS-011): "Show or hide the <pane> pane (<shortcut>)". */
export function toggleHelp(p: Exclude<PaneId, "canvas">): string {
  const key = shortcutFor(`view:pane-${p}`);
  return p === "results" ? paneWords.resultsToggleHelp(key) : paneWords.toggleHelp(PANE_NAME[p], key);
}

export function WorkspaceToolbarImpl() {
  useCommandList();
  // Any settings change re-renders (the toggles' states, the maximized pane).
  useSetting(SOLO_KEY, "");
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const returnTo = useRef<Element | null>(null);
  const solo = soloedPane();

  const open = (btn: HTMLElement) => {
    returnTo.current = btn.ownerDocument.activeElement;
    setMenu(btn.getBoundingClientRect());
  };
  const close = (chosen?: () => void) => {
    setMenu(null);
    // The command acts on the pane that had focus before the menu took it (Maximize's target).
    const back = returnTo.current;
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    chosen?.();
  };

  return (
    <div className="workspace-toolbar" role="toolbar" aria-label={paneWords.toolbarLabel}>
      <SolveToolbarButton />
      <ScenarioSwitcher />
      <ScenarioHost />
      <CanvasToolbarButtons />
      <button
        type="button"
        className="icon-btn toolbar-btn"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={solo ? paneWords.workspaceMaximizedLabel(PANE_NAME[solo]) : paneWords.workspaceLabel}
        title={solo ? paneWords.workspaceMaximizedHelp(PANE_NAME[solo]) : paneWords.workspaceHelp}
        data-toolbar-item="panes.workspace"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => (menu ? close() : open(e.currentTarget))}
      >
        <Icon icon={solo ? Minimize2 : SquareSplitHorizontal} size={16} />
        <span className="sr-only">{paneWords.workspace}</span>
      </button>
      {TOOLBAR_TOGGLES.map(([p, glyph]) => {
        const on = isPaneEnabled(p);
        return (
          <button
            key={p}
            type="button"
            className="icon-btn toolbar-btn"
            aria-pressed={on}
            aria-label={paneWords.toggleLabel(PANE_NAME[p])}
            title={toggleHelp(p)}
            data-toolbar-item={`panes.${p === "tools" ? "palette" : p}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void runCommand(`view:pane-${p}`)}
          >
            <Icon icon={glyph} size={16} />
          </button>
        );
      })}
      {menu && <PopupMenu items={workspaceMenuItems()} anchor={menu} onClose={close} label={paneWords.workspace} />}
    </div>
  );
}
