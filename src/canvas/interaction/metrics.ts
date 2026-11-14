// The scrollers' state as a pure function of the nodes and the transform (0.90.34
// NetworkCanvasScrollContainer.swift `CanvasScrollMetrics`, canvas.md §14). Only node centres feed
// it — overlays never do. Scroll targets are pan values computed from the pan-independent box, so
// the mapping holds still while a knob is dragged and a network dragged off-frame can always be
// brought back; pan is never snapped back when the overflow goes away.
import type { BnetNode } from "../../lib/bnet";
import { boundsOfCentres } from "../geometry/outline";
import type { CanvasTransform } from "../geometry/transform";

export const CONTENT_MARGIN = 16;
export const OVERFLOW_EPSILON = 2;

export interface ScrollMetrics {
  hEnabled: boolean;
  vEnabled: boolean;
  hKnob: number;
  vKnob: number;
  hValue: number;
  vValue: number;
  panAt0X: number;
  panAt1X: number;
  panAt0Y: number;
  panAt1Y: number;
}

const NONE: ScrollMetrics = { hEnabled: false, vEnabled: false, hKnob: 1, vKnob: 1, hValue: 0, vValue: 0, panAt0X: 0, panAt1X: 0, panAt0Y: 0, panAt1Y: 0 };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function scrollMetrics(nodes: readonly Pick<BnetNode, "position">[], t: CanvasTransform): ScrollMetrics {
  const vp = t.viewportSize;
  const b = boundsOfCentres(nodes);
  if (!(vp.width > 0 && vp.height > 0) || !b) return NONE;
  const s = t.scale;
  const rawMinX = b.x * s - CONTENT_MARGIN;
  const rawMaxX = (b.x + b.width) * s + CONTENT_MARGIN;
  const rawMinY = b.y * s - CONTENT_MARGIN;
  const rawMaxY = (b.y + b.height) * s + CONTENT_MARGIN;
  const minX = rawMinX + t.pan.width;
  const maxX = rawMaxX + t.pan.width;
  const minY = rawMinY + t.pan.height;
  const maxY = rawMaxY + t.pan.height;
  const floor = (o: number) => (o < OVERFLOW_EPSILON ? 0 : o);
  const totalH = floor(Math.max(0, -minX)) + floor(Math.max(0, maxX - vp.width));
  const totalV = floor(Math.max(0, -minY)) + floor(Math.max(0, maxY - vp.height));
  const hEnabled = totalH > OVERFLOW_EPSILON;
  const vEnabled = totalV > OVERFLOW_EPSILON;
  const panAt0X = -rawMinX;
  const panAt1X = vp.width - rawMaxX;
  const panAt0Y = -rawMinY;
  const panAt1Y = vp.height - rawMaxY;
  const rangeX = panAt1X - panAt0X;
  const rangeY = panAt1Y - panAt0Y;
  return {
    hEnabled,
    vEnabled,
    hKnob: hEnabled ? vp.width / (vp.width + totalH) : 1,
    vKnob: vEnabled ? vp.height / (vp.height + totalV) : 1,
    hValue: hEnabled && Math.abs(rangeX) > OVERFLOW_EPSILON ? clamp01((t.pan.width - panAt0X) / rangeX) : 0,
    vValue: vEnabled && Math.abs(rangeY) > OVERFLOW_EPSILON ? clamp01((t.pan.height - panAt0Y) / rangeY) : 0,
    panAt0X,
    panAt1X,
    panAt0Y,
    panAt1Y,
  };
}

export const offsetX = (m: ScrollMetrics, n: number) => m.panAt0X + n * (m.panAt1X - m.panAt0X);
export const offsetY = (m: ScrollMetrics, n: number) => m.panAt0Y + n * (m.panAt1Y - m.panAt0Y);

/** NSScroller's parts: a click in the slot pages by max(0.05, knob × 0.9); the line step is 0.05. */
export type ScrollerPart = "decrementPage" | "incrementPage" | "decrementLine" | "incrementLine" | "knob";

export function nextScrollValue(value: number, knob: number, part: ScrollerPart, knobValue = value): number {
  const page = Math.max(0.05, knob * 0.9);
  switch (part) {
    case "decrementPage":
      return Math.max(0, value - page);
    case "incrementPage":
      return Math.min(1, value + page);
    case "decrementLine":
      return Math.max(0, value - 0.05);
    case "incrementLine":
      return Math.min(1, value + 0.05);
    case "knob":
      return clamp01(knobValue);
  }
}
