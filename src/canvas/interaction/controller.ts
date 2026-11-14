// Everything the user does to the canvas with pointer, wheel, trackpad and keyboard: 0.90.34's
// CanvasContentView gestures (NetworkCanvasView.swift `nodeDrag`, `canvasDrag`, `moveAnchoredNodes`,
// `cancelDragInFlight`, `updateHover`, `panChanged/panEnded`) and CanvasClipView
// (NetworkCanvasScrollContainer.swift: the mouse-down monitor, middle button, `scrollWheel`,
// `magnify`, `keyDown`/`keyUp`, `revealIfOffscreen`), as one plain object the canvas view feeds
// DOM events into (docs/specs/canvas.md §12–§13).
//
// All gesture state lives here, never in the editor; the editor learns only committed changes and
// the published bits 0.90.34 published (hover, pending link point, drag and pan flags, guides).
//
// One difference of shape: SwiftUI ran two gestures (each node's and the canvas's) and resolved
// which one owned a press by hit-testing; here the press is resolved once at pointer-down into a
// node, link, empty or pan origin and one handler runs it. So one cancel flag serves where 0.90.34
// needed two (both its gestures ended on the same mouse-up in an unspecified order).
import type { Editor } from "../../editor";
import type { BnetNode } from "../../lib/bnet";
import { nodeWorldRect } from "../geometry/outline";
import { hitLink, hitNode, type CanvasScene } from "../geometry/scene";
import { toDisplay, toLogical, WHEEL_ZOOM_FACTOR, WORLD_CLAMP } from "../geometry/transform";
import type { Point, Size } from "../geometry/types";
import { dropX, dropY, GUIDE_TOLERANCE, guidesEmpty, matchGuides, NO_GUIDES } from "./guides";
import { placedNodeKind, toolForKey } from "./tools";

/** Display pt (canvas.md §12): below `drag` a press is a click. */
export const THRESHOLDS = { drag: 2, linkDrag: 3, marquee: 5, doubleClickSlop: 3 } as const;
/** The wheel's line step and the keyboard scroll's, display pt (`linePanStep`). */
export const LINE_PAN_STEP = 20;
/** `revealIfOffscreen`'s margin: clears the body and its label block. */
export const REVEAL_MARGIN = 88;

/**
 * Milliseconds. `doubleClickInterval` stands in for NSEvent.doubleClickInterval, which a web page
 * can't read: 0.5 s, the macOS default (ledger CAN-101). Tests replace `now`.
 */
export const gestureClock = { now: () => performance.now(), doubleClickInterval: 500 };

export interface PointerInput {
  /** Canvas-local display point. */
  x: number;
  y: number;
  shift: boolean;
  meta: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface KeyInput {
  key: string;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  repeat: boolean;
}

export interface WheelInput {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels (a trackpad's precise deltas), 1 lines (a mouse wheel). */
  deltaMode: number;
  alt: boolean;
  meta: boolean;
  ctrl: boolean;
}

export type Origin = { kind: "node"; id: string } | { kind: "link"; id: string } | { kind: "empty" } | { kind: "pan" };

/** What a right-click is on, for the context menu (`contextMenuLinkID`, the node's own menu). */
export type ContextTarget = { kind: "node"; id: string } | { kind: "link"; id: string } | { kind: "canvas" };

const clampWorld = (p: Point): Point => ({ x: Math.min(Math.max(p.x, -WORLD_CLAMP), WORLD_CLAMP), y: Math.min(Math.max(p.y, -WORLD_CLAMP), WORLD_CLAMP) });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

interface Press {
  origin: Origin;
  start: Point;
  last: Point;
  /** ⇧ or ⌘ at mouse-down (`lastMouseDownExtendsSelection`). */
  extends: boolean;
  /** ⌥ at mouse-down (`lastMouseDownDuplicates`). */
  duplicates: boolean;
}

export class CanvasController {
  readonly editor: Editor;
  private readonly scene: () => CanvasScene;
  private readonly changed: () => void;

  // Transient state the drawing reads (the view's @State in 0.90.34).
  /** Where the active add tool would place its node (snapped, world). */
  ghost: Point | null = null;
  /** The node a drag-to-connect started from. */
  dragLinkFromID: string | null = null;
  /** Back over the start node having once left it: the preview draws the self-loop. */
  pointerOverLinkStart = false;
  /** ⌥ is down now (the copy cursor over a node, before any drag). */
  optionHeld = false;

