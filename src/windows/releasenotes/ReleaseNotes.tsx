// Help ▸ Release Notes, and About's Release Notes link (0.90.34 ReleaseNotesWindow.swift; ledger
// ABOUT-011…018, SET-203): one window, 816 × 640 at first and never smaller than 720 × 560, its
// frame kept under 0.90.34's `WindowFrame.QnetReleaseNotesWindow`. A fixed bar over the page
// counts the releases and carries Expand All / Collapse All and Copy; the running build's entry
// is open at the top and every earlier release is a closed disclosure.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronRight, Copy, History, TriangleAlert } from "lucide-react";
import { Icon } from "../../components/Icon";
import { api } from "../../lib/api";
import { AuxWindow, raiseAuxWindow } from "../../lib/auxWindow";
import { getStateValue } from "../../lib/kv";
import { writeClipboard } from "../../panes/status/state";
import type { AboutInfo, AppInfo } from "../../lib/types";
import { auxTauriWindow, autosaveFrame } from "../../workspace/layout/frames";
import { parseRect } from "../../workspace/tabs/frame";
import { humanReadable, stampHumanReadable, stampText } from "../about/words";
import { CHANGELOG, topEntryIsLive, type ChangelogEntry } from "./changelog";
import { releaseNotesWords as w } from "./words";
import "./releasenotes.css";

export const RELEASE_NOTES_WINDOW = "release-notes";
export const RELEASE_NOTES_FRAME_KEY = "WindowFrame.QnetReleaseNotesWindow";
/** `DS.Layout.Window.auxContent` and `auxMin`. */
export const RELEASE_NOTES_SIZE: [number, number] = [816, 640];
export const RELEASE_NOTES_MIN_SIZE: [number, number] = [720, 560];

let open = false;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

/** Opens Release Notes, or brings the window forward. */
export function openReleaseNotes() {
  if (open) {
    raiseAuxWindow(RELEASE_NOTES_WINDOW);
    return;
  }
  open = true;
  publish();
}

export function closeReleaseNotes() {
  if (!open) return;
  open = false;
  publish();
}

export const releaseNotesOpen = () => open;

/** For tests. */
export function resetReleaseNotesWindow() {
  open = false;
  publish();
}

/** The running build, as an entry with `timestamp: null` shows it (ABOUT-014). */
export interface RunningBuild {
  version: string;
  /** When it was built, if known. */
  built: Date | null;
}

/** The version an entry shows: the running build's for the live entry. */
export const shownVersion = (e: ChangelogEntry, app: RunningBuild) => (e.timestamp === null ? app.version : e.version);

/** The date an entry shows: "12 May 2026, 06:06", or "" for the live entry of a build whose time is unknown. */
export function shownDate(e: ChangelogEntry, app: RunningBuild): string {
  if (e.timestamp !== null) return stampHumanReadable(e.timestamp);
  return app.built ? humanReadable(app.built) : "";
}

const shownStamp = (e: ChangelogEntry, app: RunningBuild) => e.timestamp ?? (app.built ? stampText(app.built) : "");

/** What Copy puts on the clipboard: the heading line, a blank line, then "• note" lines (`plainText(entry:)`, ABOUT-015). */
export function entryPlainText(e: ChangelogEntry, app: RunningBuild): string {
  const version = shownVersion(e, app);
  const stamp = shownStamp(e, app);
  const head = stamp ? `Qnet ${version} — ${shownDate(e, app)} (build ${version}.${stamp})` : `Qnet ${version}`;
  return `${head}\n\n${e.notes.map((n) => `• ${n}\n`).join("")}`;
}

