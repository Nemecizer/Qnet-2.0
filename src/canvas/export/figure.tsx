// The figure every diagram export draws (0.90.34 `CanvasImageExport.snapshot`, `contentRect`,
// `CanvasSnapshotView`; docs/specs/canvas.md §18; ledger CAN-185…188, FILE-059/060): the canvas's
// own layers, rendered with `snapshot` (no selection, hover, marquee or gesture) in the light
// colours with standard contrast, into one standalone SVG string that Rust turns into a PDF or
// a PNG. It is the same drawing as the screen, so a figure can't drift from it.
//
// Geometry, as 0.90.34 had it: the content rect is measured on a zoom-1, no-pan scene (bodies,
// label blocks and every routed polyline point, grown by 16 pt); the figure is content × zoom plus
// a 24 pt margin all round, plus a 32 pt band under it for the class legend when it is drawn; the
// export zoom is 1; the scene uses the canvas's route plan and class filter.
import { renderToStaticMarkup } from "react-dom/server";
import type { BnetLink, BnetNode } from "../../lib/bnet";
import type { Editor, EditorView } from "../../editor";
import { NO_GUIDES } from "../../editor";
import { buildScene, sceneContentRect } from "../geometry/scene";
import { makeTransform } from "../geometry/transform";
import { canvasColors, classColor, type CanvasColors } from "../layers/colors";
import { CANVAS_FONT, textWidth } from "../layers/text";
import { FigureLayers } from "./layers";
import type { ExportOptions } from "./options";
import { exportWords as w } from "./words";

/** DS.Spacing.xl: the margin round the drawing, so labels, badges and bows are never clipped. */
export const FIGURE_MARGIN = 24;
/** DS.Layout.controlHeight + DS.Spacing.s: the band under the drawing that holds the legend. */
export const LEGEND_BAND = 32;
/** Paper: the one literal white (0.90.34 `paperWhite`). */
export const PAPER_WHITE = "#ffffff";

// The legend chips (0.90.34 `DSBadge(swatch: true)`): DS.Layout.chipHeight, DS.Spacing.s apart.
const CHIP_HEIGHT = 20;
const CHIP_GAP = 8;
const CHIP_PAD = 8;
const CHIP_SWATCH = 8;
const CHIP_TEXT = 11;

export interface FigureRequest {
  options: ExportOptions;
  /** Only these nodes and the links between them (Copy as Image with a selection). */
  only?: ReadonlySet<string> | null;
  /** What a transparent ground becomes where the output can't carry alpha (PNG, TIFF). */
  opaqueFallback: boolean;
  zoom?: number;
}

export interface Figure {
  svg: string;
  /** Points. */
  width: number;
  height: number;
  /** Nodes drawn: the selection's size, or every node. */
  nodeCount: number;
  isSelection: boolean;
}

/** The part of the network to draw: everything, or the selection and the links inside it. */
export function figureSubject(editor: Editor, only?: ReadonlySet<string> | null): { nodes: readonly BnetNode[]; links: readonly BnetLink[]; isSelection: boolean } {
  if (only && only.size) {
    return {
      nodes: editor.nodes.filter((n) => only.has(n.id)),
      links: editor.links.filter((l) => only.has(l.fromNodeID) && only.has(l.toNodeID)),
      isSelection: true,
    };
  }
  return { nodes: editor.nodes, links: editor.links, isSelection: false };
}

/** The view a snapshot draws with: nothing selected, hovered, pending or guided. */
export function snapshotView(view: EditorView): EditorView {
  return {
    ...view,
    selectedNodeID: null,
    selectedNodeIDs: new Set(),
    selectedLinkID: null,
    multiSelectRect: null,
    multiSelectOrigin: null,
    pendingLinkStartID: null,
    pendingLinkPoint: null,
    hoveredNodeID: null,
    hoveredLinkID: null,
    isDraggingNode: false,
    isPanningCanvas: false,
    activeAlignGuides: NO_GUIDES,
  };
}

/** The ground: the canvas's own (light `surfaceRaised`), paper white, or none. */
export function groundColour(options: ExportOptions, colors: CanvasColors, opaqueFallback: boolean): string | null {
  if (options.background === "canvas") return colors.background;
  if (options.background === "white") return PAPER_WHITE;
  return opaqueFallback ? PAPER_WHITE : null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (x: number) => String(Math.round(x * 1000) / 1000);

function legend(classCount: number, height: number, colors: CanvasColors): string {
  const y = height - FIGURE_MARGIN - CHIP_HEIGHT;
  let x = FIGURE_MARGIN;
  const chips: string[] = [];
  for (let i = 0; i < classCount; i++) {
    const label = w.classLabel(i);
    const width = CHIP_PAD + CHIP_SWATCH + 6 + textWidth(label, CHIP_TEXT, 500) + CHIP_PAD;
    chips.push(
      `<g data-legend-chip="${i}">` +
        `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${CHIP_HEIGHT}" rx="${CHIP_HEIGHT / 2}" fill="${colors.chipFill}" stroke="${colors.separator}" stroke-width="${colors.hairline}"/>` +
        `<rect x="${num(x + CHIP_PAD)}" y="${num(y + (CHIP_HEIGHT - CHIP_SWATCH) / 2)}" width="${CHIP_SWATCH}" height="${CHIP_SWATCH}" rx="2" fill="${classColor(colors, i)}"/>` +
        `<text x="${num(x + CHIP_PAD + CHIP_SWATCH + 6)}" y="${num(y + CHIP_HEIGHT / 2 + CHIP_TEXT * 0.35)}" font-size="${CHIP_TEXT}" font-weight="500" fill="${colors.textPrimary}">${esc(label)}</text>` +
        `</g>`,
    );
    x += width + CHIP_GAP;
  }
  return `<g data-layer="legend">${chips.join("")}</g>`;
}

/** The figure, or null when there is nothing to draw. */
export function buildFigure(editor: Editor, req: FigureRequest): Figure | null {
  const zoom = req.zoom ?? 1;
  const subject = figureSubject(editor, req.only);
  // The routes the canvas shows, so a selection keeps the bows it has on screen.
  const plan = editor.routePlan;
  const content = sceneContentRect(subject.nodes, subject.links, plan);
  if (!content) return null;
  const classCount = req.options.includesLegend ? editor.numberOfCustomerClasses : 0;
  const band = classCount > 1 ? LEGEND_BAND : 0;
  const width = content.width * zoom + 2 * FIGURE_MARGIN;
  const height = content.height * zoom + 2 * FIGURE_MARGIN + band;
  const size = { width, height };
  const transform = makeTransform(zoom, { width: FIGURE_MARGIN - content.x * zoom, height: FIGURE_MARGIN - content.y * zoom }, size);
  const scene = buildScene({ nodes: subject.nodes, links: subject.links, transform, classFilter: editor.view.classFilter, routePlan: plan });
  const colors = canvasColors("light", false);
  const ground = groundColour(req.options, colors, req.opaqueFallback);
  const layers = renderToStaticMarkup(
    <FigureLayers editor={editor} scene={scene} view={snapshotView(editor.view)} colors={colors} showsGrid={req.options.includesGrid} />,
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}" font-family="${esc(CANVAS_FONT)}">` +
    (ground ? `<rect data-layer="ground" x="0" y="0" width="${num(width)}" height="${num(height)}" fill="${ground}"/>` : "") +
    layers +
    (classCount > 1 ? legend(classCount, height, colors) : "") +
    `</svg>`;
  return { svg, width, height, nodeCount: subject.nodes.length, isSelection: subject.isSelection };
}
