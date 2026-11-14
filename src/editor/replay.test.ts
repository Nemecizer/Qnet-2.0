// P5's acceptance test: "a network can be built, edited, undone, saved and reopened with the
// result byte-identical to the same steps in 0.90.34". Every scenario in golden/edits/ (0.90.34's
// own editor, replayed headless by golden/tools/GoldenCanvas.swift; vocabulary in
// golden/edits/README.md) is replayed here through 2.0's editor, and after every step the
// document and the observable state are compared with what 0.90.34 recorded.
//
// Documents are compared as core's writer would write them: sorted keys, the pan saved as zero,
// UUIDs numbered in order of first appearance (0.90.34 makes fresh random ones). Gestures, keys,
// the inspectors and the archetype gallery are driven through their areas' own headless functions
// (the same ones their UI calls), so this tests the shipped code.
import { describe, expect, it } from "vitest";
import type { BnetDocument, BnetLink, BnetNode } from "../lib/bnet";
import { activeTab, getWorkspace, isDirty, markSaved, replaceWorkspace, type StatusEntry } from "../workspace/store";
import { hitLink, hitNode } from "../canvas/geometry/scene";
import { toDisplay, toLogical, WORLD_CLAMP } from "../canvas/geometry/transform";
import type { Point } from "../canvas/geometry/types";
import { stationPicture } from "./pictures";
import { editorClock, editorFor, type Editor } from ".";
import type { EditorTool } from "./editor";
import { defaultHandlers } from "../dev/mockBackend";
import { mockTauri } from "../test/tauri";
import { LinkParameterDraft, makePaneState, NodeParameterDraft, reloadIfIdle, syncSelection, type PaneState } from "../panes/inspector/drafts";

// Loaded through Vite (the type check has no Node types): every file as text, on demand.
const raw = (g: Record<string, () => Promise<unknown>>) => (path: string) => {
  const f = g[path];
  if (!f) throw new Error(`no file ${path}`);
  return f() as Promise<string>;
};
const scenarioFiles = import.meta.glob("../../golden/tools/edit-scenarios/*.json", { query: "?raw", import: "default" });
const goldenFiles = import.meta.glob("../../golden/edits/*/step-*", { query: "?raw", import: "default" });
const readScenario = raw(scenarioFiles);
const readGolden = raw(goldenFiles);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Step = { op: string; [k: string]: Json };
interface Scenario {
  description: string;
  start: string | null;
  viewport?: [number, number];
  inspectorPane?: boolean;
  steps: Step[];
}

// ── Steps where 2.0 differs from 0.90.34 on purpose: each is a Changed row in docs/PARITY.md. ──
// A difference starts at `from` and, where it changes the document, carries on to `to` (default:
// the end), so those fields aren't compared there; every other field still is.
interface Expected {
  from: number;
  to?: number;
  fields: string[];
  why: string;
}
const CACHE = "0.90.34's ParameterCache re-applied an undone edit when a node's editor opened (PLAN.md §4 drops it; ledger INS row)";
const LINK_DRAFT = "0.90.34's docked Inspector never reloaded a link draft changed from outside and wrote the stale values back on the next selection change (fixed, D5; ledger INS row)";
const SERVED = "0.90.34 listed a station's classes by each incoming link's entry class, so after a class change it showed, and stored a law for, a class that never reaches the station (S1's Class 2, S2's Class 1 in Kumar–Seidman); 2.1 lists the classes served (ledger FIX-103, INS-053 Changed)";
const EXPECTED: Record<string, Expected[]> = {
  "finite-buffers": [
    { from: 10, to: 10, fields: ["status"], why: CACHE },
    { from: 16, fields: ["document"], why: CACHE },
    { from: 17, to: 17, fields: ["status"], why: CACHE },
  ],
  "inspector-link": [
    { from: 13, to: 13, fields: ["status"], why: LINK_DRAFT },
    { from: 31, to: 32, fields: ["status"], why: LINK_DRAFT },
    { from: 13, fields: ["document", "undoActionName", "redoActionName", "canUndo", "canRedo", "hasUnsavedChanges"], why: LINK_DRAFT },
  ],
  "link-drag-and-legend": [
    { from: 7, to: 7, fields: ["status"], why: LINK_DRAFT },
    { from: 7, fields: ["document", "undoActionName", "redoActionName", "canUndo", "canRedo", "hasUnsavedChanges"], why: LINK_DRAFT },
  ],
  "inspector-multiclass": [
    { from: 1, fields: ["document"], why: SERVED },
    { from: 1, to: 1, fields: ["status"], why: SERVED },
    { from: 3, to: 4, fields: ["status"], why: SERVED },
    { from: 8, fields: ["hasUnsavedChanges"], why: CACHE },
  ],
};

