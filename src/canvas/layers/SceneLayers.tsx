// The canvas's picture: one <svg> the size of the viewport with 0.90.34's layers in their order
// (docs/specs/canvas.md §10; NetworkCanvasView.swift `buildBody`). Pure: everything it draws comes
// from its props, it reads no DOM and runs no effect, so the image export renders the very same
// component with react-dom/server. See ./index.ts for the props.
import { useCallback, useId, useRef } from "react";
import type { BnetLink, NodeKind } from "../../lib/bnet";
import type { EditorView } from "../../editor/editor";
import { classLabel } from "../../editor/editor";
import { formatSig } from "../../editor/numbers";
import { marqueeSelects, outlineSize, SINK_CORNER_RADIUS } from "../geometry/outline";
import { lineWidth, type CanvasScene, type LinkGeometry } from "../geometry/scene";
import { rectToDisplay, toDisplay } from "../geometry/transform";
import type { Point } from "../geometry/types";
import { canvasWords as w } from "../words";
import { classColor, kindFill, OPACITY, type CanvasColors } from "./colors";
import { GridLayer } from "./GridLayer";
import { GuideLayer } from "./GuideLayer";
import { LinkLayer } from "./LinkLayer";
import { NodeView } from "./NodeView";
import { ResultsLayer, type CanvasResults } from "../overlay/ResultsLayer";
import { linkArrowD, linkStrokeD, outlinePath } from "./shapes";
import "../canvas.css";

/** The slice of the editor's view state the drawing reads (an `EditorView` will do). */
export type SceneView = Pick<
  EditorView,
  | "tool"
  | "selectedNodeID"
  | "selectedNodeIDs"
  | "selectedLinkID"
  | "hoveredNodeID"
  | "hoveredLinkID"
  | "multiSelectRect"
  | "pendingLinkStartID"
  | "activeLinkSourceID"
  | "activeCustomerClass"
  | "activeAlignGuides"
  | "isDraggingNode"
  | "isPanningCanvas"
  | "isSpacePanning"
>;

/** What only the gesture knows. */
export interface SceneTransient {
  /** The rubber band while a link is drawn, display space; null when none. */
  linkPreview: LinkGeometry | null;
  /** False for the bare line over empty canvas (no target, so no arrowhead). Default true. */
  linkPreviewHasArrow?: boolean;
  /** The node a link drag started from; the pending ring and fill fall back to `view.pendingLinkStartID`. */
  linkStartID?: string | null;
  /** The add tool's placement ghost, world space (already snapped). */
  ghost: { kind: NodeKind; world: Point } | null;
  /** Whether the marquee band is live; it and the candidates' highlight show only then. Default: whenever `view.multiSelectRect` is set. */
  marqueeLive: boolean;
}

export const NO_TRANSIENT: SceneTransient = Object.freeze({ linkPreview: null, ghost: null, marqueeLive: true });

