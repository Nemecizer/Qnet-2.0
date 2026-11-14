// The interactive canvas driven the way a user drives it: real pointer, wheel, pinch and key
// events on a rendered CanvasView, asserting on the editor's document, view and undo stack. Each
// test is named after the line of docs/specs/canvas.md §21 (or the ledger row) it shows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { activeEditor, editorClock, type Editor } from "../../editor";
import { getCommand, registerCommands, runCommand, titleOf, unavailableReason } from "../../lib/commands";
import { holdModal } from "../../lib/overlays";
import { addTab, selectTab } from "../../workspace/store";
import { buildScene, EMPTY_PLAN, linkBetween } from "../geometry/scene";
import { toDisplay, toLogical } from "../geometry/transform";
import type { Point } from "../geometry/types";
import { CanvasView } from "../CanvasView";
import { canvasCommands, toolKeyTarget, useCanvasCommands } from "../commands";
import { ToolsPane } from "../tools/ToolsPane";
import { CanvasToolbarButtons } from "../tools/ToolbarButtons";
import { menuPresenter } from "./contextMenu";
import { gestureClock } from "./controller";
import { motionClock } from "./motion";
import { scrollMetrics, offsetX } from "./metrics";
import { linkPreview } from "./preview";
import { closeFindNode, FindNodeBody } from "./FindNodePanel";
import * as gestures from "./gestures";

const VIEW = { width: 1200, height: 800 };

class FixedResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, contentRect: { ...VIEW, x: 0, y: 0 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}

let clock = 10_000;
const tick = (ms = 1000) => (clock += ms);

beforeEach(() => {
  clock = 10_000;
  vi.stubGlobal("ResizeObserver", FixedResizeObserver);
  gestureClock.now = () => clock;
  motionClock.now = () => clock;
  editorClock.now = () => clock;
  menuPresenter.native = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeFindNode();
});

/** Lets the event's undo group close (one AppKit event = one task). */
const settle = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

async function mount(editor: Editor = activeEditor()) {
  render(<CanvasView editor={editor} />);
  await settle();
  return { editor, surface: screen.getByRole("application", { name: "Network canvas" }) };
}

type Mods = { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };
const down = (el: Element, p: Point, m: Mods = {}) => fireEvent.pointerDown(el, { clientX: p.x, clientY: p.y, button: 0, buttons: 1, pointerId: 1, ...m });
const move = (el: Element, p: Point, m: Mods = {}) => fireEvent.pointerMove(el, { clientX: p.x, clientY: p.y, buttons: 1, pointerId: 1, ...m });
const hover = (el: Element, p: Point, m: Mods = {}) => fireEvent.pointerMove(el, { clientX: p.x, clientY: p.y, buttons: 0, pointerId: 1, ...m });
const up = (el: Element, p: Point, m: Mods = {}) => fireEvent.pointerUp(el, { clientX: p.x, clientY: p.y, button: 0, buttons: 0, pointerId: 1, ...m });

async function click(el: Element, p: Point, m: Mods = {}) {
  down(el, p, m);
  up(el, p, m);
  await settle();
}

async function drag(el: Element, from: Point, to: Point, m: Mods = {}, during?: () => void) {
  down(el, from, m);
  move(el, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, m);
  move(el, to, m);
  during?.();
  up(el, to, m);
  await settle();
}

async function build(f: () => void) {
  act(f);
  await settle();
}

const pos = (e: Editor, name: string) => {
  const n = e.nodes.find((x) => x.name === name)!;
  return { x: n.position[0], y: n.position[1] };
};
const id = (e: Editor, name: string) => e.nodes.find((x) => x.name === name)!.id;
const disp = (e: Editor, p: Point) => toDisplay(e.canvasTransform, p);
const camera = (el: Element) => el.getAttribute("data-camera")!.split(" ").map(Number);

