// The canvas's right-click menus (canvas.md §12.8, 0.90.34 NetworkCanvasView.swift
// `canvasContextMenu`, `linkContextMenu`, `nodeContextMenu`, ledger §3.9): built as data here and
// shown natively in the app (Tauri's `Menu.popup`, so the menu is AppKit's own, check marks and
// all, as 0.90.34's was), or as the workspace's in-page PopupMenu in the browser preview and in
// tests, where there is no native side. No item carries a key equivalent: the menu bar owns them.
import { classLabel, KIND_NAMES, type Editor } from "../../editor";
import type { BnetLink, BnetNode } from "../../lib/bnet";
import type { PopupItem } from "../../workspace/panes/PopupMenu";
import { interactionWords as w } from "./words";

export type MenuEntry = "-" | { label: string; enabled?: boolean; checked?: boolean; destructive?: boolean; help?: string; run?: () => void; submenu?: MenuEntry[] };

/** Empty canvas: Paste · Duplicate Selection │ Select All · Deselect All │ Zoom to Fit · Zoom to Selection · Actual Size │ Snap to Grid. */
export function canvasMenu(e: Editor): MenuEntry[] {
  return [
    { label: w.paste, enabled: e.canPaste, run: () => e.pasteSelection() },
    { label: w.duplicateSelection, enabled: e.selectionUnion.size > 0, run: () => e.duplicateSelection() },
    "-",
    { label: w.selectAll, enabled: e.nodes.length > 0, run: () => e.selectAll() },
    { label: w.deselectAll, enabled: e.hasAnySelection, run: () => e.deselectAll() },
    "-",
    { label: w.zoomToFit, enabled: e.nodes.length > 0, run: () => e.zoomToFit() },
    { label: w.zoomToSelection, enabled: e.canZoomToSelection, run: () => e.zoomToFitSelection() },
    { label: w.actualSize, run: () => e.resetZoom() },
    "-",
    { label: w.snapToGrid, checked: e.view.snapToGrid, run: () => e.setSnapToGrid(!e.view.snapToGrid) },
  ];
}

/**
 * A link: Edit Parameters…, the Customer Class picker (more than one class), the Exit Class picker
 * (Same as entry, then every class plus one new one), Delete Link. 2.0 dims an entry class another
 * link on the same pair already carries, as the inspector does (ledger CAN-144, D5).
 */
export function linkMenu(e: Editor, link: BnetLink): MenuEntry[] {
  const out: MenuEntry[] = [{ label: w.editParameters, run: () => e.openLinkParameterEditor(link.id) }];
  const classes = e.numberOfCustomerClasses;
  if (classes > 1) {
    const used = e.entryClassesUsedByOtherLinks(link.id);
    const rows: MenuEntry[] = [];
    for (let c = 0; c < classes; c++) {
      const taken = used.has(c) && c !== link.customerClass;
      rows.push({ label: classLabel(c), checked: link.customerClass === c, enabled: !taken, help: taken ? w.classUsedOnPair : undefined, run: () => e.updateLinkCustomerClass(link.id, c) });
    }
    out.push({ label: w.customerClass, submenu: rows });
  }
  const choiceMax = Math.max(classes, 1) + 1;
  const exits: MenuEntry[] = [{ label: w.sameAsEntry(classLabel(link.customerClass)), checked: link.toCustomerClass === undefined, run: () => e.updateLinkExitClass(link.id, null) }, "-"];
  for (let c = 0; c < choiceMax; c++) exits.push({ label: classLabel(c), checked: link.toCustomerClass === c, run: () => e.updateLinkExitClass(link.id, c) });
  out.push({ label: w.exitClass, submenu: exits }, "-", { label: w.deleteLink, destructive: true, run: () => e.deleteLink(link.id) });
  return out;
}

