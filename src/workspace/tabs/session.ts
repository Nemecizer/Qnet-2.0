// Session restore and quit (0.90.34 TabPersistence.swift, QnetGUIApp.swift `init` and
// `applicationShouldTerminate`; ledger 5.10, FILE-054, FILE-055).
//
// While the app runs, a snapshot of every tab goes to the session file 400 ms after any change
// (src-tauri/src/session.rs). The snapshot is 0.90.34's `PersistedTabState` object itself, field for
// field (file URLs as `file://` strings, log dates in Foundation's reference-date seconds), so a
// 0.90.34 snapshot reads as one of ours. At launch the tabs come back from it, with their ids, and
// failing that from the legacy list of open files, `tabs.currentURLs`. Quit asks whether to keep it.
import { saveShellTranscript } from "../../panes/shell/commands";
import { useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import type { BnetDocument } from "../../lib/bnet";
import { ask } from "../../lib/dialogs";
import { getSetting, getStateValue, loadKv, setSettings, setStateValues } from "../../lib/kv";
import { getWorkspace, onWorkspaceChange, replaceWorkspace, type Severity, type StatusEntry, type Tab, type Workspace } from "../store";
import { inferSeverity } from "../../panes/status/entries";
import { noteAppTerminating } from "../panes/hosts";
import { tabWords } from "./words";

/** 0.90.34 `TabPersistence.debounceMS`. */
export const SAVE_DEBOUNCE_MS = 400;
/** The legacy list of open files (0.90.34 `persistCurrentTabURLs`, WS-130), in state.json. */
export const URLS_KEY = "tabs.currentURLs";
/** Settings ▸ General: 0 Ask, 1 Always restore, 2 Never (WS-133). */
export const RESTORE_KEY = "tabs.restoreBehavior";

// --- The snapshot's shape (0.90.34 `PersistedTabState`, `StatusEntry`).

export interface PersistedEntry {
  id: string;
  title: string;
  document: BnetDocument;
  userFileURL?: string | null;
  /** 0.90.34's pre-structured log: "[h:mm:ss AM] text" strings (FILE-055). */
  statusMessages?: string[] | null;
  statusLog?: { id?: string; date?: number; severity?: string; text?: string }[] | null;
}

export interface PersistedTabState {
  entries: PersistedEntry[];
  activeTabID?: string | null;
}

/** Seconds from 1970 to Foundation's reference date, 2001-01-01: Swift's default `Date` coding. */
const REFERENCE_DATE_S = 978307200;

export const toSwiftDate = (ms: number) => ms / 1000 - REFERENCE_DATE_S;
export const fromSwiftDate = (s: number) => Math.round((s + REFERENCE_DATE_S) * 1000);

/** "/Users/a/My Nets/x.bnet" → "file:///Users/a/My%20Nets/x.bnet" (what `URL.absoluteString` gave). */
export function pathToFileUrl(path: string): string {
  return "file://" + path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/** The path of a `file://` URL string; null for anything else. */
export function fileUrlToPath(url: string): string | null {
  if (!url.startsWith("file://")) return url.startsWith("/") ? url : null;
  let rest = url.slice("file://".length);
  if (rest.startsWith("localhost/")) rest = rest.slice("localhost".length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** The session as stored: every tab in bar order, and the active one (WS-127). */
export function snapshot(ws: Workspace = getWorkspace()): PersistedTabState {
  return {
    activeTabID: ws.activeId,
    entries: ws.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      document: t.document,
      userFileURL: t.path === null ? null : pathToFileUrl(t.path),
      statusLog: t.log.map((e) => ({ id: e.id, date: toSwiftDate(e.date), severity: e.severity, text: e.text })),
    })),
  };
}

// --- 0.90.34 `StatusEntry.init(legacy:)` and `inferSeverity`, for a snapshot that has only strings.

/** 0.90.34 `StatusEntry.inferSeverity`: one copy, in src/panes/status/entries.ts. */
export { inferSeverity } from "../../panes/status/entries";

/** "[2:05:09 PM] Saved…": the time parsed back onto today when it reads as one, else now. */
export function legacyEntry(line: string, now = new Date()): StatusEntry {
  let text = line;
  let date = now.getTime();
  const m = /^\[([^\]]*)\]/.exec(line);
  if (m) {
    const t = /^(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AaPp])\.?\s*[Mm]\.?)?$/.exec(m[1].trim());
    if (t) {
      let h = Number(t[1]);
      if (t[4]) h = (h % 12) + (/[Pp]/.test(t[4]) ? 12 : 0);
      const d = new Date(now);
      d.setHours(h, Number(t[2]), Number(t[3]), 0);
      date = d.getTime();
      text = line.slice(m[0].length).trim();
    }
  }
  return { id: crypto.randomUUID().toUpperCase(), date, severity: inferSeverity(text), text };
}

const SEVERITIES: Severity[] = ["info", "success", "warning", "error"];

