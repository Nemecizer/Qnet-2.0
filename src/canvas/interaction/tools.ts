// The eight tools as the palette, the Tools menu and the canvas keys see them (0.90.34 Models.swift
// `EditorTool`: shortcutKey, paletteGroups, systemImage, `init?(shortcutCharacter:)`). SF Symbols
// become lucide icons through this fixed table (ledger CAN-004).
import { Circle, Columns3, Diamond, Hand, MousePointer2, Square, SquareDashed, Waypoints, type LucideIcon } from "lucide-react";
import type { EditorTool } from "../../editor";
import type { NodeKind } from "../../lib/bnet";
import { interactionWords as w } from "./words";

/** `EditorTool.paletteGroups`: selection tools, node tools in flow order, then the link tool. */
export const PALETTE_GROUPS: readonly (readonly EditorTool[])[] = [
  ["select", "multiSelect", "pan"],
  ["addSource", "addStation", "addBuffer", "addSink"],
  ["addLink"],
];

/** Command ids of the Tools menu (src/lib/menuSpec.ts). */
export const TOOL_COMMAND: Record<EditorTool, string> = {
  select: "tool:select",
  multiSelect: "tool:multi-select",
  pan: "tool:pan",
  addSource: "tool:source",
  addStation: "tool:station",
  addBuffer: "tool:buffer",
  addSink: "tool:sink",
  addLink: "tool:link",
};

/** cursorarrow, rectangle.dashed, hand.raised.fill, circle.fill, rectangle.split.3x1.fill, diamond.fill, app.fill, point.3…dotted. */
export const TOOL_ICON: Record<EditorTool, LucideIcon> = {
  select: MousePointer2,
  multiSelect: SquareDashed,
  pan: Hand,
  addStation: Circle,
  addBuffer: Columns3,
  addSource: Diamond,
  addSink: Square,
  addLink: Waypoints,
};

export const toolKey = (t: EditorTool): string => w.toolKey[t];

/** `EditorTool(shortcutCharacter:)`: case-insensitive, one character. */
export function toolForKey(key: string): EditorTool | null {
  if (key.length !== 1) return null;
  const upper = key.toUpperCase();
  for (const t of Object.keys(w.toolKey) as EditorTool[]) if (w.toolKey[t] === upper) return t;
  return null;
}

/** The node kind an add tool places, null for the others. */
export function placedNodeKind(t: EditorTool): NodeKind | null {
  switch (t) {
    case "addStation":
      return "station";
    case "addBuffer":
      return "buffer";
    case "addSource":
      return "source";
    case "addSink":
      return "sink";
    default:
      return null;
  }
}
