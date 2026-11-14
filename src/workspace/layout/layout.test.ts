// The pane layout's arithmetic (jsdom has no layout, so the rules are tested as functions).
import { describe, expect, it } from "vitest";
import {
  aiPaneWidth, basisOf, contentMinHeight, dragDivider, extentOf, L, lPath, migrationPatch, mirrorPatch, presetRowHeight, quadrantOf, savePatch, SPLITS,
  type Shown,
} from "./sizes";
import { cascadeFrom, detachedFrameKey, isDegenerate } from "./frames";

const all: Shown = { palette: true, canvas: true, status: true, inspector: true, results: true, shell: true, ai: true };

describe("pane sizes (WS-057, WS-058, WS-059)", () => {
  it("gives each pane 0.90.34's minimum, ideal and maximum", () => {
    expect(extentOf("TopHSplit", "palette", all, 255)).toEqual({ min: 152, ideal: 176, max: 240 });
    expect(extentOf("TopHSplit", "canvas", all, 255)).toEqual({ min: 496 });
    expect(extentOf("TopHSplit", "right", all, 255)).toEqual({ min: 288, ideal: 320 });
    expect(extentOf("RightVSplit", "inspector", all, 255)).toEqual({ min: 200, ideal: 360 });
    expect(extentOf("RightVSplit", "status", all, 255)).toEqual({ min: 200 });
    expect(extentOf("OuterVSplit", "top", all, 255)).toEqual({ min: 320, ideal: 520 });
    expect(extentOf("OuterVSplit", "results", all, 255)).toEqual({ min: 192, ideal: 248 });
    expect(extentOf("BottomHSplit", "terminal", all, 255)).toEqual({ min: 496 });
    expect(extentOf("BottomHSplit", "ai", all, 300)).toEqual({ min: 224, ideal: 300 });
  });

  it("asks 424 pt for the bottom row when the Shell is shown without the AI pane and without Results", () => {
    expect(extentOf("OuterVSplit", "bottom", all, 255).ideal).toBe(248);
    expect(extentOf("OuterVSplit", "bottom", { ...all, ai: false, results: false }, 255).ideal).toBe(424);
    expect(extentOf("OuterVSplit", "bottom", { ...all, ai: false }, 255).ideal).toBe(248);
  });

  it("takes the AI pane's ideal width from its saved width, then the legacy array, else 255", () => {
    expect(aiPaneWidth({})).toBe(255);
    expect(aiPaneWidth({ "SplitSizes.BottomHSplit": [700, 310] })).toBe(310);
    expect(aiPaneWidth({ "SplitPane.BottomHSplit.ai": 280, "SplitSizes.BottomHSplit": [700, 310] })).toBe(280);
    expect(aiPaneWidth({ "SplitPane.BottomHSplit.ai": 5 })).toBe(255);
  });

  it("lays a pane out at its saved size, inside its range, else at its ideal", () => {
    const ext = extentOf("TopHSplit", "palette", all, 255);
    expect(basisOf("TopHSplit", "palette", ext, {})).toBe(176);
    expect(basisOf("TopHSplit", "palette", ext, { "SplitPane.TopHSplit.palette": 200 })).toBe(200);
    expect(basisOf("TopHSplit", "palette", ext, { "SplitPane.TopHSplit.palette": 900 })).toBe(240);
    expect(basisOf("TopHSplit", "palette", ext, { "SplitPane.TopHSplit.palette": 1 })).toBe(176);
  });
});