  private press: Press | null = null;
  private dragLinkLeftSource = false;
  private hoverLeftPendingStart = false;
  private dragNodeID: string | null = null;
  private dragLinkID: string | null = null;
  private dragStartPositions = new Map<string, Point>();
  private dragDuplicated = false;
  private cancelled = false;
  private panStartOffset: Size | null = null;
  private ctrlHeld = false;
  private lastNodeTapID: string | null = null;
  private lastNodeTapTime = -Infinity;
  private lastLinkTapID: string | null = null;
  private lastLinkTapTime = -Infinity;
  private lastCanvasTapTime = -Infinity;
  private lastCanvasTapPoint: Point | null = null;
  private middleLast: Point | null = null;
  private pinchScale: number | null = null;
  private lastPendingStart: string | null;
  private lastTool: string;

  constructor(editor: Editor, scene: () => CanvasScene, changed: () => void) {
    this.editor = editor;
    this.scene = scene;
    this.changed = changed;
    this.lastPendingStart = editor.view.pendingLinkStartID;
    this.lastTool = editor.view.tool;
  }

  /** The node a link is being drawn from: the drag's own start, else the chain's pending start. */
  get linkStartID(): string | null {
    return this.dragLinkFromID ?? this.editor.view.pendingLinkStartID;
  }

  /** A drag Escape could put back right now (`dragIsCancellable`): never an ⌥-drag. */
  get dragIsCancellable(): boolean {
    return this.dragLinkFromID !== null || this.dragLinkID !== null || (this.dragNodeID !== null && !this.dragDuplicated);
  }

  /** A new pending start or a new tool begins a new gesture: the self-loop memo belongs to the old one. */
  syncWithView() {
    const v = this.editor.view;
    if (v.pendingLinkStartID !== this.lastPendingStart || v.tool !== this.lastTool) {
      this.lastPendingStart = v.pendingLinkStartID;
      this.lastTool = v.tool;
      this.hoverLeftPendingStart = false;
      if (this.pointerOverLinkStart) {
        this.pointerOverLinkStart = false;
        this.changed();
      }
    }
  }

  private get isPanGesture(): boolean {
    const v = this.editor.view;
    return v.tool === "pan" || v.isSpacePanning || this.panStartOffset !== null;
  }

  /**
   * A node move, link move, link drag or marquee already under way: it keeps the gesture to the
   * release even if Space or a tool letter turns panning on meanwhile (else its mutation would
   * never be ended and the route plan would stay frozen).
   */
  private get gestureInFlight(): boolean {
    return this.dragNodeID !== null || this.dragLinkID !== null || this.dragLinkFromID !== null || this.editor.view.multiSelectRect !== null;
  }

  /** Routes a move or release to the pan handlers. */
  private panning(press: { origin: { kind: string } }): boolean {
    return press.origin.kind === "pan" || (this.isPanGesture && !this.gestureInFlight);
  }

  /** The canvas went away (tab switch, pane hidden) mid-gesture: end it where it is, as a lost press does. */
  dispose() {
    this.pointerCancel();
  }

  // ── Pointer ────────────────────────────────────────────────────────────────────────────────

  /** A primary-button press (a ⌃-press is a context click and never starts a drag). */
  pointerDown(p: PointerInput, forced?: Origin) {
    this.noteModifiers(p);
    if (p.ctrl) return;
    const scene = this.scene();
    let origin: Origin;
    if (forced) origin = forced;
    else if (this.isPanGesture) origin = { kind: "pan" };
    else {
      const n = hitNode(scene, p);
      if (n) origin = { kind: "node", id: n.id };
      else {
        const l = hitLink(scene, p);
        origin = l ? { kind: "link", id: l.id } : { kind: "empty" };
      }
    }
    this.press = { origin, start: { x: p.x, y: p.y }, last: { x: p.x, y: p.y }, extends: p.shift || p.meta, duplicates: p.alt };
    // DragGesture(minimumDistance: 0) reports the press itself as its first change.
    this.onChanged(p);
  }

  /** `hit` overrides the hit test of a drag-to-connect (the headless replays name the node). */
  pointerMove(p: PointerInput, hit?: string | null) {
    this.noteModifiers(p);
    if (this.middleLast) {
      this.editor.pan({ width: p.x - this.middleLast.x, height: p.y - this.middleLast.y });
      this.middleLast = { x: p.x, y: p.y };
      return;
    }
    if (this.press) {
      this.press.last = { x: p.x, y: p.y };
      this.onChanged(p, hit);
      return;
    }
    this.hover(p);
  }

  pointerUp(p: PointerInput, hit?: string | null) {
    this.noteModifiers(p);
    if (this.middleLast) {
      this.middleEnd();
      return;
    }
    const press = this.press;
    if (!press) return;
    press.last = { x: p.x, y: p.y };
    this.press = null;
    if (this.cancelled) {
      // The release that ends a cancelled drag means nothing: no move, no link, not a click.
      this.cancelled = false;
      return;
    }
    if (this.panning(press)) return this.panEnded(press);
    if (press.origin.kind === "node") return this.nodeEnded(press, press.origin.id, p, hit);
    this.canvasEnded(press, p);
  }

