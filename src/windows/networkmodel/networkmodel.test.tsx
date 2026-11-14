// Network ▸ Network Model… (ledger ANA-226…236, SET-202): the outline's rows and selection, the
// capacity page's buffer model (undoable) and blocking rule (the sim.blocking setting).
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockTauri } from "../../test/tauri";
import { getSetting, loadKv } from "../../lib/kv";
import { editorFor } from "../../editor";
import { addTab, removeTabs, tabById } from "../../workspace/store";
import { classDescription, NETWORK_MODEL_FRAME_KEY, NetworkModelView, networkModelState, nodeDescription, openNetworkModel, resetNetworkModel } from "./NetworkModel";
import type { BnetNode } from "../../lib/bnet";

/** An example as Rust's reader hands it over: 0.90.34's own re-save of it. */
const resaved = import.meta.glob("../../../golden/*/resave.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const doc = (stem: string) => JSON.parse(resaved[`../../../golden/${stem}/resave.bnet`]);
const open = (stem: string) => addTab({ title: `${stem}.bnet`, document: doc(stem) });

afterEach(() => resetNetworkModel());

const node = (patch: Partial<BnetNode>): BnetNode => ({ id: "N", kind: "station", name: "S1", position: [0, 0], bufferSize: 5, distribution: "exponential", distributionParameters: "rate=1", numberOfServers: 1, serviceDistributions: {}, picture: "", ...patch });

describe("the outline's words", () => {
  it("describes each kind of node as 0.90.34 did (ANA-232)", () => {
    expect(nodeDescription(node({}), true)).toBe("1 server · 1 service class");
    expect(nodeDescription(node({ numberOfServers: 3, serviceDistributions: { "0": { distribution: "exponential", distributionParameters: "rate=1" }, "1": { distribution: "gamma", distributionParameters: "shape=2,rate=2" } } }), true)).toBe("3 servers · 2 service classes");
    expect(nodeDescription(node({ kind: "buffer", bufferSize: 7 }), false)).toBe("Finite waiting capacity 7");
    expect(nodeDescription(node({ kind: "buffer", bufferSize: 7 }), true)).toBe("Unbounded in the active network model; saved finite capacity 7");
    expect(nodeDescription(node({ kind: "source", distribution: "poisson", distributionParameters: "lambda=1.0" }), true)).toBe("Poisson process (Exp. inter-arrivals) · lambda=1.0");
    expect(nodeDescription(node({ kind: "source", distribution: "constant", distributionParameters: "value=2" }), true)).toBe("Deterministic · value=2");
    expect(nodeDescription(node({ kind: "sink" }), true)).toBe("Customers leave the network");
  });

  it("labels a route's class, or its class transition (ANA-233)", () => {
    expect(classDescription({ id: "L", fromNodeID: "a", toNodeID: "b", routingProbability: 1, customerClass: 0 })).toBe("Class 1");
    expect(classDescription({ id: "L", fromNodeID: "a", toNodeID: "b", routingProbability: 1, customerClass: 0, toCustomerClass: 0 })).toBe("Class 1");
    expect(classDescription({ id: "L", fromNodeID: "a", toNodeID: "b", routingProbability: 1, customerClass: 1, toCustomerClass: 2 })).toBe("Class 2 → Class 3");
  });
});

describe("the window", () => {
  it("opens for the active tab and is re-pointed when asked again; its frame key is 0.90.34's (ANA-227, SET-202)", () => {
    mockTauri(defaultHandlers());
    const a = open("2dtandem");
    openNetworkModel();
    expect(networkModelState()?.tabId).toBe(a);
    const b = open("MM1K.d1.c1.fin");
    openNetworkModel();
    expect(networkModelState()?.tabId).toBe(b);
    expect(NETWORK_MODEL_FRAME_KEY).toBe("WindowFrame.QnetNetworkModelWindow");
  });

  it("starts on the outline: nodes in document order, routes with p, and a click selects on the canvas (ANA-229, ANA-231, ANA-233)", () => {
    mockTauri(defaultHandlers());
    const id = open("2dtandem");
    render(<NetworkModelView tabId={id} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Network Model" })).toBeInTheDocument();
    expect(screen.getByText("Structure and queue-capacity semantics")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Network Outline" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Nodes in document order")).toBeInTheDocument();
    const nodes = within(screen.getByRole("region", { name: "Network nodes" })).getAllByRole("button");
    expect(nodes.map((b) => b.querySelector("strong")!.textContent)).toEqual(tabById(id)!.document.nodes.map((n) => n.name));
    fireEvent.click(nodes[2]);
    const e = editorFor(id);
    expect(e.view.selectedNodeID).toBe(tabById(id)!.document.nodes[2].id);
    expect(within(nodes[2]).getByLabelText("Selected")).toBeInTheDocument();
    const routes = screen.getByRole("region", { name: "Customer routes" });
    expect(within(routes).getByText(String(tabById(id)!.document.links.length))).toBeInTheDocument();
    expect(within(routes).getByText("Src1 → B1")).toBeInTheDocument();
    expect(within(routes).getAllByText(/Class 1\s+p = 1/).length).toBeGreaterThan(0);
    fireEvent.click(within(routes).getAllByRole("button")[0]);
    expect(e.view.selectedLinkID).toBe(tabById(id)!.document.links[0].id);
    expect(e.view.selectedNodeID).toBeNull();
    expect(screen.getByText("Changes to the network-wide buffer model are undoable on the canvas.")).toBeInTheDocument();
  });

  it("says when there is no network, no route, or no tab (ANA-228, ANA-230, ANA-233)", () => {
    mockTauri(defaultHandlers());
    const id = addTab({ title: "Untitled" });
    render(<NetworkModelView tabId={id} onClose={() => {}} />);
    expect(screen.getByText("No Network Yet")).toBeInTheDocument();
    expect(screen.getByText("Add sources, stations, buffers and sinks to build a structural outline.")).toBeInTheDocument();
    act(() => editorFor(id).addNode("station", { x: 100, y: 100 }));
    expect(screen.getByText("No Routes Yet")).toBeInTheDocument();
    act(() => removeTabs([id]));
    expect(screen.getByText("No Active Network")).toBeInTheDocument();
    expect(screen.getByText("Open or create a network to see how Qnet models it.")).toBeInTheDocument();
  });

  it("sets the network-wide buffer model as an undoable edit and the blocking rule as the setting (ANA-234…236)", async () => {
    mockTauri(defaultHandlers());
    await loadKv();
    const id = open("2dtandem");
    render(<NetworkModelView tabId={id} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Capacity & Blocking" }));
    expect(screen.getByText("Network-Wide Capacity")).toBeInTheDocument();
    expect(screen.getByLabelText("Finite buffers — capacities apply")).toBeChecked();
    expect(screen.getByText("Each buffer's saved capacity applies. A run must also specify what happens when a destination is full.")).toBeInTheDocument();
    const picker = screen.getByRole("radiogroup", { name: "Monte Carlo default" });
    expect(screen.getAllByText("BAS + external loss").length).toBeGreaterThan(1);
    await act(async () => fireEvent.click(within(picker).getByRole("radio", { name: "Loss" })));
    expect(getSetting("sim.blocking", 2)).toBe(0);
    expect(within(picker).getByRole("radio", { name: "Loss" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("table", { name: "Comparison of finite-buffer blocking rules" })).toBeInTheDocument();
    expect(screen.getByText("Rule")).toBeInTheDocument();
    expect(screen.getByText("The completed customer blocks its server until space opens; external arrivals wait outside.")).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByLabelText("Infinite buffers — capacities are ignored")));
    expect(tabById(id)!.document.infiniteBuffers).toBe(true);
    expect(screen.getByText("Every queue may grow without a capacity rejection or blocking event. Stability is required for a steady state.")).toBeInTheDocument();
    expect(within(picker).getByRole("radio", { name: "BAS" })).toBeDisabled();
    act(() => editorFor(id).undo());
    expect(tabById(id)!.document.infiniteBuffers).toBe(false);
  });
});
