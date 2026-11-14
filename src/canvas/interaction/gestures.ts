// The canvas gestures as headless functions over an Editor, for the scripted replays
// (golden/edits/README.md "Tools and clicks", "Drags", "Keys"; src/editor/replay.test.ts). Each
// drives the SAME gesture controller the canvas feeds its DOM events into
// (src/canvas/interaction/controller.ts), with synthetic pointer and key input, so a replay tests
// the shipped code path and not a copy of it. Points are display points through the editor's
// current transform; a `by` is a display translation. No DOM is needed.
import type { AlignGuides, Editor } from "../../editor";
import { hitLink, hitNode } from "../geometry/scene";
import { toDisplay } from "../geometry/transform";
import type { Point, Size } from "../geometry/types";
import { CanvasController, type KeyInput, type Origin, type PointerInput } from "./controller";

const at = (p: Point, mods: Partial<PointerInput> = {}): PointerInput => ({ x: p.x, y: p.y, shift: false, meta: false, alt: false, ctrl: false, ...mods });

/** A controller with no view behind it: the scene is the editor's own, at its current transform. */
export function headlessController(editor: Editor): CanvasController {
  return new CanvasController(editor, () => editor.makeScene(), () => {});
}

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, shift: false, meta: false, ctrl: false, alt: false, repeat: false, ...mods });

function nodeCentre(editor: Editor, nodeID: string): Point {
  const n = editor.node(nodeID);
  if (!n) throw new Error(`no node ${nodeID}`);
  return toDisplay(editor.canvasTransform, { x: n.position[0], y: n.position[1] });
}

function requireEmpty(editor: Editor, p: Point) {
  const scene = editor.makeScene();
  if (hitNode(scene, p) || hitLink(scene, p)) throw new Error(`(${p.x}, ${p.y}) is not empty canvas`);
}

function click(c: CanvasController, p: Point, opts: { extending?: boolean; origin?: Origin } = {}) {
  const m = at(p, { shift: !!opts.extending });
  c.pointerDown(m, opts.origin);
  c.pointerUp(m);
}

// ── Tools and clicks ─────────────────────────────────────────────────────────────────────────

/** A click on empty canvas (`canvasDrag.onEnded`), outside the double-click window. */
export function canvasClick(editor: Editor, displayPoint: Point, opts: { extending?: boolean } = {}, c = headlessController(editor)) {
  requireEmpty(editor, displayPoint);
  click(c, displayPoint, opts);
}

/**
 * Two clicks inside the double-click interval; only the first must land on empty canvas. With an
 * add tool the second lands on the node the first placed, which takes it as a click on itself (it
 * is already the selection), so no second node is placed.
 */
export function canvasDoubleClick(editor: Editor, displayPoint: Point) {
  const c = headlessController(editor);
  canvasClick(editor, displayPoint, {}, c);
  click(c, displayPoint);
}

export function nodeClick(editor: Editor, nodeId: string, opts: { extending?: boolean } = {}, c = headlessController(editor)) {
  click(c, nodeCentre(editor, nodeId), { extending: opts.extending, origin: { kind: "node", id: nodeId } });
}

export function nodeDoubleClick(editor: Editor, nodeId: string) {
  const c = headlessController(editor);
  nodeClick(editor, nodeId, {}, c);
  nodeClick(editor, nodeId, {}, c);
}

export function linkClick(editor: Editor, linkId: string, c = headlessController(editor)) {
  click(c, { x: 0, y: 0 }, { origin: { kind: "link", id: linkId } });
}

export function linkDoubleClick(editor: Editor, linkId: string) {
  const c = headlessController(editor);
  linkClick(editor, linkId, c);
  linkClick(editor, linkId, c);
}

/** The class legend's chip: pins the filter, and a second click clears it. */
export function legendClick(editor: Editor, cls: number) {
  editor.setView({ classFilter: editor.view.classFilter === cls ? null : cls });
}

// ── Drags ────────────────────────────────────────────────────────────────────────────────────

/**
 * A node drag in Pointer / Multi-Select: press on the node (⇧/⌘ `extending`, ⌥ `option` at
 * mouse-down), one frame at translation `byDisplay` (⌃ `control` held), Escape before the
 * release when `escape`, then the release. Returns the frame's guides.
 */
export function dragNode(editor: Editor, nodeId: string, byDisplay: Size, opts: { extending?: boolean; option?: boolean; control?: boolean; escape?: boolean } = {}): AlignGuides {
  const c = headlessController(editor);
  const start = nodeCentre(editor, nodeId);
  const end = { x: start.x + byDisplay.width, y: start.y + byDisplay.height };
  c.pointerDown(at(start, { shift: !!opts.extending, alt: !!opts.option }), { kind: "node", id: nodeId });
  c.pointerMove(at(end, { alt: !!opts.option, ctrl: !!opts.control }));
  const guides = editor.view.activeAlignGuides;
  if (opts.escape) escapeDuringDrag(c);
  c.pointerUp(at(end, { alt: !!opts.option, ctrl: !!opts.control }));
  return guides;
}

