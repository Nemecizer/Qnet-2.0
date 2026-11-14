// The nine tools against a tab's editor: 0.90.34's names, schemas, validation and result
// sentences (AITools.swift; ledger AI-042…063, LOG-030, METH-008).
import { EXPLAIN_SPECS } from "./explain/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockRuns } from "../../dev/mock/runs";
import { editorFor } from "../../editor";
import { emptyDocument } from "../../lib/bnet";
import { loadKv } from "../../lib/kv";
import { holdModal } from "../../lib/overlays";
import { getRunState } from "../../runs/state";
import { closePanel } from "../../runs/ui/panels";
import { mockTauri } from "../../test/tauri";
import { activeTab, addStatus, addTab, selectTab, tabById } from "../../workspace/store";
import { formattedLine } from "../status/entries";
import { AI_COMMANDS, DIST_NAMES, executeTool, inputSummary, inputText, prettyJSON, RUN_WAIT, swiftDouble, ToolCancelled, toolSpecs, type ToolContext } from "./tools";

let tabId: string;
let ctx: ToolContext;
const run = (name: string, input: Record<string, unknown> = {}) => executeTool(name, input, ctx);
const fails = async (name: string, input: Record<string, unknown>) => {
  try {
    await run(name, input);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("the tool did not refuse");
};
const editor = () => editorFor(tabId);
const names = () => editor().nodes.map((n) => n.name);

beforeEach(async () => {
  mockTauri(defaultHandlers());
  await loadKv();
  tabId = addTab({ title: "5stationtandem.inf.bnet", document: { ...emptyDocument(), infiniteBuffers: true } });
  ctx = { tabId, editor: editorFor(tabId), cancelled: () => false };
  RUN_WAIT.intervalMs = 2;
  RUN_WAIT.quietMs = 30;
  mockRuns.replayMs = 5;
});
afterEach(() => {
  RUN_WAIT.intervalMs = 250;
  RUN_WAIT.quietMs = 2000;
  mockRuns.replayMs = 120;
});

describe("the catalog", () => {
  it("offers 0.90.34's nine tools unchanged, with 2.1's explaining tools beside them, sorted by name (AI-035, WF-401)", () => {
    const explaining = new Set(EXPLAIN_SPECS.map((t) => t.name));
    expect(toolSpecs().map((t) => t.name)).toEqual([...toolSpecs().map((t) => t.name)].sort());
    expect(toolSpecs().filter((t) => !explaining.has(t.name)).map((t) => t.name)).toEqual(["add_link", "add_node", "delete_link", "delete_node", "get_network_summary", "read_status", "run_command", "update_link", "update_node"]);
  });

  it("describes them in 0.90.34's words, continuation spaces and all", () => {
    const spec = (n: string) => toolSpecs().find((t) => t.name === n)!;
    expect(spec("delete_node").description).toBe(
      "Delete a node from the active canvas, identified by its current `name`. Any links touching the node (incoming OR outgoing, any class) are removed in the same operation — the result string reports how many. Irreversible from the AI side; the user can ⌘Z to undo.",
    );
    expect(spec("update_node").description).toContain("  station: new_name, number_of_servers, distribution,            distribution_parameters\n  source : new_name, distribution, distribution_parameters\n");
    expect(spec("update_node").description).toContain(`\`distribution\` is one of: ${DIST_NAMES.join(", ")}.\n`);
    expect(spec("add_node").description).toContain("  sink   : (no parameters)\n\n`distribution` is one of: exponential, gamma, uniform, constant, weibull, erlang, lognormal, pareto, poisson.");
    expect(spec("run_command").description).toContain("Available commands:\n\n- RunComparison: Run Comparison\n- RunMonteCarlo: Run Monte Carlo\n");
    expect(spec("run_command").description).toContain("- AnalyzeNetwork: Analyze the active network\n\nCall get_network_summary first");
    expect(spec("get_network_summary").description.startsWith("Return a JSON snapshot of the currently-active BNET network: global flags")).toBe(true);
  });

  it("gives each tool 0.90.34's JSON schema (AI-046, AI-050, AI-053, AI-056, AI-058, AI-062)", () => {
    const schema = (n: string) => toolSpecs().find((t) => t.name === n)!.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(schema("get_network_summary")).toEqual({ type: "object", properties: {}, required: [] });
    expect(schema("add_node").required).toEqual(["kind"]);
    expect(schema("add_node").properties.kind.enum).toEqual(["station", "buffer", "source", "sink"]);
    expect(schema("add_node").properties.number_of_servers).toEqual({ type: "integer", minimum: 1, description: "Initial server count (station only)." });
    expect(schema("add_node").properties.distribution.enum).toEqual([...DIST_NAMES]);
    expect(Object.keys(schema("add_link").properties)).toEqual(["from_node_name", "to_node_name", "routing_probability", "customer_class", "to_customer_class"]);
    expect(schema("add_link").properties.routing_probability).toEqual({ type: "number", minimum: 0, maximum: 1, description: "Outgoing routing probability (default 1.0)." });
    expect(schema("delete_link").required).toEqual(["from_node_name", "to_node_name"]);
    expect(Object.keys(schema("update_node").properties)).toEqual(["name", "new_name", "number_of_servers", "buffer_size", "distribution", "distribution_parameters"]);
    expect(schema("update_link").properties.new_to_customer_class).toEqual({ type: ["integer", "null"], minimum: 0, description: "Set the link's exit customer-class index (null clears any class transition)." });
    expect(schema("run_command").properties.name.enum).toEqual(AI_COMMANDS.map(([n]) => n));
    expect(AI_COMMANDS).toHaveLength(12);
    expect(schema("run_command").properties.timeout_seconds).toEqual({ type: "number", description: "Max seconds to wait for the run to settle (default 60, max 600).", minimum: 1, maximum: 600 });
    expect(schema("read_status")).toEqual({ type: "object", properties: { tail: { type: "integer", description: "Number of most-recent lines to return (default 50, max 500).", minimum: 1, maximum: 500 } }, required: [] });
  });

  it("refuses a name that is not a tool (AI-034)", async () => {
    expect(await fails("read_network", {})).toBe("Unknown tool: read_network");
    expect(await fails("toString", {})).toBe("Unknown tool: toString");
  });
});

describe("Swift's and Foundation's text forms", () => {
  it("writes a Double as Swift's string interpolation does", () => {
    expect([1, 0.5, 0, 0.25, 1e-5, 12.75].map(swiftDouble)).toEqual(["1.0", "0.5", "0.0", "0.25", "1e-05", "12.75"]);
  });

  it("pretty-prints JSON as JSONSerialization does, keys sorted", () => {
    expect(prettyJSON({ b: [1, 0.5], a: "x/y", c: {}, d: [], e: null, f: true })).toBe('{\n  "a" : "x\\/y",\n  "b" : [\n    1,\n    0.5\n  ],\n  "c" : {\n\n  },\n  "d" : [\n\n  ],\n  "e" : null,\n  "f" : true\n}');
    expect(inputText({})).toBe("{}");
    expect(inputText({ name: "S1" })).toBe('{\n  "name" : "S1"\n}');
  });

  it("summarises a call's input as key=value, keys sorted, values cut at 40 characters (AI-075)", () => {
    expect(inputSummary({})).toBe("");
    expect(inputSummary({ to_node_name: "S1", from_node_name: "Src1", routing_probability: 0.5 })).toBe("from_node_name=Src1, routing_probability=0.5, to_node_name=S1");
    expect(inputSummary({ distribution_parameters: "x".repeat(45) })).toBe(`distribution_parameters=${"x".repeat(40)}…`);
  });
});

describe("add_node", () => {
  it("auto-names, places 120 pt right of the rightmost node, and says what it added (AI-047, AI-048)", async () => {
    expect(await run("add_node", { kind: "source" })).toBe('Added source "Src1".');
    expect(await run("add_node", { kind: "station" })).toBe('Added station "S1".');
    expect(await run("add_node", { kind: "buffer", name: "  Queue  ", buffer_size: 7 })).toBe('Added buffer "Queue" with buffer_size=7.');
    expect(editor().nodes.map((n) => n.position)).toEqual([[300, 200], [420, 200], [540, 200]]);
    expect(editor().nodes[2].bufferSize).toBe(7);
    expect(await run("add_node", { kind: "station", name: "Fast", number_of_servers: 3, distribution: "erlang", distribution_parameters: "k=2,rate=1.0" })).toBe(
      'Added station "Fast" with number_of_servers=3, distribution=erlang, distribution_parameters="k=2,rate=1.0".',
    );
    const fast = editor().nodes.find((n) => n.name === "Fast")!;
    expect([fast.numberOfServers, fast.distribution, fast.distributionParameters]).toEqual([3, "erlang", "k=2,rate=1.0"]);
  });

  it("keeps the born parameter string when only the family is given (AI-054's gap)", async () => {
    expect(await run("add_node", { kind: "station", distribution: "gamma" })).toBe('Added station "S1" with distribution=gamma.');
    expect(editor().nodes[0].distribution).toBe("gamma");
    expect(editor().nodes[0].distributionParameters).toMatch(/^rate=/);
  });

  it("is one undo step per call, undone with the editor's own Undo (AI-043)", async () => {
    await run("add_node", { kind: "station", number_of_servers: 2 });
    editor().undoManager.closeGroup();
    expect(editor().undoManager.undoActionName).toBe("Change Number of Servers");
    editor().undo();
    expect(names()).toEqual([]);
  });

  it("refuses with 0.90.34's sentences and changes nothing (AI-048)", async () => {
    await run("add_node", { kind: "station" });
    expect(await fails("add_node", { kind: "queue" })).toBe("Invalid tool input: `kind` must be one of: station, buffer, source, sink.");
    expect(await fails("add_node", {})).toBe("Invalid tool input: `kind` must be one of: station, buffer, source, sink.");
    expect(await fails("add_node", { kind: "station", name: "S1" })).toBe('Invalid tool input: A node named "S1" already exists.');
    expect(await fails("add_node", { kind: "buffer", number_of_servers: 2 })).toBe("Invalid tool input: `number_of_servers` only applies to station nodes.");
    expect(await fails("add_node", { kind: "station", buffer_size: 2 })).toBe("Invalid tool input: `buffer_size` only applies to buffer-kind nodes.");
    expect(await fails("add_node", { kind: "sink", distribution: "gamma" })).toBe("Invalid tool input: `distribution` / `distribution_parameters` only apply to station and source nodes.");
    expect(await fails("add_node", { kind: "station", distribution: "normal" })).toBe(`Invalid tool input: \`distribution\` must be one of: ${DIST_NAMES.join(", ")}.`);
    expect(names()).toEqual(["S1"]);
  });
});

describe("links", () => {
  beforeEach(async () => {
    for (const kind of ["source", "station", "station", "sink"]) await run("add_node", { kind });
  });

  it("add_link defaults to probability 1.0 and class 0 and reports the link (AI-050, AI-051)", async () => {
    expect(await run("add_link", { from_node_name: "Src1", to_node_name: "S1" })).toBe("Added link Src1 → S1 (class 0, routing_probability=1.0).");
    expect(await run("add_link", { from_node_name: "S1", to_node_name: "S2", routing_probability: 0.25, customer_class: 1, to_customer_class: 2 })).toBe(
      "Added link S1 → S2 (class 1, routing_probability=0.25, to_customer_class=2).",
    );
    expect(editor().links.map((l) => [l.routingProbability, l.customerClass, l.toCustomerClass ?? null])).toEqual([[1, 0, null], [0.25, 1, 2]]);
    expect(editor().undoManager.undoActionName).toBe("Add Link");
  });

  it("add_link refuses a sink source, a source destination, a bad probability, a negative class and a duplicate (AI-051)", async () => {
    await run("add_link", { from_node_name: "Src1", to_node_name: "S1" });
    expect(await fails("add_link", { to_node_name: "S1" })).toBe("Invalid tool input: `from_node_name` is required.");
    expect(await fails("add_link", { from_node_name: "S1" })).toBe("Invalid tool input: `to_node_name` is required.");
    expect(await fails("add_link", { from_node_name: "Sink1", to_node_name: "S1" })).toBe('Invalid tool input: "Sink1" is a sink and cannot be the source of a link.');
    expect(await fails("add_link", { from_node_name: "S1", to_node_name: "Src1" })).toBe('Invalid tool input: "Src1" is a source and cannot be the destination of a link.');
    expect(await fails("add_link", { from_node_name: "S1", to_node_name: "S2", routing_probability: 1.5 })).toBe("Invalid tool input: `routing_probability` must be between 0 and 1 (got 1.5).");
    expect(await fails("add_link", { from_node_name: "S1", to_node_name: "S2", customer_class: -1 })).toBe("Invalid tool input: `customer_class` must be ≥ 0.");
    expect(await fails("add_link", { from_node_name: "S1", to_node_name: "S2", to_customer_class: -2 })).toBe("Invalid tool input: `to_customer_class` must be ≥ 0.");
    expect(await fails("add_link", { from_node_name: "Src1", to_node_name: "S1" })).toBe('Invalid tool input: A link from "Src1" to "S1" with customer_class=0 already exists. Use update_link to edit it.');
    expect(await fails("add_link", { from_node_name: "S9", to_node_name: "S1" })).toBe('Invalid tool input: No node named "S9". Existing nodes: S1, S2, Sink1, Src1.');
    expect(editor().links).toHaveLength(1);
  });

  it("delete_link needs a class only between parallel links (AI-052)", async () => {
    await run("add_link", { from_node_name: "S1", to_node_name: "S2" });
    await run("add_link", { from_node_name: "S1", to_node_name: "S2", customer_class: 2 });
    expect(await fails("delete_link", { from_node_name: "S2", to_node_name: "S1" })).toBe('Invalid tool input: No link from "S2" to "S1".');
    expect(await fails("delete_link", { from_node_name: "S1", to_node_name: "S2" })).toBe('Invalid tool input: Multiple parallel links from "S1" to "S2" (customer_class values: 0, 2). Pass `customer_class` to disambiguate.');
    expect(await fails("delete_link", { from_node_name: "S1", to_node_name: "S2", customer_class: 1 })).toBe('Invalid tool input: No link from "S1" to "S2" with customer_class=1. Available classes on this pair: 0, 2.');
    expect(await run("delete_link", { from_node_name: "S1", to_node_name: "S2", customer_class: 2 })).toBe("Deleted link S1 → S2 (class 2).");
    expect(await run("delete_link", { from_node_name: "S1", to_node_name: "S2" })).toBe("Deleted link S1 → S2 (class 0).");
    expect(editor().links).toHaveLength(0);
  });

  it("update_link changes what differs, line by line, and clears the exit class on null (AI-056, AI-057)", async () => {
    await run("add_link", { from_node_name: "S1", to_node_name: "S2" });
    expect(await run("update_link", { from_node_name: "S1", to_node_name: "S2", new_routing_probability: 0.5, new_customer_class: 1, new_to_customer_class: 2 })).toBe(
      "Updated link S1 → S2 (class 0):\n  - routing_probability: 1.0 → 0.5\n  - customer_class: 0 → 1\n  - to_customer_class: null → 2",
    );
    expect(await run("update_link", { from_node_name: "S1", to_node_name: "S2", new_to_customer_class: null })).toBe("Updated link S1 → S2 (class 1):\n  - to_customer_class: 2 → null");
    expect(await run("update_link", { from_node_name: "S1", to_node_name: "S2", new_routing_probability: 0.5 })).toBe(
      "No changes — every requested value already matched the link's current state on S1 → S2 (class 1).",
    );
    expect(await fails("update_link", { from_node_name: "S1", to_node_name: "S2", new_routing_probability: -0.1 })).toBe("Invalid tool input: `new_routing_probability` must be between 0 and 1 (got -0.1).");
    const l = editor().links[0];
    expect([l.routingProbability, l.customerClass, l.toCustomerClass ?? null]).toEqual([0.5, 1, null]);
  });

  it("delete_node takes the node's links with it and counts them (AI-049)", async () => {
    await run("add_link", { from_node_name: "Src1", to_node_name: "S1" });
    await run("add_link", { from_node_name: "S1", to_node_name: "S2" });
    expect(await run("delete_node", { name: "S1" })).toBe('Deleted station "S1" and 2 connected link(s).');
    expect(await run("delete_node", { name: "Sink1" })).toBe('Deleted sink "Sink1".');
    expect(await fails("delete_node", { name: "S1" })).toBe('Invalid tool input: No node named "S1". Existing nodes: S2, Src1.');
    expect(await fails("delete_node", {})).toBe("Invalid tool input: `name` is required.");
    expect(editor().links).toHaveLength(0);
    editor().undo();
    editor().undo();
    expect(editor().links).toHaveLength(2);
  });
});

describe("update_node", () => {
  beforeEach(async () => {
    for (const kind of ["source", "station", "buffer", "sink"]) await run("add_node", { kind });
  });

  it("reports each change as old → new under the node's old name (AI-053, AI-054)", async () => {
    const before = editor().nodes.find((n) => n.name === "S1")!.distributionParameters;
    expect(await run("update_node", { name: "S1", new_name: "Mill", number_of_servers: 2, distribution: "gamma", distribution_parameters: "shape=2.0,scale=1.0" })).toBe(
      `Updated station "S1":\n  - name: "S1" → "Mill"\n  - number_of_servers: 1 → 2\n  - distribution: exponential → gamma\n  - distribution_parameters: "${before}" → "shape=2.0,scale=1.0"`,
    );
    const mill = editor().nodes.find((n) => n.name === "Mill")!;
    expect([mill.numberOfServers, mill.distribution, mill.distributionParameters]).toEqual([2, "gamma", "shape=2.0,scale=1.0"]);
    expect(await run("update_node", { name: "B1", buffer_size: 12 })).toMatch(/^Updated buffer "B1":\n  - buffer_size: \d+ → 12$/);
    expect(await run("update_node", { name: "Sink1", new_name: "Sink1" })).toBe("No changes — every requested value already matched the node's current state.");
  });

  it("changing only the family keeps the old parameter string (AI-054)", async () => {
    const before = editor().nodes.find((n) => n.name === "S1")!.distributionParameters;
    expect(await run("update_node", { name: "S1", distribution: "gamma" })).toBe('Updated station "S1":\n  - distribution: exponential → gamma');
    expect(editor().nodes.find((n) => n.name === "S1")!.distributionParameters).toBe(before);
  });

  it("validates everything against the node's kind before changing anything (AI-053)", async () => {
    expect(await fails("update_node", {})).toBe("Invalid tool input: `name` is required and must be non-empty.");
    expect(await fails("update_node", { name: "S1", new_name: "B1", number_of_servers: 4 })).toBe('Invalid tool input: Cannot rename to "B1": another node already has that name.');
    expect(await fails("update_node", { name: "B1", new_name: "Queue", number_of_servers: 2 })).toBe("Invalid tool input: `number_of_servers` only applies to station nodes (got kind=buffer).");
    expect(await fails("update_node", { name: "S1", buffer_size: 2 })).toBe("Invalid tool input: `buffer_size` only applies to buffer-kind nodes (got kind=station).");
    expect(await fails("update_node", { name: "Sink1", distribution_parameters: "rate=2" })).toBe("Invalid tool input: `distribution` / `distribution_parameters` only apply to station and source nodes (got kind=sink).");
    expect(await fails("update_node", { name: "Src1", distribution: "cauchy" })).toBe(`Invalid tool input: \`distribution\` must be one of: ${DIST_NAMES.join(", ")}.`);
    expect(names()).toEqual(["Src1", "S1", "B1", "Sink1"]);
    expect(editor().nodes[1].numberOfServers).toBe(1);
  });
});

describe("get_network_summary", () => {
  it("is key-sorted pretty JSON with the per-kind fields and the links by name (AI-044, AI-045)", async () => {
    expect(JSON.parse(await run("get_network_summary"))).toEqual({ customer_class_count: 1, has_been_analyzed: false, infinite_buffers: true, link_count: 0, links: [], node_count: 0, nodes: [], station_count: 0 });
    for (const kind of ["source", "buffer", "station", "sink"]) await run("add_node", { kind });
    await run("add_link", { from_node_name: "Src1", to_node_name: "B1" });
    await run("add_link", { from_node_name: "S1", to_node_name: "Sink1", routing_probability: 0.5, to_customer_class: 1 });
    const text = await run("get_network_summary");
    expect(text.startsWith('{\n  "customer_class_count" : 1,\n  "has_been_analyzed" : false,\n  "infinite_buffers" : true,\n  "link_count" : 2,\n  "links" : [\n    {\n      "customer_class" : 0,\n      "from" : "Src1",\n      "routing_probability" : 1,\n      "to" : "B1"\n    },')).toBe(true);
    const s = JSON.parse(text) as { nodes: Record<string, unknown>[]; links: Record<string, unknown>[]; station_count: number; node_count: number };
    expect([s.node_count, s.station_count]).toEqual([4, 1]);
    expect(s.nodes.map((n) => Object.keys(n).sort())).toEqual([
      ["distribution", "distribution_parameters", "kind", "name"],
      ["buffer_size", "kind", "name"],
      ["distribution", "distribution_parameters", "kind", "name", "number_of_servers"],
      ["kind", "name"],
    ]);
    expect(s.nodes[0]).toMatchObject({ name: "Src1", kind: "source", distribution: "poisson" });
    expect(s.links[1]).toEqual({ from: "S1", to: "Sink1", routing_probability: 0.5, customer_class: 0, to_customer_class: 1 });
  });
});

describe("read_status", () => {
  it("returns the last lines of the conversation's tab as the Status pane copies them (AI-062, LOG-030)", async () => {
    expect(await run("read_status")).toBe("(Status pane is empty.)");
    addStatus("first", "info", tabId);
    addStatus("second thing failed", "error", tabId);
    addStatus("third", "warning", tabId);
    const log = tabById(tabId)!.log;
    expect(await run("read_status")).toBe(log.map(formattedLine).join("\n"));
    expect(await run("read_status", { tail: 2 })).toBe(log.slice(1).map(formattedLine).join("\n"));
    expect((await run("read_status", { tail: 0 })).split("\n")).toHaveLength(1);
    expect(await run("read_status", { tail: 1 })).toMatch(/^\[.+\] \[WARNING\] third$/);
  });
});

describe("the tools that change the network", () => {
  it("wait while a dialog or parameter panel is open, as the Edit menu does (the P7 review)", async () => {
    const release = holdModal();
    try {
      for (const name of ["add_node", "delete_node", "add_link", "delete_link", "update_node", "update_link"]) {
        expect(await fails(name, { kind: "station" })).toBe("Tool execution failed: A dialog or parameter panel is open in Qnet. Ask the user to close it, then try again.");
      }
      expect(names()).toEqual([]);
      expect(await run("get_network_summary")).toContain("nodes");
    } finally {
      release();
    }
    await run("add_node", { kind: "station" });
    expect(names()).toHaveLength(1);
  });
});

describe("run_command", () => {
  it("runs the Run menu's method on the tab and returns the Status lines the run wrote (AI-059, AI-061, METH-008)", async () => {
    await run("add_node", { kind: "station" });
    const before = tabById(tabId)!.log.length;
    const result = await run("run_command", { name: "RunQNA" });
    expect(mockRuns.starts.map((r) => [r.method, r.tabId, r.title])).toEqual([["qna", tabId, "5stationtandem.inf.bnet"]]);
    const added = tabById(tabId)!.log.slice(before);
    expect(added.map((e) => e.text)).toContain("Running QNA...");
    expect(result).toBe(`(Run Whitt QNA (infinite buffers only) — settled with ${added.length} new line(s):)\n${added.map(formattedLine).join("\n")}`);
  });

  it("writes the buffer-mode guard instead of running a method of the other mode (AI-059)", async () => {
    const result = await run("run_command", { name: "RunFiniteElement" });
    expect(mockRuns.starts).toHaveLength(0);
    expect(result).toMatch(/^\(Run Finite Element \(finite buffers only\) — settled with 1 new line\(s\):\)\n\[.+\] AI: Finite Element is finite-buffer only\.$/);
    expect(await run("run_command", { name: "RunFiniteLP" })).toContain("AI: Finite LP is finite-buffer only.");
    editor().setInfiniteBuffers(false);
    for (const [name, line] of [["RunQNA", "AI: Whitt QNA is infinite-buffer only."], ["RunSBD", "AI: SBD is infinite-buffer only."], ["RunExactSimulation", "AI: SRBM MLMC is infinite-buffer only."], ["RunLinearProgram", "AI: Linear Program is infinite-buffer only."]]) {
      expect(await run("run_command", { name })).toContain(line);
    }
    expect(mockRuns.starts).toHaveLength(0);
  });

  it("times out with what it has, or with nothing captured (AI-061)", async () => {
    RUN_WAIT.quietMs = 5000;
    const started = Date.now();
    // The floor of the timeout is one second, whatever the model asks for.
    expect(await run("run_command", { name: "RunFiniteElement", timeout_seconds: 0.01 })).toMatch(/^\(Run Finite Element \(finite buffers only\) — timed out after 1s; partial output:\)\n\[.+\] AI: Finite Element/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
  });

  it("is not settled while the run it started is still going, however quiet (the P7 review)", async () => {
    await run("add_node", { kind: "station" });
    mockRuns.replayMs = 400;
    const started = Date.now();
    const result = await run("run_command", { name: "RunQNA" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect(getRunState().active).toBeNull();
    expect(getRunState().last?.summary).toContain("QNA finished");
    expect(result).toContain("— settled with");
  });

  it("says so when the method's parameter sheet is left open, and settles once it is closed (the P7 review)", async () => {
    let release = () => {};
    setTimeout(() => (release = holdModal()), 10);
    try {
      expect(await run("run_command", { name: "RunMonteCarlo", timeout_seconds: 1 })).toBe("(Run Monte Carlo — its parameter sheet is open and waiting for the user to press Run or Cancel; nothing has started after 1s:)\n(no status output captured)");
      expect(mockRuns.starts).toHaveLength(0);
      release();
      closePanel();
      setTimeout(() => {
        release = holdModal();
        setTimeout(release, 60);
      }, 10);
      const started = Date.now();
      expect(await run("run_command", { name: "RunMonteCarlo", timeout_seconds: 5 })).toBe("(Run Monte Carlo — settled with 0 new line(s):)\n(no status output captured)");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      release();
      closePanel();
    }
  });

  it("refuses an unknown command and a missing name (AI-058)", async () => {
    expect(await fails("run_command", {})).toBe("Invalid tool input: Missing 'name' argument.");
    expect(await fails("run_command", { name: "RunRQNA" })).toBe(`Invalid tool input: 'RunRQNA' is not a valid command. Valid: ${AI_COMMANDS.map(([n]) => n).join(", ")}`);
  });

  it("is refused, naming both tabs, while another tab is in front (AI-060)", async () => {
    const other = addTab({ title: "other.bnet" });
    selectTab(other);
    expect(activeTab().id).toBe(other);
    expect(await run("run_command", { name: "RunQNA" })).toBe(
      "Not run: this conversation belongs to the tab “5stationtandem.inf.bnet”, but “other.bnet” is in front and menu commands act on the front tab. " +
        "Ask the user to switch back to “5stationtandem.inf.bnet” and try again; read_network and the update tools still work on the right tab meanwhile.",
    );
    expect(mockRuns.starts).toHaveLength(0);
    // The other tools still act on the conversation's tab (AI-042).
    expect(await run("add_node", { kind: "sink" })).toBe('Added sink "Sink1".');
    expect(editorFor(other).nodes).toHaveLength(0);
  });

  it("gives up its wait when the request is stopped", async () => {
    RUN_WAIT.quietMs = 5000;
    let stop = false;
    ctx = { ...ctx, cancelled: () => stop };
    const pending = run("run_command", { name: "RunFiniteElement" });
    stop = true;
    await expect(pending).rejects.toBeInstanceOf(ToolCancelled);
  });
});
