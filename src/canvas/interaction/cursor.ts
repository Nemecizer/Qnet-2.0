// The canvas cursor, one owner and one pure derivation (0.90.34 CanvasClipView
// `cursorForCurrentState`, canvas.md §13.4, ledger INV-004, CAN-217). The surface's CSS cursor is
// recomputed from this on every render, so a tool switched from the menu, the palette or a key
// while the pointer is elsewhere can never leave a stale cursor behind. One meaning per cursor:
// the hand is panning, the arrow is "movable object", the copy cursor previews an ⌥-drag.
import type { EditorView } from "../../editor";

export type CanvasCursor = "grabbing" | "grab" | "crosshair" | "pointer" | "default" | "copy";

export function cursorFor(v: Pick<EditorView, "isPanningCanvas" | "isDraggingNode" | "isSpacePanning" | "tool" | "hoveredNodeID" | "hoveredLinkID">, optionHeld: boolean): CanvasCursor {
  if (v.isPanningCanvas || v.isDraggingNode) return "grabbing";
  if (v.isSpacePanning) return "grab";
  switch (v.tool) {
    case "pan":
      return "grab";
    case "multiSelect":
    case "addStation":
    case "addBuffer":
    case "addSource":
    case "addSink":
      return "crosshair";
    case "addLink":
      return v.hoveredNodeID !== null ? "pointer" : "default";
    case "select":
      if (v.hoveredNodeID !== null) return optionHeld ? "copy" : "default";
      return v.hoveredLinkID !== null ? "pointer" : "default";
  }
}
