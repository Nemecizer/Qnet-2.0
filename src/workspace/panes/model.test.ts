// Which panes are on, maximized and detached, as pure rules over a settings snapshot.
import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../../dev/mock/kv";
import {
  arrangement, detachedWindows, detachPatch, everyPaneIsHome, isPaneEnabled, maximizeTarget, parseDetached, presetPatch, PRESETS, serializeDetached, shows,
  showAllPatch, soloedPane, soloPatch, toggleMaximizePatch, visibilityPatch, type Vals,
} from "./model";

const vals = (over: Record<string, unknown> = {}): Vals => {
  const all: Record<string, unknown> = { ...SETTINGS_DEFAULTS, ...over };
  return (k, f) => (k in all ? all[k] : f);
};

describe("pane visibility (WS-050, WS-051, WS-052)", () => {
  it("shows Tools, Status, Inspector and Shell on a fresh install, and hides Results and AI", () => {
    const v = vals();
    expect(["tools", "status", "inspector", "shell"].every((p) => isPaneEnabled(p as never, v))).toBe(true);
    expect(isPaneEnabled("results", v)).toBe(false);
    expect(isPaneEnabled("ai", v)).toBe(false);
    expect(isPaneEnabled("canvas", vals({}))).toBe(true);
  });

  it("writes the pane's own key, and a change of any toggle ends a stored maximize (MENU-072)", () => {
    expect(visibilityPatch({ results: true }, vals())).toEqual({ "results.paneVisible": true });
    expect(visibilityPatch({ results: true }, vals({ "panes.soloed": "status" }))).toEqual({ "results.paneVisible": true, "panes.soloed": "" });
    expect(visibilityPatch({ status: true }, vals({ "panes.soloed": "status" }))).toEqual({ "status.paneVisible": true });
  });
});

describe("the arrangement (WS-053, WS-054)", () => {
  it("lays out Tools | Canvas | (Inspector over Status), the Results row and Shell | AI", () => {
    const a = arrangement(vals({ "results.paneVisible": true, "ai.paneVisible": true }));
    expect(a).toMatchObject({ outer: ["top", "results", "bottom"], top: ["palette", "canvas", "right"], right: ["inspector", "status"], bottom: ["terminal", "ai"] });
  });

  it("drops a column or row when it is empty", () => {
    const a = arrangement(vals({ "status.paneVisible": false, "inspector.paneVisible": false, "shell.paneVisible": false }));
    expect(a).toMatchObject({ outer: ["top"], top: ["palette", "canvas"], right: [], bottom: [] });
  });
});

describe("maximize (WS-080…084)", () => {
  it("draws only the maximized pane; no toggle changes", () => {
    const v = vals({ "panes.soloed": "shell" });
    expect(shows("shell", v)).toBe(true);
    expect(shows("canvas", v)).toBe(false);
    expect(isPaneEnabled("status", v)).toBe(true);
    expect(arrangement(v)).toMatchObject({ outer: ["bottom"], top: [], bottom: ["terminal"] });
  });

  it("ignores a remembered maximize that is unknown, Tools, switched off or detached", () => {
    expect(soloedPane(vals({ "panes.soloed": "nonsense" }))).toBeNull();
    expect(soloedPane(vals({ "panes.soloed": "palette" }))).toBeNull();
    expect(soloedPane(vals({ "panes.soloed": "results" }))).toBeNull();
    expect(soloedPane(vals({ "panes.soloed": "status", "panes.detached": "status" }))).toBeNull();
    expect(soloedPane(vals({ "panes.soloed": "canvas" }))).toBe("canvas");
  });

  it("acts on the maximized pane, else the focused one, else the canvas; never Tools or a detached pane", () => {
    expect(maximizeTarget(null, vals())).toBe("canvas");
    expect(maximizeTarget("status", vals())).toBe("status");
    expect(maximizeTarget("tools", vals())).toBe("canvas");
    expect(maximizeTarget("status", vals({ "panes.detached": "status" }))).toBe("canvas");
    expect(maximizeTarget("status", vals({ "panes.soloed": "shell" }))).toBe("shell");
  });

  it("toggles: maximizing a second pane replaces the first, Restore clears it", () => {
    expect(toggleMaximizePatch("status", vals())).toEqual({ "panes.soloed": "status" });
    expect(toggleMaximizePatch("status", vals({ "panes.soloed": "shell" }))).toEqual({ "panes.soloed": "" });
    expect(soloPatch("inspector", vals({ "panes.soloed": "shell" }))).toEqual({ "panes.soloed": "inspector" });
    expect(soloPatch("tools", vals())).toBeNull();
  });
});

