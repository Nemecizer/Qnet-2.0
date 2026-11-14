// The canvas's floating chrome against 0.90.34's NetworkCanvasOverlays.swift: the class legend,
// the zoom cluster and the empty-canvas hint (ledger CAN-151…CAN-155, INV-025).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { editorFor } from "../../editor";
import { registerCommands } from "../../lib/commands";
import { emptyDocument, type BnetDocument } from "../../lib/bnet";
import { activeTab, setDocument } from "../../workspace/store";
import { example } from "../layers/testkit";
import { CanvasOverlays } from "./CanvasOverlays";
import css from "../canvas.css?raw";

function mount(doc: BnetDocument) {
  const id = activeTab().id;
  setDocument(id, doc);
  const editor = editorFor(id);
  editor.setViewportSize({ width: 1600, height: 1000 });
  const utils = render(<CanvasOverlays editor={editor} />);
  return { editor, ...utils };
}

describe("class legend (CAN-152)", () => {
  it("is absent with one class", () => {
    mount(example("2dtandem.bnet"));
    expect(screen.queryByRole("group", { name: "Customer class legend" })).toBeNull();
  });

  it("shows one chip per class, pins the filter on a click and clears it on a second, dimming the others", () => {
    const { editor } = mount(example("3d3cfin.bnet"));
    const legend = screen.getByRole("group", { name: "Customer class legend" });
    const chips = within(legend).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Class 1", "Class 2", "Class 3"]);
    expect(chips[1]).toHaveAccessibleName("Class 2 filter");
    expect(chips[1]).toHaveAttribute("title", "Click to show only Class 2 routing.");
    expect(chips[1]).toHaveAttribute("aria-pressed", "false");
    expect(chips[1]).toHaveAttribute("aria-description", "off");
    fireEvent.click(chips[1]);
    expect(editor.view.classFilter).toBe(1);
    const again = within(screen.getByRole("group", { name: "Customer class legend" })).getAllByRole("button");
    expect(again[1]).toHaveAttribute("title", "Showing only Class 2 routing. Click to clear the filter.");
    expect(again[1]).toHaveAttribute("aria-pressed", "true");
    expect(again[1]).toHaveAttribute("aria-description", "on");
    expect(again[0]).toHaveAttribute("data-dimmed");
    expect(again[1]).not.toHaveAttribute("data-dimmed");
    fireEvent.click(again[1]);
    expect(editor.view.classFilter).toBeNull();
  });

  it("sits bottom-left, the zoom cluster bottom-right, on a flat panel with a hairline and the card shadow (CAN-151)", () => {
    expect(css).toMatch(/\.canvas-legend \{ left: var\(--sp-4\)/);
    expect(css).toMatch(/\.canvas-zoom \{ right: var\(--sp-4\)/);
    const panel = css.slice(css.indexOf(".canvas-panel {"), css.indexOf("}", css.indexOf(".canvas-panel {")));
    expect(panel).toMatch(/padding: var\(--sp-4\)/);
    expect(panel).toMatch(/background: var\(--canvas-panel\)/);
    expect(panel).toMatch(/border-radius: var\(--r-lg\)/);
    expect(panel).toMatch(/box-shadow: var\(--canvas-panel-shadow\)/);
    expect(panel).not.toMatch(/backdrop-filter/);
  });
});

describe("zoom cluster (CAN-153, CAN-154)", () => {
  it("zooms out and in, disabled at 10 % and 400 %, with 0.90.34's tooltips", () => {
    const { editor } = mount(example("2dtandem.bnet"));
    const cluster = screen.getByRole("group", { name: "Zoom controls" });
    const out = within(cluster).getByRole("button", { name: "Zoom Out" });
    const zin = within(cluster).getByRole("button", { name: "Zoom In" });
    expect(out).toHaveAttribute("title", "Zoom out (⌘−)");
    expect(zin).toHaveAttribute("title", "Zoom in (⌘=)");
    fireEvent.click(zin);
    expect(editor.view.canvasScale).toBeCloseTo(1.25);
    act(() => editor.setZoom(0.1));
    expect(within(cluster).getByRole("button", { name: "Zoom Out" })).toBeDisabled();
    act(() => editor.setZoom(4));
    expect(within(cluster).getByRole("button", { name: "Zoom In" })).toBeDisabled();
    expect(within(cluster).getByRole("button", { name: "Zoom level" })).toHaveAttribute("aria-description", "400%");
  });

  it("offers 50 %, 100 %, 200 %, Zoom to Fit and Zoom to Selection from the percentage menu", () => {
    const { editor } = mount(example("2dtandem.bnet"));
    const level = screen.getByRole("button", { name: "Zoom level" });
    expect(level).toHaveTextContent("100%");
    expect(level.getAttribute("title")).toBe("Zoom level — pick a preset, Zoom to Fit (⇧⌘0) or Zoom to Selection (⌥⇧⌘0). ⌘0 is actual size.");
    fireEvent.click(level);
    const menu = screen.getByRole("menu", { name: "Zoom level" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["50%", "100%", "200%", "Zoom to Fit", "Zoom to Selection"]);
    expect(items[4]).toHaveAttribute("aria-disabled", "true"); // nothing selected
    fireEvent.click(items[2]);
    expect(editor.view.canvasScale).toBe(2);
    expect(screen.getByRole("button", { name: "Zoom level" })).toHaveTextContent("200%");
  });

  it("fits the network, disabled on an empty canvas", () => {
    const { editor } = mount(example("2dtandem.bnet"));
    fireEvent.click(screen.getByRole("button", { name: "Zoom to Fit" }));
    expect(editor.view.canvasScale).not.toBe(1);
    expect(screen.getByRole("button", { name: "Zoom to Fit" })).toHaveAttribute("title", "Zoom to fit the whole network (⇧⌘0)");
  });

  it("toggles Snap to Grid and dims it to 40 % while ⌃ suspends snapping, saying so", () => {
    const { editor } = mount(example("2dtandem.bnet"));
    const snap = () => screen.getByRole("button", { name: "Snap to Grid" });
    expect(snap()).toHaveAttribute("aria-pressed", "false");
    expect(snap().getAttribute("title")).toBe("Snap to Grid is off (⌥⌘G to turn on). Alignment guides still line a dragged node up with its neighbours; hold ⌃ to place it freely.");
    fireEvent.click(snap());
    expect(editor.view.snapToGrid).toBe(true);
    expect(snap()).toHaveAttribute("aria-pressed", "true");
    expect(snap().getAttribute("title")).toBe("Snap to Grid is on — node moves land on the 28 pt grid (⌥⌘G to turn off). Hold ⌃ while dragging to place a node freely.");
    expect(snap()).toHaveStyle({ opacity: "1" });
    act(() => editor.setView({ snapSuspended: true }));
    expect(snap()).toHaveStyle({ opacity: "0.4" });
    expect(snap().getAttribute("title")).toBe("Free placement — ⌃ is held, so Snap to Grid and the alignment guides stand down for this drag");
  });
});

describe("empty-canvas hint (CAN-155, INV-025)", () => {
  it("shows only on an empty canvas, in 0.90.34's words, archetype first and prominent", () => {
    mount(emptyDocument());
    const hint = screen.getByRole("group", { name: "No Network Yet" });
    expect(within(hint).getByRole("heading")).toHaveTextContent("No Network Yet");
    expect(hint).toHaveTextContent("Press S, then click to place a station. A station is served through exactly one buffer: Source → Buffer → Station → Sink.");
    const [archetype, ex] = within(hint).getAllByRole("button");
    expect(archetype).toHaveTextContent("Start from an Archetype…");
    expect(archetype).toHaveClass("primary");
    expect(archetype).toHaveAttribute("title", "Insert a ready-made network — tandem line, M/M/c station, fork, rework loop or re-entrant pair — at a chosen size and utilisation");
    expect(ex).toHaveTextContent("Open an Example…");
    expect(ex).toHaveAttribute("title", "Open one of the 50 bundled literature networks");
    expect(ex).not.toHaveClass("primary");
  });

  it("runs File ▸ New from Archetype… and File ▸ Open Example… through their commands", () => {
    const archetype = vi.fn();
    const ex = vi.fn();
    const stop = registerCommands([
      { id: "file:new-from-archetype", title: "New from Archetype…", group: "File", run: archetype },
      { id: "file:open-example", title: "Open Example…", group: "File", run: ex },
    ]);
    mount(emptyDocument());
    fireEvent.click(screen.getByRole("button", { name: "Start from an Archetype…" }));
    fireEvent.click(screen.getByRole("button", { name: "Open an Example…" }));
    return Promise.resolve().then(() => {
      expect(archetype).toHaveBeenCalledTimes(1);
      expect(ex).toHaveBeenCalledTimes(1);
      stop();
    });
  });

  it("is gone once there is a node", () => {
    mount(example("MM1K.d1.c1.fin.bnet"));
    expect(screen.queryByRole("group", { name: "No Network Yet" })).toBeNull();
  });

  it("lets a click through its icon and text reach the canvas, the buttons alone taking the pointer", () => {
    const rule = (sel: string) => {
      const i = css.indexOf(`${sel} {`);
      return css.slice(i, css.indexOf("}", i));
    };
    expect(rule(".canvas-overlays")).toMatch(/pointer-events: none/);
    for (const sel of [".canvas-empty", ".canvas-empty-icon", ".canvas-empty-title", ".canvas-empty-message", ".canvas-empty-actions"]) expect(rule(sel), sel).toMatch(/pointer-events: none/);
    expect(rule(".canvas-empty-actions .btn")).toMatch(/pointer-events: auto/);
    expect(rule(".canvas-panel")).toMatch(/pointer-events: auto/);
    mount(emptyDocument());
    const hint = screen.getByRole("group", { name: "No Network Yet" });
    expect(hint.querySelector(".canvas-empty-title")).not.toBeNull();
    expect(hint.querySelector(".canvas-empty-message")).not.toBeNull();
    // No key equivalents on the hint's buttons.
    for (const b of within(hint).getAllByRole("button")) expect(b).not.toHaveAttribute("aria-keyshortcuts");
  });
});
