// One tab's editor: the port of 0.90.34's NetworkEditorModel (docs/specs/canvas.md §15). Method
// names, guards, undo names and Status sentences are 0.90.34's, so a scripted edit replays to the
// same document (golden/edits/). The document itself lives in the workspace store (the tab's
// `document`); the editor reads it from there and writes every change back through
// `setDocument`, so saving, the session, the analysis and the edited dot see one copy.
//
// What lives here and not in the document is view state (`EditorView`): the tool, the selection,
// the half-built link chain, zoom and pan, hover, drag flags, the class filter. It is published as
// one immutable object, replaced on every change, for React's useSyncExternalStore.
import type { BatchSize, BnetDocument, BnetLink, BnetNode, NodeKind, RateProfile, ServiceConfig, ServiceDiscipline } from "../lib/bnet";
import { newId } from "../lib/bnet";
import { invalidateMenu } from "../lib/menu";
import { addStatus, setDocument, setDocumentView, tabById, type Severity } from "../workspace/store";
import { scenarioEdit } from "../scenarios/edits";
import { boundsOfCentres, marqueeSelects } from "../canvas/geometry/outline";
import { buildRoutePlan, buildScene, type CanvasScene, type LinkRoutePlan } from "../canvas/geometry/scene";
import { clampScale, fitting, FIT_MARGIN, GRID_SPACING, NO_INSETS, viewportCentre, ZOOM_RANGE, ZOOM_STEP, zoomed, type CanvasTransform, type Insets } from "../canvas/geometry/transform";
import type { Point, Rect, Size } from "../canvas/geometry/types";
import { defaultParameters, distributionDisplayName } from "./distributions";
import { maxNameIndex, orderIsAmbiguous, sortIndex } from "./naming";
import { displayFixed, formatSig, READOUT_DIGITS } from "./numbers";
import { UndoManager } from "./undo";

export type EditorTool = "select" | "multiSelect" | "pan" | "addStation" | "addBuffer" | "addSource" | "addSink" | "addLink";

export const TOOLS: readonly EditorTool[] = ["select", "multiSelect", "pan", "addStation", "addBuffer", "addSource", "addSink", "addLink"];

/** `EditorTool.displayName`. */
export const TOOL_NAMES: Record<EditorTool, string> = {
  select: "Pointer",
  multiSelect: "Multi-Select",
  pan: "Pan",
  addStation: "Add Station",
  addBuffer: "Add Buffer",
  addSource: "Add Source",
  addSink: "Add Sink",
  addLink: "Add Link",
};

/** `NodeKind.displayName`. */
export const KIND_NAMES: Record<NodeKind, string> = { station: "Station", buffer: "Buffer", source: "Source", sink: "Sink" };

/** `CustomerClass.label(for:)`. */
export const classLabel = (i: number) => `Class ${i + 1}`;

/** The smart-guide match drawn during a drag (canvas.md §9); the geometry area owns its contents. */
export interface AlignGuides {
  readonly adjustment: Size;
  readonly x: number | null;
  readonly y: number | null;
  readonly anchor: Rect | null;
  readonly xPartner: Rect | null;
  readonly yPartner: Rect | null;
  readonly xSpacing: { first: Rect; second: Rect } | null;
  readonly ySpacing: { first: Rect; second: Rect } | null;
}

export const NO_GUIDES: AlignGuides = Object.freeze({ adjustment: { width: 0, height: 0 }, x: null, y: null, anchor: null, xPartner: null, yPartner: null, xSpacing: null, ySpacing: null });

/** Everything about a tab's canvas that isn't the document (NetworkEditorModel's published view state). */
export interface EditorView {
  readonly tool: EditorTool;
  readonly selectedNodeID: string | null;
  readonly selectedNodeIDs: ReadonlySet<string>;
  readonly selectedLinkID: string | null;
  readonly multiSelectRect: Rect | null;
  readonly multiSelectOrigin: Point | null;
  readonly pendingLinkStartID: string | null;
  /** The rubber band's free end, world space, while a link is dragged out of a node. */
  readonly pendingLinkPoint: Point | null;
  readonly activeLinkSourceID: string | null;
  readonly activeCustomerClass: number;
  readonly hoveredNodeID: string | null;
  readonly hoveredLinkID: string | null;
  readonly isPanningCanvas: boolean;
  readonly isDraggingNode: boolean;
  readonly isSpacePanning: boolean;
  readonly snapToGrid: boolean;
  readonly snapSuspended: boolean;
  readonly activeAlignGuides: AlignGuides;
  readonly classFilter: number | null;
  readonly toolBeforeStickyPan: EditorTool | null;
  readonly pendingFitOnAppear: boolean;
  readonly canvasScale: number;
  readonly canvasPanOffset: Size;
  /** Bumped by every programmatic zoom or fit, so the canvas glides; wheel and pinch leave it alone. */
  readonly canvasAnimationToken: number;
  readonly viewportSize: Size;
  /** The node whose Node Parameters panel is open (⌘I), or null. */
  readonly parameterEditorTarget: string | null;
  /** The link whose Link Parameters panel is open, or null. */
  readonly linkParameterEditorTarget: string | null;
}

interface Snapshot {
  nodes: readonly BnetNode[];
  links: readonly BnetLink[];
  infiniteBuffers: boolean;
  closedPopulation: number | undefined;
  /** The document's scenarios (src/scenarios/): part of every undo step, so undo puts them back with the values. */
  scenarios: BnetDocument["scenarios"];
  stationCount: number;
  bufferCount: number;
  sourceCount: number;
  sinkCount: number;
}

/** Milliseconds; replaced by tests and the edit replays to control the run timeouts. */
export const editorClock = { now: () => Date.now() };

/** NSSound.beep(): a refusal with nothing worth a Status line. Replaced by the app shell. */
export const editorFeedback = { beep: () => {} };

const NUDGE_RUN_TIMEOUT = 1200;
const PARAMETER_RUN_TIMEOUT = 2000;
const DEFAULT_ARRIVAL_RATE = 1.0;
const DEFAULT_TARGET_RHO = 0.9;
const DEFAULT_SERVICE_RATE_LITERAL = "1.1111111";
/** RandomNetworkGenerator.Layout.xStep: one station column of clear air between an insert and the canvas. */
const INSERT_GAP = 130;

export const NUDGE_STEP = { fine: 1, coarse: 10 } as const;

/** View fields no command's title, check mark or enablement depends on. */
const MENU_BLIND = new Set<keyof EditorView>([
  "hoveredNodeID", "hoveredLinkID", "pendingLinkPoint", "activeAlignGuides", "isPanningCanvas", "canvasPanOffset", "canvasAnimationToken", "multiSelectRect", "multiSelectOrigin",
]);

function initialView(doc: BnetDocument): EditorView {
  return {
    tool: "select",
    selectedNodeID: null,
    selectedNodeIDs: new Set(),
    selectedLinkID: null,
    multiSelectRect: null,
    multiSelectOrigin: null,
    pendingLinkStartID: null,
    pendingLinkPoint: null,
    activeLinkSourceID: null,
    activeCustomerClass: 0,
    hoveredNodeID: null,
    hoveredLinkID: null,
    isPanningCanvas: false,
    isDraggingNode: false,
    isSpacePanning: false,
    snapToGrid: false,
    snapSuspended: false,
    activeAlignGuides: NO_GUIDES,
    classFilter: null,
    toolBeforeStickyPan: null,
    pendingFitOnAppear: false,
    canvasScale: doc.canvasScale,
    canvasPanOffset: { width: doc.canvasPanOffset[0], height: doc.canvasPanOffset[1] },
    canvasAnimationToken: 0,
    viewportSize: { width: 0, height: 0 },
    parameterEditorTarget: null,
    linkParameterEditorTarget: null,
  };
}

