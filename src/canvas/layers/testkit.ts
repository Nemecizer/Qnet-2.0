// Test helpers for the drawing: the shipped examples as documents (with 0.90.34's decodeIfPresent
// defaults, which Rust applies when it opens a file), a scene at a zoom, and a quiet view.
import type { BnetDocument, BnetLink, BnetNode } from "../../lib/bnet";
import { NO_GUIDES, type EditorView } from "../../editor/editor";
import { buildRoutePlan, buildScene, type CanvasScene } from "../geometry/scene";
import { makeTransform } from "../geometry/transform";
import type { SceneView } from "./SceneLayers";

const raw = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const EXAMPLE_NAMES = Object.keys(raw)
  .map((k) => k.split("/").pop()!)
  .sort();

/** A shipped example, with every field 0.90.34 decoded with a default filled in. */
export function example(name: string): BnetDocument {
  const key = Object.keys(raw).find((k) => k.endsWith(`/${name}`));
  if (!key) throw new Error(`no example ${name}`);
  const d = JSON.parse(raw[key]) as { infiniteBuffers?: boolean; canvasScale?: number; canvasPanOffset?: [number, number]; nodes: Partial<BnetNode>[]; links: Partial<BnetLink>[] };
  return {
    infiniteBuffers: d.infiniteBuffers ?? false,
    canvasScale: d.canvasScale ?? 1,
    canvasPanOffset: d.canvasPanOffset ?? [0, 0],
    nodes: d.nodes.map((n) => ({
      bufferSize: 1,
      distribution: "exponential",
      distributionParameters: "rate=1.0",
      numberOfServers: 1,
      serviceDistributions: {},
      picture: "",
      ...n,
    })) as BnetNode[],
    links: d.links.map((l) => ({ routingProbability: 1, customerClass: 0, ...l })) as BnetLink[],
  };
}

/** The scene of `doc` at `scale` and `pan`, in a 1600 × 1000 viewport. */
export function sceneOf(doc: BnetDocument, scale = 1, pan: [number, number] = [0, 0], classFilter: number | null = null, size: [number, number] = [1600, 1000]): CanvasScene {
  return buildScene({
    nodes: doc.nodes,
    links: doc.links,
    transform: makeTransform(scale, { width: pan[0], height: pan[1] }, { width: size[0], height: size[1] }),
    classFilter,
    routePlan: buildRoutePlan(doc.nodes, doc.links),
  });
}

/** A view with nothing selected, hovered or in flight. */
export function quietView(patch: Partial<EditorView> = {}): SceneView {
  return {
    tool: "select",
    selectedNodeID: null,
    selectedNodeIDs: new Set(),
    selectedLinkID: null,
    hoveredNodeID: null,
    hoveredLinkID: null,
    multiSelectRect: null,
    pendingLinkStartID: null,
    activeLinkSourceID: null,
    activeCustomerClass: 0,
    activeAlignGuides: NO_GUIDES,
    isDraggingNode: false,
    isPanningCanvas: false,
    isSpacePanning: false,
    ...patch,
  };
}

export const byName = (doc: BnetDocument, name: string) => doc.nodes.find((n) => n.name === name)!;
export const linkBetween = (doc: BnetDocument, a: string, b: string) => doc.links.find((l) => l.fromNodeID === byName(doc, a).id && l.toNodeID === byName(doc, b).id)!;
