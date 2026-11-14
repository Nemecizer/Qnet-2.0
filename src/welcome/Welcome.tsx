// The Welcome view (new in 2.1, ledger UX-101…110): what a blank Untitled tab shows at launch
// instead of an empty canvas. Three ways to start, the recent files, and the bundled examples as
// a searchable gallery of real diagrams. `WelcomeHost` decides when it is on screen (./state.ts).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FilePlus2, FolderOpen, GraduationCap, Play, Search, X } from "lucide-react";
import { Icon } from "../components/Icon";
import { useActiveEditor, useEditorView } from "../editor";
import { getCommand, runCommand, useCommandList } from "../lib/commands";
import { getSetting, loadKv, setSettings, useSetting, useStateValue } from "../lib/kv";
import { modalOpen } from "../lib/overlays";
import { RECENTS_KEY, recentPaths } from "../workspace/files/recents";
import { baseName, dirName } from "../workspace/files/paths";
import { activeTab, isBlankTab, useWorkspace } from "../workspace/store";
import { useSessionReady } from "../workspace/tabs/session";
import { matchesFilter, matchesQuery } from "./describe";
import { loadExamples, type Example } from "./examples";
import { openFromWelcome, startEmpty, startOpen, startTandem } from "./starts";
import { closeWelcome, keepWelcome, SHOW_AT_LAUNCH_KEY, useWelcomeMode, welcomeVisible } from "./state";
import { Thumbnail } from "./Thumbnail";
import { welcomeWords as w, type ExampleFilter } from "./words";
import "./welcome.css";

/** The command the guided tour registers; the button shows only when it has. */
export const TOUR_COMMAND = "tour:start";

const FILTERS: readonly ExampleFilter[] = ["all", "tandem", "feedback", "closed", "multiclass", "finite"];

