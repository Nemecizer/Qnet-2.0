// GridCanvas (0.90.34 NetworkCanvasLayers.swift; canvas.md §8; ledger CAN-139), drawn from the
// geometry area's GridPath.build (../geometry/grid.ts): minor dots every grid cell and a hairline
// every four, both through the transform, so a snapped node sits on a
// dot at any zoom or pan. Memoised on the transform and size: a node drag never redraws it.
import { memo } from "react";
import { GRID_SPACING, type CanvasTransform } from "../geometry/transform";
import { buildGrid, gridDotsPath, gridLinesPath } from "../geometry/grid";

export interface GridLayerProps {
  transform: CanvasTransform;
  dot: string;
  line: string;
  /** DS.Stroke.hairline. The grid's lines are never stepped for contrast (`DS.Stroke.hairline`, not the adaptive form). */
  hairline?: number;
}

function GridLayerView({ transform, dot, line, hairline = 1 }: GridLayerProps) {
  const g = buildGrid(transform, transform.viewportSize, GRID_SPACING);
  const dots = gridDotsPath(g);
  const lines = gridLinesPath(g);
  if (!dots && !lines) return null;
  return (
    <g data-layer="grid" aria-hidden="true" pointerEvents="none">
      {dots && <path data-part="dots" d={dots} fill={dot} fillOpacity={round(g.minorAlpha)} />}
      {lines && <path data-part="lines" d={lines} fill="none" stroke={line} strokeOpacity={round(g.majorAlpha)} strokeWidth={hairline} />}
    </g>
  );
}

const round = (x: number) => Math.round(x * 1000) / 1000;

const sameTransform = (a: CanvasTransform, b: CanvasTransform) =>
  a.scale === b.scale && a.pan.width === b.pan.width && a.pan.height === b.pan.height && a.viewportSize.width === b.viewportSize.width && a.viewportSize.height === b.viewportSize.height;

export const GridLayer = memo(GridLayerView, (a, b) => sameTransform(a.transform, b.transform) && a.dot === b.dot && a.line === b.line && a.hairline === b.hairline);
