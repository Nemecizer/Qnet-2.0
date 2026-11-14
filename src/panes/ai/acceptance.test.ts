// P7's acceptance (PLAN.md §7): "with a local provider, the assistant builds a two-station tandem
// and runs a method on it." The scripted provider (src/dev/mock/ai.ts) plays a local model that
// calls 0.90.34's tools; the run replays what 0.90.34 itself did for the golden example the tab is
// titled after (src/dev/mock/runs.ts).
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockAi } from "../../dev/mock/ai";
import { mockRuns } from "../../dev/mock/runs";
import { editorFor } from "../../editor";
import { emptyDocument } from "../../lib/bnet";
import { loadKv } from "../../lib/kv";
import { resultsFor } from "../../runs/state";
import { mockTauri } from "../../test/tauri";
import { addTab, tabById } from "../../workspace/store";
import { formattedLine } from "../status/entries";
import { conversationOf, resetAi, submit, whenIdle } from "./model";
import { call, textTurn, tick, toolTurn } from "./testing";
import { RUN_WAIT } from "./tools";
import { transcriptMarkdown } from "./transcript";

const TITLE = "GuangChenDaiGlynn25.sec3.1.2d.inf.bnet";

beforeEach(async () => {
  mockTauri(defaultHandlers({ settings: { "ai.provider": "ollama", "ai.model.ollama": "qwen2.5:14b" } }));
  await loadKv();
  RUN_WAIT.intervalMs = 5;
  RUN_WAIT.quietMs = 80;
  mockRuns.replayMs = 10;
});
afterEach(() => {
  resetAi();
  RUN_WAIT.intervalMs = 250;
  RUN_WAIT.quietMs = 2000;
  mockRuns.replayMs = 120;
});