// ── Areas' headless functions, loaded when they exist (each area reports their path) ─────────
type Mod = Record<string, (...a: unknown[]) => unknown>;
async function optional(path: string): Promise<Mod | null> {
  try {
    return (await import(/* @vite-ignore */ path)) as Mod;
  } catch {
    return null;
  }
}

// ── References ────────────────────────────────────────────────────────────────────────────────

function nodeRef(e: Editor, r: Json): BnetNode {
  const nodes = e.nodes;
  let n: BnetNode | undefined;
  if (typeof r === "string") n = nodes.find((x) => x.name === r);
  else if (typeof r === "number") n = nodes[r];
  else if (r && typeof r === "object" && !Array.isArray(r)) n = "name" in r ? nodes.find((x) => x.name === r.name) : nodes[r.index as number];
  if (!n) throw new Error(`no node ${JSON.stringify(r)}`);
  return n;
}

function linkRef(e: Editor, r: Json): BnetLink {
  const links = e.links;
  let l: BnetLink | undefined;
  if (typeof r === "number") l = links[r];
  else if (r && typeof r === "object" && !Array.isArray(r)) {
    if ("index" in r) l = links[r.index as number];
    else {
      const from = nodeRef(e, r.from).id;
      const to = nodeRef(e, r.to).id;
      l = links.find((x) => x.fromNodeID === from && x.toNodeID === to && (r.class === undefined || x.customerClass === r.class));
    }
  }
  if (!l) throw new Error(`no link ${JSON.stringify(r)}`);
  return l;
}

const pt = (j: Json): Point => {
  const [x, y] = j as number[];
  return { x, y };
};
const clampWorld = (p: Point): Point => ({ x: Math.min(WORLD_CLAMP, Math.max(-WORLD_CLAMP, p.x)), y: Math.min(WORLD_CLAMP, Math.max(-WORLD_CLAMP, p.y)) });

// ── The ops ───────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  e: Editor;
  notes: string[];
  gestures: Mod | null;
  inspector: Mod | null;
  archetypes: Mod | null;
  extra: { alignGuides?: unknown; marqueeNodeCount?: number | null };
  pane: PaneState | null;
  clock: { t: number };
}

type Op = (c: Ctx, s: Step) => unknown;

const isSelectTool = (t: EditorTool) => t === "select" || t === "multiSelect";

/** Replica of a click on empty canvas (README "canvasClick"). */
function canvasClick(c: Ctx, at: Point, extending: boolean) {
  const { e } = c;
  const scene = e.makeScene();
  if (hitNode(scene, at) || hitLink(scene, at)) throw new Error(`canvasClick at ${at.x},${at.y} hits something`);
  const tool = e.view.tool;
  if (tool === "pan") e.exitStickyPan();
  if (tool === "multiSelect") {
    const w = toLogical(e.canvasTransform, at);
    e.beginMultiSelect(w);
    e.updateMultiSelect(w);
    e.setView({ multiSelectRect: null, multiSelectOrigin: null });
  }
  if (extending && isSelectTool(e.view.tool)) return;
  e.handleCanvasTap(e.snapIfNeeded(clampWorld(toLogical(e.canvasTransform, at))));
}