describe("§21 acceptance: clicks, zoom and pan", () => {
  it("A click lands on exactly the node/link that is drawn under it, at 10 % and 400 % zoom", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 400, y: 100 });
    });
    const [a, b] = editor.nodes;
    await build(() => editor.addLink(a.id, b.id));
    for (const scale of [0.1, 4]) {
      act(() => editor.setView({ canvasScale: scale, canvasPanOffset: { width: 600 - 250 * scale, height: 400 - 100 * scale } }));
      tick();
      await click(surface, disp(editor, { x: 400, y: 100 }));
      expect(editor.view.selectedNodeID).toBe(b.id);
      tick();
      const mid = disp(editor, { x: 250, y: 100 });
      await click(surface, mid);
      expect(editor.view.selectedLinkID).toBe(editor.links[0].id);
      expect(editor.view.selectedNodeID).toBeNull();
      tick();
      await click(surface, disp(editor, { x: 250, y: 300 }));
      expect(editor.view.selectedLinkID).toBeNull();
    }
  });

  it("⌥-scroll and pinch keep the world point under the pointer fixed, to the pixel", async () => {
    const { editor, surface } = await mount();
    const anchor = { x: 333, y: 222 };
    const world = () => toLogical(editor.canvasTransform, anchor);
    const before = world();
    fireEvent.wheel(surface, { clientX: anchor.x, clientY: anchor.y, deltaY: -30, deltaMode: 0, altKey: true });
    expect(editor.view.canvasScale).toBeCloseTo(Math.pow(1.1, 3), 10);
    expect(world().x).toBeCloseTo(before.x, 9);
    expect(world().y).toBeCloseTo(before.y, 9);
    // ⌘-scroll does the same; a mouse wheel's lines are delta as they are.
    fireEvent.wheel(surface, { clientX: anchor.x, clientY: anchor.y, deltaY: 1, deltaMode: 1, metaKey: true });
    expect(editor.view.canvasScale).toBeCloseTo(Math.pow(1.1, 2), 10);
    // WebKit's pinch: GestureEvent with a cumulative scale.
    const g = (type: string, scale: number) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & { scale: number; clientX: number; clientY: number };
      Object.assign(ev, { scale, clientX: anchor.x, clientY: anchor.y });
      surface.dispatchEvent(ev);
    };
    const s0 = editor.view.canvasScale;
    g("gesturestart", 1);
    g("gesturechange", 1.5);
    g("gesturechange", 2);
    g("gestureend", 2);
    expect(editor.view.canvasScale).toBeCloseTo(s0 * 2, 10);
    expect(world().x).toBeCloseTo(before.x, 9);
    expect(world().y).toBeCloseTo(before.y, 9);
    // Chrome-style pinch: a wheel with ctrlKey.
    const s1 = editor.view.canvasScale;
    fireEvent.wheel(surface, { clientX: anchor.x, clientY: anchor.y, deltaY: -10, deltaMode: 0, ctrlKey: true });
    expect(editor.view.canvasScale).toBeCloseTo(s1 * Math.exp(0.1), 10);
    expect(world().x).toBeCloseTo(before.x, 9);
    // None of them bumped the animation token: they track 1:1.
    expect(editor.view.canvasAnimationToken).toBe(0);
  });

  it("Zoom to Fit frames everything with an 88 pt margin and glides; wheel zoom does not glide", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("sink", { x: 900, y: 500 });
    });
    const stop = registerCommands(canvasCommands());
    await act(async () => void (await runCommand("view:zoom-to-fit")));
    const target = [editor.view.canvasScale, editor.view.canvasPanOffset.width, editor.view.canvasPanOffset.height];
    // (1200 − 176) / 800 = 1.28 and (800 − 176) / 400 = 1.56: width binds.
    expect(target[0]).toBeCloseTo(1.28, 10);
    expect(toDisplay(editor.canvasTransform, { x: 100, y: 300 }).x).toBeCloseTo(88, 9);
    expect(surface).toHaveAttribute("data-easing", "camera");
    expect(camera(surface)[0]).toBeCloseTo(1, 10);
    clock += 100;
    await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
    const mid = camera(surface)[0];
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(target[0]);
    clock += 150;
    await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
    expect(camera(surface)).toEqual(target);
    expect(surface).not.toHaveAttribute("data-easing");
    fireEvent.wheel(surface, { clientX: 10, clientY: 10, deltaY: -10, deltaMode: 0, altKey: true });
    expect(surface).not.toHaveAttribute("data-easing");
    expect(camera(surface)[0]).toBe(editor.view.canvasScale);
    stop();
  });

  it("Under Reduce Motion nothing eases — routes, guides and camera all land in one step", async () => {
    document.documentElement.setAttribute("data-motion", "reduce");
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
      editor.addNode("station", { x: 500, y: 100 });
    });
    const [a, , c] = editor.nodes;
    await build(() => editor.addLink(a.id, c.id));
    act(() => editor.zoomToFit());
    expect(camera(surface)).toEqual([editor.view.canvasScale, editor.view.canvasPanOffset.width, editor.view.canvasPanOffset.height]);
    expect(surface).not.toHaveAttribute("data-easing");
    act(() => editor.moveNode(editor.nodes[1].id, { x: 300, y: 400 }));
    expect(surface).not.toHaveAttribute("data-easing");
  });

  it("Dragging a node does not re-plan routes; releasing eases them over 150 ms", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
      editor.addNode("station", { x: 500, y: 100 });
    });
    const [a, b, c] = editor.nodes;
    await build(() => editor.addLink(a.id, c.id));
    const planBefore = editor.routePlan;
    expect(planBefore.bulges.size).toBe(1); // the A → C chord crosses B's body
    down(surface, { x: 300, y: 100 });
    move(surface, { x: 300, y: 300 });
    move(surface, { x: 300, y: 500 });
    expect(editor.view.isDraggingNode).toBe(true);
    expect(editor.routePlan).toBe(planBefore);
    up(surface, { x: 300, y: 500 });
    await settle();
    expect(editor.routePlan.bulges.size).toBe(0);
    expect(surface.getAttribute("data-easing")).toContain("routes");
    clock += 160;
    await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
    expect(surface).not.toHaveAttribute("data-easing");
    expect(pos(editor, b.name)).toEqual({ x: 300, y: 500 });
  });

  it("Pan drag sets pan = start + translation, unclamped; the Pan tool's surface takes no node hits (CAN-013, CAN-128)", async () => {
    const { editor, surface } = await mount();
    await build(() => editor.addNode("station", { x: 100, y: 100 }));
    act(() => editor.setTool("pan"));
    await drag(surface, { x: 100, y: 100 }, { x: -5000, y: 40 });
    expect(editor.view.canvasPanOffset).toEqual({ width: -5100, height: -60 });
    expect(pos(editor, "S1")).toEqual({ x: 100, y: 100 });
    expect(editor.view.isPanningCanvas).toBe(false);
  });

  it("Space held pans in any tool; the middle button pans without changing the tool (CAN-018, CAN-019)", async () => {
    const { editor, surface } = await mount();
    await build(() => editor.addNode("station", { x: 100, y: 100 }));
    surface.focus();
    fireEvent.keyDown(surface, { key: " " });
    expect(editor.view.isSpacePanning).toBe(true);
    expect(surface).toHaveAttribute("data-cursor", "grab");
    await drag(surface, { x: 100, y: 100 }, { x: 150, y: 130 });
    expect(editor.view.canvasPanOffset).toEqual({ width: 50, height: 30 });
    expect(pos(editor, "S1")).toEqual({ x: 100, y: 100 });
    fireEvent.keyUp(surface, { key: " " });
    expect(editor.view.isSpacePanning).toBe(false);
    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, button: 1, buttons: 4, pointerId: 2 });
    expect(surface).toHaveAttribute("data-cursor", "grabbing");
    fireEvent.pointerMove(surface, { clientX: 30, clientY: 15, buttons: 4, pointerId: 2 });
    fireEvent.pointerUp(surface, { clientX: 30, clientY: 15, button: 1, buttons: 0, pointerId: 2 });
    expect(editor.view.canvasPanOffset).toEqual({ width: 70, height: 35 });
    expect(editor.view.tool).toBe("select");
    // Losing the keyboard ends a Space pan (resignFirstResponder).
    fireEvent.keyDown(surface, { key: " " });
    fireEvent.blur(surface);
    expect(editor.view.isSpacePanning).toBe(false);
  });

  it("Plain scroll pans in every tool: pixels 1:1, mouse lines × 20 (CAN-125)", async () => {
    const { editor, surface } = await mount();
    fireEvent.wheel(surface, { deltaX: 3, deltaY: 7, deltaMode: 0 });
    expect(editor.view.canvasPanOffset).toEqual({ width: -3, height: -7 });
    fireEvent.wheel(surface, { deltaX: 0, deltaY: 2, deltaMode: 1 });
    expect(editor.view.canvasPanOffset).toEqual({ width: -3, height: -47 });
  });
});