/** The short date and short time, as `DateFormatter.localizedString(dateStyle: .short, timeStyle: .short)`. */
export function shortDateTime(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(d);
}

/** A stored snapshot as tabs, or null when it is missing, empty or not one (WS-140: ignored). */
export function tabsFromSnapshot(raw: unknown, now = new Date()): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as PersistedTabState;
  if (!Array.isArray(s.entries) || !s.entries.length) return null;
  const tabs: Tab[] = [];
  const seen = new Set<string>();
  for (const e of s.entries) {
    if (!e || typeof e.id !== "string" || seen.has(e.id) || !e.document || !Array.isArray(e.document.nodes) || !Array.isArray(e.document.links)) return null;
    seen.add(e.id);
    const saved: StatusEntry[] = Array.isArray(e.statusLog)
      ? e.statusLog.map((x) => ({
          id: typeof x.id === "string" ? x.id : crypto.randomUUID().toUpperCase(),
          date: typeof x.date === "number" ? fromSwiftDate(x.date) : now.getTime(),
          severity: SEVERITIES.includes(x.severity as Severity) ? (x.severity as Severity) : "info",
          text: typeof x.text === "string" ? x.text : "",
        }))
      : Array.isArray(e.statusMessages)
        ? e.statusMessages.filter((x) => typeof x === "string").map((x) => legacyEntry(x, now))
        : [];
    // WS-137: a restored log gets a session boundary.
    const log = saved.length ? [...saved, { id: crypto.randomUUID().toUpperCase(), date: now.getTime(), severity: "info" as const, text: tabWords.newSession(shortDateTime(now)) }] : [];
    const document: BnetDocument = {
      ...e.document,
      infiniteBuffers: !!e.document.infiniteBuffers,
      canvasScale: typeof e.document.canvasScale === "number" ? e.document.canvasScale : 1,
      canvasPanOffset: Array.isArray(e.document.canvasPanOffset) ? e.document.canvasPanOffset : [0, 0],
    };
    const path = typeof e.userFileURL === "string" ? fileUrlToPath(e.userFileURL) : null;
    // WS-138: every restored tab is clean.
    tabs.push({ id: e.id, title: typeof e.title === "string" ? e.title : tabWords.untitled, path, document, revision: 0, savedRevision: 0, log });
  }
  const activeId = typeof s.activeTabID === "string" && seen.has(s.activeTabID) ? s.activeTabID : tabs[0].id;
  return { tabs, activeId };
}

/** The legacy fallback (WS-136): the files in `tabs.currentURLs` that can still be read, as tabs. */
export async function tabsFromUrlList(urls: unknown): Promise<Workspace | null> {
  if (!Array.isArray(urls)) return null;
  const tabs: Tab[] = [];
  for (const u of urls) {
    const path = typeof u === "string" ? fileUrlToPath(u) : null;
    if (!path) continue;
    try {
      const opened = await api.documentRead(path);
      const document = JSON.parse(opened.text) as BnetDocument;
      tabs.push({ id: crypto.randomUUID().toUpperCase(), title: baseName(path), path: opened.path ?? path, document, revision: 0, savedRevision: 0, log: [] });
    } catch {
      // A missing or unreadable file is skipped.
    }
  }
  return tabs.length ? { tabs, activeId: tabs[0].id } : null;
}

// --- Saving while the app runs.

/** Whether a change is one 0.90.34 saved on (WS-128): tabs added, removed, reordered or switched, or
 *  any tab's document (nodes, links, zoom, pan, buffers), file, title or log. Not the unsaved mark. */
