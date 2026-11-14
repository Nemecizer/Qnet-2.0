// LinkLayerCanvas (0.90.34 NetworkCanvasLayers.swift; canvas.md §10.1; ledger CAN-061, CAN-067…
// CAN-071): every link, its arrowhead and its probability chip, plus the per-link accessibility
// elements (NetworkCanvasView.swift `linkAccessibilityElements`, CAN-201, CAN-202).
//
// Draw order is ordinary links (the scene's order: class ascending), then the hovered link, then
// the selected one. Chips: none below zoom 0.5; above it a chip overlapping one already placed is
// skipped, and the hovered and selected links' chips are reserved first so they always show.
//
// Performance: the layer is drawn inside a group translated by the pan, with every point given
// relative to it, so a pure pan leaves each link's path data unchanged and React skips them all.
import { memo, type MouseEvent } from "react";
import type { BnetLink } from "../../lib/bnet";
import { placeChips } from "../geometry/lod";
import { lineWidth, type CanvasScene, type SceneLink } from "../geometry/scene";
import { classColor, OPACITY, type CanvasColors } from "./colors";
import { linkArrowD, linkStrokeD } from "./shapes";
import { canvasWords } from "../words";
import { lineHeight, linkLabelSize, textWidth, CANVAS_FONT } from "./text";

export interface LinkLayerState {
  selectedLinkID: string | null;
  hoveredLinkID: string | null;
  /** While chain-building with the Link tool, links of other classes dim. */
  emphasisedClass: number | null;
}

/** DS.Radius.swatch + 1. */
const CHIP_RADIUS = 3;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The chip text's size in the chip font (medium weight, tabular digits). */
export const measureChipText = (text: string, size: number) => ({ width: textWidth(text, size, 500), height: lineHeight(size) });

interface LinkViewProps {
  id: string;
  stroke: string;
  arrow: string;
  width: number;
  /** A flat colour, or null with `grad` set. */
  color: string;
  grad: { id: string; x1: number; y1: number; x2: number; y2: number; from: string; to: string } | null;
  opacity: number;
  halo: string | null;
  haloWidth: number;
  chipX: number;
  chipY: number;
  chipW: number;
  chipH: number;
  chipText: string | null;
  chipSize: number;
  chipFill: string;
  chipStroke: string;
  chipInk: string;
  chipOpacity: number;
  hairline: number;
}

