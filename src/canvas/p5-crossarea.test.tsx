// P5 rows that fell between areas (the lead's sweep of docs/PARITY.md's open P5 rows): each test
// shows one behaviour the areas built but no area's own test showed. Named after the ledger row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { activeEditor, editorClock, editorFeedback, type Editor } from "../editor";
import { editCommands } from "../editor/commands";
import { defaultHandlers } from "../dev/mockBackend";
import { blankAnalysis } from "../dev/mock/status";
import { loadKv } from "../lib/kv";
import { mockTauri } from "../test/tauri";
import { recordAnalysis, resetSilentAnalysis } from "../panes/status/analysis";
import { InspectorPane } from "../panes/inspector";
import { PicturePicker } from "../panes/inspector/PicturePicker";
import { linkBetween as linkNamed, nodeNamed, openExample } from "../panes/inspector/testing";
import { ParametersHost } from "../windows/parameters";
import { ArchetypeGalleryForm } from "../windows/archetypes/Gallery";
import * as sceneModule from "./geometry/scene";
import { selfLoop, BUNDLE_SPACING } from "./geometry/scene";
import { exitDistance } from "./geometry/outline";
import { toDisplay } from "./geometry/transform";
import type { Point } from "./geometry/types";
import { CanvasView } from "./CanvasView";
import { menuPresenter } from "./interaction/contextMenu";
import { CanvasController, gestureClock } from "./interaction/controller";
import { motionClock } from "./interaction/motion";
import { linkPreview } from "./interaction/preview";
import { canvasColors, classColor } from "./layers/colors";
import { SceneLayers } from "./layers/SceneLayers";
import { byName, example, quietView, sceneOf } from "./layers/testkit";

// A pass-through spy on buildScene, so CAN-205 can count the canvas's scene builds.
vi.mock("./geometry/scene", async (importOriginal) => {
  const m = await importOriginal<typeof import("./geometry/scene")>();
  return { ...m, buildScene: vi.fn(m.buildScene) };
});

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