export interface SceneLayersProps {
  scene: CanvasScene;
  view: SceneView;
  colors: CanvasColors;
  transient?: SceneTransient;
  /** The export's frozen copy: no hover, selection, marquee, guides, link preview, ghost or accessibility elements. */
  snapshot?: boolean;
  /** The document's buffer regime (the buffer's open box, the b=N row). */
  infiniteBuffers: boolean;
  /** Station id → ρ for the badges (analysis.ts `useStationUtilisation`); a station without an entry has none. */
  utilisation?: Readonly<Record<string, number>>;
  /** The results overlay (../overlay): a run's value beside each station; none by default. */
  results?: CanvasResults | null;
  /** Draw the dot grid (default true; the export's "Include grid"). */
  grid?: boolean;
  /** A ground painted under everything (the export's background); none by default. */
  background?: string | null;
  /** A link's spoken description; pass `editor.linkDescription`. Defaults to the same sentence built from the scene. */
  linkDescription?: (link: BnetLink) => string;
  /** VoiceOver pressed a node or link element (a click with no pointer behind it). */
  onNodePress?: (id: string) => void;
  onLinkPress?: (id: string) => void;
  className?: string;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** editor.linkDescription, from what the scene knows (used when no editor is at hand). */
export function sceneLinkDescription(scene: CanvasScene): (link: BnetLink) => string {
  let classes = scene.nodes.filter((n) => n.kind === "source").length;
  for (const { link } of scene.links) classes = Math.max(classes, link.customerClass + 1, (link.toCustomerClass ?? -1) + 1);
  return (link) => {
    const parts = [classes > 1 ? `${classLabel(link.customerClass)} link` : "Link"];
    parts.push(`${scene.nodeIndex.get(link.fromNodeID)?.name ?? "?"} to ${scene.nodeIndex.get(link.toNodeID)?.name ?? "?"}`);
    if (link.routingProbability !== 1.0) parts.push(`routing probability ${formatSig(link.routingProbability, 3)}`);
    if (link.toCustomerClass !== undefined && link.toCustomerClass !== link.customerClass) parts.push(`exits as ${classLabel(link.toCustomerClass)}`);
    return parts.join(", ");
  };
}

/** A callback whose identity never changes, so memoised children don't re-render for a new closure. */
function useStable<A extends unknown[]>(f: ((...a: A) => void) | undefined): ((...a: A) => void) | undefined {
  const ref = useRef(f);
  ref.current = f;
  const stable = useCallback((...a: A) => ref.current?.(...a), []);
  return f ? stable : undefined;
}

export function SceneLayers(props: SceneLayersProps) {
  const { scene, view, colors: c, snapshot = false, infiniteBuffers, utilisation, grid = true, background = null } = props;
  const transient = props.transient ?? NO_TRANSIENT;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const glowId = `${uid}-glow`;
  const onNodePress = useStable(props.onNodePress);
  const onLinkPress = useStable(props.onLinkPress);
  const describeRef = useRef(props.linkDescription);
  describeRef.current = props.linkDescription;

  const t = scene.transform;
  const s = t.scale;
  const { width, height } = t.viewportSize;
  const live = !snapshot;
  const interacting = view.isDraggingNode || view.isPanningCanvas;

  const chainClass = view.tool === "addLink" && view.activeLinkSourceID !== null ? view.activeCustomerClass : null;
  const chainColor = view.activeLinkSourceID !== null ? classColor(c, view.activeCustomerClass) : c.accent;
  const linkStartID = transient.linkStartID ?? view.pendingLinkStartID;
  const marquee = live && view.multiSelectRect && transient.marqueeLive !== false ? view.multiSelectRect : null;

  const linkState = live
    ? { selectedLinkID: view.selectedLinkID, hoveredLinkID: view.hoveredLinkID, emphasisedClass: chainClass }
    : { selectedLinkID: null, hoveredLinkID: null, emphasisedClass: null };

  const describe = describeRef.current ?? sceneLinkDescription(scene);

  return (
    <svg
      className={props.className}
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={live ? "group" : "img"}
      aria-label={live ? w.canvasLabel : undefined}
      data-snapshot={snapshot || undefined}
    >
      <defs>
        <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor={c.selectionGlow} />
        </filter>
      </defs>
      {background && <rect data-layer="background" x="0" y="0" width={width} height={height} fill={background} />}
      {grid && <GridLayer transform={t} dot={c.gridDot} line={c.gridLine} />}
      <LinkLayer scene={scene} state={linkState} colors={c} idPrefix={uid} a11y={live && !interacting ? { describe, onPress: onLinkPress } : null} />
      {live && transient.linkPreview && <LinkPreview g={transient.linkPreview} arrow={transient.linkPreviewHasArrow !== false} scale={s} color={chainColor} />}
      {live && view.tool === "addLink" && linkStartID && <PendingRing scene={scene} id={linkStartID} color={chainColor} />}
      {live && transient.ghost && !view.isSpacePanning && <Ghost kind={transient.ghost.kind} at={toDisplay(t, transient.ghost.world)} scale={s} colors={c} />}
      <g data-layer="nodes" role={live ? "group" : undefined} aria-label={live ? w.nodesLabel : undefined} transform={t.pan.width || t.pan.height ? `translate(${r3(t.pan.width)} ${r3(t.pan.height)})` : undefined}>
        {scene.nodes.map((n) => {
          const d = scene.displayCentres.get(n.id)!;
          return (
            <NodeView
              key={n.id}
              node={n}
              x={r3(d.x - t.pan.width)}
              y={r3(d.y - t.pan.height)}
              scale={s}
              isSelected={live && (view.selectedNodeID === n.id || view.selectedNodeIDs.has(n.id))}
              isHovered={live && view.hoveredNodeID === n.id}
              isMarqueeCandidate={!!marquee && marqueeSelects(n, marquee)}
              isPendingLinkStart={live && linkStartID === n.id}
              infiniteBuffers={infiniteBuffers}
              utilisation={utilisation?.[n.id]}
              colors={c}
              live={live}
              glowId={glowId}
              onPress={onNodePress}
            />
          );
        })}
      </g>
      {props.results && <ResultsLayer scene={scene} results={props.results} colors={c} live={live} />}
      {live && <GuideLayer guides={view.activeAlignGuides} transform={t} color={c.accent} hairline={c.hairline} />}
      {marquee && <Marquee rect={rectToDisplay(t, marquee)} fill={c.marqueeFill} stroke={c.accent} hairline={c.hairline} />}
    </svg>
  );
}

/** LinkPreviewCanvas: dashed (6d, 4d; d = max(0.6, scale)) at the real link width, round caps, in the chain's colour. */
function LinkPreview({ g, arrow, scale, color }: { g: LinkGeometry; arrow: boolean; scale: number; color: string }) {
  const d = Math.max(0.6, scale);
  return (
    <g data-layer="link-preview" aria-hidden="true" pointerEvents="none">
      <path d={linkStrokeD(g)} fill="none" stroke={color} strokeWidth={lineWidth(scale)} strokeLinecap="round" strokeDasharray={`${r3(6 * d)} ${r3(4 * d)}`} />
      {arrow && <path data-part="arrow" d={linkArrowD(g)} fill={color} />}
    </g>
  );
}

/** pendingLinkIndicator: a dashed outline 16 pt larger than the body on the chain's start node. */
function PendingRing({ scene, id, color }: { scene: CanvasScene; id: string; color: string }) {
  const node = scene.nodeIndex.get(id);
  const c = scene.displayCentres.get(id);
  if (!node || !c) return null;
  const s = scene.transform.scale;
  const size = outlineSize(node.kind);
  const d = Math.max(0.6, s);
  return (
    <path
      data-layer="pending-ring"
      aria-hidden="true"
      pointerEvents="none"
      d={outlinePath(node.kind, c.x, c.y, size.width * s + 16, size.height * s + 16, SINK_CORNER_RADIUS * s + 8)}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(1.5, 2 * s)}
      strokeDasharray={`${r3(6 * d)} ${r3(4 * d)}`}
    />
  );
}

