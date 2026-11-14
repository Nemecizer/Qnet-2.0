// The link-creation rules of ledger §3.3 as the editor implements them (src/editor/editor.ts
// `handleLinkSelection`, `handleCanvasTap`, `cycleLinkCustomerClass`; 0.90.34 NetworkEditorModel.swift),
// and the class filter's effect on what the scene draws and hit-tests (CAN-062).
import { describe, expect, it } from "vitest";
import { activeEditor } from "../editor";
import type { Editor } from "../editor/editor";
import { activeTab } from "../workspace/store";
import { buildScene, hitLink } from "./geometry/scene";
import { makeTransform } from "./geometry/transform";

/** One event: the undo group closes when it returns. */
async function event(f: () => void) {
  f();
  await Promise.resolve();
}
const log = () => activeTab().log.map((e) => e.text);
const last = () => log().at(-1);

/** Src1 → B1 → S1 → Sink1 placed (no links yet), the Link tool chosen. */
async function chain(): Promise<{ e: Editor; src: string; b: string; s: string; sink: string; src2?: string }> {
  const e = activeEditor();
  let src = "", b = "", s = "", sink = "";
  await event(() => (src = e.addNode("source", { x: 100, y: 100 }).id));
  await event(() => (b = e.addNode("buffer", { x: 200, y: 100 }).id));
  await event(() => (s = e.addNode("station", { x: 300, y: 100 }).id));
  await event(() => (sink = e.addNode("sink", { x: 400, y: 100 }).id));
  e.setTool("addLink");
  return { e, src, b, s, sink };
}

describe("the Link tool's two-click flow (CAN-045…CAN-052)", () => {
  it("starts a chain on a first click, fixing the class from a source", async () => {
    const { e, src } = await chain();
    await event(() => e.handleNodeTap(src));
    expect(e.view.pendingLinkStartID).toBe(src);
    expect(e.view.selectedNodeID).toBe(src);
    expect(e.view.activeLinkSourceID).toBe(src);
    expect(e.view.activeCustomerClass).toBe(0);
    expect(last()).toBe("Link start: Src1. Click target node.");
  });

  it("refuses to start from a sink", async () => {
    const { e, sink } = await chain();
    await event(() => e.handleNodeTap(sink));
    expect(e.view.pendingLinkStartID).toBeNull();
    expect(last()).toBe("Cannot link out of Sink1: a sink is where jobs leave the network.");
  });

  it("makes a self-loop only on a station, clearing the start otherwise", async () => {
    const { e, src, b, s } = await chain();
    for (const [id, why] of [
      [src, "Cannot link Src1 to itself: a source has no service to repeat."],
      [b, "Cannot link B1 to itself: a buffer has no service to repeat — put the loop on the station it feeds."],
    ] as const) {
      await event(() => e.handleNodeTap(id));
      await event(() => e.handleNodeTap(id));
      expect(last()).toBe(why);
      expect(e.view.pendingLinkStartID).toBeNull();
    }
    // A station needs an incoming class first.
    await event(() => e.handleNodeTap(src));
    await event(() => e.handleNodeTap(b));
    await event(() => e.handleNodeTap(s));
    await event(() => e.handleNodeTap(s));
    expect(e.links.some((l) => l.fromNodeID === s && l.toNodeID === s)).toBe(true);
  });

  it("refuses a buffer or station with no incoming links", async () => {
    const { e, b, s } = await chain();
    await event(() => e.handleNodeTap(b));
    await event(() => e.handleNodeTap(s));
    expect(last()).toBe("Cannot add link: B1 has no incoming links.");
    expect(e.view.pendingLinkStartID).toBeNull();
    expect(e.links).toHaveLength(0);
  });

  it("creates the link at p = 1, selected, one 'Add Link' undo step, and carries the chain on to the target", async () => {
    const { e, src, b } = await chain();
    await event(() => e.handleNodeTap(src));
    await event(() => e.handleNodeTap(b));
    expect(e.links).toHaveLength(1);
    const l = e.links[0];
    expect([l.fromNodeID, l.toNodeID, l.routingProbability, l.customerClass]).toEqual([src, b, 1, 0]);
    expect(e.view.selectedLinkID).toBe(l.id);
    expect(e.view.pendingLinkStartID).toBe(b);
    expect(last()).toBe("Linked Src1 -> B1 [Class 1]. Click next node to continue chain.");
    expect(e.undoManager.undoActionName).toBe("Add Link");
  });

  it("ends the chain at a sink", async () => {
    const { e, src, b, s, sink } = await chain();
    for (const id of [src, b, s, sink]) await event(() => e.handleNodeTap(id));
    expect(last()).toBe("Linked S1 -> Sink1 [Class 1]. Chain complete at Sink1 — click a node to start another.");
    expect(e.view.pendingLinkStartID).toBeNull();
  });

  it("refuses a pair already linked on every available class, keeping the start", async () => {
    const { e, src, b } = await chain();
    await event(() => e.handleNodeTap(src));
    await event(() => e.handleNodeTap(b));
    await event(() => e.handleCanvasTap({ x: 900, y: 900 }));
    await event(() => e.handleNodeTap(src));
    await event(() => e.handleNodeTap(b));
    expect(last()).toBe("All available classes already linked from Src1 to B1.");
    expect(e.view.pendingLinkStartID).toBe(src);
    expect(e.links).toHaveLength(1);
  });

  it("warns when a class's routing from the start now sums above 1", async () => {
    const { e, src, b, s, sink } = await chain();
    for (const id of [src, b, s, sink]) await event(() => e.handleNodeTap(id));
    await event(() => e.handleNodeTap(s));
    await event(() => e.handleNodeTap(b));
    expect(log().slice(-1)[0]).toBe("Routing from S1 for Class 1 now sums to 2 — set the probabilities in the Inspector.");
  });

  it("cancels a pending chain on a click on empty canvas", async () => {
    const { e, src } = await chain();
    await event(() => e.handleNodeTap(src));
    await event(() => e.handleCanvasTap({ x: 900, y: 900 }));
    expect(e.view.pendingLinkStartID).toBeNull();
    expect(e.view.activeLinkSourceID).toBeNull();
    expect(e.view.selectedNodeID).toBeNull();
  });
});

