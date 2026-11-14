// The canvas geometry's stated behaviours (canvas.md §5–§9, §17, §18, §21), one by one. The
// bit-for-bit comparisons with 0.90.34 are golden.test.ts and synthetic.test.ts; the routing gate
// is routing.test.ts; the budget guard is bench.test.ts.
import { chromeInsets, fitting as fitFrame, FIT_MARGIN, MAX_INSET_SHARE, NO_INSETS, ZOOM_RANGE, type CanvasTransform as FitTransform } from "./transform";
import { describe, expect, it } from "vitest";
import { parseDocument, type BnetLink, type BnetNode, type NodeKind } from "../../lib/bnet";
import { activeEditor } from "../../editor";
import { buildGrid, firstLine, gridDotsPath, gridLinesPath } from "./grid";
import { dropX, dropY, guidesEmpty, matchGuides, GUIDE_TOLERANCE } from "./guides";
import { linkArrowPath, linkBetween, linkStrokePath, polylineDistance, polylineDistanceReference, selfLoop } from "./link";
import { chipPolicy, chipText, detailRowShown, labelBlockDisplayWidth, nameFontSize, nameRowShown, placeChips, rateRowShown } from "./lod";
import { cgIntersects, roundSwift, segmentIntersectsRect, swiftMax, swiftMin } from "./math";
import { CanvasObstacles, hitsLess } from "./obstacles";
import { nodeLabelRect, nodeWorldRect } from "./outline";
import { BULGE_LADDER, BUNDLE_SPACING, buildRoutePlan, bundleGroups, bundleSlot, EMPTY_PLAN, interpolatePlans, PAIR_BULGE, planBulge, plansEqual, solveBulgeTraced } from "./route";
import { buildScene, hitLink, hitNode, sceneContentRect } from "./scene";
import { IDENTITY, makeTransform } from "./transform";