  /** The press was lost (window switch, pointer capture taken): end it where it is. */
  pointerCancel() {
    if (this.middleLast) this.middleEnd();
    const press = this.press;
    if (!press) return;
    this.pointerUp({ ...press.last, shift: false, meta: false, alt: this.optionHeld, ctrl: this.ctrlHeld });
  }

  /** The middle button pans in any tool without changing it (`otherMouseDown/Dragged/Up`). */
  middleDown(p: PointerInput) {
    this.middleLast = { x: p.x, y: p.y };
    this.editor.setView({ isPanningCanvas: true });
  }

  private middleEnd() {
    this.middleLast = null;
    this.editor.setView({ isPanningCanvas: false });
  }

  private noteModifiers(p: { alt: boolean; ctrl: boolean }) {
    this.ctrlHeld = p.ctrl;
    if (this.optionHeld !== p.alt) {
      this.optionHeld = p.alt;
      this.changed();
    }
  }

  /** ⌥ or ⌃ went down or up with the pointer still (`flagsChanged`): the cursor and a live drag follow. */
  modifiersChanged(alt: boolean, ctrl: boolean) {
    this.noteModifiers({ alt, ctrl });
    if (this.press && this.dragStartPositions.size && !this.cancelled) {
      const t = { width: this.press.last.x - this.press.start.x, height: this.press.last.y - this.press.start.y };
      this.moveAnchoredNodes(t, this.scene().transform.scale);
    }
  }

  private onChanged(p: PointerInput, hit?: string | null) {
    const press = this.press!;
    if (this.cancelled) return;
    if (this.panning(press)) return this.panChanged(press);
    if (press.origin.kind === "node") return this.nodeChanged(press, press.origin.id, p, hit);
    const editor = this.editor;
    const tool = editor.view.tool;
    const scene = this.scene();
    const translation = { width: p.x - press.start.x, height: p.y - press.start.y };
    const travel = Math.hypot(translation.width, translation.height);
    if (press.origin.kind === "link") {
      if (tool !== "select") return;
      if (this.dragLinkID === null) {
        // Dragging a link moves both endpoints live as one step; it selects the link but never
        // cycles its class the way a repeated click does.
        const link = editor.link(press.origin.id);
        const from = editor.node(link?.fromNodeID);
        const to = editor.node(link?.toNodeID);
        if (!(travel > THRESHOLDS.linkDrag) || !link || !from || !to) return;
        this.dragLinkID = link.id;
        this.dragStartPositions = new Map([
          [from.id, { x: from.position[0], y: from.position[1] }],
          [to.id, { x: to.position[0], y: to.position[1] }],
        ]);
        if (editor.view.selectedLinkID !== link.id) editor.setView({ selectedLinkID: link.id, selectedNodeID: null, selectedNodeIDs: new Set() });
        editor.beginMutation("Move Link");
        editor.setView({ isDraggingNode: true });
        this.changed();
      }
      this.moveAnchoredNodes(translation, scene.transform.scale);
      return;
    }
    // Empty canvas: a rubber band in Multi-Select from the press, in Pointer past 5 pt.
    const band = tool === "multiSelect" || (tool === "select" && travel > THRESHOLDS.marquee);
    if (!band) return;
    if (editor.view.multiSelectOrigin === null) editor.beginMultiSelect(toLogical(scene.transform, press.start));
    editor.updateMultiSelect(toLogical(scene.transform, p));
  }