function LinkViewImpl(p: LinkViewProps) {
  const paint = p.grad ? `url(#${p.grad.id})` : p.color;
  return (
    <g data-link={p.id}>
      {p.grad && (
        <defs>
          <linearGradient id={p.grad.id} gradientUnits="userSpaceOnUse" x1={p.grad.x1} y1={p.grad.y1} x2={p.grad.x2} y2={p.grad.y2}>
            <stop offset="0" stopColor={p.grad.from} />
            <stop offset="1" stopColor={p.grad.to} />
          </linearGradient>
        </defs>
      )}
      {p.halo && (
        <>
          <path d={p.stroke} fill="none" stroke={p.halo} strokeWidth={p.haloWidth} strokeLinecap="round" strokeLinejoin="round" />
          <path d={p.arrow} fill="none" stroke={p.halo} strokeWidth={p.haloWidth} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      <path data-part="stroke" d={p.stroke} fill="none" stroke={paint} strokeWidth={p.width} strokeLinecap="butt" strokeLinejoin="round" strokeOpacity={p.opacity} />
      <path data-part="arrow" d={p.arrow} fill={paint} fillOpacity={p.opacity} />
      {p.chipText !== null && (
        <g data-part="chip" opacity={p.chipOpacity === 1 ? undefined : p.chipOpacity}>
          <rect x={p.chipX} y={p.chipY} width={p.chipW} height={p.chipH} rx={CHIP_RADIUS} fill={p.chipFill} stroke={p.chipStroke} strokeWidth={p.hairline} />
          <text
            x={r3(p.chipX + p.chipW / 2)}
            y={r3(p.chipY + p.chipH / 2)}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily={CANVAS_FONT}
            fontSize={p.chipSize}
            fontWeight={500}
            fill={p.chipInk}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {p.chipText}
          </text>
        </g>
      )}
    </g>
  );
}

const LinkView = memo(LinkViewImpl, (a, b) => {
  for (const k of Object.keys(a) as (keyof LinkViewProps)[]) {
    if (k === "grad") continue;
    if (a[k] !== b[k]) return false;
  }
  const ga = a.grad;
  const gb = b.grad;
  if (!ga || !gb) return ga === gb;
  return ga.id === gb.id && ga.x1 === gb.x1 && ga.y1 === gb.y1 && ga.x2 === gb.x2 && ga.y2 === gb.y2 && ga.from === gb.from && ga.to === gb.to;
});

export interface LinkLayerProps {
  scene: CanvasScene;
  state: LinkLayerState;
  colors: CanvasColors;
  /** Unique within the page: gradient ids hang off it. */
  idPrefix: string;
  /** The per-link accessibility elements; null drops them (snapshot, or a drag or pan in flight). */
  a11y: { describe: (link: BnetLink) => string; onPress?: (id: string) => void } | null;
}

export function LinkLayer({ scene, state, colors, idPrefix, a11y }: LinkLayerProps) {
  const scale = scene.transform.scale;
  const dx = scene.transform.pan.width;
  const dy = scene.transform.pan.height;
  const isEmph = (id: string) => id === state.selectedLinkID || id === state.hoveredLinkID;

  // The declutter pass is the geometry area's (lod.ts placeChips), with this layer's measure.
  const placed = placeChips(scene.links, { scale, selectedLinkID: state.selectedLinkID, hoveredLinkID: state.hoveredLinkID }, measureChipText);
  const size = linkLabelSize(scale);

  const props = (item: SceneLink): LinkViewProps => {
    const link = item.link;
    const g = item.geometry;
    const selected = state.selectedLinkID === link.id;
    const hovered = state.hoveredLinkID === link.id;
    const dimmed = state.emphasisedClass !== null && link.customerClass !== state.emphasisedClass;
    const fromClass = link.customerClass;
    const toClass = link.toCustomerClass ?? link.customerClass;
    const fromColor = classColor(colors, fromClass);
    const toColor = classColor(colors, toClass);
    let width = lineWidth(scale);
    if (hovered || selected) width = Math.max(3, width * 1.5);
    const grad =
      !selected && fromClass !== toClass
        ? { id: `${idPrefix}-g-${link.id}`, x1: r3(g.start.x - dx), y1: r3(g.start.y - dy), x2: r3(g.tip.x - dx), y2: r3(g.tip.y - dy), from: fromColor, to: toColor }
        : null;
    const chip = placed.get(link.id) ?? null;
    const ink = selected ? colors.accent : hovered ? fromColor : colors.textSecondary;
    return {
      id: link.id,
      stroke: linkStrokeD(g, dx, dy),
      arrow: linkArrowD(g, dx, dy),
      width,
      color: selected ? colors.accent : fromColor,
      grad,
      opacity: dimmed ? OPACITY.dim : hovered || selected ? 1 : OPACITY.linkStroke,
      halo: selected ? colors.linkHalo : null,
      haloWidth: width + 6,
      chipX: chip ? r3(chip.rect.x - dx) : 0,
      chipY: chip ? r3(chip.rect.y - dy) : 0,
      chipW: chip ? r3(chip.rect.width) : 0,
      chipH: chip ? r3(chip.rect.height) : 0,
      chipText: chip ? chip.text : null,
      chipSize: chip ? size : 0,
      chipFill: colors.chipFill,
      chipStroke: hovered || selected ? ink : colors.separator,
      chipInk: ink,
      chipOpacity: dimmed ? OPACITY.dim : 1,
      hairline: colors.hairline,
    };
  };

  const ordinary: LinkViewProps[] = [];
  const deferred: SceneLink[] = [];
  for (const item of scene.links) {
    if (isEmph(item.id)) deferred.push(item);
    else ordinary.push(props(item));
  }
  const last: LinkViewProps[] = [];
  for (const item of deferred) if (item.id !== state.selectedLinkID) last.push(props(item));
  for (const item of deferred) if (item.id === state.selectedLinkID) last.push(props(item));

  return (
    <g data-layer="links" pointerEvents="none">
      <g transform={dx || dy ? `translate(${r3(dx)} ${r3(dy)})` : undefined} aria-hidden="true">
        {ordinary.map((p) => (
          <LinkView key={p.id} {...p} />
        ))}
        {last.map((p) => (
          <LinkView key={p.id} {...p} />
        ))}
      </g>
      {a11y && <LinkA11y scene={scene} selectedLinkID={state.selectedLinkID} describe={a11y.describe} onPress={a11y.onPress} dx={dx} dy={dy} />}
    </g>
  );
}

/** DS.Layout.accessibilityProbeSize: each link's element is a 1-pt probe on its label anchor. */
const PROBE = 1;

function LinkA11y({ scene, selectedLinkID, describe, onPress, dx, dy }: { scene: CanvasScene; selectedLinkID: string | null; describe: (l: BnetLink) => string; onPress?: (id: string) => void; dx: number; dy: number }) {
  const press = (id: string) => (e: MouseEvent) => {
    // VoiceOver's press arrives as a click with no pointer behind it (detail 0); a real click is the canvas's.
    if (e.detail === 0 && onPress) onPress(id);
  };
  return (
    <g role="group" aria-label={canvasWords.linksLabel} data-layer="link-a11y" transform={dx || dy ? `translate(${r3(dx)} ${r3(dy)})` : undefined}>
      {scene.links.map(({ id, link, geometry }) => (
        <rect
          key={id}
          role="button"
          aria-label={describe(link)}
          aria-pressed={selectedLinkID === id}
          x={r3(geometry.labelAnchor.x - dx - PROBE / 2)}
          y={r3(geometry.labelAnchor.y - dy - PROBE / 2)}
          width={PROBE}
          height={PROBE}
          fill="none"
          onClick={press(id)}
        />
      ))}
    </g>
  );
}