describe("cycling a selected link's class (CAN-057)", () => {
  it("moves it to the next class unused on its pair, one 'Change Link Class' step", async () => {
    const e = activeEditor();
    let a = "", a2 = "", b = "";
    await event(() => (a = e.addNode("source", { x: 0, y: 0 }).id));
    await event(() => (a2 = e.addNode("source", { x: 0, y: 100 }).id));
    await event(() => (b = e.addNode("buffer", { x: 100, y: 0 }).id));
    let l = "";
    await event(() => (l = e.addLink(a, b, 0).id));
    void a2;
    e.setView({ selectedLinkID: null });
    await event(() => e.handleLinkTap(l));
    expect(e.view.selectedLinkID).toBe(l);
    await event(() => e.handleLinkTap(l));
    expect(e.link(l)!.customerClass).toBe(1);
    expect(last()).toBe("Changed Src1 -> B1 to Class 2.");
    expect(e.undoManager.undoActionName).toBe("Change Link Class");
    await event(() => e.addLink(a, b, 0));
    e.setView({ selectedLinkID: l });
    await event(() => e.handleLinkTap(l));
    // With every other class taken the walk comes round to the link's own class (offset = total),
    // so 0.90.34 re-sets it rather than saying "All customer classes are already used…".
    expect(last()).toBe("Changed Src1 -> B1 to Class 2.");
    expect(e.link(l)!.customerClass).toBe(1);
  });
});

describe("the class filter (CAN-062)", () => {
  it("draws and hit-tests only the filtered class, and clears on an empty click, on Clear and on load", async () => {
    const e = activeEditor();
    let a = "", b = "";
    await event(() => (a = e.addNode("station", { x: 100, y: 100 }).id));
    await event(() => (b = e.addNode("station", { x: 300, y: 100 }).id));
    await event(() => e.addLink(a, b, 0));
    await event(() => e.addLink(a, b, 1));
    const t = makeTransform(1, { width: 0, height: 0 }, { width: 800, height: 600 });
    const all = buildScene({ nodes: e.nodes, links: e.links, transform: t, classFilter: null, routePlan: null });
    const one = buildScene({ nodes: e.nodes, links: e.links, transform: t, classFilter: 1, routePlan: null });
    expect(all.links).toHaveLength(2);
    expect(one.links.map((l) => l.link.customerClass)).toEqual([1]);
    const c0 = all.links.find((l) => l.link.customerClass === 0)!.geometry.labelAnchor;
    expect(hitLink(one, c0, 50)?.customerClass).toBe(1);
    e.setView({ classFilter: 1 });
    e.handleCanvasTap({ x: 700, y: 500 });
    expect(e.view.classFilter).toBeNull();
    e.setView({ classFilter: 1 });
    await event(() => e.clear());
    expect(e.view.classFilter).toBeNull();
    e.setView({ classFilter: 1 });
    e.loadNetwork({ nodes: [], links: [], infiniteBuffers: false, canvasScale: 1, canvasPanOffset: [0, 0] });
    expect(e.view.classFilter).toBeNull();
  });
});

