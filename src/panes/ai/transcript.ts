// The conversation as Markdown, for Copy Conversation and Save Transcript… (0.90.34
// AIPaneView.swift `transcriptMarkdown`, `copyConversation`, `saveTranscript`, `format(duration:)`;
// ledger §8.12 FILE-064, FILE-065, AI-082…084). The dialog plugin's save panel asks where, as the
// files area's and the Status log's do; Rust writes the file in one step.
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { timeString } from "../status/entries";
import { writeClipboard } from "../status/state";
import { conversationOf, noteError, type TranscriptMessage } from "./model";
import { aiWords as w } from "./words";

/** "N ms" under a second, else "N.N s" (`%.0f ms`, `%.1f s`). */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const durationOf = (m: TranscriptMessage): number | null => (m.call && m.call.finished !== null ? m.call.finished - m.call.started : null);

/** The hover caption: the time alone (`.formatted(date: .omitted, time: .standard)`). */
export const shortTime = (t: number) => timeString(t);

/** Date and time for tooltips and the export (`.formatted(date: .abbreviated, time: .standard)`: "Nov 11, 2026 at 3:04:05 PM"). */
export function fullTime(t: number): string {
  const d = new Date(t);
  const lang = new Intl.DateTimeFormat().resolvedOptions().locale;
  if (!lang.startsWith("en")) return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(d);
  return `${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d)} at ${timeString(t)}`;
}

/**
 * `text` in a code fence that it cannot close: the fence is one backtick longer than the longest
 * run of backticks in the text (at least three). A tool result that itself holds a fenced block
 * would otherwise end the fence early and the rest would read as headings and turns.
 */
export function fenced(text: string, language = ""): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** A heading per turn with its time; tool calls as a json-fenced input and a fenced result. */
export function transcriptMarkdown(messages: readonly TranscriptMessage[], now = Date.now()): string {
  let out = `${w.transcriptHeading}\n\n_Exported ${fullTime(now)}_\n\n`;
  for (const m of messages) {
    if (m.role === "user") out += `## You · ${fullTime(m.timestamp)}\n\n${m.text}\n\n`;
    else if (m.role === "assistant") {
      out += `## Assistant · ${fullTime(m.timestamp)}\n\n${m.text}\n\n`;
      // The export says what the pane marks: which numbers had no matching source.
      if (m.check?.flagged.length) out += `> _${w.checkExport(m.check.flagged.map((f) => f.text))}_\n\n`;
    }
    // Every line of a note stays inside the quote.
    else if (m.role === "system") out += `${m.text.split("\n").map((line) => `> _${line}_`).join("\n")}\n\n`;
    else if (m.call) {
      out += `### Tool: \`${m.call.name.replace(/`/g, "'")}\` · ${fullTime(m.timestamp)}`;
      const d = durationOf(m);
      if (d !== null) out += ` · ${formatDuration(d)}`;
      out += `\n\n**Input**\n\n${fenced(m.call.inputText, "json")}\n\n`;
      if (m.call.result !== null) out += `**${m.call.isError ? "Error" : "Result"}**\n\n${fenced(m.call.result)}\n\n`;
    }
  }
  return out;
}

/** Copy Conversation: the same Markdown, to the clipboard of the pane's window. */
export function copyConversation(tabId: string, win?: Window): Promise<void> {
  return writeClipboard(transcriptMarkdown(conversationOf(tabId).messages), win);
}

/** "Qnet AI transcript YYYY-MM-DD.md": the ISO-8601 date, which 0.90.34 took in GMT. */
export const transcriptFileName = (now = Date.now()) => w.transcriptFileName(new Date(now).toISOString().slice(0, 10));

/** Save Transcript…: asks where and writes the Markdown; a failure is a "⚠" line in the transcript. */
export async function saveTranscript(tabId: string): Promise<void> {
  const text = transcriptMarkdown(conversationOf(tabId).messages);
  const path = await save({ title: w.savePanelTitle, defaultPath: transcriptFileName(), filters: [{ name: w.markdown, extensions: ["md"] }], canCreateDirectories: true });
  if (!path) return;
  try {
    // The Status log's writer is the app's one "write this text to that path" command.
    await api.statusLogWrite(path, text);
  } catch (e) {
    noteError(tabId, w.couldNotSave(e instanceof Error ? e.message : String(e)));
  }
}
