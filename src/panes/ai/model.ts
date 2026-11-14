// The assistant's conversations and its agentic loop (0.90.34 AIPaneView.swift `AIModel`; ledger
// §13.3, §13.4, AI-064, AI-065): one transcript and one provider history per tab id, kept in
// memory only and dropped when the tab closes; one request at a time across all tabs; each Send
// runs rounds of "send the whole history, stream the reply, run its tool calls, send their
// results" until a reply has no tool call, for at most ten rounds.
//
// The provider is behind `api.aiChat` (src-tauri/src/ai/): this module builds one AiChatRequest
// per round from the settings and the history, and reads the AiEvent stream.
import { useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { getSetting } from "../../lib/kv";
import type { AiChatRequest, AiEvent, AiMessage, AiProvider, AiReplay, AiToolCall } from "../../lib/types";
import { editorFor } from "../../editor";
import { activeTab, getWorkspace, onWorkspaceChange, tabById } from "../../workspace/store";
import { executeTool, inputSummary, inputText, ToolCancelled, toolSpecs } from "./tools";
import { factsOf, forgetFacts, networkKeyOf } from "./explain/facts";
import { systemPrompt } from "./explain/prompt";
import { forgetPlans } from "./explain/tools";
import { ACTION_LABEL, ACTION_LIMIT, askedForAction, askFirst, guardNames, namesOf, UNCONFIRMED_ACTIONS, unguardInput } from "./explain/guard";
import { numbersIn, parameterInputs, verifyAnswer, type AnswerCheck } from "./explain/verify";
import { aiWords as w } from "./words";

// ── The transcript ───────────────────────────────────────────────────────────────────────────

/** A tool invocation as the transcript shows it (`AIToolCall`). */
export interface ToolCallRecord {
  name: string;
  /** Pretty-printed JSON of the arguments. */
  inputText: string;
  /** One-line "key=value, …" for the collapsed row. */
  inputSummary: string;
  result: string | null;
  isError: boolean;
  started: number;
  finished: number | null;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  timestamp: number;
  /** True while text deltas are still arriving. */
  isStreaming: boolean;
  /** A system row's button; cleared once pressed. */
  action: "continueToolLoop" | "allowAction" | null;
  /** With "allowAction": the tool the person is asked to allow (./explain/guard.ts). */
  allow?: string;
  /** Present on `tool` rows. */
  call: ToolCallRecord | null;
  /** An assistant reply's numbers checked against what it cites (./explain/verify.ts); absent while it streams. */
  check?: AnswerCheck | null;
}

export interface Conversation {
  messages: TranscriptMessage[];
  /** What the provider is sent: every turn, tool calls and results included, never trimmed (AI-031). */
  history: AiMessage[];
}

export interface AiState {
  /** The tab the request in flight belongs to, or null when idle. */
  busyTabId: string | null;
  /** That tab's title when the request started ("Working on <title>"). */
  busyTabTitle: string;
  /** "Thinking…" or "Running <tool>…". */
  busyPhase: string;
  /** Bumped on every change, so React re-reads. */
  version: number;
}

/** Safety valve on the loop (`maxToolIterations`). */
export const MAX_TOOL_ITERATIONS = 10;

const EMPTY: Conversation = Object.freeze({ messages: [], history: [] }) as Conversation;
const conversations = new Map<string, Conversation>();
let draftText = "";
let state: AiState = { busyTabId: null, busyTabTitle: "", busyPhase: "", version: 0 };
const listeners = new Set<() => void>();
let seq = 0;
let watching = false;

/** The request in flight: its cancel flag and how to end the round it is waiting in. */
let current: { cancelled: boolean; abortRound: (() => void) | null; requestId: string | null } | null = null;

function publish(patch: Partial<AiState> = {}) {
  state = { ...state, ...patch, version: state.version + 1 };
  listeners.forEach((l) => l());
}

/** A closed tab's conversation is discarded, and a request running for it is stopped (WS-034, AI-064). */
function watch() {
  if (watching) return;
  watching = true;
  onWorkspaceChange((ws) => {
    const ids = new Set(ws.tabs.map((t) => t.id));
    let changed = false;
    for (const id of [...conversations.keys()]) {
      if (!ids.has(id)) {
        conversations.delete(id);
        forgetFacts(id);
        forgetPlans(id);
        changed = true;
      }
    }
    if (state.busyTabId && !ids.has(state.busyTabId)) cancelRequest();
    if (changed) publish();
  });
}

const newId = () => `m${++seq}`;

function message(role: TranscriptMessage["role"], text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { id: newId(), role, text, timestamp: Date.now(), isStreaming: false, action: null, call: null, ...extra };
}

export function conversationOf(tabId: string): Conversation {
  return conversations.get(tabId) ?? EMPTY;
}

function mutate(tabId: string, change: (c: Conversation) => Conversation) {
  // A tab that has closed keeps nothing.
  if (!tabById(tabId)) return;
  watch();
  conversations.set(tabId, change(conversationOf(tabId)));
  publish();
}

const mutateMessages = (tabId: string, f: (m: TranscriptMessage[]) => TranscriptMessage[]) => mutate(tabId, (c) => ({ ...c, messages: f(c.messages) }));
const mutateHistory = (tabId: string, f: (h: AiMessage[]) => AiMessage[]) => mutate(tabId, (c) => ({ ...c, history: f(c.history) }));

export function getAiState(): AiState {
  return state;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The assistant's state, re-rendering on every change of it or of any conversation. */
export function useAi(): AiState {
  return useSyncExternalStore(subscribe, () => state);
}

export const isBusy = () => state.busyTabId !== null;

/** The composer's text (`AIModel.input`: one field, whichever tab is in front). */
export const draft = () => draftText;
export function setDraft(text: string) {
  if (text === draftText) return;
  draftText = text;
  publish();
}

/** User and assistant messages (no system notes, no tool rows): gates Export and the Clear question. */
export function exchangeCount(tabId: string): number {
  return conversationOf(tabId).messages.filter((m) => m.role === "user" || m.role === "assistant").length;
}

// ── The request ──────────────────────────────────────────────────────────────────────────────

export const PROVIDERS: AiProvider[] = ["anthropic", "openai", "ollama", "lmstudio"];
/** `LLMProvider.requiresAPIKey`. */
export const requiresKey = (p: AiProvider) => p === "anthropic" || p === "openai";

/** `aiProviderResolved`: an unknown stored value reads as Anthropic. */
export function resolvedProvider(raw: unknown = getSetting<string>("ai.provider", "anthropic")): AiProvider {
  return (PROVIDERS as string[]).includes(String(raw)) ? (raw as AiProvider) : "anthropic";
}

const DEFAULT_URL: Record<AiProvider, string> = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1", ollama: "http://localhost:11434", lmstudio: "http://localhost:1234/v1" };
// 2.1: the current models (src/panes/ai/catalog.ts); a stored model is never changed for the person.
const DEFAULT_MODEL: Record<AiProvider, string> = { anthropic: "claude-opus-5-5", openai: "gpt-6-astra", ollama: "llama3.2", lmstudio: "local-model" };
/** `ai.systemPrompt`'s default (settings_schema.rs; it still says BNET, as 0.90.34's did). */
export const DEFAULT_SYSTEM_PROMPT = "You are an assistant embedded in BNET, a tool for Brownian Network analysis of queueing systems. Answer concisely.";

export const modelSetting = (p: AiProvider) => String(getSetting<string>(`ai.model.${p}`, DEFAULT_MODEL[p]) ?? "");
export const baseURLSetting = (p: AiProvider) => String(getSetting<string>(`ai.baseURL.${p}`, DEFAULT_URL[p]) ?? "");

/** `currentAIConfig()` and the catalog: one round's request, read from the settings at send time. */
export function buildRequest(history: AiMessage[]): AiChatRequest {
  const provider = resolvedProvider();
  return {
    provider,
    model: modelSetting(provider),
    baseURL: baseURLSetting(provider),
    // The person's own prompt, then Qnet's rules for explaining (./explain/prompt.ts).
    system: systemPrompt(String(getSetting<string>("ai.systemPrompt", DEFAULT_SYSTEM_PROMPT) ?? "")),
    messages: history,
    // Every provider is offered the tools (`supportsToolUse` is true for all four), sorted by name.
    tools: toolSpecs(),
    maxTokens: Number(getSetting<number>("ai.maxTokens", 4096)),
    temperature: Number(getSetting<number>("ai.temperature", 0.7)),
    timeoutSec: Number(getSetting<number>("ai.timeoutSec", 60)),
    fallback: getSetting<boolean>("ai.fallback.anthropic", true) !== false,
  };
}

class Cancelled extends Error {}

/** The numbers the assistant has passed to tools since the person's last message (inputs it chose, not results). */
function toolInputsThisTurn(history: readonly AiMessage[], now: readonly AiToolCall[]): number[] {
  const out: number[] = [];
  for (const c of now) numbersIn(c.input, out);
  for (let i = history.length - 1; i >= 0 && history[i].role !== "user"; i--) {
    const m = history[i];
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) numbersIn(c.input, out);
  }
  return out;
}

/** One round trip (`send`): streams text into a placeholder assistant row; resolves to the reply. */
async function sendRound(tabId: string, history: AiMessage[], run: NonNullable<typeof current>): Promise<{ text: string; toolCalls: AiToolCall[]; replay?: AiReplay }> {
  const placeholderId = newId();
  let streamed = "";
  const toolCalls: AiToolCall[] = [];
  let replay: AiReplay | undefined;
  let refused: { category: string | null; explanation: string | null } | null = null;
  let settle!: (outcome: { error?: string; cancelled?: boolean }) => void;
  const ended = new Promise<{ error?: string; cancelled?: boolean }>((r) => (settle = r));
  let over = false;
  const onEvent = (e: AiEvent) => {
    if (over) return;
    switch (e.kind) {
      case "text":
        streamed += e.delta;
        mutateMessages(tabId, (list) =>
          list.some((m) => m.id === placeholderId)
            ? list.map((m) => (m.id === placeholderId ? { ...m, text: m.text + e.delta } : m))
            : [...list, message("assistant", e.delta, { id: placeholderId, isStreaming: true })],
        );
        break;
      case "toolCall":
        toolCalls.push(e.call);
        break;
      case "replay":
        replay = e.replay;
        break;
      case "refused":
        refused = { category: e.category, explanation: e.explanation };
        break;
      case "done":
        over = true;
        settle(e.stopReason === "cancelled" ? { cancelled: true } : {});
        break;
      case "error":
        over = true;
        settle({ error: e.message });
        break;
    }
  };
  run.abortRound = () => {
    over = true;
    settle({ cancelled: true });
  };
  run.requestId = null;
  try {
    const started = api.aiChat(buildRequest(history), onEvent).then(
      (id) => {
        run.requestId = id;
        // Stop was pressed before the request had its id.
        if (run.cancelled) void api.aiCancel(id).catch(() => {});
        return null;
      },
      (e: unknown) => {
        over = true;
        settle({ error: e instanceof Error ? e.message : String(e) });
        return null;
      },
    );
    const outcome = await ended;
    void started;
    if (outcome.cancelled || run.cancelled) throw new Cancelled();
    if (outcome.error !== undefined) throw new Error(outcome.error);
  } finally {
    run.abortRound = null;
  }
  // Declined (2.1): the partial text is not an answer, so it is neither kept nor sent back; the
  // transcript says so in plain words instead of "Other" (ledger AI-204).
  if (refused) {
    const { category, explanation } = refused;
    mutateMessages(tabId, (list) => [...list.filter((m) => m.id !== placeholderId), message("system", w.refused(explanation, category))]);
    return { text: "", toolCalls: [] };
  }
  // .whitespacesAndNewlines
  const text = streamed.trim();
  // Every number of the reply is held against the facts it cites, as the network is now.
  const check = text ? verifyAnswer(text, { facts: factsOf(tabId), networkKey: networkKeyOf(tabId), inputs: [...toolInputsThisTurn(history, toolCalls), ...parameterInputs(factsOf(tabId), networkKeyOf(tabId))] }) : null;
  mutateMessages(tabId, (list) => {
    if (!list.some((m) => m.id === placeholderId)) return text ? [...list, message("assistant", text, { check })] : list;
    return text ? list.map((m) => (m.id === placeholderId ? { ...m, text, isStreaming: false, check } : m)) : list.filter((m) => m.id !== placeholderId);
  });
  return { text, toolCalls, replay };
}

const lastUserText = (history: readonly AiMessage[]): string | null => {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "user") return (history[i] as { text?: string }).text ?? null;
  return null;
};

