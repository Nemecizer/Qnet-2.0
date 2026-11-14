// The rubber band of a link being drawn (canvas.md §10.2, 0.90.34 `LinkPreviewCanvas`): over
// another node it is the exact geometry release would create, over the start node again (having
// left it) the exact self-loop, nested outside the loops already there, and over empty canvas a
// bare line from the start node's outline to the pointer with no arrowhead.
//
// "Exact" is kept by using the scene's own builders, `linkBetween` and `selfLoop`, with no bundle
// offset or bow, as 0.90.34's `LinkPreviewCanvas` did; a previewed loop nests one bundle spacing
// outside every loop the node already has, so it never sits on top of one and reads as "nothing".
import type { BnetLink, BnetNode } from "../../lib/bnet";
import { exitDistance } from "../geometry/outline";
import { BUNDLE_SPACING, linkBetween, selfLoop, type LinkGeometry } from "../geometry/scene";
import { toDisplay, type CanvasTransform } from "../geometry/transform";
import type { Point } from "../geometry/types";

export interface LinkPreview {
  geometry: LinkGeometry;
  /** False over empty canvas: there is no target to point at. */
  hasArrow: boolean;
}

export function linkPreview(args: {
  start: BnetNode;
  /** The free end, world space. */
  pointer: Point;
  /** The node release would land on (never the start node). */
  target: BnetNode | null;
  /** Release would draw a self-loop on the start node. */
  loopsBack: boolean;
  /** Every link of the document (all classes, whatever the filter shows). */
  links: readonly BnetLink[];
  transform: CanvasTransform;
}): LinkPreview {
  const { start, pointer, target, loopsBack, links, transform } = args;
  const s = transform.scale;
  const c = toDisplay(transform, { x: start.position[0], y: start.position[1] });
  if (loopsBack) {
    const existing = links.reduce((n, l) => (l.fromNodeID === start.id && l.toNodeID === start.id ? n + 1 : n), 0);
    return { geometry: selfLoop(c, start.kind, s, existing * BUNDLE_SPACING * s), hasArrow: true };
  }
  if (target) {
    const tc = toDisplay(transform, { x: target.position[0], y: target.position[1] });
    return { geometry: linkBetween(c, start.kind, tc, target.kind, s), hasArrow: true };
  }
  const p = toDisplay(transform, pointer);
  const len = Math.hypot(p.x - c.x, p.y - c.y);
  const u = len > 0 ? { x: (p.x - c.x) / len, y: (p.y - c.y) / len } : { x: 1, y: 0 };
  const d = exitDistance(start.kind, { x: 0, y: 0 }, u) * s;
  const from = { x: c.x + u.x * d, y: c.y + u.y * d };
  return {
    geometry: { start: from, base: p, tip: p, wingLeft: p, wingRight: p, route: { kind: "straight" }, labelAnchor: p, polyline: [from, p] },
    hasArrow: false,
  };
}
