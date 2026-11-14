// Animation of a simulation on the canvas (ROADMAP Phase E): the playback clock, the bookkeeping
// of who is where (held to the simulator's own totals through a fixture Rust records and checks:
// src-tauri/src/animate.rs `the_interface_fixture_is_what_the_commands_answer`), the picture
// with and without motion, the engine against the preview's stand-in, and the layer on the
// canvas: its controls, its clean-up, and that nothing it does reaches the run records.
//
// The simulation's correctness is checked in Rust (core/src/sim.rs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CanvasView } from "../canvas/CanvasView";
import { example, sceneOf } from "../canvas/layers/testkit";
import { CanvasStatusBar } from "../canvas/StatusBar";
import { defaultHandlers } from "../dev/mockBackend";
import { FINITE_SENTENCE, mockAnimate } from "../dev/mock/animate";
import { editorFor } from "../editor";
import { emptyDocument, type BnetDocument } from "../lib/bnet";
import { getCommand, runCommand } from "../lib/commands";
import { loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC } from "../lib/menuSpec";
import { resetRuns, resultsFor } from "../runs/state";
import { mockCalls, mockTauri } from "../test/tauri";
import { addTab, setDocument } from "../workspace/store";
import { MAX_FRAME_MS, naturalPace, PlaybackClock, SPEEDS } from "./clock";
import { ANIMATE_COMMAND } from "./commands";
import { AnimationEngine, FETCH_SECONDS, SKIP_COMPLETIONS, WINDOW_SECONDS } from "./engine";
import { AnimState, ARRIVE, DEPART, EventBuffer, Fifo, LEAVE, ROUTE, START, type AnimateChunk, type AnimateEvents, type AnimateStart } from "./model";
import { along, geometry, QUEUE_VISIBLE, seriesOf, SHAPE_PATHS, shapeOf, shapePath, SHAPES, Stage, STEP_MS, TRAVEL_MS, type Palette, type Pen } from "./render";
import { animateOn, engineFor, resetAnimate, setAnimate } from "./store";
import { stripGeometry } from "./StripChart";
import { animateWords as w } from "./words";
import fixtureJson from "./fixtures/jackson-feedback.json";

const fixture = fixtureJson as unknown as { start: AnimateStart; chunks: AnimateChunk[] };
const JACKSON = "OpenJackson.d2.feedback.p30.inf.bnet";
const TIMEOUT = { timeout: 8000 };

/** A recorder standing in for the 2D context. */
function recorder() {
  const calls: { op: string; args: unknown[] }[] = [];
  const op =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push({ op: name, args });
  const pen = {
    beginPath: op("beginPath"),
    arc: op("arc"),
    rect: op("rect"),
    moveTo: op("moveTo"),
    lineTo: op("lineTo"),
    closePath: op("closePath"),
    fill: op("fill"),
    stroke: op("stroke"),
    fillText: op("fillText"),
    clearRect: op("clearRect"),
    setTransform: op("setTransform"),
    roundRect: op("roundRect"),
    measureText: (s: string) => ({ width: s.length * 6 }) as TextMetrics,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "middle",
    globalAlpha: 1,
  } as unknown as Pen;
  return { pen, calls, texts: () => calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0])) };
}