const solvedBowInput = import.meta.glob("../../../golden/tools/canvas-fixtures/solved-bow.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

let seq = 0;
function node(kind: NodeKind, x: number, y: number, id = `N${seq++}`): BnetNode {
  return { id, kind, name: id, position: [x, y], bufferSize: 0, distribution: "", distributionParameters: "", numberOfServers: 1, serviceDistributions: {}, picture: "" };
}
function link(from: BnetNode, to: BnetNode, customerClass = 0, id = `L${seq++}`, routingProbability = 1): BnetLink {
  return { id, fromNodeID: from.id, toNodeID: to.id, customerClass, routingProbability };
}
const at = (scale: number, px = 0, py = 0) => makeTransform(scale, { width: px, height: py }, { width: 1200, height: 800 });

/** True when the BUILT world polyline of `l` (bulge `b`) enters any third body or label (padded, as the router counts). */
function builtClear(nodes: BnetNode[], l: BnetLink, offset: number, b: number): boolean {
  const o = new CanvasObstacles(nodes, IDENTITY);
  const a = nodes.find((n) => n.id === l.fromNodeID)!;
  const c = nodes.find((n) => n.id === l.toNodeID)!;
  const g = linkBetween({ x: a.position[0], y: a.position[1] }, a.kind, { x: c.position[0], y: c.position[1] }, c.kind, 1, offset, b);
  const h = o.hits(g.polyline, a.id, c.id);
  return h.bodies === 0 && h.labels === 0;
}

describe("Swift arithmetic", () => {
  it("keeps Swift's min/max NaN behaviour and .rounded() ties away from zero", () => {
    expect(swiftMin(NaN, 1)).toBeNaN();
    expect(swiftMin(1, NaN)).toBe(1);
    expect(swiftMax(NaN, 1)).toBeNaN();
    expect(swiftMax(1, NaN)).toBe(1);
    expect(roundSwift(-2.5)).toBe(-3);
    expect(roundSwift(2.5)).toBe(3);
    expect(roundSwift(-0.4)).toBe(-0);
  });

  it("intersects rects as CoreGraphics does: touching no, a zero-height rect inside yes", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(cgIntersects(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
    expect(cgIntersects(a, { x: 0, y: 5, width: 10, height: 0 })).toBe(true);
    expect(cgIntersects(a, { x: 0, y: 0, width: 0, height: 10 })).toBe(true);
    expect(cgIntersects(a, { x: 10, y: 10, width: 0, height: 0 })).toBe(false);
    expect(cgIntersects(a, { x: 8, y: 2, width: -4, height: 3 })).toBe(true);
  });

  it("clips a segment against a rect (Liang–Barsky, closed)", () => {
    const r = { x: 0, y: 0, width: 10, height: 10 };
    expect(segmentIntersectsRect({ x: -5, y: 5 }, { x: 15, y: 5 }, r)).toBe(true);
    expect(segmentIntersectsRect({ x: -5, y: 10 }, { x: 15, y: 10 }, r)).toBe(true);
    expect(segmentIntersectsRect({ x: -5, y: 11 }, { x: 15, y: 11 }, r)).toBe(false);
    expect(segmentIntersectsRect({ x: 12, y: -5 }, { x: 20, y: 30 }, r)).toBe(false);
  });
});

describe("link geometry (CAN-064…066)", () => {
  it("draws a straight link between the outlines with a 1.5 pt gap and a 28° arrowhead", () => {
    const g = linkBetween({ x: 0, y: 0 }, "station", { x: 200, y: 0 }, "station", 1);
    expect(g.route.kind).toBe("straight");
    expect(g.start.x).toBeCloseTo(25.5, 2);
    expect(g.tip.x).toBeCloseTo(174.5, 2);
    expect(g.base.x).toBeCloseTo(164.5, 2);
    expect(g.wingLeft.y).toBeCloseTo(10 * Math.tan((28 * Math.PI) / 180), 12);
    expect(g.polyline).toEqual([g.start, g.base, g.tip]);
    // Label above the segment, 9 + line width off it.
    expect(g.labelAnchor.y).toBeCloseTo(-11, 12);
    expect(linkStrokePath(g)).toBe(`M${g.start.x} 0L${g.base.x} 0`);
    expect(linkArrowPath(g)).toBe(`M${g.tip.x} 0L${g.wingLeft.x} ${g.wingLeft.y}L${g.wingRight.x} ${g.wingRight.y}Z`);
  });

  it("aims a bowed link's ends at the control point and puts its label on the convex side", () => {
    const g = linkBetween({ x: 0, y: 0 }, "station", { x: 200, y: 0 }, "station", 1, 0, 48);
    expect(g.route).toEqual({ kind: "quad", control: { x: 100, y: 48 } });
    expect(g.polyline.length).toBe(14);
    expect(g.start.y).toBeGreaterThan(0);
    expect(g.labelAnchor.y).toBeGreaterThan(24);
    expect(linkStrokePath(g)).toContain("Q100 48 ");
  });

  it("nests extra self-loops outward by their radius (CAN-066)", () => {
    const loops = [0, 8, 16].map((r) => selfLoop({ x: 100, y: 100 }, "station", 1, r));
    for (const l of loops) expect(l.route.kind).toBe("cubic");
    expect(loops[1].labelAnchor.y).toBeLessThan(loops[0].labelAnchor.y);
    expect(loops[2].labelAnchor.y).toBeLessThan(loops[1].labelAnchor.y);
    // Same ends on the outline, controls pushed out.
    expect(loops[2].start).toEqual(loops[0].start);
    expect(loops[2].tip).toEqual(loops[0].tip);
    expect(loops[0].polyline.length).toBe(18);
  });

  it("measures link distance the same with and without the inlined hit-test loop", () => {
    const g = linkBetween({ x: 0, y: 0 }, "station", { x: 200, y: 50 }, "buffer", 1.3, 4, 60);
    for (let i = 0; i < 200; i++) {
      const p = { x: (i * 37) % 260 - 30, y: (i * 53) % 140 - 40 };
      expect(polylineDistance(g.polyline, p)).toBe(polylineDistanceReference(g.polyline, p));
    }
  });
});

describe("bundling (§6.1)", () => {
  it("puts multi-class siblings 8 world pt apart, centred on the chord, at every zoom", () => {
    const a = node("station", 0, 0);
    const b = node("station", 300, 0);
    const links = [link(a, b, 2), link(a, b, 0), link(a, b, 1)];
    const groups = bundleGroups(links);
    expect(links.map((l) => bundleSlot(groups, l).offsetWorld)).toEqual([8, -8, 0]);
    for (const s of [1, 2.5]) {
      const scene = buildScene({ nodes: [a, b], links, transform: at(s), classFilter: null, routePlan: EMPTY_PLAN });
      const ys = scene.links.map((it) => it.geometry.start.y);
      expect(ys[1] - ys[0]).toBeCloseTo(BUNDLE_SPACING * s, 9);
      expect(ys[2] - ys[1]).toBeCloseTo(BUNDLE_SPACING * s, 9);
      // Draw order: class ascending.
      expect(scene.links.map((it) => it.link.customerClass)).toEqual([0, 1, 2]);
    }
  });

  it("gives an opposite-direction pair the 24 pt bow on opposite sides of the chord", () => {
    const a = node("station", 0, 0);
    const b = node("station", 300, 0);
    const ab = link(a, b);
    const ba = link(b, a);
    const plan = buildRoutePlan([a, b], [ab, ba]);
    expect(planBulge(plan, ab.id)).toBe(PAIR_BULGE);
    expect(planBulge(plan, ba.id)).toBe(PAIR_BULGE);
    const scene = buildScene({ nodes: [a, b], links: [ab, ba], transform: at(1), classFilter: null, routePlan: plan });
    const [g1, g2] = scene.links.map((it) => it.geometry.route);
    expect(g1.kind === "quad" && g2.kind === "quad").toBe(true);
    if (g1.kind === "quad" && g2.kind === "quad") expect(Math.sign(g1.control.y)).toBe(-Math.sign(g2.control.y));
  });

  it("keeps a locked pair on its own side even when a body sits there (searching only that sign)", () => {
    const a = node("station", 0, 0);
    const b = node("station", 400, 0);
    const blocker = node("station", 200, 20); // below the chord, where a→b's +24 bow goes
    const ab = link(a, b);
    const ba = link(b, a);
    const plan = buildRoutePlan([a, b, blocker], [ab, ba]);
    expect(planBulge(plan, ab.id)).toBeGreaterThan(0);
    expect(planBulge(plan, ba.id)).toBeGreaterThan(0);
  });

  it("moves no bundle when a class filter hides some links (INV-071)", () => {
    const a = node("station", 0, 0);
    const b = node("buffer", 300, 80);
    const c = node("sink", 150, 300);
    const links = [link(a, b, 0), link(a, b, 1), link(a, b, 2), link(b, c, 1), link(c, a, 0), link(a, c, 1)];
    const plan = buildRoutePlan([a, b, c], links);
    const all = buildScene({ nodes: [a, b, c], links, transform: at(1.5, 10, 20), classFilter: null, routePlan: plan });
    const one = buildScene({ nodes: [a, b, c], links, transform: at(1.5, 10, 20), classFilter: 1, routePlan: plan });
    expect(one.links.map((it) => it.link.customerClass)).toEqual([1, 1, 1]);
    for (const it of one.links) expect(it.geometry).toEqual(all.links.find((x) => x.id === it.id)!.geometry);
  });
});

describe("route plan (§6.3, CAN-073…077)", () => {
  it("keeps a tandem chain dead straight (INV-070)", () => {
    const chain = [0, 1, 2, 3, 4, 5].map((i) => node(i === 0 ? "source" : i === 5 ? "sink" : i % 2 ? "buffer" : "station", 60 + i * 140, 200));
    const links = chain.slice(1).map((n, i) => link(chain[i], n));
    const plan = buildRoutePlan(chain, links);
    expect(plan.bulges.size).toBe(0);
    const scene = buildScene({ nodes: chain, links, transform: at(1), classFilter: null, routePlan: null });
    for (const it of scene.links) {
      expect(it.geometry.route.kind).toBe("straight");
      for (const p of it.geometry.polyline) expect(p.y).toBe(200);
    }
  });

  it("bends only as far as it must: the smallest ladder rung that clears", () => {
    const a = node("station", 0, 0);
    const c = node("station", 400, 0);
    const b = node("station", 200, 20); // its padded body pokes 10 pt above the chord
    const l = link(a, c);
    const nodes = [a, c, b];
    const bulge = planBulge(buildRoutePlan(nodes, [l]), l.id);
    expect(BULGE_LADDER).toContain(Math.abs(bulge));
    expect(builtClear(nodes, l, 0, bulge)).toBe(true);
    for (const m of BULGE_LADDER.filter((m) => m < Math.abs(bulge))) {
      expect(builtClear(nodes, l, 0, m)).toBe(false);
      expect(builtClear(nodes, l, 0, -m)).toBe(false);
    }
    expect(bulge).toBe(-24);
  });

  it("bows a detour away from the drawing's centroid", () => {
    for (const side of [1, -1]) {
      // A vertical chord with a station (and its centred label) square on it: either side clears
      // at the same rung, so only the centroid decides.
      const a = node("station", 0, 0);
      const c = node("station", 0, 400);
      const b = node("station", 0, 200);
      const crowd = node("station", 300 * side, 200);
      const l = link(a, c);
      const bulge = planBulge(buildRoutePlan([a, c, b, crowd], [l]), l.id);
      // perp of a→c is (−1, 0): a positive bow goes −x, away from a crowd at +x.
      expect(Math.sign(bulge)).toBe(side);
    }
  });

  it("leaves a link alone when there are two nodes or nothing near it", () => {
    const a = node("station", 0, 0);
    const b = node("station", 300, 0);
    expect(new CanvasObstacles([a, b], IDENTITY).isEmpty).toBe(true);
    const far = node("station", 5000, 5000);
    const l = link(a, b);
    const r = solveBulgeTraced({ fromCentre: { x: 0, y: 0 }, fromKind: "station", fromID: a.id, toCentre: { x: 300, y: 0 }, toKind: "station", toID: b.id, parallelOffset: 0, baseBulge: 0, lockSide: false, obstacles: new CanvasObstacles([a, b, far], IDENTITY), centroid: { x: 0, y: 0 } });
    expect(r).toEqual({ bulge: 0, tier: "nothing-near" });
    expect(buildRoutePlan([a, b, far], [l]).bulges.size).toBe(0);
  });

  it("solves for the exact bow when no rung clears (golden fixture solved-bow: −250)", () => {
    const doc = parseDocument(Object.values(solvedBowInput)[0]);
    const plan = buildRoutePlan(doc.nodes, doc.links);
    expect([...plan.bulges.values()]).toContain(-250);
  });

  it("counts a horizontal chord through a body (CG's zero-height box rule) and never the link's own ends", () => {
    const a = node("station", 0, 0);
    const b = node("station", 200, 0);
    const c = node("station", 400, 0);
    const o = new CanvasObstacles([a, b, c], IDENTITY);
    const chord = [{ x: 0, y: 0 }, { x: 400, y: 0 }];
    expect(o.hits(chord, a.id, c.id)).toEqual({ bodies: 1, labels: 0 });
    expect(o.hits(chord, a.id, b.id).bodies).toBe(1);
    expect(o.hits(chord, a.id, c.id, true).bodies).toBe(1);
    expect(hitsLess({ bodies: 0, labels: 5 }, { bodies: 1, labels: 0 })).toBe(true);
    expect(o.near({ x: 0, y: 0 }, { x: 400, y: 0 }, 240, a.id, c.id).map((x) => x.isLabel)).toEqual([false, true]);
  });

  it("blends plans bow by bow, easing a straight link from or to zero (CAN-079's interpolation)", () => {
    const a = { bulges: new Map([["x", 10], ["z", 40]]) };
    const b = { bulges: new Map([["x", 20], ["y", 30]]) };
    expect(interpolatePlans(a, b, 0)).toBe(a);
    expect(interpolatePlans(a, b, 1)).toBe(b);
    const m = interpolatePlans(a, b, 0.5);
    expect(Object.fromEntries(m.bulges)).toEqual({ x: 15, y: 15, z: 20 });
    expect(plansEqual(interpolatePlans(a, a, 0.3), a)).toBe(true);
    expect(interpolatePlans({ bulges: new Map([["k", 10]]) }, { bulges: new Map([["k", -10]]) }, 0.5).bulges.has("k")).toBe(false);
  });

  it("is frozen while a node is dragged and re-planned on release (CAN-078)", () => {
    const e = activeEditor()!;
    const a = e.addNode("station", { x: 100, y: 200 });
    const c = e.addNode("station", { x: 500, y: 200 });
    const b = e.addNode("station", { x: 300, y: 400 });
    e.addLink(a.id, c.id);
    const before = e.routePlan;
    expect(before.bulges.size).toBe(0);
    e.setView({ isDraggingNode: true });
    e.moveNode(b.id, { x: 300, y: 205 }, false);
    expect(e.routePlan).toBe(before);
    e.setView({ isDraggingNode: false });
    expect(e.routePlan.bulges.size).toBe(1);
  });
});

describe("the scene and hit tests (§7, CAN-072)", () => {
  it("hits the topmost node, with a 3 pt display slop at any zoom", () => {
    const a = node("station", 100, 100);
    const b = node("station", 110, 100);
    const scene = buildScene({ nodes: [a, b], links: [], transform: at(2, 5, 5), classFilter: null, routePlan: EMPTY_PLAN });
    expect(hitNode(scene, { x: 215, y: 205 })).toBe(b);
    // b's display centre is (225, 205), radius 48 display at zoom 2: 50.9 still hits, 51.1 does not.
    expect(hitNode(scene, { x: 225 + 50.9, y: 205 })).toBe(b);
    expect(hitNode(scene, { x: 225 + 51.1, y: 205 })).toBeNull();
  });

  it("hits the nearest link within 5 pt, the topmost on an exact tie", () => {
    const a = node("station", 0, 0);
    const b = node("station", 300, 0);
    const l0 = link(a, b, 0);
    const l1 = link(a, b, 1);
    const scene = buildScene({ nodes: [a, b], links: [l1, l0], transform: at(1), classFilter: null, routePlan: EMPTY_PLAN });
    expect(hitLink(scene, { x: 150, y: 0 })).toBe(l1); // 4 pt from both; class 1 paints on top
    expect(hitLink(scene, { x: 150, y: -5 })).toBe(l0);
    expect(hitLink(scene, { x: 150, y: -9.5 })).toBeNull();
  });

  it("skips a link to a missing node, and plans on the spot with no plan given", () => {
    const a = node("station", 0, 0);
    const ghost = link(a, node("station", 1, 1), 0);
    const scene = buildScene({ nodes: [a], links: [ghost], transform: at(1), classFilter: null, routePlan: null });
    expect(scene.links).toEqual([]);
  });

  it("measures the content rect over bodies, labels and every routed point, grown by Spacing.l", () => {
    const a = node("station", 0, 0);
    const c = node("station", 400, 0);
    const b = node("station", 200, 20);
    const l = link(a, c);
    const plan = buildRoutePlan([a, c, b], [l]);
    const r = sceneContentRect([a, c, b], [l], plan)!;
    const lab = nodeLabelRect(b);
    expect(r.y + r.height).toBe(lab.y + lab.height + 16);
    expect(r.x).toBe(nodeLabelRect(a).x - 16);
    expect(r.x + r.width).toBe(nodeLabelRect(c).x + nodeLabelRect(c).width + 16);
    expect(nodeWorldRect(a).y).toBe(-24);
    const scene = buildScene({ nodes: [a, c, b], links: [l], transform: IDENTITY, classFilter: null, routePlan: plan });
    const top = Math.min(...scene.links[0].geometry.polyline.map((p) => p.y));
    expect(r.y).toBe(Math.min(top, -24) - 16);
    expect(sceneContentRect([], [], null)).toBeNull();
  });
});

describe("grid (§8, CAN-139)", () => {
  it("draws nothing at a cell of 0.5 pt or less, fades the dots in between 16 and 24 pt, pixel-aligns the lines", () => {
    expect(buildGrid(at(0.5 / 28), { width: 100, height: 100 })).toMatchObject({ minorDots: null, majorLines: null, minorAlpha: 0, majorAlpha: 0 });
    const faint = buildGrid(at(0.6), { width: 100, height: 100 }); // cell 16.8
    expect(faint.minorAlpha).toBeCloseTo(0.1, 12);
    expect(buildGrid(at(16.1 / 28), { width: 100, height: 100 }).minorDots).toBeNull(); // alpha ≤ 0.02
    const g = buildGrid(at(1, 3.3, -7.6), { width: 300, height: 200 });
    expect(g.minorAlpha).toBe(1);
    expect(g.minorDots![0]).toEqual({ x: 3.3 - 0.75, y: 20.4 - 0.75, width: 1.5, height: 1.5 });
    for (const l of g.majorLines!) expect(((l.x1 % 1) + 1) % 1 === 0.5 || ((l.y1 % 1) + 1) % 1 === 0.5).toBe(true);
    expect(firstLine(-30, 28)).toBe(26);
    expect(gridDotsPath(g)).toMatch(/^M2\.55 19\.65h1\.5v1\.5h-1\.5Z/);
    expect(gridLinesPath(g).startsWith("M3.5 0L3.5 200")).toBe(true);
  });
});

describe("smart guides (§9)", () => {
  const r = (x: number, y: number, w = 48, h = 48) => ({ x, y, width: w, height: h });

  it("locks the nearest edge or centre within tolerance and names the partner", () => {
    const m = matchGuides(r(102, 300), [r(100, 0), r(500, 299)], GUIDE_TOLERANCE);
    expect(m.adjustment).toEqual({ width: -2, height: -1 });
    expect(m.x).toBe(100);
    expect(m.xPartner).toEqual(r(100, 0));
    expect(m.y).toBe(299);
    expect(m.anchor).toEqual(r(100, 299));
    const noX = dropX(m);
    expect(noX.x).toBeNull();
    expect(noX.adjustment).toEqual({ width: 0, height: -1 });
    expect(guidesEmpty(dropY(noX))).toBe(true);
  });

  it("equalises the gaps only on an axis with no edge match", () => {
    // Neighbours at x 0 and 200 in the same row, anchor 1 pt right of centre (x 101 → 100).
    const m = matchGuides(r(101, 1000), [r(0, 1003), r(200, 997)], GUIDE_TOLERANCE);
    expect(m.xSpacing).not.toBeNull();
    expect(m.adjustment.width).toBe(-1);
    expect(m.y).toBe(1003); // both 3 pt away: the first neighbour keeps a tie
    expect(matchGuides(r(0, 0), [], 4)).toMatchObject({ x: null, anchor: null });
  });
});

describe("level of detail (§3.8, CAN-135…140)", () => {
  it("drops label rows at 0.35 / 0.45 / 0.6 and keeps a hovered or selected name", () => {
    expect(nameRowShown(0.34)).toBe(false);
    expect(nameRowShown(0.34, true)).toBe(true);
    expect(nameRowShown(0.34, false, true)).toBe(true);
    expect(nameRowShown(0.35)).toBe(true);
    expect([detailRowShown(0.44), detailRowShown(0.45), detailRowShown(0.9, false)]).toEqual([false, true, false]);
    expect([rateRowShown(0.59), rateRowShown(0.6)]).toEqual([false, true]);
    expect([labelBlockDisplayWidth(0.2), labelBlockDisplayWidth(1), labelBlockDisplayWidth(3)]).toEqual([56, 76, 76 * 1.4]);
    expect([nameFontSize(0.1), nameFontSize(1.1), nameFontSize(4)]).toEqual([9, 11, 13]);
  });

  it("drops chips below 50 %, never draws p = 1, and declutters with hovered and selected reserved first", () => {
    expect(chipPolicy(0.49, 0.5)).toBe("never");
    expect(chipPolicy(0.5, 1)).toBe("never");
    expect(chipPolicy(0.5, 0.5)).toBe("declutter");
    expect(chipPolicy(1, 0.5, true)).toBe("always");
    expect(chipText(0.333333)).toBe("0.33");
    expect(chipText(1)).toBeNull();
    const item = (id: string, x: number, p = 0.5) => ({ id, link: { routingProbability: p }, geometry: { labelAnchor: { x, y: 0 } } });
    const links = [item("a", 0), item("b", 10), item("c", 100), item("d", 105), item("e", 300, 1)];
    const measure = () => ({ width: 20, height: 12 });
    const plain = placeChips(links, { scale: 1, selectedLinkID: null, hoveredLinkID: null }, measure);
    expect([...plain.keys()]).toEqual(["a", "c"]);
    const hovered = placeChips(links, { scale: 1, selectedLinkID: "d", hoveredLinkID: "b" }, measure);
    expect([...hovered.keys()].sort()).toEqual(["b", "d"]);
    expect(hovered.get("b")!.rect).toEqual({ x: -4, y: -7, width: 28, height: 14 });
    expect(placeChips(links, { scale: 0.4, selectedLinkID: "a", hoveredLinkID: null }, measure).size).toBe(0);
  });
});

describe("a fit keeps clear of the canvas's floating chrome (gap FIX-106)", () => {
  const viewport = { width: 900, height: 600 };
  const world = { x: 100, y: 100, width: 400, height: 200 };
  const shown = (t: FitTransform, p: { x: number; y: number }) => ({ x: p.x * t.scale + t.pan.width, y: p.y * t.scale + t.pan.height });

  it("with nothing reserved is the fit it always was", () => {
    expect(fitFrame(world, viewport, FIT_MARGIN, ZOOM_RANGE, NO_INSETS)).toEqual(fitFrame(world, viewport, FIT_MARGIN, ZOOM_RANGE));
  });

  it("frames the network between the legend and the animation's control bar, margin and all", () => {
    // A legend chip reaching 58 pt down and a control bar 150 pt tall (its strip chart open).
    const insets = { top: 58, bottom: 150 };
    const plain = fitFrame(world, viewport, FIT_MARGIN, ZOOM_RANGE);
    const fit = fitFrame(world, viewport, FIT_MARGIN, ZOOM_RANGE, insets);
    // Without the reservation the lowest node centres sit in the band the bar covers.
    expect(shown(plain, { x: 100, y: 300 }).y).toBeGreaterThan(viewport.height - insets.bottom);
    const top = shown(fit, { x: 100, y: 100 });
    const bottom = shown(fit, { x: 500, y: 300 });
    expect(top.y).toBeGreaterThanOrEqual(insets.top + FIT_MARGIN - 1e-9);
    expect(bottom.y).toBeLessThanOrEqual(viewport.height - insets.bottom - FIT_MARGIN + 1e-9);
    expect(top.x).toBeGreaterThanOrEqual(FIT_MARGIN - 1e-9);
    // Centred in the free band, not in the whole canvas.
    expect((top.y + bottom.y) / 2).toBeCloseTo(insets.top + (viewport.height - insets.top - insets.bottom) / 2, 9);
    expect(fit.scale).toBeLessThan(plain.scale);
    // A node at the top-left corner of the network clears the legend by the fit's margin.
    expect(top.y - insets.top).toBeGreaterThanOrEqual(FIT_MARGIN - 1e-9);
  });

  it("measures the insets from the chrome's boxes, ignores what is not drawn, and never gives away more than half the canvas", () => {
    const surface = { x: 200, y: 50, width: 900, height: 600 };
    const legend = { x: 212, y: 62, width: 320, height: 46 };
    const bar = { x: 212, y: 500, width: 560, height: 138 };
    expect(chromeInsets(surface, [legend], [bar])).toEqual({ top: 58, bottom: 150 });
    expect(chromeInsets(surface, [], [])).toEqual(NO_INSETS);
    expect(chromeInsets(surface, [{ x: 0, y: 0, width: 0, height: 0 }], [{ x: 212, y: 500, width: 0, height: 0 }])).toEqual(NO_INSETS);
    // The taller of several boxes on an edge is the one that counts.
    expect(chromeInsets(surface, [legend, { ...legend, height: 70 }], [])).toEqual({ top: 82, bottom: 0 });
    const huge = chromeInsets(surface, [{ ...legend, height: 288 }], [{ ...bar, y: 350, height: 288 }]);
    expect(huge.top + huge.bottom).toBeCloseTo(600 * MAX_INSET_SHARE, 9);
    expect(huge.top).toBeCloseTo(huge.bottom, 9);
    expect(fitFrame(world, { width: 900, height: 600 }, FIT_MARGIN, ZOOM_RANGE, huge).scale).toBeGreaterThan(0);
  });
});
