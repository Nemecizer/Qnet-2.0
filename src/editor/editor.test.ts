// The editor model: 0.90.34's NetworkEditorModel rules, checked one by one. The scripted replays
// against 0.90.34 itself are src/editor/replay.test.ts (golden/edits/).
import { beforeEach, describe, expect, it } from "vitest";
import { activeTab, getWorkspace, isDirty, markSaved } from "../workspace/store";
import { activeEditor, editorClock } from ".";
import type { Editor } from "./editor";
import { UndoManager } from "./undo";
import { cFixed, displayFixed, formatSig } from "./numbers";
import { maxNameIndex, numericSuffix, sortIndex } from "./naming";

/** Runs `f` as one event: the undo group closes when it returns, as at the end of an AppKit event. */
async function event(f: () => void) {
  f();
  await Promise.resolve();
}

const log = () => activeTab().log.map((e) => e.text);
const names = (e: Editor) => e.nodes.map((n) => n.name);

let now = 0;
beforeEach(() => {
  now = 1_000_000;
  editorClock.now = () => now;
});

describe("names and numbers", () => {
  it("reads the number in a name as 0.90.34's NodeNaming did", () => {
    expect(numericSuffix("S12")).toBe(12);
    expect(numericSuffix("Src3")).toBe(3);
    expect(numericSuffix("S2a")).toBeNull();
    expect(numericSuffix("CPU")).toBeNull();
    expect(sortIndex("CPU")).toBeGreaterThan(sortIndex("S999"));
    // dropFirst(prefix.count) then Int(): a sign is allowed, anything else isn't.
    expect(maxNameIndex(["S3", "S10", "Sx", "S-2"], "S")).toBe(10);
    expect(maxNameIndex(["Sink2", "Sink"], "Sink")).toBe(2);
  });

  it("formats fixed decimals as printf does, ties to even", () => {
    expect(cFixed(0.125, 2)).toBe("0.12");
    expect(cFixed(0.375, 2)).toBe("0.38");
    expect(cFixed(2.5, 0)).toBe("2");
    expect(displayFixed(0.9, 3)).toBe("0.900");
    expect(displayFixed(-0.0001, 3)).toBe("-1.00e-04");
    expect(displayFixed(-0.0004, 3)).toBe("-4.00e-04");
    expect(displayFixed(-0.00, 3)).toBe("0.000");
    expect(formatSig(1.25, 4)).toBe("1.25");
    expect(formatSig(2, 5)).toBe("2");
  });
});

describe("the undo manager", () => {
  it("puts everything registered in one event into one group, named by the last name", async () => {
    const um = new UndoManager();
    const done: string[] = [];
    await event(() => {
      um.registerUndo(() => done.push("a"));
      um.setActionName("First");
      um.registerUndo(() => done.push("b"));
      um.setActionName("Second");
    });
    expect(um.undoActionName).toBe("Second");
    um.undo();
    expect(done).toEqual(["b", "a"]);
    expect(um.canUndo).toBe(false);
  });
});

describe("placing nodes", () => {
  it("names S1, B1, Src1, Sink1, born at ρ = 0.9, each one undo step", async () => {
    const e = activeEditor();
    for (const t of ["addStation", "addBuffer", "addSource", "addSink"] as const) {
      e.setTool(t);
      await event(() => e.handleCanvasTap({ x: 100, y: 100 }));
    }
    expect(names(e)).toEqual(["S1", "B1", "Src1", "Sink1"]);
    expect(e.nodes[0].distributionParameters).toBe("rate=1.1111111");
    expect(e.nodes[2]).toMatchObject({ distribution: "poisson", distributionParameters: "lambda=1.0" });
    expect(log()).toEqual([
      "Added station S1 — μ = 1.1111111, so ρ = 0.900 against the default source rate.",
      "Added buffer B1.",
      "Added source Src1 — Poisson arrivals at λ = 1.000.",
      "Added sink Sink1.",
    ]);
    expect(e.undoManager.undoActionName).toBe("Add Sink");
    await event(() => e.undo());
    expect(names(e)).toEqual(["S1", "B1", "Src1"]);
    expect(log().at(-1)).toBe("Undid: Add Sink.");
    // The counter came back with the snapshot: the next sink is Sink1 again.
    e.setTool("addSink");
    await event(() => e.handleCanvasTap({ x: 10, y: 10 }));
    expect(names(e).at(-1)).toBe("Sink1");
  });
});

