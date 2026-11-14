// The assistant's backend in the browser preview and the tests (src-tauri/src/ai/): no provider is
// called here. A scripted provider answers instead: each `ai_chat` takes the next scripted turn
// (default: a short text answer), records the request it was given, and streams the turn's events
// down the channel. Keys, the model list and the connection test live in memory.
//
//   mockAi.script([{ kind: "text", delta: "Hi" }, { kind: "done", stopReason: "end" }]);   // one turn
//   mockAi.script(turn1, turn2);                                                          // one per request
//   mockAi.requests        every AiChatRequest given, oldest first
//   mockAi.hold()          the next request stays open until ai_cancel, mockAi.send or mockAi.finish
//   mockAi.responder       a scripted model: asked for a turn when no scripted turn is queued (it reads the
//                          request's tool results, as a model would); null answers the default text. The
//                          preview sets ./aiExplain.ts's, so the explaining starters can be tried offline.
import type { MockHandlers } from "../../test/tauri";
import { channelEnd, channelSend } from "../../test/tauri";
import type { AiChatRequest, AiEvent, AiProvider } from "../../lib/types";

/** 0.90.34's display names (LLMProvider.displayName), as the error sentences use them. */
export const MOCK_AI_PROVIDER_NAMES: Record<AiProvider, string> = {
  anthropic: "Anthropic (Claude API)",
  openai: "OpenAI",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
};

/** What a provider's models endpoint answers in the preview (sorted, as Rust sorts them). */
export const MOCK_AI_MODELS: Record<AiProvider, string[]> = {
  anthropic: ["claude-fable-5-2", "claude-haiku-5-5", "claude-mythos-5-2", "claude-opus-5-5", "claude-sonnet-4-5", "claude-sonnet-5-5"],
  openai: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-4.1", "gpt-4o"],
  ollama: ["llama3.2", "qwen2.5:14b"],
  lmstudio: ["qwen2.5-14b-instruct"],
};

/** Anthropic's `display_name`s in the preview's list. */
export const MOCK_AI_NAMES: Record<string, string> = { "claude-mythos-5-2": "Claude Mythos 5.2" };

/** The answer to a request nobody scripted. */
export const MOCK_AI_DEFAULT_TEXT = "This is the preview's scripted assistant.";

const defaultTurn = (): AiEvent[] => [
  { kind: "text", delta: "This is the preview's " },
  { kind: "text", delta: "scripted assistant." },
  { kind: "done", stopReason: "end" },
];

const isLast = (e: AiEvent) => e.kind === "done" || e.kind === "error";

interface OpenStream {
  channel: unknown;
  timers: ReturnType<typeof setTimeout>[];
}

const open = new Map<string, OpenStream>();
let queue: AiEvent[][] = [];
let seq = 0;

function close(id: string, last?: AiEvent) {
  const s = open.get(id);
  if (!s) return;
  open.delete(id);
  for (const t of s.timers) clearTimeout(t);
  if (last) channelSend(s.channel, last);
  channelEnd(s.channel);
}

