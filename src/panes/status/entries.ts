// What a Status entry is and how it reads as text (0.90.34 StatusLog.swift `StatusEntry`): the
// severity a message's wording implies (ledger LOG-004), the time column and the copy/save line
// (LOG-009, LOG-021, FILE-047), and decoding a saved entry, including 0.90.34's old string form
// (LOG-002). Imports only types, so the workspace store may use it.
import type { Severity, StatusEntry } from "../../workspace/store";
import { statusWords } from "./words";

/**
 * The severity a message implies when its caller gives none (`StatusEntry.inferSeverity`), rule for
 * rule in 0.90.34's order: a leading ⚠; negations ("no warnings", "0 errors"…) are good news;
 * then the error wordings, the warning wordings and the success prefixes; else info.
 */
export function inferSeverity(text: string): Severity {
  const lower = text.toLowerCase();
  // .whitespaces: spaces and tabs, not newlines.
  const trimmed = lower.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
  if (trimmed.startsWith("⚠")) return lower.includes("failed") || lower.includes("aborted") ? "error" : "warning";
  const negations = ["no warnings", "0 warnings", "without warning", "no errors", "0 errors", "no error", "without error", "no failures", "0 failures"];
  if (negations.some((n) => lower.includes(n))) return "success";
  if (
    lower.includes(" aborted:") || lower.startsWith("error") || lower.includes(" failed") || lower.startsWith("failed") ||
    lower.includes("not found") || lower.startsWith("cannot ") || lower.includes("could not ") || lower.includes("invalid ")
  ) return "error";
  if (
    lower.includes("warning") || lower.includes("warn:") || lower.includes("cancelled") || lower.includes("canceled") ||
    lower.startsWith("banner will fire") || lower.startsWith("banner triggered") || lower.includes("unstable") ||
    lower.includes("caution") || lower.startsWith("nothing ") || lower.startsWith("no node matches") || lower.includes("skipping")
  ) return "warning";
  const successPrefixes = ["wrote", "updated", "aligned", "saved", "exported", "loaded", "straightened", "distributed", "displayed", "fit network", "pasted", "copied", "added ", "renamed", "found ", "undid"];
  if (successPrefixes.some((p) => trimmed.startsWith(p))) return "success";
  return "info";
}

let timeFormat: Intl.DateTimeFormat | null = null;

/** The time column: the locale's medium time style (`DateFormatter.timeStyle = .medium`). */
export function timeString(date: number): string {
  timeFormat ??= new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });
  return timeFormat.format(new Date(date));
}

/** For tests: forget the cached formatter (after changing the time zone or locale). */
export function resetTimeFormat() {
  timeFormat = null;
}

/** "[hh:mm:ss] text", or "[hh:mm:ss] [WARNING] text" for any other severity (`formattedLine`). */
export function formattedLine(e: StatusEntry): string {
  return e.severity === "info" ? `[${timeString(e.date)}] ${e.text}` : `[${timeString(e.date)}] [${statusWords.severity[e.severity].toUpperCase()}] ${e.text}`;
}

/** The text Copy puts on the clipboard: one line per entry. */
export function formattedLines(entries: StatusEntry[]): string {
  return entries.map(formattedLine).join("\n");
}

/** A saved status log file: the lines with a final newline (StatusLogExport.swift). */
export function statusLogFileText(entries: StatusEntry[]): string {
  return formattedLines(entries) + "\n";
}

/** A new entry, its severity inferred from the wording when none is given (`addStatus(_:)`). */
export function makeEntry(text: string, severity?: Severity, date = Date.now()): StatusEntry {
  return { id: crypto.randomUUID().toUpperCase(), date, severity: severity ?? inferSeverity(text), text };
}

const SEVERITIES: Severity[] = ["info", "success", "warning", "error"];

/**
 * A time of day as the medium time style writes it ("1:02:03 PM", "13:02:03"), as h/m/s, or null.
 * The legacy parser was a DateFormatter with that style; this reads the forms it produces for the
 * common locales (12- or 24-hour, an optional AM/PM marker).
 */
function parseMediumTime(stamp: string): [number, number, number] | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(stamp);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const marker = m[4]?.toLowerCase().replace(/\./g, "");
  if (marker) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (marker === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59 || s > 59) return null;
  return [h, min, s];
}

/**
 * A saved entry, read the way 0.90.34's Codable read one (ledger LOG-002): missing fields become a
 * new id, now, info and ""; a string is the old "[hh:mm:ss] text" form, migrated to today at that
 * time with its severity inferred (`init(legacy:)`). Dates are ms since the epoch (or ISO text).
 */
export function decodeStatusEntry(raw: unknown, now = Date.now()): StatusEntry {
  if (typeof raw === "string") {
    let text = raw;
    let date = now;
    const close = raw.indexOf("]");
    if (raw.startsWith("[") && close > 0) {
      const t = parseMediumTime(raw.slice(1, close));
      if (t) {
        const d = new Date(now);
        d.setHours(t[0], t[1], t[2], 0);
        date = d.getTime();
        text = raw.slice(close + 1).replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
      }
    }
    return makeEntry(text, inferSeverity(text), date);
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const date = typeof o.date === "number" && Number.isFinite(o.date) ? o.date : typeof o.date === "string" && !Number.isNaN(Date.parse(o.date)) ? Date.parse(o.date) : now;
  return {
    id: typeof o.id === "string" && o.id ? o.id : crypto.randomUUID().toUpperCase(),
    date,
    severity: SEVERITIES.includes(o.severity as Severity) ? (o.severity as Severity) : "info",
    text: typeof o.text === "string" ? o.text : "",
  };
}