describe("the Link tool's chain", () => {
  async function chain(e: Editor) {
    e.setTool("addSource");
    await event(() => e.handleCanvasTap({ x: 0, y: 0 }));
    e.setTool("addStation");
    await event(() => e.handleCanvasTap({ x: 100, y: 0 }));
    e.setTool("addSink");
    await event(() => e.handleCanvasTap({ x: 200, y: 0 }));
    e.setTool("addLink");
    const [src, s1, sink] = e.nodes;
    return { src, s1, sink };
  }

  it("links click by click, continues the chain and ends it at a sink", async () => {
    const e = activeEditor();
    const { src, s1, sink } = await chain(e);
    await event(() => e.handleNodeTap(src.id));
    await event(() => e.handleNodeTap(s1.id));
    await event(() => e.handleNodeTap(sink.id));
    expect(e.links.map((l) => [l.fromNodeID, l.toNodeID, l.customerClass])).toEqual([
      [src.id, s1.id, 0],
      [s1.id, sink.id, 0],
    ]);
    expect(log().slice(-3)).toEqual([
      "Link start: Src1. Click target node.",
      "Linked Src1 -> S1 [Class 1]. Click next node to continue chain.",
      "Linked S1 -> Sink1 [Class 1]. Chain complete at Sink1 — click a node to start another.",
    ]);
    expect(e.view.pendingLinkStartID).toBeNull();
  });

  it("refuses what the exporters couldn't solve, each with its reason", async () => {
    const e = activeEditor();
    const { src, s1, sink } = await chain(e);
    await event(() => e.handleNodeTap(sink.id));
    expect(log().at(-1)).toBe("Cannot link out of Sink1: a sink is where jobs leave the network.");
    await event(() => e.handleNodeTap(s1.id));
    await event(() => e.handleNodeTap(sink.id));
    expect(log().at(-1)).toBe("Cannot add link: S1 has no incoming links.");
    await event(() => e.handleNodeTap(src.id));
    await event(() => e.handleNodeTap(src.id));
    expect(log().at(-1)).toBe("Cannot link Src1 to itself: a source has no service to repeat.");
    expect(e.links).toHaveLength(0);
  });

  it("warns when a self-loop takes a station's routing past 1", async () => {
    const e = activeEditor();
    const { src, s1, sink } = await chain(e);
    for (const id of [src.id, s1.id, sink.id, s1.id, s1.id]) await event(() => e.handleNodeTap(id));
    expect(e.links).toHaveLength(3);
    expect(log().slice(-2)).toEqual([
      "Linked S1 -> S1 [Class 1]. Click next node to continue chain.",
      "Routing from S1 for Class 1 now sums to 2 — set the probabilities in the Inspector.",
    ]);
  });
});

describe("deleting, copying and pasting", () => {
  it("names the undo step after what went, and pastes under fresh names 60 pt away", async () => {
    const e = activeEditor();
    e.setTool("addStation");
    await event(() => e.handleCanvasTap({ x: 0, y: 0 }));
    await event(() => e.handleCanvasTap({ x: 100, y: 0 }));
    e.setTool("select");
    await event(() => e.selectAll());
    await event(() => e.copySelection());
    expect(log().at(-1)).toBe("Copied 2 nodes.");
    await event(() => e.pasteSelection());
    expect(names(e)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(e.nodes[2].position).toEqual([60, 60]);
    expect(e.undoManager.undoActionName).toBe("Paste");
    await event(() => e.deleteSelection());
    expect(e.undoManager.undoActionName).toBe("Delete Selection");
    expect(log().at(-1)).toBe("Deleted 2 nodes.");
    await event(() => e.cutSelection());
    expect(log().at(-1)).toBe("Nothing selected to cut. Select nodes to cut, or press Delete to remove a selected link.");
  });
});

describe("nudging", () => {
  it("coalesces a run of presses into one undo step, and a pause starts a new one", async () => {
    const e = activeEditor();
    e.setTool("addStation");
    await event(() => e.handleCanvasTap({ x: 0, y: 0 }));
    for (let i = 0; i < 5; i++) {
      now += 70;
      await event(() => e.nudgeSelection({ width: 1, height: 0 }));
    }
    e.endNudgeRun();
    await Promise.resolve();
    expect(e.nodes[0].position).toEqual([5, 0]);
    expect(e.undoManager.undoActionName).toBe("Move Node");
    await event(() => e.undo());
    expect(e.nodes[0].position).toEqual([0, 0]);
    expect(e.undoManager.undoActionName).toBe("Add Station");
  });

  it("snaps the anchor to the grid and moves a whole cell per press while snapping", async () => {
    const e = activeEditor();
    e.setTool("addStation");
    await event(() => e.handleCanvasTap({ x: 10, y: 0 }));
    e.setSnapToGrid(true);
    const step = e.nudgeStep(false);
    expect(step).toBe(28);
    await event(() => e.nudgeSelection({ width: step, height: 0 }));
    expect(e.nodes[0].position).toEqual([28, 0]);
  });
});

describe("unsaved changes", () => {
  it("are gone again when every edit has been undone (0.90.34 compared content)", async () => {
    const e = activeEditor();
    const id = getWorkspace().activeId;
    e.setTool("addStation");
    await event(() => e.handleCanvasTap({ x: 0, y: 0 }));
    markSaved(id, "/n/a.bnet", "a.bnet");
    expect(isDirty(activeTab())).toBe(false);
    await event(() => e.handleCanvasTap({ x: 50, y: 0 }));
    expect(isDirty(activeTab())).toBe(true);
    await event(() => e.undo());
    expect(isDirty(activeTab())).toBe(false);
    // Zoom is the view, not the document.
    e.setZoom(2);
    expect(isDirty(activeTab())).toBe(false);
  });
});