/** The node's own menu: the align set for a group it belongs to, the clipboard, Edit Parameters…, Delete <Kind>. */
export function nodeMenu(e: Editor, node: BnetNode): MenuEntry[] {
  const v = e.view;
  const out: MenuEntry[] = [];
  if (v.selectedNodeIDs.size >= 2 && v.selectedNodeIDs.has(node.id)) {
    out.push(
      { label: w.align.top, run: () => e.alignSelectedNodesTop() },
      { label: w.align.vcentre, run: () => e.alignSelectedNodesVerticalCentres() },
      { label: w.align.bottom, run: () => e.alignSelectedNodesBottom() },
      { label: w.align.left, run: () => e.alignSelectedNodesLeft() },
      { label: w.align.hcentre, run: () => e.alignSelectedNodesHorizontalCentres() },
      { label: w.align.right, run: () => e.alignSelectedNodesRight() },
      { label: w.align.distributeH, run: () => e.distributeSelectedNodesHorizontally() },
      { label: w.align.distributeV, run: () => e.distributeSelectedNodesVertically() },
      "-",
    );
  }
  // A right-clicked node outside the selection becomes the sole selection first; one inside a group keeps it.
  const n = v.selectedNodeIDs.has(node.id) ? v.selectedNodeIDs.size : 1;
  const ensure = () => {
    const cur = e.view;
    if (cur.selectedNodeIDs.has(node.id) || cur.selectedNodeID === node.id) return;
    e.setView({ selectedNodeIDs: new Set(), selectedNodeID: node.id });
  };
  out.push(
    { label: w.copy(n), run: () => (ensure(), e.copySelection()) },
    { label: w.cut(n), run: () => (ensure(), e.cutSelection()) },
    { label: w.duplicate(n), run: () => (ensure(), e.duplicateSelection()) },
    { label: w.paste, enabled: e.canPaste, run: () => e.pasteSelection() },
    "-",
    { label: w.editParameters, run: () => e.openParameterEditor(node.id) },
    "-",
    { label: w.deleteKind(KIND_NAMES[node.kind]), destructive: true, run: () => e.deleteNode(node.id) },
  );
  return out;
}

/** The in-page form of a menu (PopupMenu's items). */
export function toPopupItems(items: MenuEntry[]): PopupItem[] {
  return items.map((i) =>
    i === "-" ? "-" : { label: i.label, help: i.help, disabled: i.enabled === false, checked: i.checked, run: i.run, submenu: i.submenu ? toPopupItems(i.submenu) : undefined },
  );
}

/**
 * Whether menus pop up natively: in the app, not in the browser preview or a test, whose Tauri
 * is the mock (`mockIPC` keeps its callbacks on the internals object; the real one doesn't).
 */
export const menuPresenter = {
  native: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !("callbacks" in ((window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ ?? {})),
};

let seq = 0;

/** Shows `items` as a native menu at the pointer (logical client coordinates). */
export async function popupNative(items: MenuEntry[], x: number, y: number): Promise<void> {
  const { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const { LogicalPosition } = await import("@tauri-apps/api/dpi");
  type Native = Awaited<ReturnType<typeof MenuItem.new>> | Awaited<ReturnType<typeof CheckMenuItem.new>> | Awaited<ReturnType<typeof Submenu.new>> | Awaited<ReturnType<typeof PredefinedMenuItem.new>>;
  const build = async (list: MenuEntry[]): Promise<Native[]> => {
    const out: Native[] = [];
    for (const i of list) {
      if (i === "-") out.push(await PredefinedMenuItem.new({ item: "Separator" }));
      else if (i.submenu) out.push(await Submenu.new({ text: i.label, enabled: i.enabled !== false, items: await build(i.submenu) }));
      else {
        // Ids that name no command: Rust echoes every menu click as menu://click, and a command id
        // here would run twice.
        const id = `canvas-context-${++seq}`;
        const run = i.run;
        const base = { id, text: i.label, enabled: i.enabled !== false, action: () => run?.() };
        out.push(i.checked === undefined ? await MenuItem.new(base) : await CheckMenuItem.new({ ...base, checked: i.checked }));
      }
    }
    return out;
  };
  const menu = await Menu.new({ items: await build(items) });
  try {
    await menu.popup(new LogicalPosition(x, y));
  } finally {
    // Each popup's menu and items are native resources: release them once it has closed.
    await menu.close().catch(() => {});
  }
}
