// The canvas geometry against Qnet 0.90.34 itself: golden/canvas/<example>.json is 0.90.34's own
// scene for every shipped example (made by scripts/make-golden-canvas.sh from golden/tools/
// GoldenCanvas.swift): node rects, bundle slots, the route plan's bows, every built LinkGeometry,
// the grid, Zoom to Fit's fitting and the export's content rect, at zoom 1 and at five other
// (scale, pan) pairs. Each example is parsed as a BnetDocument, planned and built here, and every
// number is compared, to the bit (284 847 values on 2026-11-11, all exact).
import { describe, expect, it } from "vitest";
import { parseDocument, type BnetDocument } from "../../lib/bnet";
import { arrowLength, ARROW_HALF_ANGLE, lineWidth } from "./link";
import { chipFontSize, chipPolicy, chipsShown, chipText, detailFontSize, detailRowShown, labelBlockDisplayWidth, nameFontSize, nameRowShown, nodeStrokeWidth, rateRowShown } from "./lod";
import { boundingRadius, boundsOfCentres, labelBlockHeight, nodeLabelRect, nodeWorldRect, outlineSize } from "./outline";
import { BULGE_LADDER, bundleGroups, bundleSlot, buildRoutePlan, PAIR_BULGE, planBulge } from "./route";
import { buildScene, sceneContentRect } from "./scene";
import { buildGrid, firstLine } from "./grid";
import { fitting, FIT_MARGIN, GRID_SPACING, makeTransform, rectToDisplay, visibleWorldRect, ZOOM_RANGE } from "./transform";
import type { Point, Rect } from "./types";