/** An op an area implements: `args` turns the step into that function's arguments after the editor. */
const needs =
  (area: keyof Pick<Ctx, "gestures" | "inspector" | "archetypes">, fn: string, args: (c: Ctx, s: Step) => unknown[] = (_c, s) => [s], after?: (c: Ctx, r: unknown) => void): Op =>
  async (c, s) => {
    const m = c[area];
    if (!m || typeof m[fn] !== "function") throw new Pending(`${area}.${fn}`);
    const r = await (m[fn] as (...a: unknown[]) => unknown)(c.e, ...args(c, s));
    after?.(c, r);
    return r;
  };

/** The interaction area's gesture when it has one, else this file's replica of 0.90.34's view code. */
const gesture =
  (fn: string, args: (c: Ctx, s: Step) => unknown[], replica?: Op, after?: (c: Ctx, r: unknown) => void): Op =>
  async (c, s) => {
    const m = c.gestures;
    if (m && typeof m[fn] === "function") {
      const r = await (m[fn] as (...a: unknown[]) => unknown)(c.e, ...args(c, s));
      after?.(c, r);
      return r;
    }
    if (replica) return replica(c, s);
    throw new Pending(`gestures.${fn}`);
  };

const size = (j: Json) => {
  const [width, height] = j as number[];
  return { width, height };
};
const viewport = (c: Ctx) => c.e.view.viewportSize;

class Pending extends Error {}

