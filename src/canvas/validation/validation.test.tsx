// Problems on a real canvas (CanvasView and its status bar against the preview's stand-in for
// Rust's `network_diagnostics`): a badge per severity, the popover's sentence, every fix as one
// undoable edit, the Problems list, Next / Previous Problem, the View menu's switch, no check for
// a layout change, nothing in the exported diagram, and what the layer costs at 500 nodes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockDiagnostics, standInDiagnostics } from "../../dev/mock/diagnostics";
import { editorFor, type Editor } from "../../editor";
import type { BnetDocument, BnetLink, BnetNode } from "../../lib/bnet";
import { getCommand, runCommand } from "../../lib/commands";
import { getStateValue, loadKv, resetKv } from "../../lib/kv";
import { shortcutFor } from "../../lib/menu";
import { MENU_SPEC, specCommandIds, specItem } from "../../lib/menuSpec";
import { mockCalls, mockTauri } from "../../test/tauri";
import { addTab, tabById } from "../../workspace/store";
import { CanvasView } from "../CanvasView";
import { buildFigure } from "../export/figure";
import { DEFAULT_OPTIONS } from "../export/options";
import { benchNetwork, BENCH_VIEWPORT } from "../geometry/bench";
import { buildRoutePlan, buildScene } from "../geometry/scene";
import { makeTransform } from "../geometry/transform";
import { example, EXAMPLE_NAMES } from "../layers/testkit";
import { BADGE_GAP, BADGE_HEIGHT } from "../overlay/ResultsLayer";
import { CanvasStatusBar } from "../StatusBar";
import { LIST_COMMAND, NEXT_COMMAND, PREVIOUS_COMMAND, TOGGLE_COMMAND, validationCommands } from "./commands";
import { fixesFor } from "./fixes";
import type { Diagnostic } from "./model";
import { badgeOffset, PROBLEM_BADGE, ProblemsLayer } from "./ProblemsLayer";
import { checkNetwork, diagnosticsOf, problemsPointer, resetValidation, setDiagnosticsForTest, SHOW_PROBLEMS_KEY, VALIDATION_DEBOUNCE_MS, validationStats } from "./store";
import { sentence } from "./words";
import css from "./validation.css?raw";

class FixedResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, contentRect: { width: 1200, height: 800, x: 0, y: 0 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FixedResizeObserver);
  document.documentElement.setAttribute("data-motion", "reduce");
  mockTauri(defaultHandlers());
  resetKv();
  resetValidation();
  await loadKv();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-motion");
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const node = (n: number, kind: BnetNode["kind"], name: string, x: number, patch: Partial<BnetNode> = {}): BnetNode => ({
  id: uuid(n),
  kind,
  name,
  position: [x, 300],
  bufferSize: 10,
  distribution: kind === "source" ? "poisson" : "exponential",
  distributionParameters: kind === "source" ? "lambda=1.0" : "rate=1.25",
  numberOfServers: 1,
  serviceDistributions: {},
  picture: "",
  ...patch,
});
const link = (n: number, from: number, to: number, p = 1): BnetLink => ({ id: uuid(100 + n), fromNodeID: uuid(from), toNodeID: uuid(to), routingProbability: p, customerClass: 0 });

/** Src1 → B1 → S1 → Sink1, infinite buffers; S1 serves at `rate` (λ = 1). */
function tandem(rate = "1.25", patch: Partial<BnetDocument> = {}): BnetDocument {
  return {
    infiniteBuffers: true,
    canvasScale: 1,
    canvasPanOffset: [0, 0],
    nodes: [node(1, "source", "Src1", 200), node(2, "buffer", "B1", 320), node(3, "station", "S1", 440, { distributionParameters: `rate=${rate}` }), node(4, "sink", "Sink1", 560)],
    links: [link(1, 1, 2), link(2, 2, 3), link(3, 3, 4)],
    ...patch,
  };
}

async function mount(doc: BnetDocument, withBar = true) {
  let id = "";
  act(() => {
    id = addTab({ title: "test.bnet", document: doc });
  });
  const editor = editorFor(id);
  render(
    <section className="canvas-pane">
      <CanvasView editor={editor} />
      {withBar && <CanvasStatusBar editor={editor} />}
    </section>,
  );
  await settle();
  await act(() => checkNetwork(id));
  return { id, editor, surface: screen.getAllByRole("application", { name: "Network canvas" }).at(-1)! };
}

/** One synchronous task, then the end of the event: the undo group closes. */
const event = async (f: () => void) => {
  act(f);
  await settle();
};
const recheck = (id: string) => act(() => checkNetwork(id));
const badge = (name: string) => screen.queryByRole("button", { name: new RegExp(`^(Error|Warning|Note): .*${name}`) });
const mark = (id: string) => document.querySelector(`[data-problem="node:${id}"]`) as HTMLElement | null;
const pop = (el: Element | null) => el?.querySelector(".canvas-problem-pop") as HTMLElement | null;
const codesOf = (id: string) => diagnosticsOf(id).map((d) => d.code);
const rateOf = (e: Editor, name: string) => e.nodes.find((n) => n.name === name)!.distributionParameters;