const examples = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const goldens = import.meta.glob("../../../golden/canvas/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
// Four hand-made networks for what no example has (self-loops, a dangling link, opposite pairs, a
// dense grid, a solved bow): inputs in golden/tools/canvas-fixtures, scenes in golden/canvas/fixtures.
const fixtureInputs = import.meta.glob("../../../golden/tools/canvas-fixtures/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const fixtureGoldens = import.meta.glob("../../../golden/canvas/fixtures/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * Largest |difference| allowed: none. The port follows the Swift's operation order, and V8's
 * cos/sin/tan agree with Apple's libm on the angles used (tan 28°, cos/sin of −55° and −125°).
 * If a future engine differs in the last place, the summary test names the worst value.
 */
const TOLERANCE = 0;

type G = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const name = (path: string) => path.split("/").pop()!;
const exampleFor = (golden: string) => Object.keys(examples).find((p) => name(p) === golden.replace(/\.json$/, ".bnet"));
const fixtureFor = (golden: string) => Object.keys(fixtureInputs).find((p) => name(p) === golden.replace(/\.json$/, ".bnet"));

interface Tally {
  compared: number;
  exact: number;
  maxDiff: number;
  where: string;
  failures: string[];
}

function num(v: unknown): number {
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  return v as number;
}

function makeTally(): Tally {
  return { compared: 0, exact: 0, maxDiff: 0, where: "", failures: [] };
}

function cmpNum(t: Tally, where: string, ours: number, theirs: unknown) {
  const g = num(theirs);
  t.compared++;
  if (Object.is(ours, g) || ours === g) {
    t.exact++;
    return;
  }
  const d = Math.abs(ours - g);
  if (!(d <= TOLERANCE)) t.failures.push(`${where}: ours ${ours}, 0.90.34 ${g}`);
  if (d > t.maxDiff || Number.isNaN(d)) {
    t.maxDiff = d;
    t.where = where;
  }
}
const cmpPt = (t: Tally, w: string, p: Point, g: G) => {
  cmpNum(t, `${w}.x`, p.x, g[0]);
  cmpNum(t, `${w}.y`, p.y, g[1]);
};
const cmpRect = (t: Tally, w: string, r: Rect, g: G) => {
  cmpNum(t, `${w}.x`, r.x, g.x);
  cmpNum(t, `${w}.y`, r.y, g.y);
  cmpNum(t, `${w}.width`, r.width, g.width);
  cmpNum(t, `${w}.height`, r.height, g.height);
};
function cmpEq(t: Tally, where: string, ours: unknown, theirs: unknown) {
  t.compared++;
  if (ours === theirs) t.exact++;
  else t.failures.push(`${where}: ours ${JSON.stringify(ours)}, 0.90.34 ${JSON.stringify(theirs)}`);
}

function compareExample(doc: BnetDocument, golden: G, t: Tally) {
  const { nodes, links } = doc;
  cmpEq(t, "node count", nodes.length, golden.nodes.length);
  cmpEq(t, "link count", links.length, golden.links.length);
  nodes.forEach((n, i) => {
    const g = golden.nodes[i];
    const w = `node ${g.name}`;
    cmpEq(t, `${w}.id`, n.id, g.id);
    cmpPt(t, `${w}.position`, { x: n.position[0], y: n.position[1] }, g.position);
    const s = outlineSize(n.kind);
    cmpPt(t, `${w}.outlineSize`, { x: s.width, y: s.height }, g.outlineSize);
    cmpNum(t, `${w}.boundingRadius`, boundingRadius(n.kind), g.boundingRadius);
    cmpRect(t, `${w}.worldRect`, nodeWorldRect(n), g.worldRect);
    cmpRect(t, `${w}.labelRect`, nodeLabelRect(n), g.labelRect);
    cmpNum(t, `${w}.labelBlockHeight`, labelBlockHeight(n.kind), g.labelBlockHeight);
  });

  const plan = buildRoutePlan(nodes, links);
  const groups = bundleGroups(links);
  links.forEach((l, i) => {
    const g = golden.links[i];
    const w = `link ${i} ${g.from}->${g.to} c${g.customerClass}`;
    cmpEq(t, `${w}.id`, l.id, g.id);
    const slot = bundleSlot(groups, l);
    const self = l.fromNodeID === l.toNodeID;
    cmpEq(t, `${w}.isSelfLoop`, self, g.isSelfLoop);
    cmpEq(t, `${w}.bundleIndex`, slot.index, g.bundleIndex);
    cmpEq(t, `${w}.bundleCount`, slot.count, g.bundleCount);
    cmpNum(t, `${w}.offsetWorld`, slot.offsetWorld, g.offsetWorld);
    if (self) cmpNum(t, `${w}.selfLoopExtraRadiusWorld`, slot.index * 8, g.selfLoopExtraRadiusWorld);
    else cmpEq(t, `${w}.selfLoopExtraRadiusWorld`, null, g.selfLoopExtraRadiusWorld);
    cmpEq(t, `${w}.hasOpposite`, slot.hasOpposite, g.hasOpposite);
    const baseBulge = slot.hasOpposite ? PAIR_BULGE : 0;
    cmpNum(t, `${w}.baseBulge`, baseBulge, g.baseBulge);
    const bulge = planBulge(plan, l.id);
    cmpNum(t, `${w}.bulge`, bulge, g.bulge);
    const kind = bulge === 0 ? "straight" : bulge === baseBulge ? "base" : BULGE_LADDER.includes(Math.abs(bulge)) ? "ladder" : "solved";
    cmpEq(t, `${w}.bulgeKind`, kind, g.bulgeKind);
  });
  cmpEq(t, "routePlanBowedCount", plan.bulges.size, golden.routePlanBowedCount);

  const bounds = boundsOfCentres(nodes);
  if (bounds && golden.contentBounds) cmpRect(t, "contentBounds", bounds, golden.contentBounds);
  else cmpEq(t, "contentBounds", bounds, golden.contentBounds);
  const viewport = { width: golden.viewportSize[0], height: golden.viewportSize[1] };
  if (bounds) {
    const fit = fitting(bounds, viewport, FIT_MARGIN, ZOOM_RANGE);
    cmpNum(t, "zoomToFit.fittingScale", fit.scale, golden.zoomToFit.fittingScale);
    cmpPt(t, "zoomToFit.fittingPan", { x: fit.pan.width, y: fit.pan.height }, golden.zoomToFit.fittingPan);
  }
  const content = sceneContentRect(nodes, links, plan);
  if (content && golden.exportContentRect) cmpRect(t, "exportContentRect", content, golden.exportContentRect);
  else cmpEq(t, "exportContentRect", content, golden.exportContentRect);

  for (const view of golden.views as G[]) {
    const v = `view ${view.name}`;
    const tr = makeTransform(view.scale, { width: view.pan[0], height: view.pan[1] }, viewport);
    const s = tr.scale;
    cmpRect(t, `${v}.visibleWorldRect`, visibleWorldRect(tr), view.visibleWorldRect);
    const grid = buildGrid(tr, viewport, GRID_SPACING);
    const gg = view.grid;
    cmpNum(t, `${v}.grid.cell`, grid.cell, gg.cell);
    cmpNum(t, `${v}.grid.major`, grid.major, gg.major);
    cmpNum(t, `${v}.grid.minorAlpha`, grid.minorAlpha, gg.minorAlpha);
    cmpNum(t, `${v}.grid.majorAlpha`, grid.majorAlpha, gg.majorAlpha);
    cmpEq(t, `${v}.grid.minorDotCount`, grid.minorDots?.length ?? 0, gg.minorDotCount);
    cmpEq(t, `${v}.grid.majorLineCount`, grid.majorLines?.length ?? 0, gg.majorLineCount);
    cmpNum(t, `${v}.grid.minorFirstX`, firstLine(tr.pan.width, grid.cell), gg.minorFirstX);
    cmpNum(t, `${v}.grid.minorFirstY`, firstLine(tr.pan.height, grid.cell), gg.minorFirstY);
    cmpNum(t, `${v}.grid.majorFirstX`, firstLine(tr.pan.width, grid.major), gg.majorFirstX);
    cmpNum(t, `${v}.grid.majorFirstY`, firstLine(tr.pan.height, grid.major), gg.majorFirstY);
    cmpEq(t, `${v}.chipsShown`, chipsShown(s), view.chipsShown);

    const scene = buildScene({ nodes, links, transform: tr, classFilter: null, routePlan: plan });
    nodes.forEach((n, i) => {
      const g = view.nodes[i];
      const gn = golden.nodes[i];
      const w = `${v} node ${gn.name}`;
      cmpPt(t, `${w}.displayCentre`, scene.displayCentres.get(n.id)!, g.displayCentre);
      const size = outlineSize(n.kind);
      cmpPt(t, `${w}.bodyDisplaySize`, { x: size.width * s, y: size.height * s }, g.bodyDisplaySize);
      cmpRect(t, `${w}.displayRect`, rectToDisplay(tr, nodeWorldRect(n)), g.displayRect);
      cmpRect(t, `${w}.labelDisplayRect`, rectToDisplay(tr, nodeLabelRect(n)), g.labelDisplayRect);
      cmpNum(t, `${w}.hitSlopLocal`, 3 / s, g.hitSlopLocal);
      cmpNum(t, `${w}.strokeWidth`, nodeStrokeWidth(s), g.strokeWidth);
      cmpEq(t, `${w}.nameRowShown`, nameRowShown(s), g.nameRowShown);
      cmpEq(t, `${w}.detailRowShown`, detailRowShown(s, gn.detailText !== null), g.detailRowShown);
      cmpEq(t, `${w}.rateRowShown`, rateRowShown(s, gn.rateText !== null), g.rateRowShown);
      cmpNum(t, `${w}.labelBlockDisplayWidth`, labelBlockDisplayWidth(s), g.labelBlockDisplayWidth);
      cmpNum(t, `${w}.nameFontSize`, nameFontSize(s), g.nameFontSize);
      cmpNum(t, `${w}.detailFontSize`, detailFontSize(s), g.detailFontSize);
    });

    const order = new Map(scene.links.map((item, k) => [item.id, k]));
    links.forEach((l, i) => {
      const g = view.links[i];
      const w = `${v} link ${i} ${golden.links[i].from}->${golden.links[i].to} c${l.customerClass}`;
      const k = order.get(l.id);
      cmpEq(t, `${w}.visible`, k !== undefined, g.visible);
      if (k === undefined) return;
      cmpEq(t, `${w}.drawOrder`, k, g.drawOrder);
      const geo = scene.links[k].geometry;
      const slot = bundleSlot(groups, l);
      const self = l.fromNodeID === l.toNodeID;
      cmpNum(t, `${w}.parallelOffset`, self ? 0 : slot.offsetWorld * s, g.parallelOffset);
      if (self) cmpNum(t, `${w}.selfLoopExtraRadius`, slot.index * 8 * s, g.selfLoopExtraRadius);
      cmpNum(t, `${w}.bulge`, planBulge(plan, l.id) * s, g.bulge);
      cmpNum(t, `${w}.lineWidth`, lineWidth(s), g.lineWidth);
      cmpNum(t, `${w}.arrowLength`, arrowLength(s), g.arrowLength);
      cmpNum(t, `${w}.wingSpread`, arrowLength(s) * Math.tan(ARROW_HALF_ANGLE), g.wingSpread);
      cmpPt(t, `${w}.start`, geo.start, g.start);
      cmpPt(t, `${w}.base`, geo.base, g.base);
      cmpPt(t, `${w}.tip`, geo.tip, g.tip);
      cmpPt(t, `${w}.wingLeft`, geo.wingLeft, g.wingLeft);
      cmpPt(t, `${w}.wingRight`, geo.wingRight, g.wingRight);
      cmpEq(t, `${w}.route.type`, geo.route.kind, g.route.type);
      if (geo.route.kind === "quad" && g.route.type === "quad") cmpPt(t, `${w}.route.control`, geo.route.control, g.route.control);
      if (geo.route.kind === "cubic" && g.route.type === "cubic") {
        cmpPt(t, `${w}.route.c1`, geo.route.c1, g.route.c1);
        cmpPt(t, `${w}.route.c2`, geo.route.c2, g.route.c2);
      }
      cmpPt(t, `${w}.labelAnchor`, geo.labelAnchor, g.labelAnchor);
      cmpEq(t, `${w}.chipPolicy`, chipPolicy(s, l.routingProbability), g.chipPolicy);
      cmpEq(t, `${w}.chipText`, chipText(l.routingProbability), g.chipText);
      cmpNum(t, `${w}.chipFontSize`, chipFontSize(s), g.chipFontSize);
      cmpEq(t, `${w}.polyline.length`, geo.polyline.length, g.polyline.length);
      geo.polyline.forEach((p, j) => g.polyline[j] && cmpPt(t, `${w}.polyline[${j}]`, p, g.polyline[j]));
    });
  }
}

const goldenFiles = Object.keys(goldens)
  .filter((p) => p.endsWith(".json") && !p.endsWith("PROVENANCE.json"))
  .sort();

describe("canvas geometry against 0.90.34 (golden/canvas)", () => {
  it("has a golden scene for every shipped example", () => {
    expect(goldenFiles.length).toBe(50);
    expect(Object.keys(examples).length).toBe(50);
    for (const g of goldenFiles) expect(exampleFor(name(g)), name(g)).toBeDefined();
  });

  const total = makeTally();
  const cases: [string, string, string][] = [
    ...goldenFiles.map((g): [string, string, string] => [name(g), examples[exampleFor(name(g))!], goldens[g]]),
    ...Object.keys(fixtureGoldens)
      .sort()
      .map((g): [string, string, string] => [`fixture ${name(g)}`, fixtureInputs[fixtureFor(name(g))!], fixtureGoldens[g]]),
  ];
  it("has the four hand-made fixtures", () => {
    expect(Object.keys(fixtureGoldens).length).toBe(4);
    for (const g of Object.keys(fixtureGoldens)) expect(fixtureFor(name(g)), name(g)).toBeDefined();
  });
  for (const [label, input, goldenText] of cases) {
    it(label, () => {
      const doc = parseDocument(input);
      const golden = JSON.parse(goldenText);
      const t = makeTally();
      compareExample(doc, golden, t);
      total.compared += t.compared;
      total.exact += t.exact;
      total.failures.push(...t.failures.map((f) => `${label}: ${f}`));
      if (t.maxDiff > total.maxDiff) {
        total.maxDiff = t.maxDiff;
        total.where = `${label}: ${t.where}`;
      }
      expect(t.failures.slice(0, 20)).toEqual([]);
      expect(t.compared).toBeGreaterThan(50);
    });
  }

  it("summary: every number matches, worst difference reported", () => {
    // Printed so the report can quote it: compared / exact / worst |diff| and where.
    console.info(`golden/canvas: ${total.compared} values compared, ${total.exact} bit-exact, worst |diff| ${total.maxDiff} at ${total.where || "—"}`);
    expect(total.failures).toEqual([]);
    expect(total.maxDiff).toBeLessThanOrEqual(TOLERANCE);
  });
});