const OPS: Record<string, Op> = {
  empty: () => {},
  open: () => {},
  setTool: ({ e }, s) => e.setTool(s.tool as EditorTool),
  canvasClick: gesture("canvasClick", (_c, s) => [pt(s.at), { extending: !!s.extending }], (c, s) => canvasClick(c, pt(s.at), !!s.extending)),
  canvasDoubleClick: gesture("canvasDoubleClick", (_c, s) => [pt(s.at)], (c, s) => {
    canvasClick(c, pt(s.at), false);
    const t = c.e.view.tool;
    if (isSelectTool(t)) c.e.enterStickyPan();
    else if (t === "addLink") c.e.handleCanvasTap(c.e.snapIfNeeded(clampWorld(toLogical(c.e.canvasTransform, pt(s.at)))));
  }),
  nodeClick: gesture("nodeClick", (c, s) => [nodeRef(c.e, s.node).id, { extending: !!s.extending }], ({ e }, s) => e.handleNodeTap(nodeRef(e, s.node).id, !!s.extending)),
  nodeDoubleClick: gesture("nodeDoubleClick", (c, s) => [nodeRef(c.e, s.node).id], ({ e }, s) => {
    const id = nodeRef(e, s.node).id;
    e.handleNodeTap(id);
    if (isSelectTool(e.view.tool)) e.openParameterEditor(id);
    else e.handleNodeTap(id);
  }),
  linkClick: gesture("linkClick", (c, s) => [linkRef(c.e, s.link).id], ({ e }, s) => e.handleLinkTap(linkRef(e, s.link).id)),
  linkDoubleClick: gesture("linkDoubleClick", (c, s) => [linkRef(c.e, s.link).id], ({ e }, s) => {
    const id = linkRef(e, s.link).id;
    e.handleLinkTap(id);
    e.openLinkParameterEditor(id);
  }),
  legendClick: gesture("legendClick", (_c, s) => [s.class], ({ e }, s) => e.setView({ classFilter: e.view.classFilter === s.class ? null : (s.class as number) })),
  setSnapToGrid: ({ e }, s) => e.setSnapToGrid(!!s.value),
  // Drags and keys: the interaction area's gestures (src/canvas/interaction/gestures.ts).
  dragNode: gesture("dragNode", (c, s) => [nodeRef(c.e, s.node).id, size(s.by), { extending: !!s.extending, option: !!s.option, control: !!s.control, escape: !!s.escape }], undefined, (c, r) => (c.extra.alignGuides = r)),
  dragConnect: gesture("dragConnect", (c, s) => [nodeRef(c.e, s.from).id, s.to === null || s.to === undefined ? null : nodeRef(c.e, s.to).id, { returned: !!s.returned }]),
  dragLink: gesture("dragLink", (c, s) => [linkRef(c.e, s.link).id, size(s.by), { escape: !!s.escape }]),
  marquee: gesture("marquee", (_c, s) => [pt(s.from), pt(s.to), { extending: !!s.extending }], undefined, (c, r) => (c.extra.marqueeNodeCount = r as number | null)),
  panDrag: gesture("panDrag", (_c, s) => [size(s.by)]),
  arrowKey: gesture("arrowKey", (_c, s) => [s.key, { shift: !!s.shift }]),
  tabKey: gesture("tabKey", (c, s) => [{ shift: !!s.shift }, viewport(c)]),
  optionTabKey: gesture("optionTabKey", (c, s) => [{ shift: !!s.shift }, viewport(c)]),
  arrowKeyUp: gesture("arrowKeyUp", () => [], ({ e }) => e.endNudgeRun()),
  escapeKey: gesture("escapeKey", () => [], ({ e }) => e.deselectAll()),
  deleteKey: gesture("deleteKey", () => [], ({ e }) => e.deleteSelection()),
  returnKey: gesture("returnKey", () => [], ({ e }) => e.openParameterEditorForSelection()),
  // Model methods.
  addNode: ({ e }, s) => e.addNode(s.kind as BnetNode["kind"], pt(s.at), (s.name as string | undefined) ?? undefined),
  addLink: ({ e }, s) => e.addLink(nodeRef(e, s.from).id, nodeRef(e, s.to).id, (s.class as number) ?? 0, (s.toClass as number | undefined) ?? null, (s.probability as number) ?? 1),
  moveNode: ({ e }, s) => e.moveNode(nodeRef(e, s.node).id, pt(s.to), s.snap === undefined ? true : !!s.snap),
  beginMutation: ({ e }, s) => e.beginMutation(s.name as string),
  endMutation: ({ e }) => e.endMutation(),
  moveLink: ({ e }, s) => {
    const [w, h] = s.by as number[];
    e.moveLink(linkRef(e, s.link).id, { width: w, height: h });
  },
  deleteNode: ({ e }, s) => e.deleteNode(nodeRef(e, s.node).id),
  deleteLink: ({ e }, s) => e.deleteLink(linkRef(e, s.link).id),
  deleteSelection: ({ e }) => e.deleteSelection(),
  copySelection: ({ e }) => e.copySelection(),
  cutSelection: ({ e }) => e.cutSelection(),
  pasteSelection: ({ e }) => e.pasteSelection(),
  duplicateSelection: ({ e }) => e.duplicateSelection(),
  selectAll: ({ e }) => e.selectAll(),
  deselectAll: ({ e }) => e.deselectAll(),
  setNodeSelection: ({ e }, s) => e.setNodeSelection(new Set((s.nodes as Json[]).map((r) => nodeRef(e, r).id))),
  toggleNodeInSelection: ({ e }, s) => e.toggleNodeInSelection(nodeRef(e, s.node).id),
  selectAdjacentNode: ({ e }, s) => e.selectAdjacentNode(!!s.reverse),
  selectAdjacentLink: ({ e }, s) => e.selectAdjacentLink(!!s.reverse),
  alignSelectedNodesLeft: ({ e }) => e.alignSelectedNodesLeft(),
  alignSelectedNodesRight: ({ e }) => e.alignSelectedNodesRight(),
  alignSelectedNodesTop: ({ e }) => e.alignSelectedNodesTop(),
  alignSelectedNodesBottom: ({ e }) => e.alignSelectedNodesBottom(),
  alignSelectedNodesHorizontalCentres: ({ e }) => e.alignSelectedNodesHorizontalCentres(),
  alignSelectedNodesVerticalCentres: ({ e }) => e.alignSelectedNodesVerticalCentres(),
  distributeSelectedNodesHorizontally: ({ e }) => e.distributeSelectedNodesHorizontally(),
  distributeSelectedNodesVertically: ({ e }) => e.distributeSelectedNodesVertically(),
  nudgeSelection: ({ e }, s) => {
    const [w, h] = s.by as number[];
    e.nudgeSelection({ width: w, height: h });
  },
  endNudgeRun: ({ e }) => e.endNudgeRun(),
  endParameterRun: ({ e }) => e.endParameterRun(),
  straightenNetwork: ({ e }) => e.straightenNetwork(),
  fitNetworkToWindow: ({ e }) => e.fitNetworkToWindow(),
  clear: ({ e }) => e.clear(),
  setInfiniteBuffers: ({ e }, s) => e.setInfiniteBuffers(!!s.value),
  renameNode: ({ e }, s) => e.renameNode(nodeRef(e, s.node).id, s.name as string),
  updateBufferSize: ({ e }, s) => e.updateBufferSize(nodeRef(e, s.node).id, s.size as number),
  updateNumberOfServers: ({ e }, s) => e.updateNumberOfServers(nodeRef(e, s.node).id, s.count as number),
  updateStationPicture: ({ e }, s) => e.updateStationPicture(nodeRef(e, s.node).id, s.picture as string, stationPicture(s.picture as string).displayName),
  updateNodeDistribution: ({ e }, s) => e.updateNodeDistribution(nodeRef(e, s.node).id, s.distribution as string, s.parameters as string),
  updateServiceDistribution: ({ e }, s) => e.updateServiceDistribution(nodeRef(e, s.node).id, s.class as number, s.distribution as string, s.parameters as string),
  updateLinkProbability: ({ e }, s) => e.updateLinkProbability(linkRef(e, s.link).id, s.probability as number),
  updateLinkCustomerClass: ({ e }, s) => e.updateLinkCustomerClass(linkRef(e, s.link).id, s.class as number),
  updateLinkExitClass: ({ e }, s) => e.updateLinkExitClass(linkRef(e, s.link).id, (s.class as number | null) ?? null),
  findAndRevealNode: ({ e }, s) => e.findAndRevealNode(s.query as string),
  insertArchetype: needs("archetypes", "insertArchetype", (_c, s) => [s.archetype, s.parameters ?? {}]),
  zoomIn: ({ e }) => e.zoomIn(),
  zoomOut: ({ e }) => e.zoomOut(),
  zoomToFit: ({ e }) => e.zoomToFit(),
  zoomToFitSelection: ({ e }) => e.zoomToFitSelection(),
  resetZoom: ({ e }) => e.resetZoom(),
  setZoom: ({ e }, s) => e.setZoom(s.scale as number),
  zoomAbout: ({ e }, s) => e.zoomTo(s.scale as number, pt(s.about)),
  pan: ({ e }, s) => {
    const [w, h] = s.by as number[];
    e.pan({ width: w, height: h });
  },
  undo: (c) => {
    if (!c.e.undoManager.canUndo) return c.notes.push("undo disabled");
    c.e.undo();
  },
  redo: (c) => {
    if (!c.e.undoManager.canRedo) return c.notes.push("redo disabled");
    c.e.redo();
  },
  wait: (c, s) => {
    c.clock.t += (s.seconds as number) * 1000;
  },
  // The inspectors' drafts (src/panes/inspector/drafts), as the panels and the docked pane drive them.
  nodeSheet: (c, s) => {
    const { e } = c;
    const id = nodeRef(e, s.node).id;
    e.openParameterEditor(id);
    const d = new NodeParameterDraft();
    d.load(e, id);
    fillNode(d, s);
    if (!s.cancel) {
      if (d.isValid(e)) d.commit(e);
      else c.notes.push(`Save disabled: ${d.firstProblem(e) ?? d.pendingNote(e)}`);
    }
    e.closeParameterEditor();
  },
  nodePane: (c, s) => {
    const d = c.pane!.node;
    fillNode(d, s);
    d.commit(c.e, { coalescing: true });
  },
  linkSheet: (c, s) => {
    const { e } = c;
    const id = linkRef(e, s.link).id;
    e.openLinkParameterEditor(id);
    const d = new LinkParameterDraft();
    d.load(e, id);
    if (!fillLink(c, d, s)) return e.closeLinkParameterEditor();
    if (!s.cancel) {
      if (d.isValid(e)) d.commit(e);
      else c.notes.push(`Save disabled: ${d.firstProblem(e) ?? d.pendingNote}`);
    }
    e.closeLinkParameterEditor();
  },
  linkPane: (c, s) => {
    const d = c.pane!.link;
    fillLink(c, d, s);
    d.commit(c.e, { coalescing: true });
  },
};