describe("badges", () => {
  it("draws none on a healthy network, and the status bar says so", async () => {
    const { id } = await mount(tandem());
    expect(diagnosticsOf(id)).toEqual([]);
    expect(document.querySelector(".canvas-problems")).toBeNull();
    const count = screen.getByRole("button", { name: "Problems: No problems. Show the list" });
    expect(count).toHaveTextContent("No problems");
  });

  it("marks an error with a filled shape, a warning and a note with outlines of their own, and names each for a screen reader", async () => {
    // S1 at ρ = 1.25 (error); S2 reached by nothing (warnings); Sink2 unused (note).
    const doc = tandem("0.8");
    doc.nodes.push(node(5, "station", "S2", 440, { position: [440, 420] }), node(6, "buffer", "B2", 320, { position: [320, 420] }), node(7, "sink", "Sink2", 680));
    doc.links.push(link(4, 6, 5), link(5, 5, 4));
    const { id } = await mount(doc);
    expect(codesOf(id)).toEqual(["unstable", "noArrivals", "noArrivals", "sinkUnused"]);

    const s1 = mark(uuid(3))!;
    expect(s1).toHaveAttribute("data-severity", "error");
    expect(s1.querySelector(".problem-glyph")).toHaveAttribute("data-shape", "filled");
    expect(within(s1).getByRole("button")).toHaveAccessibleName("Error: Work arrives at S1 faster than it can be served (ρ = 1.25). The queue would grow without limit, so no steady state exists: some methods will refuse to run, and a simulation will not settle.");
    const s2 = mark(uuid(5))!;
    expect(s2).toHaveAttribute("data-severity", "warning");
    expect(s2.querySelector(".problem-glyph")).toHaveAttribute("data-shape", "outline");
    const sink = mark(uuid(7))!;
    expect(sink).toHaveAttribute("data-severity", "info");
    // Three shapes, not three colours of one.
    const shapes = [s1, s2, sink].map((m) => m.querySelector(".problem-glyph-shape")!.getAttribute("d"));
    expect(new Set(shapes).size).toBe(3);
    expect(screen.getByRole("group", { name: "Problems on the canvas" })).toHaveAttribute("data-count", "4");
    // The status bar counts errors and warnings, each with its mark.
    const count = screen.getByRole("button", { name: "Problems: 1 error, 2 warnings, 1 note. Show the list" });
    expect(count.querySelectorAll(".problem-glyph")).toHaveLength(2);
    expect(count).toHaveTextContent("12");
  });

  it("takes the top-left corner, clear of the results badge above and the ρ badge on the right at every zoom", () => {
    for (const scale of [0.1, 0.25, 0.45, 1, 2, 4]) {
      const half = (48 * scale) / 2;
      const o = badgeOffset("station", scale, 1.25);
      // Under the value badge, which ends BADGE_GAP above the body.
      expect(o.dy - PROBLEM_BADGE / 2).toBeGreaterThan(-half - BADGE_GAP);
      expect(-half - BADGE_GAP - BADGE_HEIGHT).toBeLessThan(o.dy - PROBLEM_BADGE / 2);
      // Left of the ρ badge ("ρ 1.3": 8 pt off the corner, extending left).
      const free = badgeOffset("station", scale, undefined);
      expect(o.dx).toBeLessThanOrEqual(free.dx);
      expect(o.dx + PROBLEM_BADGE / 2).toBeLessThan(half + 8 - 20);
    }
    // At a normal zoom the ρ badge is far enough right to leave the corner alone.
    expect(badgeOffset("station", 1, 1.25)).toEqual(badgeOffset("station", 1, undefined));
    expect(badgeOffset("station", 0.25, 1.25).dx).toBeLessThan(badgeOffset("station", 0.25, undefined).dx);
  });

  it("marks a link's problem on the link, and the links of a routing row on its station", async () => {
    const doc = tandem("4");
    doc.links.push(link(4, 1, 3));
    const { id } = await mount(doc);
    expect(codesOf(id)).toEqual(["sourceMustFeedBuffer"]);
    const halo = document.querySelector(`[data-problem-link="${uuid(104)}"]`)!;
    expect(halo).toHaveAttribute("data-severity", "error");
    expect(halo.getAttribute("d")).toMatch(/^M/);
    const m = document.querySelector(`[data-problem="link:${uuid(104)}"]`)!;
    expect(within(m as HTMLElement).getByRole("button")).toHaveAccessibleName("Error: The link from Src1 goes straight to S1. A source must lead into a buffer.");

    // A node's problem that names links marks them without badges of their own.
    act(() => setDiagnosticsForTest(id, [{ severity: "error", code: "routingOverOne", nodeIds: [uuid(3)], linkIds: [uuid(103)], values: { name: "S1", sum: 1.5, classIndex: 0 } }]));
    expect(document.querySelector(`[data-problem-link="${uuid(103)}"]`)).not.toBeNull();
    expect(document.querySelectorAll("[data-problem]")).toHaveLength(1);
    expect(badge("S1")).toHaveAccessibleName("Error: The routing probabilities out of S1 for Class 1 add up to 1.50. They can add up to at most 1.");
  });
});

