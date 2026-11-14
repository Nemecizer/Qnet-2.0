// SVG path data for the node shapes (0.90.34 NetworkCanvasLayers.swift `NodeOutlineShape`,
// `BufferShape`, `BufferFillShape`; ledger CAN-022, CAN-026, CAN-028) and the links (CanvasGeometry
// `LinkGeometry.strokePath` / `arrowPath`). Everything is in display points.
import type { NodeKind } from "../../lib/bnet";
import type { LinkGeometry } from "../geometry/scene";

const f = (x: number) => (Math.abs(x) < 1e-9 ? "0" : String(Math.round(x * 1000) / 1000));

/** A node kind's outline filling the w × h rect centred on (cx, cy); `r` is the sink's corner radius. */
export function outlinePath(kind: NodeKind, cx: number, cy: number, w: number, h: number, r: number): string {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const x1 = cx + w / 2;
  const y1 = cy + h / 2;
  switch (kind) {
    case "station": {
      const rx = w / 2;
      const ry = h / 2;
      return `M${f(x0)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(x1)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(x0)} ${f(cy)}Z`;
    }
    case "source":
      return `M${f(cx)} ${f(y0)}L${f(x1)} ${f(cy)}L${f(cx)} ${f(y1)}L${f(x0)} ${f(cy)}Z`;
    case "buffer":
      return `M${f(x0)} ${f(y0)}H${f(x1)}V${f(y1)}H${f(x0)}Z`;
    case "sink": {
      const k = Math.max(0, Math.min(r, w / 2, h / 2));
      if (k === 0) return `M${f(x0)} ${f(y0)}H${f(x1)}V${f(y1)}H${f(x0)}Z`;
      return (
        `M${f(x0 + k)} ${f(y0)}H${f(x1 - k)}A${f(k)} ${f(k)} 0 0 1 ${f(x1)} ${f(y0 + k)}` +
        `V${f(y1 - k)}A${f(k)} ${f(k)} 0 0 1 ${f(x1 - k)} ${f(y1)}` +
        `H${f(x0 + k)}A${f(k)} ${f(k)} 0 0 1 ${f(x0)} ${f(y1 - k)}` +
        `V${f(y0 + k)}A${f(k)} ${f(k)} 0 0 1 ${f(x0 + k)} ${f(y0)}Z`
      );
    }
  }
}

/** The buffer's stroke: the box (open on the left in infinite mode) and its dividers at ⅓ and ⅔. */
export function bufferStrokePath(cx: number, cy: number, w: number, h: number, infinite: boolean): string {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const x1 = cx + w / 2;
  const y1 = cy + h / 2;
  const box = infinite ? `M${f(x0)} ${f(y0)}H${f(x1)}V${f(y1)}H${f(x0)}` : `M${f(x0)} ${f(y0)}H${f(x1)}V${f(y1)}H${f(x0)}Z`;
  const d1 = x0 + w / 3;
  const d2 = x0 + (2 * w) / 3;
  return `${box}M${f(d1)} ${f(y0)}V${f(y1)}M${f(d2)} ${f(y0)}V${f(y1)}`;
}

/** The buffer's fill: the whole box, or in infinite mode only its right ⅔. */
export function bufferFillPath(cx: number, cy: number, w: number, h: number, infinite: boolean): string {
  const x0 = infinite ? cx - w / 2 + w / 3 : cx - w / 2;
  return `M${f(x0)} ${f(cy - h / 2)}H${f(cx + w / 2)}V${f(cy + h / 2)}H${f(x0)}Z`;
}

/** `LinkGeometry.strokePath`: from `start` to `base` along the route. `dx`, `dy` shift every point. */
export function linkStrokeD(g: LinkGeometry, dx = 0, dy = 0): string {
  const p = (q: { x: number; y: number }) => `${f(q.x - dx)} ${f(q.y - dy)}`;
  const r = g.route;
  if (r.kind === "quad") return `M${p(g.start)}Q${p(r.control)} ${p(g.base)}`;
  if (r.kind === "cubic") return `M${p(g.start)}C${p(r.c1)} ${p(r.c2)} ${p(g.base)}`;
  return `M${p(g.start)}L${p(g.base)}`;
}

/** `LinkGeometry.arrowPath`: the closed triangle tip → wingLeft → wingRight. */
export function linkArrowD(g: LinkGeometry, dx = 0, dy = 0): string {
  const p = (q: { x: number; y: number }) => `${f(q.x - dx)} ${f(q.y - dy)}`;
  return `M${p(g.tip)}L${p(g.wingLeft)}L${p(g.wingRight)}Z`;
}