  private nodeChanged(press: Press, nodeID: string, p: PointerInput, hitOverride?: string | null) {
    const editor = this.editor;
    const tool = editor.view.tool;
    const scene = this.scene();
    const translation = { width: p.x - press.start.x, height: p.y - press.start.y };
    const travel = Math.hypot(translation.width, translation.height);
    if (tool === "addLink") {
      // Drag-to-connect: nothing reaches the model until the release lands on a target.
      if (this.dragLinkFromID === null) {
        if (!(travel > THRESHOLDS.drag)) return;
        this.dragLinkFromID = nodeID;
        this.dragLinkLeftSource = false;
        this.pointerOverLinkStart = false;
      }
      editor.setView({ pendingLinkPoint: clampWorld(toLogical(scene.transform, p)) });
      const hit = hitOverride !== undefined ? hitOverride : (hitNode(scene, p)?.id ?? null);
      const target = hit !== null && hit !== nodeID ? hit : null;
      if (editor.view.hoveredNodeID !== target) editor.setView({ hoveredNodeID: target });
      if (hit !== nodeID) this.dragLinkLeftSource = true;
      this.pointerOverLinkStart = hit === nodeID && this.dragLinkLeftSource;
      this.changed();
      return;
    }
    if (tool !== "select" && tool !== "multiSelect") return;
    if (this.dragNodeID === null) {
      // A click stays a click until the pointer has really moved; only then does the group open.
      if (!(travel > THRESHOLDS.drag)) return;
      this.dragNodeID = nodeID;
      let group = editor.selectionUnion;
      if (!group.has(nodeID)) {
        // Dragging an unselected node makes it the selection; with ⇧/⌘ held it joins the group.
        if (press.extends) group.add(nodeID);
        else group = new Set([nodeID]);
        editor.setNodeSelection(group);
        editor.setView({ selectedLinkID: null });
      }
      // ⌥-drag duplicates: the copies become the selection and are what the drag carries, in
      // the same undo group as the move.
      const duplicating = press.duplicates;
      const noun = group.size > 1 ? "Nodes" : "Node";
      editor.beginMutation(duplicating ? `Duplicate and Move ${noun}` : `Move ${noun}`);
      if (duplicating) {
        const copies = editor.duplicateSelectionInPlaceForDrag();
        if (copies.size) {
          group = copies;
          this.dragDuplicated = true;
        }
      }
      this.dragStartPositions = new Map(editor.nodes.filter((n) => group.has(n.id)).map((n) => [n.id, { x: n.position[0], y: n.position[1] }]));
      editor.setView({ isDraggingNode: true });
      this.changed();
    }
    this.moveAnchoredNodes(translation, scene.transform.scale);
  }

  /**
   * Anchored on the mouse-down positions: world delta = translation / scale. The anchor's candidate
   * rect is offered to the guides and, with Snap to Grid, to the grid; axis by axis the nearer wins
   * and the group moves rigidly by the resolved delta (the model's per-node snap bypassed). ⌃,
   * read live, suspends both.
   */
  private moveAnchoredNodes(translation: Size, s: number) {
    const editor = this.editor;
    const delta = { width: translation.width / s, height: translation.height / s };
    const suspended = this.ctrlHeld;
    if (editor.view.snapSuspended !== suspended) editor.setView({ snapSuspended: suspended });
    let guides = NO_GUIDES;
    const anchorID = this.dragNodeID ?? this.dragStartPositions.keys().next().value ?? null;
    const anchorNode = anchorID ? editor.node(anchorID) : undefined;
    const start = anchorID ? this.dragStartPositions.get(anchorID) : undefined;
    if (!suspended && anchorNode && start) {
      const centre = { x: start.x + delta.width, y: start.y + delta.height };
      const candidate = nodeWorldRect({ kind: anchorNode.kind, position: [centre.x, centre.y] });
      const others = editor.nodes.filter((n) => !this.dragStartPositions.has(n.id)).map((n) => nodeWorldRect(n));
      guides = matchGuides(candidate, others, GUIDE_TOLERANCE / Math.max(s, 0.01));
      let adjust = { ...guides.adjustment };
      if (editor.view.snapToGrid) {
        const snapped = editor.snapIfNeeded(centre);
        const grid = { width: snapped.x - centre.x, height: snapped.y - centre.y };
        const guideX = guides.x !== null || guides.xSpacing !== null;
        const guideY = guides.y !== null || guides.ySpacing !== null;
        if (!guideX || Math.abs(grid.width) <= Math.abs(adjust.width)) {
          adjust.width = grid.width;
          guides = dropX(guides);
        }
        if (!guideY || Math.abs(grid.height) <= Math.abs(adjust.height)) {
          adjust.height = grid.height;
          guides = dropY(guides);
        }
      }
      if (guidesEmpty(guides)) guides = NO_GUIDES;
      else guides = { ...guides, anchor: { ...candidate, x: candidate.x + adjust.width, y: candidate.y + adjust.height } };
      delta.width += adjust.width;
      delta.height += adjust.height;
    }
    if (!sameGuides(editor.view.activeAlignGuides, guides)) editor.setView({ activeAlignGuides: guides });
    const to = new Map<string, Point>();
    for (const [id, p] of this.dragStartPositions) to.set(id, clampWorld({ x: p.x + delta.width, y: p.y + delta.height }));
    editor.moveNodes(to);
  }

  private finishNodeMove() {
    const editor = this.editor;
    editor.endMutation();
    editor.setView({ isDraggingNode: false, snapSuspended: false, activeAlignGuides: NO_GUIDES });
    this.clearDrag();
  }

  private clearDrag() {
    this.dragNodeID = null;
    this.dragLinkID = null;
    this.dragDuplicated = false;
    this.dragStartPositions = new Map();
    this.changed();
  }