describe("the popover", () => {
  it("opens on hover and on focus with the sentence and the fixes, and closes on Escape", async () => {
    await mount(tandem("0.8"));
    const s1 = mark(uuid(3))!;
    expect(pop(s1)).toBeNull();
    fireEvent.pointerEnter(s1);
    const p = pop(s1)!;
    expect(p).toHaveAccessibleName("Problems with S1");
    expect(p).toHaveTextContent("Error. Work arrives at S1 faster than it can be served (ρ = 1.25). The queue would grow without limit, so no steady state exists: some methods will refuse to run, and a simulation will not settle.");
    expect(within(p).getAllByRole("button").map((b) => b.textContent)).toEqual(["Add a server", "Raise the service rate to 1.3", "Open in Inspector", "Explain"]);
    fireEvent.pointerLeave(s1);
    await waitFor(() => expect(pop(s1)).toBeNull());

    const b = within(s1).getByRole("button");
    act(() => b.focus());
    expect(pop(s1)).not.toBeNull();
    expect(b).toHaveAttribute("aria-expanded", "true");
    expect(b.getAttribute("aria-controls")).toBe(pop(s1)!.id);
    fireEvent.keyDown(b, { key: "Escape" });
    expect(pop(s1)).toBeNull();
  });

  it("stays open after a click until it is clicked again", async () => {
    await mount(tandem("0.8"));
    const s1 = mark(uuid(3))!;
    const b = within(s1).getByRole("button");
    fireEvent.click(b);
    fireEvent.pointerLeave(s1);
    await new Promise((r) => setTimeout(r, 300));
    expect(pop(s1)).not.toBeNull();
    fireEvent.click(b);
    await waitFor(() => expect(pop(s1)).toBeNull());
  });

  it("has a sentence for every code, in plain words with the numbers that matter", () => {
    const d = (code: string, values: Diagnostic["values"] = {}): Diagnostic => ({ severity: "error", code, nodeIds: [], linkIds: [], values: { name: "S2", other: "B1", ...values } });
    expect(sentence(d("nearlyUnstable", { rho: 0.966 }))).toBe("S2 is busy almost all the time (ρ = 0.97). Queues will be long and a simulation will be slow; the diffusion methods are the most accurate here.");
    expect(sentence(d("overloaded", { rho: 1 }))).toContain("(ρ = 1.00). Its buffer will usually be full");
    expect(sentence(d("closedLoop", { classIndex: 1 }))).toBe("Class 2 that reaches S2 keeps coming back and never leaves the network. Lower a routing probability on the loop so some of it can leave.");
    expect(sentence(d("modelRefused", { detail: "Core's own sentence." }))).toBe("Core's own sentence.");
    const codes = ["emptyNetwork", "noSource", "noStation", "noSink", "sourceUnconnected", "badArrivalRate", "sourceCannotReachFirstStation", "stationNeedsBuffer", "stationManyBuffers", "badServiceRate", "noServers", "bufferSizeZero", "sinkUnused", "noArrivals", "noWayOut", "noPathToSink", "sourceMustFeedBuffer", "linkOutOfSink", "sinkFedByBuffer", "linkNeverUsed", "routingOverOne", "routingSinkOverOne", "closedLoop", "unstable", "overloaded", "nearlyUnstable", "infiniteVariance", "noRandomness", "sourceOverOne"];
    const all = codes.map((c) => sentence(d(c, { rho: 1.2, sum: 1.5, classIndex: 0, size: 0, exit: 0.4 })));
    expect(new Set(all).size).toBe(codes.length);
    for (const s of all) {
      expect(s).not.toContain("cannot describe");
      expect(s).not.toMatch(/undefined|NaN|\?/);
      expect(s.endsWith(".")).toBe(true);
    }
  });
});

