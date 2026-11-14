// The results overlay on a real canvas (CanvasView against the preview's replay of 0.90.34's own
// runs, golden/runs/): badges, rings and the bottleneck; the legend chip and its menu; the View
// menu and its commands; staleness after an edit; the run picked in the Results pane; zoom, pan
// and a drag; Reduce Motion; and the diagram export.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockFingerprint } from "../../dev/mock/results";
import { mockRuns } from "../../dev/mock/runs";
import { editorFor, type Editor } from "../../editor";
import { getCommand, runCommand, titleOf } from "../../lib/commands";
import { getStateValue, loadKv, resetKv } from "../../lib/kv";
import { resolveMenu, shortcutFor, type MenuNode } from "../../lib/menu";
import { MENU_SPEC, type SpecEntry } from "../../lib/menuSpec";
import { ResultsPane } from "../../panes/results/ResultsPane";
import { asResult } from "../../panes/results/model";
import { STATION_METRICS } from "../../results/insight";
import { resetSelectedRuns, selectedRunFor, setSelectedRun } from "../../results/selectedRun";
import { onRunFinished, resetRuns, resultsFor, startRun } from "../../runs/state";
import { extendMock, mockCalls, mockTauri } from "../../test/tauri";
import { addTab } from "../../workspace/store";
import { CanvasView } from "../CanvasView";
import { buildFigure } from "../export/figure";
import { DEFAULT_OPTIONS } from "../export/options";
import { toDisplay } from "../geometry/transform";
import { canvasColors } from "../layers/colors";
import { SceneLayers } from "../layers/SceneLayers";
import { quietView, sceneOf } from "../layers/testkit";
import { BADGE_HEIGHT, BADGE_MIN_SCALE, INTERVAL_MIN_SCALE, STALE_OPACITY } from "./ResultsLayer";
import { COLOR_COMMAND, metricCommand, overlayCommands, SHOW_COMMAND } from "./commands";
import { overlayModel } from "./model";
import { COLOR_KEY, METRIC_KEY, SHOW_KEY } from "./state";
import { shownResults } from "./useResultsOverlay";
import canvasCss from "../canvas.css?raw";
import overlayCss from "./overlay.css?raw";

const examples = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

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
  // Live Results (src/live/) is off here: these are the recorded-run overlay's tests, and live values would stand in after an edit.
  mockTauri(defaultHandlers({ state: { "canvas.live.show": false } }));
  mockRuns.replayMs = 1;
  resetKv();
  resetRuns();
  resetSelectedRuns();
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

function openExample(stem: string): string {
  let id = "";
  act(() => {
    id = addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: { infiniteBuffers: false, ...JSON.parse(examples[`../../../examples/${stem}.bnet`]), canvasScale: 1, canvasPanOffset: [0, 0] } });
  });
  return id;
}

async function run(id: string, method: string) {
  const done = new Promise<void>((resolve) => {
    const stop = onRunFinished(() => {
      stop();
      resolve();
    });
  });
  await act(async () => {
    expect(await startRun(id, method)).toBe(true);
    await done;
  });
  await settle();
  await settle();
}

async function mount(stem = "5stationtandem.inf", withPane = false) {
  const id = openExample(stem);
  const editor = editorFor(id);
  render(
    <>
      <CanvasView editor={editor} />
      {withPane && <ResultsPane />}
    </>,
  );
  await settle();
  return { id, editor, surface: screen.getByRole("application", { name: "Network canvas" }) };
}

const layer = () => document.querySelector('[data-layer="results"]');
const badges = () => [...document.querySelectorAll("[data-result]")] as SVGGElement[];
const badgeOf = (editor: Editor, name: string) => document.querySelector(`[data-result="${editor.nodes.find((n) => n.name === name)!.id}"]`) as SVGGElement;
/** The badge as it reads: "90.1 ± 0.3 %" (the interval sits between the number and its unit). */
const value = (g: Element) => {
  const part = (p: string) => g.querySelector(`[data-part="result-${p}"]`);
  if (!part("value")) return null;
  return [part("value"), part("interval"), part("unit")].filter((e) => e).sort((a, b) => Number(a!.getAttribute("x")) - Number(b!.getAttribute("x"))).map((e) => e!.textContent).join(" ");
};
const legend = () => screen.queryByRole("button", { name: "Results on canvas" });
const stateOf = (key: string) => getStateValue<unknown>(key, undefined);