  /**
   * Escape mid-drag (`cancelDragInFlight`): a link being drawn holds no model state, so dropping
   * the memo is the whole cancel; a move is put back with `cancelMutation`, which restores the
   * start and closes the group with no undo entry. An ⌥-drag is not cancellable (canvas.md §12.3).
   * True when something was cancelled: the key is then spent.
   */
  cancelDragInFlight(): boolean {
    const editor = this.editor;
    if (this.dragLinkFromID !== null) {
      this.dragLinkFromID = null;
      this.dragLinkLeftSource = false;
      this.pointerOverLinkStart = false;
      editor.setView({ pendingLinkPoint: null, hoveredNodeID: null });
      this.cancelled = this.press !== null;
      this.changed();
      return true;
    }
    if (!this.dragStartPositions.size || this.dragDuplicated) return false;
    editor.cancelMutation();
    editor.setView({ isDraggingNode: false, snapSuspended: false, activeAlignGuides: NO_GUIDES });
    this.cancelled = this.press !== null;
    this.clearDrag();
    return true;
  }

  private nodeEnded(press: Press, nodeID: string, p: PointerInput, hitOverride?: string | null) {
    const editor = this.editor;
    if (this.dragNodeID !== null) return this.finishNodeMove();
    if (this.dragLinkFromID !== null) {
      const fromID = this.dragLinkFromID;
      const leftSource = this.dragLinkLeftSource;
      this.dragLinkFromID = null;
      this.dragLinkLeftSource = false;
      this.pointerOverLinkStart = false;
      editor.setView({ pendingLinkPoint: null });
      const target = hitOverride !== undefined ? hitOverride : (hitNode(this.scene(), p)?.id ?? null);
      if (editor.view.hoveredNodeID !== target) editor.setView({ hoveredNodeID: target });
      this.changed();
      if (target !== null) {
        // Out and back onto the start node is the self-loop gesture; never having left it is a
        // shaky click, honoured as the click it was. Released on empty canvas: abandoned.
        if (target !== fromID || leftSource) this.completeLinkDrag(fromID, target);
        else editor.handleNodeTap(fromID);
      }
      return;
    }
    // A plain click; a second one on the same node inside the double-click interval opens the
    // parameter editor (Pointer and Multi-Select, unmodified).
    const now = gestureClock.now();
    const tool = editor.view.tool;
    if (!press.extends && (tool === "select" || tool === "multiSelect") && this.lastNodeTapID === nodeID && now - this.lastNodeTapTime < gestureClock.doubleClickInterval) {
      this.lastNodeTapID = null;
      editor.openParameterEditor(nodeID);
      return;
    }
    this.lastNodeTapID = nodeID;
    this.lastNodeTapTime = now;
    editor.handleNodeTap(nodeID, press.extends);
  }

  /** Replays the two-click flow, so the class rules, the refusals and the chain have one implementation. */
  private completeLinkDrag(from: string, to: string) {
    const editor = this.editor;
    if (editor.view.pendingLinkStartID !== from) {
      // A chain part-built elsewhere must not read this tap as its close.
      editor.setView({ pendingLinkStartID: null });
      editor.handleNodeTap(from);
      if (editor.view.pendingLinkStartID !== from) return;
    }
    editor.handleNodeTap(to);
  }

  private canvasEnded(press: Press, p: PointerInput) {
    const editor = this.editor;
    const tool = editor.view.tool;
    const scene = this.scene();
    if (press.origin.kind === "link") {
      const linkID = press.origin.id;
      if (this.dragLinkID !== null) return this.finishNodeMove();
      if (tool === "select") {
        // Double-click opens the link editor; a slower second click cycles the class.
        const now = gestureClock.now();
        if (this.lastLinkTapID === linkID && now - this.lastLinkTapTime < gestureClock.doubleClickInterval) {
          this.lastLinkTapID = null;
          this.lastLinkTapTime = -Infinity;
          editor.openLinkParameterEditor(linkID);
          return;
        }
        this.lastLinkTapID = linkID;
        this.lastLinkTapTime = now;
        editor.handleLinkTap(linkID);
        return;
      }
      // Other tools treat a link like empty canvas.
    }
    // A band with no area is a click (every Multi-Select click arrives holding one): discard it
    // without dropping the selection a ⇧-click is building, and let the click path decide.
    const rect = editor.view.multiSelectRect;
    if (rect) {
      if (rect.width > 0 || rect.height > 0) {
        editor.finalizeMultiSelect(press.extends);
        return;
      }
      editor.setView({ multiSelectRect: null, multiSelectOrigin: null });
    }
    // ⇧/⌘-click on empty canvas leaves the selection alone: the user is building a group.
    if (press.extends && (tool === "select" || tool === "multiSelect")) return;
    const location = { x: p.x, y: p.y };
    const world = editor.snapIfNeeded(clampWorld(toLogical(scene.transform, location)));
    const previous = this.lastCanvasTapPoint;
    const now = gestureClock.now();
    const inDoubleClickWindow = now - this.lastCanvasTapTime < gestureClock.doubleClickInterval;
    const nearPreviousClick = previous ? dist(previous, location) <= THRESHOLDS.doubleClickSlop : false;
    // Refreshed on every empty click, suppressed ones included: a triple-click is one placement.
    this.lastCanvasTapTime = now;
    this.lastCanvasTapPoint = location;
    if (inDoubleClickWindow) {
      if (tool === "select" || tool === "multiSelect") {
        if (nearPreviousClick) {
          this.lastCanvasTapPoint = null;
          editor.enterStickyPan();
          return;
        }
      } else if (placedNodeKind(tool) && previous) {
        // Suppress the second placement only when it would land under the first.
        const previousWorld = editor.snapIfNeeded(clampWorld(toLogical(scene.transform, previous)));
        if ((previousWorld.x === world.x && previousWorld.y === world.y) || nearPreviousClick) return;
      }
    }
    editor.handleCanvasTap(world);
  }

