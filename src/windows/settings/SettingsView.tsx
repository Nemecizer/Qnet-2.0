// The Settings window's content (0.90.34 SettingsView.swift `SettingsView`, SettingsComponents.swift
// `SettingsPane`): a sidebar of the 13 panes in five groups with the search field above it, and the
// selected pane with its action bar (Reset to Defaults · Cancel · Save). Search filters the sidebar
// to panes with matches, counts them per pane, names the match the next Return lands on ("3 of
// 5"), and steps through them in registry order with Return / ⌘G and ⇧Return / ⇧⌘G (ledger
// SET-019…025, KEY-025, MENU-051…053). The pane last shown is kept in state.json as
// `settings.selectedPane` under 0.90.34's pane ids (SET-017, SET-196).
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, Search, X } from "lucide-react";
import { Icon } from "../../components/Icon";
import { api } from "../../lib/api";
import { loadKv, setSettings, setStateValues, useAllSettings, useStateValue } from "../../lib/kv";
import type { KvValues, SettingSchemaKey } from "../../lib/types";
import { useActiveTab } from "../../workspace/store";
import { registerFocusTarget } from "../../workspace/focus";
import { SettingsHelpButton } from "../help/HelpButton";
import { changedByReset, dirtyPanes, paneAtDefault, resetPatch, type Schema } from "./model";
import { PaneBody } from "./panes";
import { anchorForKey, GROUPS, matches as findMatches, paneFromStored, paneInfo, PANES, type PaneId } from "./registry";
import { Ctx, type SettingsContext } from "./rows";
import { settingsWords } from "./words";

const sw = settingsWords;

/** The state.json key of the last selected pane. */
export const SELECTED_PANE_KEY = "settings.selectedPane";

let schemaPromise: Promise<SettingSchemaKey[]> | null = null;

