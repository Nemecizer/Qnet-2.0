// The results layer of the canvas's SVG (new in 2.1, ROADMAP B2): for every station the shown run
// has a value for, a ring in the scale's colour around the body and a value badge above it; the
// bottleneck's badge carries a marker.
//
// Drawn inside the node layer's coordinates — a group translated by the pan, each badge at its
// node's display centre — so a pan re-renders nothing here and a drag re-renders only the dragged
// node's badge (each is memoised on plain values). The badge is laid out in display points at a
// fixed size, so it reads the same at every zoom from `BADGE_MIN_SCALE` up; below that only the
// rings (and the bottleneck's marker) stay, as node labels drop out below their own zoom. Pure
// like the rest of SceneLayers: no effect, no DOM read, so the export renders it as it is.
import { memo, useMemo } from "react";
import type { NodeKind } from "../../lib/bnet";
import { outlineSize, SINK_CORNER_RADIUS } from "../geometry/outline";
import type { CanvasScene } from "../geometry/scene";
import type { CanvasColors } from "../layers/colors";
import { outlinePath } from "../layers/shapes";
import { BADGE_SIZE, CANVAS_FONT, lineHeight, textWidth } from "../layers/text";
import type { OverlayItem, OverlayModel } from "./model";
import { resultScale, ringWidth } from "./scale";
import { overlayWords as w } from "./words";

export interface CanvasResults {
  model: OverlayModel;
  /** "Color Stations": ring each station in the scale's colour. */
  color: boolean;
}

/** Below this zoom the badges' text is dropped (a 48-pt station is under 22 px wide). */
export const BADGE_MIN_SCALE = 0.45;
/** Below this zoom the badge drops the "± x" (it stays in the tooltip), so neighbours' badges don't meet. */
export const INTERVAL_MIN_SCALE = 0.8;
/** The gap between a body's top and its badge (clear of the ρ badge on the corner). */
export const BADGE_GAP = 10;
export const BADGE_HEIGHT = lineHeight(BADGE_SIZE) + 4;
/** How far outside the body the ring's centre line runs (outside the selection ring). */
const RING_OFFSET = 7.5;
/** What a stale overlay is dimmed to. */
export const STALE_OPACITY = 0.55;
const PAD = 6;
const SWATCH = 7;
const MARKER = 8;
const GAP = 4;

const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface BadgeProps {
  id: string;
  kind: NodeKind;
  /** Display centre of the node, relative to the layer's origin (the pan). */
  x: number;
  y: number;
  scale: number;
  item: OverlayItem;
  /** The scale's colour for this value; null when stations are not coloured. */
  color: string | null;
  marker: string;
  stale: boolean;
  colors: CanvasColors;
  live: boolean;
}

/** The badge's width for its content (the layout is the same on the server and on screen). */
export function badgeWidth(item: OverlayItem, hasSwatch: boolean, withText: boolean, withInterval = true): number {
  let width = 2 * PAD;
  const parts: number[] = [];
  if (hasSwatch && withText) parts.push(SWATCH);
  if (item.bottleneck) parts.push(MARKER);
  if (withText) {
    parts.push(textWidth(item.number, BADGE_SIZE, 600));
    if (item.plusMinus && withInterval) parts.push(textWidth(item.plusMinus, BADGE_SIZE, 400));
    if (item.unit) parts.push(textWidth(item.unit, BADGE_SIZE, 500));
  }
  width += parts.reduce((s, p) => s + p, 0) + GAP * Math.max(0, parts.length - 1);
  return width;
}