/** Escape with a drag in flight: the canvas's monitor cancels what can be cancelled; otherwise the canvas hears Escape. */
function escapeDuringDrag(c: CanvasController) {
  if (!(c.dragIsCancellable && c.cancelDragInFlight())) c.keyDown(key("Escape"));
}

/**
 * A Link-tool drag from `fromId` released on `toId` (null: empty canvas); `returned`: the pointer
 * left `fromId` and came back onto it (the self-loop gesture).
 */
export function dragConnect(editor: Editor, fromId: string, toId: string | null, opts: { returned?: boolean } = {}) {
  const c = headlessController(editor);
  const start = nodeCentre(editor, fromId);
  const away = { x: start.x + 200, y: start.y + 200 };
  c.pointerDown(at(start), { kind: "node", id: fromId });
  if (toId === fromId && !opts.returned) {
    // Out past the drag threshold but never off the node: a shaky click.
    c.pointerMove(at({ x: start.x + 3, y: start.y }), fromId);
    c.pointerUp(at({ x: start.x + 3, y: start.y }), fromId);
    return;
  }
  c.pointerMove(at(away), null);
  const end = toId ? nodeCentre(editor, toId) : away;
  c.pointerMove(at(end), toId);
  c.pointerUp(at(end), toId);
}

/** A Pointer-tool drag from a link: both ends move as one "Move Link"; ≤ 3 pt is a click. */
export function dragLink(editor: Editor, linkId: string, byDisplay: Size, opts: { escape?: boolean } = {}) {
  const c = headlessController(editor);
  const end = { x: byDisplay.width, y: byDisplay.height };
  c.pointerDown(at({ x: 0, y: 0 }), { kind: "link", id: linkId });
  c.pointerMove(at(end));
  if (opts.escape) escapeDuringDrag(c);
  c.pointerUp(at(end));
}

/** A rubber band from `fromDisplay` (empty canvas) to `toDisplay`; returns the live count. */
export function marquee(editor: Editor, fromDisplay: Point, toDisplay: Point, opts: { extending?: boolean } = {}): number | null {
  requireEmpty(editor, fromDisplay);
  const c = headlessController(editor);
  c.pointerDown(at(fromDisplay, { shift: !!opts.extending }));
  c.pointerMove(at(toDisplay, { shift: !!opts.extending }));
  const count = editor.marqueeNodeCount;
  c.pointerUp(at(toDisplay, { shift: !!opts.extending }));
  return count;
}

/** A Pan-tool drag (a translation ≤ 2 pt is a click, which ends sticky pan). */
export function panDrag(editor: Editor, byDisplay: Size) {
  const c = headlessController(editor);
  c.pointerDown(at({ x: 0, y: 0 }), { kind: "pan" });
  c.pointerMove(at({ x: byDisplay.width, y: byDisplay.height }));
  c.pointerUp(at({ x: byDisplay.width, y: byDisplay.height }));
}

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────

const ARROW = { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown" } as const;

export function arrowKey(editor: Editor, dir: keyof typeof ARROW, opts: { shift?: boolean } = {}) {
  headlessController(editor).keyDown(key(ARROW[dir], { shift: !!opts.shift }));
}

export function arrowKeyUp(editor: Editor) {
  headlessController(editor).keyUp({ key: "ArrowUp" });
}

/** Tab / ⇧Tab: the next node in reading order, revealed with an 88-pt margin in `viewportSize`. */
export function tabKey(editor: Editor, opts: { shift?: boolean } = {}, viewportSize?: Size) {
  if (viewportSize) editor.setViewportSize(viewportSize);
  headlessController(editor).keyDown(key("Tab", { shift: !!opts.shift }));
}

/** ⌥Tab / ⌥⇧Tab: the next link round the selected node, both ends revealed. */
export function optionTabKey(editor: Editor, opts: { shift?: boolean } = {}, viewportSize?: Size) {
  if (viewportSize) editor.setViewportSize(viewportSize);
  headlessController(editor).keyDown(key("Tab", { shift: !!opts.shift, alt: true }));
}

export function escapeKey(editor: Editor) {
  headlessController(editor).keyDown(key("Escape"));
}

export function deleteKey(editor: Editor) {
  headlessController(editor).keyDown(key("Backspace"));
}

export function returnKey(editor: Editor) {
  headlessController(editor).keyDown(key("Enter"));
}