describe("fixes are real edits, one undo step each", () => {
  it("Add a server", async () => {
    const { id, editor } = await mount(tandem("0.8"));
    fireEvent.pointerEnter(mark(uuid(3))!);
    await event(() => fireEvent.click(screen.getByRole("button", { name: "Add a server" })));
    expect(editor.node(uuid(3))!.numberOfServers).toBe(2);
    expect(editor.undoManager.undoActionName).toBe("Change Number of Servers");
    // The check ran at once, the badge has gone and the keyboard is back on the canvas.
    await waitFor(() => expect(codesOf(id)).toEqual([]));
    expect(mark(uuid(3))).toBeNull();
    expect(screen.getByRole("application", { name: "Network canvas" })).toHaveFocus();
    await event(() => editor.undo());
    expect(editor.node(uuid(3))!.numberOfServers).toBe(1);
    await recheck(id);
    expect(codesOf(id)).toEqual(["unstable"]);
  });

  it("Raise the service rate, to the rate Rust worked out", async () => {
    const { id, editor } = await mount(tandem("0.8"));
    expect(diagnosticsOf(id)[0].values).toMatchObject({ suggestedRate: 1.3, suggestedParameters: "rate=1.3", suggestedServers: 2 });
    fireEvent.pointerEnter(mark(uuid(3))!);
    await event(() => fireEvent.click(screen.getByRole("button", { name: "Raise the service rate to 1.3" })));
    expect(rateOf(editor, "S1")).toBe("rate=1.3");
    await waitFor(() => expect(codesOf(id)).toEqual([]));
    await event(() => editor.undo());
    expect(rateOf(editor, "S1")).toBe("rate=0.8");
    await event(() => editor.redo());
    expect(rateOf(editor, "S1")).toBe("rate=1.3");
  });

  it("offers 'Use N servers' when one more is not enough", async () => {
    const { id, editor } = await mount(tandem("0.25"));
    const d = diagnosticsOf(id)[0];
    expect(d.values.suggestedServers).toBe(5);
    expect(fixesFor(d, editor).map((f) => f.label)).toEqual(["Use 5 servers", "Raise the service rate to 1.3", "Open in Inspector"]);
  });

  it("Open in Inspector selects the node and opens its parameters", async () => {
    const { editor } = await mount(tandem("0.8"));
    fireEvent.pointerEnter(mark(uuid(3))!);
    await event(() => fireEvent.click(screen.getByRole("button", { name: "Open in Inspector" })));
    expect(editor.view.selectedNodeID).toBe(uuid(3));
    expect(editor.view.parameterEditorTarget).toBe(uuid(3));
    expect(editor.undoManager.canUndo).toBe(false);
  });

  it("Connect to a sink", async () => {
    const doc = tandem();
    doc.links = doc.links.filter((l) => l.toNodeID !== uuid(4));
    // Something else still reaches the sink, so the network has one.
    doc.nodes.push(node(5, "buffer", "B2", 320, { position: [320, 420] }), node(6, "station", "S2", 440, { position: [440, 420] }));
    doc.links.push(link(4, 1, 5), link(5, 5, 6), link(6, 6, 4));
    const { id, editor } = await mount(doc);
    expect(codesOf(id)).toContain("noWayOut");
    const before = editor.links.length;
    const d = diagnosticsOf(id).find((x) => x.code === "noWayOut" && x.nodeIds[0] === uuid(3))!;
    await event(() => fixesFor(d, editor).find((f) => f.label === "Connect to a sink")!.run());
    expect(editor.links).toHaveLength(before + 1);
    expect(editor.links.at(-1)).toMatchObject({ fromNodeID: uuid(3), toNodeID: uuid(4), customerClass: 0, routingProbability: 1 });
    expect(editor.undoManager.undoActionName).toBe("Connect to Sink");
    await recheck(id);
    expect(codesOf(id)).not.toContain("noWayOut");
    await event(() => editor.undo());
    expect(editor.links).toHaveLength(before);
  });

  it("Add a sink, connected to every station that led nowhere, as one step", async () => {
    const doc = tandem();
    doc.nodes = doc.nodes.filter((n) => n.kind !== "sink");
    doc.links = doc.links.filter((l) => l.toNodeID !== uuid(4));
    const { id, editor } = await mount(doc);
    expect(codesOf(id)).toEqual(["noSink"]);
    await event(() => fixesFor(diagnosticsOf(id)[0], editor)[0].run());
    const sink = editor.nodes.find((n) => n.kind === "sink")!;
    expect(sink.position[0]).toBeGreaterThan(440);
    expect(editor.links.at(-1)).toMatchObject({ fromNodeID: uuid(3), toNodeID: sink.id });
    expect(editor.undoManager.undoActionName).toBe("Add Sink");
    await recheck(id);
    expect(codesOf(id)).toEqual([]);
    await event(() => editor.undo());
    expect(editor.nodes.some((n) => n.kind === "sink")).toBe(false);
    expect(editor.links).toHaveLength(2);
  });

  it("Add a buffer in front, taking over what led to the station", async () => {
    const doc = tandem();
    // S2 is fed straight from S1: no buffer.
    doc.nodes.push(node(5, "station", "S2", 560, { position: [560, 420] }));
    doc.links[2].routingProbability = 0.5;
    doc.links.push(link(4, 3, 5, 0.5), link(5, 5, 4));
    const { id, editor } = await mount(doc);
    const d = diagnosticsOf(id).find((x) => x.code === "stationNeedsBuffer")!;
    expect(d.nodeIds).toEqual([uuid(5)]);
    await event(() => fixesFor(d, editor).find((f) => f.label === "Add a buffer in front")!.run());
    const buffer = editor.nodes.at(-1)!;
    expect(buffer.kind).toBe("buffer");
    expect(editor.links.find((l) => l.fromNodeID === uuid(3) && l.toNodeID === buffer.id)).toMatchObject({ routingProbability: 0.5, customerClass: 0 });
    expect(editor.links.some((l) => l.fromNodeID === buffer.id && l.toNodeID === uuid(5))).toBe(true);
    expect(editor.links.some((l) => l.fromNodeID === uuid(3) && l.toNodeID === uuid(5))).toBe(false);
    await recheck(id);
    expect(codesOf(id)).toEqual([]);
    await event(() => editor.undo());
    expect(editor.nodes).toHaveLength(5);
    expect(editor.links.some((l) => l.fromNodeID === uuid(3) && l.toNodeID === uuid(5))).toBe(true);
  });

  it("a source into a station: connect it to the station's buffer instead, or insert one", async () => {
    const doc = tandem("4");
    doc.links.push(link(4, 1, 3));
    const { id, editor } = await mount(doc);
    const d = diagnosticsOf(id)[0];
    expect(fixesFor(d, editor).map((f) => f.label)).toEqual(["Connect to B1", "Delete this link", "Open in Inspector"]);
    await event(() => fixesFor(d, editor)[1].run());
    expect(editor.link(uuid(104))).toBeUndefined();
    await event(() => editor.undo());
    expect(editor.link(uuid(104))).toBeDefined();

    // With no buffer at the station, one is inserted on the link.
    const bare: BnetDocument = { ...tandem("4"), nodes: tandem("4").nodes.filter((n) => n.kind !== "buffer"), links: [link(1, 1, 3), link(3, 3, 4)] };
    const second = await mount(bare, false);
    const e2 = second.editor;
    const d2 = diagnosticsOf(second.id).find((x) => x.code === "sourceMustFeedBuffer")!;
    await event(() => fixesFor(d2, e2).find((f) => f.label === "Insert a buffer")!.run());
    const buffer = e2.nodes.find((n) => n.kind === "buffer")!;
    expect(buffer.position).toEqual([320, 300]);
    expect(e2.links.some((l) => l.fromNodeID === uuid(1) && l.toNodeID === buffer.id)).toBe(true);
    expect(e2.links.some((l) => l.fromNodeID === buffer.id && l.toNodeID === uuid(3))).toBe(true);
    expect(e2.undoManager.undoActionName).toBe("Insert Buffer");
    await recheck(second.id);
    expect(codesOf(second.id)).toEqual([]);
    await event(() => e2.undo());
    expect(e2.nodes.some((n) => n.kind === "buffer")).toBe(false);
    expect(e2.links).toHaveLength(2);
  });

  it("the smaller repairs: a source's buffer, a rate, servers, a buffer's size, an unused sink, a routing row", async () => {
    const doc = tandem();
    doc.nodes.push(node(5, "source", "Src2", 200, { position: [200, 420], distributionParameters: "lambda=0" }), node(7, "sink", "Sink2", 680));
    doc.nodes[2] = { ...doc.nodes[2], numberOfServers: 0 };
    doc.nodes[1] = { ...doc.nodes[1], bufferSize: 0 };
    doc.infiniteBuffers = false;
    const { id, editor } = await mount(doc);
    const fix = async (code: string, label: string) => {
      const d = diagnosticsOf(id).find((x) => x.code === code)!;
      expect(d, code).toBeDefined();
      const before = JSON.stringify([editor.nodes, editor.links]);
      await event(() => fixesFor(d, editor).find((f) => f.label === label)!.run());
      const after = JSON.stringify([editor.nodes, editor.links]);
      expect(after).not.toBe(before);
      await event(() => editor.undo());
      expect(JSON.stringify([editor.nodes, editor.links])).toBe(before);
      await event(() => editor.redo());
    };
    await fix("sourceUnconnected", "Connect to B1");
    expect(editor.links.at(-1)).toMatchObject({ fromNodeID: uuid(5), toNodeID: uuid(2), customerClass: 1 });
    await fix("badArrivalRate", "Reset to the default rate");
    expect(rateOf(editor, "Src2")).toBe("lambda=1.0");
    await fix("noServers", "Use 1 server");
    expect(editor.node(uuid(3))!.numberOfServers).toBe(1);
    await fix("bufferSizeZero", "Set the size to 1");
    expect(editor.node(uuid(2))!.bufferSize).toBe(1);
    await fix("sinkUnused", "Delete this sink");
    expect(editor.node(uuid(7))).toBeUndefined();

    // A routing row over 1, as Rust reports it: its links are scaled together, in one step.
    act(() => void editor.addLink(uuid(3), uuid(2), 0, null, 0.9));
    const loop = editor.links.at(-1)!;
    act(() => void editor.addLink(uuid(3), uuid(2), 1, null, 0.6));
    await settle();
    const bare: Diagnostic = { severity: "error", code: "routingOverOne", nodeIds: [uuid(3)], linkIds: [loop.id, editor.links.at(-1)!.id], values: { name: "S1", sum: 1.5, classIndex: 0 } };
    // Without Rust's numbers (no scaling leaves the class a way out) the row is the Inspector's.
    expect(fixesFor(bare, editor).map((f) => f.label)).toEqual(["Open in Inspector"]);
    // With them the button says exactly what the links get, and what the sink link keeps.
    const kept: Diagnostic = { ...bare, values: { ...bare.values, suggestedProbabilities: [0.215, 0.184], exit: 0.6 } };
    expect(fixesFor(kept, editor).map((f) => f.label)).toEqual(["Scale them to 0.215 and 0.184, keeping 0.6 for the sink", "Open in Inspector"]);
    const row: Diagnostic = { ...bare, values: { ...bare.values, suggestedProbabilities: [0.6, 0.4] } };
    await event(() => fixesFor(row, editor).find((f) => f.label === "Scale them to 0.6 and 0.4")!.run());
    expect(editor.link(loop.id)!.routingProbability).toBe(0.6);
    expect(editor.links.at(-1)!.routingProbability).toBe(0.4);
    expect(editor.undoManager.undoActionName).toBe("Scale Routing Probabilities");
    await event(() => editor.undo());
    expect(editor.link(loop.id)!.routingProbability).toBe(0.9);
    expect(editor.links.at(-1)!.routingProbability).toBe(0.6);
  });
});