  private panChanged(press: Press) {
    const editor = this.editor;
    if (this.panStartOffset === null) {
      this.panStartOffset = editor.view.canvasPanOffset;
      editor.setView({ isPanningCanvas: true });
    }
    // Deliberately unclamped: the network may be dragged out of frame; the scrollers track it.
    const s = this.panStartOffset;
    editor.setView({ canvasPanOffset: { width: s.width + press.last.x - press.start.x, height: s.height + press.last.y - press.start.y } });
  }

  /** A pan drag only moves the view; a pan click is where sticky pan ends. */
  private panEnded(press: Press) {
    this.panStartOffset = null;
    this.editor.setView({ isPanningCanvas: false });
    if (dist(press.last, press.start) <= THRESHOLDS.drag) this.editor.exitStickyPan();
  }

  // ── Hover ──────────────────────────────────────────────────────────────────────────────────

  /** `onContinuousHover(.active)`: frozen while a drag or a pan owns the pointer. */
  hover(p: Point) {
    const editor = this.editor;
    const v = editor.view;
    if (v.isDraggingNode || v.isPanningCanvas || this.dragLinkFromID !== null) return;
    const scene = this.scene();
    const tool = v.tool;
    const panning = v.isSpacePanning;
    if (!panning && tool === "addLink" && v.pendingLinkStartID !== null) {
      const world = clampWorld(toLogical(scene.transform, p));
      const cur = v.pendingLinkPoint;
      if (!cur || cur.x !== world.x || cur.y !== world.y) editor.setView({ pendingLinkPoint: world });
    } else if (v.pendingLinkPoint !== null) editor.setView({ pendingLinkPoint: null });
    let ghost: Point | null = null;
    if (!panning && placedNodeKind(tool)) ghost = editor.snapIfNeeded(clampWorld(toLogical(scene.transform, p)));
    const ghostChanged = (ghost === null) !== (this.ghost === null) || (ghost && this.ghost && (ghost.x !== this.ghost.x || ghost.y !== this.ghost.y));
    if (ghostChanged) this.ghost = ghost;
    const hoversNodes = !panning && (tool === "select" || tool === "multiSelect" || tool === "addLink");
    let node: BnetNode | null = hoversNodes ? hitNode(scene, p) : null;
    let overChanged = false;
    if (!panning && tool === "addLink" && v.pendingLinkStartID !== null) {
      // The two-click flow's half of the self-loop gesture: the pointer must have left the start
      // node before coming back; the start node itself never wears the hover ring.
      if (node?.id === v.pendingLinkStartID) {
        if (this.hoverLeftPendingStart && !this.pointerOverLinkStart) {
          this.pointerOverLinkStart = true;
          overChanged = true;
        }
        node = null;
      } else {
        this.hoverLeftPendingStart = true;
        if (this.pointerOverLinkStart) {
          this.pointerOverLinkStart = false;
          overChanged = true;
        }
      }
    }
    const link = !panning && !node && tool === "select" ? hitLink(scene, p) : null;
    editor.setView({ hoveredNodeID: node?.id ?? null, hoveredLinkID: link?.id ?? null });
    if (ghostChanged || overChanged) this.changed();
  }

  /** `onContinuousHover(.ended)`: unless a link drag owns the preview. */
  hoverEnded() {
    if (this.dragLinkFromID !== null) return;
    this.editor.setView({ hoveredNodeID: null, hoveredLinkID: null, pendingLinkPoint: null });
    if (this.ghost !== null || this.pointerOverLinkStart) {
      this.ghost = null;
      this.pointerOverLinkStart = false;
      this.changed();
    }
  }