it("with a local provider, the assistant builds a two-station tandem and runs a method on it", async () => {
  const tabId = addTab({ title: TITLE, document: { ...emptyDocument(), infiniteBuffers: true } });
  const editor = editorFor(tabId);
  mockAi.script(
    toolTurn("I'll look at the canvas first. ", call("get_network_summary", {}, "t1")),
    toolTurn(
      call("add_node", { kind: "source", distribution: "poisson", distribution_parameters: "rate=0.8" }, "t2"),
      call("add_node", { kind: "buffer" }, "t3"),
      call("add_node", { kind: "station", distribution: "exponential", distribution_parameters: "rate=1.0" }, "t4"),
      call("add_node", { kind: "buffer" }, "t5"),
      call("add_node", { kind: "station", number_of_servers: 1, distribution_parameters: "rate=1.25" }, "t6"),
      call("add_node", { kind: "sink" }, "t7"),
    ),
    toolTurn(
      call("add_link", { from_node_name: "Src1", to_node_name: "B1" }, "t8"),
      call("add_link", { from_node_name: "B1", to_node_name: "S1" }, "t9"),
      call("add_link", { from_node_name: "S1", to_node_name: "B2" }, "t10"),
      call("add_link", { from_node_name: "B2", to_node_name: "S2" }, "t11"),
      call("add_link", { from_node_name: "S2", to_node_name: "Sink1", routing_probability: 1 }, "t12"),
    ),
    toolTurn("Now QNA. ", call("run_command", { name: "RunQNA", timeout_seconds: 30 }, "t13")),
    textTurn("The tandem is built and **QNA** has run."),
  );

  expect(submit(tabId, "Build a two-station tandem and run QNA on it.")).toBe(true);
  await whenIdle();

  // The provider was the local one, asked five times, with 0.90.34's nine tools and 2.1's fifteen, and the whole history.
  expect(mockAi.requests).toHaveLength(5);
  expect(mockAi.requests.every((r) => r.provider === "ollama" && r.model === "qwen2.5:14b" && r.baseURL === "http://localhost:11434" && r.tools.length === 24)).toBe(true);
  expect(mockAi.requests.map((r) => r.messages.length)).toEqual([1, 3, 5, 7, 9]);

  // The network: Src1 → B1 → S1 → B2 → S2 → Sink1, laid out left to right.
  expect(editor.nodes.map((n) => [n.kind, n.name, n.position[0], n.position[1]])).toEqual([
    ["source", "Src1", 300, 200], ["buffer", "B1", 420, 200], ["station", "S1", 540, 200], ["buffer", "B2", 660, 200], ["station", "S2", 780, 200], ["sink", "Sink1", 900, 200],
  ]);
  const node = (name: string) => editor.nodes.find((n) => n.name === name)!;
  expect([node("Src1").distribution, node("Src1").distributionParameters]).toEqual(["poisson", "rate=0.8"]);
  expect([node("S1").distributionParameters, node("S2").distributionParameters, node("S2").numberOfServers]).toEqual(["rate=1.0", "rate=1.25", 1]);
  const name = (id: string) => editor.node(id)!.name;
  expect(editor.links.map((l) => `${name(l.fromNodeID)}>${name(l.toNodeID)}:${l.customerClass}:${l.routingProbability}`)).toEqual(["Src1>B1:0:1", "B1>S1:0:1", "S1>B2:0:1", "B2>S2:0:1", "S2>Sink1:0:1"]);
  expect(tabById(tabId)!.document.nodes).toHaveLength(6);

  // The run: QNA for this tab, with the network the tools built, replayed from 0.90.34's run.
  expect(mockRuns.starts).toHaveLength(1);
  expect(mockRuns.starts[0]).toMatchObject({ method: "qna", tabId, title: TITLE });
  expect((mockRuns.starts[0].document as { nodes: unknown[]; links: unknown[] }).nodes).toHaveLength(6);
  expect((mockRuns.starts[0].document as { nodes: unknown[]; links: unknown[] }).links).toHaveLength(5);
  await tick(40);
  expect(resultsFor(tabId).map((r) => r.provenance.networkTitle)).toEqual([TITLE]);

  // The tool results, as 0.90.34 worded them.
  const messages = conversationOf(tabId).messages;
  const tools = messages.filter((m) => m.call).map((m) => m.call!);
  expect(tools.map((c) => c.name)).toEqual(["get_network_summary", ...Array(6).fill("add_node"), ...Array(5).fill("add_link"), "run_command"]);
  expect(tools.every((c) => !c.isError && c.finished !== null)).toBe(true);
  expect(JSON.parse(tools[0].result!)).toMatchObject({ node_count: 0, link_count: 0, infinite_buffers: true });
  expect(tools.slice(1, 12).map((c) => c.result)).toEqual([
    'Added source "Src1" with distribution=poisson, distribution_parameters="rate=0.8".',
    'Added buffer "B1".',
    'Added station "S1" with distribution=exponential, distribution_parameters="rate=1.0".',
    'Added buffer "B2".',
    'Added station "S2" with number_of_servers=1, distribution=exponential, distribution_parameters="rate=1.25".',
    'Added sink "Sink1".',
    "Added link Src1 → B1 (class 0, routing_probability=1.0).",
    "Added link B1 → S1 (class 0, routing_probability=1.0).",
    "Added link S1 → B2 (class 0, routing_probability=1.0).",
    "Added link B2 → S2 (class 0, routing_probability=1.0).",
    "Added link S2 → Sink1 (class 0, routing_probability=1.0).",
  ]);
  const runResult = tools[12].result!;
  const log = tabById(tabId)!.log;
  const from = log.findIndex((e) => e.text === "Running QNA...");
  expect(from).toBeGreaterThan(0);
  expect(runResult.split("\n")[0]).toMatch(/^\(Run Whitt QNA \(infinite buffers only\) — settled with \d+ new line\(s\):\)$/);
  expect(runResult).toContain(formattedLine(log[from]));

  // The last tool turn the model was sent carries that result, matched to its call.
  expect(mockAi.requests[4].messages.at(-1)).toEqual({ role: "tool", results: [{ id: "t13", name: "run_command", content: runResult, isError: false }] });

  // The transcript.
  expect(messages.map((m) => (m.call ? `tool:${m.call.name}` : `${m.role}:${m.text}`))).toEqual([
    "user:Build a two-station tandem and run QNA on it.",
    "assistant:I'll look at the canvas first.",
    "tool:get_network_summary",
    ...Array(6).fill("tool:add_node"),
    ...Array(5).fill("tool:add_link"),
    "assistant:Now QNA.",
    "tool:run_command",
    "assistant:The tandem is built and **QNA** has run.",
  ]);
  expect(transcriptMarkdown(messages)).toContain("### Tool: `add_link` · ");

  // The undo history: every tool call was its own step, with the editor's own names; undoing them
  // all gives the empty canvas back, with no confirmation asked anywhere (decision D9).
  const names: string[] = [];
  while (editor.undoManager.canUndo) {
    names.push(editor.undoManager.undoActionName);
    editor.undo();
  }
  expect(names).toEqual([...Array(5).fill("Add Link"), "Add Sink", "Change Distribution", "Add Buffer", "Change Distribution", "Add Buffer", "Change Distribution"]);
  expect(editor.nodes).toHaveLength(0);
  expect(editor.links).toHaveLength(0);
});
