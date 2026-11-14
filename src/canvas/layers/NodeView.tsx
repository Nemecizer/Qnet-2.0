// NetworkNodeView (0.90.34 NetworkCanvasLayers.swift; canvas.md §10.3; ledger CAN-025…CAN-032,
// CAN-034, CAN-135…CAN-137, CAN-140, CAN-156, CAN-158, CAN-200, ANA-189…191).
//
// The body is drawn through the zoom (world size × scale) while the label block below it is laid
// out in display space with a clamped point size. Memoised on its inputs, as 0.90.34's view was
// Equatable on (node, scale, isSelected, isHovered, isMarqueeCandidate, isPendingLinkStart,
// infiniteBuffers, utilisation, contrast): the colours carry the contrast. Its centre is given
// relative to the pan (the node layer is a translated group), so a pan re-renders no node.
import { memo, type MouseEvent } from "react";
import type { BnetNode } from "../../lib/bnet";
import { stationPicture } from "../../editor/pictures";
import { nodeFeatures } from "../../extended/model";
import { LABEL_BLOCK_GAP, outlineSize, SINK_CORNER_RADIUS } from "../geometry/outline";
import { kindFill, type CanvasColors } from "./colors";
import { detailText, nodeDescription, nodeTooltip, rateText, rhoBadgeText, rhoLevel, rhoTooltip } from "./labels";
import { bufferFillPath, bufferStrokePath, outlinePath } from "./shapes";
import {
  BADGE_SIZE,
  CANVAS_FONT,
  detailSize,
  DETAIL_ROW_MIN_SCALE,
  labelBlockDisplayWidth,
  lineHeight,
  nameSize,
  NAME_ROW_MIN_SCALE,
  RATE_ROW_MIN_SCALE,
  textWidth,
  truncate,
  type Weight,
} from "./text";

export interface NodeViewProps {
  node: BnetNode;
  /** Display centre, relative to the node layer's origin (the pan). */
  x: number;
  y: number;
  scale: number;
  isSelected: boolean;
  isHovered: boolean;
  isMarqueeCandidate: boolean;
  isPendingLinkStart: boolean;
  infiniteBuffers: boolean;
  utilisation: number | undefined;
  colors: CanvasColors;
  /** False in a snapshot: no rings, no tooltip, no accessibility element. */
  live: boolean;
  /** The selection glow's filter id. */
  glowId: string;
  onPress?: (id: string) => void;
}

/** DS.Spacing.s: the ρ badge's offset from the body's top-right corner. */
const BADGE_OFFSET = 8;
/** The SF caption's ascent, as a fraction of the size (text baselines from row tops). */
const ASCENT = 0.95;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function NodeViewImpl(p: NodeViewProps) {
  const { node, x, y, scale: s, colors: c } = p;
  const os = outlineSize(node.kind);
  const w = os.width * s;
  const h = os.height * s;
  const strokeWidth = Math.max(1, 2 * s);
  const fill = p.isPendingLinkStart ? c.selectionFillStrong : kindFill(c, node.kind);
  const border = p.isSelected ? c.accent : c.nodeStroke;
  const showsHoverRing = p.live && (p.isHovered || p.isMarqueeCandidate) && !p.isSelected;

  const label = nodeDescription(node, p.infiniteBuffers, p.utilisation);
  const press = (e: MouseEvent) => {
    if (e.detail === 0 && p.onPress) p.onPress(node.id);
  };

  return (
    <g
      data-node={node.id}
      data-kind={node.kind}
      role={p.live ? "button" : undefined}
      aria-label={p.live ? label : undefined}
      aria-pressed={p.live ? p.isSelected : undefined}
      onClick={p.live ? press : undefined}
    >
      {p.live && <title>{nodeTooltip(node, p.infiniteBuffers, p.utilisation)}</title>}
      {p.live && (
        <>
          <path
            data-part="hover-ring"
            className="canvas-fade"
            d={outlinePath(node.kind, x, y, w + 6, h + 6, SINK_CORNER_RADIUS * s + 3)}
            fill="none"
            stroke={c.hoverRing}
            strokeWidth={c.hairline}
            opacity={showsHoverRing ? 1 : 0}
            pointerEvents="none"
          />
          <path
            data-part="selection-ring"
            className="canvas-fade"
            d={outlinePath(node.kind, x, y, w + 8, h + 8, SINK_CORNER_RADIUS * s + 4)}
            fill="none"
            stroke={c.accentStroke}
            strokeWidth={1.5}
            filter={p.isSelected ? `url(#${p.glowId})` : undefined}
            opacity={p.isSelected ? 1 : 0}
            pointerEvents="none"
          />
        </>
      )}
      <Body {...p} w={w} h={h} strokeWidth={strokeWidth} fill={fill} border={border} />
      <LabelBlock {...p} top={y + h / 2 + LABEL_BLOCK_GAP} />
      {p.utilisation !== undefined && <RhoBadge rho={p.utilisation} right={x + w / 2 + BADGE_OFFSET} top={y - h / 2 - BADGE_OFFSET} colors={c} live={p.live} />}
      <FeatureMarks node={node} left={x - w / 2 - BADGE_OFFSET} bottom={y + h / 2 + BADGE_OFFSET / 2} colors={c} live={p.live} />
    </g>
  );
}