/** Calls of the no-dialog action tools the model has made since the person's last message (Continue re-enters the loop). */
function actionsSinceLastMessage(history: readonly AiMessage[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i].role !== "user"; i--) {
    const m = history[i];
    if (m.role === "assistant") n += (m.toolCalls ?? []).filter((c) => UNCONFIRMED_ACTIONS.has(c.name)).length;
  }
  return n;
}

/** Why `solve` or `check_with_another_method` is not honoured now, or null. */
function actionRefusal(tabId: string, _tool: string, honoured: { count: number }): "notAsked" | "limit" | null {
  if (!askedForAction(lastUserText(conversationOf(tabId).history))) return "notAsked";
  return honoured.count >= ACTION_LIMIT ? "limit" : null;
}

/** The one-click yes under an "ask first" row: the person says it, and the loop goes on with their word. */
export function allowAction(tabId: string, tool: string): boolean {
  if (isBusy()) return false;
  mutateMessages(tabId, (list) => list.map((m) => (m.action === "allowAction" ? { ...m, action: null } : m)));
  return submit(tabId, w.allowSay(ACTION_LABEL[tool] ?? tool));
}

/** `runAgenticLoop`. */
async function runLoop(tabId: string, run: NonNullable<typeof current>): Promise<void> {
  const check = () => {
    if (run.cancelled) throw new Cancelled();
  };
  // Runs started without a dialog since the person's last message, and what they were asked to allow.
  const honoured = { count: actionsSinceLastMessage(conversationOf(tabId).history) };
  const asked = new Set<string>();
  for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
    check();
    publish({ busyPhase: w.thinking });
    const reply = await sendRound(tabId, conversationOf(tabId).history, run);
    check();
    mutateHistory(tabId, (h) => [...h, { role: "assistant", text: reply.text, toolCalls: reply.toolCalls, ...(reply.replay ? { replay: reply.replay } : {}) }]);
    if (!reply.toolCalls.length) return;

    const results: { id: string; name: string; content: string; isError: boolean }[] = [];
    // Whatever ends this round, every call of the recorded turn gets a result, so the history
    // never holds an unmatched tool call (AI-037, decision D5).
    const closeTurn = () => {
      for (const c of reply.toolCalls) if (!results.some((r) => r.id === c.id)) results.push({ id: c.id, name: c.name, content: w.cancelled, isError: true });
      mutateHistory(tabId, (h) => [...h, { role: "tool", results }]);
    };
    try {
      for (const call of reply.toolCalls) {
        check();
        const input = call.input && typeof call.input === "object" ? call.input : {};
        const rowId = newId();
        const record: ToolCallRecord = { name: call.name, inputText: inputText(input), inputSummary: inputSummary(input), result: null, isError: false, started: Date.now(), finished: null };
        mutateMessages(tabId, (list) => [...list, message("tool", "", { id: rowId, call: record })]);
        publish({ busyPhase: w.running(call.name) });
        let result: string;
        let forModel = "";
        let isError = false;
        // The names the person's file carries, before and after the call (a tool may rename a node).
        const names = () => namesOf(tabById(tabId)?.document, tabById(tabId)?.title);
        const before = names();
        try {
          if (!tabById(tabId)) throw new Cancelled();
          // A run needs the person (./explain/guard.ts): not a name, a file or a Help text.
          const refusal = UNCONFIRMED_ACTIONS.has(call.name) ? actionRefusal(tabId, call.name, honoured) : null;
          if (refusal) {
            result = askFirst(call.name, refusal);
            if (refusal === "notAsked" && !asked.has(call.name)) {
              asked.add(call.name);
              mutateMessages(tabId, (list) => [...list, message("system", w.allowAsk(ACTION_LABEL[call.name] ?? call.name), { action: "allowAction", allow: call.name })]);
            }
          } else {
            if (UNCONFIRMED_ACTIONS.has(call.name)) honoured.count++;
            result = await executeTool(call.name, unguardInput(input, before), { tabId, editor: editorFor(tabId), cancelled: () => run.cancelled });
          }
        } catch (e) {
          if (e instanceof ToolCancelled || e instanceof Cancelled) throw new Cancelled();
          result = e instanceof Error ? e.message : String(e);
          isError = true;
        } finally {
          // What the model reads has every name between marks, an error's sentence too. The
          // transcript's row keeps the result as the tool wrote it: that is the person's view.
          if (typeof result! === "string") forModel = guardNames(result, [...new Set([...before, ...names()])]);
          // One tool call is one undo step, as one MainActor turn was in 0.90.34.
          // (A tab closed meanwhile has no editor, and asking for one would make it.)
          if (tabById(tabId)) editorFor(tabId).undoManager.closeGroup();
        }
        results.push({ id: call.id, name: call.name, content: forModel || result, isError });
        mutateMessages(tabId, (list) => list.map((m) => (m.id === rowId ? { ...m, call: { ...record, result, isError, finished: Date.now() } } : m)));
      }
    } finally {
      closeTurn();
    }
  }
  // Not a dead end: the history is whole, so Continue re-enters the loop for another ten rounds.
  mutateMessages(tabId, (list) => [...list, message("system", w.paused(MAX_TOOL_ITERATIONS), { action: "continueToolLoop" })]);
}

