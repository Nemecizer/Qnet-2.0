// The canvas status bar against 0.90.34's ContentView.swift `CanvasStatusBar` (ledger CAN-159…
// CAN-162, CAN-203).
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorFor } from "../editor";
import type { BnetDocument } from "../lib/bnet";
import { activeTab, setDocument } from "../workspace/store";
import { byName, example } from "./layers/testkit";
import { CanvasStatusBar } from "./StatusBar";

function mount(doc: BnetDocument, props: { countStyle?: "words" | "symbols"; run?: string } = {}) {
  const id = activeTab().id;
  setDocument(id, doc);
  const editor = editorFor(id);
  const utils = render(<CanvasStatusBar editor={editor} {...props} />);
  const bar = screen.getByRole("group", { name: "Status bar" });
  return { editor, bar, ...utils };
}

const segs = (bar: HTMLElement) => [...bar.querySelectorAll(".canvas-sb-seg")].map((s) => s.textContent);

describe("canvas status bar", () => {
  it("reads tool · zoom · selection · counts · snap · buffers, each with its tooltip", () => {
    const { bar } = mount(example("2dtandem.bnet"));
    expect(segs(bar)).toEqual(["Pointer", "100%", "No selection", "1source2stations2buffers1sink5links", "", "Finite buffers"]);
    const seg = [...bar.querySelectorAll(".canvas-sb-seg")];
    expect(seg[0]).toHaveAttribute("title", "Active tool. Switch in the Tools pane or with its letter shortcut. Hold Space, or drag with the middle mouse button, to pan in any tool.");
    expect(seg[1]).toHaveAttribute("title", "Canvas zoom (⌘= / ⌘−; ⌘0 actual size, ⇧⌘0 zoom to fit, ⌥⇧⌘0 zoom to selection; ⌥-scroll or pinch to zoom about the pointer)");
    expect(seg[2]).toHaveAttribute("title", "What is selected on the canvas — nodes, a link, or both (⌘A selects all nodes, Escape or ⌥⌘A deselects everything)");
    expect(seg[3]).toHaveAttribute("title", "Network primitives: sources, stations, buffers, sinks, links");
    expect(seg[4]).toHaveAttribute("title", "Snap to Grid (⌥⌘G). Hold ⌃ while dragging to place a node freely.");
    expect(seg[5]).toHaveAttribute("title", "Finite buffers: bounded queues with blocking (fBNA methods)");
    expect(screen.getByRole("img", { name: "2 stations" })).toHaveAttribute("title", "2 stations");
    expect(screen.getByRole("img", { name: "1 sink" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Snap to grid off" })).toBeInTheDocument();
  });

  it("follows the tool, the zoom and the selection", () => {
    const d = example("2dtandem.bnet");
    const { editor, bar } = mount(d);
    act(() => editor.setTool("addLink"));
    act(() => editor.setZoom(0.5));
    expect(segs(bar).slice(0, 2)).toEqual(["Add Link", "50%"]);
    act(() => editor.setView({ selectedNodeIDs: new Set([byName(d, "S1").id, byName(d, "S2").id]) }));
    expect(segs(bar)[2]).toBe("Selected 2 nodes");
    act(() => editor.setView({ selectedNodeIDs: new Set(), selectedNodeID: byName(d, "S1").id, selectedLinkID: d.links[0].id }));
    expect(segs(bar)[2]).toBe("Selected 1 node, 1 link");
    expect(screen.getByRole("group", { name: "Selected 1 node, 1 link" })).toBeInTheDocument();
    act(() => editor.setView({ selectedNodeID: null }));
    expect(segs(bar)[2]).toBe("Selected 1 link");
  });

  it("says 'Selecting N nodes' in accent while a marquee is live", () => {
    const d = example("2dtandem.bnet");
    const { editor, bar } = mount(d);
    const [x, y] = byName(d, "S1").position;
    act(() => editor.setView({ multiSelectRect: { x: x - 30, y: y - 30, width: 200, height: 60 } }));
    const seg = bar.querySelector(".canvas-sb-selecting")!;
    expect(seg.textContent).toBe(`Selecting ${editor.marqueeNodeCount} nodes`);
    expect(seg).toHaveAttribute("title", "Nodes inside the selection rectangle");
    act(() => editor.setView({ multiSelectRect: { x: x - 1, y: y - 1, width: 2, height: 2 } }));
    expect(bar.querySelector(".canvas-sb-selecting")!.textContent).toBe("Selecting 1 node");
  });

  it("falls back to kind symbols and numbers when the words don't fit", () => {
    const { bar } = mount(example("2dtandem.bnet"), { countStyle: "symbols" });
    const counts = bar.querySelector(".canvas-sb-countlist")!;
    expect(counts.getAttribute("data-style")).toBe("symbols");
    expect(counts.textContent).toBe("12215");
    expect(counts.querySelectorAll("svg")).toHaveLength(5);
    expect(screen.getByRole("img", { name: "5 links" })).toBeInTheDocument();
  });

  it("shows the snap state, 'Free placement' while ⌃ is held, and the buffer regime", () => {
    const { editor, bar } = mount({ ...example("2dtandem.bnet"), infiniteBuffers: true });
    act(() => editor.setSnapToGrid(true));
    expect(screen.getByRole("img", { name: "Snap to grid on" })).toHaveClass("canvas-sb-snap-on");
    act(() => editor.setView({ snapSuspended: true }));
    expect(screen.getByRole("img", { name: "Snap to grid suspended" })).toHaveClass("canvas-sb-snap-off");
    expect(bar).toHaveTextContent("Free placement");
    expect(bar.querySelector('[title^="Free placement: ⌃ is held"]')).not.toBeNull();
    expect(bar).toHaveTextContent("Infinite buffers");
    expect(bar.querySelector('[title="Infinite buffers: unbounded queues (BNA / QNA / spectral orthant methods)"]')).not.toBeNull();
  });

  it("shows the pan offset only when it isn't zero", () => {
    const { editor, bar } = mount(example("2dtandem.bnet"));
    expect(bar).not.toHaveTextContent("Pan ");
    act(() => editor.pan({ width: 10.4, height: -5.5 }));
    expect(bar).toHaveTextContent("Pan 10, -6 pt");
    expect(screen.getByRole("group", { name: "Canvas panned by 10 and -6 points" })).toHaveAttribute("title", "Canvas pan offset in points (⌘0 returns to actual size at the origin)");
  });

  it("leaves a slot for the run segment (P6)", () => {
    const { bar } = mount(example("2dtandem.bnet"), { run: "Idle" });
    expect(bar.querySelector('[data-slot="run"]')).toHaveTextContent("Idle");
  });

  // Ledger WF-510. jsdom lays nothing out, so the bar's box model is stood in for here: a fixed
  // part of FIXED px, the counts (WORDS px as words, SYMBOLS px as symbols) and the spacer, which
  // takes what is left and never less than its min-width. With the bar between the width at
  // which the symbols form thought the words would fit (it counted the spacer's own minimum as
  // room) and the width the words form really needs, the two forms swapped without end, and React
  // stopped the render with "Maximum update depth exceeded". Adding a button to the bar moved real
  // windows into that band.
  describe("words or symbols, by the room there is", () => {
    const WORDS = 300;
    const SYMBOLS = 120;
    const FIXED = 400;
    const MIN = 16;
    let width = 0;
    const saved: [string, PropertyDescriptor | undefined][] = [];
    const listWidth = (bar: Element) => (bar.querySelector(".canvas-sb-countlist")?.getAttribute("data-style") === "symbols" ? SYMBOLS : WORDS);
    const barOf = (el: Element) => el.closest('[role="group"]') ?? el;
    const layout = {
      clientWidth(this: HTMLElement) {
        return this.getAttribute("role") === "group" ? width : 0;
      },
      scrollWidth(this: HTMLElement) {
        if (this.classList.contains("canvas-sb-countlist")) return this.getAttribute("data-style") === "symbols" ? SYMBOLS : WORDS;
        return this.getAttribute("role") === "group" ? Math.max(width, FIXED + listWidth(this) + MIN) : 0;
      },
      offsetWidth(this: HTMLElement) {
        return this.classList.contains("canvas-sb-spacer") ? Math.max(MIN, width - FIXED - listWidth(barOf(this))) : 0;
      },
    };
    const realStyle = window.getComputedStyle.bind(window);
    const observers: (() => void)[] = [];

    beforeEach(() => {
      for (const [name, get] of Object.entries(layout)) {
        saved.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
        Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
      }
      vi.stubGlobal("ResizeObserver", class {
        constructor(private readonly f: () => void) {
          observers.push(f);
        }
        observe() {}
        disconnect() {
          const i = observers.indexOf(this.f);
          if (i >= 0) observers.splice(i, 1);
        }
      });
      vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
        const style = realStyle(el, pseudo);
        return (el as HTMLElement).classList?.contains("canvas-sb-spacer") ? (new Proxy(style, { get: (t, k) => (k === "minWidth" ? `${MIN}px` : Reflect.get(t, k)) }) as CSSStyleDeclaration) : style;
      });
    });
    afterEach(() => {
      for (const [name, d] of saved.splice(0)) {
        if (d) Object.defineProperty(HTMLElement.prototype, name, d);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
      observers.length = 0;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    const styleAt = (w: number) => {
      width = w;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { bar, unmount } = mount(example("2dtandem.bnet"));
      const style = bar.querySelector(".canvas-sb-countlist")!.getAttribute("data-style");
      const said = errors.mock.calls.map((c) => String(c[0])).filter((m) => /Maximum update depth/.test(m));
      unmount();
      errors.mockRestore();
      return { style, said };
    };

    it("settles on one form at every width, also where the symbols' spare room is only the spacer's own minimum", () => {
      // Words need FIXED + WORDS + MIN = 716. Just below that the old rule read the spacer's
      // minimum as room and went back to words: 701…715 was the band that never settled.
      for (const w of [600, 700, 701, 708, 715]) expect(styleAt(w), `${w}px`).toEqual({ style: "symbols", said: [] });
      for (const w of [716, 717, 800, 1200]) expect(styleAt(w), `${w}px`).toEqual({ style: "words", said: [] });
    });

    it("goes to symbols when the bar narrows and back to words only when the words fit", () => {
      width = 1000;
      const { bar } = mount(example("2dtandem.bnet"));
      const style = () => bar.querySelector(".canvas-sb-countlist")!.getAttribute("data-style");
      const resize = (w: number) => act(() => { width = w; [...observers].forEach((f) => f()); });
      expect(style()).toBe("words");
      resize(708);
      expect(style()).toBe("symbols");
      resize(715);
      expect(style()).toBe("symbols");
      resize(717);
      expect(style()).toBe("words");
    });
  });
});