const settle = () =>
  act(async () => {
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
const up = (el: Element, p: Point, m: Mods = {}) => fireEvent.pointerUp(el, { clientX: p.x, clientY: p.y, button: 0, buttons: 0, pointerId: 1, ...m });
async function click(el: Element, p: Point, m: Mods = {}) {
  down(el, p, m);
  up(el, p, m);
  await settle();
}
async function drag(el: Element, from: Point, to: Point) {
  down(el, from);
  move(el, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  move(el, to);
  up(el, to);
  await settle();
}
async function build(f: () => void) {
  act(f);
  await settle();
}
async function openMenu(surface: Element, p: Point) {
  fireEvent.contextMenu(surface, { clientX: p.x, clientY: p.y });
  await settle();
  return screen.getByRole("menu");
}

describe("the canvas (CAN-054, CAN-157, CAN-205, CAN-209, INS-090, INV-066)", () => {
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
    vi.restoreAllMocks();
    resetSilentAnalysis();
  });

  it("CAN-054: a drag-to-connect drops a chain part-built from another node before tapping its start", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("source", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 300 });
      editor.addNode("station", { x: 600, y: 300 });
      editor.addNode("station", { x: 300, y: 600 });
    });
    const [src, s1, s2, s3] = editor.nodes;
    await build(() => {
      editor.addLink(src.id, s1.id);
      editor.addLink(src.id, s3.id);
    });
    act(() => editor.setTool("addLink"));
    await click(surface, { x: 300, y: 600 });
    expect(editor.view.pendingLinkStartID).toBe(s3.id);
    tick();
    await drag(surface, { x: 300, y: 300 }, { x: 600, y: 300 });
    // The drag made S1 → S2; S3's chain did not read the tap on S1 as its close.
    expect(editor.links.filter((l) => l.fromNodeID === s3.id)).toHaveLength(0);
    expect(editor.links.filter((l) => l.fromNodeID === s1.id && l.toNodeID === s2.id)).toHaveLength(1);
    expect(editor.links).toHaveLength(3);
  });

  it("CAN-157: the canvas draws the ρ badges the silent analysis publishes for its tab", async () => {
    const editor = activeEditor();
    act(() => {
      editor.addNode("source", { x: 100, y: 100 });
      editor.addNode("station", { x: 400, y: 100 });
    });
    const st = editor.nodes[1];
    const { surface } = await mount(editor);
    expect(surface.querySelectorAll('[data-part="rho"]')).toHaveLength(0);
    act(() => recordAnalysis(editor.tabId, { ...blankAnalysis(), utilisation: { [st.id]: 0.934 } }));
    const badge = surface.querySelector(`[data-node="${st.id}"] [data-part="rho"]`)!;
    expect(badge.querySelector("text")!.textContent).toBe("ρ 0.93");
    act(() => recordAnalysis(editor.tabId, blankAnalysis("empty")));
    expect(surface.querySelectorAll('[data-part="rho"]')).toHaveLength(0);
  });

  it("CAN-205: the scene is memoised — a hover rebuilds nothing, a move rebuilds it", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
    });
    await build(() => editor.addLink(editor.nodes[0].id, editor.nodes[1].id));
    const spy = vi.mocked(sceneModule.buildScene);
    spy.mockClear();
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 100, buttons: 0, pointerId: 1 });
    expect(editor.view.hoveredNodeID).toBe(editor.nodes[0].id);
    fireEvent.pointerMove(surface, { clientX: 200, clientY: 100, buttons: 0, pointerId: 1 });
    expect(editor.view.hoveredLinkID).toBe(editor.links[0].id);
    expect(spy).not.toHaveBeenCalled();
    act(() => editor.moveNode(editor.nodes[1].id, { x: 300, y: 200 }));
    expect(spy).toHaveBeenCalled();
  });

  it("CAN-209: hover and the ghost are frozen during a node drag, a pan and a link drag; a pending start publishes only the preview point", async () => {
    const editor = activeEditor();
    act(() => {
      editor.addNode("station", { x: 100, y: 100 });
      editor.addNode("station", { x: 300, y: 100 });
    });
    const [a, b] = editor.nodes;
    act(() => editor.setViewportSize(VIEW));
    const ctrl = new CanvasController(editor, () => editor.makeScene(), () => {});
    for (const frozen of [{ isDraggingNode: true }, { isPanningCanvas: true }]) {
      act(() => editor.setView(frozen));
      ctrl.hover({ x: 100, y: 100 });
      expect(editor.view.hoveredNodeID).toBeNull();
      act(() => editor.setView({ isDraggingNode: false, isPanningCanvas: false }));
    }
    act(() => editor.setTool("addStation"));
    act(() => editor.setView({ isDraggingNode: true }));
    ctrl.hover({ x: 500, y: 500 });
    expect(ctrl.ghost).toBeNull();
    act(() => editor.setView({ isDraggingNode: false }));
    // A link drag owns the preview: hover leaves the hovered target and the point alone.
    act(() => editor.setTool("addLink"));
    const p = (x: number, y: number) => ({ x, y, shift: false, meta: false, alt: false, ctrl: false });
    ctrl.pointerDown(p(100, 100));
    ctrl.pointerMove(p(300, 100));
    expect(ctrl.dragLinkFromID).toBe(a.id);
    expect(editor.view.hoveredNodeID).toBe(b.id);
    const point = editor.view.pendingLinkPoint;
    ctrl.hover({ x: 700, y: 700 });
    expect(editor.view.hoveredNodeID).toBe(b.id);
    expect(editor.view.pendingLinkPoint).toBe(point);
    ctrl.pointerUp(p(700, 700));
    // With a pending start, a move over empty canvas is one publish: the preview point.
    act(() => editor.deselectAll());
    act(() => editor.setView({ pendingLinkStartID: a.id }));
    ctrl.hover({ x: 600, y: 600 });
    let publishes = 0;
    const stop = editor.subscribe(() => publishes++);
    ctrl.hover({ x: 610, y: 600 });
    ctrl.hover({ x: 620, y: 600 });
    stop();
    expect(publishes).toBe(2);
    expect(editor.view.pendingLinkPoint).toEqual({ x: 620, y: 600 });
  });

  it("INS-090: Return opens the selection's editor or beeps; double-click in Multi-Select; the node and link menus' Edit Parameters…", async () => {
    const beep = vi.spyOn(editorFeedback, "beep");
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("source", { x: 100, y: 100 });
      editor.addNode("station", { x: 400, y: 100 });
    });
    const [src, st] = editor.nodes;
    await build(() => editor.addLink(src.id, st.id));
    act(() => editor.deselectAll());
    surface.focus();
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(beep).toHaveBeenCalledTimes(1);
    expect(editor.view.parameterEditorTarget).toBeNull();
    act(() => editor.setView({ selectedLinkID: editor.links[0].id }));
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(editor.view.linkParameterEditorTarget).toBe(editor.links[0].id);
    act(() => editor.closeLinkParameterEditor());
    // Multi-Select: a double-click on a node opens its parameters too.
    act(() => editor.setTool("multiSelect"));
    tick();
    await click(surface, { x: 400, y: 100 });
    clock += 100;
    await click(surface, { x: 400, y: 100 });
    expect(editor.view.parameterEditorTarget).toBe(st.id);
    act(() => editor.closeParameterEditor());
    act(() => editor.setTool("select"));
    // The context menus.
    let menu = await openMenu(surface, { x: 100, y: 100 });
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit Parameters…" })));
    expect(editor.view.parameterEditorTarget).toBe(src.id);
    act(() => editor.closeParameterEditor());
    menu = await openMenu(surface, { x: 250, y: 100 });
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit Parameters…" })));
    expect(editor.view.linkParameterEditorTarget).toBe(editor.links[0].id);
  });

  it("INV-066: Escape, the canvas menu and Edit ▸ Deselect All are one deselectAll; click- and drag-to-link one handleNodeTap", async () => {
    const { editor, surface } = await mount();
    await build(() => {
      editor.addNode("source", { x: 100, y: 100 });
      editor.addNode("station", { x: 400, y: 100 });
      editor.addNode("station", { x: 400, y: 400 });
    });
    const deselect = vi.spyOn(editor, "deselectAll");
    const select = () => act(() => editor.setNodeSelection(new Set([editor.nodes[0].id])));
    select();
    surface.focus();
    fireEvent.keyDown(surface, { key: "Escape" });
    select();
    const menu = await openMenu(surface, { x: 700, y: 700 });
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Deselect All" })));
    select();
    act(() => void editCommands().find((c) => c.id === "edit:deselect-all")!.run());
    expect(deselect).toHaveBeenCalledTimes(3);
    expect(editor.selectionUnion.size).toBe(0);
    const tap = vi.spyOn(editor, "handleNodeTap");
    act(() => editor.setTool("addLink"));
    tick();
    await click(surface, { x: 100, y: 100 });
    tick();
    await click(surface, { x: 400, y: 100 });
    expect(tap.mock.calls.map((c) => c[0])).toEqual([editor.nodes[0].id, editor.nodes[1].id]);
    tap.mockClear();
    act(() => editor.deselectAll());
    tick();
    await drag(surface, { x: 400, y: 100 }, { x: 400, y: 400 });
    expect(tap.mock.calls.map((c) => c[0])).toEqual([editor.nodes[1].id, editor.nodes[2].id]);
    expect(editor.links).toHaveLength(2);
  });
});