/** `finishStreamingMessages`: the caret stops, and a tool row still running reads "Cancelled.". */
function finishStreaming(tabId: string) {
  mutateMessages(tabId, (list) =>
    list.map((m) => {
      if (m.isStreaming) return { ...m, isStreaming: false };
      if (m.call && m.call.finished === null) return { ...m, call: { ...m.call, finished: Date.now(), isError: true, result: m.call.result ?? w.cancelled } };
      return m;
    }),
  );
}

function appendError(tabId: string, text: string) {
  mutateMessages(tabId, (list) => [...list, message("system", `⚠ ${text}`)]);
}

/** `startLoop`: everything the run produces goes to `tabId`, wherever the user is looking. */
function startLoop(tabId: string): Promise<void> {
  const run: NonNullable<typeof current> = { cancelled: false, abortRound: null, requestId: null };
  current = run;
  publish({ busyTabId: tabId, busyTabTitle: tabById(tabId)?.title ?? "", busyPhase: w.thinking });
  const done = (async () => {
    try {
      await runLoop(tabId, run);
    } catch (e) {
      if (e instanceof Cancelled) mutateMessages(tabId, (list) => [...list, message("system", w.stopped)]);
      else appendError(tabId, e instanceof Error ? e.message : String(e));
    } finally {
      if (current === run) current = null;
      finishStreaming(tabId);
      publish({ busyTabId: null, busyTabTitle: "", busyPhase: "" });
    }
  })();
  lastRun = done;
  return done;
}

