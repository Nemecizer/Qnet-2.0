// The Status pane: the active tab's log under a header with its count and controls, the flag bar,
// the severity filter and search, and the list (0.90.34 StatusLog.swift `StatusPanelView`,
// `StatusListView`, `StatusRow`; ledger LOG-001, LOG-009…027). The same component is docked or
// detached (an auxiliary window renders it into another document), so it reaches its document and
// window only through its own elements.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AArrowDown, AArrowUp, CircleCheck, Info, OctagonX, Search, Share, TextAlignStart, Trash2, TriangleAlert, X } from "lucide-react";
import { Icon } from "../../components/Icon";
import { setSettings, useSetting } from "../../lib/kv";
import { useFocusTarget } from "../../workspace/focus";
import { PaneHeader } from "../../workspace/panes/PaneHeader";
import { useActiveTab, type Severity, type StatusEntry } from "../../workspace/store";
import { statusAction, useStatusActions, type StatusAction } from "./actions";
import { formattedLines, timeString } from "./entries";
import { saveStatusLog } from "./exportLog";
import { FlagBar } from "./FlagBar";
import { Menu, type MenuItem } from "./popup";
import { clearStatusLog, copyEntries, isFiltering, paneState, query, setPaneState, undoClearStatusLog, usePaneState, visibleEntries, type Filter } from "./state";
import { statusWords as w } from "./words";
import "./status.css";

export const FONT_KEY = "status.fontSize";
export const FONT_MIN = 8;
export const FONT_MAX = 28;
export const FONT_DEFAULT = 12;
/** Below this filter-row width the "k of n" readout is left out (`DS.Layout.matchCountMinRowWidth`). */
const MATCH_COUNT_MIN_ROW_WIDTH = 320;

const SEVERITY_ICON: Record<Severity, LucideIcon> = { info: Info, success: CircleCheck, warning: TriangleAlert, error: OctagonX };