/** The node form's fields, typed as text the way its controls take them. */
function fillNode(d: NodeParameterDraft, s: Step) {
  if (s.entryMode !== undefined) d.setEntryMode(s.entryMode as "native" | "moments");
  if (s.classEntryMode !== undefined) d.setClassEntryMode(s.classEntryMode as "native" | "moments");
  if (s.name !== undefined) d.nameText = s.name as string;
  if (s.servers !== undefined) d.serversText = s.servers as string;
  if (s.bufferSize !== undefined) d.bufferSizeText = s.bufferSize as string;
  if (s.infiniteBuffers !== undefined) d.infiniteBuffersDraft = !!s.infiniteBuffers;
  if (s.picture !== undefined) d.stationPicture = s.picture as string;
  const law = (j: Json, cls?: number) => {
    const o = j as Record<string, Json>;
    if (o.family !== undefined) d.changeDistribution(o.family as string, cls);
    for (const [k, v] of Object.entries((o.params as Record<string, string>) ?? {})) d.setParam(k, v, cls);
    if (o.mean !== undefined) d.setMean(String(o.mean), cls);
    if (o.scv !== undefined) d.setScv(String(o.scv), cls);
  };
  if (s.distribution) law(s.distribution);
  for (const [k, v] of Object.entries((s.classes as Record<string, Json>) ?? {})) law(v, Number(k));
  if (s.copyToAllClassesFrom !== undefined) d.copyToAllClasses(s.copyToAllClassesFrom as number);
  d.changed();
}

