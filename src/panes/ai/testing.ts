// Scripted provider turns for the assistant's tests (src/dev/mock/ai.ts `mockAi.script`).
import type { AiEvent } from "../../lib/types";

let callSeq = 0;
/** One tool call the model makes. */
export const call = (name: string, input: Record<string, unknown> = {}, id = `call_${++callSeq}`): AiEvent => ({ kind: "toolCall", call: { id, name, input } });
/** A turn that asks for tools: optional text, the calls, then `done`. */
export const toolTurn = (...events: (AiEvent | string)[]): AiEvent[] => [...events.map((e): AiEvent => (typeof e === "string" ? { kind: "text", delta: e } : e)), { kind: "done", stopReason: "toolUse" }];
/** A final answer, streamed in the given pieces. */
export const textTurn = (...deltas: string[]): AiEvent[] => [...deltas.map((delta): AiEvent => ({ kind: "text", delta })), { kind: "done", stopReason: "end" }];
export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
