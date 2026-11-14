// The canvas drawing against 0.90.34's NetworkCanvasLayers.swift, rendered for real examples:
// shapes, label rows by zoom, chips and their declutter, link colours, ρ badges, rings, the
// marquee, guides, the pending ring and ghost, accessibility, and snapshot mode.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BnetDocument, BnetLink, BnetNode } from "../../lib/bnet";
import { NO_GUIDES } from "../../editor/editor";
import { exitDistance, labelBlockHeight, outlineContains, outlineSize } from "../geometry/outline";
import { canvasColors, classColor } from "./colors";
import { guidePath } from "./GuideLayer";
import { detailText, nodeDescription, nodeTooltip, rateText, rhoTooltip } from "./labels";
import { SceneLayers, type SceneLayersProps } from "./SceneLayers";
import { truncate, textWidth } from "./text";
import { byName, example, EXAMPLE_NAMES, linkBetween, quietView, sceneOf } from "./testkit";

const light = canvasColors("light");

function draw(doc: BnetDocument, p: Partial<SceneLayersProps> & { scale?: number; pan?: [number, number] } = {}) {
  const scene = p.scene ?? sceneOf(doc, p.scale ?? 1, p.pan ?? [0, 0]);
  const utils = render(<SceneLayers scene={scene} view={p.view ?? quietView()} colors={p.colors ?? light} infiniteBuffers={doc.infiniteBuffers} {...p} />);
  const svg = utils.container.querySelector("svg")!;
  const node = (doc2: BnetDocument, name: string) => svg.querySelector(`[data-node="${byName(doc2, name).id}"]`)!;
  const link = (l: BnetLink) => svg.querySelector(`[data-link="${l.id}"]`);
  return { ...utils, svg, node: (name: string) => node(doc, name), link, scene };
}

const rows = (g: Element) => [...g.querySelectorAll('[data-part="labels"] text')].map((t) => [t.getAttribute("data-part"), t.textContent]);

function doc(nodes: Partial<BnetNode>[], links: Partial<BnetLink>[] = [], infiniteBuffers = false): BnetDocument {
  return {
    infiniteBuffers,
    canvasScale: 1,
    canvasPanOffset: [0, 0],
    nodes: nodes.map((n, i) => ({ id: `N${i}`, kind: "station", name: `S${i + 1}`, position: [100 + 120 * i, 200], bufferSize: 1, distribution: "exponential", distributionParameters: "rate=1.0", numberOfServers: 1, serviceDistributions: {}, picture: "", ...n })) as BnetNode[],
    links: links.map((l, i) => ({ id: `L${i}`, fromNodeID: "N0", toNodeID: "N1", routingProbability: 1, customerClass: 0, ...l })) as BnetLink[],
  };
}

describe("every shipped example draws", () => {
  it.each(EXAMPLE_NAMES)("%s: one shape per node, one stroke and arrow per visible link", (name) => {
    const d = example(name);
    const { svg, scene } = draw(d);
    expect(svg.querySelectorAll("[data-node]")).toHaveLength(d.nodes.length);
    expect(svg.querySelectorAll('[data-link] [data-part="stroke"]')).toHaveLength(scene.links.length);
    expect(svg.querySelectorAll('[data-link] [data-part="arrow"]')).toHaveLength(scene.links.length);
    for (const n of d.nodes) expect(svg.querySelector(`[data-node="${n.id}"]`)!.getAttribute("data-kind")).toBe(n.kind);
  });
});