const PALETTE: Palette = { series: ["", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"], text: "text", muted: "muted", panel: "panel", line: "line" };
const SIZE = { width: 1600, height: 1000 };

const playAll = (state: AnimState, e: AnimateEvents) => {
  for (let n = 0; n < e.t.length; n++) state.apply(e, n);
};

// ── The clock ────────────────────────────────────────────────────────────────────────────────

describe("the playback clock", () => {
  it("runs at the speed chosen, in the network's own time units", () => {
    // 2 completions a second at 1×: a network completing 4 per time unit plays 0.5 units a second.
    expect(naturalPace(4)).toBe(0.5);
    expect(naturalPace(0)).toBe(1);
    expect(naturalPace(Infinity)).toBe(1);
    const c = new PlaybackClock(0.5);
    c.playing = true;
    for (let i = 0; i < 10; i++) c.advance(100, Infinity);
    expect(c.time).toBeCloseTo(0.5, 12);
    c.setSpeed(4);
    for (let i = 0; i < 10; i++) c.advance(100, Infinity);
    expect(c.time).toBeCloseTo(0.5 + 2, 12);
    c.setSpeed(0.25);
    c.advance(100, Infinity);
    expect(c.time).toBeCloseTo(2.5 + 0.0125, 12);
  });

  it("stands still while paused, and never passes the horizon", () => {
    const c = new PlaybackClock(1);
    c.advance(100, Infinity);
    expect(c.time).toBe(0);
    c.playing = true;
    c.advance(100, 0.04);
    expect(c.time).toBe(0.04);
    expect(c.waiting).toBe(true);
    c.advance(100, 10);
    expect(c.time).toBeCloseTo(0.14, 12);
    expect(c.waiting).toBe(false);
    // A horizon behind the clock (after a skip was adopted) never turns time back.
    c.advance(100, 0.01);
    expect(c.time).toBeCloseTo(0.14, 12);
  });

  it("plays a stalled frame as a short one, skips by a jump, and steps along the ladder", () => {
    const c = new PlaybackClock(1);
    c.playing = true;
    c.advance(5000, Infinity);
    expect(c.time).toBeCloseTo(MAX_FRAME_MS / 1000, 12);
    c.jump(500);
    expect(c.time).toBe(500);
    expect(SPEEDS[0]).toBe(0.25);
    expect(SPEEDS[SPEEDS.length - 1]).toBe(64);
    c.step(1);
    expect(c.speed).toBe(2);
    c.step(-1);
    c.step(-1);
    expect(c.speed).toBe(0.5);
    for (let i = 0; i < 20; i++) c.step(1);
    expect(c.speed).toBe(64);
    c.setSpeed(1000);
    expect(c.speed).toBe(64);
    c.setSpeed(0);
    expect(c.speed).toBe(0.25);
  });
});

// ── The bookkeeping ──────────────────────────────────────────────────────────────────────────

describe("who is where, from the events", () => {
  it("replays the recorded run without a fault, and its totals are the simulator's own", () => {
    const state = new AnimState(fixture.start.layout, fixture.start.snapshot, 30);
    expect(fixture.chunks[0].events.t.length).toBeGreaterThan(200);
    for (const chunk of fixture.chunks) {
      playAll(state, chunk.events);
      expect(state.faults).toBe(0);
      const s = chunk.stats;
      expect(state.created).toBe(s.created);
      expect(state.left).toBe(s.left);
      fixture.start.layout.stations.forEach((_, i) => {
        // ∫ N dt, kept here event by event, against the simulator's (Rust) at the chunk's end.
        expect(state.area(i, s.time)).toBeCloseTo(s.areaNumber[i], 8);
        expect(state.number(i)).toBe(s.arrivals[i] - s.departures[i]);
        expect(state.average(i, s.time)!).toBeCloseTo(s.areaNumber[i] / s.time, 10);
        // A station with someone waiting has every server busy.
        expect(state.waiting(i) === 0 || state.stations[i].busy === state.stations[i].servers.length).toBe(true);
      });
      expect(state.total()).toBe(s.created - s.left);
    }
    expect(state.average(0, 0)).toBeNull();
  });

  it("no customer is in two places, and the queue is served in order", () => {
    const state = new AnimState(fixture.start.layout, fixture.start.snapshot, 30);
    const e = fixture.chunks[0].events;
    for (let n = 0; n < e.t.length; n++) {
      const head = e.k[n] === START ? state.stations[e.s[n]].queue.at(0)?.id : undefined;
      state.apply(e, n);
      if (e.k[n] === START) expect(head).toBe(e.c[n]);
      if (n % 25 === 0) {
        const seen = new Set<number>();
        state.stations.forEach((st, i) => {
          for (let k = 0; k < st.queue.length; k++) {
            const tk = st.queue.at(k)!;
            expect(seen.has(tk.id)).toBe(false);
            seen.add(tk.id);
            expect([tk.station, tk.server]).toEqual([i, -1]);
          }
          st.servers.forEach((tk, k) => {
            if (!tk) return;
            expect(seen.has(tk.id)).toBe(false);
            seen.add(tk.id);
            expect([tk.station, tk.server]).toEqual([i, k]);
          });
        });
      }
    }
    expect(state.faults).toBe(0);
  });

  it("notes each move with where it came from, for the picture", () => {
    const layout = fixture.start.layout;
    const state = new AnimState(layout, fixture.start.snapshot, 30);
    const e = fixture.chunks[0].events;
    const kinds = new Map<number, string>();
    for (let n = 0; n < e.t.length; n++) {
      state.moved.length = 0;
      const before = state.leaving.length;
      state.apply(e, n);
      const tk = state.moved[0];
      if (e.k[n] === ARRIVE) {
        expect(tk.travel).toEqual({ kind: "arrive", from: layout.sources[0].id, to: layout.stations[e.s[n]].bufferId, viaClass: 0 });
        kinds.set(ARRIVE, "arrive");
      } else if (e.k[n] === ROUTE) {
        expect(tk.travel).toMatchObject({ kind: "route", from: layout.stations[e.s[n]].id, to: layout.stations[e.o[n]].bufferId });
        kinds.set(ROUTE, "route");
      } else if (e.k[n] === LEAVE) {
        expect(tk.travel).toMatchObject({ kind: "leave", from: layout.stations[e.s[n]].id, to: layout.sinks[0] });
        expect(state.leaving.length).toBe(before + 1);
        expect(tk.station).toBe(-1);
        kinds.set(LEAVE, "leave");
      } else if (e.k[n] === DEPART) expect(state.moved.length).toBe(0);
      // The renderer picks the move up.
      for (const m of state.moved) m.travel = null;
    }
    expect([...kinds.keys()].sort()).toEqual([ARRIVE, ROUTE, LEAVE]);
  });

  it("an event that does not fit is counted, not applied", () => {
    const state = new AnimState(fixture.start.layout, fixture.start.snapshot, 30);
    const bad: AnimateEvents = { t: [1, 2, 3], k: [START, DEPART, 9], c: [5, 5, 5], cls: [0, 0, 0], s: [0, 0, 0], srv: [0, 0, -1], o: [-1, -1, -1] };
    playAll(state, bad);
    expect(state.faults).toBe(3);
    expect(state.total()).toBe(0);
  });

  it("plays buffered events up to a time, across chunks", () => {
    const state = new AnimState(fixture.start.layout, fixture.start.snapshot, 30);
    const buffer = new EventBuffer();
    fixture.chunks.forEach((c) => buffer.push(c.events));
    const all = fixture.chunks.flatMap((c) => c.events.t);
    expect(buffer.pending).toBe(all.length);
    const mid = all[100];
    const expected = all.filter((t) => t <= mid).length;
    expect(buffer.playInto(state, mid)).toBe(expected);
    expect(state.time).toBe(mid);
    expect(buffer.playInto(state, mid)).toBe(0);
    expect(buffer.playInto(state, Infinity)).toBe(all.length - expected);
    expect(buffer.pending).toBe(0);
    expect(state.faults).toBe(0);
    buffer.push(fixture.chunks[0].events);
    buffer.clear();
    expect(buffer.pending).toBe(0);
  });

  it("adopts a snapshot and the simulator's totals after a skip", () => {
    const state = new AnimState(fixture.start.layout, fixture.start.snapshot, 30);
    playAll(state, fixture.chunks[0].events);
    const stats = { time: 900, areaNumber: [1800, 2700], areaQueue: [900, 1800], arrivals: [1200, 900], departures: [1197, 899], created: 900, left: 896 };
    state.adopt({ time: 900, queues: [[[70, 0], [71, 0]], []], servers: [[[69, 0]], [[68, 0]]] }, stats);
    expect([state.number(0), state.number(1), state.total()]).toEqual([3, 1, 4]);
    expect(state.average(0, 900)).toBeCloseTo(2, 12);
    expect(state.average(1, 1000)).toBeCloseTo((2700 + 100) / 1000, 12);
    expect(state.stations[0].history).toEqual([900, 3]);
    expect([state.created, state.left, state.moved.length, state.leaving.length]).toEqual([900, 896, 0, 0]);
  });

  // Ledger WF-508: after a skip an unstable network's queue arrives as its head and a count.
  it("a queue cut to its head keeps its length, and is served in order through the part known only by number", () => {
    const state = new AnimState(fixture.start.layout, fixture.start.snapshot, 30);
    const stats = { time: 900, areaNumber: [0, 0], areaQueue: [0, 0], arrivals: [0, 0], departures: [0, 0], created: 1_000_004, left: 0 };
    state.adopt({ time: 900, queues: [[[70, 0], [71, 0]], []], waiting: [1_000_002, 0], servers: [[[69, 0]], [null]] }, stats);
    expect([state.waiting(0), state.number(0), state.total()]).toEqual([1_000_002, 1_000_003, 1_000_003]);
    const q = state.stations[0].queue;
    expect([q.at(0)?.id, q.at(1)?.id, q.at(2), q.at(999_999)]).toEqual([70, 71, undefined, undefined]);
    // An arrival joins behind everyone.
    const ev = (t: number, k: number, c: number, s: number, srv: number, o: number) => ({ t: [t], k: [k], c: [c], cls: [0], s: [s], srv: [srv], o: [o] });
    state.apply(ev(901, 0, 5_000_000, 0, -1, 0), 0);
    expect([state.waiting(0), q.at(1_000_002)?.id]).toEqual([1_000_003, 5_000_000]);
    // The server frees and takes the named head, then the next named, then customers the snapshot did not name.
    const serve = (t: number, leaving: number, next: number) => {
      state.apply(ev(t, 2, leaving, 0, 0, -1), 0);
      state.apply(ev(t, 4, leaving, 0, -1, 0), 0);
      state.apply(ev(t, 1, next, 0, 0, -1), 0);
    };
    serve(902, 69, 70);
    serve(903, 70, 71);
    expect(q.headUnnamed).toBe(true);
    serve(904, 71, 123_456);
    serve(905, 123_456, 123_457);
    expect(state.faults).toBe(0);
    expect(state.stations[0].servers[0]?.id).toBe(123_457);
    expect(state.waiting(0)).toBe(1_000_003 - 4);
    expect(q.at(0)).toBeUndefined();
    // A named head that is not the customer the event starts is still a fault.
    const other = new AnimState(fixture.start.layout, fixture.start.snapshot, 30);
    other.adopt({ time: 900, queues: [[[70, 0]], []], waiting: [9, 0], servers: [[null], [null]] }, stats);
    other.apply(ev(901, 1, 99, 0, 0, -1), 0);
    expect(other.faults).toBe(1);

    const f = new Fifo<number>();
    f.push(1);
    f.push(2);
    f.gap(3);
    f.push(9);
    expect([f.length, f.at(0), f.at(1), f.at(2), f.at(4), f.at(5), f.indexOf(9, 6), f.indexOf(9, 5)]).toEqual([6, 1, 2, undefined, undefined, 9, 5, -1]);
    expect([f.shift(), f.shift(), f.headUnnamed, f.shift(), f.shift(), f.shift(), f.headUnnamed, f.shift(), f.length]).toEqual([1, 2, true, undefined, undefined, undefined, false, 9, 0]);
  });

  it("keeps a window of history, and a very long queue costs nothing to serve", () => {
    const state = new AnimState(fixture.start.layout, fixture.start.snapshot, 2);
    for (const c of fixture.chunks) playAll(state, c.events);
    const h = state.stations[0].history;
    // Trimmed in blocks: at most one point before the window, or a short list.
    expect(h.length <= 64 || h[2] > state.time - 2 || h[0] <= state.time - 2).toBe(true);
    expect(h.length).toBeLessThan(fixture.chunks.reduce((n, c) => n + c.events.t.length, 0));
    const q = new Fifo<number>();
    for (let i = 0; i < 5000; i++) q.push(i);
    for (let i = 0; i < 4000; i++) expect(q.shift()).toBe(i);
    expect([q.length, q.at(0), q.at(999), q.indexOf(4003, 8), q.indexOf(4500, 8)]).toEqual([1000, 4000, 4999, 3, -1]);
  });
});

// ── The picture ──────────────────────────────────────────────────────────────────────────────

describe("the picture", () => {
  const doc = example(JACKSON);
  const scene = sceneOf(doc);
  const layout = fixture.start.layout;

  it("puts each queue by its buffer and each server by its station", () => {
    const g = geometry(scene, layout);
    layout.stations.forEach((s, i) => {
      const sg = g.stations[i]!;
      const c = scene.displayCentres.get(s.id)!;
      const b = scene.displayCentres.get(s.bufferId)!;
      expect(sg.serverSlots).toHaveLength(Math.min(s.servers, 6));
      expect(sg.serverSlots[0].y).toBeLessThan(c.y - 24);
      expect(sg.queueSlots).toHaveLength(QUEUE_VISIBLE);
      // The head of the queue is on the buffer's station side, and the row runs away from it.
      expect(Math.sign(sg.queueSlots[0].x - sg.queueSlots[1].x)).toBe(sg.direction);
      expect(Math.abs(sg.queueSlots[0].x - b.x)).toBeLessThan(30);
      expect(sg.queueSlots[0].y).toBeLessThan(b.y - 22);
    });
    // The picture follows the camera.
    const zoomed = geometry(sceneOf(doc, 2, [100, 50]), layout);
    expect(zoomed.stations[0]!.centre.x).not.toBe(g.stations[0]!.centre.x);
    expect(zoomed.r).toBeGreaterThan(g.r);
  });

  it("gives each class a colour and a shape", () => {
    expect([0, 1, 2, 3, 4].map(shapeOf)).toEqual(["circle", "square", "triangle", "diamond", "plus"]);
    // Eight shapes, as many as class colours: the first eight classes differ by shape alone (FIX-108).
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map(shapeOf)).size).toBe(8);
    expect([8, -1].map(shapeOf)).toEqual(["circle", "bar"]);
    expect(SHAPES).toHaveLength(8);
    // Each has an outline of its own, on the canvas and in the bar's key.
    expect(new Set(SHAPES.map((s) => SHAPE_PATHS[s])).size).toBe(8);
    const drawn = SHAPES.map((shape) => {
      const { pen, calls } = recorder();
      shapePath(pen, shape, 0, 0, 5);
      expect(calls[0].op).toBe("beginPath");
      return JSON.stringify(calls);
    });
    expect(new Set(drawn).size).toBe(8);
    expect([0, 1, 7, 8].map(seriesOf)).toEqual([1, 2, 8, 1]);
    expect(along([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.75)).toEqual({ x: 10, y: 5 });
    expect(along([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2)).toEqual({ x: 10, y: 0 });
  });

  it("draws customers travelling along the links, then standing in their places", () => {
    const state = new AnimState(layout, fixture.start.snapshot, 30);
    const stage = new Stage();
    const e = fixture.chunks[0].events;
    // The first arrival: it travels from the source, already bound for the free server.
    state.apply(e, 0);
    state.apply(e, 1);
    expect([e.k[0], e.k[1]]).toEqual([ARRIVE, START]);
    stage.pickUp(state, 1000, 1);
    expect(stage.movers).toHaveLength(1);
    const r1 = recorder();
    expect(stage.draw(r1.pen, state, scene, PALETTE, 1000 + TRAVEL_MS / 2, SIZE)).toEqual({ resting: 0, moving: 1 });
    const tk = stage.movers[0].token;
    const source = scene.nodeIndex.get(layout.sources[0].id)!;
    const s1 = scene.nodeIndex.get(layout.stations[0].id)!;
    // Half-way, it is between the source and the station.
    expect(tk.x).toBeGreaterThan(Math.min(source.position[0], s1.position[0]));
    expect(tk.x).toBeLessThan(Math.max(source.position[0], s1.position[0]));
    // Arrived: it stands in the server's place, drawn at rest.
    const r2 = recorder();
    expect(stage.draw(r2.pen, state, scene, PALETTE, 1000 + TRAVEL_MS + 1, SIZE)).toEqual({ resting: 1, moving: 0 });
    expect(stage.busy).toBe(false);
    const g = geometry(scene, layout);
    const r3 = recorder();
    expect(stage.draw(r3.pen, state, scene, PALETTE, 3000, SIZE)).toEqual({ resting: 1, moving: 0 });
    expect(scene.transform.scale * tk.x + scene.transform.pan.width).toBeCloseTo(g.stations[0]!.serverSlots[0].x, 6);
    // Every station carries its live count.
    expect(r3.texts()).toEqual(["1", "0"]);
  });

  it("shows a long queue as its first customers and a count", () => {
    const state = new AnimState(layout, { time: 0, queues: [Array.from({ length: 20 }, (_, i) => [i + 1, 0] as [number, number]), []], servers: [[[0, 0]], [null]] }, 30);
    const stage = new Stage();
    const r = recorder();
    expect(stage.draw(r.pen, state, scene, PALETTE, 0, SIZE)).toEqual({ resting: 1 + QUEUE_VISIBLE, moving: 0 });
    expect(r.texts()).toEqual([`+${20 - QUEUE_VISIBLE}`, "21", "0"]);
  });

  it("with Reduce Motion nothing travels: customers stand where they are", () => {
    const state = new AnimState(layout, fixture.start.snapshot, 30);
    const stage = new Stage();
    stage.reduced = true;
    const e = fixture.chunks[0].events;
    for (let n = 0; n < e.t.length; n++) {
      state.apply(e, n);
      if (n % 10 === 0) {
        stage.pickUp(state, n * 16, 1);
        expect(stage.movers).toHaveLength(0);
        expect(state.leaving).toHaveLength(0);
        const r = recorder();
        const counts = stage.draw(r.pen, state, scene, PALETTE, n * 16, SIZE);
        expect(counts.moving).toBe(0);
        const expected = state.stations.reduce((sum, st) => sum + st.busy + Math.min(st.queue.length, QUEUE_VISIBLE), 0);
        expect(counts.resting).toBe(expected);
        // At rest a token is exactly in its place: no easing.
        const st = state.stations[0];
        const first = st.servers[0];
        if (first) expect(scene.transform.scale * first.x + scene.transform.pan.width).toBeCloseTo(geometry(scene, layout).stations[0]!.serverSlots[0].x, 6);
      }
    }
    expect(STEP_MS).toBeGreaterThanOrEqual(250);
  });

  it("a frame with 400 moving tokens is laid out in well under a frame's time", () => {
    const n = 400;
    const state = new AnimState(layout, { time: 0, queues: [Array.from({ length: n }, (_, i) => [i, i % 3] as [number, number]), []], servers: [[null], [null]] }, 30);
    const stage = new Stage();
    for (let k = 0; k < n; k++) {
      const tk = state.stations[0].queue.at(k)!;
      tk.travel = { kind: "arrive", from: layout.sources[0].id, to: layout.stations[0].bufferId, viaClass: 0 };
      state.moved.push(tk);
    }
    stage.pickUp(state, 0, 1);
    expect(stage.movers).toHaveLength(n);
    const r = recorder();
    const frames = 60;
    const t0 = performance.now();
    let moving = 0;
    for (let f = 0; f < frames; f++) moving = stage.draw(r.pen, state, scene, PALETTE, (f * (TRAVEL_MS - 20)) / frames, SIZE).moving;
    const perFrame = (performance.now() - t0) / frames;
    expect(moving).toBe(n);
    // 16.7 ms is a frame at 60 a second; the layout must leave nearly all of it to the painting.
    // (About 0.3 ms here; the bound is loose because the test machine is shared.)
    expect(perFrame).toBeLessThan(8);
  });

  it("charts the count as steps, with the exact mean as a line", () => {
    const g = stripGeometry([0, 0, 10, 1, 20, 2, 30, 1], 40, 40, 2.5);
    expect(g.max).toBe(4);
    expect(g.exactY).not.toBeNull();
    expect(g.path.startsWith("M18 ")).toBe(true);
    expect((g.path.match(/V/g) ?? []).length).toBe(3);
    // Only the window is drawn, starting from the value in force at its start.
    const late = stripGeometry([0, 0, 10, 1, 20, 2, 30, 7], 40, 15, null);
    expect(late.max).toBe(7);
    expect(late.exactY).toBeNull();
    expect((late.path.match(/V/g) ?? []).length).toBe(1);
    expect(stripGeometry([], 5, 10, null).path).toBe("");
  });
});

// ── The engine, against the preview's stand-in ───────────────────────────────────────────────

describe("a run", () => {
  beforeEach(() => {
    mockTauri(defaultHandlers());
  });

  const started = async (doc: BnetDocument, seed = 5) => {
    const engine = new AnimationEngine();
    await engine.start(doc, seed, { play: true });
    await waitFor(() => expect(engine.horizon).toBeGreaterThan(0), TIMEOUT);
    return engine;
  };

  /** Frames 16 ms apart, letting each request settle. */
  const frames = async (engine: AnimationEngine, count: number, from: number) => {
    for (let i = 0; i < count; i++) {
      engine.frame(from + i * 16);
      if (i % 10 === 0) await act(async () => void (await Promise.resolve()));
    }
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    return from + count * 16;
  };

  it("plays, pauses, changes speed and stays ahead of the clock", async () => {
    const engine = await started(example(JACKSON));
    expect(engine.phase).toBe("running");
    expect(engine.seed).toBe(5);
    expect(engine.layout!.stations.map((s) => s.name)).toEqual(["S1", "S2"]);
    expect(engine.state!.window).toBeCloseTo(WINDOW_SECONDS * engine.clock.pace, 12);
    expect(engine.horizon).toBeCloseTo(FETCH_SECONDS * engine.clock.rate, 9);
    let now = await frames(engine, 60, 0);
    const t1 = engine.clock.time;
    // 59 frame gaps of 16 ms at 1×.
    expect(t1).toBeCloseTo(((59 * 16) / 1000) * engine.clock.pace, 9);
    expect(engine.state!.time).toBeLessThanOrEqual(t1);
    expect(engine.state!.faults).toBe(0);
    expect(engine.horizon).toBeGreaterThan(t1);

    engine.setPlaying(false);
    now = await frames(engine, 30, now);
    expect(engine.clock.time).toBe(t1);
    expect(engine.playing).toBe(false);

    engine.setSpeed(8);
    engine.toggle();
    now = await frames(engine, 61, now + 5000);
    // The pause is not played as one long frame; 60 gaps at 8×.
    expect(engine.clock.time).toBeCloseTo(t1 + ((60 * 16) / 1000) * 8 * engine.clock.pace, 9);
    engine.stepSpeed(1);
    expect(engine.clock.speed).toBe(16);
    await frames(engine, 200, now);
    expect(engine.state!.faults).toBe(0);
    expect(engine.state!.created).toBeGreaterThan(10);
    engine.dispose();
  });

  it("tells the controls of progress, a few times a second", async () => {
    const engine = await started(example(JACKSON));
    let told = 0;
    engine.subscribe(() => told++);
    await frames(engine, 125, 0);
    // 2 s of frames: published at most every 250 ms, not every frame.
    expect(told).toBeGreaterThanOrEqual(6);
    expect(told).toBeLessThan(40);
    engine.dispose();
  });

  it("skips ahead: the state and the totals are the simulator's, and play goes on from there", async () => {
    const engine = await started(example(JACKSON));
    let now = await frames(engine, 30, 0);
    const before = engine.horizon;
    const span = engine.skipSpan();
    expect(span).toBeCloseTo(SKIP_COMPLETIONS / engine.layout!.eventRate, 9);
    const done = engine.skip();
    expect(engine.skipping).toBe(true);
    await act(async () => void (await done));
    expect(engine.skipping).toBe(false);
    expect(engine.clock.time).toBeCloseTo(before + span, 6);
    expect(engine.state!.time).toBe(engine.clock.time);
    expect(engine.state!.created).toBeGreaterThan(200);
    // The snapshot adopted and the totals adopted are of the same moment.
    expect(engine.state!.total()).toBe(engine.state!.created - engine.state!.left);
    now = await frames(engine, 120, now + 1000);
    expect(engine.clock.time).toBeGreaterThan(before + span);
    expect(engine.state!.faults).toBe(0);
    // The average over the whole run, skip included.
    const avg = engine.state!.average(0, engine.clock.time)!;
    expect(avg).toBeGreaterThan(0.3);
    expect(avg).toBeLessThan(15);
    engine.dispose();
  });

  // Ledger WF-508: the simulator stops a run whose queue has passed its size limit, with a sentence.
  it("stops with the simulator's sentence when the run has passed its size limit", async () => {
    const SENTENCE = "The queue at S1 has passed 1,000,000 customers; the animation has stopped. The network is overloaded there: its queue grows without limit.";
    const handlers = defaultHandlers();
    const skipHandler = handlers.animate_skip as (a: unknown) => { time: number; snapshot?: { waiting?: number[]; queues: unknown[][] } };
    mockTauri({
      ...handlers,
      animate_skip: (a: unknown) => {
        const chunk = skipHandler(a);
        const snapshot = chunk.snapshot!;
        return { ...chunk, snapshot: { ...snapshot, waiting: snapshot.queues.map((q, i) => (i === 0 ? 1_000_001 : q.length)) }, stopped: SENTENCE };
      },
    });
    const engine = await started(example(JACKSON));
    await frames(engine, 10, 0);
    await act(async () => void (await engine.skip()));
    expect([engine.phase, engine.message, engine.playing]).toEqual(["failed", SENTENCE, false]);
    expect(engine.state!.waiting(0)).toBe(1_000_001);
    // What crossed from the simulator named at most the head of the queue.
    expect(engine.state!.stations[0].queue.at(600)).toBeUndefined();
    engine.dispose();
  });

  it("is the same run again from the same seed, and another from another", async () => {
    const doc = example(JACKSON);
    const times = async (seed: number) => {
      const engine = await started(doc, seed);
      const sim = [...mockAnimate.open.values()].pop()!;
      const s = sim.totals();
      engine.dispose();
      return JSON.stringify(s);
    };
    const a = await times(11);
    expect(await times(11)).toBe(a);
    expect(await times(12)).not.toBe(a);
  });

  it("restarts in place, and ends its run in the backend when disposed", async () => {
    const doc = example(JACKSON);
    const engine = await started(doc);
    await frames(engine, 40, 0);
    expect(mockAnimate.open.size).toBe(1);
    await act(async () => void (await engine.start(doc, 9, { play: false })));
    expect(mockAnimate.open.size).toBe(1);
    expect([engine.seed, engine.clock.time, engine.playing, engine.state!.created]).toEqual([9, 0, false, 0]);
    engine.dispose();
    await waitFor(() => expect(mockAnimate.open.size).toBe(0), TIMEOUT);
    // A disposed engine does nothing more.
    expect(engine.frame(1e6)).toBe(0);
  });

  it("refuses finite buffers with the reason, and animates an unstable network with a warning", async () => {
    const finite = new AnimationEngine();
    await finite.start(example("MM1K.d1.c1.fin.bnet"), 1);
    expect([finite.phase, finite.message]).toEqual(["refused", FINITE_SENTENCE]);
    // The sentence offers the way forward, by the menu's own words: a new, empty network starts finite.
    expect(emptyDocument().infiniteBuffers).toBe(false);
    expect(FINITE_SENTENCE).toContain("choose Network ▸ Buffer Model ▸ Infinite buffers");
    expect(JSON.stringify(MENU_SPEC)).toMatch(/"submenu":"Network".*"submenu":"Buffer Model".*Infinite buffers — queues are unbounded/);
    expect(finite.frame(100)).toBe(0);
    finite.setPlaying(true);
    expect(finite.playing).toBe(false);
    finite.dispose();

    const doc = example(JACKSON);
    const overloaded = { ...doc, nodes: doc.nodes.map((n) => (n.kind === "source" ? { ...n, distributionParameters: "lambda=5" } : n)) };
    const engine = await started(overloaded);
    expect(engine.layout!.unstable.length).toBeGreaterThan(0);
    expect(engine.layout!.stations.every((s) => s.exactNumber === null)).toBe(true);
    engine.dispose();
  });

  it("a closed network keeps its population", async () => {
    const closedDocs = import.meta.glob("../../examples/closed/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const raw = Object.values(closedDocs)[0];
    expect(raw).toBeTruthy();
    const doc = JSON.parse(raw) as BnetDocument;
    const engine = await started(doc);
    const n = engine.layout!.population!;
    expect(n).toBe(doc.closedPopulation);
    expect(engine.state!.total()).toBe(n);
    await frames(engine, 200, 0);
    expect(engine.state!.total()).toBe(n);
    expect(engine.state!.faults).toBe(0);
    engine.dispose();
  });
});

// ── On the canvas ────────────────────────────────────────────────────────────────────────────

class FixedResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, contentRect: { width: 1200, height: 800, x: 0, y: 0 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}

describe("animation mode on the canvas", () => {
  let pen: ReturnType<typeof recorder>;
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let clock: number;
  let cancelled: number[];

  /** Runs the frames due, `ms` apart. */
  const tick = async (count = 1, ms = 16) => {
    for (let i = 0; i < count; i++) {
      clock += ms;
      const due = [...frameCallbacks.values()];
      frameCallbacks.clear();
      await act(async () => {
        due.forEach((f) => f(clock));
        await Promise.resolve();
      });
    }
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  };

  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", FixedResizeObserver);
    pen = recorder();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => pen.pen as unknown as CanvasRenderingContext2D);
    frameCallbacks = new Map();
    nextFrame = 0;
    clock = 1000;
    cancelled = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
      frameCallbacks.set(++nextFrame, f);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelled.push(id);
      frameCallbacks.delete(id);
    });
    mockTauri(defaultHandlers());
    resetKv();
    resetRuns();
    resetAnimate();
    await loadKv();
  });
  afterEach(() => {
    // Unmounted while the stand-in canvas context is still in place.
    cleanup();
    resetAnimate();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-motion");
  });

  const mount = async (doc: BnetDocument = example(JACKSON)) => {
    const id = addTab({ title: JACKSON, path: `/examples/${JACKSON}`, document: doc });
    const editor = editorFor(id);
    const view = render(
      <div style={{ width: 1200, height: 800 }}>
        <CanvasView editor={editor} />
        <CanvasStatusBar editor={editor} />
      </div>,
    );
    await act(async () => void (await Promise.resolve()));
    return { id, editor, view };
  };

  const running = async (id: string) => {
    await waitFor(() => expect(engineFor(id)?.phase).toBe("running"), TIMEOUT);
    await waitFor(() => expect(engineFor(id)!.horizon).toBeGreaterThan(0), TIMEOUT);
    return engineFor(id)!;
  };

  it("is a View menu item, a command and a status-bar button, off until asked for", async () => {
    const { id } = await mount();
    expect(JSON.stringify(MENU_SPEC)).toContain(`"${ANIMATE_COMMAND}"`);
    const cmd = getCommand(ANIMATE_COMMAND)!;
    expect([cmd.title, cmd.checked?.()]).toEqual([w.menuTitle, false]);
    expect(document.querySelector(".animate-layer")).toBeNull();
    expect(mockAnimate.calls.animate_start).toBe(0);
    const button = screen.getByRole("button", { name: w.button });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(animateOn(id)).toBe(true);
    expect(cmd.checked?.()).toBe(true);
    await running(id);
    expect(screen.getByRole("button", { name: w.buttonOn }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => void (await runCommand(ANIMATE_COMMAND)));
    expect(animateOn(id)).toBe(false);
    expect(document.querySelector(".animate-layer")).toBeNull();
  });

  it("plays tokens on a canvas over the drawing, labelled as one random run", async () => {
    const { id } = await mount();
    act(() => setAnimate(id, true));
    const engine = await running(id);
    // Fast, so that the random seed in use cannot leave the run without an arrival.
    act(() => engine.setSpeed(16));
    await tick(240);
    expect(engine.clock.time).toBeGreaterThan(0);
    expect(engine.state!.created).toBeGreaterThan(0);
    expect(engine.state!.faults).toBe(0);
    const canvas = document.querySelector<HTMLCanvasElement>(".animate-canvas")!;
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(Number(canvas.dataset.tokens)).toBeGreaterThanOrEqual(0);
    expect(pen.calls.some((c) => c.op === "clearRect")).toBe(true);
    expect(pen.calls.filter((c) => c.op === "fill").length).toBeGreaterThan(10);
    // The label, the caveat and the pointer to Solve are always there.
    const bar = screen.getByRole("group", { name: w.barLabel });
    expect(bar.textContent).toContain(w.title);
    expect(bar.textContent).toContain(w.biasOpen);
    expect(bar.textContent).toContain(w.useSolve);
    expect(bar.querySelector("[data-animate-clock]")!.textContent).toMatch(/^t = \d/);
    // The strip chart, with the exact mean of S1 (7/3 in the Jackson example) as its dashed line.
    expect(bar.querySelector("[data-animate-chart]")!.getAttribute("role")).toBe("img");
    expect(bar.querySelector("[data-animate-exact-line]")).not.toBeNull();
    expect(bar.querySelector("[data-animate-exact]")!.getAttribute("data-animate-exact")).toBe("2.333");
    expect(bar.querySelector("[data-animate-average]")!.textContent).toMatch(/average \d+\.\d+ customers after t = \d/);
    // The results overlay, the ρ badges and the problem marks step aside.
    expect(document.querySelector(".canvas-clip")!.hasAttribute("data-animating")).toBe(true);
    expect(document.querySelector("[data-rho-badge], .rho-badge")).toBeNull();
  });

  it("Space on the canvas pauses and plays; the buttons restart, reseed, change speed and skip", async () => {
    const { id } = await mount();
    act(() => setAnimate(id, true));
    const engine = await running(id);
    await tick(20);
    const surface = document.querySelector<HTMLElement>(".canvas-surface")!;
    surface.focus();
    fireEvent.keyDown(surface, { key: " " });
    expect(engine.playing).toBe(false);
    expect(screen.getByRole("button", { name: w.play })).toBeTruthy();
    const paused = engine.clock.time;
    await tick(20);
    expect(engine.clock.time).toBe(paused);
    fireEvent.keyDown(surface, { key: " ", repeat: true });
    expect(engine.playing).toBe(false);
    fireEvent.keyDown(surface, { key: " " });
    expect(engine.playing).toBe(true);
    await tick(20);
    expect(engine.clock.time).toBeGreaterThan(paused);

    fireEvent.change(screen.getByRole("combobox", { name: w.speed }), { target: { value: "16" } });
    expect(engine.clock.speed).toBe(16);

    const seed = engine.seed;
    const starts = mockAnimate.calls.animate_start;
    fireEvent.click(screen.getByRole("button", { name: w.restart }));
    await waitFor(() => expect(mockAnimate.calls.animate_start).toBe(starts + 1), TIMEOUT);
    await waitFor(() => expect(engine.phase).toBe("running"), TIMEOUT);
    expect([engine.seed, engine.clock.speed]).toEqual([seed, 16]);
    expect(engine.clock.time).toBeLessThan(paused);
    fireEvent.click(screen.getByRole("button", { name: w.newRun }));
    await waitFor(() => expect(mockAnimate.calls.animate_start).toBe(starts + 2), TIMEOUT);
    await waitFor(() => expect(engine.phase).toBe("running"), TIMEOUT);
    expect(engine.seed).not.toBe(seed);
    expect(mockAnimate.open.size).toBe(1);

    await waitFor(() => expect(engine.horizon).toBeGreaterThan(0), TIMEOUT);
    const before = engine.clock.time;
    fireEvent.click(screen.getByRole("button", { name: w.skip }));
    await waitFor(() => expect(mockAnimate.calls.animate_skip).toBe(1), TIMEOUT);
    await waitFor(() => expect(engine.skipping).toBe(false), TIMEOUT);
    expect(engine.clock.time).toBeGreaterThan(before + engine.skipSpan() * 0.99);
  });

  it("a change to the network starts the run again and says so; moving a node does not", async () => {
    const { id } = await mount();
    act(() => setAnimate(id, true));
    const engine = await running(id);
    await tick(30);
    const doc = example(JACKSON);
    const starts = mockAnimate.calls.animate_start;
    act(() => setDocument(id, { ...doc, nodes: doc.nodes.map((n, i) => (i === 0 ? { ...n, position: [n.position[0] + 30, n.position[1]] as [number, number] } : n)) }));
    await tick(5);
    expect(mockAnimate.calls.animate_start).toBe(starts);
    expect(document.querySelector('[data-animate-note="restarted"]')).toBeNull();
    const seed = engine.seed;
    act(() => setDocument(id, { ...doc, nodes: doc.nodes.map((n) => (n.kind === "source" ? { ...n, distributionParameters: "lambda=0.5" } : n)) }));
    await waitFor(() => expect(mockAnimate.calls.animate_start).toBe(starts + 1), TIMEOUT);
    await waitFor(() => expect(engine.phase).toBe("running"), TIMEOUT);
    expect(engine.seed).toBe(seed);
    expect(document.querySelector('[data-animate-note="restarted"]')!.textContent).toBe(w.restarted);
    expect(mockAnimate.open.size).toBe(1);
    // The animation never writes to the document.
    expect(mockCalls.some((c) => c.cmd === "document_write")).toBe(false);
  });

  it("says why a network cannot be animated, and warns that an overloaded one has no steady state", async () => {
    const { id, view } = await mount(example("MM1K.d1.c1.fin.bnet"));
    act(() => setAnimate(id, true));
    await waitFor(() => expect(engineFor(id)?.phase).toBe("refused"), TIMEOUT);
    const bar = screen.getByRole("group", { name: w.barLabel });
    expect(bar.textContent).toContain(w.refusedTitle);
    expect(bar.textContent).toContain(FINITE_SENTENCE);
    fireEvent.click(screen.getByRole("button", { name: w.close }));
    expect(animateOn(id)).toBe(false);
    view.unmount();

    const doc = example(JACKSON);
    const second = await mount({ ...doc, nodes: doc.nodes.map((n) => (n.kind === "source" ? { ...n, distributionParameters: "lambda=5" } : n)) });
    act(() => setAnimate(second.id, true));
    await running(second.id);
    await tick(3);
    const banner = document.querySelector('[data-animate-banner="unstable"]')!;
    expect(banner.textContent).toContain("No steady state exists");
    expect(document.querySelector("[data-animate-exact-line]")).toBeNull();
  });

  it("with Reduce Motion it says so, draws no travelling tokens and repaints in steps", async () => {
    document.documentElement.setAttribute("data-motion", "reduce");
    const { id } = await mount();
    act(() => setAnimate(id, true));
    const engine = await running(id);
    act(() => engine.setSpeed(16));
    await tick(10);
    pen.calls.length = 0;
    await tick(120, 16);
    expect(document.querySelector('[data-animate-note="reduced"]')!.textContent).toBe(w.reduced);
    expect(document.querySelector(".animate-layer")!.hasAttribute("data-reduced")).toBe(true);
    expect(document.querySelector<HTMLCanvasElement>(".animate-canvas")!.dataset.moving).toBe("0");
    // 120 frames (1.92 s) but only a handful of repaints, STEP_MS apart; the run still advances.
    const paints = pen.calls.filter((c) => c.op === "clearRect").length;
    expect(paints).toBeGreaterThanOrEqual(2);
    expect(paints).toBeLessThanOrEqual(12);
    expect(engine.state!.created).toBeGreaterThan(0);
  });

  it("stops its frames while the window is hidden, and cleans up on the way out", async () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { id, view } = await mount();
    act(() => setAnimate(id, true));
    const engine = await running(id);
    await tick(10);
    expect(frameCallbacks.size).toBe(1);
    expect(add.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(1);

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(frameCallbacks.size).toBe(0);
    const t = engine.clock.time;
    await tick(10);
    expect(engine.clock.time).toBe(t);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(frameCallbacks.size).toBe(1);
    // The hidden time is not played as one long frame.
    clock += 60_000;
    await tick(2);
    expect(engine.clock.time).toBeLessThan(t + 0.2 * engine.clock.rate);

    // Paused, with nothing travelling, no frame is asked for.
    act(() => engine.setPlaying(false));
    await tick(60);
    expect(frameCallbacks.size).toBe(0);
    act(() => engine.setPlaying(true));
    expect(frameCallbacks.size).toBe(1);

    const pending = [...frameCallbacks.keys()];
    view.unmount();
    expect(frameCallbacks.size).toBe(0);
    expect(cancelled).toEqual(expect.arrayContaining(pending));
    expect(remove.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(1);
    expect(engineFor(id)).toBeUndefined();
    await waitFor(() => expect(mockAnimate.open.size).toBe(0), TIMEOUT);
    expect(mockAnimate.calls.animate_stop).toBeGreaterThanOrEqual(1);
  });

  it("nothing it does reaches the run records", async () => {
    const { id } = await mount();
    act(() => setAnimate(id, true));
    const engine = await running(id);
    await tick(120);
    await act(async () => void (await engine.skip()));
    await tick(30);
    expect(resultsFor(id)).toEqual([]);
    const asked = new Set(mockCalls.map((c) => c.cmd));
    for (const cmd of ["run_start", "quiet_run", "quiet_runs_start", "results_delete", "export_save", "document_write"]) expect(asked.has(cmd)).toBe(false);
    expect([...asked].filter((c) => c.startsWith("animate_")).sort()).toEqual(["animate_next", "animate_skip", "animate_start"]);
    // And no command with "run" or "result" in its name was sent by the animation's own calls.
    expect(mockCalls.filter((c) => c.cmd.startsWith("animate_")).every((c) => !("tabId" in c.args))).toBe(true);
  });
});