/** The link form's fields; false when Balance to 1 was disabled (nothing changes, a note says so). */
function fillLink(c: Ctx, d: LinkParameterDraft, s: Step): boolean {
  if (s.probability !== undefined) d.setProbability(s.probability as string);
  if (s.entryClass !== undefined) d.entryClass = s.entryClass as number;
  if (s.exitClass !== undefined) d.exitClass = s.exitClass as number | "same";
  if (s.balance && !d.balance(c.e)) c.notes.push("Balance to 1 disabled");
  d.changed();
  return true;
}

// ── Observing ─────────────────────────────────────────────────────────────────────────────────

const nodeObs = (e: Editor, id: string | null) => {
  if (id === null) return null;
  const i = e.nodes.findIndex((n) => n.id === id);
  return { index: i, name: e.nodes[i]?.name };
};

const linkObs = (e: Editor, id: string | null) => {
  if (id === null) return null;
  const i = e.links.findIndex((l) => l.id === id);
  const l = e.links[i];
  return { index: i, from: e.node(l?.fromNodeID)?.name, to: e.node(l?.toNodeID)?.name, customerClass: l?.customerClass };
};

function observe(e: Editor, status: StatusEntry[], dirty: boolean): Record<string, unknown> {
  const v = e.view;
  const um = e.undoManager;
  const r = v.multiSelectRect;
  return {
    status: status.map((s) => ({ text: s.text, severity: s.severity })),
    selectedNodeID: nodeObs(e, v.selectedNodeID),
    selectedNodeIDs: e.nodes.filter((n) => v.selectedNodeIDs.has(n.id)).map((n) => nodeObs(e, n.id)),
    selectedLinkID: linkObs(e, v.selectedLinkID),
    pendingLinkStartID: nodeObs(e, v.pendingLinkStartID),
    activeLinkSourceID: nodeObs(e, v.activeLinkSourceID),
    activeCustomerClass: v.activeCustomerClass,
    selectedTool: v.tool,
    toolBeforeStickyPan: v.toolBeforeStickyPan,
    canUndo: um.canUndo,
    canRedo: um.canRedo,
    undoActionName: um.undoActionName,
    redoActionName: um.redoActionName,
    snapToGrid: v.snapToGrid,
    snapSuspended: v.snapSuspended,
    classFilter: v.classFilter,
    canvasScale: v.canvasScale,
    canvasPanOffset: [v.canvasPanOffset.width, v.canvasPanOffset.height],
    infiniteBuffers: e.infiniteBuffers,
    nodeCount: e.nodes.length,
    linkCount: e.links.length,
    numberOfCustomerClasses: e.numberOfCustomerClasses,
    canPaste: e.canPaste,
    hasUnsavedChanges: dirty,
    multiSelectRect: r ? [[r.x, r.y], [r.width, r.height]] : null,
    isDraggingNode: v.isDraggingNode,
    parameterEditorTarget: nodeObs(e, v.parameterEditorTarget),
    linkParameterEditorTarget: linkObs(e, v.linkParameterEditorTarget),
    pendingFitOnAppear: v.pendingFitOnAppear,
  };
}