describe("§21 acceptance: dragging, guides, snap", () => {
  it("With Snap to Grid on, the nearer of grid and guide wins per axis", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 302, y: 400 });
    });
    act(() => editor.setSnapToGrid(true));
    // Drag S1 to (300.5, 141): x is 1.5 from S2's centre line (guide) and 7.5 from the grid's 308;
    // y is 1 from the grid's 140 and nowhere near a guide.
    let guides = null as unknown as ReturnType<typeof gestures.dragNode>;
    await drag(surface, { x: 100, y: 100 }, { x: 300.5, y: 141 }, {}, () => (guides = editor.view.activeAlignGuides));
    expect(pos(editor, "S1")).toEqual({ x: 302, y: 140 });
    expect(guides.x).toBe(278); // S2's left edge: the first of the equally near lines wins
    expect(guides.y).toBeNull();
    expect(editor.view.activeAlignGuides.x).toBeNull(); // cleared on release
    // Off-grid by 0.5 with the guide 3 away: the grid wins x.
    tick();
    await drag(surface, { x: 302, y: 140 }, { x: 307.5, y: 141 });
    expect(pos(editor, "S1")).toEqual({ x: 308, y: 140 });
  });

  it("Holding ⌃ mid-drag suspends both, live, and the status bar + zoom cluster say so", async () => {
    const { editor, surface } = await mount();
    await build(() => editor.addNode("station", { x: 112, y: 112 }));
    act(() => editor.setSnapToGrid(true));
    down(surface, { x: 112, y: 112 });
    move(surface, { x: 130, y: 131 });
    expect(pos(editor, "S1")).toEqual({ x: 140, y: 140 });
    expect(editor.view.snapSuspended).toBe(false);
    move(surface, { x: 130, y: 131 }, { ctrlKey: true });
    expect(editor.view.snapSuspended).toBe(true);
    expect(pos(editor, "S1")).toEqual({ x: 130, y: 131 });
    // ⌃ released with the pointer still: the node goes back onto the grid at once.
    fireEvent.keyUp(window, { key: "Control" });
    expect(editor.view.snapSuspended).toBe(false);
    expect(pos(editor, "S1")).toEqual({ x: 140, y: 140 });
    up(surface, { x: 130, y: 131 });
    await settle();
    expect(editor.view.snapSuspended).toBe(false);
    expect(editor.undoManager.undoActionName).toBe("Move Node");
  });

  it("⌥-drag duplicates and carries the copies, as one undo step", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 200, y: 100 });
    });
    const [a, b] = editor.nodes;
    await build(() => editor.addLink(a.id, b.id));
    act(() => editor.setNodeSelection(new Set([a.id, b.id])));
    await drag(surface, { x: 100, y: 100 }, { x: 100, y: 300 }, { altKey: true });
    expect(editor.nodes.map((n) => n.name)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(pos(editor, "S1")).toEqual({ x: 100, y: 100 });
    expect(pos(editor, "S3")).toEqual({ x: 100, y: 300 });
    expect(pos(editor, "S4")).toEqual({ x: 200, y: 300 });
    expect(editor.links).toHaveLength(2);
    expect(editor.selectionUnion).toEqual(new Set([id(editor, "S3"), id(editor, "S4")]));
    expect(editor.undoManager.undoActionName).toBe("Duplicate and Move Nodes");
    act(() => editor.undo());
    expect(editor.nodes).toHaveLength(2);
    expect(editor.links).toHaveLength(1);
    expect(editor.undoManager.undoActionName).toBe("Add Link");
  });

  it("Escape mid-drag restores the start positions and leaves no undo entry; Escape otherwise deselects", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 300 });
    });
    const [a, b] = editor.nodes;
    await build(() => editor.addLink(a.id, b.id));
    const undoName = editor.undoManager.undoActionName;
    surface.focus();
    down(surface, { x: 100, y: 100 });
    move(surface, { x: 160, y: 140 });
    expect(pos(editor, "S1")).toEqual({ x: 160, y: 140 });
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(pos(editor, "S1")).toEqual({ x: 100, y: 100 });
    expect(editor.view.isDraggingNode).toBe(false);
    // The rest of the gesture is ignored, release included.
    move(surface, { x: 400, y: 400 });
    up(surface, { x: 400, y: 400 });
    await settle();
    expect(pos(editor, "S1")).toEqual({ x: 100, y: 100 });
    expect(editor.undoManager.undoActionName).toBe(undoName);
    // The selection the drag made survives the cancel; a second Escape is Deselect All.
    expect(editor.view.selectedNodeID).toBe(a.id);
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(editor.view.selectedNodeID).toBeNull();
    // A link drag cancels the same way.
    tick();
    const mid = { x: 200, y: 200 };
    down(surface, mid);
    move(surface, { x: 240, y: 200 });
    expect(pos(editor, "S2")).toEqual({ x: 340, y: 300 });
    fireEvent.keyDown(surface, { key: "Escape" });
    up(surface, { x: 240, y: 200 });
    await settle();
    expect(pos(editor, "S2")).toEqual({ x: 300, y: 300 });
    expect(editor.undoManager.undoActionName).toBe(undoName);
  });

  it("Escape during an ⌥-drag does not cancel (documented, not a bug)", async () => {
    const { editor, surface } = await mount();
    await build(() => editor.addNode("station", { x: 100, y: 100 }));
    surface.focus();
    down(surface, { x: 100, y: 100 }, { altKey: true });
    move(surface, { x: 100, y: 200 }, { altKey: true });
    fireEvent.keyDown(surface, { key: "Escape" });
    // Escape reaches the canvas as Deselect All, and the release commits the drag.
    expect(editor.selectionUnion.size).toBe(0);
    up(surface, { x: 100, y: 200 });
    await settle();
    expect(editor.nodes).toHaveLength(2);
    expect(pos(editor, "S2")).toEqual({ x: 100, y: 200 });
    expect(editor.undoManager.undoActionName).toBe("Duplicate and Move Node");
  });

  it("Dragging a link moves both ends as one Move Link and selects it without cycling its class (CAN-104)", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
    });
    const [a, b] = editor.nodes;
    await build(() => editor.addLink(a.id, b.id));
    await drag(surface, { x: 200, y: 100 }, { x: 200, y: 150 });
    expect(pos(editor, "S1")).toEqual({ x: 100, y: 150 });
    expect(pos(editor, "S2")).toEqual({ x: 300, y: 150 });
    expect(editor.view.selectedLinkID).toBe(editor.links[0].id);
    expect(editor.links[0].customerClass).toBe(0);
    expect(editor.undoManager.undoActionName).toBe("Move Link");
  });

  it("Dragging an unselected node selects it, or adds it with ⇧ at mouse-down; a group moves rigidly (CAN-102)", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 205, y: 113 });
    });
    const [a, b] = editor.nodes;
    act(() => editor.setNodeSelection(new Set([a.id])));
    act(() => editor.setSnapToGrid(true));
    await drag(surface, { x: 205, y: 113 }, { x: 205, y: 213 }, { shiftKey: true });
    expect(editor.selectionUnion).toEqual(new Set([a.id, b.id]));
    // The anchor (S2) lands on the grid; S1 keeps its offset from it.
    expect(pos(editor, "S2")).toEqual({ x: 196, y: 224 });
    expect(pos(editor, "S1")).toEqual({ x: 91, y: 211 });
    expect(editor.undoManager.undoActionName).toBe("Move Nodes");
  });
});

describe("§21 acceptance: selection", () => {
  it("A marquee selects every node whose body it touches, and the live highlight matches the commit exactly", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 200, y: 100 });
      editor.addNode("station", { x: 400, y: 400 });
    });
    let live: number | null = null;
    // A band from empty canvas whose corner only grazes S2's body.
    await drag(surface, { x: 50, y: 50 }, { x: 186, y: 90 }, {}, () => (live = editor.marqueeNodeCount));
    expect(live).toBe(2);
    expect(editor.view.selectedNodeIDs.size).toBe(2);
    expect(editor.view.multiSelectRect).toBeNull();
    // A Pointer drag under 5 pt is a click, not a band.
    tick();
    await drag(surface, { x: 600, y: 600 }, { x: 603, y: 603 });
    expect(editor.selectionUnion.size).toBe(0);
    // ⇧-drag unions with the selection.
    act(() => editor.setNodeSelection(new Set([editor.nodes[2].id])));
    tick();
    await drag(surface, { x: 50, y: 50 }, { x: 150, y: 150 }, { shiftKey: true });
    expect(editor.view.selectedNodeIDs.size).toBe(2);
  });

  it("A zero-area band from a Multi-Select click is discarded, so double-click-to-pan works in both selection tools", async () => {
    const { editor, surface } = await mount();
    for (const tool of ["multiSelect", "select"] as const) {
      act(() => editor.setTool(tool));
      tick();
      down(surface, { x: 500, y: 500 });
      if (tool === "multiSelect") expect(editor.view.multiSelectRect).toEqual({ x: 500, y: 500, width: 0, height: 0 });
      up(surface, { x: 500, y: 500 });
      await settle();
      expect(editor.view.multiSelectRect).toBeNull();
      clock += 100;
      await click(surface, { x: 501, y: 500 });
      expect(editor.view.tool).toBe("pan");
      expect(editor.view.toolBeforeStickyPan).toBe(tool);
      tick();
      await click(surface, { x: 900, y: 100 });
      expect(editor.view.tool).toBe(tool);
    }
  });

  it("Double-click on empty canvas borrows the hand; one click anywhere gives the tool back; choosing a tool ends the borrow", async () => {
    const { editor, surface } = await mount();
    await build(() => editor.addNode("station", { x: 100, y: 100 }));
    await click(surface, { x: 500, y: 500 });
    clock += 200;
    await click(surface, { x: 502, y: 501 });
    expect(editor.view.tool).toBe("pan");
    // A pan drag keeps the hand; a click on a node (no hits in Pan) gives the tool back.
    tick();
    await drag(surface, { x: 500, y: 500 }, { x: 520, y: 500 });
    expect(editor.view.tool).toBe("pan");
    tick();
    await click(surface, { x: 120, y: 100 });
    expect(editor.view.tool).toBe("select");
    // A second click more than 3 pt away is not a double-click.
    tick();
    await click(surface, { x: 500, y: 500 });
    clock += 100;
    await click(surface, { x: 505, y: 500 });
    expect(editor.view.tool).toBe("select");
    tick();
    await click(surface, { x: 500, y: 500 });
    clock += 100;
    await click(surface, { x: 500, y: 500 });
    expect(editor.view.tool).toBe("pan");
    act(() => editor.setTool("addStation"));
    expect(editor.view.toolBeforeStickyPan).toBeNull();
    tick();
    await click(surface, { x: 700, y: 700 });
    expect(editor.view.tool).toBe("addStation");
  });

  it("A double-click with an add tool places one node, at any zoom, with snapping on or off", async () => {
    const { editor, surface } = await mount();
    act(() => editor.setTool("addStation"));
    for (const [i, [scale, snap]] of ([[1, false], [0.25, true], [3, false], [3, true]] as const).entries()) {
      act(() => {
        editor.setView({ canvasScale: scale });
        editor.setSnapToGrid(snap);
      });
      const n = editor.nodes.length;
      tick();
      const p = { x: 200 + i * 250, y: 300 };
      await click(surface, p);
      clock += 120;
      await click(surface, { x: p.x + 2, y: p.y + 1 });
      clock += 120;
      await click(surface, { x: p.x + 1, y: p.y });
      expect(editor.nodes.length).toBe(n + 1);
    }
    // Two fast clicks on clearly different points are two nodes.
    tick();
    const n = editor.nodes.length;
    act(() => {
      editor.setSnapToGrid(false);
      editor.setView({ canvasScale: 1 });
    });
    await click(surface, { x: 100, y: 600 });
    clock += 100;
    await click(surface, { x: 160, y: 600 });
    expect(editor.nodes.length).toBe(n + 2);
  });

  it("Clicking places a node at the snapped, clamped world point; a click on a node selects it (CAN-014)", async () => {
    const { editor, surface } = await mount();
    act(() => {
      editor.setTool("addSink");
      editor.setSnapToGrid(true);
      editor.setView({ canvasScale: 2, canvasPanOffset: { width: 10, height: 20 } });
    });
    await click(surface, { x: 300, y: 300 });
    expect(pos(editor, "Sink1")).toEqual({ x: 140, y: 140 });
    tick();
    act(() => editor.setView({ selectedNodeID: null }));
    await click(surface, disp(editor, { x: 140, y: 140 }));
    expect(editor.nodes).toHaveLength(1);
    expect(editor.view.selectedNodeID).toBe(id(editor, "Sink1"));
  });

  it("⇧/⌘-click toggles a node in the group; on empty canvas it leaves the selection alone (CAN-085, CAN-092)", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
    });
    await click(surface, { x: 100, y: 100 });
    tick();
    await click(surface, { x: 300, y: 100 }, { metaKey: true });
    expect(editor.view.selectedNodeIDs.size).toBe(2);
    tick();
    await click(surface, { x: 600, y: 600 }, { shiftKey: true });
    expect(editor.view.selectedNodeIDs.size).toBe(2);
    tick();
    await click(surface, { x: 300, y: 100 }, { shiftKey: true });
    expect(editor.view.selectedNodeID).toBe(editor.nodes[0].id);
    tick();
    act(() => editor.setView({ classFilter: 0 }));
    await click(surface, { x: 600, y: 600 });
    expect(editor.selectionUnion.size).toBe(0);
    expect(editor.view.classFilter).toBeNull();
  });

  it("Double-click on a node opens its parameters; on a link, the link's; a slow second click cycles the class (CAN-087, CAN-093)", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("source", { x: 100, y: 100 });
      editor.addNode("source", { x: 100, y: 300 });
      editor.addNode("station", { x: 400, y: 100 });
    });
    const [s1, , st] = editor.nodes;
    await build(() => editor.addLink(s1.id, st.id));
    await click(surface, { x: 400, y: 100 });
    clock += 100;
    await click(surface, { x: 400, y: 100 });
    expect(editor.view.parameterEditorTarget).toBe(st.id);
    act(() => editor.closeParameterEditor());
    tick();
    await click(surface, { x: 250, y: 100 });
    clock += 100;
    await click(surface, { x: 250, y: 100 });
    expect(editor.view.linkParameterEditorTarget).toBe(editor.links[0].id);
    act(() => editor.closeLinkParameterEditor());
    tick();
    // The link is selected now, so a slow click on it again cycles its class.
    await click(surface, { x: 250, y: 100 });
    expect(editor.links[0].customerClass).toBe(1);
  });
});

