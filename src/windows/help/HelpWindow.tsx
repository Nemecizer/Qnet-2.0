// The Qnet Help window (0.90.34 QnetHelpWindow.swift; ledger section 14.1): a sidebar of the
// topics in five groups with a search field over it, and the open topic typeset beside it under a
// breadcrumb bar that carries the match walker. An auxiliary window rendered from the main
// window's React tree (src/lib/auxWindow.tsx), 1040 × 704 at first and never smaller than
// 896 × 616; its frame is kept in state.json under 0.90.34's `WindowFrame.QnetHelpWindow`
// (HELP-001, SET-200). Its title is "Qnet Help" whatever the topic (HELP-020).
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Icon } from "../../components/Icon";
import { AuxWindow } from "../../lib/auxWindow";
import { getStateValue, useStateValue } from "../../lib/kv";
import { registerFocusTarget } from "../../workspace/focus";
import { auxTauriWindow, autosaveFrame } from "../../workspace/layout/frames";
import { parseRect } from "../../workspace/tabs/frame";
import { Article } from "./Article";
import { exampleMethodName, openHelpExample } from "./examples";
import { matchingBlocks } from "./markdown";
import { closeHelp, focusHelpSearch, HELP_WINDOW, LAST_TOPIC_KEY, matchCount, selectedTopic, selectTopic, setQuery, stepMatch, useHelpState } from "./state";
import { sectionIcon, sections, topic, topicBlocks, topicMatches, topicsIn, type HelpTopic } from "./topics";
import { helpWords as w } from "./words";
import "./help.css";

export const HELP_FRAME_KEY = "WindowFrame.QnetHelpWindow";
/** `DS.Layout.Window.auxWideContent` and `auxWideMin`. */
export const HELP_SIZE: [number, number] = [1040, 704];
export const HELP_MIN_SIZE: [number, number] = [896, 616];

function openExternal(url: string) {
  void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)).catch(() => {});
}

