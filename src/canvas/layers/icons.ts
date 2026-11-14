// The lucide icons that stand in for 0.90.34's SF Symbols on the canvas and its chrome (PLAN.md
// §4, "SF Symbols drawn as lucide icons through a name table"; ledger CAN-044): node kinds
// (`NodeKind.systemImage`), tools (`EditorTool.systemImage`) and the DS.Symbol glyphs the zoom
// cluster, the empty hint and the status bar use. The Tools pane should read the same table.
import type { LucideIcon } from "lucide-react";
import { Circle, Columns3, Diamond, Grid3x3, Hand, MousePointer2, Move, Network, Expand, Square, SquareDashed, Waypoints, ZoomIn, ZoomOut, ArrowRight } from "lucide-react";
import type { NodeKind } from "../../lib/bnet";
import type { EditorTool } from "../../editor/editor";

/** circle.fill, rectangle.split.3x1.fill, diamond.fill, app.fill. */
export const KIND_ICONS: Record<NodeKind, LucideIcon> = { station: Circle, buffer: Columns3, source: Diamond, sink: Square };

/** cursorarrow, rectangle.dashed, hand.raised.fill, the kinds, point.3.filled.connected.trianglepath.dotted. */
export const TOOL_ICONS: Record<EditorTool, LucideIcon> = {
  select: MousePointer2,
  multiSelect: SquareDashed,
  pan: Hand,
  addStation: KIND_ICONS.station,
  addBuffer: KIND_ICONS.buffer,
  addSource: KIND_ICONS.source,
  addSink: KIND_ICONS.sink,
  addLink: Waypoints,
};

/** DS.Symbol: zoomIn, zoomOut, zoomToFit, snapToGrid, network, pan, link. */
export const SYMBOLS = {
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  zoomToFit: Expand,
  snapToGrid: Grid3x3,
  network: Network,
  pan: Move,
  link: ArrowRight,
} as const;
