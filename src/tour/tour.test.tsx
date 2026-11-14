// The guided first model (new in 2.1, ROADMAP C2; ledger UX-201…224): the engine, the steps'
// conditions over the real stores, where the callout sits, the keyboard and the live region, and
// the whole tour done with Show Me against the simulated backend.
import { AnimationEngine } from "../animate/engine";
import { afterEach, beforeEach, describe as group, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";
import { ToolsPane } from "../canvas/tools/ToolsPane";
import { defaultHandlers } from "../dev/mockBackend";
import { mockRuns } from "../dev/mock/runs";
import { drawnLine } from "../dev/mock/tour";
import { editorFor } from "../editor";
import { getCommand, runCommand } from "../lib/commands";
import { getStateValue, loadKv } from "../lib/kv";
import { MENU_SPEC, specItem } from "../lib/menuSpec";
import { interactionWords } from "../canvas/interaction/words";
import { resetAdvice } from "../panes/results/agreement/chooser";
import { resetAgreementCommands } from "../panes/results/agreement/commands";
import { resetSequence } from "../panes/results/agreement/runner";
import { resetStructures } from "../results/current";
import { mockTauri } from "../test/tauri";
import { activeTab, getWorkspace, selectTab } from "../workspace/store";
import { TourEngine, type TourStep } from "./engine";
import { ARROW_INSET, boxDistance, GAP, MARGIN, placeCallout, placeCorner, placeNear, ringBox } from "./position";
import { COMPLETED_KEY, endTour, resetTour, SEEN_KEY, startTour, tour, tourOffered, tourTabId, tourWorld } from "./state";
import { chain, describe, lineLinked, missingLinks, nextLinkClick, nextQueuePart, overloadedStation, rateEdited, STEPS, verdictWords } from "./steps";
import { TourHost } from "./TourHost";
import { STEP_ORDER, tourWords as w } from "./words";

const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const callout = () => document.querySelector<HTMLElement>(".tour-callout");
const button = (action: string) => callout()!.querySelector<HTMLButtonElement>(`[data-tour-action="${action}"]`)!;

beforeEach(async () => {
  mockTauri(defaultHandlers());
  mockRuns.replayMs = 5;
  resetSequence();
  resetAdvice();
  resetAgreementCommands();
  resetStructures();
  resetTour();
  await loadKv();
});
afterEach(() => {
  resetTour();
  vi.restoreAllMocks();
});

// ── The engine, on a world of its own ────────────────────────────────────────────────────────

interface Toy {
  a: boolean;
  b: boolean;
  c: boolean;
}

function toy() {
  const world: Toy = { a: false, b: false, c: false };
  const shown: string[] = [];
  const entered: string[] = [];
  const ends: boolean[] = [];
  let finished = 0;
  const step = (id: keyof Toy, manual = false): TourStep<Toy> => ({
    id,
    manual,
    done: (w) => w[id],
    show: () => {
      shown.push(id);
      world[id] = true;
    },
    enter: () => void entered.push(id),
  });
  const engine = new TourEngine<Toy>([step("a"), step("b", true), step("c")], { world: () => world, onFinish: () => finished++, onEnd: (f) => ends.push(f) });
  return { engine, world, shown, entered, ends, finished: () => finished };
}

group("the engine", () => {
  it("moves on when the current step's condition becomes true, and not before (UX-202)", () => {
    const { engine, world, entered } = toy();
    engine.start();
    expect(engine.state).toMatchObject({ phase: "running", index: 0 });
    engine.observe();
    expect(engine.state.index).toBe(0);
    world.a = true;
    engine.observe();
    expect(engine.state.index).toBe(1);
    expect(entered).toEqual(["a", "b"]);
  });

  it("waits for Next on a step to read, whatever its condition says (UX-202)", () => {
    const { engine, world, finished } = toy();
    Object.assign(world, { a: true, b: true });
    engine.start();
    // Step a was already done: passed over on the way in. Step b is read, not done.
    expect(engine.state.index).toBe(1);
    engine.observe();
    expect(engine.state.index).toBe(1);
    engine.next();
    expect(engine.state.index).toBe(2);
    world.c = true;
    engine.observe();
    expect(engine.state.phase).toBe("finished");
    expect(finished()).toBe(1);
  });

  it("Back onto a step already done stays there until Next; undoing the step arms it again (UX-203)", () => {
    const { engine, world } = toy();
    engine.start();
    world.a = true;
    engine.observe();
    engine.back();
    expect(engine.state).toMatchObject({ index: 0, armed: false });
    engine.observe();
    expect(engine.state.index).toBe(0);
    world.a = false;
    engine.observe();
    expect(engine.state.armed).toBe(true);
    world.a = true;
    engine.observe();
    expect(engine.state.index).toBe(1);
    // Back from the first step does nothing; Back from the finish card returns to the last step.
    engine.back();
    engine.back();
    expect(engine.state.index).toBe(0);
  });

  it("Skip goes on without doing the step, and Show Me later does the skipped steps first (UX-203, UX-204)", async () => {
    const { engine, world, shown } = toy();
    engine.start();
    engine.next();
    engine.next();
    expect(engine.state.index).toBe(2);
    expect(world).toEqual({ a: false, b: false, c: false });
    await engine.showMe();
    expect(shown).toEqual(["a", "b", "c"]);
    expect(engine.state.phase).toBe("finished");
  });

  it("Show Me does the step through its own action and the tour moves on; on a step to read it stays (UX-204)", async () => {
    const { engine, shown } = toy();
    engine.start();
    await engine.showMe();
    expect(shown).toEqual(["a"]);
    expect(engine.state.index).toBe(1);
    await engine.showMe();
    expect(shown).toEqual(["a", "b"]);
    expect(engine.state.index).toBe(1);
  });

  it("End tells whether the tour was finished; the finish card's Back returns to the last step", () => {
    const { engine, world, ends } = toy();
    engine.start();
    engine.end();
    expect(engine.state.phase).toBe("idle");
    Object.assign(world, { a: true, b: true, c: true });
    engine.start(engine.firstOpen());
    expect(engine.state.index).toBe(2);
    engine.next();
    expect(engine.state.phase).toBe("finished");
    engine.back();
    expect(engine.state).toMatchObject({ phase: "running", index: 2, armed: false });
    engine.next();
    engine.end();
    expect(ends).toEqual([false, true]);
  });
});

// ── The steps, over the real stores ──────────────────────────────────────────────────────────

/** One event of the interface (the editor closes its undo group when it returns). */
const event = async (f: () => void) => {
  f();
  await Promise.resolve();
};

group("the steps' conditions over the real stores", () => {
  it("starts in a new untitled tab with infinite buffers and leaves the student's network alone (UX-201)", () => {
    const mine = activeTab();
    const before = mine.document;
    startTour();
    const id = tourTabId()!;
    expect(id).not.toBe(mine.id);
    expect(activeTab()).toMatchObject({ id, title: "Untitled", path: null });
    expect(activeTab().document).toMatchObject({ nodes: [], links: [], infiniteBuffers: true });
    expect(getWorkspace().tabs).toHaveLength(2);
    expect(getWorkspace().tabs[0].document).toBe(before);
    expect(tour.state).toMatchObject({ phase: "running", index: 0 });
  });

  it("follows the student's own clicks from the source to the linked line (UX-205…208)", async () => {
    startTour();
    const e = editorFor(tourTabId()!);
    const step = () => tour.step!.id;
    const at = (x: number) => ({ x, y: 200 });

    await event(() => e.setTool("addSource"));
    tour.observe();
    expect(step()).toBe("source");
    await event(() => e.handleCanvasTap(at(100)));
    tour.observe();
    expect(step()).toBe("stations");

    // Buffer, station, buffer, station: the step says which is next and counts them.
    expect(nextQueuePart(tourWorld().doc)).toBe("buffer");
    await event(() => e.setTool("addBuffer"));
    await event(() => e.handleCanvasTap(at(200)));
    expect(nextQueuePart(tourWorld().doc)).toBe("station");
    expect(describe("stations", tourWorld()).note).toBe("1 of 4 placed.");
    await event(() => e.setTool("addStation"));
    await event(() => e.handleCanvasTap(at(300)));
    await event(() => e.setTool("addBuffer"));
    await event(() => e.handleCanvasTap(at(400)));
    tour.observe();
    expect(step()).toBe("stations");
    await event(() => e.setTool("addStation"));
    await event(() => e.handleCanvasTap(at(500)));
    expect(nextQueuePart(tourWorld().doc)).toBeNull();
    tour.observe();
    expect(step()).toBe("sink");

    await event(() => e.setTool("addSink"));
    await event(() => e.handleCanvasTap(at(600)));
    tour.observe();
    expect(step()).toBe("link");
    expect(chain(tourWorld().doc).map((n) => n.name)).toEqual(["Src1", "B1", "S1", "B2", "S2", "Sink1"]);
    expect(describe("link", tourWorld()).text).toContain("Src1, B1, S1, B2, S2, Sink1");

    // The Link tool: each click after the first draws one arrow; the step names the next node.
    await event(() => e.setTool("addLink"));
    expect(nextLinkClick(tourWorld())?.name).toBe("Src1");
    const names = chain(tourWorld().doc);
    for (const [i, n] of names.entries()) {
      expect(lineLinked(tourWorld().doc)).toBe(false);
      await event(() => e.handleNodeTap(n.id));
      if (i < names.length - 1) expect(describe("link", tourWorld()).note).toBe(`Next: select ${names[i + 1].name}.`);
    }
    expect(missingLinks(tourWorld().doc)).toEqual([]);
    expect(lineLinked(tourWorld().doc)).toBe(true);
    tour.observe();
    expect(step()).toBe("rate");
    expect(drawnLine(tourWorld().doc)).toMatchObject({ lambda: 1, stations: [{ mu: 1.1111111 }, { mu: 1.1111111 }] });
  });

  it("a line that stops short of the sink, or passes one station only, is not yet linked (UX-208)", async () => {
    startTour();
    await act(() => tour.showMe());
    await act(() => tour.showMe());
    await act(() => tour.showMe());
    const e = editorFor(tourTabId()!);
    const [src, b1, s1, , , sink] = chain(tourWorld().doc);
    await event(() => e.addLink(src.id, b1.id));
    await event(() => e.addLink(b1.id, s1.id));
    expect(lineLinked(tourWorld().doc)).toBe(false);
    await event(() => e.addLink(s1.id, sink.id));
    expect(lineLinked(tourWorld().doc)).toBe(false);
    expect(missingLinks(tourWorld().doc).map(([a, b]) => `${a.name}→${b.name}`)).toEqual(["S1→B2", "B2→S2", "S2→Sink1"]);
  });

  it("Show Me builds the line with the editor's own tools and sets the rate through the Inspector's draft (UX-204, UX-209)", async () => {
    startTour();
    const id = tourTabId()!;
    for (const expected of ["stations", "sink", "link", "rate"]) {
      await act(() => tour.showMe());
      expect(tour.step!.id).toBe(expected);
    }
    const doc = tourWorld().doc;
    expect(doc.nodes.map((n) => n.name)).toEqual(["Src1", "B1", "S1", "B2", "S2", "Sink1"]);
    expect(doc.links).toHaveLength(5);
    expect(editorFor(id).view.tool).toBe("select");
    expect(rateEdited(doc)).toBe(false);
    await act(() => tour.showMe());
    expect(rateEdited(tourWorld().doc)).toBe(true);
    const s1 = tourWorld().doc.nodes.find((n) => n.name === "S1")!;
    expect(s1.serviceDistributions["0"]).toEqual({ distribution: "exponential", distributionParameters: "rate=2" });
    expect(drawnLine(tourWorld().doc)!.stations.map((s) => s.mu)).toEqual([2, 1.1111111]);
    expect(tour.step!.id).toBe("solve");
    // Every placement, link and edit is the student's to undo: the Status log says what was done.
    expect(activeTab().log.map((l) => l.text).join("\n")).toMatch(/Added source Src1[\s\S]*Linked[\s\S]*Edited S1/);
    expect(editorFor(id).undoManager.canUndo).toBe(true);
  });

  it("a slower rate that overloads the station does not complete the step; the callout says what to try (review)", async () => {
    startTour();
    const id = tourTabId()!;
    for (let i = 0; i < 4; i++) await act(() => tour.showMe());
    expect(tour.step!.id).toBe("rate");
    const s1 = tourWorld().doc.nodes.find((n) => n.name === "S1")!;
    const words = () => describe("rate", tourWorld(), true);
    expect(words().note).toBeUndefined();
    // λ = 1: a server that finishes 0.5 a unit of time never catches up.
    await act(async () => editorFor(id).updateNodeDistribution(s1.id, "exponential", "rate=0.5"));
    act(() => tour.observe());
    expect(rateEdited(tourWorld().doc)).toBe(true);
    expect(overloadedStation(tourWorld().doc)?.name).toBe("S1");
    expect(tour.step!.id).toBe("rate");
    expect(words().note).toBe("That makes S1 slower than customers arrive. Try 2.");
    // A rate the line can keep up with completes it.
    await act(async () => editorFor(id).updateNodeDistribution(s1.id, "exponential", "rate=1.5"));
    act(() => tour.observe());
    expect(overloadedStation(tourWorld().doc)).toBeNull();
    expect(tour.step!.id).toBe("solve");
  });

  it("ended early, it picks up in its own tab at the first step still to do; a closed tab starts afresh (UX-215)", async () => {
    const mine = activeTab().id;
    startTour();
    const id = tourTabId()!;
    await act(() => tour.showMe());
    await act(() => tour.showMe());
    endTour();
    expect(tour.state.phase).toBe("idle");
    selectTab(mine);
    startTour();
    expect(tourTabId()).toBe(id);
    expect(activeTab().id).toBe(id);
    expect(tour.step!.id).toBe("sink");
    expect(getWorkspace().tabs).toHaveLength(2);
    // Asked again while it runs, it only comes back to its tab.
    selectTab(mine);
    startTour();
    expect(activeTab().id).toBe(id);
    expect(tour.step!.id).toBe("sink");
  });

  it("is offered until it has been started once, and remembers being finished (UX-216)", async () => {
    expect(tourOffered()).toBe(true);
    startTour();
    await settle();
    expect(getStateValue(SEEN_KEY, false)).toBe(true);
    expect(tourOffered()).toBe(false);
    expect(getStateValue(COMPLETED_KEY, false)).toBe(false);
  });
});

// ── The words ────────────────────────────────────────────────────────────────────────────────

group("the words", () => {
  it("has eight steps, each with a title and one or two plain sentences (UX-205…213)", () => {
    expect(STEPS.map((s) => s.id)).toEqual(STEP_ORDER);
    expect(STEPS).toHaveLength(8);
    startTour();
    const texts = STEP_ORDER.map((id) => describe(id, tourWorld()));
    expect(texts.map((t) => t.title)).toEqual([
      "Add where customers arrive",
      "Add two stations",
      "Add where customers leave",
      "Link them in a line",
      "Set a service rate",
      "Solve the network",
      "Read the result",
      "Check with another method",
    ]);
    expect(texts[0].text).toBe("Choose Source in the Tools pane (or press O), then place it on empty canvas. A source is where customers enter the network.");
    expect(texts[4].text).toContain("Choose Pointer (or press V), select station S1, and in the Inspector set its Rate to 2, then press Return.");
    expect(texts[5].text).toBe("Press Solve (⌘↩). Qnet chooses the best method for this network and runs it.");
    // Device-neutral (FIX-107): every step can be done from the keyboard, so no sentence names the
    // pointer's verb, and none grew: each is at most as long as the sentence it replaces.
    const before = [133, 166, 120, 158, 220, 76];
    texts.slice(0, 6).forEach((t, i) => expect(t.text.length, t.text).toBeLessThanOrEqual(before[i]));
    const said = [...texts.map((t) => `${t.title} ${t.text} ${t.note ?? ""}`), w.steps.link.next("S1"), w.steps.check.text, w.steps.solve.menuHint("⌘↩"), w.steps.rate.tooSlow("S1", "2"), w.steps.read.waiting, w.steps.read.where].join(" ");
    expect(said).not.toMatch(/\bclick|\btap\b|\bmouse\b|\bdrag/i);
    // The tool is called what the Tools pane calls it.
    expect(texts[4].text).toContain(`Choose ${interactionWords.paletteLabel.select} `);
    expect(describe("solve", tourWorld(), false).note).toBe("Solve is in the Run menu: Run ▸ Solve, or ⌘↩.");
    expect(texts[6].text).toBe(w.steps.read.waiting);
    for (const t of texts) expect(t.text.length).toBeLessThan(330);
    expect(verdictWords(tourWorld())).toBe(w.finish.verdict.single);
  });
});

// ── Where the callout sits ───────────────────────────────────────────────────────────────────

group("the callout's place", () => {
  const size = { width: 340, height: 180 };
  const viewport = { width: 1200, height: 800 };

  it("stands on the preferred side when it fits, centred on the target, with its pointer on the target's centre (UX-217)", () => {
    const tool = { left: 10, top: 300, width: 80, height: 28 };
    const right = placeCallout(tool, size, viewport, "right");
    expect(right).toEqual({ side: "right", left: 10 + 80 + GAP, top: 314 - 90, arrow: 90 });
    const node = { left: 500, top: 200, width: 60, height: 60 };
    expect(placeCallout(node, size, viewport)).toEqual({ side: "bottom", left: 530 - 170, top: 260 + GAP, arrow: 170 });
  });

  it("takes another side when the preferred one has no room, and never leaves the window (UX-217)", () => {
    // A field at the right edge: no room to the right, so below; pushed back inside, pointer still on the field.
    const field = { left: 1100, top: 100, width: 80, height: 22 };
    const p = placeCallout(field, size, viewport, "right");
    expect(p.side).toBe("bottom");
    expect(p.left).toBe(viewport.width - size.width - MARGIN);
    expect(p.arrow).toBe(1140 - p.left);
    // A button at the bottom-left corner: above it, pointer held off the callout's corner.
    const low = { left: 0, top: 770, width: 20, height: 20 };
    const q = placeCallout(low, size, viewport);
    expect(q).toMatchObject({ side: "top", left: MARGIN, top: 770 - GAP - size.height, arrow: ARROW_INSET });
    // The Inspector's field prefers the left.
    expect(placeCallout(field, size, viewport, "left")).toMatchObject({ side: "left", left: 1100 - GAP - size.width });
    for (const target of [field, low, { left: -50, top: -50, width: 10, height: 10 }, { left: 5000, top: 5000, width: 10, height: 10 }]) {
      const r = placeCallout(target, size, viewport);
      expect(r.left).toBeGreaterThanOrEqual(MARGIN);
      expect(r.top).toBeGreaterThanOrEqual(MARGIN);
      expect(r.left + size.width).toBeLessThanOrEqual(viewport.width - MARGIN);
      expect(r.top + size.height).toBeLessThanOrEqual(viewport.height - MARGIN);
    }
  });

  it("while a network is drawn stays in the canvas and as near the step's tool as that allows, off the nodes (gap FIX-106)", () => {
    // The preview's own boxes at 1400 × 900: the Source tool, the canvas, the empty canvas's hint.
    const window_ = { width: 1400, height: 900 };
    const card = { width: 340, height: 167 };
    const tool = { left: 8, top: 171, width: 160, height: 26 };
    const canvas = { left: 177, top: 40, width: 902, height: 413 };
    const hint = { left: 435, top: 155, width: 370, height: 175 };
    // What it did: below the canvas, centred — some 300 px from the tool it is about.
    const before = placeCallout(canvas, card, window_);
    expect(before).toMatchObject({ side: "bottom", left: 458, top: 465 });
    expect(boxDistance({ ...before, ...card }, tool)).toBeGreaterThan(290);
    const p = placeNear(tool, canvas, card, window_, [], [hint]);
    const box = { left: p.left, top: p.top, ...card };
    // Just inside the canvas's edge, beside the tool, pointing at it.
    expect(p).toMatchObject({ side: "right", left: canvas.left + MARGIN });
    expect(p.arrow).toBe(tool.top + tool.height / 2 - p.top);
    expect(boxDistance(box, tool)).toBeLessThanOrEqual(GAP + MARGIN);
    // Wholly inside the canvas, and clear of the hint's words (it may clip the hint's margin).
    expect(box.left + card.width).toBeLessThanOrEqual(canvas.left + canvas.width - MARGIN);
    expect(box.top).toBeGreaterThanOrEqual(canvas.top + MARGIN);
    expect(box.top + card.height).toBeLessThanOrEqual(canvas.top + canvas.height - MARGIN);
    const words = { left: 447, top: 227, width: 346, height: 53 };
    expect(box.top + card.height <= words.top || box.left + card.width <= words.left).toBe(true);

    // A node where the callout would stand: it moves along the canvas's edge, still near the tool, and covers no node.
    const node = { left: 300, top: 150, width: 48, height: 48 };
    const moved = placeNear(tool, canvas, card, window_, [node]);
    const movedBox = { left: moved.left, top: moved.top, ...card };
    expect(boxDistance(movedBox, node)).toBeGreaterThan(0);
    expect(boxDistance(movedBox, tool)).toBeLessThan(120);
    expect(moved.left).toBe(canvas.left + MARGIN);
    // The tour's own row of nodes (boxes with their labels) and the taller card of step 2: under
    // the row at the canvas's edge, where it stays as the row grows; it runs a little past the
    // canvas's foot rather than stand where the next node goes.
    const tall = { width: 340, height: 206 };
    const row = [245, 320, 388, 470, 540].map((left) => ({ left, top: 160, width: 78, height: 97 }));
    const under = placeNear({ ...tool, top: 226 }, canvas, tall, window_, row.slice(0, 1));
    expect(under.left).toBe(canvas.left + MARGIN);
    expect(under.top).toBeGreaterThan(257);
    expect(under.top).toBeLessThanOrEqual(257 + GAP);
    expect(placeNear({ ...tool, top: 226 }, canvas, tall, window_, row)).toMatchObject({ left: under.left, top: under.top });
    expect(under.top + tall.height - (canvas.top + canvas.height)).toBeLessThan(40);
    // Nodes everywhere: sideways it never leaves the canvas, and it stands under it rather than on a node or the tool.
    const crowd = Array.from({ length: 40 }, (_, i) => ({ left: 190 + (i % 10) * 88, top: 60 + Math.floor(i / 10) * 100, width: 48, height: 48 }));
    const squeezed = placeNear(tool, canvas, card, window_, crowd);
    expect(squeezed.left).toBeGreaterThanOrEqual(canvas.left + MARGIN);
    expect(squeezed.left + card.width).toBeLessThanOrEqual(canvas.left + canvas.width - MARGIN);
    for (const n of crowd) expect(boxDistance({ left: squeezed.left, top: squeezed.top, ...card }, n)).toBeGreaterThan(0);
    expect(squeezed.top + card.height).toBeLessThanOrEqual(window_.height - MARGIN);
    // A target inside the region (a node to link from) is never covered either.
    const inner = { left: 600, top: 220, width: 48, height: 48 };
    const beside = placeNear(inner, canvas, card, window_);
    expect(boxDistance({ left: beside.left, top: beside.top, ...card }, inner)).toBe(GAP);
    expect(beside.arrow).not.toBeNull();
    // A canvas too small to hold the callout: the ordinary placement.
    expect(placeNear(tool, { left: 177, top: 40, width: 200, height: 100 }, card, window_)).toEqual(placeCallout(tool, card, window_));
  });

  it("the last card takes the bottom-right corner unless the Results header is there (gap FIX-106)", () => {
    const window_ = { width: 1400, height: 900 };
    const card = { width: 340, height: 300 };
    expect(placeCorner(card, window_)).toEqual(placeCallout(null, card, window_));
    // Results docked at the bottom, its header and view switcher across the window's width at y = 560:
    // a header the corner clears changes nothing…
    const header = { left: 0, top: 560, width: 1400, height: 29 };
    expect(placeCorner(card, window_, [{ ...header, top: 500 }])).toEqual(placeCorner(card, window_));
    // …and one the corner would lie across puts the card just above it (over the canvas).
    const clear = placeCorner(card, window_, [{ ...header, top: 620 }]);
    expect(clear).toEqual({ side: "corner", left: 1400 - 340 - MARGIN, top: 620 - GAP - 300, arrow: null });
    expect(boxDistance({ left: clear.left, top: clear.top, ...card }, { ...header, top: 620 })).toBe(GAP);
    // Results in a narrow column on the right: the bottom-left corner is free.
    const column = { left: 1080, top: 300, width: 320, height: 600 };
    expect(placeCorner(card, window_, [column])).toMatchObject({ left: MARGIN, top: 900 - 300 - MARGIN });
    // Covered wherever it goes: the corner that covers least.
    const everywhere = [{ left: 0, top: 0, width: 1400, height: 400 }, { left: 0, top: 400, width: 700, height: 500 }, { left: 700, top: 880, width: 700, height: 20 }];
    const least = placeCorner(card, window_, everywhere);
    const cover = (p: { left: number; top: number }) => everywhere.reduce((a, b) => a + Math.max(0, Math.min(p.left + 340, b.left + b.width) - Math.max(p.left, b.left)) * Math.max(0, Math.min(p.top + 300, b.top + b.height) - Math.max(p.top, b.top)), 0);
    for (const corner of [{ left: MARGIN, top: MARGIN }, { left: 1048, top: MARGIN }, { left: MARGIN, top: 588 }, { left: 1048, top: 588 }]) expect(cover(least)).toBeLessThanOrEqual(cover(corner));
  });

  it("sits inside the corner of a target too large to stand beside, and in the window's corner with no target (UX-217)", () => {
    const canvas = { left: 90, top: 40, width: 1000, height: 740 };
    expect(placeCallout(canvas, size, viewport)).toEqual({ side: "inside", left: 1090 - size.width - MARGIN, top: 780 - size.height - MARGIN, arrow: null });
    expect(placeCallout(null, size, viewport)).toEqual({ side: "corner", left: 1200 - 340 - MARGIN, top: 800 - 180 - MARGIN, arrow: null });
    // A window smaller than the callout: pinned to the margin rather than off the top-left.
    expect(placeCallout(null, size, { width: 300, height: 150 })).toMatchObject({ left: MARGIN, top: MARGIN });
  });

  it("rings the target, kept inside the window (UX-218)", () => {
    expect(ringBox({ left: 100, top: 100, width: 50, height: 20 }, viewport)).toEqual({ left: 96, top: 96, width: 58, height: 28 });
    expect(ringBox({ left: 0, top: 0, width: 1200, height: 800 }, viewport)).toEqual({ left: 2, top: 2, width: 1196, height: 796 });
    expect(ringBox({ left: 90, top: 40, width: 1000, height: 740 }, viewport, -3)).toEqual({ left: 93, top: 43, width: 994, height: 734 });
  });
});

// ── The callout: keyboard, live region, target ───────────────────────────────────────────────

/** jsdom has no layout: give the Tools pane's buttons a place, so the callout has something to stand beside. */
function layout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches("[data-tool]")) return new DOMRect(8, 100 + 30 * [...this.parentElement!.querySelectorAll("[data-tool]")].indexOf(this), 84, 26);
    if (this.matches("[data-pane='tools']")) return new DOMRect(0, 40, 100, 600);
    return new DOMRect(0, 0, 0, 0);
  });
}