/** A document as core's writer saves it, with UUIDs numbered by first appearance. */
function canonical(doc: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .filter((k) => o[k] !== undefined && o[k] !== null)
          .sort()
          .map((k) => [k, sort(o[k])]),
      );
    }
    return v;
  };
  const d = { ...(doc as BnetDocument), canvasPanOffset: [0, 0] };
  const ids = new Map<string, string>();
  return JSON.stringify(sort(d), null, 1).replace(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g, (m) => {
    if (!ids.has(m)) ids.set(m, `ID${ids.size}`);
    return ids.get(m)!;
  });
}

/** 0.90.34's recorded state, with the fields this replay compares. */
function goldenState(j: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(observeKeys)) out[k] = j[k];
  const r = j.multiSelectRect as number[][] | null;
  out.multiSelectRect = r ?? null;
  return out;
}

const observeKeys = Object.fromEntries(
  [
    "status", "selectedNodeID", "selectedNodeIDs", "selectedLinkID", "pendingLinkStartID", "activeLinkSourceID", "activeCustomerClass", "selectedTool",
    "toolBeforeStickyPan", "canUndo", "canRedo", "undoActionName", "redoActionName", "snapToGrid", "snapSuspended", "classFilter", "canvasScale",
    "canvasPanOffset", "infiniteBuffers", "nodeCount", "linkCount", "numberOfCustomerClasses", "canPaste", "hasUnsavedChanges", "multiSelectRect",
    "isDraggingNode", "parameterEditorTarget", "linkParameterEditorTarget", "pendingFitOnAppear",
  ].map((k) => [k, true]),
);

// ── The replay ────────────────────────────────────────────────────────────────────────────────

