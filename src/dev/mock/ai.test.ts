// The scripted provider behind the preview and the AI pane's tests (ai.ts), through the same
// `api` methods the pane calls.
import { beforeEach, describe, expect, it } from "vitest";
import { api } from "../../lib/api";
import type { AiChatRequest, AiEvent } from "../../lib/types";
import { mockTauri } from "../../test/tauri";
import { defaultHandlers } from "../mockBackend";
import { MOCK_AI_DEFAULT_TEXT, mockAi } from "./ai";

const request = (over: Partial<AiChatRequest> = {}): AiChatRequest => ({
  provider: "anthropic", model: "claude-opus-5-5", baseURL: "https://api.anthropic.com", system: "Be brief.",
  messages: [{ role: "user", text: "Hello" }], tools: [], maxTokens: 4096, temperature: 0.7, timeoutSec: 60, fallback: true, ...over,
});

/** Runs one request to its last event. */
async function run(req: AiChatRequest) {
  const events: AiEvent[] = [];
  let finish!: () => void;
  const ended = new Promise<void>((r) => (finish = r));
  const id = await api.aiChat(req, (e) => {
    events.push(e);
    if (e.kind === "done" || e.kind === "error") finish();
  });
  await ended;
  return { id, events };
}

const text = (events: AiEvent[]) => events.map((e) => (e.kind === "text" ? e.delta : "")).join("");

beforeEach(() => mockTauri(defaultHandlers()));

describe("the scripted assistant", () => {
  it("answers an unscripted request with a short text and done", async () => {
    const { id, events } = await run(request());
    expect(id).toBe("ai-1");
    expect(text(events)).toBe(MOCK_AI_DEFAULT_TEXT);
    expect(events[events.length - 1]).toEqual({ kind: "done", stopReason: "end" });
    expect(mockAi.requests).toEqual([request()]);
    expect(mockAi.open()).toEqual([]);
  });

  it("plays scripted turns in order, one per request, and records each request", async () => {
    const call = { id: "c1", name: "add_node", input: { name: "S1" } };
    mockAi.script(
      [{ kind: "text", delta: "Adding." }, { kind: "toolCall", call }, { kind: "done", stopReason: "toolUse" }],
      [{ kind: "error", message: "HTTP 529: Overloaded" }],
    );
    expect(mockAi.pending()).toBe(2);
    const first = await run(request());
    expect(first.events).toEqual([{ kind: "text", delta: "Adding." }, { kind: "toolCall", call }, { kind: "done", stopReason: "toolUse" }]);
    const second = await run(request({ messages: [{ role: "user", text: "Again" }] }));
    expect(second.events).toEqual([{ kind: "error", message: "HTTP 529: Overloaded" }]);
    expect(mockAi.ids).toEqual(["ai-1", "ai-2"]);
    expect(mockAi.requests.map((r) => r.messages[0])).toEqual([{ role: "user", text: "Hello" }, { role: "user", text: "Again" }]);
    expect(text((await run(request())).events)).toBe(MOCK_AI_DEFAULT_TEXT);
  });

  it("keeps a held request open until Stop, which ends it with done cancelled", async () => {
    mockAi.hold();
    const events: AiEvent[] = [];
    const id = await api.aiChat(request(), (e) => events.push(e));
    mockAi.send({ kind: "text", delta: "Thinking" });
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([{ kind: "text", delta: "Thinking" }]);
    expect(mockAi.open()).toEqual([id]);
    await api.aiCancel(id);
    expect(events).toEqual([{ kind: "text", delta: "Thinking" }, { kind: "done", stopReason: "cancelled" }]);
    expect(mockAi.cancels).toEqual([id]);
    expect(mockAi.open()).toEqual([]);
    // A turn cut short by Stop sends nothing more.
    mockAi.delayMs = 20;
    mockAi.script([{ kind: "text", delta: "a" }, { kind: "text", delta: "b" }, { kind: "done", stopReason: "end" }]);
    const later: AiEvent[] = [];
    const id2 = await api.aiChat(request(), (e) => later.push(e));
    await api.aiCancel(id2);
    await new Promise((r) => setTimeout(r, 80));
    expect(later).toEqual([{ kind: "done", stopReason: "cancelled" }]);
  });

  it("finishes a held request from the test", async () => {
    mockAi.hold();
    const events: AiEvent[] = [];
    await api.aiChat(request(), (e) => events.push(e));
    mockAi.finish("maxTokens");
    expect(events).toEqual([{ kind: "done", stopReason: "maxTokens" }]);
  });

  it("keeps keys in memory and tells the page only whether one is stored", async () => {
    expect(await api.aiKeyStatus("anthropic")).toBe(false);
    await api.aiKeySet("anthropic", "sk-ant-test");
    expect(await api.aiKeyStatus("anthropic")).toBe(true);
    expect(await api.aiKeyStatus("openai")).toBe(false);
    await api.aiKeySet("openai", "   ");
    expect(await api.aiKeyStatus("openai")).toBe(false);
    await api.aiKeySet("anthropic", "");
    expect(await api.aiKeyStatus("anthropic")).toBe(false);
    await api.aiKeySet("openai", "sk");
    await api.aiKeyDelete("openai");
    expect(await api.aiKeyStatus("openai")).toBe(false);
  });

  it("refuses a keyless request in 0.90.34's words when asked to check keys", async () => {
    mockAi.requireKey = true;
    expect((await run(request())).events).toEqual([{ kind: "error", message: "AI backend not configured: API key is required for Anthropic (Claude API)." }]);
    expect(text((await run(request({ provider: "ollama" }))).events)).toBe(MOCK_AI_DEFAULT_TEXT);
    await api.aiKeySet("anthropic", "k");
    expect(text((await run(request())).events)).toBe(MOCK_AI_DEFAULT_TEXT);
  });

  it("lists models and tests the connection", async () => {
    expect(await api.aiModels("ollama", "http://localhost:11434")).toEqual([{ id: "llama3.2" }, { id: "qwen2.5:14b" }]);
    // Anthropic's list carries a display name where the server gives one (the preview: for a model the built-in list lacks).
    expect(await api.aiModels("anthropic", "https://api.anthropic.com")).toContainEqual({ id: "claude-mythos-5-2", displayName: "Claude Mythos 5.2" });
    expect((await api.aiModels("openai", "https://api.openai.com/v1"))[0]).toEqual({ id: "gpt-6-astra" });
    expect(await api.aiTest("ollama", "http://localhost:11434", "llama3.2")).toEqual({ ok: true, message: "Reply: pong" });
    expect(mockAi.modelCalls[0]).toEqual({ provider: "ollama", baseURL: "http://localhost:11434" });
    expect(mockAi.testCalls).toEqual([{ provider: "ollama", baseURL: "http://localhost:11434", model: "llama3.2" }]);
    mockAi.models = "Network error: Could not connect to the server.";
    await expect(api.aiModels("lmstudio", "http://localhost:1234/v1")).rejects.toThrow("Network error: Could not connect to the server.");
    mockAi.test = { ok: false, message: "HTTP 401: no" };
    expect(await api.aiTest("openai", "https://api.openai.com/v1", "gpt-4o-mini")).toEqual({ ok: false, message: "HTTP 401: no" });
  });
});