/** ghostNode: the add tool's node, faint, on the snapped point under the pointer. */
function Ghost({ kind, at, scale: s, colors: c }: { kind: NodeKind; at: Point; scale: number; colors: CanvasColors }) {
  const size = outlineSize(kind);
  const d = Math.max(0.6, s);
  return (
    <path
      data-layer="ghost"
      data-kind={kind}
      aria-hidden="true"
      pointerEvents="none"
      opacity={OPACITY.disabled}
      d={outlinePath(kind, at.x, at.y, size.width * s, size.height * s, SINK_CORNER_RADIUS * s)}
      fill={kindFill(c, kind)}
      stroke={c.nodeStroke}
      strokeWidth={Math.max(1, 1.5 * s)}
      strokeDasharray={`${r3(4 * d)} ${r3(3 * d)}`}
    />
  );
}

/** The rubber band: a 1-pt accent stroke over the marquee fill. */
function Marquee({ rect, fill, stroke, hairline }: { rect: { x: number; y: number; width: number; height: number }; fill: string; stroke: string; hairline: number }) {
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return <rect data-layer="marquee" aria-hidden="true" pointerEvents="none" x={r3(cx - w / 2)} y={r3(cy - h / 2)} width={r3(w)} height={r3(h)} fill={fill} stroke={stroke} strokeWidth={hairline} />;
}