describe("the Problems list", () => {
  it("opens from the status bar, lists every problem, and a row selects and reveals its node", async () => {
    const doc = tandem("0.8");
    doc.nodes.push(node(7, "sink", "Sink2", 5000));
    const { id, editor } = await mount(doc);
    const count = screen.getByRole("button", { name: "Problems: 1 error, 1 note. Show the list" });
    expect(count).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(count);
    const list = screen.getByRole("dialog", { name: "Problems" });
    expect(count).toHaveAttribute("aria-expanded", "true");
    expect(list).toHaveFocus();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-code"))).toEqual(["unstable", "sinkUnused"]);
    expect(rows[0]).toHaveTextContent("Error. Work arrives at S1 faster than it can be served (ρ = 1.25).");
    // The same fixes as on the canvas.
    expect(within(rows[0]).getByRole("button", { name: "Add a server" })).toBeInTheDocument();

    // Sink2 is far off screen: choosing its row selects it and pans it into view, without zooming.
    const pan = editor.view.canvasPanOffset;
    fireEvent.click(within(list).getByRole("button", { name: "Go to: Note. Nothing leads to Sink2, so no work leaves through it." }));
    expect(screen.queryByRole("dialog", { name: "Problems" })).toBeNull();
    expect(editor.view.selectedNodeID).toBe(uuid(7));
    expect(editor.view.canvasPanOffset).not.toEqual(pan);
    expect(editor.view.canvasScale).toBe(1);
    // Its explanation is open on the canvas, and the keyboard is on its badge.
    await settle();
    const sink = mark(uuid(7))!;
    expect(pop(sink)).toHaveTextContent("Nothing leads to Sink2");
    expect(within(sink).getAllByRole("button")[0]).toHaveFocus();
    expect(id).toBeTruthy();
  });

  it("holds the problems of the whole network, with their fixes, and closes on Escape back to its button", async () => {
    const doc = tandem();
    doc.nodes = doc.nodes.filter((n) => n.kind !== "sink");
    doc.links = doc.links.filter((l) => l.toNodeID !== uuid(4));
    const { id, editor } = await mount(doc);
    const count = screen.getByRole("button", { name: "Problems: 1 error. Show the list" });
    fireEvent.click(count);
    const list = screen.getByRole("dialog", { name: "Problems" });
    expect(list).toHaveTextContent("Error. The network has no sink, so work has no way to leave.");
    // Nowhere on the canvas to go to, so the row is text; the fix is a button.
    expect(within(list).queryByRole("button", { name: /^Go to/ })).toBeNull();
    await event(() => fireEvent.click(within(list).getByRole("button", { name: "Add a sink" })));
    expect(editor.nodes.some((n) => n.kind === "sink")).toBe(true);
    await waitFor(() => expect(codesOf(id)).toEqual([]));
    expect(screen.getByRole("dialog", { name: "Problems" })).toHaveTextContent("Qnet found nothing wrong with this network.");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Problems" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Problems" })).toBeNull();
    expect(screen.getByRole("button", { name: "Problems: No problems. Show the list" })).toHaveFocus();
  });

  it("an empty canvas is a note, not a problem", async () => {
    const { id } = await mount({ ...tandem(), nodes: [], links: [] });
    expect(diagnosticsOf(id)).toMatchObject([{ severity: "info", code: "emptyNetwork" }]);
    expect(screen.getByRole("button", { name: "Problems: No problems, 1 note. Show the list" })).toHaveTextContent("No problems");
    expect(document.querySelector(".canvas-problems")).toBeNull();
    expect(problemsPointer(id)).toBeNull();
  });
});