/**
 * The marks of the model features new in 2.1 (priority service, batch arrivals, a rate profile;
 * src/extended): small lettered capsules at the body's bottom-left corner (the ρ badge has the
 * top right, a problem's badge the top left).
 * A mark is a letter in an outlined capsule on the canvas ground, never a colour alone, and the
 * node's description and tooltip say the same in words.
 */
function FeatureMarks({ node, left, bottom, colors: c, live }: { node: BnetNode; left: number; bottom: number; colors: CanvasColors; live: boolean }) {
  const marks = nodeFeatures(node);
  if (!marks.length) return null;
  const h = lineHeight(BADGE_SIZE) + 2;
  const top = bottom - h;
  let at = left;
  return (
    <g data-part="features" aria-hidden="true">
      {marks.map((m) => {
        const w = textWidth(m.glyph, BADGE_SIZE, 600) + 2 * 5;
        const x0 = at;
        at += w + 3;
        return (
          <g key={m.feature} data-feature={m.feature}>
            {live && <title>{m.label}</title>}
            <rect x={r3(x0)} y={r3(top)} width={r3(w)} height={h} rx={3} fill={c.chipFill} stroke={c.nodeStroke} strokeWidth={c.hairline} />
            <text x={r3(x0 + w / 2)} y={r3(top + h / 2)} textAnchor="middle" dominantBaseline="central" fontFamily={CANVAS_FONT} fontSize={BADGE_SIZE} fontWeight={600} fill={c.textPrimary} pointerEvents="none">
              {m.glyph}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Body({ node, x, y, w, h, scale: s, strokeWidth, fill, border, infiniteBuffers, colors }: NodeViewProps & { w: number; h: number; strokeWidth: number; fill: string; border: string }) {
  switch (node.kind) {
    case "station": {
      const pic = stationPicture(node.picture);
      const Glyph = pic.icon;
      const pad = w * 0.18;
      const side = w - 2 * pad;
      return (
        <g data-part="body">
          <path d={outlinePath("station", x, y, w, h, 0)} fill={fill} stroke={border} strokeWidth={strokeWidth} />
          {Glyph && side > 0 && (
            <Glyph data-part="picture" data-picture={pic.sf} x={r3(x - side / 2)} y={r3(y - side / 2)} width={r3(side)} height={r3(side)} color={colors.nodeGlyph} strokeWidth={2} aria-hidden="true" focusable="false" pointerEvents="none" />
          )}
        </g>
      );
    }
    case "buffer":
      return (
        <g data-part="body">
          <path d={bufferFillPath(x, y, w, h, infiniteBuffers)} fill={fill} />
          <path data-part="buffer-outline" d={bufferStrokePath(x, y, w, h, infiniteBuffers)} fill="none" stroke={border} strokeWidth={strokeWidth} />
        </g>
      );
    case "source":
      return <path data-part="body" d={outlinePath("source", x, y, w, h, 0)} fill={fill} stroke={border} strokeWidth={strokeWidth} />;
    case "sink":
      return <path data-part="body" d={outlinePath("sink", x, y, w, h, SINK_CORNER_RADIUS * s)} fill={fill} stroke={border} strokeWidth={strokeWidth} />;
  }
}

interface Row {
  text: string;
  size: number;
  weight: Weight;
  color: string;
  part: string;
}

/** Name / detail / rate rows, each dropped below its zoom; a hovered or selected node keeps its name. */
function LabelBlock({ node, x, scale: s, isHovered, isSelected, infiniteBuffers, colors, top }: NodeViewProps & { top: number }) {
  const width = labelBlockDisplayWidth(s);
  const rows: Row[] = [];
  if (s >= NAME_ROW_MIN_SCALE || isHovered || isSelected) {
    const size = nameSize(s);
    rows.push({ text: truncate(node.name, width, size, 600, "middle"), size, weight: 600, color: colors.textPrimary, part: "name" });
  }
  const detail = s >= DETAIL_ROW_MIN_SCALE ? detailText(node, infiniteBuffers) : null;
  if (detail) {
    const size = detailSize(s);
    rows.push({ text: truncate(detail, width, size, 400, "tail"), size, weight: 400, color: colors.textSecondary, part: "detail" });
  }
  const rates = s >= RATE_ROW_MIN_SCALE ? rateText(node) : null;
  if (rates) {
    const size = detailSize(s);
    rows.push({ text: truncate(rates, width, size, 500, "tail"), size, weight: 500, color: colors.textSecondary, part: "rates" });
  }
  if (!rows.length) return null;
  let at = top;
  return (
    <g data-part="labels" pointerEvents="none" aria-hidden="true" fontFamily={CANVAS_FONT} textAnchor="middle" style={{ fontVariantNumeric: "tabular-nums" }}>
      {rows.map((r, i) => {
        const baseline = at + r.size * ASCENT;
        at += lineHeight(r.size) + 1;
        return (
          <text key={i} data-part={r.part} x={r3(x)} y={r3(baseline)} fontSize={r.size} fontWeight={r.weight} fill={r.color}>
            {r.text}
          </text>
        );
      })}
    </g>
  );
}

/** The ρ capsule: legible tint of the signal colour, the on-tint ink, a separator hairline. */
function RhoBadge({ rho, right, top, colors: c, live }: { rho: number; right: number; top: number; colors: CanvasColors; live: boolean }) {
  const text = rhoBadgeText(rho);
  const level = rhoLevel(rho);
  const tint = level === "heavy" ? c.rhoHeavy : level === "moderate" ? c.rhoModerate : c.rhoLight;
  const w = textWidth(text, BADGE_SIZE, 600) + 2 * 5;
  const h = lineHeight(BADGE_SIZE) + 2;
  const x0 = right - w;
  return (
    <g data-part="rho" data-level={level} className={live ? "canvas-appear" : undefined} aria-hidden="true">
      {live && <title>{rhoTooltip(rho)}</title>}
      <rect x={r3(x0)} y={r3(top)} width={r3(w)} height={h} rx={h / 2} fill={tint} stroke={c.separator} strokeWidth={c.hairline} />
      <text
        x={r3(x0 + w / 2)}
        y={r3(top + h / 2)}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily={CANVAS_FONT}
        fontSize={BADGE_SIZE}
        fontWeight={600}
        fill={c.onTint}
        pointerEvents="none"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {text}
      </text>
    </g>
  );
}

export const NodeView = memo(NodeViewImpl);