/** The schema from Rust, read once. */
export function useSchema(): Schema {
  const [schema, setSchema] = useState<Schema>(new Map());
  useEffect(() => {
    let alive = true;
    schemaPromise ??= api.settingsSchemaGet();
    schemaPromise.then(
      (list) => alive && setSchema(new Map(list.map((k) => [k.name, k]))),
      () => {
        schemaPromise = null;
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return schema;
}

/** For tests: read the schema again on the next mount. */
export function resetSchemaCache() {
  schemaPromise = null;
}

/** Applies a patch; null, or Rust's sentence when it refused. */
async function apply(patch: KvValues): Promise<string | null> {
  try {
    await setSettings(patch);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export interface SettingsViewProps {
  /** The document the window renders into. */
  doc?: Document;
  /** Closes the window (Cancel). */
  onClose?: () => void;
  /** A pane another window asked for (`openSettings(pane)`), with a token that re-fires it. */
  request?: { pane: PaneId; token: number } | null;
}

export function SettingsView({ doc, onClose, request }: SettingsViewProps) {
  const values = useAllSettings();
  const schema = useSchema();
  const stored = useStateValue<unknown>(SELECTED_PANE_KEY, "General");
  const selected = paneFromStored(stored);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [hasJumped, setHasJumped] = useState(false);
  const [jump, setJump] = useState<{ id: string; token: number } | null>(null);
  const [flash, setFlash] = useState<{ ids: Set<string>; token: number } | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokens = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tab = useActiveTab();
  const dimension = tab ? tab.document.nodes.filter((n) => n.kind === "station").length : null;

  useEffect(() => {
    loadKv().catch(() => {});
  }, []);

  const filtering = query.trim() !== "";
  const found = useMemo(() => findMatches(query), [query]);
  const dirty = useMemo(() => new Set(dirtyPanes(values, schema)), [values, schema]);
  const atDefaults = schema.size ? paneAtDefault(selected, values, schema) : true;

  const select = (pane: PaneId) => void setStateValues({ [SELECTED_PANE_KEY]: pane });
  const jumpTo = (id: string) => setJump({ id, token: ++tokens.current });

  // queryDidChange: a new walk; keep the pane if it has matches, otherwise go to the first match.
  const onQuery = (q: string) => {
    setQuery(q);
    setJump(null);
    setHasJumped(false);
    const m = findMatches(q);
    if (!q.trim() || !m.length) return setMatchIndex(0);
    const here = m.findIndex((e) => e.pane === selected);
    if (here >= 0) {
      setMatchIndex(here);
    } else {
      setMatchIndex(0);
      select(m[0].pane);
      jumpTo(m[0].id);
      setHasJumped(true);
    }
  };

  // stepMatch: the first step after an edit lands on the match the counter names; later ones
  // move one match, wrapping across panes and round the ends.
  const state = useRef({ found, matchIndex, hasJumped });
  state.current = { found, matchIndex, hasJumped };
  const stepMatch = (dir: 1 | -1) => {
    const { found: m, hasJumped: jumped } = state.current;
    if (!m.length) return;
    let i = state.current.matchIndex >= m.length ? 0 : state.current.matchIndex;
    if (jumped) i = (i + dir + m.length) % m.length;
    setMatchIndex(i);
    setHasJumped(true);
    state.current = { ...state.current, matchIndex: i, hasJumped: true };
    select(m[i].pane);
    jumpTo(m[i].id);
  };

  const pickPane = (pane: PaneId) => {
    select(pane);
    const idx = found.findIndex((e) => e.pane === pane);
    if (filtering && idx >= 0) {
      setMatchIndex(idx);
      setHasJumped(true);
      jumpTo(found[idx].id);
    } else {
      setJump(null);
    }
  };

  useEffect(() => {
    if (request) pickPane(request.pane);
  }, [request?.token]);

  const focusSearch = () => {
    searchRef.current?.ownerDocument.defaultView?.focus();
    searchRef.current?.focus();
    searchRef.current?.select();
  };

  // Edit ▸ Search Settings… (⌘F), Find Next / Previous (⌘G / ⇧⌘G) while this window has the keys.
  useEffect(
    () =>
      registerFocusTarget("window:settings", {
        findTitle: sw.findTitle,
        find: focusSearch,
        stepFind: (d) => stepMatch(d),
        canStepFind: () => state.current.found.length > 0,
      }),
    [],
  );

  const confirm = (text: string) => {
    setConfirmation(text);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmation(null), 3500);
  };
  useEffect(() => () => void (confirmTimer.current && clearTimeout(confirmTimer.current)), []);

  const performReset = async () => {
    const changed = changedByReset(selected, values, schema);
    const refusal = await apply(resetPatch(selected, values));
    if (refusal) return;
    const ids = new Set(changed.map(anchorForKey).filter((x): x is string => !!x));
    setFlash({ ids, token: ++tokens.current });
    confirm(sw.bar.wasReset);
  };

  // Every change is already on disk (kv.rs writes each patch atomically): Save confirms it.
  const performSave = () => confirm(sw.bar.saved);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.altKey || e.ctrlKey || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (t === searchRef.current || t.closest("textarea, select, button, .set-menu, .sb-overlay")) return;
    performSave();
  };

  const ctx: SettingsContext = {
    values,
    schema,
    set: apply,
    query,
    jump,
    flash,
    dimension: tab ? dimension : null,
    // The window's own document, so an alert opens in it (read when used: the portal lands later).
    get doc() {
      return doc ?? rootRef.current?.ownerDocument ?? document;
    },
    openPane: (p) => pickPane(paneFromStored(p)),
  };

  const info = paneInfo(selected);
  const count = (pane: PaneId) => found.filter((e) => e.pane === pane).length;
  const status = filtering && found.length ? sw.search.status(Math.min(matchIndex, found.length - 1) + 1, found.length) : null;

  return (
    <Ctx.Provider value={ctx}>
      <div className="settings" ref={rootRef} onKeyDown={onKeyDown}>
        <nav className="set-sidebar" aria-label={sw.windowTitle}>
          <div className="set-search" title={sw.search.help}>
            <Icon icon={Search} size={12} />
            <input
              ref={searchRef}
              type="search"
              aria-label={sw.search.label}
              aria-description={sw.search.hint}
              placeholder={sw.search.placeholder}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  onQuery("");
                }
              }}
            />
            {status && <span className="set-search-status">{status}</span>}
            {query ? (
              <button type="button" className="set-icon-btn" aria-label={sw.search.clear} onClick={() => onQuery("")}>
                <Icon icon={X} size={12} />
              </button>
            ) : (
              <kbd className="set-search-hint">{sw.search.shortcutHint}</kbd>
            )}
          </div>
          <div className="set-list" role="list">
            {GROUPS.map((g) => {
              const panes = PANES.filter((p) => p.group === g && (!filtering || count(p.id) > 0));
              if (!panes.length) return null;
              return (
                <div key={g} className="set-list-group" role="group" aria-label={sw.groups[g]}>
                  <div className="set-list-head">{sw.groups[g]}</div>
                  {panes.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="listitem"
                      className={`set-pane-btn${p.id === selected ? " selected" : ""}`}
                      aria-current={p.id === selected ? "page" : undefined}
                      title={p.summary}
                      aria-description={dirty.has(p.id) ? sw.differsHint(p.summary) : p.summary}
                      onClick={() => pickPane(p.id)}
                    >
                      <Icon icon={p.icon} size={16} />
                      <span className="set-pane-title">{p.title}</span>
                      {filtering && <span className="set-badge">{count(p.id)}</span>}
                      {dirty.has(p.id) && <span className="set-dirty-dot" title={sw.differsDot(p.title)} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              );
            })}
            {filtering && !found.length && (
              <div className="set-empty empty-state">
                <Icon icon={Search} size={20} />
                <h2>{sw.search.emptyTitle(query)}</h2>
                <p>{sw.search.emptyMessage}</p>
              </div>
            )}
          </div>
        </nav>
        <div className="set-detail">
          <h2 className="set-pane-heading">{info.title}</h2>
          <div className="set-scroll" key={selected}>
            <PaneBody pane={selected} />
          </div>
          <div className="set-bar">
            <SettingsHelpButton pane={selected} />
            <button
              type="button"
              className="btn"
              disabled={atDefaults}
              title={atDefaults ? sw.bar.resetAtDefaults : sw.bar.resetTip(info.title)}
              aria-label={sw.bar.resetLabel(info.title)}
              onClick={() => void performReset()}
            >
              {sw.bar.reset}
            </button>
            <span className="spacer" />
            {confirmation && (
              <span className="set-confirm" role="status">
                <Icon icon={CircleCheck} size={12} />
                {confirmation}
              </span>
            )}
            <button type="button" className="btn" title={sw.bar.cancelTip} aria-label={sw.bar.cancelLabel} onClick={() => onClose?.()}>
              {sw.bar.cancel}
            </button>
            <button type="button" className="btn primary" title={sw.bar.saveTip} aria-label={sw.bar.saveLabel} onClick={performSave}>
              {sw.bar.save}
            </button>
          </div>
        </div>
      </div>
    </Ctx.Provider>
  );
}
