// The docked Inspector pane against real examples and the mock backend (ledger 4.1–4.7, 4.9,
// 4.12, 4.17–4.19, MENU-151, INV-022): type, blur, and read the document, the Status log and the
// editor's undo names.
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockInspector } from "../../dev/mock/inspector";
import { editorClock } from "../../editor";
import { loadKv } from "../../lib/kv";
import { mockTauri } from "../../test/tauri";
import { handlersFor } from "../../workspace/focus";
import { InspectorPane } from ".";
import { linkBetween, nodeNamed, openExample, statusLines } from "./testing";

let now = 1_000_000;
beforeEach(async () => {
  mockTauri(defaultHandlers());
  await loadKv();
  now = 1_000_000;
  editorClock.now = () => now;
});

function show(stem: string) {
  const e = openExample(stem);
  render(<InspectorPane />);
  return e;
}

const select = (e: ReturnType<typeof openExample>, name: string) => act(() => e.setView({ selectedNodeID: nodeNamed(e, name).id, selectedLinkID: null, selectedNodeIDs: new Set() }));
const field = (label: string) => screen.getByRole("textbox", { name: label }) as HTMLInputElement;
async function type(label: string, text: string) {
  const f = field(label);
  act(() => f.focus());
  fireEvent.change(f, { target: { value: text } });
}
async function blur(label: string) {
  const f = field(label);
  act(() => f.blur());
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the docked Inspector (INS-001…018)", () => {
  it("shows No Selection with 0.90.34's message until a node or link is targeted", () => {
    show("2dtandem");
    expect(screen.getByText("No Selection")).toBeInTheDocument();
    expect(screen.getByText(/Select a node or a link on the canvas to edit its parameters here\. Changes apply as you leave each field and are undoable; Escape reverts a field you have not left yet\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit in Sheet" })).toBeDisabled();
  });

  it("follows the selection, a one-node group, and not a group of two", () => {
    const e = show("2dtandem");
    select(e, "S1");
    expect(field("Name").value).toBe("S1");
    expect(screen.getByText("S1 · Station")).toBeInTheDocument();
    act(() => e.setView({ selectedNodeID: null, selectedNodeIDs: new Set([nodeNamed(e, "S2").id]) }));
    expect(field("Name").value).toBe("S2");
    act(() => e.setView({ selectedNodeIDs: new Set([nodeNamed(e, "S1").id, nodeNamed(e, "S2").id]) }));
    expect(screen.getByText("No Selection")).toBeInTheDocument();
  });

  it("commits a field on blur as one undo step, and folds a run of commits to it into that step", async () => {
    const e = show("2dtandem");
    select(e, "S1");
    await type("Number of servers", "2");
    expect(e.node(nodeNamed(e, "S1").id)!.numberOfServers).toBe(1);
    await blur("Number of servers");
    expect(nodeNamed(e, "S1").numberOfServers).toBe(2);
    // 0.90.34 also stores a law for every served class not stored yet (S1's Class 1 here).
    expect(statusLines()).toContain("Edited S1: servers 1 → 2; Class 1 → Deterministic(v=1).");
    expect(e.undoManager.undoActionName).toBe("Edit S1 Parameters");
    now += 1000;
    await type("Number of servers", "3");
    await blur("Number of servers");
    expect(nodeNamed(e, "S1").numberOfServers).toBe(3);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => e.undo());
    expect(nodeNamed(e, "S1").numberOfServers).toBe(1);
    // INS-160: undo keeps the selection, so the pane shows the restored value in the same field.
    expect(field("Number of servers").value).toBe("1");
  });

  it("renames through renameNode and refuses an empty or taken name", async () => {
    const e = show("2dtandem");
    select(e, "S1");
    await type("Name", "Mill");
    await blur("Name");
    expect(nodeNamed(e, "Mill")).toBeTruthy();
    expect(statusLines()).toContain("Edited S1: renamed to Mill; Class 1 → Deterministic(v=1).");
    await type("Name", "S2");
    await blur("Name");
    expect(screen.getByText("Another node is already named S2.")).toBeInTheDocument();
    await type("Name", "");
    // INS-021: focused and emptied is not a mistake yet.
    expect(screen.queryByText("Name cannot be empty.")).toBeNull();
    await blur("Name");
    expect(screen.getByText("Name cannot be empty.")).toBeInTheDocument();
  });

  it("never writes an invalid draft, and logs its discard when the selection moves", async () => {
    const e = show("2dtandem");
    select(e, "S1");
    await type("Number of servers", "abc");
    await blur("Number of servers");
    expect(nodeNamed(e, "S1").numberOfServers).toBe(1);
    expect(screen.getByText("Enter a whole number of servers.")).toBeInTheDocument();
    select(e, "S2");
    expect(statusLines()).toContain('Discarded invalid edit to S1: Servers ("abc").');
  });

  it("blocks Servers beyond 10,000, as its caption says (INS-030, Changed)", async () => {
    const e = show("2dtandem");
    select(e, "S1");
    await type("Number of servers", "20000");
    await blur("Number of servers");
    expect(nodeNamed(e, "S1").numberOfServers).toBe(1);
    expect(screen.getByText("Servers must be between 1 and 10,000.")).toBeInTheDocument();
  });

  it("reverts the whole draft on Escape", async () => {
    const e = show("2dtandem");
    select(e, "S1");
    await type("Number of servers", "abc");
    fireEvent.keyDown(field("Number of servers"), { key: "Escape" });
    expect(field("Number of servers").value).toBe("1");
    expect(nodeNamed(e, "S1").numberOfServers).toBe(1);
  });

  it("shows a half-typed number calmly while its field has focus (INS-081, INS-135)", async () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "Src1");
    await type("Rate (λ)", "1e-");
    expect(field("Rate (λ)")).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Enter a number for Rate (λ).")).toBeNull();
    await blur("Rate (λ)");
    expect(screen.getByText("Enter a number for Rate (λ).")).toBeInTheDocument();
    expect(nodeNamed(e, "Src1").distributionParameters).toBe("lambda=0.9");
  });

  it("writes a source's law with the Status summary and the pane's coalescing key", async () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "Src1");
    await type("Rate (λ)", "0,5");
    await blur("Rate (λ)");
    expect(nodeNamed(e, "Src1").distributionParameters).toBe("lambda=0.5");
    expect(statusLines()).toContain("Edited Src1: arrivals → Poisson process (Exp. inter-arrivals)(λ=0.5).");
    expect(screen.getByText("Arrivals from this source form Class 1.")).toBeInTheDocument();
  });

  it("commits a picker 400 ms after the draft settles", async () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "Src1");
    fireEvent.change(screen.getByRole("combobox", { name: "Distribution" }), { target: { value: "exponential" } });
    await waitFor(() => expect(nodeNamed(e, "Src1").distribution).toBe("exponential"), { timeout: 1500 });
    // Keeps the mean: λ 0.9 → rate 0.9.
    expect(nodeNamed(e, "Src1").distributionParameters).toBe("rate=0.9");
  });

  it("edits a station's served class through the class picker (INS-066, INS-067)", async () => {
    const e = show("KumarSeidman90.d2.c4.reentrant.inf");
    select(e, "S1");
    const picker = screen.getByRole("combobox", { name: "Class" });
    expect([...(picker as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Class 1", "Class 4"]);
    // Changed from 0.90.34 (INS-053, ledger FIX-103): S2 → B1 carries Class 2 in and delivers
    // Class 4, so Class 2 never reaches S1. 0.90.34 listed it, and stored a law for it on save.
    expect(e.classesServedAtStation(nodeNamed(e, "S1").id)).toEqual([0, 3]);
    expect(e.classesServedAtStation(nodeNamed(e, "S2").id)).toEqual([1, 2]);
    fireEvent.change(picker, { target: { value: "3" } });
    expect(screen.getByText("Class 4 — Exponential")).toBeInTheDocument();
    await type("Class 4 Rate (λ)", "2");
    await blur("Class 4 Rate (λ)");
    expect(nodeNamed(e, "S1").serviceDistributions["3"]).toEqual({ distribution: "exponential", distributionParameters: "rate=2" });
    expect(statusLines().at(-1)).toBe("Edited S1: Class 4 → Exponential(λ=2).");
    // The pane stays on Class 4 after the commit reloads the draft (INS-013).
    expect((screen.getByRole("combobox", { name: "Class" }) as HTMLSelectElement).value).toBe("3");
    expect(nodeNamed(e, "S1").serviceDistributions["1"]).toBeUndefined();
    expect(screen.getByText("2 classes served here. Mean, SCV and μ = 1/mean update as you type.")).toBeInTheDocument();
  });

  it("reads λ, c·μ and ρ from the draft, tinted and warned at heavy and unstable load (INS-031…035, INV-022)", async () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "S1");
    const load = await screen.findByTestId("load-readout");
    await waitFor(() => expect(load).toHaveAccessibleName("Load: arrival rate 0.9 per time, capacity 1 per time, utilisation 0.9"));
    expect(screen.getByText("ρ = λ / (c·μ) from the traffic equations, recomputed as you edit. The station is stable while ρ < 1.")).toBeInTheDocument();
    await type("Class 1 Rate (λ)", "0.9");
    await waitFor(() => expect(screen.getByText("ρ = 1 at this rate: S1 is unstable, the queue grows without bound.")).toBeInTheDocument(), { timeout: 1500 });
    // Typed but not committed: the readout follows the draft.
    expect(nodeNamed(e, "S1").distributionParameters).toBe("rate=1.0");
    await type("Class 1 Rate (λ)", "0.92");
    await waitFor(() => expect(screen.getByText("ρ = 0.97826: heavy traffic, expect long queues and slow convergence.")).toBeInTheDocument(), { timeout: 1500 });
    const calls = mockInspector.calls;
    await type("Class 1 Rate (λ)", "0.921");
    await type("Class 1 Rate (λ)", "0.9213");
    await waitFor(() => expect(mockInspector.calls).toBe(calls + 1), { timeout: 1500 });
  });

  it("shows no readout without a source", () => {
    const e = show("2dtandem");
    act(() => {
      e.deleteNode(nodeNamed(e, "Src1").id);
    });
    select(e, "S1");
    expect(screen.getByText("Utilisation ρ = λ / (c·μ) appears once a source routes jobs to this station.")).toBeInTheDocument();
  });

  it("lists a node's links and opens an outgoing one in the pane (INS-071…078, INS-016)", async () => {
    const e = show("2dtandem");
    select(e, "S1");
    const routing = screen.getByRole("region", { name: "Routing" });
    expect(within(routing).getByText("Outgoing")).toBeInTheDocument();
    expect(within(routing).getByText("Incoming")).toBeInTheDocument();
    fireEvent.click(within(routing).getByRole("button", { name: "Class 1 to B2, probability 1" }));
    expect(e.view.selectedLinkID).toBe(linkBetween(e, "S1", "B2").id);
    expect(field("Routing probability").value).toBe("1");
  });

  it("edits a link: probability, the total's warning and Balance to 1 (INS-109…115, INS-122)", async () => {
    const e = show("2dtandem");
    act(() => e.setView({ selectedLinkID: linkBetween(e, "S1", "B2").id, selectedNodeID: null }));
    expect(screen.getByText("S1 → B2 · Class 1")).toBeInTheDocument();
    await type("Routing probability", "0.5");
    await blur("Routing probability");
    expect(linkBetween(e, "S1", "B2").routingProbability).toBe(0.5);
    expect(statusLines()).toContain("Edited link S1 → B2: probability 1 → 0.5.");
    expect(e.undoManager.undoActionName).toBe("Edit Link S1 → B2");
    expect(screen.getByText("Routing from S1 for Class 1 sums to 0.5; 50% of jobs have no route (this is the only outgoing link).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Balance to 1" }));
    expect(field("Routing probability").value).toBe("1");
    await waitFor(() => expect(linkBetween(e, "S1", "B2").routingProbability).toBe(1), { timeout: 1500 });
    expect(screen.getByRole("button", { name: "Balance to 1" })).toBeDisabled();
  });

  it("refuses a probability outside [0, 1]", async () => {
    const e = show("2dtandem");
    act(() => e.setView({ selectedLinkID: linkBetween(e, "S1", "B2").id, selectedNodeID: null }));
    await type("Routing probability", "2");
    await blur("Routing probability");
    expect(screen.getByText("Probability must be between 0 and 1.")).toBeInTheDocument();
    expect(linkBetween(e, "S1", "B2").routingProbability).toBe(1);
  });

  it("reloads a clean link draft after an outside change (Changed: 0.90.34 wrote the stale draft back)", async () => {
    const e = show("2dtandem");
    const id = linkBetween(e, "S1", "B2").id;
    act(() => e.setView({ selectedLinkID: id, selectedNodeID: null }));
    act(() => e.updateLinkProbability(id, 0.25));
    expect(field("Routing probability").value).toBe("0.25");
    select(e, "S1");
    expect(linkBetween(e, "S1", "B2").routingProbability).toBe(0.25);
  });

  it("puts the caret in the Name field for Window ▸ Focus Inspector (MENU-151, INS-002)", () => {
    const e = show("2dtandem");
    select(e, "S2");
    act(() => handlersFor("inspector")!.focus!());
    expect(document.activeElement).toBe(field("Name"));
    act(() => e.setView({ selectedLinkID: linkBetween(e, "S1", "B2").id, selectedNodeID: null }));
    act(() => handlersFor("inspector")!.focus!());
    expect(document.activeElement).toBe(field("Routing probability"));
  });

  it("shows a buffer's network-wide mode and disables its size while infinite (INS-037…041)", async () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "B1");
    expect(screen.queryByRole("region", { name: "Routing" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Infinite" }));
    expect(field("Buffer size")).toBeDisabled();
    await waitFor(() => expect(e.infiniteBuffers).toBe(true), { timeout: 1500 });
    expect(statusLines()).toContain("Edited B1: network buffers → infinite.");
  });

  it("shows a sink's behaviour text", () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "Sink1");
    expect(screen.getByText("Jobs leave the network here. Sinks have no parameters.")).toBeInTheDocument();
  });

  it("offers the picture suggested by the server count (INS-023, INS-024)", async () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "S1");
    fireEvent.click(screen.getByRole("button", { name: "Use Operator" }));
    await waitFor(() => expect(nodeNamed(e, "S1").picture).toBe("person.fill"), { timeout: 1500 });
    expect(statusLines()).toContain("Edited S1: picture → Operator; Class 1 → Exponential(λ=1).");
    await type("Number of servers", "3");
    expect(screen.getByRole("button", { name: "Use Team" })).toBeInTheDocument();
  });

  it("commits a pending valid draft when the pane goes away (INS-015)", async () => {
    const e = openExample("2dtandem");
    const r = render(<InspectorPane />);
    select(e, "S2");
    await type("Number of servers", "5");
    r.unmount();
    expect(nodeNamed(e, "S2").numberOfServers).toBe(5);
  });

  it("enters a source's law as Mean & SCV, with the fixed-SCV row and the card (INS-047…052)", async () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "Src1");
    fireEvent.click(screen.getByRole("radio", { name: "Mean & SCV" }));
    expect(field("Mean inter-arrival time").value).toBe("1.11111");
    expect(screen.getByText("1  (fixed by family)", { normalizer: (t) => t })).toBeInTheDocument();
    expect(screen.getByText("native: λ=0.9")).toBeInTheDocument();
    expect(screen.getByText("N(t) ~ Poisson(λt);  inter-arrivals ~ Exp(λ)", { normalizer: (t) => t })).toBeInTheDocument();
    await type("Mean inter-arrival time", "2");
    await blur("Mean inter-arrival time");
    expect(nodeNamed(e, "Src1").distributionParameters).toBe("lambda=0.5");
    // INS-088: re-seeded from what was written, still in Mean & SCV.
    expect(field("Mean inter-arrival time").value).toBe("2");
  });

  it("steps a text field from its typed value, clamped and written as %.10g (INS-140)", async () => {
    const e = show("2dtandem");
    act(() => e.setView({ selectedLinkID: linkBetween(e, "S1", "B2").id, selectedNodeID: null }));
    const stepper = screen.getByRole("group", { name: "Routing probability stepper" });
    fireEvent.click(within(stepper).getByRole("button", { name: "Decrement" }));
    expect(field("Routing probability").value).toBe("0.95");
    fireEvent.click(within(stepper).getByRole("button", { name: "Increment" }));
    fireEvent.click(within(stepper).getByRole("button", { name: "Increment" }));
    expect(field("Routing probability").value).toBe("1");
  });

  it("explains a jargon label in a glossary popover (INS-134, INS-169…172)", () => {
    const e = show("MM1K.d1.c1.fin");
    select(e, "S1");
    fireEvent.click(screen.getByRole("button", { name: "What is Load?" }));
    expect(screen.getByRole("dialog", { name: "Load" })).toHaveTextContent("ρ — utilisation: fraction of time the station is busy (λ / (c·μ)). Must be below 1 for stability.");
  });

  it("edits a station no class reaches through its default service law (INS-044)", async () => {
    const e = show("2dtandem");
    let id = "";
    act(() => {
      id = e.addNode("station", { x: 900, y: 500 }).id;
    });
    expect(e.view.selectedNodeID).toBe(id);
    expect(screen.getByText("No customer class reaches this station yet; this default law is used until links connect a class.")).toBeInTheDocument();
    await type("Rate (λ)", "2");
    await blur("Rate (λ)");
    expect(e.node(id)!.distributionParameters).toBe("rate=2");
    expect(statusLines().at(-1)).toBe("Edited S3: service → Exponential(λ=2).");
  });
});


describe("class colours (MODEL-010)", () => {
  it("reads the canvas's eight class tokens, then walks the golden angle", async () => {
    const { classColor } = await import("./fields");
    expect(classColor(0)).toBe("var(--canvas-class-1)");
    expect(classColor(7)).toBe("var(--canvas-class-8)");
    // Class 8: hue 0, saturation 0.72, brightness 0.82.
    expect(classColor(8)).toBe("#d13b3b");
    expect(classColor(9)).not.toBe(classColor(8));
  });
});
