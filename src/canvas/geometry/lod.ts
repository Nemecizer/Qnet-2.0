// Level of detail on the canvas (ledger §3.8; 0.90.34 DesignSystem.swift `DS.Canvas`,
// NetworkCanvasLayers.swift `NetworkNodeView.labelBlock` and `LinkLayerCanvas`): which label rows a
// node shows at a zoom, the clamped font sizes, and the probability chips with their declutter
// rule. Pure functions for the drawing layer.
import { formatSig } from "../../editor/numbers";
import { cgIntersects, swiftMax, swiftMin } from "./math";
import { LABEL_BLOCK_WIDTH } from "./outline";
import type { Point, Rect, Size } from "./types";

/** Base point size of node names at zoom 1 (DS.Canvas.labelSize). */
export const CANVAS_LABEL_SIZE = 10;
/** Routing-probability chips (DS.Canvas.linkLabelSize = labelSize − 1). */
export const LINK_LABEL_SIZE = CANVAS_LABEL_SIZE - 1;
/** Below this zoom the node name is hidden (a hovered or selected node keeps it). */
export const NAME_ROW_MIN_SCALE = 0.35;
/** Below this zoom the distribution row is hidden. */
export const DETAIL_ROW_MIN_SCALE = 0.45;
/** Below this zoom the μ / SCV row is hidden. */
export const RATE_ROW_MIN_SCALE = 0.6;
/** Below this zoom no probability chip is drawn. */
export const LINK_LABEL_MIN_SCALE = 0.5;
/** DS.Spacing.xs: a chip's horizontal padding. */
export const CHIP_PADDING_X = 4;

export const nameRowShown = (scale: number, hovered = false, selected = false) => scale >= NAME_ROW_MIN_SCALE || hovered || selected;
/** `detailText` is the row's text (nil when the node has no distribution row). */
export const detailRowShown = (scale: number, hasDetail = true) => scale >= DETAIL_ROW_MIN_SCALE && hasDetail;
export const rateRowShown = (scale: number, hasRate = true) => scale >= RATE_ROW_MIN_SCALE && hasRate;

/** The label block's display width: 76 × min(scale, 1.4), at least 56. */
export const labelBlockDisplayWidth = (scale: number) => swiftMax(56, LABEL_BLOCK_WIDTH * swiftMin(scale, 1.4));
/** Node name point size: 10 × scale clamped to 9…13. */
export const nameFontSize = (scale: number) => swiftMax(9, swiftMin(13, CANVAS_LABEL_SIZE * scale));
/** Detail and rate rows: two points under the name, at least 8. */
export const detailFontSize = (scale: number) => swiftMax(8, nameFontSize(scale) - 2);
/** Probability chip point size: 9 × scale clamped to 9…12. */
export const chipFontSize = (scale: number) => swiftMax(9, swiftMin(12, LINK_LABEL_SIZE * scale));
/** Node outline stroke, display pt. */
export const nodeStrokeWidth = (scale: number) => swiftMax(1, 2 * scale);

export const chipsShown = (scale: number) => scale >= LINK_LABEL_MIN_SCALE;

/** A chip's text, 2 significant digits; null when p is exactly 1 (no chip). */
export function chipText(routingProbability: number): string | null {
  return routingProbability === 1.0 ? null : formatSig(routingProbability, 2);
}

export type ChipPolicy = "never" | "declutter" | "always";

/** The chip policy one link gets this frame (hovered and selected links' chips are reserved). */
export function chipPolicy(scale: number, routingProbability: number, emphasised = false): ChipPolicy {
  if (!chipsShown(scale) || routingProbability === 1.0) return "never";
  return emphasised ? "always" : "declutter";
}

/** The chip's rect round its text, centred on the anchor: text + 2·xs wide, text + 2 high. */
export function chipRect(anchor: Point, textSize: Size): Rect {
  return {
    x: anchor.x - textSize.width / 2 - CHIP_PADDING_X,
    y: anchor.y - textSize.height / 2 - 1,
    width: textSize.width + 2 * CHIP_PADDING_X,
    height: textSize.height + 2,
  };
}

export interface ChipLink {
  readonly id: string;
  readonly link: { readonly routingProbability: number };
  readonly geometry: { readonly labelAnchor: Point };
}

/**
 * The declutter pass of `LinkLayerCanvas` (CAN-071): which links' chips are drawn this frame and
 * where. Below zoom 0.5 none. Otherwise the hovered and selected links' chips are reserved first
 * (scene order), then every other link in scene order places its chip unless it intersects one
 * already placed (CoreGraphics' rule); the reserved ones are always drawn. `measure` returns the
 * text's size for the chip font (the drawing layer measures with the real font).
 */
export function placeChips(
  links: readonly ChipLink[],
  state: { scale: number; selectedLinkID: string | null; hoveredLinkID: string | null },
  measure: (text: string, fontSize: number) => Size,
): Map<string, { rect: Rect; text: string }> {
  const out = new Map<string, { rect: Rect; text: string }>();
  if (!chipsShown(state.scale)) return out;
  const font = chipFontSize(state.scale);
  const emphasised = (id: string) => id === state.selectedLinkID || id === state.hoveredLinkID;
  const chipFor = (item: ChipLink) => {
    const text = chipText(item.link.routingProbability);
    if (text === null) return null;
    return { rect: chipRect(item.geometry.labelAnchor, measure(text, font)), text };
  };
  const occupied: Rect[] = [];
  for (const item of links) {
    if (!emphasised(item.id)) continue;
    const c = chipFor(item);
    if (c) occupied.push(c.rect);
  }
  for (const item of links) {
    if (emphasised(item.id)) continue;
    const c = chipFor(item);
    if (!c) continue;
    if (occupied.some((r) => cgIntersects(r, c.rect))) continue;
    occupied.push(c.rect);
    out.set(item.id, c);
  }
  for (const item of links) {
    if (!emphasised(item.id)) continue;
    const c = chipFor(item);
    if (c) out.set(item.id, c);
  }
  return out;
}