describe("§21 acceptance: drag-to-connect", () => {
  it("Drag-to-connect shows the exact geometry release would create, self-loop included", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("source", { x: 100, y: 100 });
      editor.addNode("station", { x: 400, y: 160 });
    });
    const [src, st] = editor.nodes;
    act(() => editor.setTool("addLink"));
    down(surface, { x: 100, y: 100 });
    move(surface, { x: 250, y: 130 });
    move(surface, { x: 402, y: 161 });
    expect(editor.view.hoveredNodeID).toBe(st.id);
    const t = editor.canvasTransform;
    const shown = linkPreview({ start: src, pointer: editor.view.pendingLinkPoint!, target: st, loopsBack: false, links: editor.links, transform: t });
    up(surface, { x: 402, y: 161 });
    await settle();
    expect(editor.links).toHaveLength(1);
    const drawn = buildScene({ nodes: editor.nodes, links: editor.links, transform: t, classFilter: null, routePlan: EMPTY_PLAN }).links[0].geometry;
    expect(shown.geometry).toEqual(drawn);
    expect(shown.geometry).toEqual(linkBetween(toDisplay(t, { x: 100, y: 100 }), "source", toDisplay(t, { x: 400, y: 160 }), "station", t.scale));
    // The self-loop: the preview is the loop release creates, nested outside none.
    const loop = linkPreview({ start: st, pointer: { x: 400, y: 160 }, target: null, loopsBack: true, links: editor.links, transform: t });
    tick();
    act(() => editor.deselectAll());
    down(surface, { x: 400, y: 160 });
    move(surface, { x: 600, y: 300 });
    move(surface, { x: 401, y: 160 });
    up(surface, { x: 401, y: 160 });
    await settle();
    expect(editor.links).toHaveLength(2);
    const self = editor.links[1];
    expect(self.fromNodeID).toBe(st.id);
    expect(self.toNodeID).toBe(st.id);
    const scene = buildScene({ nodes: editor.nodes, links: editor.links, transform: t, classFilter: null, routePlan: EMPTY_PLAN });
    expect(loop.geometry).toEqual(scene.links.find((l) => l.id === self.id)!.geometry);
  });

  it("Out-and-back onto the start node draws a self-loop; a shaky click that never left is honoured as a click", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 300, y: 300 });
      editor.addNode("source", { x: 100, y: 600 });
    });
    await build(() => editor.addLink(editor.nodes[1].id, editor.nodes[0].id));
    act(() => editor.setTool("addLink"));
    // A shaky click: travel past the threshold, never off the node.
    await drag(surface, { x: 300, y: 300 }, { x: 306, y: 302 });
    expect(editor.links).toHaveLength(1);
    expect(editor.view.pendingLinkStartID).toBe(editor.nodes[0].id);
    act(() => editor.deselectAll());
    tick();
    down(surface, { x: 300, y: 300 });
    move(surface, { x: 420, y: 300 });
    move(surface, { x: 300, y: 302 });
    up(surface, { x: 300, y: 302 });
    await settle();
    expect(editor.links).toHaveLength(2);
    expect(editor.links[1].fromNodeID).toBe(editor.links[1].toNodeID);
  });

  it("Releasing a link drag on empty canvas leaves the network untouched", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("source", { x: 100, y: 100 });
      editor.addNode("station", { x: 400, y: 100 });
    });
    act(() => editor.setTool("addLink"));
    const undoName = editor.undoManager.undoActionName;
    await drag(surface, { x: 100, y: 100 }, { x: 250, y: 400 });
    expect(editor.links).toHaveLength(0);
    expect(editor.view.pendingLinkStartID).toBeNull();
    expect(editor.view.pendingLinkPoint).toBeNull();
    expect(editor.undoManager.undoActionName).toBe(undoName);
    // A drag from one node to the other replays the two-click flow and continues the chain.
    tick();
    await drag(surface, { x: 100, y: 100 }, { x: 400, y: 100 });
    expect(editor.links).toHaveLength(1);
    expect(editor.view.pendingLinkStartID).toBe(editor.nodes[1].id);
  });

  it("The two-click flow arms the self-loop only after the pointer has left the pending start (CAN-218)", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 300, y: 300 });
      editor.addNode("source", { x: 100, y: 600 });
    });
    await build(() => editor.addLink(editor.nodes[1].id, editor.nodes[0].id));
    act(() => editor.setTool("addLink"));
    await click(surface, { x: 300, y: 300 });
    hover(surface, { x: 301, y: 300 });
    expect(editor.view.hoveredNodeID).toBeNull(); // the start never wears the hover ring
    expect(editor.view.pendingLinkPoint).toEqual({ x: 301, y: 300 });
    hover(surface, { x: 500, y: 300 });
    hover(surface, { x: 302, y: 300 });
    tick();
    await click(surface, { x: 302, y: 300 });
    expect(editor.links).toHaveLength(2);
    expect(editor.links[1].toNodeID).toBe(editor.links[1].fromNodeID);
    fireEvent.pointerLeave(surface);
    expect(editor.view.pendingLinkPoint).toBeNull();
  });
});