describe("node kinds and shapes (CAN-021…CAN-028)", () => {
  const d = example("2dtandem.bnet");

  it("draws the four kinds at their world sizes × scale, stroke max(1, 2·scale)", () => {
    expect([outlineSize("station"), outlineSize("buffer"), outlineSize("source"), outlineSize("sink")]).toEqual([
      { width: 48, height: 48 },
      { width: 52, height: 44 },
      { width: 46, height: 46 },
      { width: 48, height: 48 },
    ]);
    const { node } = draw(d, { scale: 2 });
    const station = node("S1").querySelector('[data-part="body"] path')!;
    // A circle of radius 48 (2 × 24) as two arcs, stroke 4.
    expect(station.getAttribute("d")).toMatch(/A48 48 0 1 0/);
    expect(station.getAttribute("stroke-width")).toBe("4");
    const source = node("Src1").querySelector('[data-part="body"]')!;
    expect(source.getAttribute("d")!.match(/L/g)).toHaveLength(3); // a diamond
    const sink = node("Sink1").querySelector('[data-part="body"]')!;
    expect(sink.getAttribute("d")).toMatch(/A16 16 0 0 1/); // corner radius 8 × scale
    const { node: n2 } = draw(d, { scale: 0.25 });
    expect(n2("S1").querySelector('[data-part="body"] path')!.getAttribute("stroke-width")).toBe("1");
  });

  it("hangs label blocks of 36 / 36 / 24 / 13 world pt under station, source, buffer, sink", () => {
    expect((["station", "source", "buffer", "sink"] as const).map(labelBlockHeight)).toEqual([36, 36, 24, 13]);
  });

  it("contains points by the exact shape, with a uniform slop, and finds the outline by bisection", () => {
    expect(outlineContains("station", { x: 24, y: 0 })).toBe(true);
    expect(outlineContains("station", { x: 17.5, y: 17.5 })).toBe(false);
    expect(outlineContains("source", { x: 11.5, y: 11.5 })).toBe(true);
    expect(outlineContains("source", { x: 12, y: 12 })).toBe(false);
    expect(outlineContains("sink", { x: 23.5, y: 23.5 })).toBe(false); // the rounded corner
    expect(outlineContains("sink", { x: 23.5, y: 23.5 }, 3)).toBe(true);
    expect(exitDistance("station", { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(24, 2);
    expect(exitDistance("buffer", { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(22, 2);
  });

  it("fills each kind with its token, borders in node stroke, accent when selected, accent 35 % when the pending link start", () => {
    const { node } = draw(d, { view: quietView({ selectedNodeID: byName(d, "S2").id, tool: "addLink", pendingLinkStartID: byName(d, "B1").id }) });
    const body = (n: string) => node(n).querySelector('[data-part="body"]')!;
    expect(body("S1").querySelector("path")!.getAttribute("fill")).toBe(light.stationFill);
    expect(body("S1").querySelector("path")!.getAttribute("stroke")).toBe(light.nodeStroke);
    expect(body("S2").querySelector("path")!.getAttribute("stroke")).toBe(light.accent);
    expect(body("Src1").getAttribute("fill")).toBe(light.sourceFill);
    expect(body("Sink1").getAttribute("fill")).toBe(light.sinkFill);
    expect(body("B1").querySelector("path")!.getAttribute("fill")).toBe(light.selectionFillStrong);
    expect(body("B2").querySelector("path")!.getAttribute("fill")).toBe(light.bufferFill);
  });

  it("draws a buffer with dividers at ⅓ and ⅔, open on the left and filled on the right ⅔ only when buffers are infinite", () => {
    const finite = draw(d).node("B1").querySelector('[data-part="body"]')!;
    const [fill, outline] = [...finite.querySelectorAll("path")].map((p) => p.getAttribute("d")!);
    const c = byName(d, "B1").position;
    expect(outline.split("M")).toHaveLength(4); // box, two dividers
    expect(outline).toMatch(/Z/);
    expect(fill.startsWith(`M${Math.round((c[0] - 26) * 1000) / 1000} `)).toBe(true);
    const inf = { ...d, infiniteBuffers: true };
    const open = draw(inf).node("B1").querySelector('[data-part="body"]')!;
    const [fill2, outline2] = [...open.querySelectorAll("path")].map((p) => p.getAttribute("d")!);
    expect(outline2).not.toMatch(/Z/);
    const x0 = Math.round((c[0] - 26 + 52 / 3) * 1000) / 1000;
    expect(fill2.startsWith(`M${x0} `)).toBe(true);
  });

  it("inscribes a station's picture as its lucide icon, 0.18 × width from the stroke", () => {
    const d5 = example("5stationtandem.inf.bnet");
    const { node } = draw(d5);
    const pic = node("S1").querySelector('[data-part="picture"]')!;
    expect(pic.getAttribute("data-picture")).toBe("person.fill");
    expect(Number(pic.getAttribute("width"))).toBeCloseTo(48 * 0.64, 3);
    expect(pic.getAttribute("stroke")).toBe(light.nodeGlyph);
    expect(node("S3").querySelector('[data-part="picture"]')!.getAttribute("data-picture")).toBe("cpu.fill");
    expect(node("S2").querySelector('[data-part="picture"]')).toBeNull();
  });

  it("rings a hovered or marquee-candidate node 6 pt out, a selected one 8 pt out with a glow, and never both", () => {
    const s1 = byName(d, "S1");
    const { node } = draw(d, { view: quietView({ hoveredNodeID: s1.id }) });
    const ring = (n: string, part: string) => node(n).querySelector(`[data-part="${part}"]`)!;
    expect(ring("S1", "hover-ring").getAttribute("opacity")).toBe("1");
    expect(ring("S1", "hover-ring").getAttribute("d")).toMatch(/A27 27 /);
    expect(ring("S1", "selection-ring").getAttribute("opacity")).toBe("0");
    const sel = draw(d, { view: quietView({ hoveredNodeID: s1.id, selectedNodeIDs: new Set([s1.id]) }) });
    const r2 = (part: string) => sel.node("S1").querySelector(`[data-part="${part}"]`)!;
    expect(r2("hover-ring").getAttribute("opacity")).toBe("0");
    expect(r2("selection-ring").getAttribute("opacity")).toBe("1");
    expect(r2("selection-ring").getAttribute("d")).toMatch(/A28 28 /);
    expect(r2("selection-ring").getAttribute("filter")).toMatch(/^url\(#.*-glow\)$/);
    expect(r2("selection-ring").getAttribute("stroke-width")).toBe("1.5");
  });
});

describe("label rows by zoom (CAN-030…CAN-032, CAN-034, CAN-135…CAN-140)", () => {
  const d = example("2dtandem.bnet");

  it("shows name, distribution and rates at zoom 1, in the clamped sizes", () => {
    const { node } = draw(d);
    expect(rows(node("S1"))).toEqual([["name", "S1"], ["detail", "Deterministic"], ["rates", "μ=1 · SCV=0"]]);
    expect(rows(node("S2"))).toEqual([["name", "S2"], ["detail", "Exponential"], ["rates", "μ=1 · SCV=1"]]);
    expect(rows(node("Src1"))).toEqual([["name", "Src1"], ["detail", "Poisson"], ["rates", "λ=1 · SCV=1"]]);
    expect(rows(node("B1"))).toEqual([["name", "B1"], ["detail", "b=24"]]);
    expect(rows(node("Sink1"))).toEqual([["name", "Sink1"]]);
    const name = node("S1").querySelector('[data-part="name"]')!;
    expect(name.getAttribute("font-size")).toBe("10");
    expect(name.getAttribute("font-weight")).toBe("600");
    expect(node("S1").querySelector('[data-part="detail"]')!.getAttribute("font-size")).toBe("8");
    expect(node("S1").querySelector('[data-part="rates"]')!.getAttribute("font-weight")).toBe("500");
    expect(draw(d, { scale: 3 }).node("S1").querySelector('[data-part="name"]')!.getAttribute("font-size")).toBe("13");
  });

  it("drops the rate row below 0.6, the detail row below 0.45 and the name below 0.35 unless hovered or selected", () => {
    expect(rows(draw(d, { scale: 0.59 }).node("S1"))).toEqual([["name", "S1"], ["detail", "Deterministic"]]);
    expect(rows(draw(d, { scale: 0.44 }).node("S1"))).toEqual([["name", "S1"]]);
    expect(rows(draw(d, { scale: 0.34 }).node("S1"))).toEqual([]);
    const s1 = byName(d, "S1").id;
    expect(rows(draw(d, { scale: 0.2, view: quietView({ hoveredNodeID: s1 }) }).node("S1"))).toEqual([["name", "S1"]]);
    expect(rows(draw(d, { scale: 0.2, view: quietView({ selectedNodeID: s1 }) }).node("S1"))).toEqual([["name", "S1"]]);
  });

  it("hangs the block 4 pt under the body and truncates a long name in the middle to max(56, 76·min(scale, 1.4))", () => {
    const long = doc([{ name: "Final assembly and inspection line" }]);
    const t = draw(long).svg.querySelector('[data-part="name"]')!;
    expect(t.textContent).toContain("…");
    expect(t.textContent!.startsWith("Final")).toBe(true);
    expect(t.textContent!.endsWith("line")).toBe(true);
    expect(textWidth(t.textContent!, 10, 600)).toBeLessThanOrEqual(76);
    expect(truncate("abcdefghijklmnopqrstuvwxyz", 40, 10, 400, "tail").endsWith("…")).toBe(true);
    expect(truncate("S1", 56, 9, 600, "middle")).toBe("S1");
    // Baseline of the first row: body bottom + 4 + 0.95 × size.
    expect(Number(t.getAttribute("y"))).toBeCloseTo(200 + 24 + 4 + 9.5, 3);
  });

  it("words the detail row as 0.90.34 did: b=N in finite mode only, c=N for servers, Multi-class", () => {
    const base = doc([{ kind: "buffer", bufferSize: 7 }, { numberOfServers: 3, distribution: "gamma", distributionParameters: "shape=2.0,scale=0.5" }, { serviceDistributions: { "0": { distribution: "exponential", distributionParameters: "rate=1" }, "1": { distribution: "exponential", distributionParameters: "rate=2" } } as never, numberOfServers: 2 }, { kind: "sink" }]);
    expect(detailText(base.nodes[0], false)).toBe("b=7");
    expect(detailText(base.nodes[0], true)).toBeNull();
    expect(detailText(base.nodes[1], false)).toBe("Gamma c=3");
    expect(rateText(base.nodes[1])).toBe("μ=1 · SCV=0.5");
    expect(detailText(base.nodes[2], false)).toBe("Multi-class c=2");
    expect(detailText(base.nodes[3], false)).toBeNull();
    expect(rateText(doc([{ distribution: "pareto", distributionParameters: "shape=1.5,scale=1" }]).nodes[0])).toBe("μ=0.3333");
    expect(rateText(doc([{ distribution: "weibull", distributionParameters: "shape=1.5,scale=1.0" }]).nodes[0])).toBe("μ=1.108 · SCV=0.461");
  });
});

describe("links (CAN-061, CAN-063, CAN-067…CAN-071)", () => {
  const oj = example("OpenJackson.d2.feedback.p30.inf.bnet");
  const loop = linkBetween(oj, "S1", "B1");
  const out = linkBetween(oj, "S1", "B2");

  it("strokes a link in its class colour at 0.75, butt caps and round joins, max(1, 2·scale) wide, the arrow filled the same", () => {
    const { link } = draw(oj);
    const stroke = link(out)!.querySelector('[data-part="stroke"]')!;
    expect(stroke.getAttribute("stroke")).toBe(classColor(light, 0));
    expect(stroke.getAttribute("stroke-opacity")).toBe("0.75");
    expect(stroke.getAttribute("stroke-width")).toBe("2");
    expect(stroke.getAttribute("stroke-linecap")).toBe("butt");
    expect(stroke.getAttribute("stroke-linejoin")).toBe("round");
    expect(link(out)!.querySelector('[data-part="arrow"]')!.getAttribute("fill")).toBe(classColor(light, 0));
  });

  it("thickens a hovered link ×1.5 (min 3) at full opacity; a selected one goes accent over a halo, drawn last", () => {
    const hov = draw(oj, { view: quietView({ hoveredLinkID: out.id }) });
    const s = hov.link(out)!.querySelector('[data-part="stroke"]')!;
    expect(s.getAttribute("stroke-width")).toBe("3");
    expect(s.getAttribute("stroke-opacity")).toBe("1");
    const sel = draw(oj, { view: quietView({ selectedLinkID: loop.id, hoveredLinkID: out.id }) });
    const g = sel.link(loop)!;
    expect(g.querySelector('[data-part="stroke"]')!.getAttribute("stroke")).toBe(light.accent);
    const halo = g.querySelectorAll("path")[0];
    expect(halo.getAttribute("stroke")).toBe(light.linkHalo);
    expect(halo.getAttribute("stroke-width")).toBe("9");
    expect(halo.getAttribute("stroke-linecap")).toBe("round");
    const order = [...sel.svg.querySelectorAll("[data-link]")].map((e) => e.getAttribute("data-link"));
    expect(order.slice(-2)).toEqual([out.id, loop.id]);
  });

  it("draws a class transition as a gradient from the entry colour at the start to the exit colour at the tip", () => {
    const bd = example("BanksDai96.d3.c9.spt.reentrant.inf.bnet");
    const t = bd.links.find((l) => l.toCustomerClass !== undefined && l.toCustomerClass !== l.customerClass)!;
    const { link, scene } = draw(bd);
    const g = link(t)!;
    const grad = g.querySelector("linearGradient")!;
    const stops = [...grad.querySelectorAll("stop")].map((s) => s.getAttribute("stop-color"));
    expect(stops).toEqual([classColor(light, t.customerClass), classColor(light, t.toCustomerClass!)]);
    const geo = scene.links.find((l) => l.id === t.id)!.geometry;
    expect(Number(grad.getAttribute("x1"))).toBeCloseTo(geo.start.x, 2);
    expect(Number(grad.getAttribute("x2"))).toBeCloseTo(geo.tip.x, 2);
    expect(g.querySelector('[data-part="arrow"]')!.getAttribute("fill")).toBe(`url(#${grad.id})`);
  });

  it("dims other classes to 0.20 while a chain from a source fixes the class, chips too", () => {
    const d3 = example("3d2cfin.bnet");
    const { svg } = draw(d3, { view: quietView({ tool: "addLink", activeLinkSourceID: d3.nodes.find((n) => n.kind === "source")!.id, activeCustomerClass: 1 }) });
    for (const l of d3.links) {
      const op = svg.querySelector(`[data-link="${l.id}"] [data-part="stroke"]`)!.getAttribute("stroke-opacity");
      expect(op).toBe(l.customerClass === 1 ? "0.75" : "0.2");
    }
  });

  it("puts a chip with 2 significant digits on every p ≠ 1, in surface with a separator hairline, and none at p = 1", () => {
    const { link } = draw(oj);
    const chip = link(loop)!.querySelector('[data-part="chip"]')!;
    expect(chip.querySelector("text")!.textContent).toBe("0.3");
    expect(link(out)!.querySelector('[data-part="chip"] text')!.textContent).toBe("0.7");
    expect(chip.querySelector("rect")!.getAttribute("fill")).toBe(light.chipFill);
    expect(chip.querySelector("rect")!.getAttribute("stroke")).toBe(light.separator);
    expect(chip.querySelector("rect")!.getAttribute("rx")).toBe("3");
    expect(chip.querySelector("text")!.getAttribute("fill")).toBe(light.textSecondary);
    expect(chip.querySelector("text")!.getAttribute("font-size")).toBe("9");
    expect(chip.querySelector("text")!.getAttribute("font-weight")).toBe("500");
    expect(draw(oj, { scale: 2 }).link(loop)!.querySelector('[data-part="chip"] text')!.getAttribute("font-size")).toBe("12");
    expect(link(linkBetween(oj, "B1", "S1"))!.querySelector('[data-part="chip"]')).toBeNull();
    // Hovered: the class colour; selected: the accent, stroke in the label colour.
    const h = draw(oj, { view: quietView({ hoveredLinkID: loop.id }) }).link(loop)!.querySelector('[data-part="chip"] text')!;
    expect(h.getAttribute("fill")).toBe(classColor(light, 0));
    const s = draw(oj, { view: quietView({ selectedLinkID: loop.id }) }).link(loop)!.querySelector('[data-part="chip"] rect')!;
    expect(s.getAttribute("stroke")).toBe(light.accent);
  });

  it("drops every chip below zoom 0.5", () => {
    expect(draw(oj, { scale: 0.49 }).svg.querySelectorAll('[data-part="chip"]')).toHaveLength(0);
    expect(draw(oj, { scale: 0.5 }).svg.querySelectorAll('[data-part="chip"]')).toHaveLength(2);
  });

  it("declutters overlapping chips, the hovered and selected ones always winning", () => {
    // Two links whose chips land on the same anchor overlap: the second in scene order is dropped.
    const pair = doc([{ kind: "station" }, { kind: "station" }], [{ routingProbability: 0.5, customerClass: 0 }, { routingProbability: 0.25, customerClass: 1 }]);
    const base = sceneOf(pair);
    const scene = { ...base, links: base.links.map((l) => ({ ...l, geometry: base.links[0].geometry })) };
    const chips = (v = quietView()) => [...draw(pair, { scene, view: v }).svg.querySelectorAll('[data-part="chip"] text')].map((t) => t.textContent);
    expect(chips()).toEqual(["0.5"]);
    expect(chips(quietView({ hoveredLinkID: "L1" }))).toEqual(["0.25"]);
    expect(chips(quietView({ selectedLinkID: "L1" }))).toEqual(["0.25"]);
  });
});

describe("ρ badges (CAN-156, ANA-189…ANA-191)", () => {
  const d = example("2dtandem.bnet");
  const s1 = byName(d, "S1").id;
  const s2 = byName(d, "S2").id;

  it("draws 'ρ' and 2 significant digits at the body's top-right, tinted by load, only for stations in the map", () => {
    const { node, svg } = draw(d, { utilisation: { [s1]: 0.934, [s2]: 0.75 } });
    const b1 = node("S1").querySelector('[data-part="rho"]')!;
    expect(b1.querySelector("text")!.textContent).toBe("ρ 0.93");
    expect(b1.getAttribute("data-level")).toBe("heavy");
    expect(b1.querySelector("rect")!.getAttribute("fill")).toBe(light.rhoHeavy);
    expect(b1.querySelector("text")!.getAttribute("fill")).toBe(light.onTint);
    expect(b1.querySelector("rect")!.getAttribute("stroke")).toBe(light.separator);
    expect(node("S2").querySelector('[data-part="rho"]')!.getAttribute("data-level")).toBe("moderate");
    expect(svg.querySelectorAll('[data-part="rho"]')).toHaveLength(2);
    // Top-right corner at (x + w/2 + 8, y − h/2 − 8).
    const rect = b1.querySelector("rect")!;
    const [x, y] = byName(d, "S1").position;
    expect(Number(rect.getAttribute("x")) + Number(rect.getAttribute("width"))).toBeCloseTo(x + 24 + 8, 2);
    expect(Number(rect.getAttribute("y"))).toBeCloseTo(y - 24 - 8, 2);
    expect(draw(d, { utilisation: { [s1]: 0.69 } }).node("S1").querySelector('[data-part="rho"]')!.getAttribute("data-level")).toBe("light");
  });

  it("says why in its tooltip, in 0.90.34's words", () => {
    expect(rhoTooltip(1.02)).toBe("Utilisation ρ = 1.02 from the traffic equations (α / c·μ); updates as you edit. Unstable: ρ ≥ 1.");
    expect(rhoTooltip(0.9)).toBe("Utilisation ρ = 0.9 from the traffic equations (α / c·μ); updates as you edit. Heavy traffic.");
    expect(rhoTooltip(0.7)).toMatch(/Moderate load\.$/);
    expect(rhoTooltip(0.1234)).toBe("Utilisation ρ = 0.123 from the traffic equations (α / c·μ); updates as you edit. Light load.");
    const { node } = draw(d, { utilisation: { [s1]: 0.5 } });
    expect(node("S1").querySelector('[data-part="rho"] title')!.textContent).toBe(rhoTooltip(0.5));
  });

  it("is in the export too", () => {
    const { node } = draw(d, { utilisation: { [s1]: 0.5 }, snapshot: true });
    expect(node("S1").querySelector('[data-part="rho"] text')!.textContent).toBe("ρ 0.5");
    expect(node("S1").querySelector('[data-part="rho"] title')).toBeNull();
  });
});

describe("transient layers", () => {
  const d = example("2dtandem.bnet");

  it("draws the pending-link ring 16 pt out, dashed, in the chain's class colour or the accent", () => {
    const b1 = byName(d, "B1");
    const ring = (v: ReturnType<typeof quietView>) => draw(d, { view: v }).svg.querySelector('[data-layer="pending-ring"]');
    expect(ring(quietView({ pendingLinkStartID: b1.id }))).toBeNull(); // only with the Link tool
    const r = ring(quietView({ tool: "addLink", pendingLinkStartID: b1.id }))!;
    expect(r.getAttribute("stroke")).toBe(light.accent);
    expect(r.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(r.getAttribute("stroke-width")).toBe("2");
    expect(r.getAttribute("d")).toContain(`H${Math.round((b1.position[0] + 34) * 1000) / 1000}V`);
    const src = byName(d, "Src1");
    expect(ring(quietView({ tool: "addLink", pendingLinkStartID: b1.id, activeLinkSourceID: src.id, activeCustomerClass: 2 }))!.getAttribute("stroke")).toBe(classColor(light, 2));
  });

  it("draws the link preview dashed at link width, with or without its arrowhead", () => {
    const scene = sceneOf(d, 2);
    const g = scene.links[0].geometry;
    const one = draw(d, { scene, view: quietView({ tool: "addLink" }), transient: { linkPreview: g, ghost: null, marqueeLive: false } });
    const p = one.svg.querySelector('[data-layer="link-preview"] path')!;
    expect(p.getAttribute("stroke-dasharray")).toBe("12 8");
    expect(p.getAttribute("stroke-width")).toBe("4");
    expect(p.getAttribute("stroke-linecap")).toBe("round");
    expect(one.svg.querySelector('[data-layer="link-preview"] [data-part="arrow"]')).not.toBeNull();
    expect(p.getAttribute("stroke")).toBe(light.accent); // before a source fixes the class
    const src = byName(d, "Src1");
    const classed = draw(d, { scene, view: quietView({ tool: "addLink", activeLinkSourceID: src.id, activeCustomerClass: 1 }), transient: { linkPreview: g, ghost: null, marqueeLive: false } });
    expect(classed.svg.querySelector('[data-layer="link-preview"] path')!.getAttribute("stroke")).toBe(classColor(light, 1));
    const bare = draw(d, { scene, transient: { linkPreview: g, linkPreviewHasArrow: false, ghost: null, marqueeLive: false } });
    expect(bare.svg.querySelector('[data-layer="link-preview"] [data-part="arrow"]')).toBeNull();
  });

  it("draws the placement ghost at 40 %, dashed, and hides it while Space pans", () => {
    const t = { linkPreview: null, ghost: { kind: "sink" as const, world: { x: 56, y: 84 } }, marqueeLive: false };
    const g = draw(d, { transient: t }).svg.querySelector('[data-layer="ghost"]')!;
    expect(g.getAttribute("opacity")).toBe("0.4");
    expect(g.getAttribute("fill")).toBe(light.sinkFill);
    expect(g.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(draw(d, { transient: t, view: quietView({ isSpacePanning: true }) }).svg.querySelector('[data-layer="ghost"]')).toBeNull();
  });

  it("draws the marquee band and highlights exactly the nodes its predicate selects", () => {
    const s1 = byName(d, "S1");
    const band = { x: s1.position[0] - 30, y: s1.position[1] - 30, width: 10, height: 10 }; // touches S1's body only
    const { svg, node } = draw(d, { view: quietView({ multiSelectRect: band }) });
    const m = svg.querySelector('[data-layer="marquee"]')!;
    expect(m.getAttribute("fill")).toBe(light.marqueeFill);
    expect(m.getAttribute("stroke")).toBe(light.accent);
    expect(node("S1").querySelector('[data-part="hover-ring"]')!.getAttribute("opacity")).toBe("1");
    expect(node("S2").querySelector('[data-part="hover-ring"]')!.getAttribute("opacity")).toBe("0");
    const zero = draw(d, { view: quietView({ multiSelectRect: { x: s1.position[0], y: s1.position[1], width: 0, height: 0 } }) });
    expect(Number(zero.svg.querySelector('[data-layer="marquee"]')!.getAttribute("width"))).toBe(1);
  });

  it("draws alignment guides between the node and its partner, overshooting 8 pt, with 4-pt ticks, on half pixels", () => {
    const t = { scale: 1, pan: { width: 0, height: 0 }, viewportSize: { width: 800, height: 600 } };
    const d1 = guidePath({ ...NO_GUIDES, x: 100, anchor: { x: 76, y: 100, width: 48, height: 48 }, xPartner: { x: 76, y: 300, width: 48, height: 48 } }, t);
    expect(d1).toBe("M100.5 92.5V356.5M96.5 92.5H104.5M96.5 356.5H104.5");
    const d2 = guidePath({ ...NO_GUIDES, anchor: { x: 0, y: 0, width: 10, height: 10 }, xSpacing: { first: { x: 10, y: 5, width: 20, height: 0 }, second: { x: 40, y: 5, width: 20, height: 0 } } }, t);
    expect(d2).toBe("M10.5 5.5H30.5M10.5 1.5V9.5M30.5 1.5V9.5M40.5 5.5H60.5M40.5 1.5V9.5M60.5 1.5V9.5");
    const { svg } = draw(d, { view: quietView({ activeAlignGuides: { ...NO_GUIDES, y: 198, anchor: { x: 0, y: 174, width: 48, height: 48 } } }) });
    expect(svg.querySelector('[data-layer="guides"] path')!.getAttribute("stroke")).toBe(light.accent);
  });

  it("draws the dot grid at zoom 1 and nothing when a cell is half a point", () => {
    expect(draw(d).svg.querySelector('[data-layer="grid"] [data-part="dots"]')!.getAttribute("fill")).toBe(light.gridDot);
    expect(draw(d, { scale: 0.015 }).svg.querySelector('[data-layer="grid"]')).toBeNull();
    expect(draw(d, { grid: false }).svg.querySelector('[data-layer="grid"]')).toBeNull();
  });
});

describe("accessibility (CAN-200…CAN-203)", () => {
  const d = example("OpenJackson.d2.feedback.p30.inf.bnet");

  it("makes each node one button labelled '<Kind> <name>, <detail>, <rates in words>, utilisation ρ …', pressed when selected", () => {
    const s1 = byName(d, "S1");
    const { svg, getByRole } = draw(d, { utilisation: { [s1.id]: 0.6862 }, view: quietView({ selectedNodeID: s1.id }) });
    const label = "Station S1, Exponential, service rate μ = 2.041 jobs per time unit per server, SCV 1 (exponential), utilisation ρ 0.69";
    const el = getByRole("button", { name: label });
    expect(el).toHaveAttribute("aria-pressed", "true");
    expect(nodeDescription(byName(d, "Src1"), true, undefined)).toBe("Source Src1, Poisson, arrival rate λ = 1 jobs per time unit, SCV 1 (exponential)");
    expect(nodeDescription(byName(d, "B1"), true, undefined)).toBe("Buffer B1");
    expect(nodeDescription(byName(d, "B1"), false, undefined)).toBe("Buffer B1, b=24");
    // The tooltip adds the glossary line for each symbol drawn.
    expect(nodeTooltip(s1, true, undefined).split("\n").slice(1)).toEqual([
      "μ — service rate: mean number of jobs a single server completes per unit time (1 / mean service time).",
      "SCV (c²) — squared coefficient of variation: variance divided by the square of the mean. 1 for exponential, 0 for deterministic, above 1 for bursty.",
    ]);
    expect(svg.querySelector(`[data-node="${s1.id}"] > title`)!.textContent).toBe(nodeTooltip(s1, true, 0.6862));
    // The ρ badge itself is hidden from VoiceOver (the node's label carries it).
    expect(svg.querySelector('[data-part="rho"]')!.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives every visible link a 1-pt element on its label anchor with its description, dropped during a drag or a pan", () => {
    const { getAllByRole, scene, rerender } = draw(d, { linkDescription: (l) => `about ${l.id}` });
    const probes = getAllByRole("button").filter((e) => e.tagName.toLowerCase() === "rect");
    expect(probes).toHaveLength(scene.links.length);
    expect(probes[0]).toHaveAttribute("width", "1");
    expect(probes[0].getAttribute("aria-label")).toMatch(/^about /);
    rerender(<SceneLayers scene={scene} view={quietView({ isDraggingNode: true })} colors={light} infiniteBuffers />);
    expect(document.querySelectorAll('[data-layer="link-a11y"]')).toHaveLength(0);
    rerender(<SceneLayers scene={scene} view={quietView({ isPanningCanvas: true })} colors={light} infiniteBuffers />);
    expect(document.querySelectorAll('[data-layer="link-a11y"]')).toHaveLength(0);
    rerender(<SceneLayers scene={scene} view={quietView()} colors={light} infiniteBuffers />);
    expect(document.querySelectorAll('[data-layer="link-a11y"] rect')).toHaveLength(scene.links.length);
  });

  it("describes a link as editor.linkDescription does when no editor is given", () => {
    const { getByRole } = draw(d);
    expect(getByRole("button", { name: "Link, S1 to B1, routing probability 0.3" })).toBeInTheDocument();
  });

  it("reports VoiceOver's press (a click with no pointer) and ignores a real click", () => {
    const pressed: string[] = [];
    const { svg } = draw(d, { onNodePress: (id) => pressed.push(id), onLinkPress: (id) => pressed.push(`link ${id}`) });
    const s1 = svg.querySelector(`[data-node="${byName(d, "S1").id}"]`)!;
    s1.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    s1.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    svg.querySelector('[data-layer="link-a11y"] rect')!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(pressed).toEqual([byName(d, "S1").id, `link ${sceneOf(d).links[0].id}`]);
  });

  it("hides the grid, links canvas, preview, guides, ghost, ring and marquee from assistive technology", () => {
    const b1 = byName(d, "B1");
    const { svg } = draw(d, { view: quietView({ tool: "addLink", pendingLinkStartID: b1.id, multiSelectRect: { x: 0, y: 0, width: 5, height: 5 } }), transient: { linkPreview: sceneOf(d).links[0].geometry, ghost: { kind: "station", world: { x: 0, y: 0 } }, marqueeLive: true } });
    for (const layer of ["grid", "link-preview", "pending-ring", "ghost", "marquee"]) expect(svg.querySelector(`[data-layer="${layer}"]`)!.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector('[data-layer="links"] > g')!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("snapshot mode (the image export)", () => {
  const d = example("OpenJackson.d2.feedback.p30.inf.bnet");
  it("draws no hover, selection, marquee, guides, preview, ghost, ring or accessibility element", () => {
    const s1 = byName(d, "S1");
    const { svg } = draw(d, {
      snapshot: true,
      view: quietView({ tool: "addLink", selectedNodeID: s1.id, hoveredNodeID: s1.id, selectedLinkID: d.links[2].id, pendingLinkStartID: s1.id, multiSelectRect: { x: 0, y: 0, width: 900, height: 900 }, activeAlignGuides: { ...NO_GUIDES, x: 1, anchor: { x: 0, y: 0, width: 1, height: 1 } } }),
      transient: { linkPreview: sceneOf(d).links[0].geometry, ghost: { kind: "station", world: { x: 0, y: 0 } }, marqueeLive: true },
    });
    for (const sel of ['[data-part="hover-ring"]', '[data-part="selection-ring"]', '[data-layer="marquee"]', '[data-layer="guides"]', '[data-layer="link-preview"]', '[data-layer="ghost"]', '[data-layer="pending-ring"]', '[data-layer="link-a11y"]', "[role=button]", "title"]) {
      expect(svg.querySelector(sel), sel).toBeNull();
    }
    expect(svg.querySelector(`[data-node="${s1.id}"] [data-part="body"] path`)!.getAttribute("stroke")).toBe(light.nodeStroke);
    expect([...svg.querySelectorAll('[data-part="stroke"]')].every((p) => p.getAttribute("stroke") !== light.accent)).toBe(true);
    expect(svg.getAttribute("role")).toBe("img");
  });
});

describe("pans by moving two groups", () => {
  it("keeps every node's and link's path data when only the pan changes, and draws them where the scene says", () => {
    const d = example("random1.bnet");
    const a = draw(d, { pan: [0, 0] });
    const before = [...a.svg.querySelectorAll("[data-node] path, [data-link] path")].map((p) => p.getAttribute("d"));
    a.unmount();
    const b = draw(d, { pan: [137.25, -42.5] });
    const after = [...b.svg.querySelectorAll("[data-node] path, [data-link] path")].map((p) => p.getAttribute("d"));
    expect(after).toEqual(before);
    expect(b.svg.querySelector('[data-layer="nodes"]')!.getAttribute("transform")).toBe("translate(137.25 -42.5)");
    expect(b.svg.querySelector('[data-layer="links"] > g')!.getAttribute("transform")).toBe("translate(137.25 -42.5)");
    // A node's drawn centre = translate + local = the scene's display centre.
    const n = d.nodes[0];
    const c = b.scene.displayCentres.get(n.id)!;
    const name = b.svg.querySelector(`[data-node="${n.id}"] [data-part="name"]`)!;
    expect(Number(name.getAttribute("x")) + 137.25).toBeCloseTo(c.x, 3);
  });
});

describe("a camera frame on 200 nodes and 400 links (CAN-205, §17)", () => {
  /** A 20 × 10 lattice of stations, each linked right and down (and a few back), 400 links. */
  function lattice(): BnetDocument {
    const nodes: Partial<BnetNode>[] = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 20; c++) nodes.push({ id: `n${r}-${c}`, name: `S${r * 20 + c + 1}`, position: [80 + c * 90, 80 + r * 110] });
    const links: Partial<BnetLink>[] = [];
    for (let r = 0; r < 10; r++)
      for (let c = 0; c < 20; c++) {
        links.push({ id: `h${r}-${c}`, fromNodeID: `n${r}-${c}`, toNodeID: `n${r}-${(c + 1) % 20}`, routingProbability: 0.5 });
        links.push({ id: `v${r}-${c}`, fromNodeID: `n${r}-${c}`, toNodeID: `n${(r + 1) % 10}-${c}`, routingProbability: 0.5 });
      }
    return doc(nodes, links);
  }

  it("re-renders no node or link on a pan: only the two group transforms and the grid change", () => {
    const d = lattice();
    expect([d.nodes.length, d.links.length]).toEqual([200, 400]);
    const s0 = sceneOf(d, 1, [0, 0]);
    const { container, rerender } = render(<SceneLayers scene={s0} view={quietView()} colors={light} infiniteBuffers={false} />);
    const changed = new Set<string>();
    const note = (records: MutationRecord[]) => {
      for (const r of records) {
        const el = (r.target.nodeType === 1 ? r.target : r.target.parentElement) as Element;
        changed.add(el.closest("[data-node]") ? "node" : el.closest("[data-link]") ? "link" : el.closest('[data-layer="grid"]') ? "grid" : `${el.tagName.toLowerCase()}[${el.getAttribute("data-layer") ?? ""}]`);
      }
    };
    const mo = new MutationObserver(note);
    mo.observe(container, { subtree: true, attributes: true, childList: true, characterData: true });
    const t0 = performance.now();
    for (let i = 1; i <= 10; i++) rerender(<SceneLayers scene={sceneOf(d, 1, [i * 7.5, -i * 3.25])} view={quietView()} colors={light} infiniteBuffers={false} />);
    const perFrame = (performance.now() - t0) / 10;
    note(mo.takeRecords());
    mo.disconnect();
    expect([...changed].filter((c) => c === "node" || c === "link")).toEqual([]);
    expect(changed.has("grid")).toBe(true);
    // jsdom is far slower than WebKit; this only catches a frame that re-does the whole picture.
    expect(perFrame).toBeLessThan(250);
  });
});