describe("placing nodes and pictures (CAN-039…CAN-043)", () => {
  it("names new nodes S<n>, B<n>, Src<n>, Sink<n> from per-kind counters, re-primed on load", async () => {
    const e = activeEditor();
    const names: string[] = [];
    for (const k of ["station", "station", "buffer", "source", "sink"] as const) await event(() => names.push(e.addNode(k, { x: 0, y: 0 }).name));
    expect(names).toEqual(["S1", "S2", "B1", "Src1", "Sink1"]);
    e.loadNetwork({ nodes: [{ ...e.nodes[0], id: "X", name: "S9" }], links: [], infiniteBuffers: false, canvasScale: 1, canvasPanOffset: [0, 0] });
    await event(() => names.push(e.addNode("station", { x: 0, y: 0 }).name));
    expect(names.at(-1)).toBe("S10");
  });

  it("gives placed nodes their defaults, selects them, and makes one 'Add <Kind>' step with 0.90.34's sentence", async () => {
    const e = activeEditor();
    let s!: ReturnType<Editor["addNode"]>;
    await event(() => (s = e.addNode("station", { x: 0, y: 0 })));
    expect([s.distribution, s.distributionParameters]).toEqual(["exponential", "rate=1.1111111"]);
    expect(last()).toBe("Added station S1 — μ = 1.1111111, so ρ = 0.900 against the default source rate.");
    expect(e.undoManager.undoActionName).toBe("Add Station");
    expect(e.view.selectedNodeID).toBe(s.id);
    let src!: ReturnType<Editor["addNode"]>;
    await event(() => (src = e.addNode("source", { x: 0, y: 0 })));
    expect([src.distribution, src.distributionParameters]).toEqual(["poisson", "lambda=1.0"]);
    expect(last()).toBe("Added source Src1 — Poisson arrivals at λ = 1.000.");
    let b!: ReturnType<Editor["addNode"]>;
    await event(() => (b = e.addNode("buffer", { x: 0, y: 0 })));
    expect(b.bufferSize).toBe(1);
    expect(last()).toBe("Added buffer B1.");
    expect(e.undoManager.undoActionName).toBe("Add Buffer");
  });

  it("changes a station's picture as one 'Change Station Picture' step, and ignores other kinds", async () => {
    const { stationPicture, suggestedPicture, STATION_PICTURES } = await import("../editor/pictures");
    const e = activeEditor();
    let s = "", b = "";
    await event(() => (s = e.addNode("station", { x: 0, y: 0 }).id));
    await event(() => (b = e.addNode("buffer", { x: 0, y: 0 }).id));
    await event(() => e.updateStationPicture(s, "cpu.fill", stationPicture("cpu.fill").displayName));
    expect(e.node(s)!.picture).toBe("cpu.fill");
    expect(last()).toBe('Set S1 picture to "Automated / Robot".');
    expect(e.undoManager.undoActionName).toBe("Change Station Picture");
    await event(() => e.updateStationPicture(s, "", "No Picture"));
    expect(last()).toBe("Cleared picture on S1.");
    await event(() => e.updateStationPicture(b, "cpu.fill", "Automated / Robot"));
    expect(e.node(b)!.picture).toBe("");
    // The table (CAN-036) and the suggestion by servers (CAN-040).
    expect(STATION_PICTURES.map((p) => `${p.displayName}=${p.sf}`)).toEqual([
      "No Picture=", "Operator=person.fill", "Two Operators=person.2.fill", "Team=person.3.fill", "Machine=gearshape.2.fill", "Workbench=hammer.fill",
      "Repair / Maintenance=wrench.and.screwdriver.fill", "Printer / 3D Print=printer.fill", "Automated / Robot=cpu.fill", "Healthcare=stethoscope", "Cashier=cart.fill",
      "Teller / ATM=creditcard.fill", "Call Center=phone.fill", "Package Box=shippingbox.fill", "Inspection=magnifyingglass", "Server Rack=server.rack", "Gear=gear",
    ]);
    expect([1, 2, 3, 7].map((n) => suggestedPicture(n).displayName)).toEqual(["Operator", "Two Operators", "Team", "Team"]);
  });
});