describe("the link preview and the pending ring (CAN-080, CAN-081, CAN-082)", () => {
  const light = canvasColors("light");

  it("CAN-080: over empty canvas a bare line from the start's outline to the pointer; back on the start the loop nests outside the loops there", () => {
    const d = example("2dtandem.bnet");
    const s1 = byName(d, "S1");
    const t = sceneOf(d, 1.5).transform;
    const pointer = { x: s1.position[0] + 300, y: s1.position[1] };
    const bare = linkPreview({ start: s1, pointer, target: null, loopsBack: false, links: d.links, transform: t });
    expect(bare.hasArrow).toBe(false);
    const c = toDisplay(t, { x: s1.position[0], y: s1.position[1] });
    expect(bare.geometry.start.x).toBeCloseTo(c.x + exitDistance("station", { x: 0, y: 0 }, { x: 1, y: 0 }) * 1.5, 9);
    expect(bare.geometry.start.y).toBeCloseTo(c.y, 9);
    expect(bare.geometry.tip).toEqual(toDisplay(t, pointer));
    const withLoop = [...d.links, { id: "loop", fromNodeID: s1.id, toNodeID: s1.id, routingProbability: 0.1, customerClass: 0 }];
    const loop = linkPreview({ start: s1, pointer, target: null, loopsBack: true, links: withLoop, transform: t });
    expect(loop.hasArrow).toBe(true);
    expect(loop.geometry).toEqual(selfLoop(c, "station", 1.5, BUNDLE_SPACING * 1.5));
    // Drawn dashed 6·d, 4·d with d = max(0.6, scale): at 50 % the dash bottoms out at 0.6.
    const scene = sceneOf(d, 0.5);
    const { container } = render(
      <SceneLayers scene={scene} view={quietView({ tool: "addLink", pendingLinkStartID: s1.id })} colors={light} infiniteBuffers={false} transient={{ linkPreview: bare.geometry, linkPreviewHasArrow: false, ghost: null, marqueeLive: false }} />,
    );
    const path = container.querySelector('[data-layer="link-preview"] path')!;
    expect(path.getAttribute("stroke-dasharray")).toBe("3.6 2.4");
    expect(path.getAttribute("stroke-width")).toBe("1");
    expect(container.querySelector('[data-layer="link-preview"] [data-part="arrow"]')).toBeNull();
    // CAN-081: the ring's width bottoms out at 1.5 and its dash at 0.6 too.
    const ring = container.querySelector('[data-layer="pending-ring"]')!;
    expect(ring.getAttribute("stroke-width")).toBe("1.5");
    expect(ring.getAttribute("stroke-dasharray")).toBe("3.6 2.4");
  });

  it("CAN-070: a chip is at full opacity, dims with its link's class, and a hovered one is stroked in the label colour", () => {
    const raw = example("3d2cfin.bnet");
    // Every link of this two-class example at p = 0.5, so each carries a chip.
    const d = { ...raw, links: raw.links.map((l) => ({ ...l, routingProbability: 0.5 })) };
    const src = d.nodes.find((n) => n.kind === "source")!;
    const chips = d.links.filter((l) => l.routingProbability !== 1);
    expect(chips.length).toBeGreaterThan(0);
    const draw = (v = quietView()) => render(<SceneLayers scene={sceneOf(d)} view={v} colors={light} infiniteBuffers={d.infiniteBuffers} />).container;
    const quiet = draw();
    for (const l of chips) {
      const g = quiet.querySelector(`[data-link="${l.id}"] [data-part="chip"]`);
      if (g) expect(g.getAttribute("opacity")).toBeNull();
    }
    const dimmedClass = chips[0].customerClass === 0 ? 1 : 0;
    const dim = draw(quietView({ tool: "addLink", activeLinkSourceID: src.id, activeCustomerClass: dimmedClass }));
    const g = dim.querySelector(`[data-link="${chips[0].id}"] [data-part="chip"]`)!;
    expect(g.getAttribute("opacity")).toBe("0.2");
    const hov = draw(quietView({ hoveredLinkID: chips[0].id })).querySelector(`[data-link="${chips[0].id}"] [data-part="chip"] rect`)!;
    expect(hov.getAttribute("stroke")).toBe(classColor(light, chips[0].customerClass));
  });

  it("CAN-082: a new pending start drops the two-click flow's self-loop memo", () => {
    const editor = activeEditor();
    act(() => {
      editor.addNode("source", { x: 100, y: 600 });
      editor.addNode("station", { x: 300, y: 300 });
      editor.addNode("station", { x: 600, y: 300 });
    });
    const [src, a, b] = editor.nodes;
    act(() => {
      editor.addLink(src.id, a.id);
      editor.addLink(src.id, b.id);
      editor.setViewportSize(VIEW);
      editor.setTool("addLink");
    });
    const ctrl = new CanvasController(editor, () => editor.makeScene(), () => {});
    act(() => editor.setView({ pendingLinkStartID: a.id }));
    ctrl.syncWithView();
    ctrl.hover({ x: 301, y: 300 });
    expect(ctrl.pointerOverLinkStart).toBe(false); // never left it
    ctrl.hover({ x: 450, y: 450 });
    ctrl.hover({ x: 300, y: 301 });
    expect(ctrl.pointerOverLinkStart).toBe(true); // out and back
    // The chain moves to B with the pointer already on B: not armed until it leaves B.
    act(() => editor.setView({ pendingLinkStartID: b.id }));
    ctrl.syncWithView();
    expect(ctrl.pointerOverLinkStart).toBe(false);
    ctrl.hover({ x: 600, y: 300 });
    expect(ctrl.pointerOverLinkStart).toBe(false);
    ctrl.hover({ x: 450, y: 450 });
    ctrl.hover({ x: 601, y: 300 });
    expect(ctrl.pointerOverLinkStart).toBe(true);
  });
});