/** Swift's `.rounded()`: to nearest, ties away from zero. */
export function roundAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export class Editor {
  readonly tabId: string;
  readonly undoManager = new UndoManager();
  private _view: EditorView;
  private listeners = new Set<() => void>();

  // Name counters (S<n>, B<n>, Src<n>, Sink<n>): part of the undo snapshot, so an undone delete
  // or clear continues the numbering.
  private stationCount = 0;
  private bufferCount = 0;
  private sourceCount = 0;
  private sinkCount = 0;

  // Per-tab clipboard: 0.90.34 kept it on the editor, so a copy in one tab doesn't paste in another.
  private clipboardNodes: BnetNode[] = [];
  private clipboardLinks: BnetLink[] = [];

  private pendingMutationSnapshot: Snapshot | null = null;
  private pendingMutationName: string | null = null;
  private nudgeRunIDs: ReadonlySet<string> | null = null;
  private lastNudgeTime = -Infinity;
  private suppressParameterStatus = false;
  private pendingGroupTouchedParameters = false;
  private parameterRunKey: string | null = null;
  private lastParameterRunTime = -Infinity;

  /** The last document this editor wrote or adopted; anything else in the store came from outside. */
  private known: BnetDocument;

  private cachedPlan: LinkRoutePlan | null = null;
  private cachedPlanNodes: readonly BnetNode[] | null = null;
  private cachedPlanLinks: readonly BnetLink[] | null = null;

  /** Called after every change that the flag bar's analysis would read (`.bnetNetworkParametersDidChange`). */
  onParametersChanged: () => void = () => {};

  constructor(tabId: string) {
    this.tabId = tabId;
    const doc = this.storeDoc();
    this.known = doc;
    this._view = initialView(doc);
    this.primeCounters();
    // The Edit menu's "Undo Add Station" follows the stack.
    this.undoManager.subscribe(() => invalidateMenu());
  }

  // ── Publishing ─────────────────────────────────────────────────────────────────────────────

  get view(): EditorView {
    return this._view;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    const stop = this.undoManager.subscribe(l);
    return () => {
      this.listeners.delete(l);
      stop();
    };
  };

  /** Changes view state; a no-op patch publishes nothing. */
  setView(patch: Partial<EditorView>) {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof EditorView)[]) {
      if (this._view[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this._view = { ...this._view, ...patch };
    if ("canvasScale" in patch || "canvasPanOffset" in patch) {
      this.writing++;
      try {
        setDocumentView(this.tabId, this._view.canvasScale, [this._view.canvasPanOffset.width, this._view.canvasPanOffset.height]);
      } finally {
        this.writing--;
      }
      this.known = this.storeDoc();
    }
    this.listeners.forEach((l) => l());
    // Hover, the rubber band, guides and the pan change nothing a menu item reads; at frame rate
    // they must not re-resolve the whole menu bar.
    if (Object.keys(patch).some((k) => !MENU_BLIND.has(k as keyof EditorView))) invalidateMenu();
  }

  // ── The document ───────────────────────────────────────────────────────────────────────────

  /**
   * The tab's document. A late timer can still reach the editor of a tab that has closed (a
   * debounced readout, say): it reads the last document it knew, and its writes go nowhere.
   */
  private storeDoc(): BnetDocument {
    const t = tabById(this.tabId);
    return t ? t.document : this.known;
  }

  /** False once the tab has closed. */
  get alive(): boolean {
    return tabById(this.tabId) !== undefined;
  }

  get document(): BnetDocument {
    return this.storeDoc();
  }

  get nodes(): readonly BnetNode[] {
    return this.storeDoc().nodes;
  }

  get links(): readonly BnetLink[] {
    return this.storeDoc().links;
  }

  get infiniteBuffers(): boolean {
    return this.storeDoc().infiniteBuffers;
  }

  /** A closed network's population (new in 2.1), or undefined for an open network. */
  get closedPopulation(): number | undefined {
    return this.storeDoc().closedPopulation;
  }

  private write(patch: Partial<Pick<BnetDocument, "nodes" | "links" | "infiniteBuffers" | "closedPopulation" | "scenarios">>) {
    const prev = this.storeDoc();
    let doc = { ...prev, ...patch };
    // Scenarios (src/scenarios/edits.ts): an edit of a value is the active scenario's override; a
    // write that names the scenarios itself (undo, a scenario operation) is taken as it is.
    const told = "scenarios" in patch ? null : scenarioEdit(this.tabId, prev, doc);
    if (told) doc = told.doc;
    // An open network's document has no such key at all, as every file before 2.1.
    if (doc.closedPopulation === undefined) delete doc.closedPopulation;
    if (doc.scenarios === undefined) delete doc.scenarios;
    this.known = doc;
    setDocument(this.tabId, doc);
    told?.notes.forEach((n) => this.status(n.text, n.severity));
  }

  /**
   * A scenario operation (src/scenarios/commands.ts: switch, new, rename, delete, reset): the
   * values and the scenarios change together, as one undo step named `name` — or, with no name,
   * with no undo entry at all (Solve All Scenarios visits each scenario and comes back).
   */
  applyScenarioState(name: string | null, next: Pick<BnetDocument, "nodes" | "links" | "closedPopulation" | "scenarios">) {
    const patch = { nodes: next.nodes, links: next.links, closedPopulation: next.closedPopulation, scenarios: next.scenarios };
    this.endParameterRun();
    if (name === null) {
      const before = this.snapshot();
      this.write(patch);
      this.invalidateAnalysisIfItWouldRead(before);
    } else this.performMutation(name, () => this.write(patch));
  }

  private setNodes(nodes: readonly BnetNode[]) {
    this.write({ nodes: nodes as BnetNode[] });
  }

  private setLinks(links: readonly BnetLink[]) {
    this.write({ links: links as BnetLink[] });
  }

  private updateNodeAt(index: number, f: (n: BnetNode) => BnetNode) {
    const nodes = [...this.nodes];
    nodes[index] = f(nodes[index]);
    this.setNodes(nodes);
  }

  private updateLinkAt(index: number, f: (l: BnetLink) => BnetLink) {
    const links = [...this.links];
    links[index] = f(links[index]);
    this.setLinks(links);
  }

  /**
   * The store's document was replaced from outside (Open into a blank tab, a restored session):
   * treat it as 0.90.34's `loadNetwork(document:)` without its Status line, which Open writes.
   */
  adoptExternalDocument() {
    const doc = this.storeDoc();
    if (doc === this.known) return;
    this.known = doc;
    this.loadNetworkState(doc);
    // A file opened into this tab starts its own history: 0.90.34 kept the old stack, so ⌘Z after
    // Open could put back the whole earlier network over the file (ledger FILE-018, Changed).
    this.undoManager.removeAllActions();
  }

  /** True when the store's document isn't one this editor wrote or adopted. */
  get isStale(): boolean {
    return this.writing === 0 && this.storeDoc() !== this.known;
  }

  /** Non-zero while this editor itself is changing the store (its listeners must not see an outside change). */
  private writing = 0;

  private loadNetworkState(doc: BnetDocument) {
    this.setView({
      canvasScale: doc.canvasScale,
      canvasPanOffset: { width: doc.canvasPanOffset[0], height: doc.canvasPanOffset[1] },
      selectedNodeID: null,
      selectedNodeIDs: new Set(),
      multiSelectRect: null,
      multiSelectOrigin: null,
      selectedLinkID: null,
      pendingLinkStartID: null,
      activeLinkSourceID: null,
      parameterEditorTarget: null,
      linkParameterEditorTarget: null,
      hoveredNodeID: null,
      hoveredLinkID: null,
      classFilter: null,
    });
    this.primeCounters();
  }

  /** `loadNetwork(document:)`: replaces the document, resets the view, says so. */
  loadNetwork(doc: BnetDocument) {
    this.known = doc;
    setDocument(this.tabId, doc);
    this.loadNetworkState(doc);
    this.status(`Loaded network with ${doc.nodes.length} nodes and ${doc.links.length} links.`);
  }

  private primeCounters() {
    this.stationCount = this.maxNameIndex("station", "S");
    this.bufferCount = this.maxNameIndex("buffer", "B");
    this.sourceCount = this.maxNameIndex("source", "Src");
    this.sinkCount = this.maxNameIndex("sink", "Sink");
  }

  private maxNameIndex(kind: NodeKind, prefix: string): number {
    return maxNameIndex(
      this.nodes.filter((n) => n.kind === kind).map((n) => n.name),
      prefix,
    );
  }

  status(text: string, severity?: Severity) {
    addStatus(text, severity, this.tabId);
  }

  node(id: string | null | undefined): BnetNode | undefined {
    return id ? this.nodes.find((n) => n.id === id) : undefined;
  }

  link(id: string | null | undefined): BnetLink | undefined {
    return id ? this.links.find((l) => l.id === id) : undefined;
  }

  // ── Classes and orders ─────────────────────────────────────────────────────────────────────

  /** Sources plus any derived class a class-transition link introduces. */
  get numberOfCustomerClasses(): number {
    const src = this.nodes.filter((n) => n.kind === "source").length;
    let maxLinkClass = -1;
    for (const l of this.links) maxLinkClass = Math.max(maxLinkClass, l.customerClass, l.toCustomerClass ?? -1);
    return Math.max(src, maxLinkClass + 1);
  }

  /** A source's class: its rank among the sources ordered by the number in their names. */
  customerClassIndex(sourceID: string): number {
    const sources = sortedByIndex(this.nodes.filter((n) => n.kind === "source"));
    const i = sources.findIndex((n) => n.id === sourceID);
    return i < 0 ? 0 : i;
  }

  /** The stations in the order every exporter numbers them. */
  get stationsInExportOrder(): BnetNode[] {
    return sortedByIndex(this.nodes.filter((n) => n.kind === "station"));
  }

  get stationOrderIsAmbiguous(): boolean {
    return orderIsAmbiguous(this.nodes.filter((n) => n.kind === "station").map((n) => n.name));
  }

  /** The i-th station of an index-aligned result vector, or "S(i+1)" when that can't be trusted. */
  stationName(atExportIndex: number): string {
    const s = this.stationsInExportOrder;
    if (atExportIndex < 0 || atExportIndex >= s.length || this.stationOrderIsAmbiguous) return `S${atExportIndex + 1}`;
    return s[atExportIndex].name;
  }

  /** Top-to-bottom, then left-to-right: the order Tab walks. */
  get nodesInReadingOrder(): BnetNode[] {
    return [...this.nodes].sort((a, b) =>
      a.position[1] === b.position[1] ? cmp(a.position[0], b.position[0]) : cmp(a.position[1], b.position[1]),
    );
  }

  /** What the inspector's Previous / Next walk for a node of `kind`. */
  inspectorNavigationOrder(kind: NodeKind): BnetNode[] {
    return kind === "station" ? this.stationsInExportOrder : this.nodesInReadingOrder.filter((n) => n.kind === kind);
  }

  nodeAdjacentInInspectorOrder(nodeID: string, offset: number): BnetNode | undefined {
    const node = this.node(nodeID);
    if (!node) return undefined;
    const order = this.inspectorNavigationOrder(node.kind);
    const i = order.findIndex((n) => n.id === nodeID);
    if (i < 0) return undefined;
    return order[i + offset];
  }

  /**
   * The classes a station serves, ascending: the class each link delivers — its exit class when
   * it changes class on the way — to the station or to a buffer feeding it. That is the solver's
   * rule (core/src/traffic.rs reaches a link's target in its `to_class`) and the sweeps'
   * (src/sweeps/model.ts `classesServed`). 0.90.34 listed each link's ENTRY class instead, so on
   * a re-entrant line the station after a class change showed a row for a class that never
   * reaches it, and could miss the one that does (ledger FIX-103, INS-053 Changed).
   */
  classesServedAtStation(nodeID: string): number[] {
    const station = this.node(nodeID);
    if (!station || station.kind !== "station") return [];
    const targets = new Set<string>([nodeID]);
    for (const c of this.nodes) {
      if (c.kind === "buffer" && this.links.some((l) => l.fromNodeID === c.id && l.toNodeID === nodeID)) targets.add(c.id);
    }
    const classes = new Set<number>();
    for (const l of this.links) if (targets.has(l.toNodeID)) classes.add(l.toCustomerClass ?? l.customerClass);
    return [...classes].sort((a, b) => a - b);
  }

  /** Other links leaving the same node on the same class: the ones whose probabilities sum with it. */
  siblingLinks(linkID: string): BnetLink[] {
    const link = this.link(linkID);
    if (!link) return [];
    return this.links.filter((l) => l.id !== linkID && l.fromNodeID === link.fromNodeID && l.customerClass === link.customerClass);
  }

  /** Entry classes other links on the same directed pair already use. */
  entryClassesUsedByOtherLinks(linkID: string): Set<number> {
    const link = this.link(linkID);
    if (!link) return new Set();
    return new Set(this.links.filter((l) => l.id !== linkID && l.fromNodeID === link.fromNodeID && l.toNodeID === link.toNodeID).map((l) => l.customerClass));
  }

  /** "S1 → S2", for inspector headers. */
  displayLabel(link: BnetLink): string {
    return `${this.node(link.fromNodeID)?.name ?? "?"} → ${this.node(link.toNodeID)?.name ?? "?"}`;
  }

  /** "S1 -> S2", the form the Status sentences use. */
  linkLabel(link: BnetLink): string {
    return `${this.node(link.fromNodeID)?.name ?? "?"} -> ${this.node(link.toNodeID)?.name ?? "?"}`;
  }

  /** What VoiceOver and the tooltip say about a link. */
  linkDescription(link: BnetLink): string {
    const parts: string[] = [this.numberOfCustomerClasses > 1 ? `${classLabel(link.customerClass)} link` : "Link"];
    parts.push(`${this.node(link.fromNodeID)?.name ?? "?"} to ${this.node(link.toNodeID)?.name ?? "?"}`);
    if (link.routingProbability !== 1.0) parts.push(`routing probability ${formatSig(link.routingProbability, 3)}`);
    if (link.toCustomerClass !== undefined && link.toCustomerClass !== link.customerClass) parts.push(`exits as ${classLabel(link.toCustomerClass)}`);
    return parts.join(", ");
  }

  /** Outgoing first, then incoming, each by class: the order ⌥Tab walks. */
  linksAttached(nodeID: string): BnetLink[] {
    const out = this.links.filter((l) => l.fromNodeID === nodeID).sort((a, b) => a.customerClass - b.customerClass);
    const inc = this.links.filter((l) => l.toNodeID === nodeID && l.fromNodeID !== nodeID).sort((a, b) => a.customerClass - b.customerClass);
    return [...out, ...inc];
  }

  primitiveSummary(): string {
    const c = (k: NodeKind) => this.nodes.filter((n) => n.kind === k).length;
    return `Sources: ${c("source")} | Stations: ${c("station")} | Buffers: ${c("buffer")} | Sinks: ${c("sink")} | Links: ${this.links.length}`;
  }

  // ── Tools and selection ────────────────────────────────────────────────────────────────────

  setTool(tool: EditorTool) {
    const patch: { -readonly [K in keyof EditorView]?: EditorView[K] } = { tool };
    if (tool !== "pan") patch.toolBeforeStickyPan = null;
    if (tool !== "addLink") {
      patch.pendingLinkStartID = null;
      patch.activeLinkSourceID = null;
      patch.pendingLinkPoint = null;
    }
    this.setView(patch);
    if (tool !== "select" && tool !== "multiSelect") this.clearMultiSelection();
  }

  enterStickyPan() {
    const v = this._view;
    if (v.toolBeforeStickyPan !== null || v.tool === "pan") return;
    this.setView({ toolBeforeStickyPan: v.tool });
    this.setTool("pan");
  }

  exitStickyPan() {
    const prev = this._view.toolBeforeStickyPan;
    if (prev === null) return;
    this.setView({ toolBeforeStickyPan: null });
    this.setTool(prev);
  }

  handleCanvasTap(at: Point) {
    switch (this._view.tool) {
      case "addStation":
        this.addNode("station", at);
        break;
      case "addBuffer":
        this.addNode("buffer", at);
        break;
      case "addSource":
        this.addNode("source", at);
        break;
      case "addSink":
        this.addNode("sink", at);
        break;
      case "select":
      case "multiSelect":
      case "pan":
        this.setView({ selectedNodeID: null, selectedLinkID: null, pendingLinkStartID: null });
        this.clearMultiSelection();
        this.setView({ classFilter: null });
        break;
      case "addLink":
        this.setView({ selectedNodeID: null, selectedLinkID: null, pendingLinkStartID: null, activeLinkSourceID: null });
        break;
    }
  }

  handleNodeTap(nodeID: string, extendingSelection = false) {
    switch (this._view.tool) {
      case "select":
      case "multiSelect":
        this.setView({ selectedLinkID: null, pendingLinkStartID: null });
        if (extendingSelection) this.toggleNodeInSelection(nodeID);
        else this.setView({ selectedNodeIDs: new Set(), selectedNodeID: nodeID });
        break;
      case "addLink":
        this.handleLinkSelection(nodeID);
        break;
      case "addStation":
      case "addBuffer":
      case "addSource":
      case "addSink":
        this.setView({ selectedNodeIDs: new Set(), selectedNodeID: nodeID, selectedLinkID: null });
        break;
      case "pan":
        break;
    }
  }

  toggleNodeInSelection(nodeID: string) {
    const group = new Set(this._view.selectedNodeIDs);
    if (this._view.selectedNodeID) group.add(this._view.selectedNodeID);
    if (group.has(nodeID)) group.delete(nodeID);
    else group.add(nodeID);
    this.setNodeSelection(group);
  }

  /** One node → the single selection, several → the group, none → nothing (⌘I and Return need the single form). */
  setNodeSelection(group: ReadonlySet<string>) {
    if (!sameSet(group, this.currentSelectionIDs())) this.endNudgeRun();
    if (group.size === 1) this.setView({ selectedNodeIDs: new Set(), selectedNodeID: [...group][0] });
    else this.setView({ selectedNodeIDs: new Set(group), selectedNodeID: null });
  }

  /** The single selection and the group together. */
  get selectionUnion(): Set<string> {
    return this.currentSelectionIDs();
  }

  get hasAnySelection(): boolean {
    return this.currentSelectionIDs().size > 0 || this._view.selectedLinkID !== null;
  }

  get canZoomToSelection(): boolean {
    return this.currentSelectionIDs().size > 0;
  }

  /** The one Deselect All: Escape, ⌥⌘A and the context menu. */
  deselectAll() {
    this.endNudgeRun();
    this.clearMultiSelection();
    this.setView({
      pendingLinkStartID: null,
      activeLinkSourceID: null,
      pendingLinkPoint: null,
      selectedNodeIDs: new Set(),
      selectedNodeID: null,
      selectedLinkID: null,
    });
  }

  handleLinkTap(linkID: string) {
    if (this._view.tool !== "select") return;
    if (this._view.selectedLinkID === linkID) this.cycleLinkCustomerClass(linkID);
    else this.setView({ selectedLinkID: linkID, selectedNodeID: null, pendingLinkStartID: null });
  }

  selectAll() {
    const all = new Set(this.nodes.map((n) => n.id));
    this.setView({ selectedNodeIDs: all, selectedNodeID: null, selectedLinkID: null });
    if (all.size) this.setTool("select");
  }

  private currentSelectionIDs(): Set<string> {
    const ids = new Set(this._view.selectedNodeIDs);
    if (this._view.selectedNodeID) ids.add(this._view.selectedNodeID);
    return ids;
  }

  /** Moves the selection to the next (or previous) node in reading order, wrapping. */
  selectAdjacentNode(reverse: boolean): BnetNode | undefined {
    const ordered = this.nodesInReadingOrder;
    if (!ordered.length) return undefined;
    const v = this._view;
    const current = v.selectedNodeID ?? (v.selectedNodeIDs.size === 1 ? [...v.selectedNodeIDs][0] : null);
    let index: number;
    const at = current ? ordered.findIndex((n) => n.id === current) : -1;
    if (at >= 0) {
      index = reverse ? at - 1 : at + 1;
      if (index < 0) index = ordered.length - 1;
      if (index >= ordered.length) index = 0;
    } else index = reverse ? ordered.length - 1 : 0;
    const target = ordered[index];
    this.setNodeSelection(new Set([target.id]));
    this.setView({ selectedLinkID: null });
    return target;
  }

  /** ⌥Tab: the next link round the selected node (or the selected link's own source). */
  selectAdjacentLink(reverse: boolean): BnetLink | undefined {
    const v = this._view;
    let hub: string | null;
    const current = this.link(v.selectedLinkID);
    if (current) hub = current.fromNodeID;
    else hub = v.selectedNodeID ?? (v.selectedNodeIDs.size === 1 ? [...v.selectedNodeIDs][0] : null);
    if (!hub) return undefined;
    const attached = this.linksAttached(hub);
    if (!attached.length) return undefined;
    let index = 0;
    const at = v.selectedLinkID ? attached.findIndex((l) => l.id === v.selectedLinkID) : -1;
    if (at >= 0) {
      index = reverse ? at - 1 : at + 1;
      if (index < 0) index = attached.length - 1;
      if (index >= attached.length) index = 0;
    } else if (reverse) index = attached.length - 1;
    const target = attached[index];
    this.endNudgeRun();
    this.setView({ selectedNodeIDs: new Set(), selectedNodeID: null, selectedLinkID: target.id });
    return target;
  }

  // ── Marquee ────────────────────────────────────────────────────────────────────────────────

  beginMultiSelect(at: Point) {
    this.setView({ multiSelectOrigin: at, multiSelectRect: { x: at.x, y: at.y, width: 0, height: 0 } });
  }

  updateMultiSelect(to: Point) {
    const o = this._view.multiSelectOrigin;
    if (!o) return;
    this.setView({ multiSelectRect: { x: Math.min(o.x, to.x), y: Math.min(o.y, to.y), width: Math.abs(to.x - o.x), height: Math.abs(to.y - o.y) } });
  }

  /** Commits the band: a node the band touches is selected; ⇧ unions with what was selected. */
  finalizeMultiSelect(extending = false) {
    const band = this._view.multiSelectRect;
    if (!band) return;
    const group = new Set(this.nodes.filter((n) => marqueeSelects(n, band)).map((n) => n.id));
    if (extending) {
      for (const id of this._view.selectedNodeIDs) group.add(id);
      if (this._view.selectedNodeID) group.add(this._view.selectedNodeID);
    }
    this.setView({ multiSelectRect: null, multiSelectOrigin: null });
    if (!group.size) {
      if (!extending) this.setView({ selectedNodeIDs: new Set(), selectedNodeID: null });
      return;
    }
    // A marquee result stays a group even at one node, so the align commands and the status bar agree.
    this.setView({ selectedNodeIDs: group, selectedNodeID: null });
    this.setTool("select");
  }

  clearMultiSelection() {
    this.setView({ selectedNodeIDs: new Set(), multiSelectRect: null, multiSelectOrigin: null });
  }

  /** The live count while a band is drawn, null otherwise. */
  get marqueeNodeCount(): number | null {
    const band = this._view.multiSelectRect;
    if (!band) return null;
    return this.nodes.reduce((c, n) => (marqueeSelects(n, band) ? c + 1 : c), 0);
  }

  /** Edit ▸ Find: the first node whose name contains the query, case-insensitively, framed. */
  findAndRevealNode(query: string): string | null {
    const q = query.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "").toLowerCase();
    if (!q) return null;
    const match = this.nodes.find((n) => n.name.toLowerCase().includes(q));
    if (!match) {
      this.status(`No node matches "${query}".`);
      return null;
    }
    this.setView({ selectedNodeIDs: new Set([match.id]), selectedNodeID: match.id, selectedLinkID: null });
    this.zoomToFitSelection();
    this.status(`Found ${match.name}.`);
    return match.id;
  }

  // ── Zoom and pan ───────────────────────────────────────────────────────────────────────────

  get canvasTransform(): CanvasTransform {
    const v = this._view;
    return { scale: v.canvasScale, pan: v.canvasPanOffset, viewportSize: v.viewportSize };
  }

  /** The canvas reports its size here; plain state, it never redraws by itself. */
  setViewportSize(size: Size) {
    const v = this._view.viewportSize;
    if (v.width === size.width && v.height === size.height) return;
    this._view = { ...this._view, viewportSize: size };
  }

  zoomIn() {
    this.zoomBy(ZOOM_STEP, viewportCentre(this.canvasTransform), true);
  }

  zoomOut() {
    this.zoomBy(1 / ZOOM_STEP, viewportCentre(this.canvasTransform), true);
  }

  zoomBy(factor: number, displayAnchor: Point, animated = false) {
    this.zoomTo(this._view.canvasScale * factor, displayAnchor, animated);
  }

  /** Clamped to the zoom range; keeps the world point under `displayAnchor` fixed. */
  zoomTo(newScale: number, displayAnchor: Point, animated = false) {
    const clamped = clampScale(newScale);
    if (clamped === this._view.canvasScale) return;
    this.apply(zoomed(this.canvasTransform, clamped, displayAnchor), animated);
  }

  /** The zoom cluster's percentage menu: about the centre, animated. */
  setZoom(newScale: number) {
    this.zoomTo(newScale, viewportCentre(this.canvasTransform), true);
  }

  pan(by: Size) {
    const p = this._view.canvasPanOffset;
    this.setView({ canvasPanOffset: { width: p.width + by.width, height: p.height + by.height } });
  }

  /** Actual Size (⌘0): zoom 1 with the world origin top-left. */
  resetZoom() {
    this.apply({ scale: 1, pan: { width: 0, height: 0 }, viewportSize: this._view.viewportSize }, true);
  }

  zoomToFit() {
    this.fit(this.nodes);
  }

  /** The selection, or everything when nothing is selected. */
  zoomToFitSelection() {
    const ids = this.currentSelectionIDs();
    this.fit(ids.size ? this.nodes.filter((n) => ids.has(n.id)) : this.nodes);
  }

  /**
   * The room floating chrome takes at the canvas's top and bottom now (the results legend, the
   * animation's control bar), reported by the canvas that shows this editor (CanvasView); a fit
   * frames the network in what is left. Null with no canvas mounted: nothing is reserved.
   */
  fitInsets: (() => Insets) | null = null;

  private fit(targets: readonly BnetNode[]) {
    const bounds = boundsOfCentres(targets);
    if (!bounds) return;
    const size = this._view.viewportSize;
    if (!(size.width > 1 && size.height > 1)) return;
    this.apply(fitting(bounds, size, FIT_MARGIN, ZOOM_RANGE, this.fitInsets?.() ?? NO_INSETS), true);
  }

  private apply(t: CanvasTransform, animated: boolean) {
    this.setView({
      canvasAnimationToken: animated ? (this._view.canvasAnimationToken + 1) | 0 : this._view.canvasAnimationToken,
      canvasScale: t.scale,
      canvasPanOffset: t.pan,
    });
  }

  // ── Routing and the scene ──────────────────────────────────────────────────────────────────

  /**
   * The detours every link takes, memoised on the layout and frozen while a node is dragged (the
   * first read after the release re-plans once). One plan for the renderer, hit tests and export.
   */
  get routePlan(): LinkRoutePlan {
    const { nodes, links } = this;
    if (this.cachedPlan && this.cachedPlanNodes === nodes && this.cachedPlanLinks === links) return this.cachedPlan;
    if (this._view.isDraggingNode && this.cachedPlan && this.cachedPlanLinks === links) return this.cachedPlan;
    const plan = buildRoutePlan(nodes, links);
    this.cachedPlan = plan;
    this.cachedPlanNodes = nodes;
    this.cachedPlanLinks = links;
    return plan;
  }

  makeScene(): CanvasScene {
    return buildScene({ nodes: this.nodes, links: this.links, transform: this.canvasTransform, classFilter: this._view.classFilter, routePlan: this.routePlan });
  }

  // ── Snapping and nudging ───────────────────────────────────────────────────────────────────

  snapIfNeeded(p: Point): Point {
    const v = this._view;
    if (!v.snapToGrid || v.snapSuspended) return p;
    return { x: roundAway(p.x / GRID_SPACING) * GRID_SPACING, y: roundAway(p.y / GRID_SPACING) * GRID_SPACING };
  }

  setSnapToGrid(on: boolean) {
    this.setView({ snapToGrid: on });
  }

  /** One arrow press, world pt: a whole grid cell (⇧ four) while snapping, else 1 pt (⇧ 10 pt). */
  nudgeStep(coarse: boolean): number {
    if (this._view.snapToGrid) return GRID_SPACING * (coarse ? 4 : 1);
    return coarse ? NUDGE_STEP.coarse : NUDGE_STEP.fine;
  }

  /**
   * Moves the selection by `delta`, coalescing a run of presses into one undo step. Snapping is
   * applied to the anchor only (the single selection, else the first in reading order) and its
   * delta given to every node, so a group at mixed sub-grid offsets keeps its shape.
   */
  nudgeSelection(delta: Size) {
    const ids = this.currentSelectionIDs();
    if (!ids.size) return;
    const now = editorClock.now();
    const continues = this.nudgeRunIDs !== null && sameSet(this.nudgeRunIDs, ids) && now - this.lastNudgeTime < NUDGE_RUN_TIMEOUT;
    if (!continues) {
      this.endNudgeRun();
      this.beginMutation(ids.size > 1 ? "Move Nodes" : "Move Node");
      this.nudgeRunIDs = ids;
    }
    this.lastNudgeTime = now;
    const anchorID = this._view.selectedNodeID ?? this.nodesInReadingOrder.find((n) => ids.has(n.id))?.id ?? null;
    let applied = delta;
    const anchor = anchorID ? this.node(anchorID) : undefined;
    if (this._view.snapToGrid && anchor) {
      const target = this.snapIfNeeded({ x: anchor.position[0] + delta.width, y: anchor.position[1] + delta.height });
      applied = { width: target.x - anchor.position[0], height: target.y - anchor.position[1] };
      if (applied.width === 0 && applied.height === 0) applied = delta;
    }
    this.setNodes(this.nodes.map((n) => (ids.has(n.id) ? { ...n, position: [n.position[0] + applied.width, n.position[1] + applied.height] } : n)));
  }

  /** Closes an open arrow-key run, committing its one undo step. */
  endNudgeRun() {
    if (this.nudgeRunIDs === null) return;
    this.nudgeRunIDs = null;
    this.lastNudgeTime = -Infinity;
    this.endMutation();
  }

  // ── Node and link mutations ────────────────────────────────────────────────────────────────

  /** `snap: false` places exactly: the drag has already decided per axis between grid and guide. */
  moveNode(id: string, to: Point, snap = true) {
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i < 0) return;
    const p = snap ? this.snapIfNeeded(to) : to;
    this.updateNodeAt(i, (n) => ({ ...n, position: [p.x, p.y] }));
  }

  /**
   * Places several nodes exactly (`moveNode(id, p, snap: false)` for each), in one store write: a
   * drag frame moving a group costs one document change, not one per node. Unknown ids are skipped.
   */
  moveNodes(to: ReadonlyMap<string, Point>) {
    if (!to.size) return;
    let changed = false;
    const nodes = this.nodes.map((n) => {
      const p = to.get(n.id);
      if (!p || (p.x === n.position[0] && p.y === n.position[1])) return n;
      changed = true;
      return { ...n, position: [p.x, p.y] as [number, number] };
    });
    if (changed) this.setNodes(nodes);
  }

  /** Shifts every node of the group by `delta` (inside an open drag mutation). */
  moveSelectedNodes(delta: Size) {
    const ids = this._view.selectedNodeIDs;
    this.setNodes(this.nodes.map((n) => (ids.has(n.id) ? { ...n, position: [n.position[0] + delta.width, n.position[1] + delta.height] } : n)));
  }

  moveLink(id: string, by: Size) {
    const link = this.link(id);
    if (!link || !this.node(link.fromNodeID) || !this.node(link.toNodeID)) return;
    this.performMutation("Move Link", () => {
      const ends = new Set([link.fromNodeID, link.toNodeID]);
      // A self-loop's one node moves twice, as 0.90.34's index arithmetic did.
      const times = (nid: string) => (link.fromNodeID === link.toNodeID && nid === link.fromNodeID ? 2 : 1);
      this.setNodes(this.nodes.map((n) => (ends.has(n.id) ? { ...n, position: [n.position[0] + by.width * times(n.id), n.position[1] + by.height * times(n.id)] } : n)));
    });
    this.status(`Moved link ${this.linkLabel(link)}.`);
  }

  /** Adds a node: auto-named S1 / B1 / Src1 / Sink1 unless `name` is given, born at ρ = 0.9. */
  addNode(kind: NodeKind, at: Point, name?: string): BnetNode {
    let created!: BnetNode;
    this.performMutation(`Add ${KIND_NAMES[kind]}`, () => {
      const custom = name?.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
      let resolved: string;
      if (custom) resolved = custom;
      else
        switch (kind) {
          case "station":
            resolved = `S${++this.stationCount}`;
            break;
          case "buffer":
            resolved = `B${++this.bufferCount}`;
            break;
          case "source":
            resolved = `Src${++this.sourceCount}`;
            break;
          case "sink":
            resolved = `Sink${++this.sinkCount}`;
            break;
        }
      const node = makeNode(kind, resolved, at);
      if (kind === "source") {
        node.distribution = "poisson";
        node.distributionParameters = defaultParameters("poisson");
      } else if (kind === "station") {
        node.distributionParameters = `rate=${DEFAULT_SERVICE_RATE_LITERAL}`;
      }
      this.setNodes([...this.nodes, node]);
      created = node;
      this.setView({ selectedNodeID: node.id, selectedLinkID: null });
      let note: string;
      switch (kind) {
        case "station":
          note = ` — μ = ${DEFAULT_SERVICE_RATE_LITERAL}, so ρ = ${displayFixed(DEFAULT_TARGET_RHO, 3)} against the default source rate.`;
          break;
        case "source":
          note = ` — Poisson arrivals at λ = ${displayFixed(DEFAULT_ARRIVAL_RATE, 3)}.`;
          break;
        default:
          note = ".";
      }
      this.status(`Added ${KIND_NAMES[kind].toLowerCase()} ${resolved}${note}`);
    });
    return created;
  }

  /** A link with explicit endpoints, class and weight (the AI's add_link); validation is the caller's. */
  addLink(fromID: string, toID: string, customerClass = 0, toCustomerClass: number | null = null, routingProbability = 1.0): BnetLink {
    let created!: BnetLink;
    this.performMutation("Add Link", () => {
      const link = makeLink(fromID, toID, customerClass, routingProbability, toCustomerClass);
      this.setLinks([...this.links, link]);
      created = link;
      this.setView({ selectedLinkID: link.id });
      this.status(`Added link ${this.linkLabel(link)} [${classLabel(customerClass)}].`);
    });
    return created;
  }

  deleteNode(id: string) {
    if (!this.node(id)) return;
    this.performMutation("Delete Node", () => {
      const removed = this.node(id);
      if (!removed) return;
      const linksBefore = this.links.length;
      this.write({
        nodes: this.nodes.filter((n) => n.id !== id),
        links: this.links.filter((l) => l.fromNodeID !== id && l.toNodeID !== id),
      });
      const removedLinks = linksBefore - this.links.length;
      const v = this._view;
      const ids = new Set(v.selectedNodeIDs);
      ids.delete(id);
      this.setView({
        selectedNodeID: v.selectedNodeID === id ? null : v.selectedNodeID,
        selectedNodeIDs: ids,
        pendingLinkStartID: v.pendingLinkStartID === id ? null : v.pendingLinkStartID,
        activeLinkSourceID: v.activeLinkSourceID === id ? null : v.activeLinkSourceID,
        parameterEditorTarget: v.parameterEditorTarget === id ? null : v.parameterEditorTarget,
      });
      this.status(removedLinks > 0 ? `Deleted ${removed.name} and ${removedLinks} connected link(s).` : `Deleted ${removed.name}.`);
    });
  }

  deleteLink(id: string) {
    if (!this.link(id)) return;
    this.performMutation("Delete Link", () => {
      const link = this.link(id);
      if (!link) return;
      const label = this.linkLabel(link);
      this.setLinks(this.links.filter((l) => l.id !== id));
      if (this._view.selectedLinkID === id) this.setView({ selectedLinkID: null });
      this.status(`Deleted link ${label}.`);
    });
  }

  /** Edit ▸ Delete, ⌫ and the context menu: the selected nodes with their links, and a selected link. */
  deleteSelection() {
    const ids = this.currentSelectionIDs();
    const linkID = this._view.selectedLinkID;
    if (!ids.size && linkID === null) return;
    const sel = this.link(linkID);
    const linkLabelText = sel ? this.linkLabel(sel) : null;
    const actionName = !ids.size ? "Delete Link" : ids.size === 1 && linkID === null ? "Delete Node" : "Delete Selection";
    let removedNodes = 0;
    let removedLinks = 0;
    this.performMutation(actionName, () => {
      const linksBefore = this.links.length;
      let links = linkID ? this.links.filter((l) => l.id !== linkID) : [...this.links];
      const nodesBefore = this.nodes.length;
      const nodes = this.nodes.filter((n) => !ids.has(n.id));
      links = links.filter((l) => !ids.has(l.fromNodeID) && !ids.has(l.toNodeID));
      this.write({ nodes, links });
      removedNodes = nodesBefore - nodes.length;
      removedLinks = linksBefore - links.length;
      this.setView({
        selectedNodeID: null,
        selectedNodeIDs: new Set(),
        selectedLinkID: null,
        pendingLinkStartID: null,
        activeLinkSourceID: null,
        parameterEditorTarget: null,
      });
    });
    if (removedNodes === 0 && linkLabelText !== null) this.status(`Deleted link ${linkLabelText}.`);
    else this.status(`Deleted ${removedNodes} node${removedNodes === 1 ? "" : "s"}${removedLinks > 0 ? ` and ${removedLinks} link${removedLinks === 1 ? "" : "s"}` : ""}.`);
  }

  // ── Clipboard ──────────────────────────────────────────────────────────────────────────────

  get canPaste(): boolean {
    return this.clipboardNodes.length > 0;
  }

  /** The selected nodes and only the links with both ends among them. */
  copySelection() {
    const ids = this.currentSelectionIDs();
    if (!ids.size) {
      this.status("Nothing selected to copy. Use the Multi-Select tool to drag a rectangle around nodes, or ⌘A to Select All.");
      return;
    }
    this.clipboardNodes = this.nodes.filter((n) => ids.has(n.id));
    this.clipboardLinks = this.links.filter((l) => ids.has(l.fromNodeID) && ids.has(l.toNodeID));
    const n = this.clipboardNodes.length;
    const l = this.clipboardLinks.length;
    this.status(`Copied ${n} node${n === 1 ? "" : "s"}${l > 0 ? ` and ${l} link${l === 1 ? "" : "s"}` : ""}.`);
  }

  /** Copy, then delete; refuses a link-only selection (⌘V couldn't bring it back). */
  cutSelection() {
    const ids = this.currentSelectionIDs();
    if (!ids.size) {
      this.status("Nothing selected to cut. Select nodes to cut, or press Delete to remove a selected link.");
      return;
    }
    const sel = this.link(this._view.selectedLinkID);
    if (sel && !(ids.has(sel.fromNodeID) && ids.has(sel.toNodeID))) this.setView({ selectedLinkID: null });
    this.copySelection();
    this.deleteSelection();
  }

  pasteSelection() {
    if (!this.clipboardNodes.length) {
      this.status("Clipboard is empty — copy a selection first.");
      return;
    }
    this.performMutation("Paste", () => this.pasteClipboardContents());
  }

  /** ⌘D: copy and paste in one, leaving the clipboard as it was. */
  duplicateSelection() {
    const ids = this.currentSelectionIDs();
    if (!ids.size) return;
    const dupNodes = this.nodes.filter((n) => ids.has(n.id));
    const dupLinks = this.links.filter((l) => ids.has(l.fromNodeID) && ids.has(l.toNodeID));
    this.performMutation("Duplicate", () => this.withClipboard(dupNodes, dupLinks, () => this.pasteClipboardContents()));
  }

  /** ⌥-drag: copies in place (the drag supplies the offset) and selects them; call inside an open mutation. */
  duplicateSelectionInPlaceForDrag(): Set<string> {
    const ids = this.currentSelectionIDs();
    if (!ids.size) return new Set();
    const dupNodes = this.nodes.filter((n) => ids.has(n.id));
    const dupLinks = this.links.filter((l) => ids.has(l.fromNodeID) && ids.has(l.toNodeID));
    this.withClipboard(dupNodes, dupLinks, () => this.pasteClipboardContents(0, false));
    return this.currentSelectionIDs();
  }

  private withClipboard(nodes: BnetNode[], links: BnetLink[], f: () => void) {
    const sn = this.clipboardNodes;
    const sl = this.clipboardLinks;
    this.clipboardNodes = nodes;
    this.clipboardLinks = links;
    try {
      f();
    } finally {
      this.clipboardNodes = sn;
      this.clipboardLinks = sl;
    }
  }

  private pasteClipboardContents(offset = 60, announce = true) {
    const added = this.appendRenamedCopies(this.clipboardNodes, this.clipboardLinks, { width: offset, height: offset });
    this.setView({
      selectedNodeIDs: new Set(added.nodes.map((n) => n.id)),
      selectedNodeID: added.nodes.length === 1 ? added.nodes[0].id : null,
      selectedLinkID: null,
    });
    if (!announce) return;
    const n = added.nodes.length;
    const l = added.links.length;
    this.status(`Pasted ${n} node${n === 1 ? "" : "s"}${l > 0 ? ` and ${l} link${l === 1 ? "" : "s"}` : ""}.`);
  }

  /**
   * Appends nodes and links under fresh names and ids, displaced by `translation`: the one
   * implementation behind Paste, Duplicate, ⌥-drag and insertSubnetwork. Re-primes the counters
   * against the canvas first so a paste can never make a second "S3".
   */
  private appendRenamedCopies(incomingNodes: readonly BnetNode[], incomingLinks: readonly BnetLink[], translation: Size): { nodes: BnetNode[]; links: BnetLink[] } {
    this.stationCount = Math.max(this.stationCount, this.maxNameIndex("station", "S"));
    this.bufferCount = Math.max(this.bufferCount, this.maxNameIndex("buffer", "B"));
    this.sourceCount = Math.max(this.sourceCount, this.maxNameIndex("source", "Src"));
    this.sinkCount = Math.max(this.sinkCount, this.maxNameIndex("sink", "Sink"));
    const idMap = new Map<string, string>();
    const newNodes: BnetNode[] = [];
    for (const src of incomingNodes) {
      let name: string;
      switch (src.kind) {
        case "station":
          name = `S${++this.stationCount}`;
          break;
        case "buffer":
          name = `B${++this.bufferCount}`;
          break;
        case "source":
          name = `Src${++this.sourceCount}`;
          break;
        case "sink":
          name = `Sink${++this.sinkCount}`;
          break;
      }
      const n: BnetNode = {
        ...makeNode(src.kind, name, { x: src.position[0] + translation.width, y: src.position[1] + translation.height }),
        bufferSize: src.bufferSize,
        numberOfServers: src.numberOfServers,
        distribution: src.distribution,
        distributionParameters: src.distributionParameters,
        serviceDistributions: { ...src.serviceDistributions },
        picture: src.picture,
      };
      idMap.set(src.id, n.id);
      newNodes.push(n);
    }
    const newLinks: BnetLink[] = [];
    for (const l of incomingLinks) {
      const from = idMap.get(l.fromNodeID);
      const to = idMap.get(l.toNodeID);
      if (!from || !to) continue;
      newLinks.push(makeLink(from, to, l.customerClass, l.routingProbability, l.toCustomerClass ?? null));
    }
    this.write({ nodes: [...this.nodes, ...newNodes], links: [...this.links, ...newLinks] });
    return { nodes: newNodes, links: newLinks };
  }

  /**
   * Inserts a whole sub-network (an archetype) as ONE undo step, renamed and re-classed into this
   * document and placed clear to the right of what is already on the canvas. Returns the new ids.
   */
  insertSubnetwork(incomingNodes: readonly BnetNode[], incomingLinks: readonly BnetLink[], newInfiniteBuffers: boolean, origin: Point, actionName: string, detail: string | null = null): Set<string> {
    if (!incomingNodes.length) return new Set();
    const canvasWasEmpty = this.nodes.length === 0;
    const regimeAdopted = canvasWasEmpty || newInfiniteBuffers === this.infiniteBuffers;
    const keptRegimeIsInfinite = this.infiniteBuffers;
    const priorClassCount = this.numberOfCustomerClasses;
    let inserted: BnetNode[] = [];
    let insertedLinks: BnetLink[] = [];
    let insertedClasses: number[] = [];
    this.performMutation(actionName, () => {
      const added = this.appendRenamedCopies(incomingNodes, incomingLinks, this.insertionTranslation(incomingNodes, origin));
      inserted = added.nodes;
      insertedLinks = added.links;
      if (regimeAdopted) this.write({ infiniteBuffers: newInfiniteBuffers });
      insertedClasses = this.remapInsertedCustomerClasses(incomingNodes, added.nodes, new Set(added.links.map((l) => l.id)), priorClassCount);
      this.setNodeSelection(new Set(added.nodes.map((n) => n.id)));
      this.setView({ selectedLinkID: null });
    });
    this.setView({ pendingFitOnAppear: true });
    const n = inserted.length;
    const l = insertedLinks.length;
    this.status(
      `${actionName}: added ${n} node${n === 1 ? "" : "s"} and ${l} link${l === 1 ? "" : "s"}` +
        (regimeAdopted && canvasWasEmpty && !newInfiniteBuffers ? ", with finite buffers" : "") +
        "." +
        (detail !== null ? ` ${detail}.` : "") +
        (regimeAdopted
          ? ""
          : ` The network stays on ${keptRegimeIsInfinite ? "infinite" : "finite"} buffers — an insert never re-interprets the stations already on the canvas. Use Network ▸ Buffer Model to change the whole network.`) +
        (insertedClasses.some((c) => c !== 0) ? ` Its traffic is ${[...insertedClasses].sort((a, b) => a - b).map(classLabel).join(", ")}, because the canvas already had a source.` : ""),
    );
    return new Set(inserted.map((x) => x.id));
  }

  private remapInsertedCustomerClasses(incoming: readonly BnetNode[], inserted: readonly BnetNode[], linkIDs: Set<string>, priorClassCount: number): number[] {
    const incomingSources = incoming.map((element, offset) => ({ element, offset })).filter((e) => e.element.kind === "source");
    if (!incomingSources.length || inserted.length !== incoming.length) return [];
    const classMap = new Map<number, number>();
    const ownOrder = [...incomingSources].sort((a, b) => cmp(sortIndex(a.element.name), sortIndex(b.element.name)));
    ownOrder.forEach((entry, ownClass) => classMap.set(ownClass, this.customerClassIndex(inserted[entry.offset].id)));
    const derivedBase = Math.max(priorClassCount, (classMap.size ? Math.max(...classMap.values()) : -1) + 1);
    const mapped = (c: number) => {
      const moved = classMap.get(c);
      if (moved !== undefined) return moved;
      if (c < incomingSources.length) return c;
      return derivedBase + (c - incomingSources.length);
    };
    const landed = new Set<number>();
    this.setLinks(
      this.links.map((l) => {
        if (!linkIDs.has(l.id)) return l;
        const next: BnetLink = { ...l, customerClass: mapped(l.customerClass) };
        if (l.toCustomerClass !== undefined) next.toCustomerClass = mapped(l.toCustomerClass);
        landed.add(next.customerClass);
        return next;
      }),
    );
    return [...landed].sort((a, b) => a - b);
  }

  private insertionTranslation(incoming: readonly BnetNode[], origin: Point): Size {
    if (!incoming.length) return { width: 0, height: 0 };
    const inMinX = Math.min(...incoming.map((n) => n.position[0]));
    const inMinY = Math.min(...incoming.map((n) => n.position[1]));
    if (!this.nodes.length) return { width: origin.x - inMinX, height: origin.y - inMinY };
    const exMaxX = Math.max(...this.nodes.map((n) => n.position[0]));
    const exMinY = Math.min(...this.nodes.map((n) => n.position[1]));
    return { width: exMaxX + INSERT_GAP - inMinX, height: exMinY - inMinY };
  }

  // ── Link chains (the Link tool) ────────────────────────────────────────────────────────────

  private handleLinkSelection(nodeID: string) {
    const tapped = this.node(nodeID);
    if (!tapped) return;
    const startID = this._view.pendingLinkStartID;
    if (startID === null) {
      if (tapped.kind === "sink") {
        this.status(`Cannot link out of ${tapped.name}: a sink is where jobs leave the network.`);
        return;
      }
      if (tapped.kind === "source") this.setView({ activeCustomerClass: this.customerClassIndex(nodeID), activeLinkSourceID: nodeID });
      else this.setView({ activeLinkSourceID: null });
      this.setView({ pendingLinkStartID: nodeID, selectedNodeID: nodeID, selectedLinkID: null });
      this.status(`Link start: ${tapped.name}. Click target node.`);
      return;
    }
    if (startID === nodeID) {
      const refuse = (why: string) => {
        this.status(`Cannot link ${tapped.name} to itself: ${why}`);
        this.setView({ pendingLinkStartID: null });
      };
      if (tapped.kind === "source") return refuse("a source has no service to repeat.");
      if (tapped.kind === "sink") return refuse("a sink is where jobs leave the network.");
      if (tapped.kind === "buffer") return refuse("a buffer has no service to repeat — put the loop on the station it feeds.");
    }
    const startNode = this.node(startID);
    if (!startNode) {
      this.setView({ pendingLinkStartID: null });
      return;
    }
    let candidates: number[];
    if (startNode.kind === "source") candidates = [this.customerClassIndex(startID)];
    else if (startNode.kind === "buffer" || startNode.kind === "station") {
      const incoming = new Set(this.links.filter((l) => l.toNodeID === startID).map((l) => l.customerClass));
      if (!incoming.size) {
        this.status(`Cannot add link: ${startNode.name} has no incoming links.`);
        this.setView({ pendingLinkStartID: null });
        return;
      }
      candidates = [...incoming].sort((a, b) => a - b);
    } else {
      this.status(`Cannot link out of ${startNode.name}: a sink is where jobs leave the network.`);
      this.setView({ pendingLinkStartID: null });
      return;
    }
    const used = new Set(this.links.filter((l) => l.fromNodeID === startID && l.toNodeID === nodeID).map((l) => l.customerClass));
    const available = candidates.filter((c) => !used.has(c));
    if (!available.length) {
      this.status(`All available classes already linked from ${startNode.name} to ${tapped.name}.`);
      return;
    }
    const chosen = available.includes(0) ? 0 : available[0];
    this.performMutation("Add Link", () => {
      const link = makeLink(startID, nodeID, chosen, 1.0, null);
      this.setLinks([...this.links, link]);
      this.setView({ selectedLinkID: link.id, activeCustomerClass: chosen });
      const chainEnds = tapped.kind === "sink";
      this.status(
        `Linked ${this.linkLabel(link)} [${classLabel(chosen)}].` +
          (chainEnds ? ` Chain complete at ${tapped.name} — click a node to start another.` : " Click next node to continue chain."),
      );
      const total = this.links.filter((l) => l.fromNodeID === startID && l.customerClass === chosen).reduce((s, l) => s + l.routingProbability, 0);
      if (total > 1.0 + 1e-6) {
        this.status(`Routing from ${startNode.name} for ${classLabel(chosen)} now sums to ${formatSig(total, READOUT_DIGITS)} — set the probabilities in the Inspector.`);
      }
      this.setView({ pendingLinkStartID: chainEnds ? null : nodeID, selectedNodeID: nodeID });
    });
  }

  private cycleLinkCustomerClass(linkID: string) {
    const index = this.links.findIndex((l) => l.id === linkID);
    if (index < 0) return;
    const link = this.links[index];
    const total = Math.max(this.numberOfCustomerClasses, 1);
    const used = new Set(this.links.filter((l) => l.fromNodeID === link.fromNodeID && l.toNodeID === link.toNodeID && l.id !== linkID).map((l) => l.customerClass));
    for (let offset = 1; offset <= total; offset++) {
      const next = (link.customerClass + offset) % total;
      if (!used.has(next)) {
        this.performMutation("Change Link Class", () => {
          this.updateLinkAt(index, (l) => ({ ...l, customerClass: next }));
          this.noteParametersChanged();
        });
        this.status(`Changed ${this.linkLabel(this.links[index])} to ${classLabel(next)}.`);
        return;
      }
    }
    this.status("All customer classes are already used for this link pair.");
  }

  // ── Parameter mutations (the inspectors, the AI, context menus) ────────────────────────────

  updateLinkProbability(linkID: string, probability: number) {
    const i = this.links.findIndex((l) => l.id === linkID);
    if (i < 0) return;
    const clamped = Math.min(Math.max(probability, 0), 1);
    if (this.links[i].routingProbability === clamped) return;
    this.performParameterMutation("Change Routing Probability", () => {
      this.updateLinkAt(i, (l) => ({ ...l, routingProbability: clamped }));
      this.noteParametersChanged();
    });
    this.parameterStatus(`Updated ${this.linkLabel(this.links[i])} routing probability to ${formatSig(clamped, 4)}.`);
  }

  updateLinkCustomerClass(linkID: string, customerClass: number) {
    const i = this.links.findIndex((l) => l.id === linkID);
    if (i < 0 || this.links[i].customerClass === customerClass) return;
    this.performParameterMutation("Change Link Class", () => {
      this.updateLinkAt(i, (l) => ({ ...l, customerClass }));
      this.noteParametersChanged();
    });
    this.parameterStatus(`Updated ${this.linkLabel(this.links[i])} to ${classLabel(customerClass)}.`);
  }

  /** null clears the class transition. */
  updateLinkExitClass(linkID: string, exitClass: number | null) {
    const i = this.links.findIndex((l) => l.id === linkID);
    if (i < 0 || (this.links[i].toCustomerClass ?? null) === exitClass) return;
    this.performParameterMutation("Change Exit Class", () => {
      this.updateLinkAt(i, (l) => {
        const next = { ...l };
        if (exitClass === null) delete next.toCustomerClass;
        else next.toCustomerClass = exitClass;
        return next;
      });
      this.noteParametersChanged();
    });
    const l = this.links[i];
    if (exitClass !== null && exitClass !== l.customerClass) this.parameterStatus(`${this.linkLabel(l)} now transitions to ${classLabel(exitClass)} on exit.`);
    else this.parameterStatus(`${this.linkLabel(l)} exit class cleared (no transition).`);
  }

  renameNode(nodeID: string, name: string) {
    const i = this.nodes.findIndex((n) => n.id === nodeID);
    if (i < 0) return;
    const oldName = this.nodes[i].name;
    const trimmed = name.replace(/^\s+|\s+$/g, "");
    if (!trimmed || trimmed === oldName) return;
    this.performParameterMutation("Rename Node", () => {
      this.updateNodeAt(i, (n) => ({ ...n, name: trimmed }));
      this.noteParametersChanged();
    });
    this.parameterStatus(`Renamed ${oldName} to ${trimmed}.`);
  }

  updateBufferSize(nodeID: string, size: number) {
    const i = this.nodes.findIndex((n) => n.id === nodeID && n.kind === "buffer");
    if (i < 0) return;
    const clamped = Math.max(1, size);
    if (this.nodes[i].bufferSize === clamped) return;
    this.performParameterMutation("Change Buffer Size", () => {
      this.updateNodeAt(i, (n) => ({ ...n, bufferSize: clamped }));
      this.noteParametersChanged();
    });
    this.parameterStatus(`Updated ${this.nodes[i].name} buffer size to ${clamped}.`);
  }

  /** The network-wide buffer regime. */
  setInfiniteBuffers(infinite: boolean) {
    if (this.infiniteBuffers === infinite) return;
    this.performParameterMutation("Change Buffer Mode", () => {
      this.write({ infiniteBuffers: infinite });
      this.noteParametersChanged();
    });
    this.parameterStatus(infinite ? "Network buffers set to infinite (capacity limits ignored)." : "Network buffers set to finite (per-buffer sizes apply).");
  }

  /**
   * The population of a closed network (new in 2.1): a whole number of at least 1, or null to make
   * the network open again. One undoable step.
   */
  setClosedPopulation(population: number | null) {
    const next = population === null ? undefined : Math.max(1, Math.round(population));
    if (this.closedPopulation === next) return;
    this.performParameterMutation(next === undefined ? "Remove Population" : "Change Population", () => {
      this.write({ closedPopulation: next });
      this.noteParametersChanged();
    });
    this.parameterStatus(next === undefined ? "The network no longer has a fixed population." : `Closed network population set to ${next} customer${next === 1 ? "" : "s"}.`);
  }

  // ── Priorities, batch arrivals, rate profiles (new in 2.1; core/src/extended.rs) ────────────
  // Each key is in the node only while the feature is used, so a network that uses none is the
  // file 2.0 wrote, key for key.

  /** A station's order of service. "fcfs" removes both keys; a priority discipline keeps `order` (class indices, highest first). */
  updateServiceDiscipline(nodeID: string, discipline: ServiceDiscipline, order: readonly number[]) {
    const i = this.nodes.findIndex((n) => n.id === nodeID && n.kind === "station");
    if (i < 0) return;
    const now = this.nodes[i];
    const fcfs = discipline === "fcfs";
    if ((now.serviceDiscipline ?? "fcfs") === discipline && (fcfs || JSON.stringify(now.priorityOrder ?? []) === JSON.stringify(order))) return;
    const reordered = !fcfs && (now.serviceDiscipline ?? "fcfs") === discipline;
    this.performParameterMutation(reordered ? "Change Priority Order" : "Change Service Discipline", () => {
      this.updateNodeAt(i, (n) => {
        const { serviceDiscipline: _d, priorityOrder: _o, ...rest } = n;
        return fcfs ? rest : { ...rest, serviceDiscipline: discipline, priorityOrder: [...order] };
      });
      this.noteParametersChanged();
    });
    this.parameterStatus(fcfs ? `${now.name} now serves first come, first served.` : reordered ? `Updated ${now.name}'s priority order to ${order.map(classLabel).join(" > ")}.` : `${now.name} now serves by priority (${discipline === "priorityPreemptiveResume" ? "preemptive-resume" : "non-preemptive"}): ${order.map(classLabel).join(" > ")}.`);
  }

  /** A source's batch-size law, or null for one customer at a time (the key is removed). */
  updateBatchSize(nodeID: string, batch: BatchSize | null) {
    const i = this.nodes.findIndex((n) => n.id === nodeID && n.kind === "source");
    if (i < 0) return;
    const now = this.nodes[i];
    if (JSON.stringify(now.batchSize ?? null) === JSON.stringify(batch)) return;
    this.performParameterMutation("Change Batch Size", () => {
      this.updateNodeAt(i, (n) => {
        const { batchSize: _b, ...rest } = n;
        return batch === null ? rest : { ...rest, batchSize: batch };
      });
      this.noteParametersChanged();
    });
    this.parameterStatus(batch === null ? `${now.name} now emits one customer at a time.` : `Updated ${now.name}'s batch sizes.`);
  }

  /** A source's rate profile, or null for a constant rate (the key is removed). */
  updateRateProfile(nodeID: string, profile: RateProfile | null) {
    const i = this.nodes.findIndex((n) => n.id === nodeID && n.kind === "source");
    if (i < 0) return;
    const now = this.nodes[i];
    if (JSON.stringify(now.rateProfile ?? null) === JSON.stringify(profile)) return;
    this.performParameterMutation("Change Rate Profile", () => {
      this.updateNodeAt(i, (n) => {
        const { rateProfile: _r, ...rest } = n;
        return profile === null ? rest : { ...rest, rateProfile: profile };
      });
      this.noteParametersChanged();
    });
    this.parameterStatus(profile === null ? `${now.name} now arrives at a constant rate.` : `Updated ${now.name}'s rate profile.`);
  }

  updateNumberOfServers(nodeID: string, count: number) {
    const i = this.nodes.findIndex((n) => n.id === nodeID && n.kind === "station");
    if (i < 0) return;
    const clamped = Math.max(1, count);
    if (this.nodes[i].numberOfServers === clamped) return;
    this.performParameterMutation("Change Number of Servers", () => {
      this.updateNodeAt(i, (n) => ({ ...n, numberOfServers: clamped }));
      this.noteParametersChanged();
    });
    this.parameterStatus(`Updated ${this.nodes[i].name} to ${clamped} server${clamped === 1 ? "" : "s"}.`);
  }

  /** `picture` is the SF Symbol name a .bnet stores, "" for none; `displayName` the picker's label. */
  updateStationPicture(nodeID: string, picture: string, displayName: string) {
    const i = this.nodes.findIndex((n) => n.id === nodeID);
    if (i < 0 || this.nodes[i].kind !== "station" || this.nodes[i].picture === picture) return;
    this.performParameterMutation("Change Station Picture", () => {
      this.updateNodeAt(i, (n) => ({ ...n, picture }));
    });
    if (picture === "") this.parameterStatus(`Cleared picture on ${this.nodes[i].name}.`);
    else this.parameterStatus(`Set ${this.nodes[i].name} picture to "${displayName}".`);
  }

  updateNodeDistribution(nodeID: string, distribution: string, parameters: string) {
    const i = this.nodes.findIndex((n) => n.id === nodeID && (n.kind === "station" || n.kind === "source"));
    if (i < 0) return;
    const trimmed = parameters.replace(/^\s+|\s+$/g, "");
    const resolved = trimmed || defaultParameters(distribution);
    const n0 = this.nodes[i];
    if (n0.distribution === distribution && n0.distributionParameters === resolved) return;
    this.performParameterMutation("Change Distribution", () => {
      this.updateNodeAt(i, (n) => ({ ...n, distribution, distributionParameters: resolved }));
      this.noteParametersChanged();
    });
    const process = this.nodes[i].kind === "station" ? "service" : "interarrival";
    this.parameterStatus(`Updated ${this.nodes[i].name} ${process} distribution to ${distributionDisplayName(distribution)} (${resolved}).`);
  }

  updateServiceDistribution(nodeID: string, customerClass: number, distribution: string, parameters: string) {
    const i = this.nodes.findIndex((n) => n.id === nodeID && n.kind === "station");
    if (i < 0) return;
    const trimmed = parameters.replace(/^\s+|\s+$/g, "");
    const params = trimmed || defaultParameters(distribution);
    const key = String(customerClass);
    const cur = this.nodes[i].serviceDistributions[key];
    if (cur && cur.distribution === distribution && cur.distributionParameters === params) return;
    this.performParameterMutation("Change Service Distribution", () => {
      this.updateNodeAt(i, (n) => ({ ...n, serviceDistributions: { ...n.serviceDistributions, [key]: { distribution, distributionParameters: params } } }));
      this.noteParametersChanged();
    });
    this.parameterStatus(`Updated ${this.nodes[i].name} service distribution for ${classLabel(customerClass)} to ${distributionDisplayName(distribution)} (${params}).`);
  }

  private parameterStatus(message: string) {
    if (this.suppressParameterStatus) return;
    this.status(message);
  }

  private noteParametersChanged() {
    if (this.pendingMutationSnapshot !== null) this.pendingGroupTouchedParameters = true;
    else this.onParametersChanged();
  }

  private performParameterMutation(name: string, block: () => void) {
    if (this.pendingMutationSnapshot !== null) block();
    else this.performMutation(name, block);
  }

  /**
   * Every parameter mutation in `block` as ONE undo step named `name`, with the per-field Status
   * lines silenced and `summary` written once if anything changed (an inspector's Save). Returns
   * whether the document changed.
   */
  performParameterEdit(name: string, summary: string | null, block: () => void): boolean {
    const ownsGroup = this.pendingMutationSnapshot === null;
    if (ownsGroup) this.beginMutation(name);
    const before = this.snapshot();
    this.suppressParameterStatus = true;
    try {
      block();
    } finally {
      this.suppressParameterStatus = false;
    }
    const changed = !sameDocumentContent(before, this);
    if (ownsGroup) this.endMutation();
    if (changed && summary !== null) this.status(summary);
    return changed;
  }

  /**
   * The docked inspector's commit-on-blur: consecutive commits to the same field (`key`) within
   * 2 s register no new undo entry, so one ⌘Z undoes the whole run.
   */
  performCoalescedParameterEdit(key: string, name: string, summary: string | null, block: () => void): boolean {
    const now = editorClock.now();
    const continues = this.parameterRunKey === key && now - this.lastParameterRunTime < PARAMETER_RUN_TIMEOUT && this.pendingMutationSnapshot === null;
    this.parameterRunKey = key;
    this.lastParameterRunTime = now;
    if (!continues) return this.performParameterEdit(name, summary, block);
    const before = this.snapshot();
    this.suppressParameterStatus = true;
    this.pendingMutationSnapshot = before;
    this.pendingMutationName = name;
    try {
      block();
    } finally {
      this.pendingMutationSnapshot = null;
      this.pendingMutationName = null;
      this.suppressParameterStatus = false;
    }
    const touched = this.pendingGroupTouchedParameters;
    this.pendingGroupTouchedParameters = false;
    if (touched) this.onParametersChanged();
    const changed = !sameDocumentContent(before, this);
    if (changed && summary !== null) this.status(summary);
    return changed;
  }

  endParameterRun() {
    this.parameterRunKey = null;
    this.lastParameterRunTime = -Infinity;
  }

  // ── Parameter panels ───────────────────────────────────────────────────────────────────────

  openParameterEditor(nodeID: string) {
    if (!this.node(nodeID)) return;
    this.setView({ selectedNodeID: nodeID, selectedLinkID: null, parameterEditorTarget: nodeID });
  }

  closeParameterEditor() {
    this.setView({ parameterEditorTarget: null });
  }

  openLinkParameterEditor(linkID: string) {
    if (!this.link(linkID)) return;
    this.setView({ selectedLinkID: linkID, selectedNodeID: null, linkParameterEditorTarget: linkID });
  }

  closeLinkParameterEditor() {
    this.setView({ linkParameterEditorTarget: null });
  }

  /** ⌘I and Return: the single node, else the link, else a one-node group; a beep otherwise. */
  openParameterEditorForSelection() {
    const v = this._view;
    if (v.selectedNodeID) this.openParameterEditor(v.selectedNodeID);
    else if (v.selectedLinkID) this.openLinkParameterEditor(v.selectedLinkID);
    else if (v.selectedNodeIDs.size === 1) this.openParameterEditor([...v.selectedNodeIDs][0]);
    else editorFeedback.beep();
  }

  get canOpenParameterEditor(): boolean {
    const v = this._view;
    return v.selectedNodeID !== null || v.selectedLinkID !== null || v.selectedNodeIDs.size === 1;
  }

  // ── Whole-network commands ─────────────────────────────────────────────────────────────────

  straightenNetwork() {
    if (!this.nodes.length) {
      this.status("Nothing to straighten.");
      return;
    }
    this.performMutation("Straighten Network", () => {
      this.straightenNodesInPlace();
      this.status("Straightened network layout.");
    });
  }

  private straightenNodesInPlace() {
    const nodes = this.nodes;
    const sorted = [...nodes].sort((a, b) => (a.position[0] === b.position[0] ? swiftStringCompare(a.name, b.name) : cmp(a.position[0], b.position[0])));
    const targetY = nodes.reduce((s, n) => s + n.position[1], 0) / nodes.length;
    const minX = sorted[0]?.position[0] ?? 80;
    const spacing = 88;
    const pos = new Map<string, [number, number]>();
    sorted.forEach((n, i) => pos.set(n.id, [minX + i * spacing, targetY]));
    this.setNodes(nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
  }

  /** Network ▸ Straighten and Fit to Window: rewrites the positions (one undo step), then shows zoom 1. */
  fitNetworkToWindow() {
    if (!this.nodes.length) {
      this.status("Nothing to fit.");
      return;
    }
    const size = this._view.viewportSize;
    if (!(size.width > 1 && size.height > 1)) {
      this.status("Canvas size not yet known; try again after the window finishes laying out.");
      return;
    }
    this.performMutation("Straighten and Fit", () => this.fitNetworkToWindowInPlace(size));
    this.setView({ canvasAnimationToken: (this._view.canvasAnimationToken + 1) | 0, canvasScale: 1, canvasPanOffset: { width: 0, height: 0 } });
    this.status("Straightened and fit the network to the window.");
  }

  private fitNetworkToWindowInPlace(size: Size) {
    this.straightenNodesInPlace();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.position[0]);
      y0 = Math.min(y0, n.position[1]);
      x1 = Math.max(x1, n.position[0]);
      y1 = Math.max(y1, n.position[1]);
    }
    const bw = Math.max(x1 - x0, 1);
    const bh = Math.max(y1 - y0, 1);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const margin = 80;
    const availW = Math.max(size.width - 2 * margin, 100);
    const availH = Math.max(size.height - 2 * margin, 100);
    const scale = Math.min(availW / bw, availH / bh);
    const tx = size.width / 2;
    const ty = size.height / 2;
    this.setNodes(this.nodes.map((n) => ({ ...n, position: [tx + (n.position[0] - cx) * scale, ty + (n.position[1] - cy) * scale] })));
  }

  /** Edit ▸ Clear Canvas…: empties the document as one undoable step; the view resets outside it. */
  clear() {
    this.performMutation("Clear Canvas", () => {
      this.write({ nodes: [], links: [], infiniteBuffers: false, closedPopulation: undefined });
      this.stationCount = 0;
      this.bufferCount = 0;
      this.sourceCount = 0;
      this.sinkCount = 0;
    });
    this.setView({
      selectedNodeID: null,
      selectedNodeIDs: new Set(),
      multiSelectRect: null,
      multiSelectOrigin: null,
      selectedLinkID: null,
      pendingLinkStartID: null,
      activeLinkSourceID: null,
      parameterEditorTarget: null,
      linkParameterEditorTarget: null,
      hoveredNodeID: null,
      hoveredLinkID: null,
      classFilter: null,
    });
    this.status("Canvas cleared. Edit ▸ Undo brings the network back.");
  }

  // ── Alignment and distribution (the group selection) ───────────────────────────────────────

  alignSelectedNodesTop() {
    this.alignAxis("Align Top", 1, (vs) => Math.min(...vs), "to top");
  }

  alignSelectedNodesBottom() {
    this.alignAxis("Align Bottom", 1, (vs) => Math.max(...vs), "to bottom");
  }

  alignSelectedNodesLeft() {
    this.alignAxis("Align Left", 0, (vs) => Math.min(...vs), "to left");
  }

  alignSelectedNodesRight() {
    this.alignAxis("Align Right", 0, (vs) => Math.max(...vs), "to right");
  }

  alignSelectedNodesHorizontalCentres() {
    this.alignAxis("Align Horizontal Centres", 0, (vs) => (Math.min(...vs) + Math.max(...vs)) / 2, "to their horizontal centre");
  }

  alignSelectedNodesVerticalCentres() {
    this.alignAxis("Align Vertical Centres", 1, (vs) => (Math.min(...vs) + Math.max(...vs)) / 2, "to their vertical centre");
  }

  private alignAxis(name: string, axis: 0 | 1, pick: (vs: number[]) => number, words: string) {
    const ids = this._view.selectedNodeIDs;
    if (ids.size < 2) return;
    this.performMutation(name, () => {
      const vs = this.nodes.filter((n) => ids.has(n.id)).map((n) => n.position[axis]);
      if (!vs.length) return;
      const target = pick(vs);
      this.setNodes(this.nodes.map((n) => (ids.has(n.id) ? { ...n, position: axis === 0 ? [target, n.position[1]] : [n.position[0], target] } : n)));
      this.status(`Aligned ${ids.size} nodes ${words}.`);
    });
  }

  distributeSelectedNodesHorizontally() {
    this.distribute("Distribute Horizontally", 0, "horizontally");
  }

  distributeSelectedNodesVertically() {
    this.distribute("Distribute Vertically", 1, "vertically");
  }

  private distribute(name: string, axis: 0 | 1, words: string) {
    const ids = this._view.selectedNodeIDs;
    if (ids.size < 3) return;
    this.performMutation(name, () => {
      const nodes = this.nodes;
      const sorted = nodes.map((_, i) => i).filter((i) => ids.has(nodes[i].id)).sort((a, b) => cmp(nodes[a].position[axis], nodes[b].position[axis]));
      if (!sorted.length) return;
      const lo = nodes[sorted[0]].position[axis];
      const hi = nodes[sorted[sorted.length - 1]].position[axis];
      const n = sorted.length;
      if (!(hi > lo)) return;
      const step = (hi - lo) / (n - 1);
      const next = [...nodes];
      sorted.forEach((idx, rank) => {
        const p: [number, number] = [...next[idx].position];
        p[axis] = lo + step * rank;
        next[idx] = { ...next[idx], position: p };
      });
      this.setNodes(next);
      this.status(`Distributed ${n} nodes ${words}.`);
    });
  }

  // ── Undo plumbing ──────────────────────────────────────────────────────────────────────────

  private snapshot(): Snapshot {
    return {
      nodes: this.nodes,
      links: this.links,
      infiniteBuffers: this.infiniteBuffers,
      closedPopulation: this.closedPopulation,
      scenarios: this.storeDoc().scenarios,
      stationCount: this.stationCount,
      bufferCount: this.bufferCount,
      sourceCount: this.sourceCount,
      sinkCount: this.sinkCount,
    };
  }

  private restore(s: Snapshot) {
    this.write({ nodes: s.nodes as BnetNode[], links: s.links as BnetLink[], infiniteBuffers: s.infiniteBuffers, closedPopulation: s.closedPopulation, scenarios: s.scenarios });
    this.stationCount = s.stationCount;
    this.bufferCount = s.bufferCount;
    this.sourceCount = s.sourceCount;
    this.sinkCount = s.sinkCount;
    // The selection survives undo (the docked Inspector follows it); only ids that are gone drop.
    const v = this._view;
    const has = (id: string) => s.nodes.some((n) => n.id === id);
    this.setView({
      selectedNodeID: v.selectedNodeID && has(v.selectedNodeID) ? v.selectedNodeID : null,
      selectedLinkID: v.selectedLinkID && s.links.some((l) => l.id === v.selectedLinkID) ? v.selectedLinkID : null,
      selectedNodeIDs: new Set([...v.selectedNodeIDs].filter(has)),
      multiSelectRect: null,
      multiSelectOrigin: null,
      pendingLinkStartID: null,
      activeLinkSourceID: null,
      // The parameter panels close, as 0.90.34's did; Edit ▸ Undo waits while one is up
      // (src/editor/commands.ts undoWhen), so a draft is never lost this way.
      parameterEditorTarget: null,
      linkParameterEditorTarget: null,
    });
    this.onParametersChanged();
  }

  /** One undoable step around `block`. */
  performMutation(name: string, block: () => void) {
    if (this.nudgeRunIDs !== null) this.endNudgeRun();
    const before = this.snapshot();
    block();
    this.registerReversal(before, name);
    this.invalidateAnalysisIfItWouldRead(before);
  }

  /** Opens a long mutation (a drag); `endMutation` commits it as one entry. Nested begins are ignored. */
  beginMutation(name: string) {
    if (this.nudgeRunIDs !== null) this.endNudgeRun();
    if (this.pendingMutationSnapshot !== null) return;
    this.pendingMutationSnapshot = this.snapshot();
    this.pendingMutationName = name;
  }

  endMutation() {
    const before = this.pendingMutationSnapshot;
    const name = this.pendingMutationName;
    if (before === null || name === null) return;
    this.pendingMutationSnapshot = null;
    this.pendingMutationName = null;
    const touched = this.pendingGroupTouchedParameters;
    this.pendingGroupTouchedParameters = false;
    try {
      if (sameDocumentContent(before, this) && before.scenarios === this.storeDoc().scenarios) return;
      this.registerReversal(before, name);
    } finally {
      if (touched) this.onParametersChanged();
      else this.invalidateAnalysisIfItWouldRead(before);
    }
  }

  /** Drops an open mutation without an undo entry, after restoring its start (Escape mid-drag). */
  cancelMutation() {
    const before = this.pendingMutationSnapshot;
    if (before === null) return;
    this.pendingMutationSnapshot = null;
    this.pendingMutationName = null;
    this.pendingGroupTouchedParameters = false;
    this.write({ nodes: before.nodes as BnetNode[], links: before.links as BnetLink[], infiniteBuffers: before.infiniteBuffers, closedPopulation: before.closedPopulation, scenarios: before.scenarios });
    this.stationCount = before.stationCount;
    this.bufferCount = before.bufferCount;
    this.sourceCount = before.sourceCount;
    this.sinkCount = before.sinkCount;
  }

  get mutationOpen(): boolean {
    return this.pendingMutationSnapshot !== null;
  }

  private invalidateAnalysisIfItWouldRead(before: Snapshot) {
    if (analysisWouldRead(before, this)) this.onParametersChanged();
  }

  private registerReversal(state: Snapshot, name: string) {
    this.undoManager.registerUndo(() => {
      const verb = this.undoManager.isUndoing ? "Undid" : "Redid";
      const current = this.snapshot();
      this.restore(state);
      this.registerReversal(current, name);
      this.endParameterRun();
      this.status(`${verb}: ${name}.`);
    });
    this.undoManager.setActionName(name);
  }

  undo() {
    this.endNudgeRun();
    this.undoManager.undo();
  }

  redo() {
    this.endNudgeRun();
    this.undoManager.redo();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

function makeNode(kind: NodeKind, name: string, at: Point): BnetNode {
  return {
    id: newId(),
    kind,
    name,
    position: [at.x, at.y],
    bufferSize: 1,
    distribution: "exponential",
    distributionParameters: defaultParameters("exponential"),
    numberOfServers: 1,
    serviceDistributions: {},
    picture: "",
  };
}

function makeLink(from: string, to: string, customerClass: number, p: number, toCustomerClass: number | null): BnetLink {
  const l: BnetLink = { id: newId(), fromNodeID: from, toNodeID: to, routingProbability: p, customerClass };
  if (toCustomerClass !== null) l.toCustomerClass = toCustomerClass;
  return l;
}

function sortedByIndex(nodes: BnetNode[]): BnetNode[] {
  return [...nodes].sort((a, b) => cmp(sortIndex(a.name), sortIndex(b.name)));
}

function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Swift's `String <`: by Unicode scalar values, which for these names is code-point order. */
function swiftStringCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length - y.length;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function sameService(a: Record<string, ServiceConfig>, b: Record<string, ServiceConfig>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] !== undefined && a[k].distribution === b[k].distribution && a[k].distributionParameters === b[k].distributionParameters);
}