describe("§21 acceptance: keys", () => {
  it("Holding an arrow key produces one undo entry; a whole grid cell per press while snapping", async () => {
    const { editor, surface } = await mount();
    await build(() => editor.addNode("station", { x: 112, y: 112 }));
    act(() => editor.setSnapToGrid(true));
    surface.focus();
    await click(surface, { x: 112, y: 112 });
    for (let i = 0; i < 5; i++) {
      clock += 60;
      fireEvent.keyDown(surface, { key: "ArrowRight", repeat: i > 0 });
      await settle();
    }
    fireEvent.keyUp(surface, { key: "ArrowRight" });
    await settle();
    expect(pos(editor, "S1")).toEqual({ x: 252, y: 112 });
    expect(editor.undoManager.undoActionName).toBe("Move Node");
    act(() => editor.undo());
    expect(pos(editor, "S1")).toEqual({ x: 112, y: 112 });
    expect(editor.undoManager.undoActionName).toBe("Add Station");
    // ⇧: four cells; snapping off: 1 pt, ⇧ 10 pt.
    fireEvent.keyDown(surface, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyUp(surface, { key: "ArrowDown" });
    expect(pos(editor, "S1")).toEqual({ x: 112, y: 224 });
    act(() => editor.setSnapToGrid(false));
    fireEvent.keyDown(surface, { key: "ArrowLeft" });
    fireEvent.keyDown(surface, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyUp(surface, { key: "ArrowUp" });
    expect(pos(editor, "S1")).toEqual({ x: 111, y: 214 });
  });

  it("Arrows with nothing selected scroll the view instead of doing nothing", async () => {
    const { editor, surface } = await mount();
    surface.focus();
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(editor.view.canvasPanOffset).toEqual({ width: -20, height: 0 });
    fireEvent.keyDown(surface, { key: "ArrowUp", shiftKey: true });
    expect(editor.view.canvasPanOffset).toEqual({ width: -20, height: 80 });
  });

  it("Tab walks nodes in reading order and pans off-screen targets into view; ⌥Tab walks a node's links", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 500, y: 100 });
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 2000 });
    });
    const [a, b, c] = editor.nodes;
    await build(() => {
      editor.addLink(b.id, a.id);
      editor.addLink(c.id, b.id);
    });
    surface.focus();
    // The walk starts from no selection (2.1: at the last node Tab leaves the canvas, it no longer wraps; WF-602).
    act(() => editor.deselectAll());
    fireEvent.keyDown(surface, { key: "Tab" });
    expect(editor.view.selectedNodeID).toBe(b.id);
    expect(editor.view.canvasPanOffset).toEqual({ width: 0, height: 0 }); // on screen: no jitter
    fireEvent.keyDown(surface, { key: "Tab" });
    expect(editor.view.selectedNodeID).toBe(a.id);
    fireEvent.keyDown(surface, { key: "Tab" });
    expect(editor.view.selectedNodeID).toBe(c.id);
    // Revealed 88 pt inside the bottom edge.
    expect(disp(editor, { x: 300, y: 2000 }).y).toBe(800 - 88);
    fireEvent.keyDown(surface, { key: "Tab", shiftKey: true });
    expect(editor.view.selectedNodeID).toBe(a.id);
    act(() => editor.setNodeSelection(new Set([b.id])));
    fireEvent.keyDown(surface, { key: "Tab", altKey: true });
    expect(editor.view.selectedLinkID).toBe(editor.links[0].id);
    fireEvent.keyDown(surface, { key: "Tab", altKey: true });
    expect(editor.view.selectedLinkID).toBe(editor.links[1].id);
    // Both ends revealed in turn (C, then B): B, the last, is inside the margin.
    expect(disp(editor, { x: 100, y: 100 }).y).toBe(88);
  });

  it("Delete, Return and the tool letters on the canvas; keys with ⌘ go to the menus (KEY-005, KEY-008, KEY-013, KEY-014)", async () => {
    const { editor, surface } = await mount();
    await build(() => editor.addNode("station", { x: 100, y: 100 }));
    surface.focus();
    await click(surface, { x: 100, y: 100 });
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(editor.view.parameterEditorTarget).toBe(editor.nodes[0].id);
    for (const [k, tool] of [["m", "multiSelect"], ["H", "pan"], ["o", "addSource"], ["s", "addStation"], ["b", "addBuffer"], ["x", "addSink"], ["l", "addLink"], ["v", "select"]] as const) {
      fireEvent.keyDown(surface, { key: k });
      expect(editor.view.tool).toBe(tool);
    }
    fireEvent.keyDown(surface, { key: "m", metaKey: true });
    expect(editor.view.tool).toBe("select");
    act(() => editor.setNodeSelection(new Set([editor.nodes[0].id])));
    fireEvent.keyDown(surface, { key: "Delete" });
    await settle();
    expect(editor.nodes).toHaveLength(0);
    expect(editor.undoManager.undoActionName).toBe("Delete Node");
    // A dialog over the canvas keeps the letters and Delete (CAN-216).
    const release = holdModal();
    fireEvent.keyDown(surface, { key: "h" });
    expect(editor.view.tool).toBe("select");
    release();
  });

  it("Clicking the canvas takes focus away from a text field (⌘Z keeps working)", async () => {
    const { editor, surface } = await mount();
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    await click(surface, { x: 500, y: 500 });
    expect(document.activeElement).toBe(surface);
    field.remove();
    void editor;
  });
});

describe("§21 acceptance: the cursor", () => {
  it("The cursor is never stale after a tool switch made while the pointer is elsewhere", async () => {
    const { editor, surface } = await mount();
    const stop = registerCommands(canvasCommands());
    expect(surface).toHaveAttribute("data-cursor", "default");
    await act(async () => void (await runCommand("tool:pan")));
    expect(surface).toHaveAttribute("data-cursor", "grab");
    expect(surface.style.cursor).toBe("grab");
    await act(async () => void (await runCommand("tool:station")));
    expect(surface).toHaveAttribute("data-cursor", "crosshair");
    act(() => editor.setTool("multiSelect"));
    expect(surface).toHaveAttribute("data-cursor", "crosshair");
    act(() => editor.setTool("select"));
    expect(surface).toHaveAttribute("data-cursor", "default");
    stop();
  });

  it("⌥ over a node flips to the copy cursor before the drag starts", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
    });
    await build(() => editor.addLink(editor.nodes[0].id, editor.nodes[1].id));
    hover(surface, { x: 100, y: 100 });
    expect(surface).toHaveAttribute("data-cursor", "default");
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(surface).toHaveAttribute("data-cursor", "copy");
    fireEvent.keyUp(window, { key: "Alt" });
    expect(surface).toHaveAttribute("data-cursor", "default");
    hover(surface, { x: 200, y: 100 });
    expect(surface).toHaveAttribute("data-cursor", "pointer");
    act(() => editor.setTool("addLink"));
    hover(surface, { x: 300, y: 100 });
    expect(surface).toHaveAttribute("data-cursor", "pointer");
    hover(surface, { x: 600, y: 600 });
    expect(surface).toHaveAttribute("data-cursor", "default");
    // Dragging a node is the closed hand.
    act(() => editor.setTool("select"));
    down(surface, { x: 100, y: 100 });
    move(surface, { x: 120, y: 120 });
    expect(surface).toHaveAttribute("data-cursor", "grabbing");
    up(surface, { x: 120, y: 120 });
    await settle();
  });

  it("Hover follows the tool: nodes in Pointer, Multi-Select and Link, links only in Pointer, a ghost for the add tools (CAN-218, CAN-015)", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
    });
    await build(() => editor.addLink(editor.nodes[0].id, editor.nodes[1].id));
    act(() => editor.setTool("multiSelect"));
    hover(surface, { x: 200, y: 100 });
    expect(editor.view.hoveredLinkID).toBeNull();
    hover(surface, { x: 100, y: 100 });
    expect(editor.view.hoveredNodeID).toBe(editor.nodes[0].id);
    act(() => editor.setTool("addBuffer"));
    hover(surface, { x: 100, y: 100 });
    expect(editor.view.hoveredNodeID).toBeNull();
    fireEvent.keyDown(surface, { key: " " });
    hover(surface, { x: 300, y: 100 });
    expect(editor.view.hoveredNodeID).toBeNull();
    fireEvent.keyUp(surface, { key: " " });
  });
});

