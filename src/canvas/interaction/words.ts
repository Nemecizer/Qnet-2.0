// The words of the interactive canvas: the Tools pane and Tools menu (0.90.34 Models.swift
// `EditorTool`, ToolPaletteView.swift), the canvas context menus (NetworkCanvasView.swift
// `canvasContextMenu`, `linkContextMenu`, `nodeContextMenu`), the View-menu tooltips
// (QnetCommands.swift `viewMenu`), the toolbar's canvas buttons (ContentView.swift) and the Find
// Node panel (NetworkDialogs.swift `FindNodeSheet`). Kept verbatim where 0.90.34 had them.
import type { EditorTool } from "../../editor";

const KEY: Record<EditorTool, string> = { select: "V", multiSelect: "M", pan: "H", addStation: "S", addBuffer: "B", addSource: "O", addSink: "X", addLink: "L" };

export const interactionWords = {
  /** `EditorTool.paletteLabel`. */
  paletteLabel: {
    select: "Pointer",
    multiSelect: "Multi-Select",
    pan: "Pan",
    addStation: "Station",
    addBuffer: "Buffer",
    addSource: "Source",
    addSink: "Sink",
    addLink: "Link",
  } as Record<EditorTool, string>,
  /** `EditorTool.menuTitle`. */
  menuTitle: {
    select: "Pointer Tool",
    multiSelect: "Multi-Select Tool",
    pan: "Pan Tool",
    addStation: "Station Tool",
    addBuffer: "Buffer Tool",
    addSource: "Source Tool",
    addSink: "Sink Tool",
    addLink: "Link Tool",
  } as Record<EditorTool, string>,
  /** `EditorTool.helpText`. */
  helpText: {
    select: `Pointer tool (${KEY.select}) — click to select, drag to move (guides line the node up with its neighbours and the grid; hold ⌃ while dragging to place it freely; ⌥ duplicates; Escape mid-drag puts the drag back), drag on empty canvas to rubber-band select, double-click empty canvas for the hand and one click anywhere to come back`,
    multiSelect: `Multi-Select tool (${KEY.multiSelect}) — drag a rectangle to select several nodes at once; double-click empty canvas for the hand and one click anywhere to come back`,
    pan: `Pan tool (${KEY.pan}) — drag the canvas to scroll; press V for the Pointer, hold Space to pan from any tool, or double-click empty canvas in any selection tool to borrow the hand for one click`,
    addStation: `Station tool (${KEY.addStation}) — click the canvas to place a service station`,
    addBuffer: `Buffer tool (${KEY.addBuffer}) — click the canvas to place a finite or infinite buffer`,
    addSource: `Source tool (${KEY.addSource}) — click the canvas to place an arrival source (one customer class each)`,
    addSink: `Sink tool (${KEY.addSink}) — click the canvas to place an exit sink`,
    addLink: `Link tool (${KEY.addLink}) — click a start node, then each next node to chain routing links, or press on a node and drag to a second one; click the same station twice (or drag out and back onto it) for a self-loop`,
  } as Record<EditorTool, string>,
  /** The Tools menu item's tooltip (QnetCommands.swift `toolItem`). */
  menuHelp: (help: string) => `${help} — Help ▸ Keyboard Shortcuts lists every key`,
  toolKey: KEY,
  toolA11yLabel: (label: string) => `${label} tool`,
  toolSelected: "selected",
  toolA11yHint: (key: string) => `Shortcut ${key} on the canvas`,
  toolsPane: "Tools pane",
  toolsHeader: "Tools",
  /** Why a Tools item or canvas key is off (`canvasCommandsActive`). */
  canvasNotKey: "Click in the main window first",

  // View menu (QnetCommands.swift viewMenu .help)
  zoomInHelp: "Zoom the canvas in (the focused Status, Shell or AI pane's text instead)",
  zoomOutHelp: "Zoom the canvas out (the focused Status, Shell or AI pane's text instead)",
  actualSizeHelp: "Zoom to 100 % with the origin in the top-left corner",
  zoomToFitHelp: "Frame the whole network",
  zoomToSelectionHelp: "Frame the selected nodes",
  snapHelp: "Snap node positions to the canvas grid while dragging and nudging",
  noNodes: "The canvas is empty",
  noNodeSelection: "Select one or more nodes first",

  // The workspace toolbar's canvas buttons (ContentView.swift toolbar, TB-002…004)
  straighten: "Straighten Network",
  straightenHelp: "Straighten Network (Network ▸ Straighten Network)",
  zoomToFit: "Zoom to Fit",
  zoomToFitToolbarHelp: (key: string) => `Zoom to Fit — frame the whole network without moving any node (View ▸ Zoom to Fit, ${key})`,

  // Context menus (no key equivalents: the menu bar owns them)
  paste: "Paste",
  duplicateSelection: "Duplicate Selection",
  selectAll: "Select All",
  deselectAll: "Deselect All",
  zoomToSelection: "Zoom to Selection",
  actualSize: "Actual Size",
  snapToGrid: "Snap to Grid",
  editParameters: "Edit Parameters…",
  customerClass: "Customer Class",
  exitClass: "Exit Class",
  sameAsEntry: (cls: string) => `Same as entry (${cls})`,
  deleteLink: "Delete Link",
  deleteKind: (kind: string) => `Delete ${kind}`,
  copy: (n: number) => (n >= 2 ? `Copy (${n} nodes)` : "Copy"),
  cut: (n: number) => (n >= 2 ? `Cut (${n} nodes)` : "Cut"),
  duplicate: (n: number) => (n >= 2 ? `Duplicate (${n} nodes)` : "Duplicate"),
  align: {
    top: "Align Top",
    vcentre: "Align Vertical Centres",
    bottom: "Align Bottom",
    left: "Align Left",
    hcentre: "Align Horizontal Centres",
    right: "Align Right",
    distributeH: "Distribute Horizontally",
    distributeV: "Distribute Vertically",
  },
  classUsedOnPair: "Another link on this pair already carries this class",
  canvasMenu: "Canvas",
  nodeMenu: (name: string) => `${name}`,
  linkMenu: "Link",

  // Scrollers (NetworkCanvasScrollContainer.swift)
  vScroller: "Canvas vertical scroller",
  hScroller: "Canvas horizontal scroller",
  canvasLabel: "Network canvas",

  // Find Node (NetworkDialogs.swift FindNodeSheet; QnetGUIApp syncFindNodePanel)
  findTitle: "Find Node",
  findSubtitle: "Enter a node name or part of one. The first match is selected and scrolled into view.",
  findPlaceholder: "Node name (e.g. S3, Src, buffer)",
  findFieldHelp: "Type part of a node name; the list filters as you type",
  findFieldLabel: "Node name",
  findOnCanvas: (n: number) => `${n} node${n === 1 ? "" : "s"} on the canvas`,
  findNoMatch: (q: string) => `No node matches “${q}”`,
  findMatches: (n: number) => (n === 1 ? "1 match" : `${n} matches`),
  findMore: (n: number) => `and ${n} more…`,
  findConfirm: "Find",
  findCancel: "Cancel",
  findCancelHelp: "Close without changing the selection (Esc)",
  findConfirmHelp: "Select the first matching node and zoom to it (Return)",
  findBlockedHelp: "Type part of a node name to find it",
} as const;