const scenarios = Object.keys(scenarioFiles).map((f) => f.replace(/^.*\//, "").slice(0, -5)).sort();

async function replay(name: string): Promise<{ pending: string | null; mismatches: string[] }> {
  mockTauri(defaultHandlers());
  const sc = JSON.parse(await readScenario(`../../golden/tools/edit-scenarios/${name}.json`)) as Scenario;
  const ctx: Ctx = {
    e: null as unknown as Editor,
    notes: [],
    gestures: await optional("../canvas/interaction/gestures"),
    inspector: await optional("../panes/inspector/drafts/replay"),
    archetypes: await optional("../windows/archetypes/insert"),
    extra: {},
    pane: null,
    clock: { t: 1_000_000 },
  };
  editorClock.now = () => ctx.clock.t;
  const id = getWorkspace().activeId;
  // The example as 0.90.34 opened it (step-00.bnet is its save of the opened file, every field
  // filled in as core's reader fills them for the interface).
  if (sc.start) {
    const doc = JSON.parse(await readGolden(`../../golden/edits/${name}/step-00.bnet`)) as BnetDocument;
    replaceWorkspace({ tabs: [{ ...activeTab(), document: doc, path: `/examples/${sc.start}.bnet`, title: `${sc.start}.bnet`, revision: 0, savedRevision: 0 }], activeId: id });
  }
  const e = editorFor(id);
  ctx.e = e;
  const [w, h] = sc.viewport ?? [1200, 800];
  e.setViewportSize({ width: w, height: h });
  if (sc.inspectorPane !== false) {
    ctx.pane = makePaneState();
    syncSelection(e, ctx.pane);
  }
  const mismatches: string[] = [];
  const expected = EXPECTED[name] ?? [];
  for (let i = 1; i <= sc.steps.length; i++) {
    const step = sc.steps[i - 1];
    const before = activeTab().log.length;
    ctx.notes = [];
    ctx.extra = {};
    ctx.clock.t += 1;
    const op = OPS[step.op];
    if (!op) return { pending: `op ${step.op}`, mismatches };
    try {
      await op(ctx, step);
    } catch (err) {
      if (err instanceof Pending) return { pending: `${err.message} (step ${i})`, mismatches };
      throw err;
    }
    // The docked Inspector follows the selection and the document after every step, as
    // InspectorPaneView did (README "How a step runs").
    if (ctx.pane) {
      syncSelection(e, ctx.pane);
      reloadIfIdle(e, ctx.pane);
    }
    // The end of the event: its undo group closes.
    e.undoManager.closeGroup();
    const tab = activeTab();
    const got = observe(e, tab.log.slice(before), isDirty(tab));
    const gold = JSON.parse(await readGolden(`../../golden/edits/${name}/step-${String(i).padStart(2, "0")}.json`));
    const want = goldenState(gold);
    const skip = new Set(expected.filter((x) => i >= x.from && i <= (x.to ?? Infinity)).flatMap((x) => x.fields));
    for (const k of Object.keys(want)) {
      if (skip.has(k)) continue;
      if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) mismatches.push(`${name} step ${i} (${step.op}) ${k}: got ${JSON.stringify(got[k])}, 0.90.34 ${JSON.stringify(want[k])}`);
    }
    if (!skip.has("document")) {
      const goldDoc = JSON.parse(await readGolden(`../../golden/edits/${name}/step-${String(i).padStart(2, "0")}.bnet`));
      if (canonical(tab.document) !== canonical(goldDoc)) mismatches.push(`${name} step ${i} (${step.op}) document differs`);
    }
    // 0.90.34's replay saved after every step: the next step's "unsaved changes" start from here.
    markSaved(id, tab.path ?? "/tmp/replay.bnet", tab.title);
    if (mismatches.length > 8) break;
  }
  return { pending: null, mismatches };
}

describe("edits replayed against 0.90.34 (golden/edits)", () => {
  it("has the scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
  });
  for (const name of scenarios) {
    it(name, async (ctx) => {
      const { pending, mismatches } = await replay(name);
      if (pending) return ctx.skip(`waits for ${pending}`);
      expect(mismatches).toEqual([]);
    });
  }
});

// Kept for the expected-difference notes above.
void toDisplay;