describe("context menus (§12.8, ledger §3.9)", () => {
  async function openMenu(surface: Element, p: Point) {
    fireEvent.contextMenu(surface, { clientX: p.x, clientY: p.y });
    await settle();
    return screen.getByRole("menu");
  }
  const labels = (menu: HTMLElement) => [...menu.querySelectorAll(":scope > [role^=menuitem]")].map((e) => e.querySelector(".ctx-label")!.textContent);

  it("Canvas: Paste · Duplicate Selection │ Select All · Deselect All │ Zoom to Fit · Zoom to Selection · Actual Size │ Snap to Grid (CAN-142, CAN-150)", async () => {
    const { editor, surface } = await mount();
    await build(() => editor.addNode("station", { x: 100, y: 100 }));
    act(() => editor.deselectAll());
    const menu = await openMenu(surface, { x: 600, y: 600 });
    expect(labels(menu)).toEqual(["Paste", "Duplicate Selection", "Select All", "Deselect All", "Zoom to Fit", "Zoom to Selection", "Actual Size", "Snap to Grid"]);
    expect(within(menu).getByRole("menuitem", { name: "Paste" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Deselect All" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Snap to Grid" })).toHaveAttribute("aria-checked", "false");
    expect(menu.textContent).not.toMatch(/⌘/);
    await act(async () => fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Snap to Grid" })));
    expect(editor.view.snapToGrid).toBe(true);
  });

  it("Link: Edit Parameters…, Customer Class (several classes), Exit Class, Delete Link (CAN-141, CAN-143…146)", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("source", { x: 100, y: 100 });
      editor.addNode("source", { x: 100, y: 400 });
      editor.addNode("station", { x: 400, y: 100 });
    });
    const [s1, , st] = editor.nodes;
    await build(() => {
      editor.addLink(s1.id, st.id, 0);
      editor.addLink(s1.id, st.id, 1);
    });
    const menu = await openMenu(surface, { x: 250, y: 100 });
    expect(labels(menu)).toEqual(["Edit Parameters…", "Customer Class", "Exit Class", "Delete Link"]);
    const link = editor.link(editor.makeScene().links.length ? (await import("../geometry/scene")).hitLink(editor.makeScene(), { x: 250, y: 100 })!.id : "")!;
    await act(async () => fireEvent.pointerEnter(within(menu).getByRole("menuitem", { name: "Customer Class" })));
    const other = link.customerClass === 0 ? "Class 2" : "Class 1";
    expect(screen.getByRole("menuitemcheckbox", { name: other })).toHaveAttribute("aria-disabled", "true");
    await act(async () => fireEvent.pointerEnter(within(menu).getByRole("menuitem", { name: "Exit Class" })));
    const exits = screen.getAllByRole("menu").at(-1)!;
    expect(labels(exits)).toEqual([`Same as entry (Class ${link.customerClass + 1})`, "Class 1", "Class 2", "Class 3"]);
    await act(async () => fireEvent.click(within(exits).getByRole("menuitemcheckbox", { name: "Class 3" })));
    await settle();
    expect(editor.link(link.id)!.toCustomerClass).toBe(2);
    expect(editor.undoManager.undoActionName).toBe("Change Exit Class");
    const again = await openMenu(surface, { x: 250, y: 100 });
    await act(async () => fireEvent.click(within(again).getByRole("menuitem", { name: "Delete Link" })));
    await settle();
    expect(editor.links).toHaveLength(1);
  });

  it("Node: the align set for a group, Copy (N nodes) / Cut / Duplicate, Paste, Edit Parameters…, Delete <Kind> (CAN-147…149)", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("buffer", { x: 300, y: 160 });
      editor.addNode("sink", { x: 500, y: 100 });
    });
    const [a, b] = editor.nodes;
    act(() => editor.setNodeSelection(new Set([a.id, b.id])));
    let menu = await openMenu(surface, { x: 300, y: 160 });
    expect(labels(menu)).toEqual([
      "Align Top", "Align Vertical Centres", "Align Bottom", "Align Left", "Align Horizontal Centres", "Align Right", "Distribute Horizontally", "Distribute Vertically",
      "Copy (2 nodes)", "Cut (2 nodes)", "Duplicate (2 nodes)", "Paste", "Edit Parameters…", "Delete Buffer",
    ]);
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Align Top" })));
    await settle();
    expect(pos(editor, "B1").y).toBe(100);
    // A node outside the selection becomes the sole selection for the clipboard items.
    menu = await openMenu(surface, { x: 500, y: 100 });
    expect(labels(menu)).toEqual(["Copy", "Cut", "Duplicate", "Paste", "Edit Parameters…", "Delete Sink"]);
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Duplicate" })));
    await settle();
    expect(editor.nodes.map((n) => n.name)).toEqual(["S1", "B1", "Sink1", "Sink2"]);
    menu = await openMenu(surface, { x: 100, y: 100 });
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Station" })));
    await settle();
    expect(editor.nodes.map((n) => n.name)).toEqual(["B1", "Sink1", "Sink2"]);
  });
});

describe("scrollers and metrics (§14, CAN-129, CAN-130)", () => {
  it("are inert while the content fits, and map their value to a pan through the pan-independent box", async () => {
    const t = { scale: 1, pan: { width: 0, height: 0 }, viewportSize: VIEW };
    const fits = scrollMetrics([{ position: [100, 100] }, { position: [500, 300] }], t);
    expect(fits.hEnabled).toBe(false);
    expect(fits.vEnabled).toBe(false);
    const wide = scrollMetrics([{ position: [100, 100] }, { position: [2100, 300] }], t);
    expect(wide.hEnabled).toBe(true);
    // overflow right = 2116 − 1200 = 916; knob = 1200 / 2116
    expect(wide.hKnob).toBeCloseTo(1200 / 2116, 12);
    expect(wide.panAt0X).toBe(-84);
    expect(wide.panAt1X).toBe(1200 - 2116);
    expect(offsetX(wide, 1)).toBe(-916);
    // A 1-pt overflow is below the 2-pt floor.
    expect(scrollMetrics([{ position: [16, 100] }], { ...t, pan: { width: -1, height: 0 } }).hEnabled).toBe(false);
  });

  it("page in a slot click and never snap the pan back", async () => {
    const { editor } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 3100, y: 100 });
    });
    const h = screen.getByRole("scrollbar", { name: "Canvas horizontal scroller" });
    expect(h).toHaveAttribute("data-enabled");
    expect(screen.getByRole("scrollbar", { name: "Canvas vertical scroller" })).not.toHaveAttribute("data-enabled");
    vi.spyOn(h, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 785, 1200, 15));
    fireEvent.pointerDown(h, { clientX: 1190, clientY: 790, button: 0, pointerId: 3 });
    const m = scrollMetrics(editor.nodes, editor.canvasTransform);
    expect(m.hValue).toBeGreaterThan(0.3);
    expect(editor.view.canvasPanOffset.width).toBeLessThan(0);
    // The arrow keys step a line (0.05) when the scroller has the keyboard.
    const before = m.hValue;
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(scrollMetrics(editor.nodes, editor.canvasTransform).hValue).toBeCloseTo(before + 0.05, 9);
  });
});