describe("a tab's first run", () => {
  it("shows nothing before it: no layer, no legend, and no fingerprint asked", async () => {
    await mount();
    expect(layer()).toBeNull();
    expect(legend()).toBeNull();
    expect(mockCalls.some((c) => c.cmd === "results_fingerprint")).toBe(false);
  });

  it("puts a value badge and a ring on every station, on by default, and names metric, method and tier in the legend", async () => {
    const { id, editor } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(layer()).toHaveAttribute("aria-label", "Results on canvas: Utilization, QNA, Approximation");
    const stations = editor.nodes.filter((n) => n.kind === "station");
    expect(badges()).toHaveLength(stations.length);
    // Sources and sinks carry nothing: no run reports a value for them.
    for (const n of editor.nodes.filter((x) => x.kind !== "station")) expect(document.querySelector(`[data-result="${n.id}"]`)).toBeNull();
    const s1 = badgeOf(editor, "S1");
    expect(value(s1)).toBe("90.0 %");
    expect(s1.querySelector('[data-part="result-interval"]')).toBeNull();
    expect(s1.querySelector('[data-part="result-ring"]')).toHaveAttribute("stroke", expect.stringMatching(/^#[0-9a-f]{6}$/));
    expect(s1).toHaveAttribute("role", "img");
    expect(s1.querySelector("title")!.textContent).toContain("S1 · Utilization: 90.0000 %");
    expect(s1.querySelector("title")!.textContent).toContain("QNA · Approximation");
    expect(legend()).toHaveTextContent("Utilization · QNA · Approximation");
    expect(legend()).toHaveAttribute("aria-haspopup", "menu");
  });

  it("marks the bottleneck with a marker and the word", async () => {
    const { id } = await mount();
    await run(id, "inf_sim");
    await waitFor(() => expect(layer()).not.toBeNull());
    const marked = badges().filter((b) => b.hasAttribute("data-bottleneck"));
    expect(marked).toHaveLength(1);
    expect(marked[0].querySelector('[data-part="bottleneck"]')).not.toBeNull();
    expect(marked[0].getAttribute("aria-label")).toContain("Bottleneck");
    expect(screen.getAllByRole("img", { name: /Bottleneck/ })).toHaveLength(1);
    expect(marked[0].querySelector("title")!.textContent).toContain("Bottleneck: the highest utilisation in this run.");
    // A simulation gives an interval, drawn as ± beside the value.
    expect(marked[0].querySelector('[data-part="result-interval"]')!.textContent).toMatch(/^± \d/);
  });

  it("moves to better evidence when a better method has run", async () => {
    const { id, editor } = await mount();
    await run(id, "qna");
    await run(id, "product_form");
    await waitFor(() => expect(legend()).toHaveTextContent("Utilization · Product Form · Exact"));
    expect(value(badgeOf(editor, "S1"))).toBe("90.0 %");
  });
});

describe("following the network", () => {
  it("dims the values and says the network changed after an edit, rather than dropping them", async () => {
    const { id, editor } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(layer()).not.toHaveAttribute("data-stale");
    const s2 = editor.nodes.find((n) => n.name === "S2")!;
    await act(async () => {
      editor.updateNumberOfServers(s2.id, 2);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(layer()).toHaveAttribute("data-stale"));
    expect(badges()).toHaveLength(5);
    expect(value(badgeOf(editor, "S1"))).toBe("90.0 %");
    for (const b of badges()) {
      expect(b).toHaveAttribute("opacity", String(STALE_OPACITY));
      expect(b.querySelector('[data-part="result-ring"]')).toHaveAttribute("stroke-dasharray");
      expect(b.getAttribute("aria-label")).toContain("Network changed since this run");
    }
    expect(legend()).toHaveTextContent("Network changed since this run");
    expect(legend()).toHaveAttribute("title", expect.stringContaining("earlier version of the network"));
    // The export carries no such note, so it leaves stale values out.
    expect(shownResults(id)).toBeUndefined();
    // Back to the network the run was made from (the preview's replayed records keep 0.90.34's
    // snapshot, so a re-run here cannot stand in for one): current again.
    await act(async () => {
      editor.updateNumberOfServers(s2.id, 1);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(layer()).not.toHaveAttribute("data-stale"));
    expect(legend()).not.toHaveTextContent("Network changed");
  });

  it("shows the run picked in the Results pane, and the best one again after the next run", async () => {
    const { id, editor } = await mount("5stationtandem.inf", true);
    await run(id, "product_form");
    await run(id, "inf_sim");
    await waitFor(() => expect(legend()).toHaveTextContent("Product Form · Exact"));
    const rows = [...document.querySelectorAll(".results-run")] as HTMLElement[];
    const sim = rows.find((r) => r.textContent!.includes("Monte Carlo"))!;
    fireEvent.click(sim);
    await waitFor(() => expect(legend()).toHaveTextContent("Utilization · Monte Carlo · Simulation"));
    expect(selectedRunFor(id)).not.toBeNull();
    expect(value(badgeOf(editor, "S1"))).toBe("90.1 ± 0.3 %");
    // The legend's menu offers the way back.
    fireEvent.click(legend()!);
    fireEvent.click(within(screen.getByRole("menu")).getByText("Show the Best Current Run"));
    await waitFor(() => expect(legend()).toHaveTextContent("Product Form · Exact"));
    // A pick ends when the tab's next run finishes.
    act(() => setSelectedRun(id, resultsFor(id).map(asResult).find((r) => r.method.shortName === "Monte Carlo")!.id));
    await waitFor(() => expect(legend()).toHaveTextContent("Monte Carlo"));
    await run(id, "qna");
    expect(selectedRunFor(id)).toBeNull();
    await waitFor(() => expect(legend()).toHaveTextContent("Product Form · Exact"));
  });
});

describe("View ▸ Results on Canvas", () => {
  const find = (nodes: MenuNode[], label: string): MenuNode | undefined => {
    for (const n of nodes) {
      if (n.type === "submenu") {
        if (n.label === label) return n;
        const hit = find(n.items, label);
        if (hit) return hit;
      }
    }
    return undefined;
  };

  it("is one submenu of the View menu: Show/Hide with ⌥⌘R, the five metrics, Color Stations", async () => {
    await mount();
    const view = MENU_SPEC.find((e): e is Extract<SpecEntry, { submenu: string }> => e !== "-" && "submenu" in e && e.submenu === "View")!;
    const sub = view.items.find((e): e is Extract<SpecEntry, { submenu: string }> => e !== "-" && "submenu" in e && e.submenu === "Results on Canvas")!;
    const ids = sub.items.filter((e): e is Extract<SpecEntry, { id: string }> => e !== "-" && "id" in e).map((e) => e.id);
    expect(ids).toEqual([SHOW_COMMAND, ...STATION_METRICS.map(metricCommand), COLOR_COMMAND]);
    expect(sub.items.filter((e): e is Extract<SpecEntry, { id: string }> => e !== "-" && "id" in e).slice(1, 6).map((e) => e.label)).toEqual([...STATION_METRICS]);
    // Every id is a registered command while the canvas is mounted, so no item is dimmed.
    for (const cmd of overlayCommands()) expect(getCommand(cmd.id), cmd.id).toBeDefined();
    expect(ids.every((i) => getCommand(i))).toBe(true);
    expect(shortcutFor(SHOW_COMMAND)).toBe("⌥⌘R");
    const resolved = find(resolveMenu(), "Results on Canvas") as Extract<MenuNode, { type: "submenu" }>;
    const items = resolved.items.filter((n): n is Extract<MenuNode, { type: "item" }> => n.type === "item");
    expect(items.every((i) => i.enabled)).toBe(true);
    expect(items[0].label).toBe("Hide Results on Canvas");
    expect(items.find((i) => i.label === "Utilization")).toMatchObject({ checked: true });
    expect(items.find((i) => i.label === "Color Stations")).toMatchObject({ checked: true });
  });

  it("gives no other menu item the same key", () => {
    const accels: string[] = [];
    const walk = (entries: SpecEntry[]) => {
      for (const e of entries) {
        if (e === "-") continue;
        if ("items" in e) walk(e.items);
        else if ("accel" in e && e.accel) accels.push(e.accel.toLowerCase());
      }
    };
    walk(MENU_SPEC);
    expect(accels.filter((a) => a === "cmdorctrl+alt+r")).toHaveLength(1);
  });

  it("hides and shows the overlay, and the title says which it will do", async () => {
    const { id } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(titleOf(getCommand(SHOW_COMMAND)!)).toBe("Hide Results on Canvas");
    await act(async () => void (await runCommand(SHOW_COMMAND)));
    await waitFor(() => expect(layer()).toBeNull());
    expect(legend()).toBeNull();
    expect(stateOf(SHOW_KEY)).toBe(false);
    expect(titleOf(getCommand(SHOW_COMMAND)!)).toBe("Show Results on Canvas");
    expect(shownResults(id)).toBeUndefined();
    await act(async () => void (await runCommand(SHOW_COMMAND)));
    await waitFor(() => expect(layer()).not.toBeNull());
  });

  it("changes the metric (which also shows a hidden overlay) and checks the one in use", async () => {
    const { id, editor } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    await act(async () => void (await runCommand(SHOW_COMMAND)));
    await act(async () => void (await runCommand(metricCommand("Mean number in system"))));
    await waitFor(() => expect(legend()).toHaveTextContent("Mean number in system · QNA · Approximation"));
    expect(stateOf(METRIC_KEY)).toBe("Mean number in system");
    expect(stateOf(SHOW_KEY)).toBe(true);
    expect(value(badgeOf(editor, "S1"))).toBe("9.000 customers");
    expect(getCommand(metricCommand("Mean number in system"))!.checked!()).toBe(true);
    expect(getCommand(metricCommand("Utilization"))!.checked!()).toBe(false);
    expect(layer()).toHaveAttribute("data-metric", "Mean number in system");
  });

  it("Color Stations takes the rings and swatches away and leaves the numbers", async () => {
    const { id } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(document.querySelectorAll('[data-part="result-ring"]')).toHaveLength(5);
    expect(document.querySelector(".canvas-results-ramp")).not.toBeNull();
    await act(async () => void (await runCommand(COLOR_COMMAND)));
    await waitFor(() => expect(document.querySelectorAll('[data-part="result-ring"]')).toHaveLength(0));
    expect(document.querySelectorAll('[data-part="result-swatch"]')).toHaveLength(0);
    expect(document.querySelector(".canvas-results-ramp")).toBeNull();
    expect(badges()).toHaveLength(5);
    expect(stateOf(COLOR_KEY)).toBe(false);
    expect(getCommand(COLOR_COMMAND)!.checked!()).toBe(false);
  });

  it("the legend chip is the same menu: metrics a run reports, Color Stations, Hide", async () => {
    const { id } = await mount();
    await run(id, "product_form");
    await waitFor(() => expect(legend()).not.toBeNull());
    fireEvent.click(legend()!);
    const menu = screen.getByRole("menu", { name: "Results on canvas options" });
    const labels = [...menu.querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent);
    expect(labels.slice(0, 5)).toEqual([...STATION_METRICS]);
    expect(labels).toContain("Color Stations");
    expect(labels.at(-1)).toMatch(/^Hide Results on Canvas/);
    // Product Form reports no sojourn time: that choice is dimmed rather than leading nowhere.
    const sojourn = within(menu).getByText("Mean sojourn time").closest(".ctx-item")!;
    expect(sojourn.className).toContain("disabled");
    fireEvent.click(within(menu).getByText("Throughput"));
    await waitFor(() => expect(legend()).toHaveTextContent("Throughput · Product Form · Exact"));
    fireEvent.click(legend()!);
    fireEvent.click(within(screen.getByRole("menu")).getByText(/^Hide Results on Canvas/));
    await waitFor(() => expect(legend()).toBeNull());
  });
});

describe("zoom, pan and drag", () => {
  const rect = (g: Element) => {
    const r = g.querySelector('[data-part="result-badge"] rect')!;
    return { x: Number(r.getAttribute("x")), y: Number(r.getAttribute("y")), w: Number(r.getAttribute("width")), h: Number(r.getAttribute("height")) };
  };

  it("keeps the badge the same size on screen from 45 % to 400 %, sitting just above its node", async () => {
    const { id, editor } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    const sizes: { w: number; h: number }[] = [];
    for (const scale of [BADGE_MIN_SCALE, 1, 2, 4]) {
      act(() => editor.setView({ canvasScale: scale, canvasPanOffset: { width: 40, height: 60 } }));
      const g = badgeOf(editor, "S3");
      const r = rect(g);
      sizes.push({ w: r.w, h: r.h });
      expect(g.querySelector('[data-part="result-value"]')).toHaveAttribute("font-size", "10");
      // Centred over the node, its bottom 10 pt above the body's top, in the layer's (pan-relative) coordinates.
      const node = editor.nodes.find((n) => n.name === "S3")!;
      const d = toDisplay(editor.canvasTransform, { x: node.position[0], y: node.position[1] });
      expect(r.x + r.w / 2).toBeCloseTo(d.x - 40, 2);
      expect(r.y + r.h).toBeCloseTo(d.y - 60 - 24 * scale - 10, 2);
    }
    expect(new Set(sizes.map((s) => `${s.w}x${s.h}`)).size).toBe(1);
    expect(sizes[0].h).toBe(BADGE_HEIGHT);
  });

  it("drops the ± below 80 % so neighbouring badges do not meet, keeping the value and unit", async () => {
    const { id, editor } = await mount();
    await run(id, "inf_sim");
    await waitFor(() => expect(layer()).not.toBeNull());
    act(() => editor.setView({ canvasScale: INTERVAL_MIN_SCALE }));
    expect(value(badgeOf(editor, "S2"))).toMatch(/^\d+\.\d ± \d+\.\d %$/);
    act(() => editor.setView({ canvasScale: 0.6 }));
    expect(value(badgeOf(editor, "S2"))).toMatch(/^\d+\.\d %$/);
    expect(badgeOf(editor, "S2").querySelector("title")!.textContent).toContain("interval");
  });

  it("below 45 % drops the numbers and keeps the rings and the bottleneck's marker", async () => {
    const { id, editor } = await mount();
    await run(id, "inf_sim");
    await waitFor(() => expect(layer()).not.toBeNull());
    act(() => editor.setView({ canvasScale: 0.25 }));
    expect(document.querySelectorAll('[data-part="result-value"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-part="result-ring"]')).toHaveLength(5);
    expect(document.querySelectorAll('[data-part="result-badge"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-part="bottleneck"]')).toHaveLength(1);
    // The value is still there for a pointer or a screen reader.
    expect(badges()[0].querySelector("title")!.textContent).toContain("Utilization");
  });

  it("pans with the node layer through the same transform, re-rendering no badge", async () => {
    const { id, editor } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    const before = badges().map((b) => b.outerHTML);
    act(() => editor.setView({ canvasPanOffset: { width: -137, height: 52 } }));
    expect(layer()).toHaveAttribute("transform", "translate(-137 52)");
    expect(document.querySelector('[data-layer="nodes"]')).toHaveAttribute("transform", "translate(-137 52)");
    expect(badges().map((b) => b.outerHTML)).toEqual(before);
  });

  it("a dragged node takes its badge with it, moves no other badge, and asks nothing of the backend per frame", async () => {
    const { id, editor, surface } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    const s2 = editor.nodes.find((n) => n.name === "S2")!;
    const from = toDisplay(editor.canvasTransform, { x: s2.position[0], y: s2.position[1] });
    const others = () => badges().filter((b) => b.getAttribute("data-result") !== s2.id).map((b) => b.outerHTML);
    const stillOthers = others();
    const start = rect(badgeOf(editor, "S2"));
    const calls = vi.fn();
    extendMock({ results_fingerprint: ({ document }: { document: Parameters<typeof mockFingerprint>[0] }) => (calls(), mockFingerprint(document)) });
    fireEvent.pointerDown(surface, { clientX: from.x, clientY: from.y, button: 0, buttons: 1, pointerId: 1 });
    for (let i = 1; i <= 6; i++) fireEvent.pointerMove(surface, { clientX: from.x + 14 * i, clientY: from.y + 14 * i, buttons: 1, pointerId: 1 });
    await settle();
    expect(editor.view.isDraggingNode).toBe(true);
    const mid = rect(badgeOf(editor, "S2"));
    expect(mid.x).toBeGreaterThan(start.x + 40);
    expect(mid.y).toBeGreaterThan(start.y + 40);
    expect(others()).toEqual(stillOthers);
    expect(calls).not.toHaveBeenCalled();
    // Still the run's values, not yet stale: the question is asked once, when the drag ends.
    expect(layer()).not.toHaveAttribute("data-stale");
    fireEvent.pointerUp(surface, { clientX: from.x + 84, clientY: from.y + 84, button: 0, buttons: 0, pointerId: 1 });
    await settle();
    await settle();
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("Reduce Motion", () => {
  it("the only motion is the canvas's own fade, which Reduce Motion switches off", async () => {
    const { id } = await mount();
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    for (const b of badges()) expect(b).toHaveClass("canvas-appear");
    expect(legend()).toHaveClass("canvas-appear");
    expect(canvasCss).toMatch(/:root\[data-motion="reduce"\] \.canvas-appear \{ animation: none; \}/);
    expect(canvasCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\}\s*:root:not\(\[data-motion\]\) \.canvas-appear \{ animation: none; \}|prefers-reduced-motion: reduce[\s\S]*?\.canvas-appear \{ animation: none; \}/);
    expect(overlayCss).not.toMatch(/\b(transition|animation)\s*:/);
  });
});

describe("the diagram export", () => {
  it("draws the overlay when it is on and current, standing alone, and is unchanged when it is off", async () => {
    const { id, editor } = await mount();
    const plain = buildFigure(editor, { options: DEFAULT_OPTIONS, opaqueFallback: false })!.svg;
    await run(id, "qna");
    await waitFor(() => expect(layer()).not.toBeNull());
    const withResults = buildFigure(editor, { options: DEFAULT_OPTIONS, opaqueFallback: false })!.svg;
    expect(withResults).toContain('data-layer="results"');
    expect(withResults).toContain(">90.0</text>");
    expect(withResults).toContain(">%</text>");
    expect(withResults).not.toMatch(/var\(--/);
    expect(withResults.slice(withResults.indexOf('data-layer="results"'))).not.toMatch(/<title>|role="img"|aria-label|canvas-appear/);
    // The badge of the topmost station lies inside the figure.
    const tops = [...withResults.matchAll(/data-part="result-badge"><rect x="([-\d.]+)" y="([-\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(tops.length).toBe(5);
    for (const [x, y] of tops) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
    await act(async () => void (await runCommand(SHOW_COMMAND)));
    await waitFor(() => expect(layer()).toBeNull());
    const strip = (s: string) => s.replace(/_r_[\w-]+?-/g, "").replace(/id="[^"]*"|url\(#[^)]*\)/g, "");
    expect(strip(buildFigure(editor, { options: DEFAULT_OPTIONS, opaqueFallback: false })!.svg)).toBe(strip(plain));
  });

  it("renders on the server in the light colours, the same in a dark session", async () => {
    const id = openExample("5stationtandem.inf");
    await run(id, "qna");
    const doc = editorFor(id).document;
    const records = resultsFor(id).map(asResult);
    const model = overlayModel({ records, fingerprint: records[0].provenance.networkFingerprint, metric: "Utilization", decimals: 6 })!;
    const svg = () => renderToStaticMarkup(<SceneLayers scene={sceneOf(doc)} view={quietView()} colors={canvasColors("light")} infiniteBuffers snapshot results={{ model, color: true }} />).replace(/_r_[\w-]+?-/g, "");
    document.documentElement.setAttribute("data-theme", "dark");
    const dark = svg();
    document.documentElement.removeAttribute("data-theme");
    expect(svg()).toBe(dark);
    expect(dark).toContain('data-layer="results"');
    expect(dark).not.toMatch(/var\(--|currentColor/);
  });
});