export function changesSnapshot(next: Workspace, prev: Workspace): boolean {
  if (next.activeId !== prev.activeId || next.tabs.length !== prev.tabs.length) return true;
  return next.tabs.some((t, i) => {
    const p = prev.tabs[i];
    return t.id !== p.id || t.document !== p.document || t.path !== p.path || t.title !== p.title || t.log !== p.log;
  });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let lastUrls: string | null = null;

function cancelPendingSave() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/** Writes the snapshot now (Quit with Restore, and the debounced save's end). */
export async function saveNow(): Promise<void> {
  cancelPendingSave();
  await api.sessionSave(snapshot()).catch(() => {});
}

/** 0.90.34 `scheduleSave`: one save 400 ms after the last change. */
export function scheduleSave() {
  if (stopped) return;
  cancelPendingSave();
  timer = setTimeout(() => {
    timer = null;
    if (!stopped) void api.sessionSave(snapshot()).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

/** Keeps `tabs.currentURLs` (WS-130) as the files of the open tabs, in bar order. */
function noteUrls(ws: Workspace) {
  const urls = ws.tabs.filter((t) => t.path !== null).map((t) => pathToFileUrl(t.path as string));
  const json = JSON.stringify(urls);
  if (json === lastUrls) return;
  lastUrls = json;
  void setStateValues({ [URLS_KEY]: urls }).catch(() => {});
}

/** 0.90.34 `clearTabsForRestore`: no pending save, no snapshot, no URL list. */
export async function clearForRestore(): Promise<void> {
  cancelPendingSave();
  stopped = true;
  await Promise.all([api.sessionClear().catch(() => {}), setStateValues({ [URLS_KEY]: null }).catch(() => {})]);
}

/** Follows the workspace from now on; returns a function that stops. */
export function startAutosave(): () => void {
  stopped = false;
  lastUrls = JSON.stringify(getStateValue<unknown>(URLS_KEY, []));
  const off = onWorkspaceChange((next, prev) => {
    if (stopped) return;
    if (changesSnapshot(next, prev)) scheduleSave();
    noteUrls(next);
  });
  return () => {
    off();
    cancelPendingSave();
  };
}

// --- Launch.

let restored: Promise<void> | null = null;
let ready = false;
const readyListeners = new Set<() => void>();

export function sessionReady(): boolean {
  return ready;
}

export function onSessionReady(l: () => void): () => void {
  readyListeners.add(l);
  return () => readyListeners.delete(l);
}

/** Whether the launch restore has finished (the tab bar and title wait for it, so no "Untitled" flashes). */
export function useSessionReady(): boolean {
  return useSyncExternalStore(onSessionReady, sessionReady);
}

function markReady() {
  ready = true;
  readyListeners.forEach((l) => l());
}

/**
 * WS-136: the tabs of the last session (ids, titles, documents, files, logs, the active tab);
 * failing that, the files in `tabs.currentURLs`; failing that, the one Untitled tab already open.
 * Runs once; then saving starts.
 */
export function restoreSession(): Promise<void> {
  if (restored) return restored;
  restored = (async () => {
    try {
      const ws = tabsFromSnapshot(await api.sessionGet().catch(() => null));
      if (ws) replaceWorkspace(ws);
      else {
        await loadKv().catch(() => {});
        const fromUrls = await tabsFromUrlList(getStateValue<unknown>(URLS_KEY, null));
        if (fromUrls) replaceWorkspace(fromUrls);
      }
    } finally {
      markReady();
    }
  })();
  return restored;
}

// --- Quit (0.90.34 `applicationShouldTerminate`, MENU-007, WS-131…135).

/** Some tab has nodes or links: only then is there anything to ask about (WS-132). */
export function hasRestorableContent(ws: Workspace = getWorkspace()): boolean {
  return ws.tabs.some((t) => t.document.nodes.length > 0 || t.document.links.length > 0);
}

let quitting: Promise<void> | null = null;

/**
 * Quit: with nothing to restore, the snapshot is cleared; otherwise `tabs.restoreBehavior` decides
 * (Always saves now, Never clears, Ask asks, and "Do not ask again" stores the answer). Unsaved
 * changes are never asked about (WS-135). Then the app exits. `beforeAsk` runs before the prompt
 * (the main window is shown again if it was closed). The Shell's transcript is saved too (WS-131).
 */
export function quit(opts: { beforeAsk?: () => Promise<unknown> | void } = {}): Promise<void> {
  if (quitting) return quitting;
  quitting = (async () => {
    try {
      // A quit that arrives while the launch is still restoring (the Dock, logout) waits for it:
      // otherwise the blank first tab would look like "nothing to restore" and clear the saved
      // session. It never starts one itself. The restore always settles; the settings are needed
      // for tabs.restoreBehavior.
      if (restored) await restored;
      await loadKv().catch(() => {});
      if (!hasRestorableContent()) {
        await clearForRestore();
      } else {
        const behaviour = getSetting<number>(RESTORE_KEY, 0);
        if (behaviour === 1) {
          stopped = true;
          await saveNow();
        } else if (behaviour === 2) {
          await clearForRestore();
        } else {
          await opts.beforeAsk?.();
          const answer = await ask({
            title: tabWords.restoreTitle,
            message: tabWords.restoreMessage,
            confirmTitle: tabWords.restoreConfirm,
            cancelTitle: tabWords.restoreCancel,
            suppressionTitle: tabWords.restoreSuppress,
          });
          if (answer.confirmed) {
            stopped = true;
            await saveNow();
          } else {
            await clearForRestore();
          }
          if (answer.suppress) await setSettings({ [RESTORE_KEY]: answer.confirmed ? 1 : 2 }).catch(() => {});
        }
      }
      // The Shell's transcript is saved whatever the restore answer (WS-131); it waits at most 0.5 s.
      await saveShellTranscript().catch(() => {});
      // Detached panes stay detached for the next launch: their windows close with the app (WS-093).
      noteAppTerminating();
      await api.appExit();
    } catch {
      // The exit was refused (it never is in practice): keep saving the session, so nothing is lost.
      stopped = false;
    } finally {
      quitting = null;
    }
  })();
  return quitting;
}

/** For tests: back to before launch. */
export function resetSession() {
  cancelPendingSave();
  stopped = false;
  lastUrls = null;
  restored = null;
  ready = false;
  quitting = null;
}
