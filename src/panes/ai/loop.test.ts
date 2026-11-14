// The agentic loop against the scripted provider (src/dev/mock/ai.ts): rounds, the ten-round
// pause and Continue, Stop, errors, what each request carries, and per-tab conversations
// (AIPaneView.swift `AIModel`; ledger §13.3, §13.4, AI-064, AI-065).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockAi } from "../../dev/mock/ai";
import { editorFor } from "../../editor";
import { loadKv, setSettings } from "../../lib/kv";
import type { AiMessage } from "../../lib/types";
import { mockTauri } from "../../test/tauri";
import { addTab, removeTabs, selectTab, tabById } from "../../workspace/store";
import { cancelRequest, clearConversation, continueToolLoop, conversationOf, DEFAULT_SYSTEM_PROMPT, draft, exchangeCount, getAiState, isBusy, resetAi, setDraft, submit, whenIdle } from "./model";
import { EXPLAIN_PROMPT } from "./explain/prompt";
import { call, textTurn, tick, toolTurn } from "./testing";
import { RUN_WAIT, toolSpecs } from "./tools";
import { aiWords as w } from "./words";

let tabId: string;
const rows = (id = tabId) => conversationOf(id).messages.map((m) => (m.call ? `tool:${m.call.name}` : `${m.role}:${m.text}`));
const history = (id = tabId) => conversationOf(id).history;

beforeEach(async () => {
  mockTauri(defaultHandlers({ settings: { "ai.provider": "ollama" } }));
  await loadKv();
  tabId = addTab({ title: "net.bnet" });
});
afterEach(() => {
  resetAi();
  RUN_WAIT.intervalMs = 250;
  RUN_WAIT.quietMs = 2000;
});