describe("detached panes (WS-086…096)", () => {
  it("stores the set in pane order, dropping unknown and undetachable names", () => {
    expect([...parseDetached("ai,palette,canvas,bogus,status")]).toEqual(["ai", "status"]);
    expect(serializeDetached(["inspector", "ai", "status", "shell", "results"])).toBe("status,results,shell,ai,inspector");
  });

  it("detaching switches the pane on and ends its own maximize; reattaching only docks it", () => {
    expect(detachPatch("ai", true, vals())).toEqual({ "ai.paneVisible": true, "panes.detached": "ai" });
    expect(detachPatch("status", true, vals({ "panes.soloed": "status" }))).toEqual({ "status.paneVisible": true, "panes.detached": "status", "panes.soloed": "" });
    expect(detachPatch("status", false, vals({ "panes.detached": "status,ai" }))).toEqual({ "panes.detached": "ai" });
    expect(detachPatch("tools", true, vals())).toBeNull();
    expect(detachPatch("canvas", true, vals())).toBeNull();
  });

  it("is never docked and detached at once; hiding a detached pane closes its window but keeps it detached", () => {
    const v = vals({ "panes.detached": "status" });
    expect(shows("status", v)).toBe(false);
    expect(detachedWindows(v)).toEqual(["status"]);
    const hidden = vals({ "panes.detached": "status", "status.paneVisible": false });
    expect(detachedWindows(hidden)).toEqual([]);
    expect(shows("status", hidden)).toBe(false);
  });
});

describe("Show All Panes and the presets (WS-060, WS-073…079)", () => {
  it("Show All Panes turns everything on, ends a maximize and docks everything; dimmed when all is home", () => {
    expect(showAllPatch()).toEqual({
      "panes.soloed": "",
      "panes.detached": "",
      "palette.paneVisible": true,
      "status.paneVisible": true,
      "shell.paneVisible": true,
      "ai.paneVisible": true,
      "inspector.paneVisible": true,
      "results.paneVisible": true,
    });
    expect(everyPaneIsHome(vals())).toBe(false);
    expect(everyPaneIsHome(vals({ "results.paneVisible": true, "ai.paneVisible": true }))).toBe(true);
    expect(everyPaneIsHome(vals({ "results.paneVisible": true, "ai.paneVisible": true, "panes.detached": "ai" }))).toBe(false);
  });

  it("sets each preset's panes, with no maximize and nothing detached", () => {
    const on = (id: string) => {
      const p = presetPatch(PRESETS.find((x) => x.id === id)!);
      expect(p).toMatchObject({ "panes.soloed": "", "panes.detached": "" });
      return ["palette", "status", "inspector", "results", "shell", "ai"].filter((k) => p[`${k}.paneVisible`]);
    };
    expect(on("build")).toEqual(["palette", "status", "inspector"]);
    expect(on("analyze")).toEqual(["status", "inspector", "results"]);
    expect(on("run")).toEqual(["status", "results", "shell"]);
    expect(on("shell")).toEqual(["status", "shell"]);
    expect(on("canvas")).toEqual([]);
    expect(PRESETS.map((p) => p.row ?? null)).toEqual([null, ["results", 0.5], null, ["bottom", 0.45], null]);
  });
});