describe("commands (§1.4 View, §1.6 Tools, CAN-214)", () => {
  it("View ▸ Zoom In / Out step 1.25 about the centre and glide, unless a pane with text size has focus (MENU-058, MENU-059)", async () => {
    const { editor } = await mount();
    const stop = registerCommands(canvasCommands());
    await act(async () => void (await runCommand("view:zoom-in")));
    expect(editor.view.canvasScale).toBeCloseTo(1.25, 12);
    expect(editor.view.canvasAnimationToken).toBe(1);
    expect(toLogical(editor.canvasTransform, { x: 600, y: 400 })).toEqual({ x: 600, y: 400 });
    // A focused Status pane with a zoom handler takes the key instead.
    const { registerFocusTarget } = await import("../../workspace/focus");
    const zoom = vi.fn();
    const pane = document.createElement("div");
    pane.setAttribute("data-pane", "status");
    pane.tabIndex = 0;
    document.body.appendChild(pane);
    const off = registerFocusTarget("status", { zoom });
    pane.focus();
    await act(async () => void (await runCommand("view:zoom-out")));
    expect(zoom).toHaveBeenCalledWith(-1);
    expect(editor.view.canvasScale).toBeCloseTo(1.25, 12);
    off();
    pane.remove();
    await act(async () => void (await runCommand("view:zoom-out")));
    expect(editor.view.canvasScale).toBeCloseTo(1, 12);
    stop();
  });

  it("Actual Size, Zoom to Fit (dimmed when empty), Zoom to Selection (dimmed without a node selection), Snap to Grid checked (MENU-060…063)", async () => {
    const { editor } = await mount();
    const stop = registerCommands(canvasCommands());
    expect(unavailableReason(getCommand("view:zoom-to-fit")!)).toBe("The canvas is empty");
    expect(unavailableReason(getCommand("view:zoom-to-selection")!)).not.toBeNull();
    await build(() => editor.addNode("station", { x: 100, y: 100 }));
    expect(unavailableReason(getCommand("view:zoom-to-fit")!)).toBeNull();
    await act(async () => void (await runCommand("view:zoom-to-selection")));
    expect(editor.view.canvasScale).toBe(4); // one node frames at the ceiling (CAN-123)
    await act(async () => void (await runCommand("view:actual-size")));
    expect(editor.canvasTransform.scale).toBe(1);
    expect(editor.view.canvasPanOffset).toEqual({ width: 0, height: 0 });
    expect(getCommand("view:snap-to-grid")!.checked!()).toBe(false);
    await act(async () => void (await runCommand("view:snap-to-grid")));
    expect(getCommand("view:snap-to-grid")!.checked!()).toBe(true);
    stop();
  });

  it("the Tools menu: eight items in palette order, checked = the current tool, dimmed under a dialog (MENU-101…109, CAN-008)", async () => {
    const editor = activeEditor();
    const stop = registerCommands(canvasCommands());
    const ids = ["tool:select", "tool:multi-select", "tool:pan", "tool:source", "tool:station", "tool:buffer", "tool:sink", "tool:link"];
    expect(ids.map((i) => titleOf(getCommand(i)!))).toEqual(["Pointer Tool", "Multi-Select Tool", "Pan Tool", "Source Tool", "Station Tool", "Buffer Tool", "Sink Tool", "Link Tool"]);
    expect(getCommand("tool:select")!.subtitle).toMatch(/^Pointer tool \(V\) — click to select.* — Help ▸ Keyboard Shortcuts lists every key$/);
    await act(async () => void (await runCommand("tool:link")));
    expect(editor.view.tool).toBe("addLink");
    expect(ids.map((i) => getCommand(i)!.checked!())).toEqual([false, false, false, false, false, false, false, true]);
    const release = holdModal();
    expect(unavailableReason(getCommand("tool:pan")!)).toBe("Close the open dialog first");
    release();
    stop();
  });

  it("the bare tool letters work anywhere in the main window but never in a text field, the Shell or under a dialog (KEY-003, CAN-009, CAN-216)", async () => {
    function Host() {
      useCanvasCommands();
      return (
        <>
          <input aria-label="field" />
          <div data-pane="shell" tabIndex={0} aria-label="shell" />
          <button type="button">plain</button>
        </>
      );
    }
    render(<Host />);
    const editor = activeEditor();
    screen.getByRole("button", { name: "plain" }).focus();
    fireEvent.keyDown(screen.getByRole("button", { name: "plain" }), { key: "h" });
    expect(editor.view.tool).toBe("pan");
    screen.getByLabelText("field").focus();
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "v" });
    expect(editor.view.tool).toBe("pan");
    screen.getByLabelText("shell").focus();
    fireEvent.keyDown(screen.getByLabelText("shell"), { key: "v" });
    expect(editor.view.tool).toBe("pan");
    screen.getByRole("button", { name: "plain" }).focus();
    const release = holdModal();
    fireEvent.keyDown(screen.getByRole("button", { name: "plain" }), { key: "v" });
    expect(editor.view.tool).toBe("pan");
    release();
    fireEvent.keyDown(screen.getByRole("button", { name: "plain" }), { key: "V", shiftKey: true });
    expect(editor.view.tool).toBe("select");
    expect(toolKeyTarget({ key: "v", metaKey: true, ctrlKey: false, altKey: false, isComposing: false, defaultPrevented: false, target: null })).toBeNull();
  });

  it("the toolbar's Straighten Network and Zoom to Fit (TB-002, TB-003, WS-012)", async () => {
    render(<CanvasToolbarButtons />);
    const editor = activeEditor();
    const fit = screen.getByRole("button", { name: "Zoom to Fit" });
    expect(fit).toBeDisabled();
    expect(fit).toHaveAttribute("title", "Zoom to Fit — frame the whole network without moving any node (View ▸ Zoom to Fit, ⇧⌘0)");
    const straighten = screen.getByRole("button", { name: "Straighten Network" });
    expect(straighten).toHaveAttribute("title", "Straighten Network (Network ▸ Straighten Network)");
    expect(straighten).toBeEnabled();
    await act(async () => fireEvent.click(straighten));
    const { activeTab } = await import("../../workspace/store");
    expect(activeTab().log.at(-1)?.text).toBe("Nothing to straighten.");
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 250 });
    });
    expect(fit).toBeEnabled();
    await act(async () => fireEvent.click(straighten));
    await settle();
    expect(editor.nodes.map((n) => n.position[1])).toEqual([175, 175]);
  });
});