export const mockAi = {
  /** Every request `ai_chat` was given, oldest first. */
  requests: [] as AiChatRequest[],
  /** The id each request was answered with, in the same order. */
  ids: [] as string[],
  /** Every id `ai_cancel` was called with. */
  cancels: [] as string[],
  /** The stored keys (the page never sees them: `ai_key_status` answers true or false). */
  keys: {} as Partial<Record<AiProvider, string>>,
  /** Every ai_models and ai_test call. */
  modelCalls: [] as { provider: AiProvider; baseURL: string }[],
  testCalls: [] as { provider: AiProvider; baseURL: string; model: string }[],
  /** What ai_models answers; a string is the sentence it fails with. */
  models: { ...MOCK_AI_MODELS } as Record<AiProvider, string[]> | string,
  /** What ai_test answers. */
  test: { ok: true, message: "Reply: pong" } as { ok: boolean; message: string },
  /** True: Anthropic and OpenAI requests without a stored key fail with 0.90.34's sentence, as Rust does. */
  requireKey: false,
  /** Milliseconds between a turn's events (0: one macrotask each). */
  delayMs: 0,
  /** A scripted model for requests no queued turn answers; null (or a null answer): the default text. */
  responder: null as null | ((request: AiChatRequest) => AiEvent[] | null),

  /**
   * Queues scripted turns, one per coming request, in order. A turn without a final `done` or
   * `error` stays open (the pane shows "busy") until `ai_cancel`, `send` or `finish`.
   */
  script(...turns: AiEvent[][]) {
    queue.push(...turns.map((t) => [...t]));
  },
  /** The next request gets no events and stays open. */
  hold() {
    queue.push([]);
  },
  /** Scripted turns not yet used. */
  pending: () => queue.length,
  /** The ids of the requests still streaming. */
  open: () => [...open.keys()],
  /** Sends one event on an open request (the latest when `id` is omitted); `done` or `error` closes it. */
  send(event: AiEvent, id?: string) {
    const target = id ?? [...open.keys()].pop();
    if (target === undefined) return;
    const s = open.get(target);
    if (!s) return;
    if (isLast(event)) close(target, event);
    else channelSend(s.channel, event);
  },
  /** Ends an open request (the latest when `id` is omitted). */
  finish(stopReason: "end" | "toolUse" | "maxTokens" | "cancelled" | "other" = "end", id?: string) {
    this.send({ kind: "done", stopReason }, id);
  },
  /** Back to an empty script and no recorded calls (the handler table does this when it is built). */
  reset() {
    for (const id of [...open.keys()]) close(id);
    queue = [];
    seq = 0;
    Object.assign(this, {
      requests: [], ids: [], cancels: [], keys: {}, modelCalls: [], testCalls: [],
      models: { ...MOCK_AI_MODELS }, test: { ok: true, message: "Reply: pong" }, requireKey: false, delayMs: 0, responder: null,
    });
  },
};

export function aiHandlers(): MockHandlers {
  mockAi.reset();
  return {
    ai_chat: ({ request, channel }: { request: AiChatRequest; channel: unknown }) => {
      const id = `ai-${++seq}`;
      mockAi.requests.push(JSON.parse(JSON.stringify(request)) as AiChatRequest);
      mockAi.ids.push(id);
      const stream: OpenStream = { channel, timers: [] };
      open.set(id, stream);
      const needsKey = request.provider === "anthropic" || request.provider === "openai";
      const turn: AiEvent[] = mockAi.requireKey && needsKey && !mockAi.keys[request.provider]
        ? [{ kind: "error", message: `AI backend not configured: API key is required for ${MOCK_AI_PROVIDER_NAMES[request.provider]}.` }]
        : queue.shift() ?? mockAi.responder?.(JSON.parse(JSON.stringify(request)) as AiChatRequest) ?? defaultTurn();
      // After the command has answered with the id, one event at a time, as a stream arrives.
      turn.forEach((event, i) => {
        stream.timers.push(setTimeout(() => {
          if (!open.has(id)) return;
          if (isLast(event)) close(id, event);
          else channelSend(channel, event);
        }, mockAi.delayMs * (i + 1)));
      });
      return id;
    },
    ai_cancel: ({ id }: { id: string }) => {
      mockAi.cancels.push(id);
      close(id, { kind: "done", stopReason: "cancelled" });
      return null;
    },
    ai_key_set: ({ provider, key }: { provider: AiProvider; key: string }) => {
      if (key === "") delete mockAi.keys[provider];
      else mockAi.keys[provider] = key;
      return null;
    },
    ai_key_status: ({ provider }: { provider: AiProvider }) => (mockAi.keys[provider] ?? "").trim() !== "",
    ai_key_delete: ({ provider }: { provider: AiProvider }) => {
      delete mockAi.keys[provider];
      return null;
    },
    ai_models: ({ provider, baseURL }: { provider: AiProvider; baseURL: string }) => {
      mockAi.modelCalls.push({ provider, baseURL });
      if (typeof mockAi.models === "string") throw { kind: "failed", message: mockAi.models };
      // As Rust answers: ids, with Anthropic's display names (here only for the one the catalog lacks).
      return (mockAi.models[provider] ?? []).map((id) => (provider === "anthropic" && MOCK_AI_NAMES[id] ? { id, displayName: MOCK_AI_NAMES[id] } : { id }));
    },
    ai_test: ({ provider, baseURL, model }: { provider: AiProvider; baseURL: string; model: string }) => {
      mockAi.testCalls.push({ provider, baseURL, model });
      return { ...mockAi.test };
    },
  };
}