function BadgeImpl({ id, kind, x, y, scale: s, item, color, marker, stale, colors: c, live }: BadgeProps) {
  const os = outlineSize(kind);
  const bw = os.width * s;
  const bh = os.height * s;
  const withText = s >= BADGE_MIN_SCALE;
  const showsBadge = withText || item.bottleneck;
  const withInterval = withText && item.plusMinus !== null && s >= INTERVAL_MIN_SCALE;
  const width = badgeWidth(item, color !== null, withText, withInterval);
  const top = y - bh / 2 - BADGE_GAP - BADGE_HEIGHT;
  const mid = top + BADGE_HEIGHT / 2;
  let at = x - width / 2 + PAD;
  const swatchAt = color !== null && withText ? at : null;
  if (swatchAt !== null) at += SWATCH + GAP;
  const markerAt = item.bottleneck ? at : null;
  if (markerAt !== null) at += MARKER + GAP;
  const textAt = at;
  const pmAt = textAt + textWidth(item.number, BADGE_SIZE, 600) + GAP;
  const unitAt = withInterval ? pmAt + textWidth(item.plusMinus!, BADGE_SIZE, 400) + GAP : pmAt;
  const text = { fontFamily: CANVAS_FONT, fontSize: BADGE_SIZE, dominantBaseline: "central" as const, pointerEvents: "none" as const, style: { fontVariantNumeric: "tabular-nums" } };
  return (
    <g
      data-result={id}
      data-bottleneck={item.bottleneck ? (item.tied ? "tied" : "true") : undefined}
      data-stale={stale || undefined}
      className={live ? "canvas-appear" : undefined}
      role={live ? "img" : undefined}
      aria-label={live ? item.label : undefined}
      opacity={stale ? STALE_OPACITY : undefined}
    >
      {live && <title>{item.lines.join("\n")}</title>}
      {color !== null && (
        <path
          data-part="result-ring"
          d={outlinePath(kind, x, y, bw + 2 * RING_OFFSET, bh + 2 * RING_OFFSET, SINK_CORNER_RADIUS * s + RING_OFFSET)}
          fill="none"
          stroke={color}
          strokeWidth={r3(ringWidth(item.intensity))}
          strokeDasharray={stale ? "5 4" : undefined}
          pointerEvents="none"
        />
      )}
      {showsBadge && (
        <g data-part="result-badge">
          <rect
            x={r3(x - width / 2)}
            y={r3(top)}
            width={r3(width)}
            height={BADGE_HEIGHT}
            rx={BADGE_HEIGHT / 2}
            fill={c.chipFill}
            stroke={item.bottleneck ? marker : c.separator}
            strokeWidth={item.bottleneck ? 1.5 : c.hairline}
          />
          {swatchAt !== null && <circle data-part="result-swatch" cx={r3(swatchAt + SWATCH / 2)} cy={r3(mid)} r={SWATCH / 2} fill={color!} pointerEvents="none" />}
          {markerAt !== null && (
            <path
              data-part="bottleneck"
              d={`M${r3(markerAt)} ${r3(mid + 3.5)}L${r3(markerAt + MARKER / 2)} ${r3(mid - 4)}L${r3(markerAt + MARKER)} ${r3(mid + 3.5)}Z`}
              fill={marker}
              pointerEvents="none"
            />
          )}
          {withText && (
            <text data-part="result-value" x={r3(textAt)} y={r3(mid)} fontWeight={600} fill={c.textPrimary} {...text}>
              {item.number}
            </text>
          )}
          {withText && item.unit && (
            <text data-part="result-unit" x={r3(unitAt)} y={r3(mid)} fontWeight={500} fill={c.textPrimary} {...text}>
              {item.unit}
            </text>
          )}
          {withInterval && (
            <text data-part="result-interval" x={r3(pmAt)} y={r3(mid)} fontWeight={400} fill={c.textSecondary} {...text}>
              {item.plusMinus}
            </text>
          )}
        </g>
      )}
    </g>
  );
}

const Badge = memo(BadgeImpl);

export interface ResultsLayerProps {
  scene: CanvasScene;
  results: CanvasResults;
  colors: CanvasColors;
  /** False in a snapshot (the export): no tooltips, no accessibility elements, no fade. */
  live: boolean;
}

export function ResultsLayer({ scene, results, colors, live }: ResultsLayerProps) {
  const { model, color } = results;
  const scale = resultScale(colors.theme, colors.contrast);
  // One colour per station, worked out when the run, metric or theme changes, not per frame.
  const ringColors = useMemo(() => {
    const out = new Map<string, string>();
    if (color) for (const [id, item] of model.items) out.set(id, scale.color(item.intensity, model.fixedScale));
    return out;
  }, [model, color, scale]);
  if (!model.items.size) return null;
  const t = scene.transform;
  return (
    <g
      data-layer="results"
      data-metric={model.metric}
      data-stale={model.stale || undefined}
      role={live ? "group" : undefined}
      aria-label={live ? w.layerLabel(model.metric, model.method, w.tier[model.tier]) : undefined}
      aria-description={live && model.stale ? w.stale : undefined}
      transform={t.pan.width || t.pan.height ? `translate(${r3(t.pan.width)} ${r3(t.pan.height)})` : undefined}
    >
      {scene.nodes.map((n) => {
        if (n.kind !== "station") return null;
        const key = n.id.toUpperCase();
        const item = model.items.get(key);
        if (!item) return null;
        const d = scene.displayCentres.get(n.id)!;
        return (
          <Badge
            key={n.id}
            id={n.id}
            kind={n.kind}
            x={r3(d.x - t.pan.width)}
            y={r3(d.y - t.pan.height)}
            scale={t.scale}
            item={item}
            color={ringColors.get(key) ?? null}
            marker={scale.marker}
            stale={model.stale}
            colors={colors}
            live={live}
          />
        );
      })}
    </g>
  );
}