describe("keyboard", () => {
  it("Next Problem and Previous Problem step through the marked nodes and links, wrapping, with the keyboard on the badge", async () => {
    const doc = tandem("0.8");
    doc.nodes.push(node(7, "sink", "Sink2", 680));
    doc.links.push(link(4, 1, 3));
    const { id, editor } = await mount(doc);
    expect(codesOf(id)).toEqual(["sourceMustFeedBuffer", "unstable", "sinkUnused"]);
    render(<Commands />);
    const step = async (cmd: string) => {
      await act(async () => void (await runCommand(cmd)));
      await settle();
    };
    await step(NEXT_COMMAND);
    expect(editor.view.selectedLinkID).toBe(uuid(104));
    expect(document.activeElement?.closest("[data-problem]")).toHaveAttribute("data-problem", `link:${uuid(104)}`);
    expect(pop(document.activeElement!.closest("[data-problem]"))).toHaveTextContent("A source must lead into a buffer.");
    await step(NEXT_COMMAND);
    expect(editor.view.selectedNodeID).toBe(uuid(3));
    expect(editor.view.selectedLinkID).toBeNull();
    expect(document.activeElement?.closest("[data-problem]")).toBe(mark(uuid(3)));
    // Tab from the badge reaches the fixes: they follow it in the document.
    const buttons = [...mark(uuid(3))!.querySelectorAll("button")];
    expect(buttons[0]).toBe(document.activeElement);
    expect(buttons[1]).toHaveTextContent("Use 4 servers");
    await step(NEXT_COMMAND);
    expect(editor.view.selectedNodeID).toBe(uuid(7));
    await step(NEXT_COMMAND);
    expect(editor.view.selectedLinkID).toBe(uuid(104));
    await step(PREVIOUS_COMMAND);
    expect(editor.view.selectedNodeID).toBe(uuid(7));
    await step(PREVIOUS_COMMAND);
    expect(editor.view.selectedNodeID).toBe(uuid(3));
    // Only one explanation is open at a time.
    expect(document.querySelectorAll(".canvas-problem-pop")).toHaveLength(1);
  });

  it("the commands are in the View menu with shortcuts no other item has", () => {
    const ids = specCommandIds(MENU_SPEC);
    for (const c of [TOGGLE_COMMAND, NEXT_COMMAND, PREVIOUS_COMMAND]) expect(ids).toContain(c);
    expect(specItem(TOGGLE_COMMAND)).toMatchObject({ label: "Show Problems on Canvas", check: true });
    expect(shortcutFor(NEXT_COMMAND)).toBe("⌥⌘]");
    expect(shortcutFor(PREVIOUS_COMMAND)).toBe("⌥⌘[");
    const accels = ids.map((i) => specItem(i)?.accel).filter((a) => a);
    expect(accels.filter((a) => a === "CmdOrCtrl+Alt+]")).toHaveLength(1);
    expect(accels.filter((a) => a === "CmdOrCtrl+Alt+[")).toHaveLength(1);
    // Every menu id has a command, titled as the menu labels it.
    const cmds = validationCommands();
    for (const c of [TOGGLE_COMMAND, NEXT_COMMAND, PREVIOUS_COMMAND]) expect(cmds.find((x) => x.id === c)!.title).toBe(specItem(c)!.label);
    expect(cmds.map((c) => c.id)).toContain(LIST_COMMAND);
  });

  it("Show Problems List opens the list, and with nothing on the canvas to visit Next Problem opens it too", async () => {
    const doc = tandem();
    doc.nodes = doc.nodes.filter((n) => n.kind !== "sink");
    doc.links = doc.links.filter((l) => l.toNodeID !== uuid(4));
    await mount(doc);
    render(<Commands />);
    await act(async () => void (await runCommand(NEXT_COMMAND)));
    expect(screen.getByRole("dialog", { name: "Problems" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Problems" }), { key: "Escape" });
    await act(async () => void (await runCommand(LIST_COMMAND)));
    expect(screen.getByRole("dialog", { name: "Problems" })).toBeInTheDocument();
  });
});

/** The commands are registered by the layer; a healthy network still has them. */
function Commands() {
  return null;
}

describe("a source whose links sum above 1 (review finding FIX-201)", () => {
  it("is a warning on the source with its links marked, and is not said beside a link straight into a station", () => {
    const doc = tandem("0.8");
    const second = { ...doc.links.find((l) => l.fromNodeID === uuid(1))!, id: uuid(150), routingProbability: 0.3 };
    doc.links.push(second);
    const d = standInDiagnostics(doc).find((x) => x.code === "sourceOverOne")!;
    expect(d).toMatchObject({ severity: "warning", nodeIds: [uuid(1)] });
    expect(d.linkIds).toContain(uuid(150));
    expect(sentence(d)).toMatch(/^The links out of \S+ add up to 1\.30, more than 1\. .* Replicated Simulation and Animate refuse the network\. Lower them so that they add up to 1 at most\.$/);
    const direct = tandem("0.8");
    direct.links.push(link(4, 1, 3));
    expect(standInDiagnostics(direct).map((x) => x.code)).not.toContain("sourceOverOne");
    expect(standInDiagnostics(tandem("0.8")).map((x) => x.code)).not.toContain("sourceOverOne");
  });
});

describe("Show Problems on Canvas", () => {
  it("is on by default, hides the badges and marked links when off, and keeps the count and the list", async () => {
    const doc = tandem("0.8");
    doc.links.push(link(4, 1, 3));
    const { id } = await mount(doc);
    expect(getCommand(TOGGLE_COMMAND)!.checked!()).toBe(true);
    expect(document.querySelectorAll("[data-problem]")).toHaveLength(2);
    await act(async () => void (await runCommand(TOGGLE_COMMAND)));
    expect(getStateValue<unknown>(SHOW_PROBLEMS_KEY, undefined)).toBe(false);
    expect(getCommand(TOGGLE_COMMAND)!.checked!()).toBe(false);
    expect(document.querySelector(".canvas-problems")).toBeNull();
    expect(document.querySelector("[data-problem-link]")).toBeNull();
    // Stored like the Results-on-Canvas switch: in state.json, through state_patch.
    expect(mockCalls.some((c) => c.cmd === "state_patch" && (c.args.patch as Record<string, unknown>)[SHOW_PROBLEMS_KEY] === false)).toBe(true);
    // The count stays, and the list says why the canvas shows nothing and offers to show them.
    const count = screen.getByRole("button", { name: "Problems: 2 errors. Show the list" });
    fireEvent.click(count);
    const list = screen.getByRole("dialog", { name: "Problems" });
    expect(list).toHaveTextContent("Problems are hidden on the canvas.");
    fireEvent.click(within(list).getByRole("button", { name: "Show on Canvas" }));
    expect(document.querySelectorAll("[data-problem]")).toHaveLength(2);
    expect(id).toBeTruthy();
  });

  it("never reaches an exported diagram", async () => {
    const doc = tandem("0.8");
    doc.links.push(link(4, 1, 3));
    const { editor } = await mount(doc);
    expect(document.querySelectorAll("[data-problem]")).toHaveLength(2);
    const svg = buildFigure(editor, { options: DEFAULT_OPTIONS, opaqueFallback: false })!.svg;
    expect(svg).not.toMatch(/problem/i);
    // And the canvas's own SVG has none of it: the layer is HTML beside the drawing surface.
    const surface = screen.getByRole("application", { name: "Network canvas" });
    expect(surface.querySelector("[data-problem], .canvas-problems, [data-problem-link]")).toBeNull();
    expect(surface.innerHTML).not.toMatch(/problem/i);
  });
});

describe("when the network is checked", () => {
  it("checks after the debounce, once for a burst of edits", async () => {
    let id = "";
    act(() => {
      id = addTab({ title: "t.bnet", document: tandem("0.8") });
    });
    const editor = editorFor(id);
    render(<CanvasView editor={editor} />);
    await settle();
    expect(validationStats.checks).toBe(0);
    expect(diagnosticsOf(id)).toEqual([]);
    await waitFor(() => expect(codesOf(id)).toEqual(["unstable"]), { timeout: VALIDATION_DEBOUNCE_MS + 1500 });
    expect(validationStats.checks).toBe(1);
    // Three parameter edits in quick succession: one check, of the last state.
    act(() => editor.updateNumberOfServers(uuid(3), 2));
    act(() => editor.updateNumberOfServers(uuid(3), 3));
    act(() => editor.updateNumberOfServers(uuid(3), 1));
    act(() => editor.updateNodeDistribution(uuid(3), "exponential", "rate=2"));
    await waitFor(() => expect(codesOf(id)).toEqual([]), { timeout: VALIDATION_DEBOUNCE_MS + 1500 });
    expect(validationStats.checks).toBe(2);
    expect(mockDiagnostics.calls).toBe(2);
  });

  it("does not check again for a move, a nudge, an align, a picture, a zoom or a pan", async () => {
    const { id, editor } = await mount(tandem("0.8"));
    expect(validationStats.checks).toBe(1);
    const before = diagnosticsOf(id);
    const at = mark(uuid(3))!.style.left;
    act(() => editor.moveNode(uuid(3), { x: 500, y: 360 }));
    act(() => editor.moveNodes(new Map([[uuid(2), { x: 300, y: 200 }]])));
    act(() => editor.setNodeSelection(new Set([uuid(2), uuid(3)])));
    act(() => editor.alignSelectedNodesTop());
    act(() => editor.updateStationPicture(uuid(3), "gear", "Gear"));
    act(() => editor.zoomIn());
    act(() => editor.pan({ width: 40, height: -20 }));
    await new Promise((r) => setTimeout(r, VALIDATION_DEBOUNCE_MS + 150));
    await settle();
    expect(validationStats.checks).toBe(1);
    expect(mockDiagnostics.calls).toBe(1);
    expect(diagnosticsOf(id)).toBe(before);
    // The badge followed its node.
    expect(mark(uuid(3))!.style.left).not.toBe(at);
    // An edit a solver reads does check.
    act(() => editor.updateNumberOfServers(uuid(3), 2));
    await waitFor(() => expect(validationStats.checks).toBe(2), { timeout: VALIDATION_DEBOUNCE_MS + 1500 });
  });

  it("points a refused run at the Problems list when the network has errors", async () => {
    const { id } = await mount(tandem("0.8"));
    expect(problemsPointer(id)).toBe("This network has 1 error, which may be why the run did not start. See Problems in the canvas status bar (⌥⌘] goes to the next one).");
    const ok = await mount(tandem(), false);
    expect(problemsPointer(ok.id)).toBeNull();
    // A link out of a sink is ignored by every exporter: a warning, and no reason for a refusal.
    const doc = tandem();
    doc.nodes.push(node(7, "sink", "Sink2", 680));
    doc.links.push(link(9, 4, 7));
    const stray = await mount(doc, false);
    expect(diagnosticsOf(stray.id).map((d) => [d.code, d.severity])).toEqual([["linkOutOfSink", "warning"]]);
    expect(problemsPointer(stray.id)).toBeNull();
  });
});

describe("the preview's stand-in", () => {
  it("finds no error in any shipped example it can model, and the loads Rust's tests assert", () => {
    for (const name of EXAMPLE_NAMES) {
      const errors = standInDiagnostics(example(name)).filter((d) => d.severity === "error");
      expect(errors, name).toEqual([]);
    }
    expect(standInDiagnostics(example("OpenJackson.d2.feedback.p50.inf.bnet"))).toEqual([]);
    const tandemExample = standInDiagnostics(example("2dtandem.bnet"));
    expect(tandemExample.map((d) => d.code)).toEqual(["overloaded", "overloaded"]);
    expect(tandemExample[1].values).toMatchObject({ rho: 1, suggestedServers: 2, suggestedRate: 1.3, suggestedParameters: "rate=1.3" });
    expect(tandemExample[0].values.suggestedRate).toBeUndefined();
  });

  it("models both routing-row problems: over 1 without the sink link is an error, over 1 only with it a warning, each cured by its fix in one undo step", async () => {
    // S1 sends 0.7 to the sink and 0.6 back to B1: 1.3 for the exporters that count the sink link.
    const doc = tandem("5");
    doc.links[2].routingProbability = 0.7;
    doc.links.push(link(4, 3, 2, 0.6));
    const { id, editor } = await mount(doc);
    expect(codesOf(id)).toEqual(["routingSinkOverOne"]);
    const d = diagnosticsOf(id)[0];
    expect(d).toMatchObject({ severity: "warning", nodeIds: [uuid(3)], linkIds: [uuid(103)], values: { name: "S1", classIndex: 0, suggestedProbabilities: [0.4] } });
    expect(d.values.sum).toBeCloseTo(1.3, 12);
    expect(d.values.exit).toBeCloseTo(0.4, 12);
    expect(sentence(d)).toBe("The routing probabilities out of S1 for Class 1 add up to 1.30 with the link into a sink. Most methods ignore a sink link's number and let 0.40 leave here, but Regenerative Monte Carlo, Product Form, QBD, the CTMC methods and Finite-Buffer Decomposition refuse the network.");
    expect(fixesFor(d, editor).map((f) => f.label)).toEqual(["Set the sink link to 0.4", "Open in Inspector"]);
    await event(() => fixesFor(d, editor)[0].run());
    expect(editor.link(uuid(103))!.routingProbability).toBe(0.4);
    expect(editor.undoManager.undoActionName).toBe("Set Sink Probability");
    await recheck(id);
    expect(codesOf(id)).toEqual([]);
    await event(() => editor.undo());
    expect(editor.link(uuid(103))!.routingProbability).toBe(0.7);
    expect(editor.link(uuid(104))!.routingProbability).toBe(0.6);

    // The feedback alone over 1 is core's refusal: an error on the links that do not enter the sink.
    const over = tandem("5");
    over.links[2].routingProbability = 0.6;
    over.links.push(link(4, 3, 2, 0.9), link(5, 3, 2, 0.6));
    const [e] = standInDiagnostics(over);
    expect(e).toMatchObject({ severity: "error", code: "routingOverOne", linkIds: [uuid(104), uuid(105)], values: { sum: 1.5, exit: 0.6, suggestedProbabilities: [0.24, 0.16] } });
    expect(standInDiagnostics(over).map((x) => x.code)).toEqual(["routingOverOne"]);
    // The other links at exactly 1: flagged, with no number to offer.
    const full = tandem("5");
    full.links.push(link(4, 3, 2, 1));
    const w = standInDiagnostics(full).find((x) => x.code === "routingSinkOverOne")!;
    expect(w.values.suggestedProbabilities).toBeUndefined();
    expect(fixesFor(w, editor).map((f) => f.id)).not.toContain("sink-share");
  });
});

describe("tokens", () => {
  it("colours come from tokens only", () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/);
    expect(tabById("nope")).toBeUndefined();
  });
});

describe("at 500 nodes", () => {
  it("a pan re-renders no badge, a drag only the dragged node's, and a frame of the layer is cheap", async () => {
    const net = benchNetwork(undefined, 500, 1000);
    expect(net.nodes).toHaveLength(500);
    let id = "";
    act(() => {
      id = addTab({ title: "bench.bnet", document: { infiniteBuffers: true, canvasScale: 1, canvasPanOffset: [0, 0], nodes: net.nodes, links: net.links } });
    });
    const editor = editorFor(id);
    // Every node has a problem: the worst case for the layer.
    const all: Diagnostic[] = net.nodes.map((n) => ({ severity: n.kind === "station" ? "error" : "warning", code: n.kind === "station" ? "unstable" : "noArrivals", nodeIds: [n.id], linkIds: [], values: { name: n.name, rho: 1.2 } }));
    act(() => setDiagnosticsForTest(id, all));
    const plan = buildRoutePlan(net.nodes, net.links);
    const sceneAt = (nodes = net.nodes, pan = { width: 0, height: 0 }) => buildScene({ nodes, links: net.links, transform: makeTransform(1, pan, BENCH_VIEWPORT), classFilter: null, routePlan: plan });
    const doc = tabById(id)!.document;
    const view = (scene: ReturnType<typeof sceneAt>) => <ProblemsLayer editor={editor} scene={scene} document={doc} />;
    const { rerender, container } = render(view(sceneAt()));
    expect(container.querySelectorAll("[data-problem]")).toHaveLength(500);

    const changed = () => {
      const seen = new Set<Element>();
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          const el = (r.target as Element).closest?.("[data-problem]") ?? (r.target.parentElement?.closest("[data-problem]") as Element | null);
          if (el) seen.add(el);
        }
      });
      obs.observe(container, { attributes: true, subtree: true, childList: true, characterData: true });
      return () => {
        for (const r of obs.takeRecords()) {
          const el = (r.target as Element).closest?.("[data-problem]");
          if (el) seen.add(el);
        }
        obs.disconnect();
        return seen.size;
      };
    };

    let done = changed();
    rerender(view(sceneAt(net.nodes, { width: 37, height: -12 })));
    expect(done()).toBe(0);
    expect((container.querySelector(".canvas-problems-pan") as HTMLElement).style.transform).toBe("translate(37px, -12px)");

    const moved = net.nodes.map((n, i) => (i === 7 ? { ...n, position: [n.position[0] + 30, n.position[1] + 10] as [number, number] } : n));
    done = changed();
    rerender(view(sceneAt(moved)));
    expect(done()).toBe(1);

    // A frame of the layer during a drag, against a frame of building the scene it is drawn from.
    const fastest = (f: () => void, n = 15) => {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        f();
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    let k = 0;
    const scenes = [sceneAt(moved), sceneAt()];
    const frame = fastest(() => rerender(view(scenes[k++ % 2])));
    const sceneBuild = fastest(() => void sceneAt(k++ % 2 ? moved : net.nodes));
    const checksBefore = validationStats.checks;
    console.info(`problems layer, 500 nodes each with a badge: drag frame ${frame.toFixed(2)} ms (scene build ${sceneBuild.toFixed(2)} ms)`);
    expect(frame).toBeLessThan(16);
    expect(validationStats.checks).toBe(checksBefore);
  });
});