  /** What a right-click at `p` is on: a node takes its own menu; otherwise the link under it, else the canvas. */
  contextTarget(p: Point): ContextTarget {
    const v = this.editor.view;
    const scene = this.scene();
    const surface = v.tool === "pan" || v.isSpacePanning;
    const n = surface ? null : hitNode(scene, p);
    if (n) return { kind: "node", id: n.id };
    const l = hitLink(scene, p) ?? this.editor.link(v.hoveredLinkID) ?? null;
    return l ? { kind: "link", id: l.id } : { kind: "canvas" };
  }

  // ── Wheel and pinch ────────────────────────────────────────────────────────────────────────

  /**
   * `scrollWheel`: ⌥ or ⌘ zooms about the pointer by 1.1^delta (delta a tenth of a precise
   * scroll, a mouse wheel's lines as they are); a plain scroll pans, pixels 1:1, lines × 20. A
   * Chrome-style pinch arrives as a wheel with ctrlKey and zooms by its own factor. DOM deltas
   * point the other way from NSEvent's scrollingDelta (positive is "scroll down"), hence the signs.
   */
  wheel(e: WheelInput) {
    const editor = this.editor;
    const anchor = { x: e.x, y: e.y };
    if (e.ctrl && !e.alt && !e.meta) {
      if (this.pinchScale !== null || e.deltaY === 0) return;
      editor.zoomBy(Math.exp(-e.deltaY / 100), anchor);
      return;
    }
    const lines = e.deltaMode === 1;
    if (e.alt || e.meta) {
      const delta = lines ? -e.deltaY : -e.deltaY / 10;
      if (delta === 0) return;
      editor.zoomBy(Math.pow(WHEEL_ZOOM_FACTOR, delta), anchor);
      return;
    }
    const step = lines ? LINE_PAN_STEP : e.deltaMode === 2 ? editor.view.viewportSize.height : 1;
    const dx = -e.deltaX * step;
    const dy = -e.deltaY * step;
    if (dx === 0 && dy === 0) return;
    editor.pan({ width: dx + 0, height: dy + 0 });
  }

  /** WebKit's GestureEvent (`magnify`): `scale` is cumulative from the gesture's start. */
  pinchStart() {
    this.pinchScale = 1;
  }

  pinchChange(scale: number, at: Point) {
    const last = this.pinchScale ?? 1;
    this.pinchScale = scale;
    if (!(scale > 0) || scale === last) return;
    this.editor.zoomBy(scale / last, at);
  }

  pinchEnd() {
    this.pinchScale = null;
  }

