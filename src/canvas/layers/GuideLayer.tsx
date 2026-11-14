// AlignmentGuideLayer (0.90.34 NetworkCanvasLayers.swift; canvas.md §9; ledger CAN-110…): the 1-pt
// accent guides while a dragged node lines up with a neighbour. An edge / centre guide runs
// between the dragged node and the partner it locked onto, overshooting both by 8 pt, with a 4-pt
// tick at each end; an equal-spacing guide draws each equalised gap as a bar with end ticks.
// Every coordinate is `.rounded() + 0.5` for a crisp hairline. The layer fades in and out with the
// quick animation in its own group (nothing eases under Reduce Motion: --dur-1 is 0 then).
import { useRef } from "react";
import type { AlignGuides } from "../../editor/editor";
import { rectToDisplay, toDisplay, type CanvasTransform } from "../geometry/transform";
import { maxX, maxY, midX, midY, minX, minY } from "../geometry/types";

const OVERSHOOT = 8;
const TICK = 4;
const roundAway = (x: number) => Math.sign(x) * Math.round(Math.abs(x));
const px = (v: number) => roundAway(v) + 0.5;

export function guidesEmpty(g: AlignGuides): boolean {
  return g.x === null && g.y === null && g.xSpacing === null && g.ySpacing === null;
}

/** The guides' path data in display space; "" when there is nothing to draw. */
export function guidePath(guides: AlignGuides, t: CanvasTransform): string {
  if (!guides.anchor) return "";
  const a = rectToDisplay(t, guides.anchor);
  const parts: string[] = [];
  const v = (x: number, y0: number, y1: number) => {
    parts.push(`M${x} ${y0}V${y1}`);
    for (const y of [y0, y1]) parts.push(`M${x - TICK} ${y}H${x + TICK}`);
  };
  const hz = (y: number, x0: number, x1: number) => {
    parts.push(`M${x0} ${y}H${x1}`);
    for (const x of [x0, x1]) parts.push(`M${x} ${y - TICK}V${y + TICK}`);
  };
  if (guides.x !== null) {
    const x = px(toDisplay(t, { x: guides.x, y: 0 }).x);
    let y0 = minY(a);
    let y1 = maxY(a);
    if (guides.xPartner) {
      const p = rectToDisplay(t, guides.xPartner);
      y0 = Math.min(y0, minY(p));
      y1 = Math.max(y1, maxY(p));
    }
    v(x, px(y0 - OVERSHOOT), px(y1 + OVERSHOOT));
  }
  if (guides.y !== null) {
    const y = px(toDisplay(t, { x: 0, y: guides.y }).y);
    let x0 = minX(a);
    let x1 = maxX(a);
    if (guides.yPartner) {
      const p = rectToDisplay(t, guides.yPartner);
      x0 = Math.min(x0, minX(p));
      x1 = Math.max(x1, maxX(p));
    }
    hz(y, px(x0 - OVERSHOOT), px(x1 + OVERSHOOT));
  }
  if (guides.xSpacing) {
    for (const gap of [guides.xSpacing.first, guides.xSpacing.second]) {
      const g = rectToDisplay(t, gap);
      hz(px(midY(g)), px(minX(g)), px(maxX(g)));
    }
  }
  if (guides.ySpacing) {
    for (const gap of [guides.ySpacing.first, guides.ySpacing.second]) {
      const g = rectToDisplay(t, gap);
      v(px(midX(g)), px(minY(g)), px(maxY(g)));
    }
  }
  return parts.join("");
}

export function GuideLayer({ guides, transform, color, hairline }: { guides: AlignGuides; transform: CanvasTransform; color: string; hairline: number }) {
  // The last guides shown stay drawn while the layer fades out.
  const last = useRef<string>("");
  const d = guidesEmpty(guides) ? "" : guidePath(guides, transform);
  if (d) last.current = d;
  if (!last.current) return null;
  return (
    <g data-layer="guides" className="canvas-fade" opacity={d ? 1 : 0} aria-hidden="true" pointerEvents="none">
      <path d={d || last.current} fill="none" stroke={color} strokeWidth={hairline} />
    </g>
  );
}