group("the callout", () => {
  it("registers tour:start, in the Help menu as Guided Tour (UX-201)", async () => {
    render(<TourHost />);
    expect(specItem("tour:start", MENU_SPEC)).toMatchObject({ label: "Guided Tour" });
    expect(getCommand("tour:start")).toMatchObject({ title: "Guided Tour", group: "Help" });
    expect(callout()).toBeNull();
    await act(() => runCommand("tour:start"));
    expect(callout()).not.toBeNull();
    expect(tour.state.phase).toBe("running");
  });

  it("is a labelled region beside its target, not a dialog; it takes the keyboard and shows the step and its place (UX-217…220)", async () => {
    layout();
    render(
      <>
        <ToolsPane />
        <TourHost />
      </>,
    );
    await act(() => runCommand("tour:start"));
    await settle();
    const c = callout()!;
    expect(c).toHaveAttribute("role", "region");
    expect(c).toHaveAccessibleName("Guided tour");
    expect(c).not.toHaveAttribute("aria-modal");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(c);
    expect(c).toHaveTextContent("1 of 8");
    expect(screen.getByRole("heading", { name: "Add where customers arrive" })).toBeInTheDocument();
    // Beside the Source tool, with the ring round it.
    const source = document.querySelector('[data-tool="addSource"]')!.getBoundingClientRect();
    expect(c).toHaveAttribute("data-side", "right");
    expect(c.style.left).toBe(`${source.right + GAP}px`);
    const ring = document.querySelector<HTMLElement>("[data-tour-ring]")!;
    expect(ring.style.left).toBe(`${source.left - 4}px`);
    expect(ring.style.width).toBe(`${source.width + 8}px`);
    expect(ring).toHaveAttribute("aria-hidden", "true");
    // Every control is a button with a name, reachable by Tab; Back has nowhere to go on step one.
    expect([...c.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["End Tour", "Back", "Skip", "Show Me"]);
    expect(button("back")).toBeDisabled();
    for (const b of c.querySelectorAll("button")) expect(b.tabIndex).toBe(0);
  });

  it("follows its target: the ring moves to the next tool, and to nothing when the window has no such control (UX-218)", async () => {
    layout();
    render(
      <>
        <ToolsPane />
        <TourHost />
      </>,
    );
    await act(() => runCommand("tour:start"));
    await act(() => tour.showMe());
    await settle(250);
    expect(tour.step!.id).toBe("stations");
    const buffer = document.querySelector('[data-tool="addBuffer"]')!.getBoundingClientRect();
    expect(document.querySelector<HTMLElement>("[data-tour-ring]")!.style.top).toBe(`${buffer.top - 4}px`);
    // The window was resized: the same tick places it again.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.matches("[data-tool='addBuffer']") ? new DOMRect(8, 400, 84, 26) : new DOMRect(0, 0, 0, 0);
    });
    await act(async () => void window.dispatchEvent(new Event("resize")));
    expect(document.querySelector<HTMLElement>("[data-tour-ring]")!.style.top).toBe("396px");
    // Solve has no toolbar button here: no ring, the callout in the corner, and the menu named instead.
    act(() => {
      tour.next();
      tour.next();
      tour.next();
      tour.next();
    });
    await settle(250);
    expect(tour.step!.id).toBe("solve");
    expect(document.querySelector("[data-tour-ring]")).toBeNull();
    expect(callout()).toHaveAttribute("data-side", "corner");
    expect(callout()).toHaveTextContent("Solve is in the Run menu: Run ▸ Solve, or ⌘↩.");
  });

  it("stays by the canvas while a network is drawn: the ring goes to the tool, the callout does not lie over the nodes (UX-217)", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.matches("[data-tool='addSource']")) return new DOMRect(8, 130, 84, 26);
      if (this.matches("[data-pane='canvas']")) return new DOMRect(100, 40, 600, 300);
      return new DOMRect(0, 0, 0, 0);
    });
    render(
      <>
        <ToolsPane />
        <section data-pane="canvas" />
        <TourHost />
      </>,
    );
    await act(() => runCommand("tour:start"));
    await settle();
    expect(document.querySelector<HTMLElement>("[data-tour-ring]")!.style.top).toBe("126px");
    // Inside the canvas's edge, level with the tool and pointing at it (gap FIX-106: it stood
    // below the canvas, centred, some 300 px from the tool).
    const c = callout()!;
    expect(c).toHaveAttribute("data-side", "right");
    expect([c.style.left, c.style.top]).toEqual([`${100 + MARGIN}px`, `${40 + MARGIN}px`]);
    expect(c.querySelector(".tour-arrow")).not.toBeNull();
    // The tool chosen, the canvas is ringed: the callout has not moved, and points at nothing.
    act(() => editorFor(tourTabId()!).setTool("addSource"));
    await settle();
    expect(document.querySelector<HTMLElement>("[data-tour-ring]")!.style.top).toBe("36px");
    expect([callout()!.style.left, callout()!.style.top]).toEqual([`${100 + MARGIN}px`, `${40 + MARGIN}px`]);
    expect(callout()!.querySelector(".tour-arrow")).toBeNull();
  });

  it("reads each step out through the polite live region (UX-221)", async () => {
    render(<TourHost />);
    await act(() => runCommand("tour:start"));
    await settle(60);
    const live = document.querySelector('[data-announce="polite"]')!;
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live.textContent).toBe(`Guided tour, step 1 of 8. Add where customers arrive. ${describe("source", tourWorld()).text}`);
    act(() => tour.next());
    await settle(60);
    expect(live.textContent).toMatch(/^Guided tour, step 2 of 8\. Add two stations\. .* 0 of 4 placed\.$/);
    act(() => endTour());
    await settle(60);
    expect(live.textContent).toBe("The tour has ended. Help ▸ Guided Tour starts it again.");
  });

  it("Back, Skip and End work from the keyboard's buttons and from the palette's commands (UX-219)", async () => {
    render(<TourHost />);
    await act(() => runCommand("tour:start"));
    fireEvent.click(button("next"));
    expect(callout()).toHaveTextContent("2 of 8");
    fireEvent.click(button("back"));
    expect(callout()).toHaveTextContent("1 of 8");
    await act(() => runCommand("tour:next"));
    await act(() => runCommand("tour:next"));
    expect(tour.step!.id).toBe("sink");
    await act(() => runCommand("tour:back"));
    expect(tour.step!.id).toBe("stations");
    (document.body as HTMLElement).focus();
    await act(() => runCommand("tour:focus"));
    expect(document.activeElement).toBe(callout());
    await act(() => runCommand("tour:end"));
    expect(callout()).toBeNull();
    expect(getCommand("tour:next")!.when!()).toBe("The tour has ended. Help ▸ Guided Tour starts it again.");
  });

  it("Escape ends the tour — but a field, a tool in hand and a selection keep the key (UX-222)", async () => {
    render(
      <>
        <input aria-label="A field" />
        <TourHost />
      </>,
    );
    await act(() => runCommand("tour:start"));
    const id = tourTabId()!;
    fireEvent.keyDown(screen.getByLabelText("A field"), { key: "Escape" });
    expect(callout()).not.toBeNull();
    act(() => editorFor(id).setTool("addSource"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(callout()).not.toBeNull();
    // From the callout itself, always.
    fireEvent.keyDown(button("next"), { key: "Escape" });
    expect(callout()).toBeNull();
    await act(() => runCommand("tour:start"));
    // A selection is Escape's to drop first; with nothing in hand, Escape ends the tour.
    act(() => void editorFor(id).addNode("source", { x: 100, y: 100 }));
    act(() => editorFor(id).setTool("select"));
    expect(editorFor(id).hasAnySelection).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(callout()).not.toBeNull();
    act(() => editorFor(id).deselectAll());
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(callout()).toBeNull();
  });

  it("says so when the student looks at another tab, and ends when its tab is closed (UX-223)", async () => {
    const mine = activeTab().id;
    render(<TourHost />);
    await act(() => runCommand("tour:start"));
    const id = tourTabId()!;
    act(() => selectTab(mine));
    expect(screen.getByRole("heading", { name: "The tour is in another tab" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to the Tour's Tab" }));
    expect(activeTab().id).toBe(id);
    expect(callout()).toHaveTextContent("1 of 8");
    const { removeTabs } = await import("../workspace/store");
    act(() => removeTabs([id]));
    await settle();
    expect(callout()).toBeNull();
    expect(tour.state.phase).toBe("idle");
  });
});

// ── The whole tour ───────────────────────────────────────────────────────────────────────────

group("the whole tour in the app", () => {
  it("is completed with Show Me for every step and ends with a result that two methods report (UX-224)", async () => {
    render(<App />);
    await settle();
    const mine = activeTab();
    await act(() => runCommand("tour:start"));
    const id = tourTabId()!;
    expect(id).not.toBe(mine.id);

    const order: string[] = [];
    for (let guard = 0; tour.state.phase === "running" && guard < 12; guard++) {
      const step = tour.step!;
      order.push(step.id);
      expect(callout()).toHaveTextContent(`${STEP_ORDER.indexOf(step.id as (typeof STEP_ORDER)[number]) + 1} of 8`);
      await act(async () => void fireEvent.click(button("show-me")));
      await waitFor(() => expect(tour.state.working).toBe(false), { timeout: 10000 });
      if (step.id === "read") {
        // A step to read: the result is there, in words, and Next goes on.
        expect(callout()).toHaveTextContent("S2 is the busiest station: its server is working 90 % of the time (its utilisation), and on average 9.00 customers are there, waiting or being served.");
        expect(callout()).toHaveTextContent(w.steps.read.sure.exact);
        fireEvent.click(button("next"));
      }
    }
    expect(order).toEqual(STEP_ORDER);
    expect(tour.state.phase).toBe("finished");

    // The network is the student's own tab's business: untouched. The tour's has the line and two runs.
    expect(getWorkspace().tabs.find((t) => t.id === mine.id)!.document).toBe(mine.document);
    const world = tourWorld();
    expect(world.doc.nodes.map((n) => n.kind)).toEqual(["source", "buffer", "station", "buffer", "station", "sink"]);
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["product_form", "inf_sim"]);
    expect(world.runs.map((r) => r.method.shortName)).toEqual(["Product Form", "Monte Carlo"]);
    // S1 was set to μ = 2 against λ = 1: half busy. S2 kept the rate it was born with.
    const utilisation = Object.fromEntries(world.runs[0].measurements.filter((m) => m.metric === "Server utilization").map((m) => [m.stationName, m.estimate]));
    expect(utilisation.S1).toBeCloseTo(0.5, 6);
    expect(utilisation.S2).toBeCloseTo(0.9, 6);
    // The tour's network is one View ▸ Animate plays: infinite buffers, every station stable.
    const engine = new AnimationEngine();
    await act(async () => void (await engine.start(world.doc, 1, { play: false })));
    expect([engine.phase, engine.message, engine.layout?.unstable]).toEqual(["running", "", []]);
    engine.dispose();

    // The Results pane shows it, and the finish card says what the comparison means and what to try next.
    expect(await screen.findByRole("heading", { name: "Exact result available — Product Form solves this network exactly." })).toBeInTheDocument();
    expect(document.querySelector(".agr-banner")).toHaveAttribute("data-verdict", "exact");
    const c = callout()!;
    expect(c).toHaveAttribute("data-step", "finished");
    expect(c).toHaveTextContent("Your first model is built and checked");
    expect(verdictWords(world)).toBe(w.finish.withExact.close);
    expect(c).toHaveTextContent(verdictWords(world));
    expect(c).toHaveTextContent(w.finish.meaning);
    expect([...c.querySelectorAll(".tour-next strong")].map((x) => x.textContent)).toEqual(["What-If Sweep", "Open an Example", "Method Chooser"]);
    for (const next of ["run:what-if-sweep", "file:open-example", "run:choose-method"]) expect(getCommand(next), next).toBeDefined();
    await waitFor(() => expect(getStateValue(COMPLETED_KEY, false)).toBe(true));

    // Finish closes it; started again, it is a fresh tab.
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(callout()).toBeNull();
    await act(() => runCommand("tour:start"));
    expect(tourTabId()).not.toBe(id);
    expect(tour.step!.id).toBe("source");
  }, 30000);
});