function Notes({ notes }: { notes: string[] }) {
  return (
    <ul className="rn-notes">
      {notes.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}

/** The window's contents; `entries` is the changelog (tests pass their own). */
export function ReleaseNotesView({ entries = CHANGELOG }: { entries?: ChangelogEntry[] }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.appInfo().then((i) => alive && setInfo(i), () => {});
    api.aboutInfo().then((a) => alive && setAbout(a), () => {});
    return () => {
      alive = false;
      clearTimeout(timer.current);
    };
  }, []);
  const app: RunningBuild = { version: info?.version ?? "", built: about?.builtMs ? new Date(about.builtMs) : null };
  const shipped = entries.slice(1).map((_, i) => i + 1);
  const allExpanded = shipped.length > 0 && shipped.every((i) => expanded.has(i));
  const top = entries[0];

  // The clipboard of the window the button is in: the main window's refuses while this one is key.
  const copy = async (win: Window) => {
    if (!top) return;
    try {
      await writeClipboard(entryPlainText(top, app), win);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), w.copiedFor);
  };
  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="rn">
      <div className="rn-bar">
        <span className="rn-count" aria-label={w.releasesLabel(entries.length)}>
          <Icon icon={History} size={12} />
          {w.releases(entries.length)}
        </span>
        {shipped.length > 0 && (
          <button
            type="button"
            className="rn-link"
            title={allExpanded ? w.collapseAllHelp : w.expandAllHelp}
            aria-label={allExpanded ? w.collapseAllLabel : w.expandAllLabel}
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(shipped))}
          >
            {allExpanded ? w.collapseAll : w.expandAll}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn rn-copy" title={w.copyHelp} aria-label={copied ? w.copiedLabel : w.copyLabel} onClick={(e) => void copy(e.currentTarget.ownerDocument.defaultView ?? window)}>
          <Icon icon={copied ? Check : Copy} size={12} />
          {copied ? w.copied : w.copy}
        </button>
      </div>
      <div className="rn-scroll">
        <div className="rn-page">
          <header className="rn-header">
            <h1>{w.heading}</h1>
            <p>{w.appLine(app.version)}</p>
          </header>
          {info?.instance === "dev" && !topEntryIsLive(entries) && (
            <p className="rn-warning" role="note">
              <Icon icon={TriangleAlert} size={14} />
              <span>{w.frozenTop(`${app.version}${app.built ? `.${stampText(app.built)}` : ""}`)}</span>
            </p>
          )}
          {entries.map((e, i) => {
            const version = shownVersion(e, app);
            const date = shownDate(e, app);
            if (i === 0) {
              const live = e.timestamp === null;
              return (
                <section key={i} className="rn-entry current" aria-label={w.version(version)}>
                  <div className="rn-entry-head">
                    <h2>{w.version(version)}</h2>
                    <span className="rn-badge" aria-label={live ? w.inDevelopment : w.currentLabel}>
                      {live ? w.inDevelopment : w.current}
                    </span>
                  </div>
                  {date && (
                    <p className="rn-date" title={w.buildTip(version, shownStamp(e, app))}>
                      {date}
                    </p>
                  )}
                  <Notes notes={e.notes} />
                </section>
              );
            }
            const isOpen = expanded.has(i);
            return (
              <section key={i} className="rn-entry">
                <button type="button" className="rn-disclosure" aria-expanded={isOpen} aria-label={w.collapsedLabel(e.version, date)} onClick={() => toggle(i)}>
                  <Icon icon={isOpen ? ChevronDown : ChevronRight} size={12} />
                  <span className="rn-disclosure-version">{w.version(e.version)}</span>
                  <span className="rn-disclosure-dash" aria-hidden="true">
                    —
                  </span>
                  <span className="rn-disclosure-date">{date}</span>
                </button>
                {isOpen && <Notes notes={e.notes} />}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function savedSize(): [number, number] {
  const f = parseRect(getStateValue<unknown>(RELEASE_NOTES_FRAME_KEY, null));
  if (f && f.w > 200 && f.h > 200) return [Math.max(RELEASE_NOTES_MIN_SIZE[0], Math.round(f.w)), Math.max(RELEASE_NOTES_MIN_SIZE[1], Math.round(f.h))];
  return RELEASE_NOTES_SIZE;
}

/** Mounts the Release Notes window while it is open. */
export function ReleaseNotesHost() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
  const stop = useRef<(() => void) | null>(null);
  const current = useRef<Window | null>(null);
  if (!open) return null;
  const close = () => {
    stop.current?.();
    stop.current = null;
    current.current = null;
    closeReleaseNotes();
  };
  return (
    <AuxWindow
      name={RELEASE_NOTES_WINDOW}
      title={w.windowTitle}
      size={savedSize()}
      minSize={RELEASE_NOTES_MIN_SIZE}
      onOpen={(win) => {
        current.current = win;
        void auxTauriWindow(RELEASE_NOTES_WINDOW).then((tw) => {
          if (tw && current.current === win) stop.current = autosaveFrame(tw, RELEASE_NOTES_FRAME_KEY);
        });
      }}
      onClose={close}
    >
      <ReleaseNotesView />
    </AuxWindow>
  );
}