/** The window's contents. */
export function HelpView() {
  const state = useHelpState();
  // The stored topic can arrive after the window (state.json loads at launch).
  useStateValue<unknown>(LAST_TOPIC_KEY, null);
  const selected = selectedTopic();
  const current = topic(selected);
  const query = state.query.trim();
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const out: [string, HelpTopic[]][] = [];
    for (const s of sections()) {
      const topics = topicsIn(s).filter((t) => topicMatches(t, query));
      if (topics.length) out.push([s, topics]);
    }
    return out;
  }, [query]);
  const visible = groups.flatMap(([, t]) => t);

  const blocks = topicBlocks(selected);
  const matches = useMemo(() => matchingBlocks(blocks, query), [blocks, query]);
  const cursor = matches.length ? Math.min(state.matchIndex, matches.length - 1) : 0;
  const currentBlock = matches.length ? matches[cursor] : null;

  const focusSearch = () => {
    const input = searchRef.current;
    input?.ownerDocument.defaultView?.focus();
    input?.focus();
    input?.select();
  };
  useEffect(() => {
    if (state.focusRequest) focusSearch();
  }, [state.focusRequest]);

  // Edit ▸ Search Help… (⌘F), Find Next / Previous (⌘G / ⇧⌘G) while this window has the keys.
  useEffect(
    () =>
      registerFocusTarget(`window:${HELP_WINDOW}`, {
        findTitle: w.findTitle,
        find: focusHelpSearch,
        stepFind: stepMatch,
        canStepFind: () => matchCount() > 0,
      }),
    [],
  );

  // A new topic starts at its top; with a search active, the match under the cursor is brought to
  // the middle of the page. Clearing the search leaves the page where it was (HELP-013).
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [selected]);
  useEffect(() => {
    if (currentBlock === null) return;
    scrollRef.current?.querySelector(`[data-block="${currentBlock}"]`)?.scrollIntoView({ block: "center" });
  }, [selected, query, currentBlock]);

  const move = (delta: 1 | -1) => {
    if (!visible.length) return;
    const at = visible.findIndex((t) => t.id === selected);
    const next = visible[Math.max(0, Math.min(visible.length - 1, at < 0 ? 0 : at + delta))];
    selectTopic(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-help-topic="${next.id}"]`)?.focus();
  };

  return (
    <div
      className="help"
      onKeyDown={(e) => {
        // Escape anywhere in the window clears the search (HELP-008); with none, it closes the window.
        if (e.key === "Escape" && state.query && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          setQuery("");
        }
      }}
    >
      <nav className="help-sidebar" aria-label={w.windowTitle}>
        <div className="help-search" title={w.searchTip}>
          <Icon icon={Search} size={12} />
          <input
            ref={searchRef}
            type="search"
            aria-label={w.searchLabel}
            aria-description={w.searchHelp}
            placeholder={w.searchPlaceholder}
            value={state.query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stepMatch(e.shiftKey ? -1 : 1);
              }
            }}
          />
          {state.query ? (
            <button type="button" className="help-icon-btn" aria-label={w.clearSearch} title={w.clearSearch} onClick={() => setQuery("")}>
              <Icon icon={X} size={12} />
            </button>
          ) : (
            <kbd className="help-search-hint">{w.searchShortcutHint}</kbd>
          )}
        </div>
        <div
          className="help-list"
          ref={listRef}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          {groups.map(([section, topics]) => (
            <div key={section} className="help-group" role="group" aria-label={section}>
              <div className="help-group-head">
                <Icon icon={sectionIcon(section)} size={12} />
                {section}
              </div>
              {topics.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  id={`help.topic.${t.id}`}
                  data-help-topic={t.id}
                  className={t.id === selected ? "help-topic selected" : "help-topic"}
                  aria-current={t.id === selected ? "page" : undefined}
                  aria-label={t.title}
                  onClick={() => selectTopic(t.id)}
                >
                  <span className="help-topic-title">{t.title}</span>
                  {t.subtitle && <span className="help-topic-sub">{t.subtitle}</span>}
                </button>
              ))}
            </div>
          ))}
          {!groups.length && (
            <div className="help-empty empty-state">
              <Icon icon={Search} size={20} />
              <h2>{w.emptyTitle(query)}</h2>
              <p>{w.emptyMessage}</p>
            </div>
          )}
        </div>
        {query && (
          <div className="help-match-summary" role="status">
            {w.matchSummary(visible.length)}
          </div>
        )}
      </nav>
      <section className="help-detail" aria-label={current?.windowTitle ?? w.windowTitle}>
        <div className="help-crumb">
          {current && (
            <>
              <span className="help-crumb-group">
                <Icon icon={sectionIcon(current.section)} size={12} />
                {current.section}
              </span>
              {current.subtitle && (
                <>
                  <span className="help-crumb-dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="help-crumb-sub">{current.subtitle}</span>
                </>
              )}
            </>
          )}
          <span className="spacer" />
          {matches.length > 0 && (
            <span className="help-walker">
              <span className="help-walker-count" aria-label={w.matchLabel(cursor + 1, matches.length)}>
                {w.matchOf(cursor + 1, matches.length)}
              </span>
              <button type="button" className="help-icon-btn" aria-label={w.findPrevious} title={w.findPreviousHelp} onClick={() => stepMatch(-1)}>
                <Icon icon={ChevronUp} size={14} />
              </button>
              <button type="button" className="help-icon-btn" aria-label={w.findNext} title={w.findNextHelp} onClick={() => stepMatch(1)}>
                <Icon icon={ChevronDown} size={14} />
              </button>
            </span>
          )}
        </div>
        <div className="help-scroll" ref={scrollRef} tabIndex={-1}>
          {blocks.length ? (
            <Article blocks={blocks} query={query} currentBlock={currentBlock} onTopic={selectTopic} onExternal={openExternal} onExample={(name, run) => void openHelpExample(name, run)} methodName={exampleMethodName} />
          ) : (
            <p className="help-missing">{w.missingText}</p>
          )}
        </div>
      </section>
    </div>
  );
}

/** The size the window opens at: the saved frame's, else 0.90.34's default. */
function savedSize(): [number, number] {
  const f = parseRect(getStateValue<unknown>(HELP_FRAME_KEY, null));
  if (f && f.w > 200 && f.h > 200) return [Math.max(HELP_MIN_SIZE[0], Math.round(f.w)), Math.max(HELP_MIN_SIZE[1], Math.round(f.h))];
  return HELP_SIZE;
}

/** Mounts the Help window while it is open. */
export function HelpHost() {
  const state = useHelpState();
  const stopFrame = useRef<(() => void) | null>(null);
  const alive = useRef<Window | null>(null);
  if (!state.open) return null;
  const close = () => {
    stopFrame.current?.();
    stopFrame.current = null;
    alive.current = null;
    closeHelp();
  };
  return (
    <AuxWindow
      name={HELP_WINDOW}
      title={w.windowTitle}
      size={savedSize()}
      minSize={HELP_MIN_SIZE}
      onOpen={(win) => {
        alive.current = win;
        void auxTauriWindow(HELP_WINDOW).then((tw) => {
          if (tw && alive.current === win) stopFrame.current = autosaveFrame(tw, HELP_FRAME_KEY);
        });
      }}
      onClose={close}
    >
      <HelpView />
    </AuxWindow>
  );
}