describe("the Tools pane (CAN-003…007, KEY-020, MENU-147)", () => {
  it("groups the tools, marks the active one, and Focus Tools puts the keyboard on it", async () => {
    render(<ToolsPane />);
    const editor = activeEditor();
    const pane = screen.getByRole("region", { name: "Tools pane" });
    expect(within(pane).getByRole("heading", { name: "Tools" })).toBeInTheDocument();
    const buttons = within(pane).getAllByRole("button", { name: / tool$/ });
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Pointer tool", "Multi-Select tool", "Pan tool", "Source tool", "Station tool", "Buffer tool", "Sink tool", "Link tool"]);
    expect(buttons.map((b) => b.textContent)).toEqual(["PointerV", "Multi-SelectM", "PanH", "SourceO", "StationS", "BufferB", "SinkX", "LinkL"]);
    expect(pane.querySelectorAll("[role=separator]")).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    expect(buttons[0]).toHaveAttribute("aria-description", "Shortcut V on the canvas");
    expect(buttons[4]).toHaveAttribute("title", "Station tool (S) — click the canvas to place a service station");
    await act(async () => fireEvent.click(buttons[4]));
    expect(editor.view.tool).toBe("addStation");
    expect(buttons[4]).toHaveAttribute("aria-pressed", "true");
    const { handlersFor } = await import("../../workspace/focus");
    act(() => handlersFor("tools")!.focus!());
    expect(document.activeElement).toBe(buttons[4]);
    fireEvent.keyDown(buttons[4], { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[5]);
    fireEvent.keyDown(buttons[5], { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
  });
});

describe("Find Node (MENU-044, MENU-045, CAN-168…170)", () => {
  it("is ⌘F on the canvas, enabled with nodes, and filters live", async () => {
    function Host() {
      useCanvasCommands();
      return null;
    }
    const { paneCommands } = await import("../../workspace/panes/commands");
    const stopPanes = registerCommands(paneCommands());
    render(<Host />);
    const editor = activeEditor();
    expect(titleOf(getCommand("edit:find")!)).toBe("Find Node…");
    expect(unavailableReason(getCommand("edit:find")!)).not.toBeNull();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
      editor.addNode("source", { x: 100, y: 300 });
    });
    expect(unavailableReason(getCommand("edit:find")!)).toBeNull();
    stopPanes();
    editor.setViewportSize(VIEW);
    const done = vi.fn();
    render(<FindNodeBody onDone={done} />);
    expect(screen.getByText("3 nodes on the canvas")).toBeInTheDocument();
    const field = screen.getByRole("searchbox", { name: "Node name" });
    expect(field).toHaveAttribute("placeholder", "Node name (e.g. S3, Src, buffer)");
    fireEvent.change(field, { target: { value: "zz" } });
    expect(screen.getByText("No node matches “zz”")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find" })).toBeDisabled();
    fireEvent.change(field, { target: { value: " s " } });
    expect(screen.getByText("3 matches")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "S2" } });
    expect(screen.getByText("1 match")).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(done).toHaveBeenCalled();
    expect(editor.view.selectedNodeID).toBe(editor.nodes[1].id);
    expect(editor.view.canvasScale).toBe(4);
    const { activeTab } = await import("../../workspace/store");
    expect(activeTab().log.at(-1)?.text).toBe("Found S2.");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(done).toHaveBeenCalledTimes(2);
  });
});

describe("tab switch (CAN-222)", () => {
  it("rebinds the canvas to the new tab's editor: its own nodes, zoom, selection and undo", async () => {
    const first = activeEditor();
    const { useActiveEditor } = await import("../../editor");
    function Switcher() {
      const e = useActiveEditor();
      return <CanvasView key={e.tabId} editor={e} />;
    }
    render(<Switcher />);
    await settle();
    let surface = screen.getByRole("application", { name: "Network canvas" });
    await build(() => first.addNode("station", { x: 100, y: 100 }));
    const second = await act(async () => {
      const id2 = addTab({ title: "Second" });
      selectTab(id2);
      return id2;
    });
    await settle();
    const e2 = activeEditor();
    expect(e2.tabId).toBe(second);
    surface = screen.getByRole("application", { name: "Network canvas" });
    expect(surface.closest("[data-tab]")).toHaveAttribute("data-tab", second);
    fireEvent.keyDown(surface, { key: "h" });
    expect(e2.view.tool).toBe("pan");
    expect(first.view.tool).toBe("select");
    fireEvent.wheel(surface, { deltaY: 10, deltaMode: 0 });
    expect(e2.view.canvasPanOffset.height).toBe(-10);
    expect(first.view.canvasPanOffset.height).toBe(0);
    expect(e2.undoManager.canUndo).toBe(false);
    expect(first.undoManager.canUndo).toBe(true);
  });
});

describe("headless gestures (golden/edits replays)", () => {
  it("drive the shipped controller: a click, a drag with guides, a connect, keys", async () => {
    const editor = activeEditor();
    editor.setViewportSize(VIEW);
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 103 });
    });
    const [a, b] = editor.nodes;
    gestures.nodeClick(editor, a.id);
    expect(editor.view.selectedNodeID).toBe(a.id);
    const g = gestures.dragNode(editor, a.id, { width: 0, height: 4 });
    expect(g.y).toBe(79); // S2's top edge
    expect(pos(editor, "S1")).toEqual({ x: 100, y: 103 });
    await settle();
    expect(editor.undoManager.undoActionName).toBe("Move Node");
    // ⌥-drag: the anchor is the original node, which is not dragged, so no guide applies.
    const g2 = gestures.dragNode(editor, a.id, { width: 0, height: 10 }, { option: true });
    expect(g2.y).toBeNull();
    await settle();
    expect(editor.nodes).toHaveLength(3);
    await build(() => editor.addNode("source", { x: 100, y: 600 }));
    act(() => editor.setTool("addLink"));
    gestures.dragConnect(editor, editor.nodes[3].id, b.id);
    await settle();
    expect(editor.links).toHaveLength(1);
    gestures.dragConnect(editor, b.id, b.id, { returned: true });
    await settle();
    expect(editor.links).toHaveLength(2);
    act(() => editor.setTool("select"));
    gestures.escapeKey(editor);
    gestures.arrowKey(editor, "down", { shift: true });
    expect(editor.view.canvasPanOffset).toEqual({ width: 0, height: -80 });
    expect(gestures.marquee(editor, { x: 50, y: 0 }, { x: 350, y: 150 })).toBe(3);
    gestures.legendClick(editor, 0);
    expect(editor.view.classFilter).toBe(0);
    gestures.legendClick(editor, 0);
    expect(editor.view.classFilter).toBeNull();
  });
});

describe("ghost, clamp and the one-shot fit", () => {
  it("an add tool's ghost sits on the snapped point the click would place at, and not while Space pans (CAN-015)", () => {
    const editor = activeEditor();
    const c = gestures.headlessController(editor);
    editor.setTool("addBuffer");
    editor.setSnapToGrid(true);
    c.hover({ x: 33, y: 50 });
    expect(c.ghost).toEqual({ x: 28, y: 56 });
    editor.setView({ isSpacePanning: true });
    c.hover({ x: 90, y: 90 });
    expect(c.ghost).toBeNull();
    editor.setTool("select");
    editor.setView({ isSpacePanning: false });
    c.hover({ x: 90, y: 90 });
    expect(c.ghost).toBeNull();
  });

  it("dragged positions are clamped to ±100 000 world pt (CAN-110)", async () => {
    const editor = activeEditor();
    await build(() => editor.addNode("station", { x: 0, y: 0 }));
    editor.setView({ canvasScale: 0.1 });
    gestures.dragNode(editor, editor.nodes[0].id, { width: 20_000, height: -30_000 });
    await settle();
    expect(pos(editor, "S1")).toEqual({ x: 100_000, y: -100_000 });
  });

  it("a fit an insert asked for runs once the viewport is known, and clears the flag (CAN-131)", async () => {
    const editor = activeEditor();
    await build(() => {
      editor.addNode("station", { x: 3000, y: 3000 });
      editor.addNode("station", { x: 3400, y: 3100 });
    });
    act(() => editor.setView({ pendingFitOnAppear: true }));
    await mount(editor);
    expect(editor.view.pendingFitOnAppear).toBe(false);
    expect(toDisplay(editor.canvasTransform, { x: 3200, y: 3050 })).toEqual({ x: 600, y: 400 });
  });
});

describe("undo and the selection (CAN-099)", () => {
  it("undo keeps the selection, dropping ids that no longer exist, and closes the editor targets", async () => {
    const editor = activeEditor();
    await build(() => editor.addNode("station", { x: 100, y: 100 }));
    await build(() => editor.addNode("station", { x: 300, y: 100 }));
    const [a, b] = editor.nodes;
    act(() => {
      editor.setNodeSelection(new Set([a.id, b.id]));
      editor.openParameterEditor(a.id);
    });
    act(() => editor.undo());
    expect(editor.nodes).toHaveLength(1);
    expect(editor.selectionUnion).toEqual(new Set([a.id]));
    expect(editor.view.parameterEditorTarget).toBeNull();
  });
});