  // ── Keys ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The canvas's own keys (CanvasClipView `keyDown`). True when the key was used. Never a key
   * with ⌘, ⌃ or ⌥ (those are the menus'), except ⌥Tab / ⌥⇧Tab.
   */
  keyDown(k: KeyInput): boolean {
    const editor = this.editor;
    if (k.key === "Alt" || k.key === "Control") {
      this.modifiersChanged(k.key === "Alt" ? true : this.optionHeld, k.key === "Control" ? true : this.ctrlHeld);
      return false;
    }
    if (k.meta || k.ctrl || k.alt) {
      if (k.key === "Tab" && k.alt && !k.meta && !k.ctrl) {
        const link = editor.selectAdjacentLink(k.shift);
        if (link) {
          for (const id of [link.fromNodeID, link.toNodeID]) {
            const n = editor.node(id);
            if (n) this.revealIfOffscreen(n);
          }
          return true;
        }
      }
      return false;
    }
    switch (k.key) {
      case " ":
        if (!k.repeat && !editor.view.isSpacePanning) editor.setView({ isSpacePanning: true });
        return true;
      case "Backspace":
      case "Delete":
        editor.deleteSelection();
        return true;
      case "Escape":
        editor.deselectAll();
        return true;
      case "Enter":
        // With a drawing tool in hand, Return is the click a keyboard cannot make (2.1,
        // docs/ACCESSIBILITY.md): the Link tool takes the selected node as the start, then the
        // next one as the target; a node tool places its node at a free spot beside the selection.
        if (this.keyboardDraw()) return true;
        editor.openParameterEditorForSelection();
        return true;
      case "Tab": {
        // The walk ends at the last node (⇧Tab: at the first) and the key goes on to the next
        // control, so the canvas is never a keyboard trap (WCAG 2.1.2; 0.90.34 wrapped round).
        const ordered = editor.nodesInReadingOrder;
        const current = editor.view.selectedNodeID ?? (editor.view.selectedNodeIDs.size === 1 ? [...editor.view.selectedNodeIDs][0] : null);
        const edge = ordered.length ? ordered[k.shift ? 0 : ordered.length - 1].id : null;
        if (current !== null && current === edge) return false;
        const target = editor.selectAdjacentNode(k.shift);
        if (!target) return false;
        this.revealIfOffscreen(target);
        return true;
      }
      case "ArrowLeft":
        this.arrow(-1, 0, k.shift);
        return true;
      case "ArrowRight":
        this.arrow(1, 0, k.shift);
        return true;
      case "ArrowDown":
        this.arrow(0, 1, k.shift);
        return true;
      case "ArrowUp":
        this.arrow(0, -1, k.shift);
        return true;
      default: {
        const tool = toolForKey(k.key);
        if (!tool) return false;
        editor.setTool(tool);
        return true;
      }
    }
  }

  keyUp(k: Pick<KeyInput, "key">): boolean {
    const editor = this.editor;
    if (k.key === "Alt") this.modifiersChanged(false, this.ctrlHeld);
    else if (k.key === "Control") this.modifiersChanged(this.optionHeld, false);
    else if (k.key === " ") {
      if (editor.view.isSpacePanning) editor.setView({ isSpacePanning: false });
      return true;
    } else if (k.key.startsWith("Arrow")) {
      editor.endNudgeRun();
      return true;
    }
    return false;
  }

  /** The canvas lost the keyboard (`resignFirstResponder`): end a Space pan and a nudge run. */
  blur() {
    if (this.editor.view.isSpacePanning) this.editor.setView({ isSpacePanning: false });
    this.editor.endNudgeRun();
  }

  /** With a selection, nudge it (a whole grid cell while snapping); with none, scroll the view. */
  /** Return with a drawing tool: true when the key was a link click or placed a node. */
  private keyboardDraw(): boolean {
    const editor = this.editor;
    const v = editor.view;
    const selected = v.selectedNodeID ?? (v.selectedNodeIDs.size === 1 ? [...v.selectedNodeIDs][0] : null);
    if (v.tool === "addLink") {
      if (!selected) return false;
      editor.handleNodeTap(selected);
      return true;
    }
    const kind = placedNodeKind(v.tool);
    if (!kind) return false;
    const created = editor.addNode(kind, keyboardSpot(editor, selected));
    this.revealIfOffscreen(created);
    return true;
  }

  private arrow(dx: number, dy: number, coarse: boolean) {
    const editor = this.editor;
    if (editor.selectionUnion.size || editor.view.selectedLinkID !== null) {
      const step = editor.nudgeStep(coarse);
      editor.nudgeSelection({ width: dx * step, height: dy * step });
      return;
    }
    const pan = LINE_PAN_STEP * (coarse ? 4 : 1);
    editor.pan({ width: -dx * pan + 0, height: -dy * pan + 0 });
  }

  /** Pans just enough to bring `node` inside the viewport with an 88 pt margin; on screen, nothing moves. */
  revealIfOffscreen(node: BnetNode) {
    const t = this.editor.canvasTransform;
    const vp = t.viewportSize;
    if (!(vp.width > 1 && vp.height > 1)) return;
    const p = toDisplay(t, { x: node.position[0], y: node.position[1] });
    const m = REVEAL_MARGIN;
    let dx = 0;
    let dy = 0;
    if (p.x < m) dx = m - p.x;
    else if (p.x > vp.width - m) dx = vp.width - m - p.x;
    if (p.y < m) dy = m - p.y;
    else if (p.y > vp.height - m) dy = vp.height - m - p.y;
    if (dx !== 0 || dy !== 0) this.editor.pan({ width: dx, height: dy });
  }
}

/** How far apart the keyboard places nodes, world pt: four grid cells, the tandem line's pitch. */
export const KEYBOARD_PITCH = 112;

/**
 * Where a node added without a pointer goes: one pitch to the right of `besideID` (else of the
 * rightmost node, else the middle of the viewport), stepping right until the spot is free.
 */
export function keyboardSpot(editor: Editor, besideID: string | null = null): Point {
  const nodes = editor.nodes;
  const beside = editor.node(besideID) ?? [...nodes].sort((a, b) => b.position[0] - a.position[0])[0];
  let at: Point;
  if (beside) at = { x: beside.position[0] + KEYBOARD_PITCH, y: beside.position[1] };
  else {
    const t = editor.canvasTransform;
    at = toLogical(t, { x: t.viewportSize.width / 2, y: t.viewportSize.height / 2 });
  }
  at = editor.snapIfNeeded(at);
  for (let guard = 0; guard < 200 && nodes.some((n) => Math.hypot(n.position[0] - at.x, n.position[1] - at.y) < KEYBOARD_PITCH / 2); guard++) {
    at = { x: at.x + KEYBOARD_PITCH, y: at.y };
  }
  return clampWorld(at);
}

function sameGuides(a: import("../../editor").AlignGuides, b: import("../../editor").AlignGuides): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