export function sameNode(a: BnetNode, b: BnetNode): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.kind === b.kind &&
      a.name === b.name &&
      a.position[0] === b.position[0] &&
      a.position[1] === b.position[1] &&
      a.bufferSize === b.bufferSize &&
      a.distribution === b.distribution &&
      a.distributionParameters === b.distributionParameters &&
      a.numberOfServers === b.numberOfServers &&
      a.picture === b.picture &&
      sameService(a.serviceDistributions, b.serviceDistributions))
  );
}

export function sameLink(a: BnetLink, b: BnetLink): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.fromNodeID === b.fromNodeID &&
      a.toNodeID === b.toNodeID &&
      a.routingProbability === b.routingProbability &&
      a.customerClass === b.customerClass &&
      (a.toCustomerClass ?? null) === (b.toCustomerClass ?? null))
  );
}

function sameArray<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
  return true;
}

function sameDocumentContent(s: Snapshot, e: { nodes: readonly BnetNode[]; links: readonly BnetLink[]; infiniteBuffers: boolean; closedPopulation: number | undefined }): boolean {
  return sameArray(s.nodes, e.nodes, sameNode) && sameArray(s.links, e.links, sameLink) && s.infiniteBuffers === e.infiniteBuffers && s.closedPopulation === e.closedPopulation;
}

/** Position-blind: a drag never re-runs the analysis (layout is not an input to any pill). */
function analysisWouldRead(before: Snapshot, e: { nodes: readonly BnetNode[]; links: readonly BnetLink[]; infiniteBuffers: boolean; closedPopulation: number | undefined }): boolean {
  if (before.infiniteBuffers !== e.infiniteBuffers) return true;
  if (before.closedPopulation !== e.closedPopulation) return true;
  if (!sameArray(before.links, e.links, sameLink)) return true;
  if (before.nodes.length !== e.nodes.length) return true;
  for (let i = 0; i < before.nodes.length; i++) {
    const a = before.nodes[i];
    const b = e.nodes[i];
    if (
      !(
        a.id === b.id &&
        a.kind === b.kind &&
        a.name === b.name &&
        a.bufferSize === b.bufferSize &&
        a.numberOfServers === b.numberOfServers &&
        a.distribution === b.distribution &&
        a.distributionParameters === b.distributionParameters &&
        sameService(a.serviceDistributions, b.serviceDistributions)
      )
    )
      return true;
  }
  return false;
}