/** Changes the pane's text size by one point, within 8–28 (`increaseStatusFontSize`). */
export function stepStatusFont(current: number, delta: 1 | -1): Promise<unknown> | undefined {
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, current + delta));
  return next === current ? undefined : setSettings({ [FONT_KEY]: next }).catch(() => {});
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The entry text with every occurrence of the query marked (`highlightingMatches(of:)`). */
export function Highlighted({ text, q }: { text: string; q: string }) {
  const t = q.trim();
  if (!t) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(t)})`, "giu"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="status-match">{p}</mark> : p))}</>;
}

function IconButton({ icon, label, help, onClick, disabled, danger, buttonRef }: { icon: LucideIcon; label: string; help: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; danger?: boolean; buttonRef?: React.Ref<HTMLButtonElement> }) {
  return (
    <button ref={buttonRef} type="button" className="icon-btn" data-danger={danger || undefined} aria-label={label} title={help} disabled={disabled} onClick={onClick}>
      <Icon icon={icon} size={14} aria-hidden />
    </button>
  );
}

/** The line's action, when it has one (actions.ts): a button after its text. */
function RowAction({ action }: { action: StatusAction }) {
  return (
    <button
      type="button"
      className="status-row-action"
      title={action.help}
      // The row's own mouse-up selects it; the button only runs its action.
      onMouseUp={(ev) => ev.stopPropagation()}
      onClick={(ev) => {
        ev.stopPropagation();
        action.run();
      }}
    >
      {action.label}
    </button>
  );
}

function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <div className="empty-state status-empty">
      <Icon icon={TextAlignStart} size={20} aria-hidden />
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function StatusPane() {
  const tab = useActiveTab();
  const tabId = tab.id;
  const s = usePaneState(tabId);
  useStatusActions();
  const fontSize = useSetting<number>(FONT_KEY, FONT_DEFAULT);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRowRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const pinned = useRef(true);
  const anchorId = useRef<string | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [menu, setMenu] = useState<{ kind: "export" | "context"; x: number; y: number } | null>(null);

  const log = tab.log;
  const visible = useMemo(() => visibleEntries(log, s), [log, s]);
  const q = query(s);
  const hasQuery = q !== "";
  const filtering = isFiltering(s);
  const warningCount = log.filter((e) => e.severity === "warning" || e.severity === "error").length;
  const win = () => rootRef.current?.ownerDocument.defaultView ?? undefined;
  const doc = () => rootRef.current?.ownerDocument;

  // The filter row's width decides whether the "k of n" readout fits.
  useEffect(() => {
    const el = filterRowRef.current;
    const RO = el?.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (!el || !RO) return;
    const ro = new RO((es) => setRowWidth(es[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Open scrolled to the newest entry, per tab; after that follow new entries only while the user is at the bottom.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
  }, [tabId]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const scrollToEntry = (id: string) => {
    const row = listRef.current?.querySelector(`[data-entry="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: "center" });
  };

  // What the handlers read when the menu calls them, rather than this render's copies.
  const logRef = useRef(log);
  logRef.current = log;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  /** Return / ⌘G / ⇧⌘G: select the next (or previous) match and scroll it to the centre (`stepMatch`). */
  const stepMatch = useCallback(
    (delta: 1 | -1) => {
      const st = paneState(tabId);
      const vis = visibleEntries(logRef.current, st);
      const total = vis.length;
      if (!query(st) || !total) return;
      const i = (Math.min(st.matchIndex, total - 1) + delta + total) % total;
      setPaneState(tabId, { matchIndex: i, selection: new Set([vis[i].id]) });
      anchorId.current = vis[i].id;
      scrollToEntry(vis[i].id);
    },
    [tabId],
  );
  const zoom = useCallback((delta: 1 | -1) => void stepStatusFont(Number(fontSizeRef.current), delta), []);

  useFocusTarget(
    "status",
    {
      findTitle: w.findTitle,
      find: () => {
        searchRef.current?.focus();
        searchRef.current?.select();
      },
      stepFind: stepMatch,
      canStepFind: () => {
        const st = paneState(tabId);
        return query(st) !== "" && visibleEntries(logRef.current, st).length > 0;
      },
      zoom,
      canZoom: (d) => (d > 0 ? fontSizeRef.current < FONT_MAX : fontSizeRef.current > FONT_MIN),
      focus: () => listRef.current?.focus(),
    },
    [tabId, stepMatch, zoom],
  );

  const selected = visible.filter((e) => s.selection.has(e.id));
  const copySelected = () => (selected.length ? copyEntries(tabId, selected, win()) : copyEntries(tabId, visible, win()));
  const copyAll = () => copyEntries(tabId, visible, win());
  const clear = () => void clearStatusLog(tabId, doc());

  const select = (e: React.MouseEvent, entry: StatusEntry) => {
    if (e.button !== 0) return;
    const sel = new Set(s.selection);
    if (e.metaKey) {
      if (sel.has(entry.id)) sel.delete(entry.id);
      else sel.add(entry.id);
      anchorId.current = entry.id;
    } else if (e.shiftKey && anchorId.current) {
      const a = visible.findIndex((x) => x.id === anchorId.current);
      const b = visible.findIndex((x) => x.id === entry.id);
      if (a >= 0 && b >= 0) for (const x of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) sel.add(x.id);
    } else {
      // A click that only ended a text selection keeps the selection as it was.
      const picked = doc()?.getSelection()?.toString();
      if (picked) return;
      sel.clear();
      sel.add(entry.id);
      anchorId.current = entry.id;
    }
    setPaneState(tabId, { selection: sel });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && visible.length) {
      e.preventDefault();
      const cur = visible.findIndex((x) => x.id === anchorId.current);
      const i = cur < 0 ? (e.key === "ArrowDown" ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
      anchorId.current = visible[i].id;
      setPaneState(tabId, { selection: new Set([visible[i].id]) });
      scrollToEntry(visible[i].id);
    } else if (e.key === "a" && e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      setPaneState(tabId, { selection: new Set(visible.map((x) => x.id)) });
    }
  };

  // ⌘C (Edit ▸ Copy) with entries selected and no text selected copies them (`.copyable`).
  const onCopy = (e: React.ClipboardEvent) => {
    if (doc()?.getSelection()?.toString()) return;
    if (!selected.length) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", formattedLines(selected));
  };

  const exportItems: MenuItem[] = [
    { label: w.copyAll, disabled: !visible.length, run: () => void copyAll() },
    { label: w.copySelected, disabled: !s.selection.size || !selected.length, run: () => void copySelected() },
    "-",
    { label: w.saveLog, disabled: !visible.length, run: () => void saveStatusLog(tabId, visible) },
  ];
  const contextItems: MenuItem[] = [
    { label: w.copy, disabled: !selected.length, run: () => void copySelected() },
    { label: w.copyAll, run: () => void copyAll() },
    "-",
    { label: w.clear, danger: true, run: clear },
  ];

  const matchStatus = hasQuery && rowWidth >= MATCH_COUNT_MIN_ROW_WIDTH && visible.length ? w.matchStatus(Math.min(s.matchIndex, visible.length - 1) + 1, visible.length) : null;

  let empty: ReactNode = null;
  if (!visible.length) {
    if (filtering) empty = <EmptyState title={w.noResults(s.search)} message={w.noResultsMessage} />;
    else if (s.backlog.length)
      empty = (
        <EmptyState
          title={w.clearedTitle}
          message={w.clearedMessage(s.backlog.length)}
          action={
            <button type="button" className="btn" onClick={() => undoClearStatusLog(tabId)}>
              {w.undoClear}
            </button>
          }
        />
      );
    else empty = <EmptyState title={w.emptyTitle} message={w.emptyMessage} />;
  }

  return (
    <div ref={rootRef} className="status-pane" data-pane="status" role="region" aria-label={w.title} tabIndex={-1} style={{ ["--status-fs" as string]: `${fontSize}px` }}>
      <PaneHeader
        pane="status"
        title={w.title}
        accessory={
          <span className="status-count" title={filtering ? w.badgeHelpFiltered(visible.length, log.length, warningCount) : w.badgeHelp(log.length, warningCount)} aria-label={filtering ? w.badgeLabelFiltered(visible.length, log.length) : w.badgeLabel(log.length)}>
            {log.length}
          </span>
        }
      >
        <IconButton
          buttonRef={exportRef}
          icon={Share}
          label={w.exportLabel}
          help={w.exportHelp}
          disabled={!log.length}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu?.kind === "export" ? null : { kind: "export", x: r.left, y: r.bottom + 4 });
          }}
        />
        <span className="status-stepper" role="group" aria-label={w.textSize}>
          <IconButton icon={AArrowDown} label={w.smaller} help={w.smallerHelp} disabled={fontSize <= FONT_MIN} onClick={() => void stepStatusFont(fontSize, -1)} />
          <IconButton icon={AArrowUp} label={w.bigger} help={w.biggerHelp} disabled={fontSize >= FONT_MAX} onClick={() => void stepStatusFont(fontSize, 1)} />
        </span>
        <IconButton icon={Trash2} label={w.clear} help={w.clearHelp} danger disabled={!log.length} onClick={clear} />
      </PaneHeader>

      <FlagBar tab={tab} />

      <div ref={filterRowRef} className="status-filter-row">
        <div className="status-segmented" role="radiogroup" aria-label={w.filterLabel} title={w.filterHelp}>
          {(["all", "warnings", "errors"] as Filter[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={s.filter === f} data-on={s.filter === f || undefined} onClick={() => setPaneState(tabId, { filter: f })}>
              {w.filters[f]}
            </button>
          ))}
        </div>
        <label className="status-search" title={`${w.searchHelp} (${w.searchHint}). Escape clears.`}>
          <Icon icon={Search} size={12} aria-hidden />
          <input
            ref={searchRef}
            type="text"
            value={s.search}
            placeholder={w.searchPlaceholder}
            aria-label={w.searchPlaceholder}
            aria-description={matchStatus ?? undefined}
            spellCheck={false}
            autoCorrect="off"
            onChange={(e) => setPaneState(tabId, { search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stepMatch(1);
              } else if (e.key === "Escape" && s.search) {
                e.preventDefault();
                e.stopPropagation();
                setPaneState(tabId, { search: "" });
              }
            }}
          />
          {matchStatus ? <span className="status-search-count" aria-hidden>{matchStatus}</span> : null}
          {s.search ? (
            <button type="button" className="status-search-clear" title={w.clearSearch} aria-label={w.clearSearch} onClick={() => setPaneState(tabId, { search: "" })}>
              <Icon icon={X} size={12} aria-hidden />
            </button>
          ) : null}
        </label>
      </div>

      <div className="status-list-well">
        <div
          ref={listRef}
          className="status-list"
          role="listbox"
          aria-multiselectable
          aria-label={w.title}
          tabIndex={0}
          onKeyDown={onListKey}
          onCopy={onCopy}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const row = (e.target as Element).closest?.("[data-entry]");
            const id = row?.getAttribute("data-entry");
            if (id && !s.selection.has(id)) {
              anchorId.current = id;
              setPaneState(tabId, { selection: new Set([id]) });
            }
            setMenu({ kind: "context", x: e.clientX, y: e.clientY });
          }}
        >
          {visible.map((e) => (
            <div key={e.id} role="option" aria-selected={s.selection.has(e.id)} aria-label={undefined} className="status-row" data-entry={e.id} data-severity={e.severity} onMouseUp={(ev) => select(ev, e)}>
              <span className="status-row-icon" role="img" aria-label={w.severity[e.severity]}>
                <Icon icon={SEVERITY_ICON[e.severity]} size={12} aria-hidden />
              </span>
              <span className="status-row-time">{timeString(e.date)}</span>
              <span className="status-row-text">
                <Highlighted text={e.text} q={s.search} />
              </span>
              {statusAction(e.id) ? <RowAction action={statusAction(e.id)!} /> : null}
            </div>
          ))}
        </div>
        {empty}
      </div>

      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          label={menu.kind === "export" ? w.exportLabel : w.title}
          anchor={menu.kind === "export" ? exportRef.current : null}
          items={menu.kind === "export" ? exportItems : contextItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