describe("splitters (WS-063, WS-064, WS-066, WS-067)", () => {
  it("names the four split views, their full pane sets and flexible panes", () => {
    expect(Object.values(SPLITS).map((s) => [s.name, s.canonical.join(","), s.flexible])).toEqual([
      ["OuterVSplit", "top,results,bottom", "top"],
      ["TopHSplit", "palette,canvas,right", "canvas"],
      ["RightVSplit", "inspector,status", "status"],
      ["BottomHSplit", "terminal,ai", "terminal"],
    ]);
  });

  it("moves only the divider's two neighbours, each kept inside its range", () => {
    const ext = [extentOf("TopHSplit", "palette", all, 255), extentOf("TopHSplit", "canvas", all, 255), extentOf("TopHSplit", "right", all, 255)];
    expect(dragDivider([176, 1000, 320], ext, 0, 30)).toEqual([206, 970, 320]);
    expect(dragDivider([176, 1000, 320], ext, 0, 500)).toEqual([240, 936, 320]); // Tools max 240
    expect(dragDivider([176, 1000, 320], ext, 0, -100)).toEqual([152, 1024, 320]); // Tools min 152
    expect(dragDivider([176, 600, 320], ext, 1, -200)).toEqual([176, 496, 424]); // canvas min 496
    expect(dragDivider([176, 600, 320], ext, 1, 200)).toEqual([176, 632, 288]); // right column min 288
    // Results | bottom: two fixed rows trade height; the canvas row is untouched.
    const rows = [extentOf("OuterVSplit", "top", all, 255), extentOf("OuterVSplit", "results", all, 255), extentOf("OuterVSplit", "bottom", all, 255)];
    expect(dragDivider([400, 248, 248], rows, 1, 100)).toEqual([400, 304, 192]);
  });

  it("saves every non-flexible pane, and the legacy array only with the full set", () => {
    expect(savePatch(SPLITS.TopHSplit, ["palette", "canvas", "right"], [180, 900, 320])).toEqual({
      "SplitPane.TopHSplit.palette": 180,
      "SplitPane.TopHSplit.right": 320,
      "SplitSizes.TopHSplit": [180, 900, 320],
    });
    expect(savePatch(SPLITS.TopHSplit, ["canvas", "right"], [1000, 330])).toEqual({ "SplitPane.TopHSplit.right": 330 });
    expect(savePatch(SPLITS.TopHSplit, ["canvas"], [1000])).toBeNull();
    expect(savePatch(SPLITS.TopHSplit, ["canvas", "right"], [1000, 1])).toBeNull();
  });

  it("mirrors the right column's width to the AI pane only while both rows show every pane", () => {
    const top = ["palette", "canvas", "right"];
    const bottom = ["terminal", "ai"];
    expect(mirrorPatch("TopHSplit", 340, top, bottom, 255, 1500)).toEqual({ "SplitPane.BottomHSplit.ai": 340 });
    expect(mirrorPatch("BottomHSplit", 300, top, bottom, 320, 1500)).toEqual({ "SplitPane.TopHSplit.right": 300 });
    expect(mirrorPatch("TopHSplit", 340, ["canvas", "right"], bottom, 255, 1500)).toBeNull();
    expect(mirrorPatch("TopHSplit", 340, top, ["terminal"], 255, 1500)).toBeNull();
    expect(mirrorPatch("TopHSplit", 340.3, top, bottom, 340, 1500)).toBeNull();
  });
});

describe("one-time split repairs (WS-066, WS-068)", () => {
  it("clears the corrupt bottom array once, seeds …right from …status, and seeds missing keys from legacy arrays", () => {
    const p = migrationPatch({
      "SplitSizes.BottomHSplit": [400, 300],
      "SplitPane.TopHSplit.status": 330,
      "SplitSizes.OuterVSplit": [500, 200, 250],
      "SplitPane.OuterVSplit.results": 210,
    });
    expect(p).toEqual({
      "SplitSizes.BottomHSplit": null,
      "migration.bottomHSplit.2026-04-24": true,
      "SplitPane.TopHSplit.right": 330,
      "SplitPane.OuterVSplit.bottom": 250,
    });
    expect(migrationPatch({ "migration.bottomHSplit.2026-04-24": true, "SplitPane.TopHSplit.right": 300, "SplitPane.TopHSplit.status": 330 })).toEqual({});
  });
});

describe("presets and the window's minimum size (WS-002, WS-079)", () => {
  it("writes a preset's row as a share of the window, clamped, or nothing when the minimums don't fit", () => {
    expect(presetRowHeight(900, 800, 0.45)).toBe(405);
    expect(presetRowHeight(900, 600, 0.45)).toBe(279); // leaves the canvas row 320 (+ the divider)
    expect(presetRowHeight(300, 800, 0.45)).toBe(192);
    expect(presetRowHeight(900, 500, 0.45)).toBeNull();
  });

  it("sums the rows shown: 320 for the canvas row, 192 for each other", () => {
    expect(contentMinHeight(["top"])).toBe(320);
    expect(contentMinHeight(["top", "bottom"])).toBe(512);
    expect(contentMinHeight(["top", "results", "bottom"])).toBe(704);
    expect(contentMinHeight(["results"])).toBe(192);
    expect(L.mainMinWidth).toBe(1000);
  });
});

describe("corner grips (WS-070)", () => {
  it("draws the L for the quadrant under the pointer", () => {
    expect(quadrantOf(-3, -3)).toBe("upperLeft");
    expect(quadrantOf(3, -3)).toBe("upperRight");
    expect(quadrantOf(-3, 3)).toBe("lowerLeft");
    expect(quadrantOf(0, 0)).toBe("lowerRight");
    expect(lPath("upperLeft")).toBe("M12 0 L12 12 L0 12"); // ┘
    expect(lPath("lowerRight")).toBe("M12 24 L12 12 L24 12"); // ┌
  });
});

describe("detached panes' window frames (WS-092)", () => {
  it("keeps each pane's frame under its own key, and ignores frames 200 pt or smaller", () => {
    expect(detachedFrameKey("shell")).toBe("WindowFrame.DetachedPane.shell");
    expect(isDegenerate({ x: 0, y: 0, w: 200, h: 900 })).toBe(true);
    expect(isDegenerate({ x: 0, y: 0, w: 880, h: 560 })).toBe(false);
  });

  it("cascades a window that has no remembered frame from the previous one", () => {
    const own = { x: 300, y: 200 };
    expect(cascadeFrom(null, own)).toBe(own);
    expect(cascadeFrom({ x: 300, y: 200 }, own)).toEqual({ x: 322, y: 222 });
  });
});