function Recents({ busy, open }: { busy: boolean; open: (path: string) => void }) {
  useStateValue<unknown>(RECENTS_KEY, null);
  const paths = recentPaths();
  return (
    <section className="qn-welcome-recent" aria-labelledby="qn-welcome-recent-h">
      <h2 id="qn-welcome-recent-h">{w.recentHeading}</h2>
      {paths.length === 0 ? (
        <div className="qn-welcome-empty" data-empty="recent">
          <strong>{w.recentEmptyTitle}</strong>
          <span>{w.recentEmpty}</span>
        </div>
      ) : (
        <ul className="qn-welcome-recent-list">
          {paths.map((p) => (
            <li key={p}>
              <button type="button" className="qn-welcome-recent-item" title={p} aria-label={w.recentOpen(baseName(p))} disabled={busy} onClick={() => open(p)}>
                <span className="qn-welcome-recent-name">{baseName(p)}</span>
                <span className="qn-welcome-recent-dir">{dirName(p)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How many cards share the first card's row (1 where layout can't be measured). */
function columnsOf(cards: HTMLElement[]): number {
  if (cards.length < 2) return 1;
  const top = cards[0].offsetTop;
  const n = cards.findIndex((c) => c.offsetTop !== top);
  return n > 0 ? n : 1;
}

function Gallery({ busy, open }: { busy: boolean; open: (path: string) => void }) {
  const [examples, setExamples] = useState<Example[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ExampleFilter>("all");
  const [current, setCurrent] = useState(0);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void loadExamples().then((list) => alive && setExamples(list));
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => (examples ?? []).filter((e) => matchesFilter(e.facts, filter) && matchesQuery(e.name, e.description, query)), [examples, filter, query]);
  const at = Math.min(current, Math.max(0, shown.length - 1));

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cards = [...(grid.current?.querySelectorAll<HTMLElement>("[data-example]") ?? [])];
    const i = cards.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const cols = columnsOf(cards);
    const next =
      e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowDown" ? i + cols : e.key === "ArrowUp" ? i - cols : e.key === "Home" ? 0 : e.key === "End" ? cards.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const to = Math.max(0, Math.min(cards.length - 1, next));
    setCurrent(to);
    cards[to].focus();
  };

  return (
    <section className="qn-welcome-examples" aria-labelledby="qn-welcome-examples-h">
      <div className="qn-welcome-examples-head">
        <h2 id="qn-welcome-examples-h">{w.examplesHeading}</h2>
        <span className="qn-welcome-count" aria-live="polite">
          {examples && examples.length > 0 ? w.shown(shown.length, examples.length) : ""}
        </span>
        <span className="qn-welcome-spacer" />
        <div className="qn-welcome-filters" role="group" aria-label={w.filterLabel}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className="qn-welcome-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {w.filters[f]}
            </button>
          ))}
        </div>
        <label className="qn-welcome-search">
          <Icon icon={Search} size={12} />
          <input
            type="search"
            value={query}
            placeholder={w.searchPlaceholder}
            aria-label={w.search}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </label>
      </div>
      {examples === null ? (
        <div className="qn-welcome-empty" data-empty="loading" aria-live="polite">
          <span>{w.examplesLoading}</span>
        </div>
      ) : examples.length === 0 ? (
        <div className="qn-welcome-empty" data-empty="examples">
          <strong>{w.examplesNoneTitle}</strong>
          <span>{w.examplesNone}</span>
        </div>
      ) : shown.length === 0 ? (
        <div className="qn-welcome-empty" data-empty="match">
          <strong>{w.examplesNoMatchTitle}</strong>
          <span>{w.examplesNoMatch}</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            {w.clearSearch}
          </button>
        </div>
      ) : (
        // Arrow keys walk the cards; Tab passes the grid in one stop.
        <div ref={grid} className="qn-welcome-grid" role="list" aria-label={w.examplesHeading} onKeyDown={onGridKey}>
          {shown.map((e, i) => (
            <div key={e.path} role="listitem" className="qn-welcome-cell">
              <button
                type="button"
                className="qn-welcome-card"
                data-example={e.name}
                tabIndex={i === at ? 0 : -1}
                aria-label={w.exampleOpen(e.name, e.description)}
                disabled={busy}
                onFocus={() => setCurrent(i)}
                onClick={() => open(e.path)}
              >
                <Thumbnail document={e.document} />
                <span className="qn-welcome-card-name">{e.name}</span>
                <span className="qn-welcome-card-text">{e.description}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function WelcomeView() {
  useCommandList();
  const showAtLaunch = useSetting<boolean>(SHOW_AT_LAUNCH_KEY, true) === true;
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Keyboard first: the view takes the focus when it appears, unless a dialog has it.
  useEffect(() => {
    if (!modalOpen()) first.current?.focus({ preventScroll: true });
  }, []);

  // What is underneath (the panes of a blank tab) is out of reach while the view covers it.
  // The layout element can be replaced while the view is up (a pane detached or docked again), so
  // the work area's children are watched and whichever layout is there is the one held.
  useEffect(() => {
    const area = root.current?.parentElement;
    if (!area) return;
    const layouts = () => area.querySelectorAll<HTMLElement>(":scope > .pane-layout");
    const hold = () => layouts().forEach((el) => el.hasAttribute("inert") || el.setAttribute("inert", ""));
    hold();
    const Observer = area.ownerDocument.defaultView?.MutationObserver;
    const watch = Observer ? new Observer(hold) : null;
    watch?.observe(area, { childList: true });
    return () => {
      watch?.disconnect();
      layouts().forEach((el) => el.removeAttribute("inert"));
    };
  }, []);

  const during = async (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const open = (path: string) => void during(() => openFromWelcome(path));
  const tour = getCommand(TOUR_COMMAND);

  return (
    <div
      ref={root}
      className="qn-welcome"
      role="region"
      aria-label={w.label}
      data-welcome
      onKeyDown={(e) => {
        if (e.key === "Escape" && !modalOpen()) {
          e.preventDefault();
          startEmpty();
        }
      }}
    >
      <div className="qn-welcome-scroll">
        <div className="qn-welcome-page">
          <header className="qn-welcome-head">
            <div>
              <h1>{w.title}</h1>
              <p>{w.lead}</p>
            </div>
            <button type="button" className="icon-btn qn-welcome-close" aria-label={w.close} title={w.closeHelp} onClick={startEmpty}>
              <Icon icon={X} size={16} />
            </button>
          </header>

          <div className="qn-welcome-top">
            <section className="qn-welcome-start" aria-labelledby="qn-welcome-start-h">
              <h2 id="qn-welcome-start-h">{w.startHeading}</h2>
              <button ref={first} type="button" className="qn-welcome-action primary" disabled={busy} onClick={() => void during(startTandem)}>
                <Icon icon={Play} size={20} />
                <span>
                  <strong>{w.tandem}</strong>
                  <small>{w.tandemHelp}</small>
                </span>
              </button>
              <button type="button" className="qn-welcome-action" disabled={busy} onClick={startEmpty}>
                <Icon icon={FilePlus2} size={20} />
                <span>
                  <strong>{w.empty}</strong>
                  <small>{w.emptyHelp}</small>
                </span>
              </button>
              <button type="button" className="qn-welcome-action" disabled={busy} onClick={startOpen}>
                <Icon icon={FolderOpen} size={20} />
                <span>
                  <strong>{w.open}</strong>
                  <small>{w.openHelp}</small>
                </span>
              </button>
              {tour && (
                <button
                  type="button"
                  className="qn-welcome-action"
                  data-welcome-tour
                  disabled={busy}
                  onClick={() => {
                    startEmpty();
                    void runCommand(TOUR_COMMAND);
                  }}
                >
                  <Icon icon={GraduationCap} size={20} />
                  <span>
                    <strong>{w.tour}</strong>
                    <small>{w.tourHelp}</small>
                  </span>
                </button>
              )}
            </section>
            <Recents busy={busy} open={open} />
          </div>

          <Gallery busy={busy} open={open} />

          <footer className="qn-welcome-foot">
            <label title={w.showAtLaunchHelp}>
              <input type="checkbox" checked={showAtLaunch} onChange={(e) => void setSettings({ [SHOW_AT_LAUNCH_KEY]: e.target.checked }).catch(() => {})} />
              {w.showAtLaunch}
            </label>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** Mounted once in the main window's work area; draws the view only while it applies. */
export function WelcomeHost() {
  const mode = useWelcomeMode();
  const sessionReady = useSessionReady();
  const [kvReady, setKvReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadKv()
      .catch(() => {})
      .then(() => alive && setKvReady(true));
    return () => {
      alive = false;
    };
  }, []);
  useSetting<boolean>(SHOW_AT_LAUNCH_KEY, true);
  const blank = useWorkspace((ws) => isBlankTab(activeTab(ws)));
  const editor = useActiveEditor();
  const tool = useEditorView(editor).tool;
  const ready = sessionReady && kvReady;
  const visible = welcomeVisible(ready, mode);

  // The tool in hand when the view appeared: picking another one is starting to draw.
  const toolAtShow = useRef<{ tab: string; tool: string } | null>(null);
  if (!visible) toolAtShow.current = null;
  else if (toolAtShow.current?.tab !== editor.tabId) toolAtShow.current = { tab: editor.tabId, tool };

  useEffect(() => {
    if (mode === "closed") return;
    if (mode === "launch" && !ready) return;
    // Shown at launch, it stays as if asked for: unticking "Show this at launch" is about next time.
    if (mode === "launch" && visible) {
      keepWelcome();
      return;
    }
    const drawing = toolAtShow.current !== null && toolAtShow.current.tool !== tool;
    // Once there is a network, or the launch setting is off, the view is done until asked for.
    if (!blank || drawing || (mode === "launch" && getSetting<boolean>(SHOW_AT_LAUNCH_KEY, true) !== true)) closeWelcome();
  }, [mode, ready, blank, tool, visible]);

  return visible ? <WelcomeView /> : null;
}