describe("one Send", () => {
  it("sends the trimmed message, streams the reply into the transcript and ends on a reply without tool calls (AI-028, AI-069)", async () => {
    mockAi.delayMs = 20;
    mockAi.script(textTurn("Two ", "stations.  \n"));
    setDraft("draft");
    expect(submit(tabId, "  How many stations?\n")).toBe(true);
    expect(draft()).toBe("");
    expect(isBusy()).toBe(true);
    expect(getAiState()).toMatchObject({ busyTabId: tabId, busyTabTitle: "net.bnet", busyPhase: "Thinking…" });
    await tick(30);
    const streaming = conversationOf(tabId).messages.at(-1)!;
    expect([streaming.role, streaming.isStreaming, streaming.text]).toEqual(["assistant", true, "Two "]);
    await whenIdle();
    expect(rows()).toEqual(["user:How many stations?", "assistant:Two stations."]);
    expect(conversationOf(tabId).messages[1].isStreaming).toBe(false);
    expect(history()).toEqual<AiMessage[]>([{ role: "user", text: "How many stations?" }, { role: "assistant", text: "Two stations.", toolCalls: [] }]);
    expect(isBusy()).toBe(false);
    expect(getAiState().busyPhase).toBe("");
  });

  it("refuses a blank message, and any message while a request runs anywhere (AI-030)", async () => {
    expect(submit(tabId, "  \n ")).toBe(false);
    mockAi.hold();
    expect(submit(tabId, "first")).toBe(true);
    const other = addTab({ title: "other.bnet" });
    expect(submit(other, "second")).toBe(false);
    expect(submit(tabId, "third")).toBe(false);
    expect(mockAi.requests).toHaveLength(1);
    cancelRequest();
    await whenIdle();
  });

  it("builds each request from the settings: provider, model, base URL, system prompt, limits, the tools sorted (AI-035, AI-040), and Qnet's rules for explaining after the person's prompt (WF-407)", async () => {
    await setSettings({ "ai.provider": "lmstudio", "ai.model.lmstudio": "qwen", "ai.baseURL.lmstudio": "http://127.0.0.1:1234/v1", "ai.maxTokens": 512, "ai.temperature": 0.2, "ai.timeoutSec": 30 });
    submit(tabId, "hello");
    await whenIdle();
    const r = mockAi.requests[0];
    expect(r).toMatchObject({ provider: "lmstudio", model: "qwen", baseURL: "http://127.0.0.1:1234/v1", maxTokens: 512, temperature: 0.2, timeoutSec: 30 });
    expect(r.system).toBe(`You are an assistant embedded in BNET, a tool for Brownian Network analysis of queueing systems. Answer concisely.\n\n${EXPLAIN_PROMPT}`);
    expect(r.system.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect(r.tools).toEqual(toolSpecs());
    expect(r.tools.map((t) => t.name)).toEqual([...r.tools.map((t) => t.name)].sort());
    expect(r.messages).toEqual([{ role: "user", text: "hello" }]);

    await setSettings({ "ai.systemPrompt": "Be terse.", "ai.provider": "ollama" });
    submit(tabId, "again");
    await whenIdle();
    expect(mockAi.requests[1]).toMatchObject({ provider: "ollama", model: "llama3.2", baseURL: "http://localhost:11434", system: `Be terse.\n\n${EXPLAIN_PROMPT}` });
  });
});

describe("tool rounds", () => {
  it("runs every call of a reply in order, sends all results as one turn, and sends the whole history each round (AI-028, AI-031, AI-033, AI-034)", async () => {
    mockAi.script(
      toolTurn("Adding. ", call("add_node", { kind: "station" }, "a"), call("add_node", { kind: "station", name: "S1" }, "b"), call("read_network", {}, "c")),
      textTurn("Done."),
    );
    submit(tabId, "add two stations");
    await whenIdle();
    expect(rows()).toEqual(["user:add two stations", "assistant:Adding.", "tool:add_node", "tool:add_node", "tool:read_network", "assistant:Done."]);
    const tools = conversationOf(tabId).messages.filter((m) => m.call).map((m) => m.call!);
    expect(tools.map((c) => [c.result, c.isError])).toEqual([
      ['Added station "S1".', false],
      ['Invalid tool input: A node named "S1" already exists.', true],
      ["Unknown tool: read_network", true],
    ]);
    expect(tools[1].inputText).toBe('{\n  "kind" : "station",\n  "name" : "S1"\n}');
    expect(tools[1].inputSummary).toBe("kind=station, name=S1");
    expect(tools.every((c) => c.finished !== null)).toBe(true);
    expect(editorFor(tabId).nodes.map((n) => n.name)).toEqual(["S1"]);

    expect(mockAi.requests).toHaveLength(2);
    expect(mockAi.requests[1].messages).toEqual<AiMessage[]>([
      { role: "user", text: "add two stations" },
      { role: "assistant", text: "Adding.", toolCalls: [{ id: "a", name: "add_node", input: { kind: "station" } }, { id: "b", name: "add_node", input: { kind: "station", name: "S1" } }, { id: "c", name: "read_network", input: {} }] },
      {
        role: "tool",
        results: [
          // What the model reads has every name of the network between ‹ and › (ledger WF-507);
          // the transcript's rows above keep 0.90.34's wording.
          { id: "a", name: "add_node", content: 'Added station "‹S1›".', isError: false },
          { id: "b", name: "add_node", content: 'Invalid tool input: A node named "‹S1›" already exists.', isError: true },
          { id: "c", name: "read_network", content: "Unknown tool: read_network", isError: true },
        ],
      },
    ]);
    expect(history()).toHaveLength(4);
  });

  it("shows no assistant row for a reply that is only tool calls, and says what it is doing (AI-076)", async () => {
    mockAi.script(toolTurn(call("run_command", { name: "RunFiniteElement" })), textTurn("ok"));
    RUN_WAIT.intervalMs = 5;
    RUN_WAIT.quietMs = 60;
    editorFor(tabId).setInfiniteBuffers(true);
    submit(tabId, "run it");
    await tick(20);
    expect(getAiState().busyPhase).toBe("Running run_command…");
    expect(conversationOf(tabId).messages.at(-1)!.call).toMatchObject({ name: "run_command", finished: null, result: null });
    await whenIdle();
    expect(rows()).toEqual(["user:run it", "tool:run_command", "assistant:ok"]);
  });

  it("pauses after ten rounds with 0.90.34's note and a Continue that runs ten more on the same history (AI-029)", async () => {
    for (let i = 0; i < 12; i++) mockAi.script(toolTurn(call("get_network_summary")));
    mockAi.script(textTurn("Finished."));
    submit(tabId, "loop");
    await whenIdle();
    expect(mockAi.requests).toHaveLength(10);
    const note = conversationOf(tabId).messages.at(-1)!;
    expect(note.role).toBe("system");
    expect(note.text).toBe("Paused after 10 tool calls without a final answer. Continue to let the assistant keep working, or ask a narrower question.");
    expect(note.action).toBe("continueToolLoop");
    expect(history().at(-1)!.role).toBe("tool");
    expect(history()).toHaveLength(21);

    continueToolLoop(tabId);
    expect(conversationOf(tabId).messages.find((m) => m.id === note.id)!.action).toBeNull();
    await whenIdle();
    expect(mockAi.requests).toHaveLength(13);
    expect(mockAi.requests[10].messages).toHaveLength(21);
    expect(rows().at(-1)).toBe("assistant:Finished.");
    expect(conversationOf(tabId).messages.filter((m) => m.action)).toHaveLength(0);
  });
});

describe("Stop", () => {
  it("cancels mid-stream: the partial text stays, 'Stopped.' is added, the provider is told (AI-036)", async () => {
    mockAi.script([{ kind: "text", delta: "Partial ans" }]);
    submit(tabId, "question");
    await tick(5);
    expect(conversationOf(tabId).messages.at(-1)).toMatchObject({ text: "Partial ans", isStreaming: true });
    cancelRequest();
    await whenIdle();
    expect(rows()).toEqual(["user:question", "assistant:Partial ans", "system:Stopped."]);
    expect(conversationOf(tabId).messages[1].isStreaming).toBe(false);
    expect(mockAi.cancels).toEqual([mockAi.ids[0]]);
    expect(isBusy()).toBe(false);
    // The unfinished reply never reached the history; the next Send is well-formed.
    expect(history()).toEqual([{ role: "user", text: "question" }]);
  });

  it("stops a request that has not answered yet, and one stopped before it had an id", async () => {
    mockAi.hold();
    submit(tabId, "q");
    cancelRequest();
    await whenIdle();
    await tick(5);
    expect(rows()).toEqual(["user:q", "system:Stopped."]);
    expect(mockAi.cancels).toEqual([mockAi.ids[0]]);
  });

  it("marks a tool still running as 'Cancelled.' and leaves no unmatched tool call in the history (AI-036, AI-037)", async () => {
    mockAi.script(toolTurn(call("run_command", { name: "RunFiniteElement" }, "r1"), call("add_node", { kind: "sink" }, "r2")));
    RUN_WAIT.intervalMs = 5;
    RUN_WAIT.quietMs = 5000;
    editorFor(tabId).setInfiniteBuffers(true);
    submit(tabId, "run");
    await tick(30);
    cancelRequest();
    await whenIdle();
    expect(rows()).toEqual(["user:run", "tool:run_command", "system:Stopped."]);
    expect(conversationOf(tabId).messages[1].call).toMatchObject({ result: "Cancelled.", isError: true });
    expect(conversationOf(tabId).messages[1].call!.finished).not.toBeNull();
    expect(history().at(-1)).toEqual({ role: "tool", results: [{ id: "r1", name: "run_command", content: "Cancelled.", isError: true }, { id: "r2", name: "add_node", content: "Cancelled.", isError: true }] });
    expect(editorFor(tabId).nodes).toHaveLength(0);

    mockAi.script(textTurn("fine"));
    submit(tabId, "and now?");
    await whenIdle();
    const sent = mockAi.requests.at(-1)!.messages;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });
});

describe("errors", () => {
  it("shows a provider error as a '⚠ ' system row and frees the composer; the user sends again (AI-032, AI-039)", async () => {
    mockAi.script([{ kind: "text", delta: "Half" }, { kind: "error", message: "HTTP 401: invalid x-api-key" }]);
    submit(tabId, "hi");
    await whenIdle();
    expect(rows()).toEqual(["user:hi", "assistant:Half", "system:⚠ HTTP 401: invalid x-api-key"]);
    expect(conversationOf(tabId).messages[1].isStreaming).toBe(false);
    expect(isBusy()).toBe(false);
    mockAi.script(textTurn("Hello."));
    expect(submit(tabId, "hi again")).toBe(true);
    await whenIdle();
    expect(mockAi.requests[1].messages).toEqual([{ role: "user", text: "hi" }, { role: "user", text: "hi again" }]);
  });

  it("shows 0.90.34's missing-key sentence when the backend refuses for want of a key", async () => {
    await setSettings({ "ai.provider": "anthropic" });
    mockAi.requireKey = true;
    submit(tabId, "hi");
    await whenIdle();
    expect(rows().at(-1)).toBe("system:⚠ AI backend not configured: API key is required for Anthropic (Claude API).");
  });

  it("shows a failed command the same way", async () => {
    mockTauri({ ...defaultHandlers({ settings: { "ai.provider": "ollama" } }), ai_chat: () => { throw { kind: "failed", message: "The assistant backend is not available." }; } });
    tabId = addTab({ title: "net.bnet" });
    submit(tabId, "hi");
    await whenIdle();
    expect(rows().at(-1)).toBe("system:⚠ The assistant backend is not available.");
  });
});

describe("conversations per tab", () => {
  it("keeps one transcript and history per tab; a request keeps writing to the tab it started in (AI-064)", async () => {
    const other = addTab({ title: "other.bnet" });
    selectTab(tabId);
    mockAi.script(toolTurn(call("add_node", { kind: "source" })));
    mockAi.hold();
    submit(tabId, "add a source");
    await tick(10);
    selectTab(other);
    // The tool ran on the conversation's tab, not the one now in front (AI-042).
    expect(editorFor(tabId).nodes.map((n) => n.name)).toEqual(["Src1"]);
    expect(editorFor(other).nodes).toHaveLength(0);
    mockAi.send({ kind: "text", delta: "Added it." });
    mockAi.finish();
    await whenIdle();
    expect(rows(tabId)).toEqual(["user:add a source", "tool:add_node", "assistant:Added it."]);
    expect(rows(other)).toEqual([]);

    mockAi.script(textTurn("Nothing here."));
    submit(other, "what is here?");
    await whenIdle();
    expect(mockAi.requests.at(-1)!.messages).toEqual([{ role: "user", text: "what is here?" }]);
    expect(rows(other)).toEqual(["user:what is here?", "assistant:Nothing here."]);
    expect(exchangeCount(tabId)).toBe(2);
    expect(exchangeCount(other)).toBe(2);
  });

  it("discards a closed tab's conversation, and stops a request running for it (WS-034, AI-064)", async () => {
    mockAi.script(textTurn("a"));
    submit(tabId, "q");
    await whenIdle();
    const other = addTab({ title: "other.bnet" });
    mockAi.hold();
    submit(other, "long question");
    await tick(5);
    removeTabs([other]);
    await whenIdle();
    expect(isBusy()).toBe(false);
    expect(mockAi.cancels).toHaveLength(1);
    expect(conversationOf(other).messages).toEqual([]);
    expect(rows(tabId)).toEqual(["user:q", "assistant:a"]);
    removeTabs([tabId]);
    expect(tabById(tabId)).toBeUndefined();
    expect(conversationOf(tabId).messages).toEqual([]);
  });

  it("Clear empties only that tab, history included, and cancels its request", async () => {
    mockAi.script(textTurn("a"));
    submit(tabId, "q");
    await whenIdle();
    const other = addTab({ title: "other.bnet" });
    mockAi.script(textTurn("b"));
    submit(other, "q2");
    await whenIdle();
    clearConversation(tabId);
    expect(conversationOf(tabId)).toEqual({ messages: [], history: [] });
    expect(rows(other)).toEqual(["user:q2", "assistant:b"]);
    mockAi.hold();
    submit(other, "q3");
    await tick(5);
    clearConversation(other);
    await whenIdle();
    expect(mockAi.cancels).toHaveLength(1);
    expect(isBusy()).toBe(false);
    expect(w.stopped).toBe("Stopped.");
  });
});

describe("the current models (2.1, ledger AI-204, AI-206)", () => {
  it("says a declined reply in plain words, keeps none of its partial text and runs none of its tool calls", async () => {
    mockAi.script([{ kind: "text", delta: "Here is how to" }, call("run_command", { name: "RunQNA" }, "c1"), { kind: "refused", category: "cyber", explanation: null }, { kind: "done", stopReason: "refusal" }]);
    submit(tabId, "Explain this result");
    await whenIdle();
    expect(rows()).toEqual(["user:Explain this result", `system:${w.refused(null, "cyber")}`]);
    expect(w.refused(null, "cyber")).toBe("The model declined to answer this request (category: cyber). Try rephrasing it, or choose another model in Settings ▸ AI Assistant.");
    expect(history()).toEqual<AiMessage[]>([{ role: "user", text: "Explain this result" }, { role: "assistant", text: "", toolCalls: [] }]);
    expect(mockAi.requests).toHaveLength(1);
  });

  it("keeps a reply's output items on its turn and sends them back with the next round", async () => {
    await setSettings({ "ai.provider": "openai", "ai.model.openai": "gpt-6-astra" });
    const replay = { provider: "openai" as const, model: "gpt-6-astra", items: [{ type: "reasoning", id: "rs_1", encrypted_content: "x" }] };
    mockAi.script([{ kind: "replay", replay }, call("get_network_summary", {}, "c1"), { kind: "done", stopReason: "toolUse" }], textTurn("Done."));
    submit(tabId, "Summarise");
    await whenIdle();
    expect(history()[1]).toEqual({ role: "assistant", text: "", toolCalls: [{ id: "c1", name: "get_network_summary", input: {} }], replay });
    expect(mockAi.requests[1].messages[1]).toEqual(history()[1]);
    // A turn without items carries no `replay` field.
    expect(history()[3]).toEqual({ role: "assistant", text: "Done.", toolCalls: [] });
  });

  it("asks for the refusal fallback unless the person turned it off", async () => {
    await setSettings({ "ai.provider": "anthropic" });
    submit(tabId, "one");
    await whenIdle();
    expect(mockAi.requests[0]).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", fallback: true });
    await setSettings({ "ai.fallback.anthropic": false });
    submit(tabId, "two");
    await whenIdle();
    expect(mockAi.requests[1].fallback).toBe(false);
  });
});