describe("the inspectors (KEY-026)", () => {
  beforeEach(async () => {
    mockTauri(defaultHandlers());
    await loadKv();
    editorClock.now = () => 1_000_000;
  });
  const field = (label: string) => screen.getByRole("textbox", { name: label }) as HTMLInputElement;

  it("KEY-026: Return commits the field; Escape reverts every field of the node form, and the link form", async () => {
    const e = openExample("2dtandem");
    render(<InspectorPane />);
    act(() => e.setView({ selectedNodeID: nodeNamed(e, "S1").id }));
    act(() => field("Number of servers").focus());
    fireEvent.change(field("Number of servers"), { target: { value: "2" } });
    fireEvent.keyDown(field("Number of servers"), { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(nodeNamed(e, "S1").numberOfServers).toBe(2);
    // Two fields edited, neither committed: one Escape puts both back.
    fireEvent.change(field("Name"), { target: { value: "Mill" } });
    fireEvent.change(field("Number of servers"), { target: { value: "5" } });
    fireEvent.keyDown(field("Number of servers"), { key: "Escape" });
    expect(field("Name").value).toBe("S1");
    expect(field("Number of servers").value).toBe("2");
    expect(nodeNamed(e, "S1").numberOfServers).toBe(2);
    const link = linkNamed(e, "S1", "B2");
    act(() => e.setView({ selectedNodeID: null, selectedLinkID: link.id }));
    const before = field("Routing probability").value;
    fireEvent.change(field("Routing probability"), { target: { value: "0.123" } });
    fireEvent.keyDown(field("Routing probability"), { key: "Escape" });
    expect(field("Routing probability").value).toBe(before);
    expect(e.link(link.id)!.routingProbability).toBe(link.routingProbability);
  });
});

describe("the panels (KEY-027, KEY-028, KEY-033, KEY-034, CAN-035)", () => {
  const frames: HTMLIFrameElement[] = [];
  let opened: { name: string; win: Window }[] = [];
  beforeEach(async () => {
    mockTauri(defaultHandlers());
    await loadKv();
    editorClock.now = () => 1_000_000;
    opened = [];
    vi.spyOn(window, "open").mockImplementation((_url, target) => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      frames.push(frame);
      const win = frame.contentWindow!;
      opened.push({ name: String(target), win });
      return win;
    });
  });
  afterEach(() => {
    frames.splice(0).forEach((f) => f.remove());
    vi.restoreAllMocks();
  });
  const win = (name: string) => {
    const o = [...opened].reverse().find((x) => x.name === `qnet-panel-${name}`);
    if (!o) throw new Error(`no window ${name}`);
    return o.win;
  };
  const panel = (name: string) => within(win(name).document.body);

  // KEY-027 is still Open: the highlight moves but the keyboard focus doesn't, because moveRow
  // (src/panes/inspector/NodeSections.tsx) looks for the next row under its own .insp-table-group,
  // which holds only the one row. `it.fails` until that is fixed; then make it `it`.
  it("KEY-027: ↑ / ↓ move focus between the class rows while no text field is being edited", async () => {
    const e = openExample("KumarSeidman90.d2.c4.reentrant.inf");
    render(<ParametersHost />);
    act(() => e.openParameterEditor(nodeNamed(e, "S1").id));
    const p = panel("node-parameters");
    const rows = await p.findAllByRole("row", { name: /^Class \d+ row$/ });
    expect(rows.length).toBeGreaterThan(1);
    const doc = win("node-parameters").document;
    act(() => rows[0].focus());
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    expect(doc.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: "ArrowUp" });
    expect(doc.activeElement).toBe(rows[0]);
    // Inside a text field the arrows are the field's.
    const field = within(rows[0]).getAllByRole("textbox")[0];
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(doc.activeElement).toBe(field);
  });

  it("KEY-028: ⌥↑ goes to the previous node in the Node Parameters panel", async () => {
    const e = openExample("2dtandem");
    render(<ParametersHost />);
    act(() => e.openParameterEditor(nodeNamed(e, "S2").id));
    const p = panel("node-parameters");
    expect(await p.findByRole("heading", { name: "S2" })).toBeInTheDocument();
    fireEvent.keyDown(p.getByRole("textbox", { name: "Name" }), { key: "ArrowUp", altKey: true });
    expect(await p.findByRole("heading", { name: "S1" })).toBeInTheDocument();
    expect(e.view.selectedNodeID).toBe(nodeNamed(e, "S1").id);
  });

  it("KEY-033: in the archetype gallery ← and ↑ go back one tile, clamped at the first", () => {
    render(<ArchetypeGalleryForm state={{ canvasNodeCount: 0, canvasSourceCount: 0, initialInfiniteBuffers: true }} onCancel={() => {}} onInsert={() => {}} />);
    const list = screen.getByRole("listbox", { name: "Insert Archetype" });
    const tile = () => within(list).getByRole("option", { selected: true });
    expect(tile()).toHaveAttribute("data-archetype", "tandemLine");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(tile()).toHaveAttribute("data-archetype", "mmcStation");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(tile()).toHaveAttribute("data-archetype", "mmcStation");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(tile()).toHaveAttribute("data-archetype", "tandemLine");
  });

  it("KEY-034 / CAN-035: ↑ goes back a row of four; the sections in 0.90.34's order; Choose… opens it as its own window", async () => {
    const chosen: string[] = [];
    const { unmount } = render(<PicturePicker current="" onChoose={(sf) => chosen.push(sf)} onCancel={() => chosen.push("cancel")} />);
    const form = screen.getByRole("heading", { name: "Station Picture" }).closest(".panel-form")!;
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["No Picture", "People / Operators", "Manufacturing", "Service Industry", "Logistics / Compute"]);
    expect(screen.getByText(/^Choose a resource icon to draw inside the station circle\./)).toBeInTheDocument();
    for (let i = 0; i < 3; i++) fireEvent.keyDown(form, { key: "ArrowDown" });
    const at = screen.getByRole("option", { selected: true }).getAttribute("aria-label");
    fireEvent.keyDown(form, { key: "ArrowUp" });
    fireEvent.keyDown(form, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("aria-label", at!);
    fireEvent.keyDown(form, { key: "ArrowUp" });
    fireEvent.keyDown(form, { key: "ArrowUp" });
    fireEvent.keyDown(form, { key: "ArrowUp" });
    fireEvent.keyDown(form, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("aria-label", "No Picture, current picture");
    fireEvent.keyDown(form, { key: "Escape" });
    expect(chosen).toEqual(["cancel"]);
    unmount();
    // From the Node Parameters panel the picker is a panel window of its own, not a sheet.
    const e = openExample("2dtandem");
    render(<ParametersHost />);
    act(() => e.openParameterEditor(nodeNamed(e, "S1").id));
    const p = panel("node-parameters");
    fireEvent.click(await p.findByRole("button", { name: "Choose…" }));
    const picker = panel("station-picture");
    expect(await picker.findByRole("heading", { name: "Station Picture" })).toBeInTheDocument();
    expect(win("station-picture").document.title).toBe("Station Picture");
  });
});