let lastRun: Promise<void> = Promise.resolve();
/** Resolves when the request in flight (if any) has ended; for the tests and the export. */
export const whenIdle = () => lastRun;

/** `submit()`: sends the trimmed text for `tabId`; nothing while a request runs anywhere (AI-030). */
export function submit(tabId: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isBusy() || !tabById(tabId)) return false;
  mutate(tabId, (c) => ({ messages: [...c.messages, message("user", trimmed)], history: [...c.history, { role: "user", text: trimmed }] }));
  setDraft("");
  void startLoop(tabId);
  return true;
}

/** "Continue" after the loop paused: the row loses its button and the loop re-enters with the same history. */
export function continueToolLoop(tabId: string) {
  if (isBusy()) return;
  mutateMessages(tabId, (list) => list.map((m) => (m.action === "continueToolLoop" ? { ...m, action: null } : m)));
  void startLoop(tabId);
}

/** Stop: cancels the request in flight, whichever tab it belongs to. Partial streamed text stays. */
export function cancelRequest() {
  const run = current;
  if (!run || run.cancelled) return;
  run.cancelled = true;
  if (run.requestId) void api.aiCancel(run.requestId).catch(() => {});
  run.abortRound?.();
}

/** `clear()`: empties this tab's transcript and history; a request running for it is cancelled with it. */
export function clearConversation(tabId: string) {
  if (state.busyTabId === tabId) cancelRequest();
  conversations.delete(tabId);
  forgetFacts(tabId);
  forgetPlans(tabId);
  publish();
}

/** A system note in a tab's transcript ("⚠ Could not save the transcript: …"). */
export function noteError(tabId: string, text: string) {
  appendError(tabId, text);
}

/** The tab in front (`activeTabID`). */
export const frontTabId = () => activeTab(getWorkspace()).id;

/** For tests: no conversations, nothing running. */
export function resetAi() {
  if (current) current.cancelled = true;
  current?.abortRound?.();
  current = null;
  conversations.clear();
  forgetFacts();
  forgetPlans();
  draftText = "";
  lastRun = Promise.resolve();
  state = { busyTabId: null, busyTabTitle: "", busyPhase: "", version: state.version + 1 };
  listeners.forEach((l) => l());
}
